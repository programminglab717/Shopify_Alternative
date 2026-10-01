import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { orderLinkPage } from './link-pages.js';
import type { OrderLinkView } from './order-link.service.js';
import { errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

const ACCOUNT = {
  title: 'Zari Textiles',
  bankName: 'Standard Chartered',
  iban: 'PK36SCBL0000001123456702',
};

/** A PNG's signature, then `size` bytes in all. */
const png = (size: number) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(size - 8, 1),
  ]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const pdf = Buffer.from('%PDF-1.7\n%receipt\n');

/** The view of an order's page, failing the test when it shows no order. */
function shown(view: OrderLinkView): Extract<OrderLinkView, { kind: 'order' }> {
  if (view.kind !== 'order') throw new Error(`Expected an order, got ${view.kind}`);
  return view;
}

describe.skipIf(!server)('Receipts of transfers', () => {
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
    unwrap(await f.bankTransfer.update(f.a, { enabled: true, account: ACCOUNT }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A bank-transfer order and its link's secret. */
  async function transferOrder() {
    const order = await f.order(f.a, [kurta], { paymentMethod: 'bank_transfer' });
    const link = unwrap(await f.links.createLink(f.a, order.id));
    return { order, token: link.url.slice('https://hatti.test/o/'.length) };
  }

  it("takes the customer's receipts while the order waits for its transfer, five at most", async () => {
    const { order, token } = await transferOrder();
    const before = shown(await f.links.viewLink(token));
    expect(before.receipts).toBe(0);
    const form = orderLinkPage(before).html;
    expect(form).toContain('<form method="post" enctype="multipart/form-data">');
    expect(form).toContain('<input type="hidden" name="action" value="receipt" />');
    expect(form).toContain('accept="image/jpeg,image/png,image/webp,application/pdf"');
    expect(form).toContain('Paid? Send a photo or screenshot of the receipt, or its PDF');

    const put = vi.spyOn(f.storage, 'put');
    // Nothing chosen, too large, or not a photo or a PDF: said so, and nothing kept.
    for (const [upload, reason] of [
      [null, 'missing'],
      [{ data: Buffer.alloc(0) }, 'missing'],
      ['too_large', 'size'],
      [{ data: png(10 * 1024 * 1024 + 1) }, 'size'],
      [{ data: Buffer.from('<html><script>alert(1)</script>') }, 'type'],
      [{ data: Buffer.from('GIF89a......') }, 'type'],
    ] as const) {
      const view = shown(await f.links.sendReceipt(token, upload));
      expect(view.problem, reason).toEqual({ kind: 'receipt', reason });
      expect(orderLinkPage(view).status).toBe(422);
    }
    expect(put).not.toHaveBeenCalled();
    const refused = (reason: 'missing' | 'type' | 'size' | 'count') =>
      orderLinkPage({ ...before, problem: { kind: 'receipt', reason } }).html;
    expect(refused('missing')).toContain('Choose the photo or PDF of your receipt first.');
    expect(refused('type')).toContain('That file isn&#39;t a photo or a PDF.');
    expect(refused('size')).toContain('That file is larger than 10 MB.');

    await f.admin.query('DELETE FROM platform.outbox_events');
    const sent = shown(await f.links.sendReceipt(token, { data: png(64) }));
    expect(sent).toMatchObject({ problem: null, receipts: 1 });
    const [receipt] = (await f.receipts.receiptsOf(f.a, [order.id])).get(order.id)!;
    expect(receipt).toMatchObject({ orderId: order.id, contentType: 'image/png', size: 64 });
    expect(receipt!.key).toBe(`shops/${f.a.shopId}/receipts/${order.id}/${receipt!.id}.png`);
    expect(await f.storage.read(receipt!.key)).toEqual({ body: png(64), contentType: 'image/png' });
    const timeline = await f.orders.timeline(f.a, order.id, { first: 1 });
    expect(timeline.items.map((entry) => [entry.kind, entry.actorKind, entry.message])).toEqual([
      ['receipt', 'system', 'The customer sent a receipt for their transfer through their link'],
    ]);
    // It changes nothing of the order itself, so not its version.
    const { version } = (await f.orders.get(f.a, order.id))!;
    expect((await f.outbox()).map((event) => [event.event_type, event.payload])).toEqual([
      ['order.updated', { changed: ['transferReceipt'], stage: 'awaiting_payment', version }],
    ]);
    // The shop sees it through a URL signed for an hour, named for the order.
    const url = new URL(f.receipts.urlOf(receipt!, order.number, 1));
    expect(
      f.storage.verify('GET', decodeURIComponent(url.pathname.slice('/storage/'.length)), {
        ...Object.fromEntries(url.searchParams),
      }),
    ).toEqual({ method: 'GET', filename: `Receipt #${order.number}-1.png` });
    expect((await f.receipts.receiptsOf(f.b, [order.id])).get(order.id)).toEqual([]);

    const thanked = orderLinkPage(shown(await f.links.viewLink(token)), { sent: true }).html;
    expect(thanked).toContain('Thank you: A has your receipt, and sends your order once the');
    expect(thanked).toContain('You sent a receipt.');

    for (const data of [jpeg, pdf, png(32), jpeg]) {
      expect(shown(await f.links.sendReceipt(token, { data })).problem).toBeNull();
    }
    const kept = (await f.receipts.receiptsOf(f.a, [order.id])).get(order.id)!;
    expect(kept.map((each) => each.contentType)).toEqual([
      'image/png',
      'image/jpeg',
      'application/pdf',
      'image/png',
      'image/jpeg',
    ]);
    // A sixth is one more than an order takes: storage keeps nothing of it.
    const remove = vi.spyOn(f.storage, 'delete');
    put.mockClear();
    const sixth = shown(await f.links.sendReceipt(token, { data: pdf }));
    expect(sixth).toMatchObject({ problem: { kind: 'receipt', reason: 'count' }, receipts: 5 });
    expect(remove).toHaveBeenCalledExactlyOnceWith(put.mock.calls[0]![0]);
    expect(await f.storage.head(put.mock.calls[0]![0])).toBeNull();
    expect(refused('count')).toContain('You sent as many receipts as an order takes.');
    const full = orderLinkPage(shown(await f.links.viewLink(token))).html;
    expect(full).toContain('You sent 5 receipts.');
    expect(full).not.toContain('enctype="multipart/form-data"');
  });

  it('takes none once the order no longer waits for a transfer, nor for cash on delivery', async () => {
    const { order, token } = await transferOrder();
    unwrap(await f.orders.markAsPaid(f.a, order.id));
    const remove = vi.spyOn(f.storage, 'delete');
    const paid = shown(await f.links.sendReceipt(token, { data: png(64) }));
    expect(paid.problem).toEqual({ kind: 'too_late', action: 'receipt' });
    expect(remove).toHaveBeenCalledOnce();
    const page = orderLinkPage(paid);
    expect(page.status).toBe(409);
    expect(page.html).toContain('This order no longer waits for a transfer.');
    expect(page.html).not.toContain('enctype="multipart/form-data"');

    const cancelled = await transferOrder();
    unwrap(await f.orders.cancel(f.a, cancelled.order.id, { reason: 'customer' }));
    expect(shown(await f.links.sendReceipt(cancelled.token, { data: pdf })).problem).toEqual({
      kind: 'too_late',
      action: 'receipt',
    });

    const cod = await f.order(f.a, [kurta]);
    const codToken = unwrap(await f.links.createLink(f.a, cod.id)).url.split('/o/')[1]!;
    const view = shown(await f.links.sendReceipt(codToken, { data: pdf }));
    expect(view).toMatchObject({ receipts: 0, problem: { kind: 'too_late', action: 'receipt' } });
    // Not the order's link, nothing is kept.
    expect(await f.links.sendReceipt('o_nothing', { data: pdf })).toEqual({ kind: 'not_found' });
    const { rows } = await f.admin.query('SELECT 1 FROM orders.transfer_receipts');
    expect(rows).toEqual([]);
  });

  it('goes when the customer is erased', async () => {
    const { order, token } = await transferOrder();
    expect(shown(await f.links.sendReceipt(token, { data: pdf })).problem).toBeNull();
    // Their orders must be closed first.
    expect(errorsOf(await f.customerData.erase(f.a, order.customerId!))).toEqual([
      ['id', 'IN_USE'],
    ]);
    unwrap(await f.orders.cancel(f.a, order.id, { reason: 'customer' }));
    unwrap(await f.customerData.erase(f.a, order.customerId!));
    expect((await f.receipts.receiptsOf(f.a, [order.id])).get(order.id)).toEqual([]);
  });
});
