import { isUuid } from '@hatti/ids';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { sql } from 'drizzle-orm';
import {
  NodePgSession,
  NodePgTransaction,
  drizzle,
  type NodePgDatabase,
} from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
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

/** The dialect drizzle() uses unless told otherwise, for the transactions begun here. */
const dialect = new PgDialect();

/** A shop's ID as it may be written into SQL: hex digits and hyphens, nothing that could quote. */
const UUID_LITERAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The statement that begins a transaction acting for `shopId`: `begin`, then the shop and the
 * limits set for that transaction alone (set_config with is_local = true), in one simple query and
 * so one round trip (ADR-107). A simple query takes no parameters, so the values are written into
 * it, checked first: the shop's ID is a UUID, and the limits whole milliseconds.
 */
export function tenantBegin(shopId: string, limits: TransactionLimits): string {
  if (!isUuid(shopId) || !UUID_LITERAL.test(shopId)) {
    throw new TenantScopeError('A valid shop id is required');
  }
  const milliseconds = (value: number) => {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`A transaction limit must be whole milliseconds, not ${value}`);
    }
    return value;
  };
  return (
    `begin; select set_config('app.shop_id', '${shopId}', true), ` +
    `set_config('statement_timeout', '${milliseconds(limits.statementTimeoutMs)}', true), ` +
    "set_config('idle_in_transaction_session_timeout', " +
    `'${milliseconds(limits.idleInTransactionTimeoutMs)}', true)`
  );
}

/**
 * Runs `fn` in a transaction that acts for one shop. Row-level security limits every statement to
 * that shop's rows, whatever the SQL says.
 *
 * The transaction begins with its shop and limits set, in one round trip (see tenantBegin), and
 * they hold for this transaction only. Nothing outlives it, so it works behind PgBouncer in
 * transaction mode, and cannot leak to the next user of a connection. It ends as drizzle's own
 * transactions do: committed when `fn` returns, rolled back when it or the commit throws. A
 * connection that fails, or cannot even roll back, is closed rather than handed to anyone else.
 */
export async function withTenantTransaction<T>(
  pool: pg.Pool,
  shopId: string,
  fn: (tx: Tx) => Promise<T>,
  limits: TransactionLimits = DEFAULT_TRANSACTION_LIMITS,
): Promise<T> {
  const begin = sql.raw(tenantBegin(shopId, limits));
  const client = await pool.connect();
  const session = new NodePgSession<Record<string, never>, Record<string, never>>(
    client,
    dialect,
    undefined,
  );
  const tx: Tx = new NodePgTransaction(dialect, session, undefined);
  // The pool listens for the errors of idle connections only. One that fails while the
  // transaction holds it, between statements, would otherwise throw where nothing can catch it
  // and end the process; the statement under way fails on its own.
  let broken = false;
  const lost = () => {
    broken = true;
  };
  client.on('error', lost);
  try {
    await tx.execute(begin);
    const result = await fn(tx);
    await tx.execute(sql`commit`);
    return result;
  } catch (error) {
    await tx.execute(sql`rollback`).catch(lost);
    throw error;
  } finally {
    // A broken connection is closed, not handed to anyone else, and keeps the listener for
    // whatever else it says on its way out.
    if (!broken) client.off('error', lost);
    client.release(broken);
  }
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
  readonly #appPool: pg.Pool;
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
    this.#appPool = appPool;
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
          return await withTenantTransaction(this.#appPool, shopId, fn, this.#limits);
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
