import pg from 'pg';

export interface PoolOptions {
  connectionString: string;
  /** Shown in pg_stat_activity, e.g. "core-api". */
  applicationName: string;
  max?: number;
  statementTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
  /** Called when an idle connection fails, e.g. because the server restarted. */
  onError?: (error: Error) => void;
}

/**
 * A connection pool with timeouts that stop one slow query or abandoned transaction from holding
 * connections for long. The pool replaces failed idle connections itself.
 */
export function createPool(options: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName,
    max: options.max ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs ?? 30_000,
  });
  // Without a listener, an error on an idle connection would crash the process.
  pool.on('error', (error) => options.onError?.(error));
  return pool;
}
