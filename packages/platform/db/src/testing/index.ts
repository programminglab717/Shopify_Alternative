import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { defaultMigrationsDir, loadMigrations, migrate, type MigrateResult } from '../migrate.js';
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

export interface TestDatabaseOptions {
  /**
   * Migrate only as far as the migration before this one, such as '0015': to test how a migration
   * treats the data it finds, insert some through adminUrl, then migrateThrough() adminUrl.
   */
  before?: string;
}

/**
 * How long a test that makes its database `before` a migration may take (see
 * {@link createTestDatabase}): every migration before it runs from nothing, which on a busy CI
 * runner takes longer than a test's usual 30 seconds.
 */
export const MIGRATION_TEST_TIMEOUT = 120_000;

/** Creates a fresh, fully migrated database with its own name. Call drop() when done. */
export async function createTestDatabase(
  server = testDatabaseServer(),
  options: TestDatabaseOptions = {},
): Promise<TestDatabase> {
  if (!server) throw new Error('DATABASE_ADMIN_URL is not set');
  const name = `hatti_test_${randomBytes(6).toString('hex')}`;
  const onDatabase = withDatabase(server, name);
  const pooler = testPoolerServer();
  const login = (kind: keyof typeof TEST_LOGINS, via = pooler ?? server) =>
    withCredentials(withDatabase(via, name), TEST_LOGINS[kind].user, TEST_LOGINS[kind].password);
  const appUrl = login('app');
  const systemUrl = login('system');
  const identityUrl = login('identity');
  const migrationsDir = options.before ? await migrationsBefore(options.before) : undefined;
  try {
    // A fully migrated database is a copy of the template for the migrations there are, which
    // one test migrates once; the logins are then set up on it as on any other.
    if (!migrationsDir) await cloneTemplate(server, name);
    await setupDatabase({ adminUrl: server, appUrl, systemUrl, identityUrl, migrationsDir });
  } finally {
    if (migrationsDir) await rm(migrationsDir, { recursive: true, force: true });
  }

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

/** Serialises making and copying templates across test processes. */
const TEMPLATE_LOCK_KEY = 7_241_703;

/**
 * Creates database `name` as a copy of the template for the current migrations, migrating the
 * template first if no test has yet. Every migration ran in each test's own database before, one
 * test at a time under setup's lock: with two hundred of them, a busy CI runner kept a test
 * waiting past its hook's minute (run 38458021000). A copy takes a moment. The template is named
 * by a digest of the migrations, so a migration added or changed makes a new one, and the old
 * ones are dropped.
 */
async function cloneTemplate(server: string, name: string): Promise<void> {
  const digest = createHash('sha256');
  for (const migration of await loadMigrations()) {
    digest.update(`${migration.version}:${migration.checksum}\n`);
  }
  const template = `hatti_template_${digest.digest('hex').slice(0, 16)}`;
  const admin = new pg.Client({
    connectionString: server,
    application_name: 'hatti-test-template',
  });
  await admin.connect();
  try {
    await admin.query('SELECT pg_advisory_lock($1)', [TEMPLATE_LOCK_KEY]);
    const { rows } = await admin.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE 'hatti\\_template\\_%'",
    );
    if (!rows.some((row) => row.datname === template)) {
      // Built under another name and renamed once whole, so that a run cut short leaves none.
      const building = `${template}_building`;
      for (const { datname } of rows) {
        await admin.query(
          `DROP DATABASE IF EXISTS ${admin.escapeIdentifier(datname)} WITH (FORCE)`,
        );
      }
      const login = (kind: keyof typeof TEST_LOGINS) =>
        withCredentials(
          withDatabase(server, building),
          TEST_LOGINS[kind].user,
          TEST_LOGINS[kind].password,
        );
      await setupDatabase({
        adminUrl: server,
        appUrl: login('app'),
        systemUrl: login('system'),
        identityUrl: login('identity'),
      });
      await admin.query(
        `ALTER DATABASE ${admin.escapeIdentifier(building)} RENAME TO ${admin.escapeIdentifier(template)}`,
      );
    }
    await admin.query(
      `CREATE DATABASE ${admin.escapeIdentifier(name)} TEMPLATE ${admin.escapeIdentifier(template)}`,
    );
  } finally {
    await admin.end();
  }
}

/**
 * Applies migration `migration`, such as '0013', to a database made `before` it, and none after:
 * the one a test is about, which then takes as long however many migrations follow it.
 */
export async function migrateThrough(adminUrl: string, migration: string): Promise<MigrateResult> {
  const dir = await migrationsWhere((file) => file.slice(0, migration.length) <= migration);
  try {
    return await migrate({ connectionString: adminUrl, dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A temporary copy of the migrations numbered before `migration`. */
function migrationsBefore(migration: string): Promise<string> {
  return migrationsWhere((file) => file < migration);
}

async function migrationsWhere(keep: (file: string) => boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hatti-migrations-'));
  for (const file of await readdir(defaultMigrationsDir)) {
    if (keep(file)) await copyFile(join(defaultMigrationsDir, file), join(dir, file));
  }
  return dir;
}
