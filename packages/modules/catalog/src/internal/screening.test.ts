import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { screen, screeningMessage } from './prohibited.js';
import { catalogFixture, errorsOf, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();

describe('Prohibited-items screening (TNS-03, ADR-473)', () => {
  it('finds prohibited goods by whole words, in English and Urdu, in any of the words', () => {
    expect(screen({ title: '9mm Pistol with ammo' })).toEqual([
      { good: 'weapons', words: ['pistol', 'ammo'] },
    ]);
    expect(screen({ title: 'Lawn suit', tags: ['Master Copy'] })).toEqual([
      { good: 'counterfeits', words: ['master copy'] },
    ]);
    expect(screen({ title: 'تحفہ', description: '<p>اصلی شراب</p>' })).toEqual([
      { good: 'alcohol', words: ['شراب'] },
    ]);
    // Parts of words, and words in their own sense, are not.
    expect(
      screen({ title: 'Gunmetal kurta in wine red', vendor: 'Replicate Studio', tags: ['ivory'] }),
    ).toEqual([]);
    expect(screeningMessage(screen({ title: 'Replica watch' }))).toBe(
      'Hatti doesn\'t allow selling copies of other brands (it found "replica"). Keep it as a ' +
        "draft, or ask Hatti's support to review it if this is a mistake",
    );
  });
});

describe.skipIf(!server)('Prohibited-items screening, of products (TNS-03, ADR-473)', () => {
  let f: CatalogFixture;

  beforeAll(async () => {
    f = await catalogFixture(server!);
  }, 120_000);
  afterAll(() => f?.close());
  beforeEach(() => f.reset());

  it('keeps a product naming prohibited goods off sale, a draft only, until Hatti clears it', async () => {
    // Never on sale from the start, nor its copy.
    expect(
      errorsOf(await f.products.create(f.a, { title: 'Replica Rolex', status: 'active' })),
    ).toEqual([['input.status', 'PROHIBITED']]);
    const watch = unwrap(await f.products.create(f.a, { title: 'Replica Rolex', status: 'draft' }));
    expect(
      errorsOf(
        await f.products.duplicate(f.a, {
          productId: watch.id,
          newTitle: 'Replica Rolex 2',
          newStatus: 'active',
        }),
      ),
    ).toEqual([['input.status', 'PROHIBITED']]);

    // Nor put on sale, by hand or many at once.
    expect(errorsOf(await f.products.update(f.a, { id: watch.id, status: 'active' }))).toEqual([
      ['input.status', 'PROHIBITED'],
    ]);
    const bulk = unwrap(await f.products.bulkSetStatus(f.a, [watch.id], 'active'));
    expect(JSON.stringify(bulk)).toContain('PROHIBITED');

    // A product on sale whose words come to name them is refused the words.
    const kurta = unwrap(await f.products.create(f.a, { title: 'Kurta', status: 'active' }));
    expect(errorsOf(await f.products.update(f.a, { id: kurta.id, tags: ['first copy'] }))).toEqual([
      ['input.status', 'PROHIBITED'],
    ]);
    // Other changes to it go through.
    unwrap(await f.products.update(f.a, { id: kurta.id, vendor: 'Zari' }));

    // Its time to go on sale comes, and it stays a draft, its time gone.
    await f.admin.query(
      `UPDATE catalog.products SET publish_at = now() - interval '1 minute' WHERE id = $1`,
      [watch.id],
    );
    expect(await f.products.publishDue(f.a.shopId)).toBe(0);
    const { rows } = await f.admin.query<{ status: string; publish_at: Date | null }>(
      'SELECT status, publish_at FROM catalog.products WHERE id = $1',
      [watch.id],
    );
    expect(rows).toEqual([{ status: 'draft', publish_at: null }]);

    // Hatti's people clear it, for its words as they are.
    expect(await f.products.clearScreening(watch.id)).toEqual({
      shopId: f.a.shopId,
      title: 'Replica Rolex',
      found: ['replica'],
    });
    unwrap(await f.products.update(f.a, { id: watch.id, status: 'active' }));
    // Words changed are screened again.
    expect(
      errorsOf(await f.products.update(f.a, { id: watch.id, title: 'Replica Rolex Daytona' })),
    ).toEqual([['input.status', 'PROHIBITED']]);
    expect(await f.products.clearScreening('not-a-product')).toBeNull();
  });
});
