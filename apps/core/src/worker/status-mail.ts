import type { PublicSite } from '@hatti/api';
import type { AccountEmail, AccountEmailSender } from '@hatti/identity/public';
import type { Logger } from '@hatti/logger';
import {
  COMPONENT_WORDS,
  STATUS_SUBSCRIPTION_PATH,
  STATUS_WORDS,
  type StatusRecipient,
  type StatusSubscriptionsService,
  type StatusUpdateToMail,
} from '@hatti/trust/public';
import { repeat } from './repeat.js';

/**
 * Emails of Hatti's status page (BIL-06, ADR-535): to each address asked for, the link to confirm
 * it; to each confirmed, every update Hatti's people post, with the link to stop. Each once, as
 * the trust module hands them over. Without SES, nothing is taken, to be sent once it is set up.
 */
export class StatusMail {
  constructor(
    private readonly subscriptions: Pick<
      StatusSubscriptionsService,
      'takeConfirmations' | 'takeUpdates'
    >,
    private readonly emails: AccountEmailSender | null,
    private readonly site: PublicSite,
    private readonly logger?: Pick<Logger, 'warn'>,
  ) {}

  /** Emails what is due at `at`: how many emails went, and how many didn't. */
  async sweep(at: Date = new Date()): Promise<{ sent: number; failed: number }> {
    const emails = this.emails;
    if (!emails) return { sent: 0, failed: 0 };
    let sent = 0;
    let failed = 0;
    const deliver = async (email: AccountEmail) => {
      if (await emails.send(email)) sent += 1;
      else failed += 1;
    };
    for (const recipient of await this.subscriptions.takeConfirmations(at)) {
      await deliver(confirmationEmail(recipient, this.linkOf(recipient)));
    }
    const { updates, recipients } = await this.subscriptions.takeUpdates(at);
    for (const update of updates) {
      for (const recipient of recipients) {
        await deliver(
          updateEmail(recipient, update, this.site.url('status'), this.linkOf(recipient)),
        );
      }
    }
    if (failed > 0) this.logger?.warn({ failed }, 'status emails not sent');
    return { sent, failed };
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'status emails sweep failed'),
    );
  }

  private linkOf(recipient: StatusRecipient): string {
    return this.site.url(`${STATUS_SUBSCRIPTION_PATH}/${recipient.token}`);
  }
}

/** The email asking an address to confirm, in English and Urdu. */
export function confirmationEmail(recipient: StatusRecipient, link: string): AccountEmail {
  const en = [
    "Someone, perhaps you, asked for Hatti's status emails at this address: an email each time " +
      'Hatti says something of an incident or maintenance.',
    `To get them, open this link and confirm: ${link}`,
    "If it wasn't you, do nothing: nothing more is sent.",
  ];
  const ur = [
    'کسی نے، شاید آپ نے، اس پتے پر ہٹی کی صورتحال کی ای میلز مانگی ہیں: جب بھی ہٹی کسی مسئلے یا مرمت کے بارے میں کچھ بتائے، ایک ای میل۔',
    `انہیں پانے کے لیے یہ لنک کھول کر تصدیق کریں: ${link}`,
    'اگر یہ آپ نہیں تھے تو کچھ نہ کریں: مزید کچھ نہیں بھیجا جائے گا۔',
  ];
  return {
    to: recipient.email,
    subject: 'Confirm your Hatti status emails',
    text: [...en, '', ...ur].join('\n\n'),
    html: page(
      [...en.map(escapeHtml), ...ur.map((line) => `<span dir="rtl">${escapeHtml(line)}</span>`)],
      link,
    ),
  };
}

/** An update's email: what it is about, its status, what Hatti said, in both languages. */
export function updateEmail(
  recipient: StatusRecipient,
  update: StatusUpdateToMail,
  statusUrl: string,
  stopLink: string,
): AccountEmail {
  const status = STATUS_WORDS[update.status];
  const touches = update.components.map((component) => COMPONENT_WORDS[component].en).join(', ');
  // Each line, and whether it is Urdu, to run right to left.
  const lines: [string, boolean][] = [
    [`${update.title} · ${status.en}`, false],
    ...(update.titleUr ? [[`${update.titleUr} · ${status.ur}`, true] as [string, boolean]] : []),
    [`Touches: ${touches}`, false],
    [update.body, false],
    ...(update.bodyUr ? [[update.bodyUr, true] as [string, boolean]] : []),
    [`The status page: ${statusUrl}`, false],
    [`Stop these emails: ${stopLink}`, false],
  ];
  return {
    to: recipient.email,
    subject: `Hatti status: ${update.title} · ${status.en}`,
    text: lines.map(([line]) => line).join('\n\n'),
    html: page(
      lines.map(([line, urdu]) =>
        urdu ? `<span dir="rtl">${escapeHtml(line)}</span>` : escapeHtml(line),
      ),
      null,
    ),
  };
}

function page(paragraphs: string[], link: string | null): string {
  return (
    '<!doctype html><html lang="en"><body style="font-family:system-ui,sans-serif;' +
    'line-height:1.5;color:#1f2933">' +
    paragraphs.map((each) => `<p>${each}</p>`).join('') +
    (link ? `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>` : '') +
    '</body></html>'
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
