import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import {
  LinkTapsService,
  SessionDaysService,
  linkHash,
  type SessionCounts,
} from '@hatti/online-store/public';
import { StorefrontActivity, StorefrontKeys } from '@hatti/storefront-data';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StorefrontSessions } from './storefront-sessions.js';

const server = testDatabaseServer();
const redisUrl = process.env.REDIS_URL;
if (!redisUrl && process.env.CI) throw new Error('REDIS_URL must be set in CI');

describe.skipIf(!server || !redisUrl)('Storefront sessions kept by the worker (ADR-180)', () => {
  let testDb: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  const redis = new Redis(redisUrl ?? '', { lazyConnect: true });
  const prefix = `test-sessions-${randomBytes(4).toString('hex')}`;
  const activity = new StorefrontActivity(redis, new StorefrontKeys(prefix));
  const [a, b] = [newId(), newId()];
  const karachi = 'Asia/Karachi';
  /** 23:30 on 4 October in Karachi, and 00:10 on the 5th. */
  const late = new Date('2026-10-04T18:30:00Z');
  const early = new Date('2026-10-04T19:10:00Z');

  const kept = async () =>
    (
      await admin.query<{
        shop_id: string;
        day: string;
        sessions: number;
        added_to_cart: number;
        reached_checkout: number;
        converted: number;
      }>(
        `SELECT shop_id, day::text, sessions, added_to_cart, reached_checkout, converted
           FROM online_store.session_days ORDER BY shop_id, day`,
      )
    ).rows;

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    database = new Database({ appUrl: testDb.appUrl, applicationName: 'storefront-sessions-test' });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [a, b]);
  });

  afterAll(async () => {
    const found = await redis.keys(`${prefix}:*`);
    if (found.length > 0) await redis.del(...found);
    redis.disconnect();
    await database?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("keeps each shop's days counted since the last sweep, their latest counts in place", async () => {
    const sweeps = new StorefrontSessions(activity, {
      days: new SessionDaysService(database),
      taps: new LinkTapsService(database),
    });
    await activity.visited(a, karachi, 'session-1', late);
    await activity.visited(a, karachi, 'session-2', late);
    await activity.reached(a, karachi, 'session-2', 'added_to_cart', late);
    await activity.visited(a, karachi, 'session-1', early);
    await activity.reached(b, karachi, 'session-3', 'converted', early);
    expect(await sweeps.sweep()).toBe(3);
    const row = (shopId: string, day: string, [s, c, r, v]: number[]) => ({
      shop_id: shopId,
      day,
      sessions: s,
      added_to_cart: c,
      reached_checkout: r,
      converted: v,
    });
    const expected = [
      row(a, '2026-10-04', [2, 1, 0, 0]),
      row(a, '2026-10-05', [1, 0, 0, 0]),
      row(b, '2026-10-05', [1, 0, 0, 1]),
    ].sort((x, y) => (x.shop_id + x.day).localeCompare(y.shop_id + y.day));
    expect(await kept()).toEqual(expected);
    // Nothing new: nothing to keep.
    expect(await sweeps.sweep()).toBe(0);
    // More of a day: its counts so far, in place of those before.
    await activity.reached(a, karachi, 'session-1', 'reached_checkout', early);
    expect(await sweeps.sweep()).toBe(1);
    expect((await kept()).find((r) => r.shop_id === a && r.day === '2026-10-05')).toEqual(
      row(a, '2026-10-05', [1, 0, 1, 0]),
    );
  });

  it('gives back a day it could not keep, for the next sweep', async () => {
    let failing = true;
    const days = new SessionDaysService(database);
    const flaky = {
      keep: (shopId: string, day: string, counts: SessionCounts) =>
        failing ? Promise.reject(new Error('database down')) : days.keep(shopId, day, counts),
    } as SessionDaysService;
    const sweeps = new StorefrontSessions(activity, {
      days: flaky,
      taps: new LinkTapsService(database),
    });
    await activity.visited(b, karachi, 'session-4', late);
    expect(await sweeps.sweep()).toBe(0);
    failing = false;
    expect(await sweeps.sweep()).toBe(1);
    expect((await kept()).find((r) => r.shop_id === b && r.day === '2026-10-04')).toMatchObject({
      sessions: 1,
    });
  });

  it("keeps each day's taps on the link page's links beside its sessions (ADR-204)", async () => {
    const sweeps = new StorefrontSessions(activity, {
      days: new SessionDaysService(database),
      taps: new LinkTapsService(database),
    });
    const taps = async () =>
      (
        await admin.query<{
          shop_id: string;
          day: string;
          link: string;
          url: string;
          taps: number;
        }>(
          `SELECT shop_id, day::text, link, url, taps FROM online_store.link_taps
            ORDER BY shop_id, day, url`,
        )
      ).rows;
    const instagram = 'https://www.instagram.com/zari.pk';
    await activity.tapped(a, karachi, instagram, late);
    await activity.tapped(a, karachi, instagram, late);
    await activity.tapped(a, karachi, '/collections/eid-lawn', early);
    await activity.tapped(b, karachi, instagram, early);
    expect(await sweeps.sweep()).toBe(3);
    const row = (shopId: string, day: string, url: string, count: number) => ({
      shop_id: shopId,
      day,
      link: linkHash(url),
      url,
      taps: count,
    });
    const expected = [
      row(a, '2026-10-04', instagram, 2),
      row(a, '2026-10-05', '/collections/eid-lawn', 1),
      row(b, '2026-10-05', instagram, 1),
    ].sort((x, y) => (x.shop_id + x.day).localeCompare(y.shop_id + y.day));
    expect(await taps()).toEqual(expected);
    // More taps of a day: its counts so far, in place of those before.
    await activity.tapped(a, karachi, instagram, late);
    expect(await sweeps.sweep()).toBe(1);
    expect(
      (await taps()).find((r) => r.shop_id === a && r.day === '2026-10-04' && r.url === instagram),
    ).toEqual(row(a, '2026-10-04', instagram, 3));
  });
});
