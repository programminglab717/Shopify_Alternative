import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { snsStringToSign, type SnsMessage } from '../internal/email-feedback.js';

/**
 * Plays SNS for tests of SES's bounces and complaints (ADR-170): a topic of its own, a key it signs
 * its messages with, given to the identity module in place of SNS's certificates, and the messages
 * SNS posts, signed as SNS signs them.
 */
export class SnsTestTopic {
  /** Where its messages say SNS's certificate is. */
  readonly certificateUrl =
    'https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-test.pem';
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;
  #sent = 0;

  constructor(
    /** The topic's ARN, for `feedback.topicArn`. */
    readonly topicArn = 'arn:aws:sns:ap-south-1:123456789012:hatti-ses-feedback',
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.#privateKey = privateKey;
    this.#publicKey = publicKey;
  }

  /** Its key, for `feedback.certificates`: the same for whatever certificate is named. */
  readonly certificates = async (): Promise<KeyObject> => this.#publicKey;

  /** A notification of the topic saying `message`, signed as SNS signs with `version`. */
  notification(message: unknown, options: { version?: '1' | '2'; topicArn?: string } = {}): string {
    return this.#signed(
      {
        Type: 'Notification',
        Message: typeof message === 'string' ? message : JSON.stringify(message),
        TopicArn: options.topicArn ?? this.topicArn,
      },
      options.version ?? '2',
    );
  }

  /** SNS's request to confirm a subscription to the topic, by its link. */
  subscriptionConfirmation(subscribeUrl: string): string {
    return this.#signed(
      {
        Type: 'SubscriptionConfirmation',
        Message: `You have chosen to subscribe to the topic ${this.topicArn}.`,
        TopicArn: this.topicArn,
        SubscribeURL: subscribeUrl,
        Token: 'test-token-' + 'a'.repeat(40),
      },
      '2',
    );
  }

  /** What SES says of an email bounced, for good unless said otherwise, to `emails`. */
  static bounce(emails: string[], bounceType = 'Permanent'): Record<string, unknown> {
    return {
      notificationType: 'Bounce',
      bounce: {
        bounceType,
        bounceSubType: bounceType === 'Permanent' ? 'General' : 'MailboxFull',
        bouncedRecipients: emails.map((emailAddress) => ({
          emailAddress,
          action: 'failed',
          status: '5.1.1',
          diagnosticCode: 'smtp; 550 5.1.1 user unknown',
        })),
        timestamp: new Date().toISOString(),
        feedbackId: `0100018b-bounce-${emails.length}`,
      },
      mail: { messageId: 'test-message', source: 'Hatti <no-reply@hatti.pk>', destination: emails },
    };
  }

  /** What SES says of an email `emails` marked as spam. */
  static complaint(emails: string[]): Record<string, unknown> {
    return {
      notificationType: 'Complaint',
      complaint: {
        complainedRecipients: emails.map((emailAddress) => ({ emailAddress })),
        complaintFeedbackType: 'abuse',
        timestamp: new Date().toISOString(),
        feedbackId: `0100018b-complaint-${emails.length}`,
      },
      mail: { messageId: 'test-message', source: 'Hatti <no-reply@hatti.pk>', destination: emails },
    };
  }

  #signed(
    fields: Pick<SnsMessage, 'Type' | 'Message' | 'TopicArn' | 'SubscribeURL' | 'Token'>,
    version: '1' | '2',
  ): string {
    const message: SnsMessage = {
      ...fields,
      MessageId: `00000000-0000-4000-8000-${String((this.#sent += 1)).padStart(12, '0')}`,
      Timestamp: new Date().toISOString(),
      SignatureVersion: version,
      Signature: '',
      SigningCertURL: this.certificateUrl,
    };
    message.Signature = createSign(version === '2' ? 'RSA-SHA256' : 'RSA-SHA1')
      .update(snsStringToSign(message), 'utf8')
      .sign(this.#privateKey, 'base64');
    return JSON.stringify(message);
  }
}
