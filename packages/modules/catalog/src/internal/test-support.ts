// Shared set-up for the catalog's database tests. Not part of the build.
import type { TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { CollectionService } from './collection.service.js';
import type { MutationResult } from './input-checker.js';
import { MediaService } from './media.service.js';
import { OptionService } from './option.service.js';
import { ProductService } from './product.service.js';
import { VariantService } from './variant.service.js';

export interface OutboxRow {
  event_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
}

export interface CatalogFixture {
  testDb: TestDatabase;
  db: Database;
  admin: pg.Client;
  /** Two shops, so every test can check the other one sees nothing. */
  a: TenantContext;
  b: TenantContext;
  products: ProductService;
  options: OptionService;
  variants: VariantService;
  media: MediaService;
  collections: CollectionService;
  /** Events recorded so far, oldest first. */
  outbox(): Promise<OutboxRow[]>;
  /** Empties the catalog and the outbox between tests. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

function tenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_products']),
  };
}

export async function catalogFixture(server: string): Promise<CatalogFixture> {
  const testDb = await createTestDatabase(server);
  const db = new Database({ appUrl: testDb.appUrl, applicationName: 'catalog-test' });
  const admin = new pg.Client({ connectionString: testDb.adminUrl });
  await admin.connect();
  const a = tenant(newId());
  const b = tenant(newId());
  await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
    a.shopId,
    b.shopId,
  ]);
  return {
    testDb,
    db,
    admin,
    a,
    b,
    products: new ProductService(db),
    options: new OptionService(db),
    variants: new VariantService(db),
    media: new MediaService(db),
    collections: new CollectionService(db),
    async outbox() {
      const { rows } = await admin.query<OutboxRow>(
        'SELECT event_type, aggregate_id, payload FROM platform.outbox_events ORDER BY occurred_at, id',
      );
      return rows;
    },
    async reset() {
      await admin.query(`
        DELETE FROM catalog.collections;
        DELETE FROM catalog.products;
        DELETE FROM platform.outbox_events;`);
    },
    async close() {
      await db.close();
      await admin.end();
      await testDb.drop();
    },
  };
}

/** The value of a successful result; fails the test with the errors otherwise. */
export function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(`Expected success, got ${JSON.stringify(result.errors)}`);
  return result.value;
}

/** The [field path, code] pairs of a failed result. */
export function errorsOf(result: MutationResult<unknown>): [string, string][] {
  if (result.ok) throw new Error('Expected user errors, got success');
  return result.errors.map((error) => [error.field.join('.'), error.code]);
}
