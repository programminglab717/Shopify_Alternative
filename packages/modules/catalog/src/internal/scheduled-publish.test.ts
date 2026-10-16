import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { catalogFixture, errorsOf, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();
const HOUR = 3_600_000;

describe.skipIf(!server)('Drafts put on sale at a time ahead (CAT-17, ADR-441)', () => {
  let f: CatalogFixture;

  const draft = async (title: string, tenant = f.a) =>
    unwrap(await f.products.create(tenant, { title, status: 'draft' })).id;
  const times = async (ids: string[], tenant = f.a) => f.products.publishTimesOf(tenant, ids);
  /** As if the time set came while nobody looked. */
  const due = (id: string) =>
    f.admin.query(
      `UPDATE catalog.products SET publish_at = now() - interval '1 minute' WHERE id = $1`,
      [id],
    );

  beforeAll(async () => {
    f = await catalogFixture(server!);
  }, 120_000);
  afterAll(() => f?.close());
  beforeEach(() => f.reset());

  it('takes a time for a draft, a minute to a year ahead, and takes it away', async () => {
    const lawn = await draft('Eid lawn drop');
    const at = new Date(Date.now() + 2 * HOUR);
    unwrap(await f.products.schedulePublish(f.a, lawn, at));
    expect(await times([lawn])).toEqual(new Map([[lawn, at]]));
    expect(await times([lawn], f.b)).toEqual(new Map());

    for (const early of [new Date(Date.now() - HOUR), new Date(Date.now() + 10_000)]) {
      expect(errorsOf(await f.products.schedulePublish(f.a, lawn, early))).toEqual([
        ['publishAt', 'INVALID'],
      ]);
    }
    const late = new Date(Date.now() + 366 * 24 * HOUR);
    expect(errorsOf(await f.products.schedulePublish(f.a, lawn, late))).toEqual([
      ['publishAt', 'INVALID'],
    ]);
    expect(errorsOf(await f.products.schedulePublish(f.b, lawn, at))).toEqual([
      ['productId', 'NOT_FOUND'],
    ]);
    const onSale = unwrap(await f.products.create(f.a, { title: 'Khaddar', status: 'active' }));
    expect(errorsOf(await f.products.schedulePublish(f.a, onSale.id, at))).toEqual([
      ['productId', 'INVALID'],
    ]);
    expect(await times([lawn])).toEqual(new Map([[lawn, at]]));

    unwrap(await f.products.schedulePublish(f.a, lawn, null));
    expect(await times([lawn])).toEqual(new Map());
  });

  it('loses its time once put on sale or archived by hand', async () => {
    const [lawn, chiffon, silk] = [
      await draft('Lawn'),
      await draft('Chiffon'),
      await draft('Silk'),
    ];
    const at = new Date(Date.now() + 2 * HOUR);
    for (const id of [lawn, chiffon, silk]) unwrap(await f.products.schedulePublish(f.a, id, at));

    unwrap(await f.products.update(f.a, { id: lawn, title: 'Lawn three-piece' }));
    unwrap(await f.products.update(f.a, { id: chiffon, status: 'active' }));
    unwrap(await f.products.bulkSetStatus(f.a, [silk], 'archived'));
    expect(await times([lawn, chiffon, silk])).toEqual(new Map([[lawn, at]]));
  });

  it('puts the drafts whose time came on sale, shop by shop, as a status set by hand', async () => {
    const lawn = await draft('Eid lawn drop');
    const later = await draft('Winter shawls');
    const theirs = await draft('Their kurta', f.b);
    const archived = await draft('Old stock');
    const at = new Date(Date.now() + 2 * HOUR);
    for (const id of [lawn, later, archived]) {
      unwrap(await f.products.schedulePublish(f.a, id, at));
    }
    unwrap(await f.products.schedulePublish(f.b, theirs, at));
    await due(lawn);
    await due(theirs);
    await due(archived);
    // Archived after its time was set, by a path that keeps it: it stays archived.
    await f.admin.query(`UPDATE catalog.products SET status = 'archived' WHERE id = $1`, [
      archived,
    ]);
    expect(new Set(await f.products.shopsWithProductsDue())).toEqual(
      new Set([f.a.shopId, f.b.shopId]),
    );

    const before = (await f.outbox()).length;
    expect(await f.products.publishDue(f.a.shopId)).toBe(1);
    expect((await f.products.get(f.a, lawn))!.status).toBe('active');
    expect((await f.products.get(f.a, later))!.status).toBe('draft');
    expect((await f.products.get(f.a, archived))!.status).toBe('archived');
    expect(await times([lawn, later, archived])).toEqual(new Map([[later, at]]));
    expect((await f.outbox()).slice(before)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: 'product.updated', aggregate_id: lawn }),
      ]),
    );
    expect(await f.products.shopsWithProductsDue()).toEqual([f.b.shopId]);
    expect(await f.products.publishDue(f.a.shopId)).toBe(0);
    expect(await f.products.publishDue(f.b.shopId)).toBe(1);
    expect(await f.products.shopsWithProductsDue()).toEqual([]);
  });
});
