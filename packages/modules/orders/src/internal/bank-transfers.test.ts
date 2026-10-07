import 'reflect-metadata';
import type { MutationResult } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { draftLinkPage, orderLinkPage } from './link-pages.js';
import type { BankAccountValue } from './schema.js';
import { ADDRESS, errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

const TYPED = {
  title: ' Zari Textiles ',
  bankName: 'Standard Chartered',
  iban: 'pk36 scbl 0000 0011 2345 6702',
  instructions: 'Send the receipt to 0300 1234567 on WhatsApp.',
};

/** TYPED as it is kept. */
const KEPT: BankAccountValue = {
  title: 'Zari Textiles',
  bankName: 'Standard Chartered',
  iban: 'PK36SCBL0000001123456702',
  instructions: 'Send the receipt to 0300 1234567 on WhatsApp.',
  raastId: null,
};

describe.skipIf(!server)('Bank transfer', () => {
  let f: OrdersFixture;
  let kurta: string;

  beforeAll(async () => {
    f = await ordersFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 5);
  });

  const latest = async (orderId: string) =>
    (await f.orders.timeline(f.a, orderId, { first: 1 })).items.map((entry) => entry.message);

  /** Why a change was refused: its first error's message; null if it was not. */
  const refusalOf = (result: MutationResult<unknown>) =>
    result.ok ? null : result.errors[0]!.message;

  it("keeps the shop's account, checked, and who changed it to what", async () => {
    expect(await f.bankTransfer.get(f.a)).toEqual({
      enabled: false,
      account: null,
      discount: null,
      updatedAt: null,
    });
    // Offering transfers needs an account; an account needs a title, a bank and a good IBAN.
    expect(errorsOf(await f.bankTransfer.update(f.a, { enabled: true }))).toEqual([
      ['input.enabled', 'INVALID'],
    ]);
    const typed = (account: Partial<typeof TYPED>) =>
      f.bankTransfer.update(f.a, { account: { ...TYPED, ...account } });
    expect(
      errorsOf(await typed({ title: ' ', bankName: 'B'.repeat(101), iban: '', instructions: '' })),
    ).toEqual([
      ['input.account.title', 'BLANK'],
      ['input.account.bankName', 'TOO_LONG'],
      ['input.account.iban', 'BLANK'],
    ]);
    expect(refusalOf(await typed({ iban: 'GB82 WEST 1234 5698 7654 32' }))).toBe(
      'Give a Pakistani IBAN: PK, then 22 letters and digits, like PK36 SCBL 0000 0011 2345 6702',
    );
    expect(refusalOf(await typed({ iban: 'PK37 SCBL 0000 0011 2345 6702' }))).toBe(
      "The IBAN's check digits don't match it: check it for a mistyped character",
    );
    expect(errorsOf(await typed({ instructions: 'x'.repeat(501) }))).toEqual([
      ['input.account.instructions', 'TOO_LONG'],
    ]);
    expect(await f.bankTransfer.get(f.a)).toMatchObject({ enabled: false, account: null });

    await f.admin.query('DELETE FROM platform.outbox_events; DELETE FROM platform.audit_log');
    const saved = unwrap(await f.bankTransfer.update(f.a, { enabled: true, account: TYPED }));
    expect(saved).toMatchObject({ enabled: true, account: KEPT });
    expect(saved.updatedAt).toBeInstanceOf(Date);
    // Typed the same again, or nothing given, it changes nothing.
    unwrap(await f.bankTransfer.update(f.a, { account: { ...TYPED, iban: KEPT.iban } }));
    unwrap(await f.bankTransfer.update(f.a, {}));
    // On, the account can't be taken away; off, it can, or kept for staff's orders.
    expect(errorsOf(await f.bankTransfer.update(f.a, { account: null }))).toEqual([
      ['input.account', 'INVALID'],
    ]);
    unwrap(await f.bankTransfer.update(f.a, { enabled: false }));
    expect(unwrap(await f.bankTransfer.update(f.a, { account: null }))).toMatchObject({
      enabled: false,
      account: null,
    });

    const appId = f.a.actor.kind === 'app' ? f.a.actor.tokenId : null;
    expect(
      (await f.outbox())
        .filter((event) => event.event_type === 'bank_transfer_settings.updated')
        .map((event) => event.payload),
    ).toEqual([
      {
        enabled: true,
        changed: ['enabled', 'account', 'instructions'],
        actorKind: 'app',
        actorId: appId,
      },
      { enabled: false, changed: ['enabled'], actorKind: 'app', actorId: appId },
      { enabled: false, changed: ['account', 'instructions'], actorKind: 'app', actorId: appId },
    ]);
    // The audit log keeps the account before and after: where customers' money went, and when.
    const account = { title: KEPT.title, bankName: KEPT.bankName, iban: KEPT.iban, raastId: null };
    const { rows } = await f.admin.query<{ action: string; details: unknown }>(
      'SELECT action, details FROM platform.audit_log ORDER BY id',
    );
    const audited = (
      enabled: boolean,
      after: unknown,
      beforeEnabled: boolean,
      before: unknown,
    ) => ({
      action: 'bank_transfer_settings.updated',
      details: {
        enabled,
        account: after,
        discount: null,
        before: { enabled: beforeEnabled, account: before, discount: null },
      },
    });
    expect(rows).toEqual([
      audited(true, account, false, null),
      audited(false, account, true, account),
      audited(false, null, false, account),
    ]);
    expect(await f.bankTransfer.get(f.b)).toMatchObject({ enabled: false, account: null });
  });

  it('keeps the Raast ID its bank registered, which orders keep and their pages show', async () => {
    expect(
      errorsOf(await f.bankTransfer.update(f.a, { account: { ...TYPED, raastId: '042 1234567' } })),
    ).toEqual([['input.account.raastId', 'INVALID']]);
    const saved = unwrap(
      await f.bankTransfer.update(f.a, {
        enabled: true,
        account: { ...TYPED, raastId: '0300-123 4567' },
      }),
    );
    expect(saved.account).toEqual({ ...KEPT, raastId: '+923001234567' });
    // A new Raast ID is a new place for the money: audited as the account.
    await f.admin.query('DELETE FROM platform.outbox_events; DELETE FROM platform.audit_log');
    unwrap(await f.bankTransfer.update(f.a, { account: { ...TYPED, raastId: '0321 7654321' } }));
    expect((await f.outbox()).map((event) => event.payload.changed)).toEqual([['account']]);
    const { rows } = await f.admin.query<{ details: { account: unknown; before: unknown } }>(
      'SELECT details FROM platform.audit_log',
    );
    expect(rows[0]!.details).toMatchObject({
      account: { raastId: '+923217654321' },
      before: { account: { raastId: '+923001234567' } },
    });

    const order = await f.order(f.a, [kurta], { paymentMethod: 'bank_transfer' });
    expect(order.bankAccount).toEqual({ ...KEPT, raastId: '+923217654321' });
    const token = unwrap(await f.links.createLink(f.a, order.id)).url.split('/o/')[1]!;
    const view = await f.links.viewLink(token);
    if (view.kind !== 'order') throw new Error(`Expected an order, got ${view.kind}`);
    expect(orderLinkPage(view).html).toMatch(
      /Raast ID<\/span>[\s\S]*?<bdi dir="ltr" class="select-all">0321 7654321<\/bdi>/,
    );
    // Taken away, later orders have none; this one keeps what its customer was told.
    unwrap(await f.bankTransfer.update(f.a, { account: { ...TYPED, raastId: ' ' } }));
    expect((await f.order(f.a, [kurta], { paymentMethod: 'bank_transfer' })).bankAccount).toEqual(
      KEPT,
    );
    expect((await f.orders.get(f.a, order.id))?.bankAccount?.raastId).toBe('+923217654321');
  });

  it('waits for the money: no confirming, no packing or shipping until marked paid', async () => {
    unwrap(await f.bankTransfer.update(f.a, { enabled: true, account: TYPED }));
    const order = await f.order(f.a, [kurta], { paymentMethod: 'bank_transfer' });
    expect(order).toMatchObject({
      paymentMethod: 'bank_transfer',
      stage: 'awaiting_payment',
      confirmationStatus: 'not_required',
      financialStatus: 'pending',
      amountPaid: 0n,
      codAmount: 0n,
      risk: null,
      bankAccount: KEPT,
    });
    expect(await latest(order.id)).toEqual([
      `Order #${order.number} placed through the API: Rs 2,000, by bank transfer`,
    ]);
    expect((await f.orders.stageCounts(f.a)).get('awaiting_payment')).toBe(1);
    // A transfer is paid in full.
    expect(
      errorsOf(
        await f.orders.create(f.a, {
          lineItems: [{ variantId: kurta, quantity: 1 }],
          shippingAddress: ADDRESS,
          paymentMethod: 'bank_transfer',
          advancePaid: '500',
        }),
      ),
    ).toEqual([['input.advancePaid', 'INVALID']]);

    expect(refusalOf(await f.orders.markPacked(f.a, order.id))).toBe(
      'Only confirmed or paid orders can be packed',
    );
    expect(refusalOf(await f.fulfillments.fulfill(f.a, order.id, {}))).toBe(
      'Mark the order paid once its bank transfer is in',
    );
    // A later account is for later orders.
    unwrap(
      await f.bankTransfer.update(f.a, {
        account: { ...TYPED, bankName: 'HBL', iban: 'PK93HABB0000000000000001' },
      }),
    );
    expect((await f.orders.get(f.a, order.id))?.bankAccount).toEqual(KEPT);

    const paid = unwrap(await f.orders.markAsPaid(f.a, order.id));
    expect(paid).toMatchObject({
      stage: 'to_pack',
      financialStatus: 'paid',
      amountPaid: 2_000_00n,
    });
    expect(await latest(order.id)).toEqual(['Marked as paid: Rs 2,000 received by bank transfer']);
    unwrap(await f.orders.markPacked(f.a, order.id));
    unwrap(await f.fulfillments.fulfill(f.a, order.id, {}));
    expect((await f.orders.get(f.a, order.id))?.stage).toBe('in_transit');
  });

  it('cancels the orders never paid, as many days on as the shop says, but those with a receipt or a payment underway (ADR-168)', async () => {
    unwrap(await f.bankTransfer.update(f.a, { enabled: true, account: TYPED }));
    const placed = () => f.order(f.a, [kurta], { paymentMethod: 'bank_transfer' });
    const old = await placed();
    const recent = await placed();
    const receipted = await placed();
    const underway = await placed();
    const paid = await placed();
    unwrap(await f.orders.markAsPaid(f.a, paid.id));
    await f.admin.query(
      `UPDATE orders.orders SET created_at = now() - interval '3 days' WHERE id = ANY($1::uuid[])`,
      [[old.id, receipted.id, underway.id, paid.id]],
    );
    // A receipt waits for staff to check it.
    const receipt = newId();
    await f.admin.query(
      `INSERT INTO orders.transfer_receipts (shop_id, id, order_id, key, content_type, size)
       VALUES ($1, $2, $3, $4, 'application/pdf', 100)`,
      [
        f.a.shopId,
        receipt,
        receipted.id,
        `shops/${f.a.shopId}/receipts/${receipted.id}/${receipt}.pdf`,
      ],
    );
    const committed = async () => (await f.level(f.a, kurta))!.committed;
    const before = await committed();
    await f.admin.query('DELETE FROM platform.outbox_events');

    // Placed three days ago and never paid: cancelled, its stock let go; one with a payment
    // underway online waits.
    const asked: string[][] = [];
    const paying = async (orderIds: string[]) => {
      asked.push([...orderIds].sort());
      return new Set([underway.id]);
    };
    expect(await f.orders.cancelUnpaid(f.a.shopId, 2, new Date(), paying)).toBe(1);
    expect(asked).toEqual([[old.id, underway.id].sort()]);
    expect(await f.orders.get(f.a, old.id)).toMatchObject({
      status: 'cancelled',
      stage: 'cancelled',
      cancelReason: 'unpaid',
    });
    expect(await latest(old.id)).toEqual(['Cancelled: not paid in 2 days']);
    expect(await committed()).toBe(before - 1);
    expect(
      (await f.outbox())
        .filter((event) => event.event_type.startsWith('order.'))
        .map((event) => [event.event_type, event.payload.reason]),
    ).toEqual([['order.cancelled', 'unpaid']]);
    // Placed lately, with a receipt to check, with a payment underway, or paid: as they were.
    for (const order of [recent, receipted, underway]) {
      expect((await f.orders.get(f.a, order.id))!.stage).toBe('awaiting_payment');
    }
    expect((await f.orders.get(f.a, paid.id))!.stage).toBe('to_pack');
    // Swept again, nothing more; another shop has none.
    expect(await f.orders.cancelUnpaid(f.a.shopId, 2, new Date(), paying)).toBe(0);
    expect(await f.orders.cancelUnpaid(f.b.shopId, 1)).toBe(0);
    // Its payment no longer underway, the order waits no more; a day's wait takes the recent one
    // once a day has passed.
    expect(await f.orders.cancelUnpaid(f.a.shopId, 2)).toBe(1);
    expect(
      await f.orders.cancelUnpaid(f.a.shopId, 1, new Date(Date.now() + 86_400_000 + 60_000)),
    ).toBe(1);
    expect((await f.orders.get(f.a, recent.id))!.cancelReason).toBe('unpaid');
    expect((await f.orders.get(f.a, receipted.id))!.status).toBe('open');

    // The shop's days, checked as the unreachable's are.
    const refused = await f.orderSettings.update(f.a, { cancelUnpaidAfterDays: 31 });
    expect(refusalOf(refused)).toBe('Cancel unpaid after days must be a whole number from 1 to 30');
    expect(unwrap(await f.orderSettings.update(f.a, { cancelUnpaidAfterDays: 2 }))).toMatchObject({
      cancelUnpaidAfterDays: 2,
    });
  });

  it('holds a blocked number for review first, and keeps no account when the shop has none', async () => {
    unwrap(await f.blocklist.add(f.a, { phone: '03217654321', reason: 'fake_orders' }));
    const order = await f.order(f.a, [kurta], {
      paymentMethod: 'bank_transfer',
      shippingAddress: { ...ADDRESS, phone: '03217654321' },
    });
    expect(order).toMatchObject({
      stage: 'needs_review',
      confirmationStatus: 'needs_review',
      bankAccount: null,
    });
    expect(unwrap(await f.orders.confirm(f.a, order.id)).stage).toBe('awaiting_payment');
  });

  it("sends a draft paid by transfer a link, whose confirming places its order and makes it the order's (ADR-223)", async () => {
    const draft = unwrap(
      await f.drafts.create(f.a, {
        lineItems: [{ variantId: kurta, quantity: 1 }],
        paymentMethod: 'bank_transfer',
      }),
    );
    expect(errorsOf(await f.drafts.update(f.a, draft.id, { advancePaid: '500' }))).toEqual([
      ['input.advancePaid', 'INVALID'],
    ]);
    // Its order's page shows where to pay: the shop's account first.
    expect(refusalOf(await f.drafts.createLink(f.a, draft.id))).toBe(
      "A link to pay by transfer needs the shop's bank account, which its page shows: add it first",
    );
    unwrap(await f.bankTransfer.update(f.a, { account: TYPED }));
    const link = unwrap(await f.drafts.createLink(f.a, draft.id));
    expect(decodeURIComponent(link.whatsappUrl.split('?text=')[1]!)).toBe(
      `Please add your address, then confirm and pay for your order from A:\n${link.url}\n` +
        'اپنا پتہ لکھ کر آرڈر کنفرم کرنے اور ادائیگی کے لیے یہ لنک کھولیں۔',
    );
    const token = link.url.split('/d/')[1]!;
    const opened = await f.drafts.viewLink(token);
    if (opened.kind !== 'open') throw new Error(opened.kind);
    const addressed = await f.drafts.changeAddress(token, opened.shown, {
      name: 'Ayesha Khan',
      phone: '0300 1234567',
      address1: 'House 12, Street 4',
      address2: '',
      landmark: '',
      city: 'Lahore',
      province: '',
      zip: '',
      latitude: '',
      longitude: '',
    });
    if (addressed.kind !== 'open') throw new Error(addressed.kind);
    const page = draftLinkPage(addressed).html;
    expect(page).toMatch(/Pay by bank transfer<\/span>[\s\S]*Rs 2,000/);
    expect(page).toContain(
      'Once you confirm, pay Rs 2,000 by bank transfer, to the account the next page shows, or ' +
        'online there where the shop takes it.',
    );

    // Confirming places the order to wait for the transfer, and the link is the order's now.
    const confirmed = await f.drafts.confirmLink(token, addressed.shown);
    if (confirmed.kind !== 'completed') throw new Error(confirmed.kind);
    expect(confirmed.orderLinked).toBe(true);
    expect(confirmed.order).toMatchObject({
      paymentMethod: 'bank_transfer',
      stage: 'awaiting_payment',
      bankAccount: KEPT,
    });
    const number = confirmed.order.number;
    expect(await latest(confirmed.order.id)).toEqual([
      `The link of draft #D${draft.number} became the order's, working until 30 days after the ` +
        'order ends',
    ]);
    const ordered = await f.links.viewLink(token);
    if (ordered.kind !== 'order') throw new Error(`Expected an order, got ${ordered.kind}`);
    expect(orderLinkPage(ordered).html).toContain(
      `Your order #${number} is placed. Pay Rs 2,000 by bank transfer, with #${number} as the ` +
        'reference: A sends your order once the money is in.',
    );
    // As long as the order's link works, past the draft's own hours.
    await f.admin.query(
      `UPDATE orders.draft_orders SET link_expires_at = now() - interval '1 hour' WHERE id = $1`,
      [draft.id],
    );
    expect(await f.drafts.viewLink(token)).toMatchObject({ kind: 'completed', orderLinked: true });
    // A new link for the order takes it back: the draft's is spent.
    unwrap(await f.links.createLink(f.a, confirmed.order.id));
    expect(await f.drafts.viewLink(token)).toMatchObject({ kind: 'expired' });

    // A prepaid draft gets none, and staff complete a transfer's as before.
    const prepaid = unwrap(
      await f.drafts.create(f.a, {
        lineItems: [{ variantId: kurta, quantity: 1 }],
        shippingAddress: ADDRESS,
        paymentMethod: 'prepaid',
      }),
    );
    expect(refusalOf(await f.drafts.createLink(f.a, prepaid.id))).toBe(
      'A link confirms an order paid on delivery or by transfer. Complete a prepaid draft once ' +
        'the customer has paid',
    );
    const other = unwrap(
      await f.drafts.create(f.a, {
        lineItems: [{ variantId: kurta, quantity: 1 }],
        shippingAddress: ADDRESS,
        paymentMethod: 'bank_transfer',
      }),
    );
    const completed = unwrap(await f.drafts.complete(f.a, other.id));
    expect(await f.orders.get(f.a, completed.orderId!)).toMatchObject({
      paymentMethod: 'bank_transfer',
      stage: 'awaiting_payment',
    });
  });

  it("shows the customer where to pay on the order's link, and lets them cancel until they do", async () => {
    unwrap(await f.bankTransfer.update(f.a, { enabled: true, account: TYPED }));
    const order = await f.order(f.a, [kurta], { paymentMethod: 'bank_transfer' });
    const link = unwrap(await f.links.createLink(f.a, order.id));
    expect(decodeURIComponent(link.whatsappUrl.split('?text=')[1]!)).toBe(
      `Pay for your order #${order.number} from A by bank transfer:\n${link.url}\n` +
        'بینک ٹرانسفر کی تفصیل کے لیے یہ لنک کھولیں۔',
    );
    const token = link.url.slice('https://hatti.test/o/'.length);
    const view = await f.links.viewLink(token);
    if (view.kind !== 'order') throw new Error(`Expected an order, got ${view.kind}`);
    expect(view.cancellable).toBe(true);
    const page = orderLinkPage(view).html;
    expect(page).toContain('<title>Waiting for your payment · A</title>');
    expect(page).toContain(
      `Your order #${order.number} is placed. Pay Rs 2,000 by bank transfer, with ` +
        `#${order.number} as the reference: A sends your order once the money is in.`,
    );
    for (const shown of ['Zari Textiles', 'Standard Chartered', KEPT.instructions]) {
      expect(page).toContain(`<bdi>${shown}</bdi>`);
    }
    expect(page).toContain('<bdi dir="ltr" class="select-all">PK36 SCBL 0000 0011 2345 6702</bdi>');
    expect(page).toContain(`<bdi dir="ltr">#${order.number}</bdi>`);
    expect(page).toMatch(/Pay by bank transfer<\/span>[\s\S]*Rs 2,000/);
    expect(page).toContain('?cancel');

    const cancelled = await f.links.cancelLink(token, view.shown);
    expect(cancelled.kind === 'order' && cancelled.order.stage).toBe('cancelled');
    expect(await latest(order.id)).toEqual([
      'Cancelled by the customer through their link, before paying',
    ]);

    // Paid, it is the shop's to cancel, and the page says it is paid.
    const other = await f.order(f.a, [kurta], { paymentMethod: 'bank_transfer' });
    unwrap(await f.orders.markAsPaid(f.a, other.id));
    const paidToken = unwrap(await f.links.createLink(f.a, other.id)).url.split('/o/')[1]!;
    const paid = await f.links.viewLink(paidToken);
    if (paid.kind !== 'order') throw new Error(`Expected an order, got ${paid.kind}`);
    expect(paid.cancellable).toBe(false);
    const paidPage = orderLinkPage(paid).html;
    expect(paidPage).toContain('<title>Order confirmed · A</title>');
    expect(paidPage).not.toContain('PK36');
    expect(paidPage).toMatch(/Paid<\/span>[\s\S]*Rs 2,000/);
  });

  it('marks packing slips of unpaid transfers not to pack', async () => {
    const order = await f.order(f.a, [kurta], { paymentMethod: 'bank_transfer' });
    const slip = unwrap(
      await f.documents.render(f.a, [order.id], {
        kind: 'packing_slip',
        paper: 'a4',
        language: 'english',
      }),
    );
    expect(slip.html).toContain('Not paid yet: do not pack');
    expect(slip.html).toContain('Bank transfer');
    expect(slip.html).toContain('Nothing to collect');
  });
});
