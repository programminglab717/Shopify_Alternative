import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sessionDays } from './schema.js';
import { SessionDaysService, conversionRate } from './session-days.service.js';
import { errorsOf, onlineStoreFixture, unwrap, type OnlineStoreFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)("The online store's sessions (ADR-180)", () => {
  let f: OnlineStoreFixture;
  let sessions: SessionDaysService;
  const counts = (sessions: number, addedToCart = 0, reachedCheckout = 0, converted = 0) => ({
    sessions,
    addedToCart,
    reachedCheckout,
    converted,
  });

  beforeAll(async () => {
    f = await onlineStoreFixture(server!);
    sessions = new SessionDaysService(f.db);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.admin.query('DELETE FROM online_store.session_days');
  });

  it('matches the migrated table', async () => {
    await f.db.tenant(f.a.shopId, (tx) => tx.select().from(sessionDays).limit(1));
  });

  it("keeps each day's counts as the storefronts counted them, the latest in place of the last", async () => {
    await sessions.keep(f.a.shopId, '2026-10-04', counts(40, 10, 4, 2));
    await sessions.keep(f.a.shopId, '2026-10-05', counts(5, 1));
    await sessions.keep(f.a.shopId, '2026-10-05', counts(12, 3, 2, 1));
    await sessions.keep(f.b.shopId, '2026-10-05', counts(99, 9, 9, 9));
    // 4 and 5 October in Karachi, from midnight to midnight.
    const report = unwrap(
      await sessions.report(f.a, {
        from: new Date('2026-10-03T19:00:00Z'),
        before: new Date('2026-10-05T19:00:00Z'),
        interval: 'day',
      }),
    );
    expect(report).toEqual({
      totals: counts(52, 13, 6, 3),
      periods: [
        { start: new Date('2026-10-03T19:00:00Z'), ...counts(40, 10, 4, 2) },
        { start: new Date('2026-10-04T19:00:00Z'), ...counts(12, 3, 2, 1) },
      ],
    });
    expect(conversionRate(report.totals)).toBe(0.0577);
    expect(conversionRate(counts(0))).toBeNull();
  });

  it('gives every week or month of a period, those without sessions too', async () => {
    await sessions.keep(f.a.shopId, '2026-09-30', counts(7, 1));
    await sessions.keep(f.a.shopId, '2026-10-06', counts(3));
    const weeks = unwrap(
      await sessions.report(f.a, {
        from: new Date('2026-09-27T19:00:00Z'),
        before: new Date('2026-10-18T19:00:00Z'),
        interval: 'week',
      }),
    );
    // Weeks from Monday: 28 September, 5 October and 12 October.
    expect(weeks.periods.map((period) => [period.start.toISOString(), period.sessions])).toEqual([
      ['2026-09-27T19:00:00.000Z', 7],
      ['2026-10-04T19:00:00.000Z', 3],
      ['2026-10-11T19:00:00.000Z', 0],
    ]);
    const months = unwrap(
      await sessions.report(f.a, {
        from: new Date('2026-08-31T19:00:00Z'),
        before: new Date('2026-10-31T19:00:00Z'),
        interval: 'month',
      }),
    );
    expect(months.periods.map((period) => period.sessions)).toEqual([7, 3]);
    // Another shop sees none of them.
    const theirs = unwrap(
      await sessions.report(f.b, {
        from: new Date('2026-08-31T19:00:00Z'),
        before: new Date('2026-10-31T19:00:00Z'),
        interval: 'month',
      }),
    );
    expect(theirs.totals.sessions).toBe(0);
  });

  it('refuses a period that ends before it begins, or longer than a year', async () => {
    const from = new Date('2026-10-05T00:00:00Z');
    expect(errorsOf(await sessions.report(f.a, { from, before: from, interval: 'day' }))).toEqual([
      ['before', 'INVALID', 'Before must be later than from'],
    ]);
    const long = new Date(from.getTime() + 367 * 86_400_000);
    expect(errorsOf(await sessions.report(f.a, { from, before: long, interval: 'day' }))).toEqual([
      ['before', 'INVALID', 'A report covers at most 366 days at a time'],
    ]);
  });
});
