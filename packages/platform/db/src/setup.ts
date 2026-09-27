import pg from 'pg';
import { migrate } from './migrate.js';
import { credentials, databaseName, withDatabase } from './urls.js';

export interface SetupOptions {
  /** A superuser (or equivalent) connection, used to create the database and login users. */
  adminUrl: string;
  /** hatti_app login and target database, e.g. postgres://hatti_app:…@localhost:5432/hatti */
  appUrl: string;
  /** hatti_system login, same database. */
  systemUrl: string;
  /** hatti_identity login, same database. */
  identityUrl: string;
  migrationsDir?: string;
  log?: (message: string) => void;
}

/** Serialises role changes across processes; role rows are shared by the whole cluster. */
const ROLE_LOCK_KEY = 7_241_702;

/**
 * Creates the database if needed, applies migrations and creates or updates the login users named
 * in the URLs. For local development and tests: production provisions logins with infrastructure
 * code and only runs migrations.
 */
export async function setupDatabase(options: SetupOptions): Promise<void> {
  const database = databaseName(options.appUrl);
  const logins = [
    [options.appUrl, 'hatti_app_role'],
    [options.systemUrl, 'hatti_system_role'],
    [options.identityUrl, 'hatti_identity_role'],
  ] as const;
  if (logins.some(([url]) => databaseName(url) !== database)) {
    throw new Error('All database URLs must point at the same database');
  }

  const admin = new pg.Client({
    connectionString: options.adminUrl,
    application_name: 'hatti-setup',
  });
  await admin.connect();
  try {
    await admin.query('SELECT pg_advisory_lock($1)', [ROLE_LOCK_KEY]);
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (existing.rowCount === 0) {
      options.log?.(`Creating database ${database}`);
      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(database)}`);
    }

    // Migrations create the group roles the logins join.
    await migrate({
      connectionString: withDatabase(options.adminUrl, database),
      dir: options.migrationsDir,
      log: options.log,
    });

    for (const [url, groupRole] of logins) {
      const { user, password } = credentials(url);
      if (!user || !password) throw new Error('Database URLs must include a user and password');
      const role = admin.escapeIdentifier(user);
      const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user]);
      if (exists.rowCount === 0) {
        options.log?.(`Creating login ${user}`);
        await admin.query(`CREATE ROLE ${role} LOGIN`);
      }
      await admin.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${admin.escapeLiteral(password)}`);
      await admin.query(`GRANT ${admin.escapeIdentifier(groupRole)} TO ${role}`);
    }
  } finally {
    await admin.end();
  }
}
