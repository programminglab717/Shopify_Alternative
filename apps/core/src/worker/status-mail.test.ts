import { PublicSite } from '@hatti/api';
import { AccountEmailSender, type AccountEmail } from '@hatti/identity/public';
import type { StatusRecipient, StatusUpdateToMail } from '@hatti/trust/public';
import { describe, expect, it } from 'vitest';
import { StatusMail } from './status-mail.js';

const SITE = new PublicSite('https://hatti.pk');
const AT = new Date('2026-10-17T09:00:00Z');

class Sent extends AccountEmailSender {
  readonly emails: AccountEmail[] = [];

  async send(email: AccountEmail): Promise<boolean> {
    this.emails.push(email);
    return !email.to.startsWith('bounce');
  }
}

const ayesha: StatusRecipient = { email: 'ayesha@example.pk', token: 'a'.repeat(32) };
const bounce: StatusRecipient = { email: 'bounce@example.pk', token: 'b'.repeat(32) };

const update: StatusUpdateToMail = {
  incidentId: '0192d5a0-0000-7000-8000-000000000001',
  kind: 'incident',
  title: 'WhatsApp messages <delayed>',
  titleUr: 'واٹس ایپ پیغامات میں تاخیر',
  components: ['whatsapp', 'sms'],
  status: 'identified',
  body: "Meta's servers are slow.",
  bodyUr: null,
  postedAt: AT,
};

function subscriptions(confirm: StatusRecipient[], updates: StatusUpdateToMail[]) {
  return {
    takeConfirmations: async () => confirm.splice(0),
    takeUpdates: async () => ({ updates: updates.splice(0), recipients: [ayesha, bounce] }),
  };
}

describe("The status page's emails, sent by the worker (BIL-06, ADR-535)", () => {
  it('emails each link to confirm, then each update to every confirmed address with its link to stop', async () => {
    const sent = new Sent();
    const warned: unknown[] = [];
    const mail = new StatusMail(subscriptions([ayesha], [update]), sent, SITE, {
      warn: (...args: unknown[]) => void warned.push(args[0]),
    });
    expect(await mail.sweep(AT)).toEqual({ sent: 2, failed: 1 });
    expect(warned).toEqual([{ failed: 1 }]);
    const [confirm, toAyesha] = sent.emails;
    expect(confirm).toMatchObject({
      to: 'ayesha@example.pk',
      subject: 'Confirm your Hatti status emails',
    });
    expect(confirm!.text).toContain(`https://hatti.pk/status/subscription/${'a'.repeat(32)}`);
    expect(toAyesha).toMatchObject({
      to: 'ayesha@example.pk',
      subject: 'Hatti status: WhatsApp messages <delayed> · Cause found',
    });
    expect(toAyesha!.text).toContain('واٹس ایپ پیغامات میں تاخیر · وجہ مل گئی');
    expect(toAyesha!.text).toContain('Touches: WhatsApp messages, SMS');
    expect(toAyesha!.text).toContain('The status page: https://hatti.pk/status');
    expect(toAyesha!.text).toContain(
      `Stop these emails: https://hatti.pk/status/subscription/${'a'.repeat(32)}`,
    );
    expect(toAyesha!.html).toContain('WhatsApp messages &lt;delayed&gt;');
    expect(toAyesha!.html).toContain('<span dir="rtl">واٹس ایپ');
    // The bounce's own link, never another's.
    expect(sent.emails[2]!.text).toContain('b'.repeat(32));
    expect(sent.emails[2]!.text).not.toContain('a'.repeat(32));
  });

  it('takes nothing without SES, to send once it is set up', async () => {
    const confirm = [ayesha];
    expect(await new StatusMail(subscriptions(confirm, []), null, SITE).sweep(AT)).toEqual({
      sent: 0,
      failed: 0,
    });
    expect(confirm).toHaveLength(1);
  });
});
