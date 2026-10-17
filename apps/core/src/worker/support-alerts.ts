import type { OpenSupportRequest, SupportService } from '@hatti/billing/public';
import type { AccountEmail, AccountEmailSender } from '@hatti/identity/public';
import { toPublicId } from '@hatti/ids';
import type { Logger } from '@hatti/logger';
import { repeat } from './repeat.js';

/**
 * Tells Hatti's people of shops' requests still open past the time their plan answers in (BIL-05,
 * ADR-525): each once, as the support module flags it, logged as a warning and listed in one email
 * a sweep to Hatti's support address, the most urgent first. Without the address or SES, the log
 * alone says so.
 */
export class SupportAlerts {
  constructor(
    private readonly support: Pick<SupportService, 'overdue'>,
    private readonly emails: AccountEmailSender | null,
    /** Hatti's support address; null where none is set. */
    private readonly to: string | null,
    private readonly logger?: Pick<Logger, 'warn'>,
  ) {}

  /** Flags the requests late at `at`: how many, and whether the email about them went. */
  async sweep(at: Date = new Date()): Promise<{ late: number; emailed: boolean }> {
    const late = await this.support.overdue(at);
    for (const request of late) {
      this.logger?.warn(
        {
          request: toPublicId('supportRequest', request.id),
          shopId: request.shopId,
          plan: request.plan,
          dueAt: request.dueAt.toISOString(),
        },
        'support request past its time',
      );
    }
    if (late.length === 0 || !this.emails || !this.to) return { late: late.length, emailed: false };
    const emailed = await this.emails.send(supportAlertEmail(this.to, late, at));
    if (!emailed) this.logger?.warn({ late: late.length }, 'support alert not emailed');
    return { late: late.length, emailed };
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'support alerts sweep failed'),
    );
  }
}

/**
 * The email listing requests late at `at`: for each, its shop and plan, how long past its time,
 * its topic and the shop's words, and how to answer it with the command.
 */
export function supportAlertEmail(
  to: string,
  late: readonly OpenSupportRequest[],
  at: Date,
): AccountEmail {
  const subject =
    late.length === 1
      ? `A support request from ${late[0]!.shopName} is past its time`
      : `${late.length} support requests are past their time`;
  const items = late.map((request) => {
    const hours = Math.max(1, Math.floor((at.getTime() - request.dueAt.getTime()) / 3_600_000));
    return {
      head:
        `${request.shopName} (${request.plan}, P${request.priority}), ${request.topic}: ` +
        `${hours} ${hours === 1 ? 'hour' : 'hours'} past its time`,
      message: request.message.replace(/\s+/g, ' '),
      answer: `pnpm --filter @hatti/core support-requests answer ${toPublicId('supportRequest', request.id)}`,
    };
  });
  const text = [
    'These shops are still waiting for an answer from Hatti, past the time their plans promise:',
    ...items.map((item) => `${item.head}\n${item.message}\n${item.answer}`),
    'Answer them in order, the most urgent first.',
  ].join('\n\n');
  const html =
    '<!doctype html><html lang="en"><body style="font-family:system-ui,sans-serif;' +
    'line-height:1.5;color:#1f2933">' +
    '<p>These shops are still waiting for an answer from Hatti, past the time their plans ' +
    'promise:</p>' +
    items
      .map(
        (item) =>
          `<p><strong>${escapeHtml(item.head)}</strong><br>${escapeHtml(item.message)}<br>` +
          `<code>${escapeHtml(item.answer)}</code></p>`,
      )
      .join('') +
    '<p>Answer them in order, the most urgent first.</p></body></html>';
  return { to, subject, text, html };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
