import { createVerify, X509Certificate, type KeyObject } from 'node:crypto';
import type { Db } from '@hatti/db';
import { eq, sql } from 'drizzle-orm';
import { emailSuppressions } from './schema.js';

// Bounces and complaints (ONB-01, ADR-170). Amazon SES publishes what became of Hatti's emails to
// an SNS topic, and SNS posts each notification to Hatti's webhook, signed with a certificate it
// serves from its own host. Hatti hears its own topic alone: an address that bounced for good, or
// whose recipient marked an email of Hatti's as spam, is sent no more.

export const SNS = {
  /** Where SNS serves the certificates it signs with, and the links that confirm a subscription. */
  host: /^sns\.[a-z0-9-]+\.amazonaws\.com$/,
  /** How long a certificate is kept once fetched. */
  certificateHours: 24,
  /** How long SNS is waited for. */
  timeoutMs: 5_000,
  /** The most of a certificate read, in characters. */
  certificateLength: 16_384,
} as const;

/** Where SES's word on Hatti's emails comes from. */
export interface EmailFeedbackSettings {
  /** The SNS topic SES publishes Hatti's bounces and complaints to: no other topic is heard. */
  topicArn: string;
  /** The key of SNS's certificate at `url`: fetched and kept a day, unless given, as tests do. */
  certificates?: (url: URL) => Promise<KeyObject>;
  /** Confirms the topic's subscription by its link: a GET of it, unless given, as tests do. */
  confirm?: (url: URL) => Promise<boolean>;
}

/** A message SNS posts, with the fields it signs. */
export interface SnsMessage {
  Type: 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: '1' | '2';
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
}

/** The fields SNS signs of each type of message, in the order it signs them. */
const SIGNED: Record<SnsMessage['Type'], readonly (keyof SnsMessage)[]> = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
  UnsubscribeConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
};

/** What SNS signs of `message`: each field it signs that the message has, its name and value. */
export function snsStringToSign(message: SnsMessage): string {
  return SIGNED[message.Type]
    .filter((field) => message[field] !== undefined)
    .map((field) => `${field}\n${message[field]}\n`)
    .join('');
}

/** `body` as a message SNS posts, where it is one; null otherwise. */
export function parseSnsMessage(body: string): SnsMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { Type, SignatureVersion } = value;
  if (
    Type !== 'Notification' &&
    Type !== 'SubscriptionConfirmation' &&
    Type !== 'UnsubscribeConfirmation'
  ) {
    return null;
  }
  if (SignatureVersion !== '1' && SignatureVersion !== '2') return null;
  const fields: (keyof SnsMessage)[] = [
    'MessageId',
    'TopicArn',
    'Message',
    'Timestamp',
    'Signature',
    'SigningCertURL',
    ...(Type === 'Notification' ? [] : (['SubscribeURL', 'Token'] as const)),
  ];
  if (fields.some((field) => typeof value[field] !== 'string')) return null;
  if (value.Subject !== undefined && typeof value.Subject !== 'string') return null;
  const message = Object.fromEntries(
    [...fields, 'Type', 'SignatureVersion', 'Subject']
      .filter((field) => value[field] !== undefined)
      .map((field) => [field, value[field]]),
  );
  return message as unknown as SnsMessage;
}

/** `text` as an address on SNS's own host, over HTTPS; null for any other. */
export function snsUrl(text: string | undefined): URL | null {
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const plain = url.protocol === 'https:' && url.port === '' && !url.username && !url.password;
  return plain && SNS.host.test(url.hostname) ? url : null;
}

export type SnsCheck =
  | { ok: true; message: SnsMessage }
  | { ok: false; reason: 'invalid' | 'other_topic' | 'unreachable' };

/**
 * Checks what SNS posts for Hatti's topic: a message of the topic, signed with the certificate it
 * names, which SNS serves from its own host.
 */
export class SnsMessages {
  readonly #certificates: (url: URL) => Promise<KeyObject>;

  constructor(private readonly settings: EmailFeedbackSettings) {
    this.#certificates = settings.certificates ?? snsCertificates();
  }

  async check(body: string): Promise<SnsCheck> {
    const message = parseSnsMessage(body);
    const certificate = snsUrl(message?.SigningCertURL);
    if (!message || !certificate?.pathname.endsWith('.pem')) {
      return { ok: false, reason: 'invalid' };
    }
    if (message.TopicArn !== this.settings.topicArn) return { ok: false, reason: 'other_topic' };
    let key: KeyObject;
    try {
      key = await this.#certificates(certificate);
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
    let signed: boolean;
    try {
      signed = createVerify(message.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1')
        .update(snsStringToSign(message), 'utf8')
        .verify(key, message.Signature, 'base64');
    } catch {
      signed = false;
    }
    return signed ? { ok: true, message } : { ok: false, reason: 'invalid' };
  }
}

/** SNS's certificates, as it serves them, kept a day once fetched: a few at a time. */
function snsCertificates(): (url: URL) => Promise<KeyObject> {
  const kept = new Map<string, { key: KeyObject; until: number }>();
  return async (url) => {
    const now = Date.now();
    const known = kept.get(url.href);
    if (known && known.until > now) return known.key;
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(SNS.timeoutMs),
    });
    if (!response.ok) throw new Error(`SNS answered ${response.status} for its certificate`);
    const pem = await response.text();
    if (pem.length > SNS.certificateLength) throw new Error("SNS's certificate is too long");
    const { publicKey } = new X509Certificate(pem);
    if (kept.size >= 16) kept.clear();
    kept.set(url.href, { key: publicKey, until: now + SNS.certificateHours * 3_600_000 });
    return publicKey;
  };
}

/** What SES said of an email of Hatti's: the addresses to send no more to, and why. */
export interface EmailFeedback {
  reason: 'bounce' | 'complaint';
  /** As Hatti keeps addresses: trimmed, in lower case. */
  emails: string[];
  /** What the address's server said, or the kind of complaint. */
  detail: string | null;
  /** SES's ID for the feedback. */
  feedbackId: string;
}

/**
 * The feedback in SES's notification `message`, as a topic's notifications or a configuration
 * set's events say it: a bounce for good, or a complaint. Null for anything else, such as a
 * bounce that may pass, as a full mailbox's, or a delivery.
 */
export function feedbackOf(message: string): EmailFeedback | null {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const type = value.notificationType ?? value.eventType;
  if (type === 'Bounce' && isRecord(value.bounce)) {
    const { bounce } = value;
    if (bounce.bounceType !== 'Permanent' || typeof bounce.feedbackId !== 'string') return null;
    const recipients = recordsOf(bounce.bouncedRecipients);
    const said = recipients.find((recipient) => typeof recipient.diagnosticCode === 'string');
    return feedback('bounce', recipients, said?.diagnosticCode ?? bounce.bounceSubType, bounce);
  }
  if (type === 'Complaint' && isRecord(value.complaint)) {
    const { complaint } = value;
    if (typeof complaint.feedbackId !== 'string') return null;
    return feedback(
      'complaint',
      recordsOf(complaint.complainedRecipients),
      complaint.complaintFeedbackType,
      complaint,
    );
  }
  return null;
}

function feedback(
  reason: EmailFeedback['reason'],
  recipients: Record<string, unknown>[],
  detail: unknown,
  about: Record<string, unknown>,
): EmailFeedback | null {
  const emails = [
    ...new Set(
      recipients
        .map((recipient) => addressOf(recipient.emailAddress))
        .filter((email): email is string => email !== null),
    ),
  ];
  if (emails.length === 0) return null;
  return {
    reason,
    emails,
    detail: typeof detail === 'string' && detail.trim() ? detail.trim().slice(0, 1000) : null,
    feedbackId: String(about.feedbackId).slice(0, 200),
  };
}

/** An address as a notification names it, maybe with a name around it, as Hatti keeps it. */
function addressOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const bracketed = /<([^<>]+)>\s*$/.exec(value);
  const email = (bracketed ? bracketed[1]! : value).trim().toLowerCase();
  return email.length <= 254 && /^[^@\s]+@[^@\s]+$/.test(email) ? email : null;
}

/** Sends no more email to the addresses of `feedback`, the latest feedback kept for each. */
export async function suppressIn(db: Db, feedback: EmailFeedback, at: Date): Promise<void> {
  await db
    .insert(emailSuppressions)
    .values(
      feedback.emails.map((email) => ({
        email,
        reason: feedback.reason,
        detail: feedback.detail,
        feedbackId: feedback.feedbackId,
        createdAt: at,
        updatedAt: at,
      })),
    )
    .onConflictDoUpdate({
      target: emailSuppressions.email,
      set: {
        reason: sql`excluded.reason`,
        detail: sql`excluded.detail`,
        feedbackId: sql`excluded.feedback_id`,
        updatedAt: at,
      },
    });
}

/** Whether Hatti sends no more email to `email`, as it keeps addresses (ADR-170). */
export async function suppressed(db: Pick<Db, 'select'>, email: string): Promise<boolean> {
  const [row] = await db
    .select({ email: emailSuppressions.email })
    .from(emailSuppressions)
    .where(eq(emailSuppressions.email, email));
  return row !== undefined;
}

export type EmailFeedbackOutcome =
  'not_found' | 'invalid' | 'unreachable' | 'confirmed' | 'recorded' | 'ignored';

/**
 * Hears SES's word on Hatti's emails through SNS (ADR-170): confirms the subscription of Hatti's
 * topic, and sends no more to each address that bounced for good or complained. Heard twice, a
 * notification changes nothing more.
 */
export class EmailFeedbackService {
  readonly #messages: SnsMessages | null;
  readonly #confirm: (url: URL) => Promise<boolean>;

  constructor(
    private readonly options: {
      db: Db;
      feedback?: EmailFeedbackSettings | null;
      now?: () => Date;
    },
  ) {
    this.#messages = options.feedback ? new SnsMessages(options.feedback) : null;
    this.#confirm = options.feedback?.confirm ?? confirmSubscription;
  }

  /** What became of SNS's request `body`: not_found where no topic is set up. */
  async hear(body: string): Promise<EmailFeedbackOutcome> {
    if (!this.#messages) return 'not_found';
    const checked = await this.#messages.check(body);
    if (!checked.ok) return checked.reason === 'unreachable' ? 'unreachable' : 'invalid';
    const { message } = checked;
    switch (message.Type) {
      case 'SubscriptionConfirmation': {
        const url = snsUrl(message.SubscribeURL);
        if (!url) return 'invalid';
        return (await this.#confirm(url).catch(() => false)) ? 'confirmed' : 'unreachable';
      }
      case 'UnsubscribeConfirmation':
        return 'ignored';
      case 'Notification': {
        const feedback = feedbackOf(message.Message);
        if (!feedback) return 'ignored';
        await suppressIn(this.options.db, feedback, this.options.now?.() ?? new Date());
        return 'recorded';
      }
    }
  }
}

/** Confirms a subscription as SNS asks: a GET of its link. */
async function confirmSubscription(url: URL): Promise<boolean> {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(SNS.timeoutMs),
  });
  return response.ok;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
