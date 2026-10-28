import { Database } from '@hatti/db';
import type { TestDatabase } from '@hatti/db/testing';
import type { ConsoleSignInSettings } from '@hatti/identity/public';
import { createLogger } from '@hatti/logger';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createConsoleApi } from '../console/console-app.js';

export interface TestConsole {
  app: NestFastifyApplication;
  close(): Promise<void>;
}

/** The console's server (ADR-876) on a test database, signing in through `console`'s provider. */
export async function startTestConsole(
  testDb: TestDatabase,
  console: ConsoleSignInSettings,
): Promise<TestConsole> {
  const database = new Database({
    appUrl: testDb.appUrl,
    systemUrl: testDb.systemUrl,
    applicationName: 'console-test',
  });
  const identityDatabase = new Database({
    appUrl: testDb.identityUrl,
    applicationName: 'console-test:identity',
  });
  const app = await createConsoleApi({
    database,
    identityDb: identityDatabase.app,
    // Tests' providers run on this machine.
    console: { ...console, allowPrivateAddresses: true },
    logger: createLogger({ name: 'console-test', level: 'silent' }),
  });
  return {
    app,
    async close() {
      await app.close();
      await database.close();
      await identityDatabase.close();
    },
  };
}
