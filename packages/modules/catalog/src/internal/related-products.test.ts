import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RELATED_PRODUCTS, relatedProductsIn } from './related-products.js';
import { catalogFixture, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Related products (MKT-09, ADR-434)', () => {
  let f: CatalogFixture;

  const product = async (
    title: string,
    more: { productType?: string; vendor?: string; status?: 'active' | 'draft' } = {},
    tenant = f.a,
  ) => unwrap(await f.products.create(tenant, { title, status: 'active', ...more })).id;
  const collection = async (title: string, productIds: string[], tenant = f.a) =>
    unwrap(await f.collections.create(tenant, { title, productIds }));
  const related = (productIds: string[], shopId = f.a.shopId) =>
    f.db.tenant(shopId, (tx) => relatedProductsIn(tx, shopId, productIds));

  beforeAll(async () => {
    f = await catalogFixture(server!);
  }, 120_000);
  afterAll(() => f?.close());
  beforeEach(() => f.reset());

  it('puts those sharing more of its collections first, then its type, then its vendor', async () => {
    const lawn = await product('Lawn 3-piece', { productType: 'Lawn', vendor: 'Zari' });
    const both = await product('Printed lawn', { productType: 'Kurta' });
    const eid = await product('Eid lawn');
    const sameType = await product('Lawn 2-piece', { productType: 'Lawn' });
    const sameVendor = await product('Zari dupatta', { vendor: 'Zari' });
    await product('Unrelated shawl', { productType: 'Shawl', vendor: 'Other' });
    await product('Draft lawn', { productType: 'Lawn', status: 'draft' });
    await collection('Summer', [lawn, both, eid]);
    await collection('Printed', [lawn, both]);

    expect((await related([lawn])).get(lawn)).toEqual([both, eid, sameType, sameVendor]);
    // A product nothing relates to has none; another shop's see none of these.
    const alone = await product('Lone khussa', { productType: 'Khussa' });
    expect((await related([alone])).has(alone)).toBe(false);
    const elsewhere = await product('Lawn 3-piece', { productType: 'Lawn' }, f.b);
    expect((await related([elsewhere], f.b.shopId)).has(elsewhere)).toBe(false);
  });

  it('keeps to so many a product, the newest first among equals', async () => {
    const ids: string[] = [];
    for (let index = 0; index < RELATED_PRODUCTS + 2; index++) {
      ids.push(await product(`Kurta ${index}`, { productType: 'Kurta' }));
    }
    const shown = (await related([ids[0]!])).get(ids[0]!)!;
    expect(shown).toHaveLength(RELATED_PRODUCTS);
    expect(shown).toEqual([...ids.slice(1)].reverse().slice(0, RELATED_PRODUCTS));
  });
});
