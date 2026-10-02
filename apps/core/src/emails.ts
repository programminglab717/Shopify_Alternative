import { createHash } from 'node:crypto';
import { AccountEmailSender, type AccountEmail, type AccountEmails } from '@hatti/identity/public';
import type { Logger } from '@hatti/logger';
import { signRequest } from '@hatti/storage';
import { passkeysOf, type ApiConfig } from './config.js';

/** Amazon SES's v2 API, sending Hatti's own emails about accounts one at a time (ADR-165). */
export class SesEmails extends AccountEmailSender {
  readonly #url: URL;

  constructor(
    private readonly options: {
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      /** "Hatti <no-reply@hatti.pk>", at a domain SES has verified. */
      from: string;
      /** The region's API unless given. */
      baseUrl?: string;
      timeoutMs?: number;
      now?: () => Date;
      logger?: Pick<Logger, 'warn'>;
    },
  ) {
    super();
    const base = options.baseUrl ?? `https://email.${options.region}.amazonaws.com`;
    this.#url = new URL('v2/email/outbound-emails', base.endsWith('/') ? base : `${base}/`);
  }

  async send(email: AccountEmail): Promise<boolean> {
    const utf8 = (data: string) => ({ Data: data, Charset: 'UTF-8' });
    const body = JSON.stringify({
      FromEmailAddress: this.options.from,
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
    try {
      const response = await fetch(this.#url, {
        method: 'POST',
        headers: { ...headers, ...signed },
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
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
 * ADMIN_URL, or the first of the passkeys' origins.
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
    };
  }
  return config.NODE_ENV === 'production' ? null : { sender: new LogEmails(logger), adminUrl };
}
