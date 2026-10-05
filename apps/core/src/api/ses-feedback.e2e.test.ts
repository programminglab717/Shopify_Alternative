import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { AccountEmailSender, type AccountEmail } from '@hatti/identity/public';
import { SnsTestTopic } from '@hatti/identity/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

/** Keeps each email it is given to send. */
class EmailsSent extends AccountEmailSender {
  readonly sent: AccountEmail[] = [];

  async send(email: AccountEmail): Promise<boolean> {
    this.sent.push(email);
    return true;
  }
}

describe.skipIf(!server)(
  "/webhooks/ses: SES's bounces and complaints, through SNS (ADR-170)",
  () => {
    let testDb: TestDatabase;
    let api: TestApi;
    let admin: pg.Client;
    const outbox = new EmailsSent();
    const topic = new SnsTestTopic();
    const confirmed: string[] = [];

    /** Posts `body` as SNS does: text, whatever it holds. */
    const notify = (body: string) =>
      api.app.inject({
        method: 'POST',
        url: '/webhooks/ses',
        payload: body,
        headers: {
          'content-type': 'text/plain; charset=UTF-8',
          'x-amz-sns-message-type': (JSON.parse(body) as { Type: string }).Type,
        },
      });

    const post = (url: string, payload: unknown, token?: string) =>
      api.app.inject({
        method: 'POST',
        url,
        payload: payload as Record<string, unknown>,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });

    const suppressions = async () =>
      (
        await admin.query<{ email: string; reason: string; detail: string | null }>(
          'SELECT email, reason, detail FROM identity.email_suppressions ORDER BY email',
        )
      ).rows;

    beforeAll(async () => {
      testDb = await createTestDatabase(server!);
      api = await startTestApi(testDb, {
        emails: {
          sender: outbox,
          adminUrl: 'https://admin.hatti.pk',
          feedback: {
            topicArn: topic.topicArn,
            certificates: topic.certificates,
            confirm: async (url) => {
              confirmed.push(url.href);
              return true;
            },
          },
        },
      });
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
    });

    afterAll(async () => {
      await admin?.end();
      await api?.close();
      await testDb?.drop();
    });

    it("confirms its topic's subscription by SNS's own link, and no other", async () => {
      const link =
        'https://sns.ap-south-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=y';
      const subscribed = await notify(topic.subscriptionConfirmation(link));
      expect(subscribed.statusCode).toBe(200);
      expect(confirmed).toEqual([link]);
      const elsewhere = await notify(topic.subscriptionConfirmation('https://evil.pk/confirm'));
      expect(elsewhere.statusCode).toBe(403);
      // Another topic's, or one signed by someone else: refused, and nothing fetched.
      const theirs = await notify(
        topic.notification(SnsTestTopic.bounce(['a@x.pk']), {
          topicArn: 'arn:aws:sns:ap-south-1:999999999999:theirs',
        }),
      );
      const forged = await notify(new SnsTestTopic().notification(SnsTestTopic.bounce(['a@x.pk'])));
      expect([theirs.statusCode, forged.statusCode]).toEqual([403, 403]);
      expect(confirmed).toEqual([link]);
      expect(await suppressions()).toEqual([]);
    });

    it('sends no more to an address that bounced for good, or complained', async () => {
      const opened = await post('/auth/sign-up', {
        email: 'rabia@example.pk',
        password: 'correct horse battery staple',
        name: 'Rabia Anwar',
      });
      expect(opened.statusCode).toBe(201);
      const token = opened.json().accessToken as string;
      expect(outbox.sent.map((email) => email.to)).toEqual(['rabia@example.pk']);

      // A full mailbox may take mail tomorrow: nothing changes.
      const full = await notify(
        topic.notification(SnsTestTopic.bounce(['rabia@example.pk'], 'Transient')),
      );
      expect(full.statusCode).toBe(200);
      expect(await suppressions()).toEqual([]);
      // Its server says it takes no mail, by SHA-1 as by SHA-256, and SNS says it twice.
      const bounce = topic.notification(SnsTestTopic.bounce(['Rabia@Example.pk']), {
        version: '1',
      });
      for (const _ of [1, 2]) expect((await notify(bounce)).statusCode).toBe(200);
      expect(await suppressions()).toEqual([
        { email: 'rabia@example.pk', reason: 'bounce', detail: 'smtp; 550 5.1.1 user unknown' },
      ]);
      const again = await post('/auth/email/verification', {}, token);
      expect([again.statusCode, again.json().error.code]).toEqual([409, 'EMAIL_UNDELIVERABLE']);
      // Forgotten: the same answer as ever, and no email.
      const forgot = await post('/auth/password/forgot', { email: 'rabia@example.pk' });
      expect([forgot.statusCode, forgot.json()]).toEqual([202, {}]);
      expect(outbox.sent).toHaveLength(1);

      // A complaint, as a configuration set's event says it.
      const { notificationType, ...complaint } = SnsTestTopic.complaint(['bilal@example.pk']);
      expect(notificationType).toBe('Complaint');
      const complained = await notify(topic.notification({ eventType: 'Complaint', ...complaint }));
      expect(complained.statusCode).toBe(200);
      const signedUp = await post('/auth/sign-up', {
        email: 'bilal@example.pk',
        password: 'correct horse battery staple',
        name: 'Bilal Ahmed',
      });
      // The account opens; its link is not sent.
      expect(signedUp.statusCode).toBe(201);
      expect(outbox.sent).toHaveLength(1);
      expect((await suppressions()).map((row) => [row.email, row.reason])).toEqual([
        ['bilal@example.pk', 'complaint'],
        ['rabia@example.pk', 'bounce'],
      ]);
      // SES drops an email to an address on its own list, and tells it as a bounce: a complaint
      // stays one, and keeps what was said of it (ADR-200).
      const dropped = await notify(topic.notification(SnsTestTopic.bounce(['bilal@example.pk'])));
      expect(dropped.statusCode).toBe(200);
      expect(await suppressions()).toEqual([
        { email: 'bilal@example.pk', reason: 'complaint', detail: 'abuse' },
        { email: 'rabia@example.pk', reason: 'bounce', detail: 'smtp; 550 5.1.1 user unknown' },
      ]);
    });

    it("moves the emails sent for a shop's customers on to delivered or failed, as SES says (ADR-197)", async () => {
      const shopId = randomUUID();
      await admin.query("INSERT INTO control.shops (id, name) VALUES ($1, 'Zari Fashions')", [
        shopId,
      ]);
      /** An order's news emailed through SES, which gave it `messageId`. */
      const emailed = async (messageId: string, recipient: string) => {
        const { rows } = await admin.query<{ id: string }>(
          `INSERT INTO messaging.messages
                  (shop_id, kind, channel, recipient, language, variables, dedupe_key, status,
                   provider, provider_message_id, sent_at)
           VALUES ($1, 'order_shipped', 'email', $2, 'en', '{"shop": "Zari Fashions"}', $3,
                   'sent', 'ses', $4, now())
           RETURNING id`,
          [shopId, recipient, `order_shipped:${messageId}:email`, messageId],
        );
        return rows[0]!.id;
      };
      const stateOf = async (id: string) =>
        (
          await admin.query<{ status: string; error: string | null; delivered: boolean }>(
            `SELECT status, error, delivered_at IS NOT NULL AS delivered
               FROM messaging.messages WHERE id = $1`,
            [id],
          )
        ).rows[0];
      const delivered = await emailed('0100018f-delivered', 'ayesha@example.pk');
      const bounced = await emailed('0100018f-bounced', 'hina@example.pk');

      const delivery = SnsTestTopic.delivery('0100018f-delivered', ['ayesha@example.pk']);
      expect((await notify(topic.notification(delivery))).statusCode).toBe(200);
      expect(await stateOf(delivered)).toEqual({
        status: 'delivered',
        error: null,
        delivered: true,
      });
      // Bounced for good: failed, saying why, and the address sent none of Hatti's emails again.
      const bounce = SnsTestTopic.bounce(['hina@example.pk'], 'Permanent', '0100018f-bounced');
      expect((await notify(topic.notification(bounce))).statusCode).toBe(200);
      expect(await stateOf(bounced)).toEqual({
        status: 'failed',
        error: 'The email bounced: smtp; 550 5.1.1 user unknown',
        delivered: false,
      });
      expect((await suppressions()).map((row) => row.email)).toContain('hina@example.pk');
      // Word come late or twice moves nothing back; that of Hatti's own emails, nothing at all.
      const late = SnsTestTopic.delivery('0100018f-bounced', ['hina@example.pk']);
      expect((await notify(topic.notification(late))).statusCode).toBe(200);
      expect((await notify(topic.notification(delivery))).statusCode).toBe(200);
      expect(await stateOf(bounced)).toMatchObject({ status: 'failed' });
      expect(await stateOf(delivered)).toMatchObject({ status: 'delivered' });
      const own = SnsTestTopic.delivery('0100018f-account-link', ['rabia@example.pk']);
      expect((await notify(topic.notification(own))).statusCode).toBe(200);
    });
  },
);
