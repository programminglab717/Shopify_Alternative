import 'reflect-metadata';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { AccountEmailSender, DEVICE_HEADER, type AccountEmail } from '@hatti/identity/public';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** Keeps each email it is given to send. */
class EmailsSent extends AccountEmailSender {
  readonly sent: AccountEmail[] = [];

  async send(email: AccountEmail): Promise<boolean> {
    this.sent.push(email);
    return true;
  }

  /** The token the last email's link carries. */
  get token(): string {
    return /#token=(\S+)/.exec(this.sent.at(-1)!.text)![1]!;
  }
}

describe.skipIf(!server)(
  '/auth/email and /auth/password: accounts prove their email and reset a password (ADR-165)',
  () => {
    let testDb: TestDatabase;
    let api: TestApi;
    const outbox = new EmailsSent();

    const post = (
      url: string,
      payload: unknown,
      token?: string,
      headers: Record<string, string> = {},
    ) =>
      api.app.inject({
        method: 'POST',
        url,
        payload: payload as Record<string, unknown>,
        headers: token ? { ...headers, authorization: `Bearer ${token}` } : headers,
      });

    beforeAll(async () => {
      testDb = await createTestDatabase(server!);
      api = await startTestApi(testDb, {
        emails: { sender: outbox, adminUrl: 'https://admin.hatti.pk' },
      });
    });

    afterAll(async () => {
      await api?.close();
      await testDb?.drop();
    });

    it('proves the email an account opened with, and resets its password by a link to it', async () => {
      const opened = await post('/auth/sign-up', {
        email: 'rabia@example.pk',
        password: 'correct horse battery staple',
        name: 'Rabia Anwar',
        language: 'ur',
      });
      const body = opened.json() as Json;
      expect([opened.statusCode, body.user.emailVerified]).toEqual([201, false]);
      expect(outbox.sent.at(-1)).toMatchObject({
        to: 'rabia@example.pk',
        text: expect.stringContaining('https://admin.hatti.pk/verify-email#token=hev_'),
      });
      const verified = await post('/auth/email/verify', { token: outbox.token });
      expect([verified.statusCode, verified.headers['cache-control']]).toEqual([200, 'no-store']);
      expect(verified.json().user).toMatchObject({
        email: 'rabia@example.pk',
        emailVerified: true,
      });
      const again = await post('/auth/email/verification', {}, body.accessToken);
      expect([again.statusCode, again.json().error.code]).toEqual([409, 'EMAIL_ALREADY_VERIFIED']);

      // Forgotten: a link to the email, the answer the same for an email no account has.
      for (const email of ['rabia@example.pk', 'nobody@example.pk']) {
        const forgot = await post('/auth/password/forgot', { email });
        expect([forgot.statusCode, forgot.json()]).toEqual([202, {}]);
      }
      expect(outbox.sent.at(-1)).toMatchObject({
        to: 'rabia@example.pk',
        text: expect.stringContaining('https://admin.hatti.pk/reset-password#token=hpr_'),
      });
      const reset = await post('/auth/password/reset', {
        token: outbox.token,
        password: 'a brand new passphrase',
      });
      expect(reset.statusCode).toBe(204);
      const signedOut = await api.app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${body.accessToken}` },
      });
      expect(signedOut.statusCode).toBe(401);
      const signedIn = await post('/auth/sign-in', {
        email: 'rabia@example.pk',
        password: 'a brand new passphrase',
      });
      expect(signedIn.json()).toMatchObject({ status: 'signed_in', user: { name: 'Rabia Anwar' } });
      const used = await post('/auth/password/reset', {
        token: outbox.token,
        password: 'another passphrase again',
      });
      expect([used.statusCode, used.json().error.code]).toEqual([401, 'INVALID_EMAIL_LINK']);
    });

    it("changes an account's email by a link to the new one, telling the one before (ADR-172)", async () => {
      const opened = await post('/auth/sign-up', {
        email: 'hina@example.pk',
        password: 'correct horse battery staple',
        name: 'Hina Malik',
      });
      const token = (opened.json() as Json).accessToken as string;
      const asked = await post('/auth/email/change', { email: 'Hina.Malik@Example.pk' }, token);
      expect([asked.statusCode, asked.headers['cache-control'], asked.json()]).toEqual([
        200,
        'no-store',
        {
          email: 'hina.malik@example.pk',
          expiresAt: expect.any(String),
          resendAfter: expect.any(String),
        },
      ]);
      expect(outbox.sent.at(-1)).toMatchObject({
        to: 'hina.malik@example.pk',
        text: expect.stringContaining('https://admin.hatti.pk/change-email#token=hce_'),
      });
      const changed = await post('/auth/email/change/confirm', { token: outbox.token });
      expect([changed.statusCode, changed.json().user]).toMatchObject([
        200,
        { email: 'hina.malik@example.pk', emailVerified: true },
      ]);
      expect(outbox.sent.at(-1)).toMatchObject({
        to: 'hina@example.pk',
        subject: 'Your Hatti account has a new email',
      });
      const anonymous = await post('/auth/email/change', { email: 'someone@example.pk' });
      expect(anonymous.statusCode).toBe(401);
    });

    it('emails the owner of a sign-in from a device new to the account, by the ID its client keeps (ADR-179)', async () => {
      const chrome =
        'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/129.0.0.0 Mobile Safari/537.36';
      const device = (id: string) => ({ 'user-agent': chrome, [DEVICE_HEADER]: id });
      const account = { email: 'saima@example.pk', password: 'correct horse battery staple' };
      const opened = await post(
        '/auth/sign-up',
        { ...account, name: 'Saima Khan' },
        undefined,
        device('phone-one-0123456789'),
      );
      expect(opened.statusCode).toBe(201);
      await post('/auth/email/verify', { token: outbox.token });
      const before = outbox.sent.length;
      await post('/auth/sign-in', account, undefined, device('phone-one-0123456789'));
      expect(outbox.sent.length).toBe(before);
      // Another phone, its browser saying the same.
      const other = await post('/auth/sign-in', account, undefined, device('phone-two-0123456789'));
      expect(outbox.sent.slice(before)).toEqual([
        expect.objectContaining({
          to: 'saima@example.pk',
          subject: 'New sign-in to your Hatti account',
          text: expect.stringContaining('signed in to from Chrome on Android on '),
        }),
      ]);
      const listed = await api.app.inject({
        method: 'GET',
        url: '/auth/sessions',
        headers: { authorization: `Bearer ${(other.json() as Json).accessToken}` },
      });
      expect(
        (listed.json() as Json).sessions.map((session: Json) => [session.device, session.current]),
      ).toEqual([
        ['Chrome on Android', true],
        ['Chrome on Android', false],
        ['Chrome on Android', false],
      ]);
    });
  },
);
