import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { setupDatabase } from '../setup.js';
import { withCredentials, withDatabase } from '../urls.js';

export interface TestDatabase {
  name: string;
  /** Superuser on the test database: bypasses row-level security, for fixtures and assertions. */
  adminUrl: string;
  /** hatti_app login: row-level security applies. Through the pooler when one is configured. */
  appUrl: string;
  /** hatti_system login. Through the pooler when one is configured. */
  systemUrl: string;
  /** hatti_identity login. Through the pooler when one is configured. */
  identityUrl: string;
  /** hatti_system login, always direct to Postgres: for LISTEN, which a pooler would break. */
  listenUrl: string;
  /** Whether the app, system and identity URLs go through PgBouncer. */
  pooled: boolean;
  drop(): Promise<void>;
}

/**
 * The server used for database tests, from DATABASE_ADMIN_URL. Tests are skipped without it,
 * except in CI, where a missing database is an error rather than a silent skip.
 */
export function testDatabaseServer(): string | undefined {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url && process.env.CI) {
    throw new Error(
      'DATABASE_ADMIN_URL must be set in CI; database tests would otherwise be skipped',
    );
  }
  return url;
}

/**
 * PgBouncer in transaction mode, from DATABASE_POOLER_URL (e.g. postgres://localhost:6432), as in
 * production. When set, request-serving test connections go through it; CI sets it. Setup,
 * migrations and fixtures always connect directly.
 */
export function testPoolerServer(): string | undefined {
  return process.env.DATABASE_POOLER_URL || undefined;
}

/** Login users shared by local development and tests; the passwords match .env.example. */
export const TEST_LOGINS = {
  app: { user: 'hatti_app', password: 'hatti_app' },
  system: { user: 'hatti_system', password: 'hatti_system' },
  identity: { user: 'hatti_identity', password: 'hatti_identity' },
} as const;

/** Creates a fresh, fully migrated database with its own name. Call drop() when done. */
export async function createTestDatabase(server = testDatabaseServer()): Promise<TestDatabase> {
  if (!server) throw new Error('DATABASE_ADMIN_URL is not set');
  const name = `hatti_test_${randomBytes(6).toString('hex')}`;
  const onDatabase = withDatabase(server, name);
  const pooler = testPoolerServer();
  const login = (kind: keyof typeof TEST_LOGINS, via = pooler ?? server) =>
    withCredentials(withDatabase(via, name), TEST_LOGINS[kind].user, TEST_LOGINS[kind].password);
  const appUrl = login('app');
  const systemUrl = login('system');
  const identityUrl = login('identity');
  await setupDatabase({ adminUrl: server, appUrl, systemUrl, identityUrl });

  return {
    name,
    adminUrl: onDatabase,
    appUrl,
    systemUrl,
    identityUrl,
    listenUrl: login('system', server),
    pooled: pooler !== undefined,
    async drop() {
      const admin = new pg.Client({ connectionString: server });
      await admin.connect();
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(name)} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    },
  };
}
