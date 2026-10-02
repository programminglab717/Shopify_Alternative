import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { toPublicId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { invoicePage } from './billing-pages.js';
import { PLANS, periodEndOf } from './plans.js';
import { billingFixture, errorsOf, unwrap, type BillingFixture } from './test-support.js';

const server = testDatabaseServer();
const DAY = 24 * 3_600_000;

describe('periods', () => {
  it('end a month or a year on, on the same day or the last of a shorter month', () => {
    const at = (iso: string) => new Date(iso);
    expect(periodEndOf(at('2026-10-02T09:30:00Z'), 'monthly')).toEqual(at('2026-11-02T09:30:00Z'));
    expect(periodEndOf(at('2026-01-31T00:00:00Z'), 'monthly')).toEqual(at('2026-02-28T00:00:00Z'));
    expect(periodEndOf(at('2028-01-31T00:00:00Z'), 'monthly')).toEqual(at('2028-02-29T00:00:00Z'));
    expect(periodEndOf(at('2026-12-15T00:00:00Z'), 'monthly')).toEqual(at('2027-01-15T00:00:00Z'));
    expect(periodEndOf(at('2028-02-29T00:00:00Z'), 'yearly')).toEqual(at('2029-02-28T00:00:00Z'));
  });
});

describe.skipIf(!server)('Billing', () => {
  let f: BillingFixture;

  beforeAll(async () => {
    f = await billingFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  const publicId = (id: string) => toPublicId('billingInvoice', id);

  it('puts every shop on Free, with its limits, and lists the plans', async () => {
    expect(
      f.billing.plans().map((plan) => [plan.name, plan.prices.monthly, plan.prices.yearly]),
    ).toEqual([
      ['Free', 0n, 0n],
      ['Starter', 2_499_00n, 24_990_00n],
      ['Growth', 6_999_00n, 69_990_00n],
      ['Pro', 17_999_00n, 179_990_00n],
    ]);
    expect(await f.billing.subscriptionOf(f.a.shopId)).toMatchObject({
      plan: { code: 'free' },
      interval: null,
      periodEnd: null,
      pastDue: false,
      nextPlan: null,
      openInvoice: null,
    });
    expect(await f.billing.limitOf(f.a.shopId, 'staff')).toEqual({ limit: 1, plan: 'Free' });
    expect(await f.billing.limitOf(f.a.shopId, 'locations')).toEqual({ limit: 1, plan: 'Free' });
    expect(await f.billing.invoicesOf(f.a.shopId)).toEqual([]);
  });

  it("invoices a plan chosen from Free, which begins once paid through Hatti's gateway", async () => {
    expect(errorsOf(await f.billing.changePlan(f.a, { plan: 'gold' }))).toEqual([
      ['input.plan', 'INVALID'],
    ]);
    expect(errorsOf(await f.billing.changePlan(f.a, { plan: 'growth' }))).toEqual([
      ['input.interval', 'BLANK'],
    ]);
    expect(
      errorsOf(await f.billing.changePlan(f.a, { plan: 'free', interval: 'monthly' })),
    ).toEqual([['input.interval', 'INVALID']]);
    expect(errorsOf(await f.billing.changePlan(f.a, { plan: 'free' }))).toEqual([
      ['input.plan', 'INVALID'],
    ]);

    const chosen = unwrap(await f.billing.changePlan(f.a, { plan: 'growth', interval: 'monthly' }));
    const invoice = chosen.invoice!;
    expect(invoice).toMatchObject({
      name: expect.stringMatching(/^HB-\d{6}$/),
      reason: 'change',
      plan: { code: 'growth' },
      interval: 'monthly',
      price: 6_999_00n,
      credit: 0n,
      amount: 6_999_00n,
      status: 'open',
    });
    // Still Free until it is paid.
    expect(chosen.subscription).toMatchObject({
      plan: { code: 'free' },
      openInvoice: { id: invoice.id },
    });

    const started = unwrap(await f.billing.pay(f.a, invoice.id));
    const page = `https://hatti.test/billing/invoices/${publicId(invoice.id)}`;
    expect(f.gateway.checkouts).toMatchObject([
      {
        amount: 6_999_00n,
        currency: 'PKR',
        orderName: invoice.name,
        returnUrl: `${page}/paid`,
        cancelUrl: page,
      },
    ]);
    // Asked again soon after, the same page.
    expect(unwrap(await f.billing.pay(f.a, invoice.id))).toEqual(started);
    expect(f.gateway.checkouts).toHaveLength(1);
    // The other shop cannot pay it, nor see it.
    expect(errorsOf(await f.billing.pay(f.b, invoice.id))).toEqual([['id', 'NOT_FOUND']]);
    expect(await f.billing.invoicesOf(f.b.shopId)).toEqual([]);

    // Back with a form not signed with Hatti's secret: nothing paid.
    const forged = await f.billing.returned(publicId(invoice.id), {
      ...f.formOf(started.url),
      sig: '00',
    });
    expect(forged?.invoice.status).toBe('open');
    expect(invoicePage(forged).html).toContain('It waits for its payment');

    const paid = (await f.billing.returned(publicId(invoice.id), f.formOf(started.url)))!;
    expect(paid.invoice).toMatchObject({ status: 'paid', reference: expect.stringMatching(/^T-/) });
    const subscription = await f.billing.subscriptionOf(f.a.shopId);
    expect(subscription).toMatchObject({
      plan: { code: 'growth' },
      interval: 'monthly',
      pastDue: false,
      openInvoice: null,
    });
    expect(subscription.periodEnd).toEqual(periodEndOf(subscription.periodStart!, 'monthly'));
    expect(Math.abs(subscription.periodStart!.getTime() - Date.now())).toBeLessThan(60_000);
    expect(paid.periodEnd).toEqual(subscription.periodEnd);
    expect(invoicePage(paid).html).toContain(
      `Thank you: invoice ${invoice.name} is paid. Zari is on Growth until`,
    );
    expect(await f.billing.limitOf(f.a.shopId, 'staff')).toEqual({ limit: 8, plan: 'Growth' });
    expect(await f.billing.limitOf(f.a.shopId, 'locations')).toEqual({ limit: 3, plan: 'Growth' });
    // Reloaded, nothing changes; and a paid invoice is not paid again.
    await f.billing.returned(publicId(invoice.id), f.formOf(started.url));
    expect(errorsOf(await f.billing.pay(f.a, invoice.id))).toEqual([['id', 'INVALID']]);
    expect((await f.outbox()).map((event) => event.event_type)).toEqual([
      'billing_invoice.created',
      'billing_invoice.paid',
      'billing_subscription.changed',
    ]);
    const { rows: audit } = await f.admin.query<{ action: string; details: unknown }>(
      'SELECT action, details FROM platform.audit_log',
    );
    expect(audit).toEqual([
      {
        action: 'billing.plan_chosen',
        details: { plan: 'growth', interval: 'monthly', begins: 'now' },
      },
    ]);
    expect(invoicePage(await f.billing.pageOf('binv_nothing')).status).toBe(404);
  });

  it('takes off what is left of a period a bigger plan cuts short, and leaves a smaller one for its end', async () => {
    const now = Date.now();
    const month = { start: new Date(now - 10 * DAY), end: new Date(now + 20 * DAY) };
    await f.subscribe(f.a, 'growth', 'monthly', month);
    expect(
      errorsOf(await f.billing.changePlan(f.a, { plan: 'growth', interval: 'monthly' })),
    ).toEqual([['input.plan', 'INVALID']]);

    // Bigger: Pro now, less two thirds of Growth's month, in whole rupees.
    const pro = unwrap(
      await f.billing.changePlan(f.a, { plan: 'pro', interval: 'monthly' }),
    ).invoice!;
    expect(pro.price).toBe(17_999_00n);
    expect(pro.credit >= 4_665_00n && pro.credit <= 4_666_00n).toBe(true);
    expect(pro.credit % 100n).toBe(0n);
    expect(pro.amount).toBe(pro.price - pro.credit);

    // Smaller: Starter when the month ends; the invoice for Pro gives way.
    const smaller = unwrap(
      await f.billing.changePlan(f.a, { plan: 'starter', interval: 'monthly' }),
    );
    expect(smaller.invoice).toBeNull();
    expect(smaller.subscription).toMatchObject({
      plan: { code: 'growth' },
      nextPlan: { code: 'starter' },
      nextInterval: 'monthly',
      openInvoice: null,
    });
    expect((await f.billing.invoicesOf(f.a.shopId)).map((invoice) => invoice.status)).toEqual([
      'void',
    ]);
    // Growth again: kept, the change for later dropped.
    expect(
      unwrap(await f.billing.changePlan(f.a, { plan: 'growth', interval: 'monthly' })).subscription,
    ).toMatchObject({ plan: { code: 'growth' }, nextPlan: null });
    // Free, when the month ends.
    expect(unwrap(await f.billing.changePlan(f.a, { plan: 'free' })).subscription).toMatchObject({
      plan: { code: 'growth' },
      nextPlan: { code: 'free' },
      nextInterval: null,
    });
    // The same plan by the year: at once, less what is left of the month.
    const yearly = unwrap(
      await f.billing.changePlan(f.a, { plan: 'growth', interval: 'yearly' }),
    ).invoice!;
    expect([yearly.price, yearly.credit >= 4_665_00n && yearly.credit <= 4_666_00n]).toEqual([
      69_990_00n,
      true,
    ]);
    // A yearly plan stays yearly until its year ends: Pro by the month waits for it.
    await f.subscribe(f.a, 'growth', 'yearly', {
      start: new Date(now - 100 * DAY),
      end: new Date(now + 265 * DAY),
    });
    const later = unwrap(await f.billing.changePlan(f.a, { plan: 'pro', interval: 'monthly' }));
    expect(later).toMatchObject({ invoice: null, subscription: { nextPlan: { code: 'pro' } } });
    expect(
      unwrap(await f.billing.changePlan(f.a, { plan: 'pro', interval: 'yearly' })).invoice,
    ).toMatchObject({ price: 179_990_00n, status: 'open' });
    // The audit log has each choice.
    const { rows } = await f.admin.query<{ begins: string }>(
      `SELECT details->>'begins' AS begins FROM platform.audit_log ORDER BY occurred_at, id`,
    );
    expect(rows.map((row) => row.begins)).toEqual([
      'now',
      'period_end',
      'kept',
      'period_end',
      'now',
      'period_end',
      'now',
    ]);
  });

  it('renews a week ahead, carries the paid period on, and puts unpaid or ended plans on Free', async () => {
    const now = Date.now();
    const soon = { start: new Date(now - 27 * DAY), end: new Date(now + 3 * DAY) };
    await f.subscribe(f.a, 'starter', 'monthly', soon);
    await f.subscribe(f.b, 'growth', 'monthly', {
      start: new Date(now - 10 * DAY),
      end: new Date(now + 20 * DAY),
    });
    expect(await f.billing.sweep()).toEqual({ invoiced: 1, ended: 0, failed: 0 });
    expect(await f.billing.sweep()).toEqual({ invoiced: 0, ended: 0, failed: 0 });
    const [renewal] = await f.billing.invoicesOf(f.a.shopId);
    expect(renewal).toMatchObject({
      reason: 'renewal',
      plan: { code: 'starter' },
      price: 2_499_00n,
      credit: 0n,
      status: 'open',
    });
    expect(await f.billing.invoicesOf(f.b.shopId)).toEqual([]);
    // Paid early, the next month follows on from this one's end.
    const started = unwrap(await f.billing.pay(f.a, renewal!.id));
    await f.billing.returned(publicId(renewal!.id), f.formOf(started.url));
    const renewed = await f.billing.subscriptionOf(f.a.shopId);
    expect(renewed.periodStart).toEqual(soon.end);
    expect(renewed.periodEnd).toEqual(periodEndOf(soon.end, 'monthly'));

    // Unpaid past its end: the plan stays a week, then the shop is on Free.
    const ended = new Date(now - 2 * DAY);
    await f.subscribe(f.b, 'growth', 'monthly', { start: new Date(now - 32 * DAY), end: ended });
    expect(await f.billing.sweep()).toEqual({ invoiced: 1, ended: 0, failed: 0 });
    expect(await f.billing.subscriptionOf(f.b.shopId)).toMatchObject({
      plan: { code: 'growth' },
      pastDue: true,
      openInvoice: { reason: 'renewal' },
    });
    expect(await f.billing.sweep(new Date(now + 6 * DAY))).toEqual({
      invoiced: 0,
      ended: 1,
      failed: 0,
    });
    const lapsed = await f.billing.subscriptionOf(f.b.shopId);
    expect(lapsed).toMatchObject({ plan: { code: 'free' }, periodEnd: null });
    // Its invoice stays open: paid later, the plan begins again from then.
    const late = unwrap(await f.billing.pay(f.b, lapsed.openInvoice!.id));
    await f.billing.returned(publicId(lapsed.openInvoice!.id), f.formOf(late.url));
    const again = await f.billing.subscriptionOf(f.b.shopId);
    expect(again.plan.code).toBe('growth');
    expect(Math.abs(again.periodStart!.getTime() - Date.now())).toBeLessThan(60_000);

    // Free chosen for when the month ends: on Free once it has, its invoices void.
    await f.subscribe(
      f.a,
      'starter',
      'monthly',
      { start: new Date(now - 31 * DAY), end: new Date(now - 3_600_000) },
      { plan: 'free', interval: null },
    );
    expect(await f.billing.sweep()).toEqual({ invoiced: 0, ended: 1, failed: 0 });
    expect(await f.billing.subscriptionOf(f.a.shopId)).toMatchObject({
      plan: { code: 'free' },
      nextPlan: null,
    });
    // A smaller plan chosen for later is invoiced once the period ends, not before.
    await f.subscribe(
      f.a,
      'growth',
      'monthly',
      { start: new Date(now - 27 * DAY), end: new Date(now + 3 * DAY) },
      { plan: 'starter', interval: 'monthly' },
    );
    expect(await f.billing.sweep()).toEqual({ invoiced: 0, ended: 0, failed: 0 });
    expect(await f.billing.sweep(new Date(now + 3 * DAY + 3_600_000))).toEqual({
      invoiced: 1,
      ended: 0,
      failed: 0,
    });
    expect((await f.billing.subscriptionOf(f.a.shopId)).openInvoice).toMatchObject({
      reason: 'renewal',
      plan: { code: 'starter' },
    });
    expect(
      (await f.outbox())
        .filter((event) => event.event_type === 'billing_subscription.changed')
        .map((event) => event.payload.reason),
    ).toEqual(['paid', 'lapsed', 'paid', 'ended']);
  });

  it("pays an invoice from Hatti's webhook once, even one set aside meanwhile", async () => {
    const first = unwrap(
      await f.billing.changePlan(f.a, { plan: 'starter', interval: 'monthly' }),
    ).invoice!;
    unwrap(await f.billing.pay(f.a, first.id));
    const { ref } = f.gateway.checkouts[0]!;
    // Another plan chosen before it is paid: the first invoice gives way.
    const second = unwrap(
      await f.billing.changePlan(f.a, { plan: 'growth', interval: 'monthly' }),
    ).invoice!;
    expect((await f.billing.invoicesOf(f.a.shopId)).map((invoice) => invoice.status)).toEqual([
      'open',
      'void',
    ]);
    const webhook = f.gateway.webhookFor(f.hatti.account, { ref, amount: 2_499_00n });
    expect(
      await f.billing.webhook({ ...webhook, headers: { 'x-test-signature': 'f'.repeat(64) } }),
    ).toBe('unsigned');
    // The shop paid the first all the same: it pays it, and the second gives way.
    expect(await f.billing.webhook(webhook)).toBe('paid');
    expect(await f.billing.webhook(webhook)).toBe('paid');
    expect(
      (await f.billing.invoicesOf(f.a.shopId)).map((invoice) => [invoice.id, invoice.status]),
    ).toEqual([
      [second.id, 'void'],
      [first.id, 'paid'],
    ]);
    expect((await f.billing.subscriptionOf(f.a.shopId)).plan.code).toBe('starter');
    expect(
      (await f.outbox()).filter((event) => event.event_type === 'billing_invoice.paid'),
    ).toHaveLength(1);
    // A payment not started here is left alone.
    expect(
      await f.billing.webhook(f.gateway.webhookFor(f.hatti.account, { ref: 'test_x', amount: 1n })),
    ).toBe('ignored');

    // A host with no gateway for Hatti takes nothing online.
    const third = unwrap(
      await f.billing.changePlan(f.a, { plan: 'pro', interval: 'yearly' }),
    ).invoice!;
    const unpaid = await f.unpaid.pay(f.a, third.id);
    expect(unpaid.ok ? null : unpaid.errors[0]!.message).toBe(
      "Paying Hatti online isn't set up here",
    );
    expect(await f.unpaid.webhook(webhook)).toBe('not_found');
    // The gateway refusing: said, and recorded.
    f.gateway.refusing = 'Test gateway: down';
    const refused = await f.billing.pay(f.a, third.id);
    expect(refused.ok ? null : refused.errors[0]!.message).toBe(
      "Paying online isn't working right now: Test gateway: down",
    );
    expect(PLANS.pro.prices.yearly).toBe(third.price);
  });
});
