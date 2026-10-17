import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { catalogFixture, errorsOf, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Eastern-wear attributes (CAT-08, ADR-477)', () => {
  let f: CatalogFixture;

  beforeAll(async () => {
    f = await catalogFixture(server!);
  }, 120_000);
  afterAll(() => f?.close());
  beforeEach(() => f.reset());

  it("keeps a product's stitching, pieces, fabrics and season in Hatti's words, copied and found by them", async () => {
    const suit = unwrap(
      await f.products.create(f.a, {
        title: 'Eid suit',
        easternWear: {
          stitching: 'unstitched',
          pieces: 3,
          fabrics: ['lawn', 'chiffon', 'lawn'],
          season: 'summer',
        },
      }),
    );
    expect(suit.easternWear).toEqual({
      stitching: 'unstitched',
      pieces: 3,
      fabrics: ['lawn', 'chiffon'],
      season: 'summer',
    });
    // None said is none at all.
    expect(
      unwrap(await f.products.create(f.a, { title: 'Mug', easternWear: {} })).easternWear,
    ).toBeNull();

    // Only Hatti's words, and within bounds.
    expect(
      errorsOf(
        await f.products.create(f.a, {
          title: 'Odd',
          easternWear: {
            stitching: 'tailored',
            pieces: 9,
            fabrics: ['lawn', 'polyester', 'silk', 'net', 'velvet'],
            season: 'monsoon',
          },
        }),
      ),
    ).toEqual([
      ['input.easternWear.stitching', 'INVALID'],
      ['input.easternWear.season', 'INVALID'],
      ['input.easternWear.pieces', 'INVALID'],
      ['input.easternWear.fabrics', 'INVALID'],
      ['input.easternWear.fabrics', 'TOO_MANY'],
    ]);

    // Updated whole, cleared with null, left alone when not given.
    const winter = unwrap(
      await f.products.update(f.a, {
        id: suit.id,
        easternWear: { stitching: 'stitched', fabrics: ['khaddar'], season: 'winter' },
      }),
    );
    expect(winter.easternWear).toEqual({
      stitching: 'stitched',
      pieces: null,
      fabrics: ['khaddar'],
      season: 'winter',
    });
    expect(
      unwrap(await f.products.update(f.a, { id: suit.id, title: 'Winter suit' })).easternWear,
    ).toEqual(winter.easternWear);
    const copy = unwrap(await f.products.duplicate(f.a, { productId: suit.id, newTitle: 'Copy' }));
    expect(copy.easternWear).toEqual(winter.easternWear);

    // Found by its fabric and stitching.
    const { rows } = await f.admin.query<{ search_text: string }>(
      'SELECT search_text FROM catalog.products WHERE id = $1',
      [suit.id],
    );
    // Folded, as search's words are: khaddar is khadar.
    expect(rows[0]!.search_text).toMatch(/khadd?ar/);
    expect(rows[0]!.search_text).toContain('stitched');

    expect(
      unwrap(await f.products.update(f.a, { id: suit.id, easternWear: null })).easternWear,
    ).toBeNull();
  });
});
