import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { setupDatabase } from '../setup.js';
import { withCredentials, withDatabase } from '../urls.js';

export interface TestDatabase {
  name: string;
  /** Superuser on the test database: bypasses row-level security, for fixtures and assertions. */
  adminUrl: string;
  /** hatti_app login: row-level security applies. */
  appUrl: string;
  /** hatti_system login. */
  systemUrl: string;
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

/** Login users shared by local development and tests; the passwords match .env.example. */
export const TEST_LOGINS = {
  app: { user: 'hatti_app', password: 'hatti_app' },
  system: { user: 'hatti_system', password: 'hatti_system' },
} as const;

/** Creates a fresh, fully migrated database with its own name. Call drop() when done. */
export async function createTestDatabase(server = testDatabaseServer()): Promise<TestDatabase> {
  if (!server) throw new Error('DATABASE_ADMIN_URL is not set');
  const name = `hatti_test_${randomBytes(6).toString('hex')}`;
  const onDatabase = withDatabase(server, name);
  const appUrl = withCredentials(onDatabase, TEST_LOGINS.app.user, TEST_LOGINS.app.password);
  const systemUrl = withCredentials(
    onDatabase,
    TEST_LOGINS.system.user,
    TEST_LOGINS.system.password,
  );
  await setupDatabase({ adminUrl: server, appUrl, systemUrl });

  return {
    name,
    adminUrl: onDatabase,
    appUrl,
    systemUrl,
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
