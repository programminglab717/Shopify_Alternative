import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export interface Migration {
  /** File name without extension, e.g. "0001_foundation". */
  version: string;
  sql: string;
  checksum: string;
}

export class MigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

/** db/migrations at the repository root. */
export const defaultMigrationsDir = fileURLToPath(
  new URL('../../../../db/migrations', import.meta.url),
);

const FILE_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
/** Advisory lock key held while migrating, so two deploys never migrate at once. */
const LOCK_KEY = 7_241_701;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Reads NNNN_name.sql files in order. Numbers must be unique. */
export async function loadMigrations(dir = defaultMigrationsDir): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort();
  const seen = new Set<string>();
  const migrations: Migration[] = [];
  for (const file of files) {
    const number = FILE_NAME.exec(file)?.[1];
    if (!number) throw new MigrationError(`${file}: expected a name like 0002_add_orders.sql`);
    if (seen.has(number)) throw new MigrationError(`Two migrations are numbered ${number}`);
    seen.add(number);
    const sql = await readFile(join(dir, file), 'utf8');
    migrations.push({ version: file.slice(0, -'.sql'.length), sql, checksum: sha256(sql) });
  }
  return migrations;
}

export interface MigrateOptions {
  /** A role that owns the schema objects, connected to the target database. */
  connectionString: string;
  dir?: string;
  log?: (message: string) => void;
}

export interface MigrateResult {
  applied: string[];
  skipped: number;
}

/**
 * Applies pending migrations, each in its own transaction. Refuses to run if an applied migration
 * was edited or deleted: fix forward with a new migration instead.
 */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const migrations = await loadMigrations(options.dir);
  const client = new pg.Client({
    connectionString: options.connectionString,
    application_name: 'hatti-migrate',
  });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS platform;
      CREATE TABLE IF NOT EXISTS platform.schema_migrations (
        version    text        PRIMARY KEY,
        checksum   text        NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM platform.schema_migrations',
    );
    const applied = new Map(rows.map((row) => [row.version, row.checksum]));

    const known = new Set(migrations.map((migration) => migration.version));
    for (const version of applied.keys()) {
      if (!known.has(version)) {
        throw new MigrationError(`Migration ${version} was applied but its file is missing`);
      }
    }
    for (const migration of migrations) {
      const checksum = applied.get(migration.version);
      if (checksum !== undefined && checksum !== migration.checksum) {
        throw new MigrationError(
          `Migration ${migration.version} changed after it was applied; add a new migration instead`,
        );
      }
    }

    const pending = migrations.filter((migration) => !applied.has(migration.version));
    for (const migration of pending) {
      options.log?.(`Applying ${migration.version}`);
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO platform.schema_migrations (version, checksum) VALUES ($1, $2)',
          [migration.version, migration.checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new MigrationError(`Migration ${migration.version} failed: ${String(error)}`, {
          cause: error,
        });
      }
    }
    return { applied: pending.map((migration) => migration.version), skipped: applied.size };
  } finally {
    await client.end();
  }
}
