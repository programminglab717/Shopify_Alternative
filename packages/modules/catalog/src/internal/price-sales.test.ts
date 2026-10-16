import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PriceSaleEvents,
  PriceSaleService,
  salePrice,
  type PriceSaleInput,
} from './price-sales.js';
import { catalogFixture, errorsOf, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe.skipIf(!server)('Sales set ahead (CAT-17, ADR-443)', () => {
  let f: CatalogFixture;
  let sales: PriceSaleService;

  /** A product of one variant at `price`, with `compareAt` if given. */
  const product = async (title: string, price: string, compareAt?: string, tenant = f.a) => {
    const created = unwrap(await f.products.create(tenant, { title, status: 'active' }));
    unwrap(
      await f.variants.bulkUpdate(tenant, created.id, [
        {
          id: created.variants[0]!.id,
          price,
          ...(compareAt !== undefined && { compareAtPrice: compareAt }),
        },
      ]),
    );
    return created.id;
  };
  const prices = async (id: string) => {
    const variant = (await f.products.get(f.a, id))!.variants[0]!;
    return { price: variant.price, compareAt: variant.compareAtPrice };
  };
  const sale = (productIds: string[], over: Partial<PriceSaleInput> = {}): PriceSaleInput => ({
    name: 'Eid sale',
    percentOff: 20,
    startsAt: new Date(Date.now() + DAY),
    endsAt: new Date(Date.now() + 4 * DAY),
    productIds,
    ...over,
  });
  /** As if its time to start, or to end, came while nobody looked. */
  const due = (id: string, which: 'starts_at' | 'ends_at') =>
    f.admin.query(
      `UPDATE catalog.price_sales SET starts_at = now() - interval '2 hours',
              ends_at = CASE WHEN $2 = 'ends_at' THEN now() - interval '1 minute'
                             ELSE now() + interval '1 day' END
        WHERE id = $1`,
      [id, which],
    );
  const updates = async () =>
    (await f.outbox()).filter((event) => event.event_type === PriceSaleEvents.Updated);

  beforeAll(async () => {
    f = await catalogFixture(server!);
    sales = new PriceSaleService(f.db);
  }, 120_000);
  afterAll(() => f?.close());
  beforeEach(async () => {
    await f.admin.query('DELETE FROM catalog.price_sales');
    await f.reset();
  });

  it('cuts to a whole rupee, never to nothing', () => {
    expect(salePrice(499_900n, 20, 'PKR')).toBe(399_900n);
    expect(salePrice(265_050n, 15, 'PKR')).toBe(225_200n);
    expect(salePrice(50n, 20, 'PKR')).toBe(0n);
  });

  it('starts at its time, cutting prices with the old shown struck through, and ends putting them back', async () => {
    const lawn = await product('Lawn suit', '4,999');
    const shawl = await product('Pashmina shawl', '8,000', '12,000');
    const kurta = await product('Kurta', '2,650');
    const created = unwrap(await sales.create(f.a, sale([lawn, shawl, kurta])));
    expect(created).toMatchObject({ name: 'Eid sale', percentOff: 20, state: 'scheduled' });
    expect(new Set(created.productIds)).toEqual(new Set([lawn, shawl, kurta]));
    expect(await sales.shopsWithSalesDue()).toEqual([]);
    expect(await sales.runDue(f.a.shopId)).toBe(0);
    expect(await prices(lawn)).toEqual({ price: 499_900n, compareAt: null });

    await due(created.id, 'starts_at');
    expect(await sales.shopsWithSalesDue()).toEqual([f.a.shopId]);
    const before = (await f.outbox()).length;
    expect(await sales.runDue(f.a.shopId)).toBe(1);
    expect((await sales.get(f.a, created.id))!.state).toBe('running');
    expect(await prices(lawn)).toEqual({ price: 399_900n, compareAt: 499_900n });
    // A higher compare-at price is kept.
    expect(await prices(shawl)).toEqual({ price: 640_000n, compareAt: 1_200_000n });
    expect(await prices(kurta)).toEqual({ price: 212_000n, compareAt: 265_000n });
    const started = (await f.outbox()).slice(before);
    expect(started.filter((event) => event.event_type === 'product.updated')).toHaveLength(3);
    expect(await updates()).toEqual([
      expect.objectContaining({ aggregate_id: created.id, payload: { state: 'running' } }),
    ]);

    // The kurta's price changed by hand meanwhile: it stays as the shop set it.
    unwrap(
      await f.variants.bulkUpdate(f.a, kurta, [
        { id: (await f.products.get(f.a, kurta))!.variants[0]!.id, price: '2,000' },
      ]),
    );
    await due(created.id, 'ends_at');
    expect(await sales.runDue(f.a.shopId)).toBe(1);
    const ended = (await sales.get(f.a, created.id))!;
    expect(ended.state).toBe('ended');
    expect(ended.endedAt).toBeInstanceOf(Date);
    expect(await prices(lawn)).toEqual({ price: 499_900n, compareAt: null });
    expect(await prices(shawl)).toEqual({ price: 800_000n, compareAt: 1_200_000n });
    expect(await prices(kurta)).toEqual({ price: 200_000n, compareAt: 265_000n });
    expect(await sales.shopsWithSalesDue()).toEqual([]);
  });

  it('starts at once when set for now, and is cancelled ahead or ended early', async () => {
    const lawn = await product('Lawn suit', '5,000');
    const now = unwrap(await sales.create(f.a, sale([lawn], { startsAt: new Date() })));
    expect(now.state).toBe('running');
    expect(await prices(lawn)).toEqual({ price: 400_000n, compareAt: 500_000n });

    const early = unwrap(await sales.cancel(f.a, now.id));
    expect(early.state).toBe('ended');
    expect(await prices(lawn)).toEqual({ price: 500_000n, compareAt: null });
    expect(errorsOf(await sales.cancel(f.a, now.id))).toEqual([['id', 'INVALID']]);

    const later = unwrap(await sales.create(f.a, sale([lawn])));
    expect(unwrap(await sales.cancel(f.a, later.id)).state).toBe('cancelled');
    await due(later.id, 'starts_at');
    expect(await sales.runDue(f.a.shopId)).toBe(0);
    expect(await prices(lawn)).toEqual({ price: 500_000n, compareAt: null });
    expect(errorsOf(await sales.cancel(f.b, later.id))).toEqual([['id', 'NOT_FOUND']]);
    // Latest start first: the cancelled one's was moved back two hours.
    expect((await sales.list(f.a)).map((each) => each.state)).toEqual(['ended', 'cancelled']);
    expect(await sales.list(f.b)).toEqual([]);
  });

  it('takes a product into one sale at a time, and says what is wrong', async () => {
    const lawn = await product('Lawn suit', '5,000');
    const theirs = await product('Their kurta', '2,000', undefined, f.b);
    unwrap(await sales.create(f.a, sale([lawn])));
    expect(errorsOf(await sales.create(f.a, sale([lawn], { name: 'Overlap' })))).toEqual([
      ['productIds.0', 'TAKEN'],
    ]);
    // After it ends, another may start.
    unwrap(
      await sales.create(
        f.a,
        sale([lawn], {
          name: '11.11',
          startsAt: new Date(Date.now() + 4 * DAY),
          endsAt: new Date(Date.now() + 5 * DAY),
        }),
      ),
    );
    expect(
      errorsOf(
        await sales.create(f.a, {
          name: ' ',
          percentOff: 95,
          startsAt: new Date(Date.now() - DAY),
          endsAt: new Date(Date.now() - 2 * DAY),
          productIds: [],
        }),
      ),
    ).toEqual([
      ['name', 'BLANK'],
      ['percentOff', 'INVALID'],
      ['startsAt', 'INVALID'],
      ['endsAt', 'INVALID'],
      ['productIds', 'BLANK'],
    ]);
    expect(
      errorsOf(
        await sales.create(
          f.a,
          sale([theirs, newId()], {
            startsAt: new Date(Date.now() + 400 * DAY),
            endsAt: new Date(Date.now() + 500 * DAY),
          }),
        ),
      ),
    ).toEqual([
      ['startsAt', 'INVALID'],
      ['endsAt', 'INVALID'],
    ]);
    expect(errorsOf(await sales.create(f.a, sale([theirs, newId(), theirs])))).toEqual([
      ['productIds.2', 'TAKEN'],
    ]);
    expect(errorsOf(await sales.create(f.a, sale([theirs, newId()])))).toEqual([
      ['productIds.0', 'NOT_FOUND'],
      ['productIds.1', 'NOT_FOUND'],
    ]);
  });
});
