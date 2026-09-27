import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleCandidate, toHandle } from './handle.js';
import { ProductService, type ProductRecord } from './product.service.js';
import { products, variants } from './schema.js';

const server = testDatabaseServer();

describe('handles', () => {
  it.each([
    ['Lawn 3-Piece Suit (Unstitched)', 'lawn-3-piece-suit-unstitched'],
    ['  Peshawari   Chappal!! ', 'peshawari-chappal'],
    ['Café & Chai', 'cafe-and-chai'],
    ['کھسہ', ''],
  ])('%s → %s', (title, handle) => {
    expect(toHandle(title)).toBe(handle);
  });

  it('numbers candidates within the length limit', () => {
    expect(handleCandidate('khussa', 0)).toBe('khussa');
    expect(handleCandidate('khussa', 1)).toBe('khussa-2');
    expect(handleCandidate('a'.repeat(100), 9)).toBe(`${'a'.repeat(97)}-10`);
  });
});

describe.skipIf(!server)('ProductService', () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let service: ProductService;
  const shopA = newId();
  const shopB = newId();
  const tenant = (shopId: string): TenantContext => ({
    shopId,
    currency: 'PKR',
    tokenId: newId(),
    scopes: new Set(['write_products']),
  });
  const a = tenant(shopA);
  const b = tenant(shopB);

  async function create(
    title: string,
    extra: Record<string, unknown> = {},
  ): Promise<ProductRecord> {
    const result = await service.create(a, { title, ...extra });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    return result.value;
  }

  async function outbox(): Promise<
    { event_type: string; aggregate_id: string; payload: unknown }[]
  > {
    const { rows } = await admin.query(
      'SELECT event_type, aggregate_id, payload FROM platform.outbox_events ORDER BY occurred_at, id',
    );
    return rows;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    db = new Database({ appUrl: testDb.appUrl, applicationName: 'catalog-test' });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      shopA,
      shopB,
    ]);
    service = new ProductService(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  beforeEach(async () => {
    await admin.query('DELETE FROM catalog.products; DELETE FROM platform.outbox_events;');
  });

  it('matches the migrated tables', async () => {
    // Drizzle names every column, so a mismatch with the SQL migrations fails here.
    await db.tenant(shopA, async (tx) => {
      await tx.select().from(products).limit(0);
      await tx.select().from(variants).limit(0);
    });
  });

  it('creates a draft product with a generated handle and a default variant', async () => {
    const product = await create('Lawn 3-Piece Suit');
    expect(product).toMatchObject({
      title: 'Lawn 3-Piece Suit',
      handle: 'lawn-3-piece-suit',
      status: 'draft',
      version: 1,
      tags: [],
    });
    expect(product.variants).toMatchObject([{ title: 'Default', price: 0n, position: 1 }]);
    expect(await outbox()).toEqual([
      {
        event_type: 'product.created',
        aggregate_id: product.id,
        payload: { handle: 'lawn-3-piece-suit', status: 'draft', variantCount: 1 },
      },
    ]);
  });

  it('stores prices in paisa', async () => {
    const product = await create('Peshawari Chappal', {
      status: 'active',
      variants: [
        { title: 'Size 8', price: '2,499.50', compareAtPrice: '3000', sku: 'PC-8' },
        { title: 'Size 9', price: '2499' },
      ],
    });
    expect(product.variants.map((v) => [v.title, v.price, v.compareAtPrice, v.position])).toEqual([
      ['Size 8', 249_950n, 300_000n, 1],
      ['Size 9', 249_900n, null, 2],
    ]);
  });

  it('numbers generated handles and rejects a taken explicit handle', async () => {
    expect((await create('Khussa')).handle).toBe('khussa');
    expect((await create('Khussa')).handle).toBe('khussa-2');
    const taken = await service.create(a, { title: 'Other', handle: 'Khussa' });
    expect(taken).toEqual({
      ok: false,
      errors: [{ field: ['input', 'handle'], code: 'TAKEN', message: 'Handle is already in use' }],
    });
  });

  it('allows the same handle in different shops', async () => {
    await create('Khussa');
    const result = await service.create(b, { title: 'Khussa' });
    expect(result.ok && result.value.handle).toBe('khussa');
  });

  it('falls back to a generic handle for titles without Latin letters', async () => {
    expect((await create('کھسہ')).handle).toBe('product');
  });

  it('reports every invalid field and writes nothing', async () => {
    const result = await service.create(a, {
      title: '   ',
      vendor: 'v'.repeat(256),
      variants: [{ price: 'abc' }, { price: '-5' }, { price: '' }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => [e.field.join('.'), e.code])).toEqual([
      ['input.title', 'BLANK'],
      ['input.vendor', 'TOO_LONG'],
      ['input.variants.0.price', 'INVALID'],
      ['input.variants.1.price', 'INVALID'],
      ['input.variants.2.price', 'BLANK'],
    ]);
    expect(result.errors[0]?.message).toBe("Title can't be blank");
    expect(await outbox()).toEqual([]);
  });

  it('updates changed fields, bumps the version and records what changed', async () => {
    const product = await create('Lawn Suit', { vendor: 'Gul Ahmed' });
    const result = await service.update(a, {
      id: product.id,
      title: 'Lawn Suit 2026',
      status: 'active',
      vendor: null,
      tags: ['Eid', 'eid', ' Summer '],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      title: 'Lawn Suit 2026',
      status: 'active',
      vendor: null,
      tags: ['Eid', 'Summer'],
      version: 2,
      handle: 'lawn-suit',
    });
    const events = await outbox();
    expect(events.at(-1)).toEqual({
      event_type: 'product.updated',
      aggregate_id: product.id,
      payload: { changed: ['title', 'status', 'vendor', 'tags'], version: 2 },
    });
  });

  it('leaves the version alone when nothing changes', async () => {
    const product = await create('Lawn Suit');
    const result = await service.update(a, { id: product.id, title: 'Lawn Suit' });
    expect(result.ok && result.value.version).toBe(1);
    expect((await outbox()).map((e) => e.event_type)).toEqual(['product.created']);
  });

  it('rejects a handle that another product uses', async () => {
    await create('Khussa');
    const other = await create('Chappal');
    const result = await service.update(a, { id: other.id, handle: 'khussa' });
    expect(result.ok ? null : result.errors[0]?.code).toBe('TAKEN');
  });

  it('finds products by Roman Urdu spelling variants and Urdu script', async () => {
    const suit = await create('Qameez Shalwar', { tags: ['لان'], vendor: 'Khaadi' });
    await create('Peshawari Chappal');
    const search = async (query: string) =>
      (await service.list(a, { first: 10, query })).items.map((p) => p.id);

    expect(await search('kameez shalvar')).toEqual([suit.id]);
    expect(await search('KAMIZ')).toEqual([suit.id]);
    expect(await search('shalwar khaadi')).toEqual([suit.id]);
    expect(await search('لان')).toEqual([suit.id]);
    expect(await search('kurta')).toEqual([]);
  });

  it('pages newest first', async () => {
    const first = await create('One');
    const second = await create('Two');
    const third = await create('Three');
    const page1 = await service.list(a, { first: 2 });
    expect(page1.items.map((p) => p.id)).toEqual([third.id, second.id]);
    expect(page1.hasNextPage).toBe(true);
    const page2 = await service.list(a, { first: 2, after: second.id });
    expect(page2.items.map((p) => p.id)).toEqual([first.id]);
    expect(page2.hasNextPage).toBe(false);
  });

  it("never reads or changes another shop's products", async () => {
    const product = await create('Khussa');
    expect(await service.get(b, product.id)).toBeNull();
    expect((await service.list(b, { first: 10 })).items).toEqual([]);
    const result = await service.update(b, { id: product.id, title: 'Stolen' });
    expect(result.ok ? null : result.errors[0]?.code).toBe('NOT_FOUND');
    expect((await service.get(a, product.id))?.title).toBe('Khussa');
  });
});
