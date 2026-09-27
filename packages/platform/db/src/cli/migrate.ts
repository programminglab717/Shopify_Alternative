import { env, parseEnv, z } from '@hatti/config';
import { migrate } from '../migrate.js';
import { databaseName, withDatabase } from '../urls.js';

// DATABASE_MIGRATION_URL is the schema owner in deployed environments. Locally it defaults to the
// admin login on the application database.
const config = parseEnv(
  z.object({
    DATABASE_MIGRATION_URL: env.postgresUrl().optional(),
    DATABASE_ADMIN_URL: env.postgresUrl().optional(),
    DATABASE_URL: env.postgresUrl(),
  }),
);

const connectionString =
  config.DATABASE_MIGRATION_URL ??
  (config.DATABASE_ADMIN_URL
    ? withDatabase(config.DATABASE_ADMIN_URL, databaseName(config.DATABASE_URL))
    : undefined);
if (!connectionString) {
  console.error('Set DATABASE_MIGRATION_URL, or DATABASE_ADMIN_URL for local development');
  process.exit(1);
}

const result = await migrate({ connectionString, log: (message) => console.log(message) });
console.log(
  result.applied.length > 0
    ? `Applied ${result.applied.length} migration(s)`
    : `Up to date (${result.skipped} applied)`,
);
