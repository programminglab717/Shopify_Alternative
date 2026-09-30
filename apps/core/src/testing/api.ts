import { DnsLookup } from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { Database } from '@hatti/db';
import type { TestDatabase } from '@hatti/db/testing';
import { createLogger } from '@hatti/logger';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApi } from '../api/create-api.js';

export interface TestApi {
  app: NestFastifyApplication;
  database: Database;
  close(): Promise<void>;
}

/** What storefronts present to the /storefront/ routes in tests. */
export const TEST_STOREFRONT_KEY = 'test-storefront-key-with-32-characters';

/**
 * Boots the Admin API against a test database, with quiet logs and no rate limits, and DNS that
 * knows nothing unless the test gives its own.
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
  const app = await createApi({
    database,
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
    async close() {
      await app.close();
      await database.close();
      await identityDatabase.close();
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
