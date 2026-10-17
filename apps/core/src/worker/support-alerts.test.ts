import type { OpenSupportRequest } from '@hatti/billing/public';
import { AccountEmailSender, type AccountEmail } from '@hatti/identity/public';
import { toPublicId } from '@hatti/ids';
import { describe, expect, it } from 'vitest';
import { SupportAlerts } from './support-alerts.js';

const AT = new Date('2026-10-17T12:00:00Z');

const late = (overrides: Partial<OpenSupportRequest> = {}): OpenSupportRequest => ({
  id: '0192d5a0-0000-7000-8000-000000000001',
  topic: 'couriers',
  message: 'PostEx bookings fail\nfor Multan since this morning.',
  language: 'en',
  callBack: null,
  priority: 1,
  status: 'open',
  answer: null,
  answeredBy: null,
  answeredAt: null,
  createdAt: new Date('2026-10-17T01:00:00Z'),
  shopId: 'shop-1',
  shopName: 'Zari <Lahore>',
  plan: 'growth',
  dueAt: new Date('2026-10-17T09:00:00Z'),
  ...overrides,
});

class Sent extends AccountEmailSender {
  readonly emails: AccountEmail[] = [];

  constructor(private readonly answer = true) {
    super();
  }

  async send(email: AccountEmail): Promise<boolean> {
    this.emails.push(email);
    return this.answer;
  }
}

describe("Support requests past their time, told to Hatti's people (ADR-525)", () => {
  it('logs each request late and emails the list to the support address, once a sweep', async () => {
    const warned: unknown[] = [];
    const sent = new Sent();
    const second = late({
      id: '0192d5a0-0000-7000-8000-000000000002',
      shopName: 'B',
      plan: 'free',
      priority: 3,
      topic: 'billing',
      dueAt: new Date('2026-10-17T11:30:00Z'),
    });
    const alerts = new SupportAlerts(
      { overdue: async () => [late(), second] },
      sent,
      'help@hatti.pk',
      { warn: (...args: unknown[]) => void warned.push(args[0]) },
    );
    expect(await alerts.sweep(AT)).toEqual({ late: 2, emailed: true });
    expect(warned).toEqual([
      {
        request: toPublicId('supportRequest', late().id),
        shopId: 'shop-1',
        plan: 'growth',
        dueAt: '2026-10-17T09:00:00.000Z',
      },
      expect.objectContaining({ plan: 'free' }),
    ]);
    const [email] = sent.emails;
    expect(email).toMatchObject({
      to: 'help@hatti.pk',
      subject: '2 support requests are past their time',
    });
    expect(email!.text).toContain(
      'Zari <Lahore> (growth, P1), couriers: 3 hours past its time\n' +
        'PostEx bookings fail for Multan since this morning.\n' +
        `pnpm --filter @hatti/core support-requests answer ${toPublicId('supportRequest', late().id)}`,
    );
    // Under an hour late is said as an hour.
    expect(email!.text).toContain('B (free, P3), billing: 1 hour past its time');
    expect(email!.html).toContain('Zari &lt;Lahore&gt;');
    expect(email!.html).not.toContain('<Lahore>');
  });

  it('says one late request by its shop, and emails nothing when none is late', async () => {
    const sent = new Sent();
    let found: OpenSupportRequest[] = [late()];
    const alerts = new SupportAlerts({ overdue: async () => found }, sent, 'help@hatti.pk');
    await alerts.sweep(AT);
    expect(sent.emails.map((email) => email.subject)).toEqual([
      'A support request from Zari <Lahore> is past its time',
    ]);
    found = [];
    expect(await alerts.sweep(AT)).toEqual({ late: 0, emailed: false });
    expect(sent.emails).toHaveLength(1);
  });

  it('logs alone without the support address or SES, and logs an email SES refused', async () => {
    const warned: string[] = [];
    const logger = { warn: (...args: unknown[]) => void warned.push(String(args[1])) };
    expect(
      await new SupportAlerts({ overdue: async () => [late()] }, new Sent(), null, logger).sweep(
        AT,
      ),
    ).toEqual({ late: 1, emailed: false });
    expect(
      await new SupportAlerts({ overdue: async () => [late()] }, null, 'help@hatti.pk').sweep(AT),
    ).toEqual({ late: 1, emailed: false });
    expect(
      await new SupportAlerts(
        { overdue: async () => [late()] },
        new Sent(false),
        'help@hatti.pk',
        logger,
      ).sweep(AT),
    ).toEqual({ late: 1, emailed: false });
    expect(warned).toEqual([
      'support request past its time',
      'support request past its time',
      'support alert not emailed',
    ]);
  });
});
