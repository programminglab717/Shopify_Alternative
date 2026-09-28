import pg from 'pg';

export interface PoolOptions {
  connectionString: string;
  /** Shown in pg_stat_activity, e.g. "core-api". */
  applicationName: string;
  max?: number;
  /** Called when an idle connection fails, e.g. because the server restarted. */
  onError?: (error: Error) => void;
}

/**
 * A connection pool. It sends no session settings when connecting: PgBouncer in transaction mode
 * refuses connections that do (`unsupported startup parameter`). Timeouts come from the login's
 * defaults ({@link LOGIN_DEFAULTS}) and, inside tenant transactions, from the transaction itself.
 * The pool replaces failed idle connections itself.
 */
export function createPool(options: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName,
    max: options.max ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  // Without a listener, an error on an idle connection would crash the process.
  pool.on('error', (error) => options.onError?.(error));
  return pool;
}

/**
 * Session defaults every application login must have, set on the role so that they apply however
 * the login connects, directly or through PgBouncer. `pnpm db:setup` sets them for local logins;
 * infrastructure code sets them in deployed environments.
 */
export const LOGIN_DEFAULTS = {
  statement_timeout: '15s',
  idle_in_transaction_session_timeout: '30s',
} as const;
