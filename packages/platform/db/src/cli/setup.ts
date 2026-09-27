import { env, parseEnv, z } from '@hatti/config';
import { setupDatabase } from '../setup.js';

const config = parseEnv(
  z.object({
    DATABASE_ADMIN_URL: env.postgresUrl(),
    DATABASE_URL: env.postgresUrl(),
    DATABASE_SYSTEM_URL: env.postgresUrl(),
  }),
);

await setupDatabase({
  adminUrl: config.DATABASE_ADMIN_URL,
  appUrl: config.DATABASE_URL,
  systemUrl: config.DATABASE_SYSTEM_URL,
  log: (message) => console.log(message),
});
console.log('Database ready');
