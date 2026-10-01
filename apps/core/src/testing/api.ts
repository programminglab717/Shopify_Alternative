import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DnsLookup } from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { Database } from '@hatti/db';
import type { TestDatabase } from '@hatti/db/testing';
import { createLogger } from '@hatti/logger';
import { LocalStorage } from '@hatti/storage';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApi } from '../api/create-api.js';

export interface TestApi {
  app: NestFastifyApplication;
  database: Database;
  /** Files, in a directory of the test's own, served at http://localhost:4000/storage. */
  storage: LocalStorage;
  close(): Promise<void>;
}

/** What storefronts present to the /storefront/ routes in tests. */
export const TEST_STOREFRONT_KEY = 'test-storefront-key-with-32-characters';

/**
 * Boots the Admin API against a test database, with quiet logs and no rate limits, DNS that
 * knows nothing unless the test gives its own, and files kept in a directory of its own.
 */
export async function startTestApi(
  testDb: TestDatabase,
  options: { dns?: DnsLookup } = {},
): Promise<TestApi> {
  const database = new Database({ appUrl: testDb.appUrl, applicationName: 'api-test' });
  const identityDatabase = new Database({
    appUrl: testDb.identityUrl,
    applicationName: 'api-test:identity',
  });
  const directory = await mkdtemp(join(tmpdir(), 'hatti-api-files-'));
  const storage = new LocalStorage({
    directory,
    baseUrl: 'http://localhost:4000/storage',
    secret: 'test-storage-secret-of-32-characters',
  });
  const app = await createApi({
    database,
    storage,
    logger: createLogger({ name: 'api-test', level: 'silent' }),
    identity: {
      db: identityDatabase.app,
      secretBox: new SecretBox([{ id: 'test', key: Buffer.alloc(32, 9) }]),
    },
    maskInternalErrors: true,
    storefrontKey: TEST_STOREFRONT_KEY,
    dnsLookup: options.dns ?? new TestDns(),
  });
  await app.getHttpAdapter().getInstance().ready();
  return {
    app,
    database,
    storage,
    async close() {
      await app.close();
      await database.close();
      await identityDatabase.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** DNS for tests: the records a test sets, and nothing else. */
export class TestDns extends DnsLookup {
  readonly records = new Map<string, { cnames?: string[]; addresses?: string[] }>();

  async cnames(host: string): Promise<string[]> {
    return this.records.get(host)?.cnames ?? [];
  }

  async addresses(host: string): Promise<string[]> {
    return this.records.get(host)?.addresses ?? [];
  }
}
