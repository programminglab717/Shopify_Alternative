import 'reflect-metadata';
import { PublicSite, StorefrontSite } from '@hatti/api';
import { ComplementService } from '@hatti/catalog/public';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { orderLinkPage } from './link-pages.js';
import { OrderLinkService, type OrderLinkView } from './order-link.service.js';
import { PostPurchaseOffers, offerPrice } from './post-purchase-offer.js';
import { ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

type Shown = Extract<OrderLinkView, { kind: 'order' }>;

describe.skipIf(!server)('The offer after the purchase (MKT-09, ADR-438)', () => {
  let f: OrdersFixture;
  let links: OrderLinkService;
  /** A kurta, and the dupatta and khussas the shop pairs with it. */
  let kurta: { id: string; variant: string };
  let dupatta: { id: string; variant: string };
  let khussa: { id: string; variants: string[] };

  const made = async (title: string, price: string, sizes?: string[]) =>
    unwrap(
      await f.products.create(f.a, {
        title,
        status: 'active',
        ...(sizes
          ? {
              options: [{ name: 'Size', values: sizes }],
              variants: sizes.map((size) => ({ optionValues: [size], price })),
            }
          : { variants: [{ price }] }),
      }),
    );

  const tokenOf = (url: string) => url.slice('https://hatti.test/o/'.length);
  const shownOn = async (token: string): Promise<Shown> => {
    const view = await links.viewLink(token);
    if (view.kind !== 'order') throw new Error(`Expected an order, got ${view.kind}`);
    return view;
  };
  /** A confirmed cash-on-delivery order of a kurta, and its link's secret. */
  const confirmed = async () => {
    const order = await f.order(f.a, [kurta.variant]);
    unwrap(await f.orders.confirm(f.a, order.id));
    return { order, token: tokenOf(unwrap(await f.links.createLink(f.a, order.id)).url) };
  };

  beforeAll(async () => {
    f = await ordersFixture(server!);
    links = new OrderLinkService(
      f.db,
      f.orders,
      new PublicSite('https://hatti.test'),
      new StorefrontSite('https://hatti.test'),
      f.receipts,
      f.storage,
      undefined,
      new PostPurchaseOffers(f.products, f.inventory, f.edits),
    );
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    const k = await made('Lawn kurta', '2,000');
    const d = await made('Chiffon dupatta', '1,000');
    const s = await made('Khussa', '2,499', ['7', '8']);
    kurta = { id: k.id, variant: k.variants[0]!.id };
    dupatta = { id: d.id, variant: d.variants[0]!.id };
    khussa = { id: s.id, variants: s.variants.map((variant) => variant.id) };
    for (const variant of [kurta.variant, dupatta.variant, ...khussa.variants]) {
      await f.stock(f.a, variant, 5);
    }
    unwrap(await new ComplementService(f.db).set(f.a, kurta.id, [dupatta.id, khussa.id]));
  });

  it('offers what the shop pairs with the order, at its percentage off, added with a tap and paid at the door, once', async () => {
    const { order, token } = await confirmed();
    // No offer while the shop makes none.
    expect((await shownOn(token)).offer).toBeNull();
    unwrap(await f.orderSettings.update(f.a, { upsellPercentOff: 15 }));
    expect((await shownOn(token)).offer).toEqual({
      productId: dupatta.id,
      title: 'Chiffon dupatta',
      percentOff: 15,
      variants: [
        { variantId: dupatta.variant, title: 'Default Title', price: 850_00n, was: 1_000_00n },
      ],
    });
    const page = orderLinkPage(await shownOn(token)).html;
    expect(page).toContain(
      'Add Chiffon dupatta for Rs 850 (was Rs 1,000), and pay for it when it&#39;s delivered.',
    );
    expect(page).toContain(`name="variant" value="${dupatta.variant}"`);

    // Sold out, the next paired product is offered, each size a button.
    await f.stock(f.a, dupatta.variant, 0);
    const next = (await shownOn(token)).offer!;
    expect([next.title, next.variants.map((variant) => [variant.title, variant.price])]).toEqual([
      'Khussa',
      [
        ['7', 2_124_00n],
        ['8', 2_124_00n],
      ],
    ]);
    expect(orderLinkPage(await shownOn(token)).html).toContain('Add 8, Rs 2,124');

    // Taken: the khussa added at the offer's price, the cash at the door with it, and no offer more.
    const taken = await links.takeOffer(token, khussa.variants[1]!);
    expect(taken).toMatchObject({ kind: 'order', problem: null, offer: null });
    const now = await f.orders.get(f.a, order.id);
    expect(now!.lines.map((line) => [line.title, line.variantTitle, line.unitPrice])).toEqual([
      ['Lawn kurta', 'Default Title', 2_000_00n],
      ['Khussa', '8', 2_124_00n],
    ]);
    expect(now!.total - order.total).toBe(2_124_00n);
    expect(now!.codAmount - order.codAmount).toBe(2_124_00n);
    expect(now!.upsoldAt).toBeInstanceOf(Date);
    expect((await f.level(f.a, khussa.variants[1]!))?.committed).toBe(1);
    const [entry] = (await f.orders.timeline(f.a, order.id, { first: 1 })).items;
    expect([entry!.kind, entry!.actorKind, entry!.message]).toEqual([
      'edited',
      'system',
      'The customer took the offer on their page: added 1 × Khussa (8); Rs 4,124 instead of Rs 2,000',
    ]);
    expect(orderLinkPage(await shownOn(token), { added: true }).html).toContain(
      'Added to your order.',
    );
    // Once: tapped again, it is gone.
    expect(await links.takeOffer(token, khussa.variants[0]!)).toMatchObject({
      problem: { kind: 'too_late', action: 'upsell' },
    });
  });

  it('offers nothing before it is confirmed, once packed, paid otherwise, or with nothing paired for sale', async () => {
    unwrap(await f.orderSettings.update(f.a, { upsellPercentOff: 0 }));
    // Waiting for its customer to confirm it, the order itself is what they decide on.
    const waiting = await f.order(f.a, [kurta.variant]);
    const waitingToken = tokenOf(unwrap(await f.links.createLink(f.a, waiting.id)).url);
    expect((await shownOn(waitingToken)).offer).toBeNull();
    expect(await links.takeOffer(waitingToken, dupatta.variant)).toMatchObject({
      problem: { kind: 'too_late', action: 'upsell' },
    });
    const { order, token } = await confirmed();
    // At its price: none taken off.
    expect((await shownOn(token)).offer?.variants[0]).toMatchObject({
      price: 1_000_00n,
      was: 1_000_00n,
    });
    expect(orderLinkPage(await shownOn(token)).html).toContain(
      'Add Chiffon dupatta for Rs 1,000, and pay for it when it&#39;s delivered.',
    );
    unwrap(await f.orders.markPacked(f.a, order.id));
    expect((await shownOn(token)).offer).toBeNull();
    expect(await links.takeOffer(token, dupatta.variant)).toMatchObject({
      problem: { kind: 'too_late', action: 'upsell' },
    });
    expect((await f.orders.get(f.a, order.id))!.lines).toHaveLength(1);

    // Paid by transfer, there is no cash at the door to add it to.
    await f.admin.query(
      `INSERT INTO orders.bank_transfer_settings (shop_id, enabled, account_title, bank_name, iban)
       VALUES ($1, true, 'Zari', 'HBL', 'PK36SCBL0000001123456702')`,
      [f.a.shopId],
    );
    const transfer = await f.order(f.a, [kurta.variant], { paymentMethod: 'bank_transfer' });
    const transferToken = tokenOf(unwrap(await f.links.createLink(f.a, transfer.id)).url);
    expect((await shownOn(transferToken)).offer).toBeNull();

    // Nothing paired is for sale: no offer.
    for (const variant of [dupatta.variant, ...khussa.variants]) await f.stock(f.a, variant, 0);
    const { token: bare } = await confirmed();
    expect((await shownOn(bare)).offer).toBeNull();
  });

  it('takes a whole rupee off a price, down', () => {
    expect(offerPrice(2_499_00n, 15, 'PKR')).toBe(2_124_00n);
    expect(offerPrice(999_99n, 50, 'PKR')).toBe(499_00n);
    expect(offerPrice(1_000_00n, 0, 'PKR')).toBe(1_000_00n);
  });
});
