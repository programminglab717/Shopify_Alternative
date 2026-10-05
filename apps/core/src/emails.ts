import { createHash, randomBytes } from 'node:crypto';
import {
  AccountEmailSender,
  type AccountEmail,
  type AccountEmails,
  type SesSuppressionList,
} from '@hatti/identity/public';
import type { Logger } from '@hatti/logger';
import {
  SES_EMAIL,
  messageEmail,
  type MessageProvider,
  type OutgoingMessage,
  type SendResult,
} from '@hatti/messaging/public';
import { ScheduledExportSender, type ScheduledExportEmail } from '@hatti/orders/public';
import { EMPTY_PAYLOAD_SHA256, signRequest, uriEncode } from '@hatti/storage';
import { passkeysOf, type ApiConfig, type MessageSendingConfig } from './config.js';

/** Amazon SES, as Hatti's emails go through it. */
export interface SesOptions {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** "Hatti <no-reply@hatti.pk>", at a domain SES has verified. */
  from: string;
  /** The region's API unless given. */
  baseUrl?: string;
  timeoutMs?: number;
  now?: () => Date;
}

/** One email to one address, as SES sends it. */
interface SesEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Amazon SES's v2 API, sending one email at a time, and asking of the addresses on the account's
 * suppression list (ADR-200), each request signed for SES in its region.
 */
class Ses {
  readonly #base: string;
  readonly #url: URL;

  constructor(private readonly options: SesOptions) {
    const base = options.baseUrl ?? `https://email.${options.region}.amazonaws.com`;
    this.#base = base.endsWith('/') ? base : `${base}/`;
    this.#url = new URL('v2/email/outbound-emails', this.#base);
  }

  /**
   * SES's answer of `email` on the account's suppression list: why it has it, by a GET, or taking
   * it off, by a DELETE. Throws when SES is not reached.
   */
  async suppressed(method: 'GET' | 'DELETE', email: string): Promise<Response> {
    const url = new URL(`v2/email/suppression/addresses/${uriEncode(email)}`, this.#base);
    const signed = signRequest(method, url, {}, EMPTY_PAYLOAD_SHA256, this.#signing());
    return fetch(url, {
      method,
      headers: signed,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    });
  }

  /** Sends `email`: SES's answer. Throws when SES is not reached. */
  async send(email: SesEmail): Promise<Response> {
    const utf8 = (data: string) => ({ Data: data, Charset: 'UTF-8' });
    return this.#post({
      FromEmailAddress: email.from,
      Destination: { ToAddresses: [email.to] },
      Content: {
        Simple: {
          Subject: utf8(email.subject),
          Body: { Text: utf8(email.text), Html: utf8(email.html) },
        },
      },
    });
  }

  /** Sends a whole MIME message from `from` to `to`, as it is: SES's answer. */
  async sendRaw(email: { from: string; to: string; message: string }): Promise<Response> {
    return this.#post({
      FromEmailAddress: email.from,
      Destination: { ToAddresses: [email.to] },
      Content: { Raw: { Data: Buffer.from(email.message).toString('base64') } },
    });
  }

  async #post(content: object): Promise<Response> {
    const body = JSON.stringify(content);
    const headers = { 'content-type': 'application/json' };
    const signed = signRequest(
      'POST',
      this.#url,
      headers,
      createHash('sha256').update(body).digest('hex'),
      this.#signing(),
    );
    return fetch(this.#url, {
      method: 'POST',
      headers: { ...headers, ...signed },
      body,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    });
  }

  #signing() {
    return {
      credentials: {
        accessKeyId: this.options.accessKeyId,
        secretAccessKey: this.options.secretAccessKey,
      },
      region: this.options.region,
      date: this.options.now?.() ?? new Date(),
      service: 'ses',
    };
  }
}

/** Amazon SES's v2 API, sending Hatti's own emails about accounts one at a time (ADR-165). */
export class SesEmails extends AccountEmailSender {
  readonly #ses: Ses;

  constructor(private readonly options: SesOptions & { logger?: Pick<Logger, 'warn'> }) {
    super();
    this.#ses = new Ses(options);
  }

  async send(email: AccountEmail): Promise<boolean> {
    try {
      const response = await this.#ses.send({ ...email, from: this.options.from });
      if (response.ok) return true;
      this.options.logger?.warn(
        { status: response.status, answer: (await response.text()).slice(0, 500) },
        'SES refused an email',
      );
      return false;
    } catch (error) {
      this.options.logger?.warn({ err: error }, 'SES could not be reached');
      return false;
    }
  }
}

/**
 * Amazon SES's own list of the addresses Hatti's account sends no more to (ADR-200): asked why it
 * has an address, and told to take one off as Hatti lifts it. SES's IAM user is allowed
 * ses:GetSuppressedDestination and ses:DeleteSuppressedDestination for it.
 */
export class SesSuppressions implements SesSuppressionList {
  readonly #ses: Ses;

  constructor(options: SesOptions) {
    this.#ses = new Ses(options);
  }

  async reasonOf(email: string): Promise<'bounce' | 'complaint' | null> {
    const response = await this.#ses.suppressed('GET', email);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`SES answered ${response.status} for a suppressed address`);
    const body = (await response.json().catch(() => ({}))) as {
      SuppressedDestination?: { Reason?: unknown };
    };
    switch (body.SuppressedDestination?.Reason) {
      case 'BOUNCE':
        return 'bounce';
      case 'COMPLAINT':
        return 'complaint';
      default:
        throw new Error('SES gave no reason for a suppressed address');
    }
  }

  async remove(email: string): Promise<void> {
    const response = await this.#ses.suppressed('DELETE', email);
    // Not on the list: nothing to take off.
    if (!response.ok && response.status !== 404) {
      throw new Error(`SES answered ${response.status} taking an address off its list`);
    }
  }
}

/** SES's own list of suppressed addresses (ADR-200), where SES is set up. */
export function sesSuppressionsOf(
  config: Pick<
    MessageSendingConfig,
    'SES_REGION' | 'SES_ACCESS_KEY_ID' | 'SES_SECRET_ACCESS_KEY' | 'SES_URL' | 'EMAIL_FROM'
  >,
): SesSuppressions | null {
  if (!config.SES_REGION || !config.SES_ACCESS_KEY_ID || !config.SES_SECRET_ACCESS_KEY) return null;
  return new SesSuppressions({
    region: config.SES_REGION,
    accessKeyId: config.SES_ACCESS_KEY_ID,
    secretAccessKey: config.SES_SECRET_ACCESS_KEY,
    from: config.EMAIL_FROM,
    baseUrl: config.SES_URL,
  });
}

/** What SES refuses for a while: its limits, and Hatti's sending paused or over its quota. */
const SES_RETRY_ERRORS = new Set([
  'TooManyRequestsException',
  'LimitExceededException',
  'SendingPausedException',
  'AccountSuspendedException',
]);

/**
 * Sends shops' emails to their customers about their orders through Amazon SES (MSG-01, ADR-181):
 * from EMAIL_FROM's address under the shop's name; and Hatti's notices of a shop's bills to its
 * owner from EMAIL_FROM itself (ADR-195). What SES refuses for a while, or cannot take for its own
 * trouble, is tried again; what it refuses of the email itself is not.
 */
export class SesMessageEmails implements MessageProvider {
  readonly name = SES_EMAIL;
  readonly channel = 'email' as const;
  readonly #ses: Ses;
  readonly #from: string;
  readonly #address: string;

  constructor(options: SesOptions) {
    this.#ses = new Ses(options);
    this.#from = options.from;
    this.#address = addressOf(options.from);
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    const email = messageEmail(message.kind, message.language, message.variables);
    if (!email) {
      return { ok: false, outcome: 'fail', error: `No email is written for ${message.kind}` };
    }
    let response: Response;
    try {
      response = await this.#ses.send({
        ...email,
        from:
          email.from === 'hatti' ? this.#from : namedAddress(message.variables.shop, this.#address),
        to: message.recipient,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, outcome: 'retry', error: `SES not reached: ${reason}` };
    }
    const body = (await response.json().catch(() => ({}))) as {
      MessageId?: unknown;
      message?: unknown;
    };
    if (response.ok) {
      // Taken: sending it again would send it twice, whatever SES said of it.
      const id = typeof body.MessageId === 'string' ? body.MessageId : `ses-${message.id}`;
      return { ok: true, providerMessageId: id };
    }
    const refusal = refusalOf(response, body.message);
    return { ok: false, outcome: refusal.retry ? 'retry' : 'fail', error: refusal.error };
  }
}

/** What SES refused, and whether it may pass later: its limits, its own trouble, Hatti's pause. */
function refusalOf(response: Response, message: unknown): { retry: boolean; error: string } {
  // "MessageRejected:http://internal.amazon.com/coral/com.amazonaws.sesv2/".
  const type = response.headers.get('x-amzn-errortype')?.split(':')[0] ?? '';
  const retry = response.status >= 500 || response.status === 429 || SES_RETRY_ERRORS.has(type);
  const error = `SES ${type || response.status}: ${String(message ?? 'no reason given')}`;
  return { retry, error: error.slice(0, 1_000) };
}

/**
 * Sends scheduled exports of shops' orders through Amazon SES (ORD-11, ADR-183): from Hatti's own
 * address to the member of staff, the export attached, as a raw MIME message.
 */
export class SesExportEmails extends ScheduledExportSender {
  readonly #ses: Ses;

  constructor(private readonly options: SesOptions & { logger?: Pick<Logger, 'warn'> }) {
    super();
    this.#ses = new Ses(options);
  }

  async send(email: ScheduledExportEmail): Promise<'sent' | 'retry' | 'failed'> {
    const message = mimeMessage({
      ...email,
      from: this.options.from,
      date: this.options.now?.() ?? new Date(),
      boundary: `hatti-${randomBytes(12).toString('hex')}`,
    });
    try {
      const response = await this.#ses.sendRaw({ from: this.options.from, to: email.to, message });
      if (response.ok) return 'sent';
      const body = (await response.json().catch(() => ({}))) as { message?: unknown };
      const refusal = refusalOf(response, body.message);
      this.options.logger?.warn({ error: refusal.error }, 'SES refused a scheduled export');
      return refusal.retry ? 'retry' : 'failed';
    } catch (error) {
      this.options.logger?.warn({ err: error }, 'SES could not be reached');
      return 'retry';
    }
  }
}

/** Writes scheduled exports' emails to the log in place of sending them, in development. */
export class LogExportEmails extends ScheduledExportSender {
  constructor(private readonly logger: Pick<Logger, 'info'>) {
    super();
  }

  async send(email: ScheduledExportEmail): Promise<'sent'> {
    this.logger.info(
      {
        to: email.to,
        subject: email.subject,
        attachment: email.attachment.filename,
        bytes: email.attachment.content.length,
      },
      'scheduled export not sent',
    );
    return 'sent';
  }
}

/**
 * Where scheduled exports' emails go out (ADR-183): through Amazon SES where it is set up, to the
 * log in development, and nowhere in production without it, where they wait.
 */
export function exportEmailsOf(
  config: MessageSendingConfig,
  logger: Logger,
): ScheduledExportSender | null {
  if (config.SES_REGION && config.SES_ACCESS_KEY_ID && config.SES_SECRET_ACCESS_KEY) {
    return new SesExportEmails({
      region: config.SES_REGION,
      accessKeyId: config.SES_ACCESS_KEY_ID,
      secretAccessKey: config.SES_SECRET_ACCESS_KEY,
      from: config.EMAIL_FROM,
      baseUrl: config.SES_URL,
      logger,
    });
  }
  return config.NODE_ENV === 'production' ? null : new LogExportEmails(logger);
}

/**
 * An email with a file attached, as a MIME message (RFC 5322, RFC 2045): its words as text and as
 * HTML, each in UTF-8, and the file, all in base64 in lines of 76; a subject that is not ASCII in
 * encoded words.
 */
export function mimeMessage(email: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  attachment: { filename: string; contentType: string; content: Buffer };
  date: Date;
  /**
   * Random, so that no line of the parts begins with a delimiter: "hatti-…-mixed" around them,
   * "hatti-…-words" around the words; a base64 line never has a hyphen.
   */
  boundary: string;
}): string {
  const mixed = `${email.boundary}-mixed`;
  const words = `${email.boundary}-words`;
  const base64 = (data: Buffer) =>
    data
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n') ?? '';
  const filename = email.attachment.filename.replace(/[^\w.-]/g, '_');
  return [
    `From: ${email.from}`,
    `To: ${email.to}`,
    `Subject: ${headerText(email.subject)}`,
    `Date: ${email.date.toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${words}"`,
    '',
    `--${words}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64(Buffer.from(email.text)),
    `--${words}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64(Buffer.from(email.html)),
    `--${words}--`,
    `--${mixed}`,
    `Content-Type: ${email.attachment.contentType}; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    base64(email.attachment.content),
    `--${mixed}--`,
    '',
  ].join('\r\n');
}

/** A header's text as it may be sent: ASCII as it is, anything else in encoded words. */
function headerText(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return /^[ -~]*$/.test(line) ? line : encodedWords(line).join('\r\n ');
}

/**
 * `text` in encoded words (RFC 2047), each of whole characters and within its limit of 75: 45
 * bytes are 60 characters of base64, 72 with "=?UTF-8?B?" and "?=".
 */
function encodedWords(text: string): string[] {
  const words: string[] = [];
  let word = '';
  for (const char of text) {
    if (Buffer.byteLength(word + char) > 45) {
      words.push(word);
      word = '';
    }
    word += char;
  }
  words.push(word);
  return words.map((part) => `=?UTF-8?B?${Buffer.from(part).toString('base64')}?=`);
}

/**
 * `address` under `name`, as an email's From has it (RFC 5322): the name quoted where it is
 * printable ASCII, and in encoded words (RFC 2047) where it is not, as an Urdu name, each of whole
 * characters and within its limit of 75. The address alone without a name.
 */
export function namedAddress(name: string | undefined, address: string): string {
  const shown = (name ?? '').replace(/\s+/g, ' ').trim();
  if (!shown) return address;
  if (/^[ -~]+$/.test(shown)) return `"${shown.replace(/["\\]/g, '\\$&')}" <${address}>`;
  return `${encodedWords(shown).join(' ')} <${address}>`;
}

/** The address alone of "Hatti <no-reply@hatti.pk>", or of a bare one. */
function addressOf(from: string): string {
  return (/<([^<>]+)>\s*$/.exec(from)?.[1] ?? from).trim();
}

/** Writes emails to the log in place of sending them, in development, links and all. */
export class LogEmails extends AccountEmailSender {
  constructor(private readonly logger: Pick<Logger, 'info'>) {
    super();
  }

  async send(email: AccountEmail): Promise<boolean> {
    this.logger.info({ to: email.to, subject: email.subject }, `not sent: ${email.text}`);
    return true;
  }
}

/**
 * Where Hatti's emails about accounts go out (ADR-165): through Amazon SES where it is set up, to
 * the log in development, and nowhere in production without it. Their links open the admin at
 * ADMIN_URL, or the first of the passkeys' origins. SES's bounces and complaints are heard where
 * its SNS topic is set (ADR-170), and its own list of suppressed addresses is kept in step as one
 * is lifted (ADR-200).
 */
export function accountEmailsOf(
  config: Pick<
    ApiConfig,
    | 'NODE_ENV'
    | 'ADMIN_URL'
    | 'SES_REGION'
    | 'SES_ACCESS_KEY_ID'
    | 'SES_SECRET_ACCESS_KEY'
    | 'SES_URL'
    | 'EMAIL_FROM'
    | 'SES_FEEDBACK_TOPIC_ARN'
    | 'PASSKEY_RP_ID'
    | 'PASSKEY_ORIGINS'
    | 'PUBLIC_URL'
    | 'PORT'
  >,
  logger: Logger,
): AccountEmails | null {
  const adminUrl = config.ADMIN_URL ?? passkeysOf(config).origins[0]!;
  if (config.SES_REGION && config.SES_ACCESS_KEY_ID && config.SES_SECRET_ACCESS_KEY) {
    return {
      sender: new SesEmails({
        region: config.SES_REGION,
        accessKeyId: config.SES_ACCESS_KEY_ID,
        secretAccessKey: config.SES_SECRET_ACCESS_KEY,
        from: config.EMAIL_FROM,
        baseUrl: config.SES_URL,
        logger,
      }),
      adminUrl,
      // SES's bounces and complaints, through SNS (ADR-170).
      feedback: config.SES_FEEDBACK_TOPIC_ARN ? { topicArn: config.SES_FEEDBACK_TOPIC_ARN } : null,
      suppressions: sesSuppressionsOf(config),
    };
  }
  return config.NODE_ENV === 'production' ? null : { sender: new LogEmails(logger), adminUrl };
}
