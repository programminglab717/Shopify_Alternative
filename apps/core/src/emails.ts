import { createHash } from 'node:crypto';
import { AccountEmailSender, type AccountEmail, type AccountEmails } from '@hatti/identity/public';
import type { Logger } from '@hatti/logger';
import {
  messageEmail,
  type MessageProvider,
  type OutgoingMessage,
  type SendResult,
} from '@hatti/messaging/public';
import { signRequest } from '@hatti/storage';
import { passkeysOf, type ApiConfig } from './config.js';

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

/** Amazon SES's v2 API, sending one email at a time, each signed for SES in its region. */
class Ses {
  readonly #url: URL;

  constructor(private readonly options: SesOptions) {
    const base = options.baseUrl ?? `https://email.${options.region}.amazonaws.com`;
    this.#url = new URL('v2/email/outbound-emails', base.endsWith('/') ? base : `${base}/`);
  }

  /** Sends `email`: SES's answer. Throws when SES is not reached. */
  async send(email: SesEmail): Promise<Response> {
    const utf8 = (data: string) => ({ Data: data, Charset: 'UTF-8' });
    const body = JSON.stringify({
      FromEmailAddress: email.from,
      Destination: { ToAddresses: [email.to] },
      Content: {
        Simple: {
          Subject: utf8(email.subject),
          Body: { Text: utf8(email.text), Html: utf8(email.html) },
        },
      },
    });
    const headers = { 'content-type': 'application/json' };
    const signed = signRequest(
      'POST',
      this.#url,
      headers,
      createHash('sha256').update(body).digest('hex'),
      {
        credentials: {
          accessKeyId: this.options.accessKeyId,
          secretAccessKey: this.options.secretAccessKey,
        },
        region: this.options.region,
        date: this.options.now?.() ?? new Date(),
        service: 'ses',
      },
    );
    return fetch(this.#url, {
      method: 'POST',
      headers: { ...headers, ...signed },
      body,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    });
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

/** What SES refuses for a while: its limits, and Hatti's sending paused or over its quota. */
const SES_RETRY_ERRORS = new Set([
  'TooManyRequestsException',
  'LimitExceededException',
  'SendingPausedException',
  'AccountSuspendedException',
]);

/**
 * Sends shops' emails to their customers about their orders through Amazon SES (MSG-01, ADR-181):
 * from EMAIL_FROM's address under the shop's name. What SES refuses for a while, or cannot take
 * for its own trouble, is tried again; what it refuses of the email itself is not.
 */
export class SesMessageEmails implements MessageProvider {
  readonly name = 'ses';
  readonly channel = 'email' as const;
  readonly #ses: Ses;
  readonly #address: string;

  constructor(options: SesOptions) {
    this.#ses = new Ses(options);
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
        from: namedAddress(message.variables.shop, this.#address),
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
    // "MessageRejected:http://internal.amazon.com/coral/com.amazonaws.sesv2/".
    const type = response.headers.get('x-amzn-errortype')?.split(':')[0] ?? '';
    const retry = response.status >= 500 || response.status === 429 || SES_RETRY_ERRORS.has(type);
    return {
      ok: false,
      outcome: retry ? 'retry' : 'fail',
      error: `SES ${type || response.status}: ${String(body.message ?? 'no reason given')}`.slice(
        0,
        1_000,
      ),
    };
  }
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
  const words: string[] = [];
  let word = '';
  for (const char of shown) {
    // 45 bytes are 60 characters of base64: 72 with "=?UTF-8?B?" and "?=".
    if (Buffer.byteLength(word + char) > 45) {
      words.push(word);
      word = '';
    }
    word += char;
  }
  words.push(word);
  const encoded = words.map((part) => `=?UTF-8?B?${Buffer.from(part).toString('base64')}?=`);
  return `${encoded.join(' ')} <${address}>`;
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
 * its SNS topic is set (ADR-170).
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
    };
  }
  return config.NODE_ENV === 'production' ? null : { sender: new LogEmails(logger), adminUrl };
}
