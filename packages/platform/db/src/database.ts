import { isUuid } from '@hatti/ids';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { createPool } from './pool.js';

export type Db = NodePgDatabase;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantScopeError';
  }
}

export function createDb(pool: pg.Pool): Db {
  return drizzle({ client: pool });
}

/**
 * Runs `fn` in a transaction that acts for one shop. Row-level security limits every statement to
 * that shop's rows, whatever the SQL says. The setting is local to the transaction, so it cannot
 * leak to the next user of a pooled connection, and it works behind PgBouncer in transaction mode.
 */
export async function withTenantTransaction<T>(
  db: Db,
  shopId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!isUuid(shopId)) throw new TenantScopeError('A valid shop id is required');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.shop_id', ${shopId}, true)`);
    return fn(tx);
  });
}

export interface DatabaseOptions {
  /** Login for request-serving code (hatti_app). Row-level security applies. */
  appUrl: string;
  /** Login for cell-wide jobs (hatti_system). Only processes that need it should get it. */
  systemUrl?: string;
  applicationName: string;
  maxConnections?: number;
  onError?: (error: Error) => void;
}

/** The application's connection pools. */
export class Database {
  readonly app: Db;
  readonly #system: Db | undefined;
  readonly #pools: pg.Pool[] = [];

  constructor(options: DatabaseOptions) {
    const poolOptions = {
      applicationName: options.applicationName,
      max: options.maxConnections,
      onError: options.onError,
    };
    const appPool = createPool({ ...poolOptions, connectionString: options.appUrl });
    this.#pools.push(appPool);
    this.app = createDb(appPool);
    if (options.systemUrl) {
      const systemPool = createPool({ ...poolOptions, connectionString: options.systemUrl });
      this.#pools.push(systemPool);
      this.#system = createDb(systemPool);
    }
  }

  /** Runs `fn` as the given shop. See {@link withTenantTransaction}. */
  tenant<T>(shopId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenantTransaction(this.app, shopId, fn);
  }

  /** Runs `fn` with the system role, which sees every shop. For cell-wide jobs only. */
  system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.systemDb.transaction(fn);
  }

  get systemDb(): Db {
    if (!this.#system) throw new Error('This process was not given a system database URL');
    return this.#system;
  }

  /** Throws unless the database answers. Used by readiness checks. */
  async ping(): Promise<void> {
    await this.app.execute(sql`select 1`);
  }

  async close(): Promise<void> {
    await Promise.all(this.#pools.map((pool) => pool.end()));
  }
}
