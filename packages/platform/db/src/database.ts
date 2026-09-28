import { isUuid } from '@hatti/ids';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { createPool } from './pool.js';

const tracer = trace.getTracer('hatti.db');

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

/** Limits for one transaction, in milliseconds. */
export interface TransactionLimits {
  /** Cancels any statement that runs longer. */
  statementTimeoutMs: number;
  /** Ends the session if the transaction sits idle, e.g. waiting on a slow HTTP call, this long. */
  idleInTransactionTimeoutMs: number;
}

export const DEFAULT_TRANSACTION_LIMITS: TransactionLimits = {
  statementTimeoutMs: 15_000,
  idleInTransactionTimeoutMs: 30_000,
};

/**
 * Runs `fn` in a transaction that acts for one shop. Row-level security limits every statement to
 * that shop's rows, whatever the SQL says.
 *
 * The shop and the limits are set in one statement, so they cost no extra round trip, and only
 * for this transaction (set_config with is_local = true). Nothing outlives the transaction, so it
 * works behind PgBouncer in transaction mode, and cannot leak to the next user of a connection.
 */
export async function withTenantTransaction<T>(
  db: Db,
  shopId: string,
  fn: (tx: Tx) => Promise<T>,
  limits: TransactionLimits = DEFAULT_TRANSACTION_LIMITS,
): Promise<T> {
  if (!isUuid(shopId)) throw new TenantScopeError('A valid shop id is required');
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select set_config('app.shop_id', ${shopId}, true),
             set_config('statement_timeout', ${String(limits.statementTimeoutMs)}, true),
             set_config('idle_in_transaction_session_timeout',
                        ${String(limits.idleInTransactionTimeoutMs)}, true)`);
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
  /**
   * Limits for tenant transactions: each pool gets the budget of the surface it serves (admin 5 s,
   * storefront 1 s, checkout 2 s). Other statements get the login's defaults.
   */
  transactionLimits?: Partial<TransactionLimits>;
  onError?: (error: Error) => void;
}

/** The application's connection pools. */
export class Database {
  readonly app: Db;
  readonly #system: Db | undefined;
  readonly #pools: pg.Pool[] = [];
  readonly #limits: TransactionLimits;

  constructor(options: DatabaseOptions) {
    this.#limits = { ...DEFAULT_TRANSACTION_LIMITS, ...options.transactionLimits };
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

  /**
   * Runs `fn` as the given shop. See {@link withTenantTransaction}. Traced as one span with the
   * shop id, so every query of a request can be found by shop.
   */
  tenant<T>(shopId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return tracer.startActiveSpan(
      'tenant transaction',
      { attributes: { 'hatti.shop_id': shopId } },
      async (span) => {
        try {
          return await withTenantTransaction(this.app, shopId, fn, this.#limits);
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
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
