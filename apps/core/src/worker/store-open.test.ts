import 'reflect-metadata';
import { StorefrontSite } from '@hatti/api';
import { SegmentFieldRegistry, SegmentService, SignUpService } from '@hatti/customers/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import type { DomainEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { MessagesService } from '@hatti/messaging/public';
import { OnlineStoreEvents } from '@hatti/online-store/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StoreOpenNotices } from './store-open.js';

const server = testDatabaseServer();

describe.skipIf(!server)(
  'The pre-launch waitlist told when the shop opens (ONB-14, ADR-446)',
  () => {
    let testDb: TestDatabase;
    let database: Database;
    let admin: pg.Client;
    let notices: StoreOpenNotices;
    const shopId = newId();

    const changed = (...fields: string[]): DomainEvent =>
      ({
        id: newId(),
        type: OnlineStoreEvents.PreferencesUpdated,
        shopId,
        aggregateType: 'shop',
        aggregateId: shopId,
        payload: { changed: fields },
      }) as unknown as DomainEvent;
    const closed = (enabled: boolean) =>
      admin.query(
        // A password kept, as one must be for the shop to be closed behind it.
        `INSERT INTO online_store.preferences
                (shop_id, password_enabled, password_sealed, password_verifier)
         VALUES ($1, $2, 'sealed', 'verifier')
         ON CONFLICT (shop_id) DO UPDATE SET password_enabled = EXCLUDED.password_enabled`,
        [shopId, enabled],
      );
    const told = async () =>
      (
        await admin.query<{ recipient: string; variables: Record<string, string> }>(
          `SELECT recipient, variables FROM messaging.messages
          WHERE shop_id = $1 AND kind = 'store_open' ORDER BY recipient`,
          [shopId],
        )
      ).rows;

    beforeAll(async () => {
      testDb = await createTestDatabase(server!);
      database = new Database({
        appUrl: testDb.appUrl,
        systemUrl: testDb.systemUrl,
        applicationName: 'store-open-test',
      });
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
      await admin.query(
        `INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`,
        [shopId],
      );
      notices = new StoreOpenNotices(
        database,
        new SegmentService(database, new SegmentFieldRegistry()),
        new MessagesService(database),
        new StorefrontSite('https://hatti.test'),
      );
      const signUps = new SignUpService(database);
      for (const [phone, tags] of [
        ['0300 1112223', 'waitlist'],
        ['0301 4445556', 'waitlist,eid'],
        // Signed up for news alone: not told the shop opened.
        ['0302 7778889', 'newsletter'],
      ] as const) {
        const outcome = await signUps.signUp(shopId, { phone, tags });
        if (!outcome.ok) throw new Error(JSON.stringify(outcome.errors));
      }
    }, 120_000);

    afterAll(async () => {
      await database?.close();
      await admin?.end();
      await testDb?.drop();
    });

    it('tells each subscribed shopper on the waitlist once the shop opens, and once only', async () => {
      await closed(true);
      // Closed still, or something else changed: nobody is told.
      expect(await notices.handle(changed('passwordEnabled'))).toBe(0);
      await closed(false);
      expect(await notices.handle(changed('seo'))).toBe(0);
      expect(await told()).toEqual([]);

      expect(await notices.handle(changed('passwordEnabled'))).toBe(2);
      expect(await told()).toEqual([
        { recipient: '+923001112223', variables: { shop: 'Zari', url: 'https://zari.hatti.test' } },
        { recipient: '+923014445556', variables: { shop: 'Zari', url: 'https://zari.hatti.test' } },
      ]);
      // Closed and opened again: told once.
      await closed(true);
      await notices.handle(changed('passwordEnabled'));
      await closed(false);
      expect(await notices.handle(changed('passwordEnabled'))).toBe(0);
      expect(await told()).toHaveLength(2);
      expect(StoreOpenNotices.EVENTS).toEqual([OnlineStoreEvents.PreferencesUpdated]);
    });
  },
);
