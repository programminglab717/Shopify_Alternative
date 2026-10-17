import 'reflect-metadata';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiCreditsService, creditMonth } from './ai-credits.js';

const server = testDatabaseServer();

describe('A month of AI credits by plan (BIL-01, ADR-533)', () => {
  it("counts the month in Pakistan's time", () => {
    // 11 pm in Karachi on the last of October is still October; an hour later, November.
    expect(creditMonth(new Date('2026-10-31T18:59:00Z'))).toEqual({
      start: new Date('2026-09-30T19:00:00Z'),
      next: new Date('2026-10-31T19:00:00Z'),
    });
    expect(creditMonth(new Date('2026-10-31T19:00:00Z')).start).toEqual(
      new Date('2026-10-31T19:00:00Z'),
    );
    expect(creditMonth(new Date('2026-12-15T00:00:00Z')).next).toEqual(
      new Date('2026-12-31T19:00:00Z'),
    );
  });

  describe.skipIf(!server)('kept by billing', () => {
    let testDb: TestDatabase;
    let db: Database;
    let admin: pg.Client;
    let credits: AiCreditsService;
    const [free, growth] = [newId(), newId()];
    const AT = new Date('2026-10-17T09:00:00Z');

    beforeAll(async () => {
      testDb = await createTestDatabase(server!);
      db = new Database({
        appUrl: testDb.appUrl,
        systemUrl: testDb.systemUrl,
        applicationName: 'ai-credits-test',
      });
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
      await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari'), ($2, 'Bano')`, [
        free,
        growth,
      ]);
      await admin.query(
        `INSERT INTO billing.subscriptions (shop_id, plan, billing_interval, period_start, period_end)
         VALUES ($1, 'growth', 'monthly', now(), now() + interval '1 month')`,
        [growth],
      );
      credits = new AiCreditsService(db);
    });

    afterAll(async () => {
      await db?.close();
      await admin?.end();
      await testDb?.drop();
    });

    it("gives each shop its plan's credits a month, each draft spending one, back next month", async () => {
      expect(await credits.balanceOf(free, AT)).toEqual({
        perMonth: 10,
        used: 0,
        left: 10,
        plan: 'Free',
        renewsAt: new Date('2026-10-31T19:00:00Z'),
      });
      expect(await credits.balanceOf(growth, AT)).toMatchObject({ perMonth: 150, left: 150 });

      // Last month's draft counts nothing now.
      await credits.spend(free, 'translation', new Date('2026-09-30T18:00:00Z'));
      for (let i = 0; i < 10; i += 1) await credits.spend(free, 'product_copy', AT);
      expect(await credits.balanceOf(free, AT)).toMatchObject({ used: 10, left: 0 });
      // Past the plan's, none are left, never fewer.
      await credits.spend(free, 'product_copy', AT);
      expect(await credits.balanceOf(free, AT)).toMatchObject({ used: 11, left: 0 });
      // Another shop's are its own.
      expect((await credits.balanceOf(growth, AT)).used).toBe(0);
      // Back on the 1st, Pakistan's time.
      expect(await credits.balanceOf(free, new Date('2026-10-31T19:00:00Z'))).toMatchObject({
        used: 0,
        left: 10,
      });
    });
  });
});
