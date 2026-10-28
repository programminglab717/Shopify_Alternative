import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@hatti/db';
import type { TestDatabase } from '@hatti/db/testing';
import type { ConsoleSignInSettings } from '@hatti/identity/public';
import { createLogger } from '@hatti/logger';
import { LocalStorage } from '@hatti/storage';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type pg from 'pg';
import { createConsoleApi } from '../console/console-app.js';

export interface TestConsole {
  app: NestFastifyApplication;
  /** Where verifications' documents are, as the API keeps them. */
  storage: LocalStorage;
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
  const directory = await mkdtemp(join(tmpdir(), 'hatti-console-files-'));
  const storage = new LocalStorage({
    directory,
    baseUrl: 'http://localhost:4000/storage',
    secret: 'test-storage-secret-of-32-characters',
  });
  const app = await createConsoleApi({
    database,
    identityDb: identityDatabase.app,
    // Tests' providers run on this machine.
    console: { ...console, allowPrivateAddresses: true },
    storage,
    publicUrl: 'https://hatti.example',
    logger: createLogger({ name: 'console-test', level: 'silent' }),
  });
  return {
    app,
    storage,
    async close() {
      await app.close();
      await database.close();
      await identityDatabase.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/**
 * One of Hatti's agents, their account made with the admin login, signed in to the console
 * through `provider` with a hardware key: their console session's token.
 */
export async function consoleAgentToken(
  testConsole: TestConsole,
  admin: pg.Client,
  provider: {
    signIn(
      url: string,
      email: string,
      options: { amr?: string[] },
    ): { code: string; state: string };
  },
  email: string,
  name: string,
): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO identity.users (email, name) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [email, name],
  );
  await admin.query(
    `INSERT INTO identity.support_agents (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [rows[0]!.id],
  );
  const { app } = testConsole;
  const started = (
    await app.inject({ method: 'POST', url: '/console/api/auth/start', payload: {} })
  ).json() as { url: string };
  const { code, state } = provider.signIn(started.url, email, { amr: ['hwk'] });
  const back = await app.inject({
    method: 'GET',
    url: `/console/api/auth/callback?code=${code}&state=${state}`,
  });
  const handoff = new URL(back.headers.location as string).searchParams.get('code');
  const redeemed = (
    await app.inject({
      method: 'POST',
      url: '/console/api/auth/redeem',
      payload: { code: handoff },
    })
  ).json() as { token: string };
  return redeemed.token;
}
