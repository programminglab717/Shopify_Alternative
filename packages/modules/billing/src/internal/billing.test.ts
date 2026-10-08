import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId, toPublicId } from '@hatti/ids';
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
    // Free alone limits orders a month (ADR-263).
    expect(await f.billing.limitOf(f.a.shopId, 'ordersPerMonth')).toEqual({
      limit: 50,
      plan: 'Free',
    });
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
    expect(await f.billing.limitOf(f.a.shopId, 'ordersPerMonth')).toBeNull();
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

  it("pays an invoice by transfer into Hatti's account, once Hatti's people find it (ADR-254)", async () => {
    const invoice = unwrap(
      await f.billing.changePlan(f.a, { plan: 'growth', interval: 'monthly' }),
    ).invoice!;
    // Its page shows Hatti's account, the IBAN in fours, and its name for the transfer's remarks.
    const page = invoicePage(await f.billing.pageOf(publicId(invoice.id))).html;
    expect(page).toContain('PK36 SCBL 0000 0011 2345 6702');
    expect(page).toContain('0300 1234567');
    expect(page).toContain(`Write ${invoice.name} in the transfer&#39;s remarks.`);
    expect(f.billing.bankAccount()).toEqual(f.bank);
    // A host with no account of Hatti's takes no transfers, and shows none.
    const unset = await f.unpaid.reportTransfer(f.a, invoice.id, { reference: 'FT24100012' });
    expect(unset.ok ? null : unset.errors[0]!.message).toBe(
      "Paying Hatti by transfer isn't set up here",
    );
    expect(invoicePage(await f.unpaid.pageOf(publicId(invoice.id))).html).not.toContain('IBAN');
    expect(f.unpaid.bankAccount()).toBeNull();

    const report = (tenant = f.a, reference = 'FT 2410 0012', id = invoice.id) =>
      f.billing.reportTransfer(tenant, id, { reference });
    expect(errorsOf(await report(f.a, ' '))).toEqual([['reference', 'BLANK']]);
    expect(errorsOf(await report(f.a, 'FT1'))).toEqual([['reference', 'INVALID']]);
    expect(errorsOf(await report(f.a, 'FT<2410>'))).toEqual([['reference', 'INVALID']]);
    expect(errorsOf(await report(f.a, 'F'.repeat(65)))).toEqual([['reference', 'TOO_LONG']]);
    // Another shop's invoice is not found.
    expect(errorsOf(await report(f.b))).toEqual([['id', 'NOT_FOUND']]);

    const said = unwrap(await report());
    expect(said).toEqual({
      id: expect.any(String),
      invoiceId: invoice.id,
      reference: 'FT 2410 0012',
      amount: 6_999_00n,
      status: 'waiting',
      received: null,
      refusal: null,
      reportedAt: expect.any(Date),
      checkedAt: null,
    });
    // An invoice waits on one transfer at a time.
    const twice = await report(f.a, 'FT 2410 0013');
    expect(twice.ok ? null : twice.errors[0]!.message).toBe(
      `A transfer for invoice ${invoice.name} waits for Hatti to find it`,
    );
    // Hatti's people see it waiting, whichever shop said it.
    expect(await f.billing.waitingTransfers()).toEqual([
      { ...said, shopId: f.a.shopId, shopName: 'Zari', invoiceName: invoice.name },
    ]);
    // A reference is given once, for whichever of the shop's invoices.
    const credit = unwrap(await f.billing.buyCredits(f.a, { amount: '1000' })).invoice;
    expect(errorsOf(await report(f.a, 'ft 2410 0012', credit.id))).toEqual([
      ['reference', 'TAKEN'],
    ]);

    // Not found as said: refused, saying why, on one line; then checked, it stays so.
    expect(
      await f.billing.refuseTransfer(said.id, {
        by: ' Ayesha ',
        reason: '  No such transfer\n  reached us.  ',
      }),
    ).toEqual({ outcome: 'refused', invoiceName: invoice.name, left: 6_999_00n });
    expect(await f.billing.refuseTransfer(said.id, { by: 'Ayesha', reason: 'Again' })).toBe(
      'checked',
    );
    expect(await f.billing.confirmTransfer(said.id, { by: 'Ayesha' })).toBe('checked');
    expect(await f.billing.waitingTransfers()).toEqual([]);
    // Refused, its reference may be given again: the money may come late.
    const again = unwrap(await report(f.a, 'ft 2410 0012'));
    // Found short of the invoice: kept, and the invoice waits for the rest.
    expect(await f.billing.confirmTransfer(again.id, { by: 'Bilal', received: 6_000_00n })).toEqual(
      { outcome: 'short', invoiceName: invoice.name, left: 999_00n },
    );
    expect((await f.billing.subscriptionOf(f.a.shopId)).plan.code).toBe('free');
    // The rest, said and found as said: with the first, it pays the invoice, and its plan begins.
    const rest = unwrap(await report(f.a, 'RAAST-77001'));
    expect(await f.billing.confirmTransfer(rest.id, { by: 'Bilal', received: 999_00n })).toEqual({
      outcome: 'paid',
      invoiceName: invoice.name,
      left: 0n,
    });
    expect(await f.billing.subscriptionOf(f.a.shopId)).toMatchObject({
      plan: { code: 'growth' },
      interval: 'monthly',
      openInvoice: null,
    });
    const paid = (await f.billing.invoicesOf(f.a.shopId)).find((each) => each.id === invoice.id);
    expect(paid).toMatchObject({ status: 'paid', reference: 'RAAST-77001' });
    expect(
      (await f.billing.transfersOf(f.a.shopId, [invoice.id]))
        .get(invoice.id)!
        .map((each) => [
          each.reference,
          each.status,
          each.received,
          each.refusal,
          each.checkedAt instanceof Date,
        ]),
    ).toEqual([
      ['RAAST-77001', 'confirmed', 999_00n, null, true],
      ['ft 2410 0012', 'confirmed', 6_000_00n, null, true],
      ['FT 2410 0012', 'refused', null, 'No such transfer reached us.', true],
    ]);
    // A paid invoice takes no transfer; the other shop sees none of them.
    expect(errorsOf(await report(f.a, 'FT 9999 0001'))).toEqual([['id', 'INVALID']]);
    expect((await f.billing.transfersOf(f.b.shopId, [invoice.id])).get(invoice.id)).toEqual([]);
    const { rows: checkers } = await f.admin.query<{ checked_by: string }>(
      `SELECT checked_by FROM billing.payments WHERE gateway = 'bank_transfer'
        ORDER BY created_at`,
    );
    expect(checkers.map((row) => row.checked_by)).toEqual(['Ayesha', 'Bilal', 'Bilal']);

    // Said for credit that was then paid online: found all the same, it is Hatti's to give back.
    const forCredit = unwrap(await report(f.a, 'IBFT-555', credit.id));
    unwrap(await f.billing.pay(f.a, credit.id));
    const { ref } = f.gateway.checkouts.at(-1)!;
    expect(
      await f.billing.webhook(f.gateway.webhookFor(f.hatti.account, { ref, amount: 1_000_00n })),
    ).toBe('paid');
    expect(await f.billing.confirmTransfer(forCredit.id, { by: 'Bilal' })).toEqual({
      outcome: 'already_paid',
      invoiceName: credit.name,
      left: 0n,
    });
    expect(await f.wallet.balanceOf(f.a.shopId)).toBe(1_000_00n);
    expect(await f.billing.confirmTransfer(newId(), { by: 'Bilal' })).toBe('not_found');
    expect(await f.billing.refuseTransfer('btr_nothing', { by: 'Bilal', reason: 'x' })).toBe(
      'not_found',
    );

    expect(
      (await f.outbox())
        .filter((event) => event.event_type.startsWith('billing_invoice.transfer'))
        .map((event) => [event.event_type, event.payload]),
    ).toEqual([
      [
        'billing_invoice.transfer_reported',
        { number: invoice.name, amount: '699900', reference: 'FT 2410 0012' },
      ],
      [
        'billing_invoice.transfer_refused',
        {
          number: invoice.name,
          amount: '699900',
          reference: 'FT 2410 0012',
          reason: 'No such transfer reached us.',
        },
      ],
      [
        'billing_invoice.transfer_reported',
        { number: invoice.name, amount: '699900', reference: 'ft 2410 0012' },
      ],
      [
        'billing_invoice.transfer_confirmed',
        {
          number: invoice.name,
          amount: '699900',
          reference: 'ft 2410 0012',
          received: '600000',
          paid: false,
        },
      ],
      [
        'billing_invoice.transfer_reported',
        { number: invoice.name, amount: '699900', reference: 'RAAST-77001' },
      ],
      [
        'billing_invoice.transfer_confirmed',
        {
          number: invoice.name,
          amount: '699900',
          reference: 'RAAST-77001',
          received: '99900',
          paid: true,
        },
      ],
      [
        'billing_invoice.transfer_reported',
        { number: credit.name, amount: '100000', reference: 'IBFT-555' },
      ],
      [
        'billing_invoice.transfer_confirmed',
        {
          number: credit.name,
          amount: '100000',
          reference: 'IBFT-555',
          received: '100000',
          paid: false,
        },
      ],
    ]);
    const { rows: audit } = await f.admin.query<{ action: string; details: unknown }>(
      `SELECT action, details FROM platform.audit_log WHERE action = 'billing.transfer_reported'
        ORDER BY occurred_at, id`,
    );
    expect(audit.map((row) => row.details)).toEqual([
      { invoice: invoice.name, reference: 'FT 2410 0012', amount: '699900' },
      { invoice: invoice.name, reference: 'ft 2410 0012', amount: '699900' },
      { invoice: invoice.name, reference: 'RAAST-77001', amount: '699900' },
      { invoice: credit.name, reference: 'IBFT-555', amount: '100000' },
    ]);
  });

  it("buys message credit with an invoice of its own, the shop's once paid", async () => {
    for (const [amount, code] of [
      ['', 'BLANK'],
      ['lots', 'INVALID'],
      ['499', 'INVALID'],
      ['100001', 'INVALID'],
      ['1000.50', 'INVALID'],
    ] as const) {
      expect(errorsOf(await f.billing.buyCredits(f.a, { amount })), amount).toEqual([
        ['input.amount', code],
      ]);
    }
    // A plan waiting to be paid, and credit chosen twice: the first credit gives way, not the plan.
    const plan = unwrap(
      await f.billing.changePlan(f.a, { plan: 'growth', interval: 'monthly' }),
    ).invoice!;
    const first = unwrap(await f.billing.buyCredits(f.a, { amount: '2000' })).invoice;
    const credit = unwrap(await f.billing.buyCredits(f.a, { amount: '1,500' })).invoice;
    expect(credit).toMatchObject({
      name: expect.stringMatching(/^HB-\d{6}$/),
      reason: 'credits',
      plan: null,
      interval: null,
      price: 1_500_00n,
      credit: 0n,
      amount: 1_500_00n,
      status: 'open',
    });
    expect(
      (await f.billing.invoicesOf(f.a.shopId)).map((invoice) => [invoice.id, invoice.status]),
    ).toEqual([
      [credit.id, 'open'],
      [first.id, 'void'],
      [plan.id, 'open'],
    ]);
    expect(await f.billing.walletOf(f.a.shopId)).toEqual({ balance: 0n, openInvoice: credit });
    expect((await f.billing.subscriptionOf(f.a.shopId)).openInvoice?.id).toBe(plan.id);
    expect(invoicePage(await f.billing.pageOf(publicId(credit.id))).html).toContain(
      `Invoice ${credit.name}: Rs 1,500 for message credit.`,
    );

    const started = unwrap(await f.billing.pay(f.a, credit.id));
    expect(f.gateway.checkouts).toMatchObject([
      { amount: 1_500_00n, currency: 'PKR', orderName: credit.name },
    ]);
    const paid = (await f.billing.returned(publicId(credit.id), f.formOf(started.url)))!;
    expect(paid.invoice.status).toBe('paid');
    expect(invoicePage(paid).html).toContain(
      `Thank you: invoice ${credit.name} is paid. Rs 1,500 of message credit is added to Zari&#39;s.`,
    );
    // Reloaded: added once.
    await f.billing.returned(publicId(credit.id), f.formOf(started.url));
    expect(await f.billing.walletOf(f.a.shopId)).toEqual({ balance: 1_500_00n, openInvoice: null });
    expect(await f.billing.walletEntriesOf(f.a.shopId)).toMatchObject([
      {
        kind: 'top_up',
        amount: 1_500_00n,
        balance: 1_500_00n,
        invoiceId: credit.id,
        messageId: null,
        cost: null,
      },
    ]);
    // The plan is as it was: Free, its invoice still waiting.
    expect(await f.billing.subscriptionOf(f.a.shopId)).toMatchObject({
      plan: { code: 'free' },
      openInvoice: { id: plan.id, status: 'open' },
    });
    // Renewals leave credit alone.
    expect(await f.billing.sweep()).toEqual({ invoiced: 0, ended: 0, failed: 0 });
    const events = await f.outbox();
    expect(events.map((event) => event.event_type)).toEqual([
      'billing_invoice.created',
      'billing_invoice.created',
      'billing_invoice.created',
      'billing_invoice.paid',
    ]);
    expect(events[3]!.payload).toEqual({
      number: credit.name,
      reason: 'credits',
      plan: null,
      interval: null,
      amount: '150000',
    });
    const { rows: audit } = await f.admin.query<{ action: string; details: unknown }>(
      'SELECT action, details FROM platform.audit_log ORDER BY occurred_at, id',
    );
    expect(audit.map((entry) => entry.action)).toEqual([
      'billing.plan_chosen',
      'billing.credits_chosen',
      'billing.credits_chosen',
    ]);
    expect(audit[2]!.details).toEqual({ amount: '150000', invoice: credit.name });
    // The other shop sees none of it.
    expect(await f.billing.walletOf(f.b.shopId)).toEqual({ balance: 0n, openInvoice: null });
    expect(await f.billing.walletEntriesOf(f.b.shopId)).toEqual([]);
  });

  it('pays each message from the credit at its price, once, and gives back what went undelivered', async () => {
    expect(
      f.billing.messagePrices().map((price) => [price.channel, price.category, price.price]),
    ).toEqual([
      ['whatsapp', 'utility', 4_62n],
      ['whatsapp', 'authentication', 4_62n],
      ['whatsapp', 'marketing', 14_58n],
      ['sms', 'utility', 1_73n],
      ['sms', 'authentication', 1_73n],
      ['sms', 'marketing', 1_73n],
    ]);
    const whatsapp = { channel: 'whatsapp', category: 'utility', parts: 1 } as const;
    const sms = { channel: 'sms', category: 'utility', parts: 2 } as const;
    expect(f.wallet.priceOf(sms)).toBe(3_46n);

    expect(await f.billing.grantCredits(f.a.shopId, 10_00n, 'To try messages with')).toBe(10_00n);
    const [first, second, third] = [newId(), newId(), newId()];
    const inShop = (work: Parameters<typeof f.db.tenant>[1]) => f.db.tenant(f.a.shopId, work);
    await inShop((tx) => f.wallet.chargeIn(tx, f.a.shopId, first, whatsapp));
    // Charged again, as a settle heard twice would: once.
    await inShop((tx) => f.wallet.chargeIn(tx, f.a.shopId, first, whatsapp));
    await inShop((tx) => f.wallet.chargeIn(tx, f.a.shopId, second, sms));
    // Sent at once with another: the credit goes below nothing.
    await inShop((tx) => f.wallet.chargeIn(tx, f.a.shopId, third, whatsapp));
    expect(await f.wallet.balanceOf(f.a.shopId)).toBe(-2_70n);
    // WhatsApp could not deliver the first: given back once; nothing for a message never charged.
    await inShop((tx) => f.wallet.refundIn(tx, f.a.shopId, first));
    await inShop((tx) => f.wallet.refundIn(tx, f.a.shopId, first));
    await inShop((tx) => f.wallet.refundIn(tx, f.a.shopId, newId()));
    expect(await f.wallet.balanceOf(f.a.shopId)).toBe(1_92n);
    expect(
      (await f.billing.walletEntriesOf(f.a.shopId)).map((entry) => [
        entry.kind,
        entry.amount,
        entry.balance,
        entry.messageId,
        entry.cost?.parts ?? null,
        entry.note,
      ]),
    ).toEqual([
      ['message_refund', 4_62n, 1_92n, first, 1, null],
      ['message', -4_62n, -2_70n, third, 1, null],
      ['message', -3_46n, 1_92n, second, 2, null],
      ['message', -4_62n, 5_38n, first, 1, null],
      ['grant', 10_00n, 10_00n, null, null, 'To try messages with'],
    ]);
    // Credit bought pays first for what the messages took below nothing.
    await inShop((tx) => f.wallet.chargeIn(tx, f.a.shopId, newId(), whatsapp));
    await inShop((tx) => f.wallet.chargeIn(tx, f.a.shopId, newId(), whatsapp));
    expect(await f.wallet.balanceOf(f.a.shopId)).toBe(-7_32n);
    const bought = unwrap(await f.billing.buyCredits(f.a, { amount: '500' })).invoice;
    const started = unwrap(await f.billing.pay(f.a, bought.id));
    await f.billing.returned(publicId(bought.id), f.formOf(started.url));
    expect(await f.wallet.balanceOf(f.a.shopId)).toBe(492_68n);
    // Another shop's credit is its own, and nothing until its first entry.
    expect(await f.wallet.balanceOf(f.b.shopId)).toBe(0n);
    await expect(f.billing.grantCredits(f.b.shopId, 0n, 'Nothing')).rejects.toThrow(RangeError);
  });

  it('tells of the credit falling below Rs 100, once each time a message takes it there', async () => {
    const whatsapp = { channel: 'whatsapp', category: 'utility', parts: 1 } as const;
    const charge = () =>
      f.db.tenant(f.a.shopId, (tx) => f.wallet.chargeIn(tx, f.a.shopId, newId(), whatsapp));
    const told = async () =>
      (await f.outbox())
        .filter((event) => event.event_type === 'billing_credit.low')
        .map((event) => [event.aggregate_id, event.payload.balance]);
    // Credit given below it says nothing: it never fell there.
    await f.billing.grantCredits(f.b.shopId, 50_00n, 'To try messages with');
    await f.billing.grantCredits(f.a.shopId, 105_00n, 'To try messages with');
    await charge();
    expect(await told()).toEqual([]);
    await charge();
    expect(await told()).toEqual([[f.a.shopId, '9576']]);
    // Below it already: nothing more, until credit takes it above and a message below again.
    await charge();
    await f.billing.grantCredits(f.a.shopId, 20_00n, 'More to try with');
    await charge();
    await charge();
    expect(await told()).toEqual([[f.a.shopId, '9576']]);
    await charge();
    expect(await told()).toEqual([
      [f.a.shopId, '9576'],
      [f.a.shopId, '9728'],
    ]);
  });
});
