import type { Db } from '@hatti/db';
import { describe, expect, it } from 'vitest';
import { SnsTestTopic } from '../testing/sns-topic.js';
import {
  EmailFeedbackService,
  SnsMessages,
  feedbackOf,
  parseSnsMessage,
  snsUrl,
} from './email-feedback.js';

describe("SNS's messages (ADR-170)", () => {
  const topic = new SnsTestTopic();
  const messages = new SnsMessages({ topicArn: topic.topicArn, certificates: topic.certificates });
  const bounced = SnsTestTopic.bounce(['ayesha@example.pk']);

  it('takes a message of its topic signed as SNS signs, by SHA-256 or SHA-1', async () => {
    for (const version of ['2', '1'] as const) {
      const checked = await messages.check(topic.notification(bounced, { version }));
      expect(checked).toMatchObject({
        ok: true,
        message: { Type: 'Notification', TopicArn: topic.topicArn, SignatureVersion: version },
      });
    }
    const confirmation = topic.subscriptionConfirmation(
      'https://sns.ap-south-1.amazonaws.com/?Action=ConfirmSubscription&Token=x',
    );
    expect(await messages.check(confirmation)).toMatchObject({
      ok: true,
      message: { Type: 'SubscriptionConfirmation', Token: expect.any(String) },
    });
  });

  it("refuses one changed after it was signed, another topic's, and one signed by another", async () => {
    const changed = JSON.parse(topic.notification(bounced)) as Record<string, string>;
    changed.Message = JSON.stringify(SnsTestTopic.bounce(['someone@else.pk']));
    expect(await messages.check(JSON.stringify(changed))).toEqual({
      ok: false,
      reason: 'invalid',
    });
    const otherTopic = topic.notification(bounced, {
      topicArn: 'arn:aws:sns:ap-south-1:999999999999:theirs',
    });
    expect(await messages.check(otherTopic)).toEqual({ ok: false, reason: 'other_topic' });
    const impostor = new SnsTestTopic();
    expect(await messages.check(impostor.notification(bounced))).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(await messages.check('not json')).toEqual({ ok: false, reason: 'invalid' });
    expect(await messages.check('{"Type":"Notification"}')).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it("takes certificates from SNS's own host alone, over HTTPS, and says when it can't reach them", async () => {
    let fetched = 0;
    const counting = new SnsMessages({
      topicArn: topic.topicArn,
      certificates: async () => {
        fetched += 1;
        return topic.certificates();
      },
    });
    const elsewhere = (url: string) => {
      const message = JSON.parse(topic.notification(bounced)) as Record<string, string>;
      return JSON.stringify({ ...message, SigningCertURL: url });
    };
    for (const url of [
      'https://sns.ap-south-1.amazonaws.com.evil.pk/cert.pem',
      'http://sns.ap-south-1.amazonaws.com/cert.pem',
      'https://sns.ap-south-1.amazonaws.com:8443/cert.pem',
      'https://user@sns.ap-south-1.amazonaws.com/cert.pem',
      'https://sns.ap-south-1.amazonaws.com/cert.txt',
      'https://evil.pk/sns.ap-south-1.amazonaws.com.pem',
    ]) {
      expect(await counting.check(elsewhere(url))).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(fetched).toBe(0);
    const unreachable = new SnsMessages({
      topicArn: topic.topicArn,
      certificates: () => Promise.reject(new Error('timed out')),
    });
    expect(await unreachable.check(topic.notification(bounced))).toEqual({
      ok: false,
      reason: 'unreachable',
    });
    expect(
      snsUrl('https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription'),
    ).not.toBeNull();
    expect(snsUrl(undefined)).toBeNull();
    expect(parseSnsMessage(JSON.stringify({ Type: 'Notification', SignatureVersion: '3' }))).toBe(
      null,
    );
  });
});

describe("SES's feedback (ADR-170)", () => {
  it('names the addresses that bounced for good, with what their server said', () => {
    expect(
      feedbackOf(JSON.stringify(SnsTestTopic.bounce([' Ayesha@Example.PK ', 'b@x.pk']))),
    ).toEqual({
      reason: 'bounce',
      emails: ['ayesha@example.pk', 'b@x.pk'],
      detail: 'smtp; 550 5.1.1 user unknown',
      feedbackId: '0100018b-bounce-2',
    });
    // A full mailbox may take mail tomorrow.
    expect(feedbackOf(JSON.stringify(SnsTestTopic.bounce(['a@x.pk'], 'Transient')))).toBeNull();
    expect(feedbackOf(JSON.stringify(SnsTestTopic.bounce(['a@x.pk'], 'Undetermined')))).toBeNull();
  });

  it('names those who marked an email as spam, as events of a configuration set say it too', () => {
    const complaint = SnsTestTopic.complaint(['"Bilal" <Bilal@Example.pk>']);
    expect(feedbackOf(JSON.stringify(complaint))).toEqual({
      reason: 'complaint',
      emails: ['bilal@example.pk'],
      detail: 'abuse',
      feedbackId: '0100018b-complaint-1',
    });
    const { notificationType, ...event } = complaint;
    expect(notificationType).toBe('Complaint');
    expect(feedbackOf(JSON.stringify({ eventType: 'Complaint', ...event }))).toMatchObject({
      emails: ['bilal@example.pk'],
    });
  });

  it("tells what else keeps Hatti's emails of each notification, and has SNS send it again when that fails (ADR-197)", async () => {
    const topic = new SnsTestTopic();
    const heard: string[] = [];
    let working = true;
    // A delivery suppresses nothing: no database is asked.
    const feedback = new EmailFeedbackService({
      db: {} as Db,
      feedback: {
        topicArn: topic.topicArn,
        certificates: topic.certificates,
        onNotification: async (message) => {
          if (!working) throw new Error('database down');
          heard.push(message);
        },
      },
    });
    const delivered = SnsTestTopic.delivery('0100018f-order', ['ayesha@example.pk']);
    expect(await feedback.hear(topic.notification(delivered))).toBe('ignored');
    expect(heard.map((message) => JSON.parse(message) as unknown)).toEqual([delivered]);
    working = false;
    expect(await feedback.hear(topic.notification(delivered))).toBe('unreachable');
    expect(heard).toHaveLength(1);
  });

  it('says nothing of deliveries, addresses it cannot read, or what is not JSON', () => {
    expect(feedbackOf(JSON.stringify({ notificationType: 'Delivery', delivery: {} }))).toBeNull();
    expect(feedbackOf(JSON.stringify(SnsTestTopic.bounce(['not an address'])))).toBeNull();
    expect(feedbackOf('{')).toBeNull();
    expect(feedbackOf('[]')).toBeNull();
  });
});
