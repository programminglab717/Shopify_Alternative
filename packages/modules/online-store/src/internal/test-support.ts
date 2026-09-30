// Shared set-up for the online store's database tests. Not part of the build.
import type { MutationResult, TenantContext } from '@hatti/api';
import { CollectionService, ProductService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { MenuService } from './menu.service.js';
import { PageService } from './page.service.js';
import { PreferencesService } from './preferences.service.js';
import { ThemeService } from './theme.service.js';

export interface OutboxRow {
  event_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
}

export interface OnlineStoreFixture {
  testDb: TestDatabase;
  db: Database;
  admin: pg.Client;
  /** Two shops, so every test can check the other one sees nothing. */
  a: TenantContext;
  b: TenantContext;
  themes: ThemeService;
  menus: MenuService;
  pages: PageService;
  preferences: PreferencesService;
  /** The catalog, for the collections and products menus link to. */
  products: ProductService;
  collections: CollectionService;
  /** Events recorded so far, oldest first. */
  outbox(): Promise<OutboxRow[]>;
  /** Empties the online store and the outbox between tests; the catalog stays. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

function tenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set([
      'write_themes',
      'write_online_store_navigation',
      'write_online_store_pages',
      'write_products',
    ]),
  };
}

export async function onlineStoreFixture(server: string): Promise<OnlineStoreFixture> {
  const testDb = await createTestDatabase(server);
  const db = new Database({ appUrl: testDb.appUrl, applicationName: 'online-store-test' });
  const admin = new pg.Client({ connectionString: testDb.adminUrl });
  await admin.connect();
  const a = tenant(newId());
  const b = tenant(newId());
  const [products, collections] = [new ProductService(db), new CollectionService(db)];
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
    themes: new ThemeService(db),
    menus: new MenuService(db, collections, products),
    pages: new PageService(db),
    preferences: new PreferencesService(db),
    products,
    collections,
    async outbox() {
      const { rows } = await admin.query<OutboxRow>(
        `SELECT event_type, aggregate_id, payload
           FROM platform.outbox_events ORDER BY occurred_at, id`,
      );
      return rows;
    },
    async reset() {
      await admin.query(`
        DELETE FROM online_store.themes;
        DELETE FROM online_store.menus;
        DELETE FROM online_store.pages;
        DELETE FROM online_store.preferences;
        DELETE FROM online_store.domains;
        DELETE FROM online_store.url_redirects;
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

/** The [field path, code, message] of each error of a failed result. */
export function errorsOf(result: MutationResult<unknown>): [string, string, string][] {
  if (result.ok) throw new Error('Expected user errors, got success');
  return result.errors.map((error) => [error.field.join('.'), error.code, error.message]);
}
