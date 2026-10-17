import 'reflect-metadata';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IncidentsService } from './incidents.service.js';
import { statusJson, statusPage, statusTime } from './status-page.js';

const server = testDatabaseServer();
const NOW = new Date('2026-10-17T09:00:00.000Z');
const minutes = (count: number) => new Date(NOW.getTime() + count * 60_000);

describe.skipIf(!server)("Hatti's status page (BIL-06, ADR-498)", () => {
  let testDb: TestDatabase;
  let db: Database;
  let incidents: IncidentsService;

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'incidents-test',
    });
    incidents = new IncidentsService(db);
  });

  afterAll(async () => {
    await db?.close();
    await testDb?.drop();
  });

  it('posts incidents and maintenance, refuses what is wrong, and follows them with updates until they end', async () => {
    const refused = await Promise.all([
      incidents.open(
        { kind: 'incident', impact: 'outage', components: [], title: 'x', body: 'y', by: 'A' },
        NOW,
      ),
      incidents.open(
        {
          kind: 'incident',
          impact: 'outage',
          components: ['checkout', 'fax'],
          title: 'x',
          body: 'y',
          by: 'A',
        },
        NOW,
      ),
      incidents.open(
        {
          kind: 'incident',
          impact: 'degraded',
          components: ['admin'],
          title: ' ',
          body: 'y',
          by: 'A',
        },
        NOW,
      ),
      incidents.open(
        {
          kind: 'incident',
          impact: 'degraded',
          components: ['admin'],
          title: 'x',
          body: 'y',
          startsAt: minutes(60),
          by: 'A',
        },
        NOW,
      ),
      incidents.open(
        {
          kind: 'maintenance',
          impact: 'outage',
          components: ['admin'],
          title: 'x',
          body: 'y',
          startsAt: minutes(60),
          endsAt: minutes(30),
          by: 'A',
        },
        NOW,
      ),
    ]);
    expect(refused.map((result) => (result.ok ? 'ok' : result.problem))).toEqual([
      'Name what it touches, of: storefronts, checkout, admin, payments, couriers, whatsapp, sms, email.',
      'Name what it touches, of: storefronts, checkout, admin, payments, couriers, whatsapp, sms, email.',
      'Give it a title.',
      'An incident begins as it is posted: only maintenance has times.',
      'It must end after it begins.',
    ]);

    const outage = await incidents.open(
      {
        kind: 'incident',
        impact: 'degraded',
        components: ['Couriers', 'checkout', 'couriers'],
        title: 'PostEx bookings failing',
        titleUr: 'پوسٹ ایکس بکنگ ناکام',
        body: 'Bookings with PostEx fail; we are looking into it.',
        bodyUr: 'پوسٹ ایکس کی بکنگ ناکام ہو رہی ہے۔',
        by: 'Ayesha',
      },
      NOW,
    );
    if (!outage.ok) throw new Error(outage.problem);
    expect(outage.value).toMatchObject({
      kind: 'incident',
      components: ['checkout', 'couriers'],
      status: 'investigating',
      startsAt: NOW,
      resolvedAt: null,
    });

    const maintenance = await incidents.open(
      {
        kind: 'maintenance',
        impact: 'outage',
        components: ['admin'],
        title: 'Database upgrade',
        body: 'The admin is down for 20 minutes.',
        startsAt: minutes(120),
        endsAt: minutes(140),
        by: 'Bilal',
      },
      NOW,
    );
    if (!maintenance.ok) throw new Error(maintenance.problem);
    expect(maintenance.value.status).toBe('scheduled');

    // An incident's statuses are not maintenance's; one that ended takes no more.
    const wrong = await incidents.update(
      outage.value.id,
      { status: 'completed', body: 'Done', by: 'Ayesha' },
      minutes(5),
    );
    expect(wrong).toEqual({
      ok: false,
      problem: 'Its status is one of: investigating, identified, monitoring, resolved.',
    });
    expect(
      await incidents.update(
        '00000000-0000-4000-8000-000000000000',
        { status: 'resolved', body: 'x', by: 'A' },
        NOW,
      ),
    ).toBe('not_found');
    const worse = await incidents.update(
      outage.value.id,
      {
        status: 'identified',
        body: "PostEx's API is down; bookings wait and go through once it is back.",
        impact: 'outage',
        by: 'Ayesha',
      },
      minutes(10),
    );
    expect(worse !== 'not_found' && worse.ok && worse.value).toMatchObject({
      impact: 'outage',
      status: 'identified',
    });

    let snapshot = await incidents.snapshot(minutes(15));
    expect(snapshot.overall).toBe('outage');
    expect(
      Object.fromEntries(snapshot.components.map((each) => [each.component, each.state])),
    ).toMatchObject({ checkout: 'outage', couriers: 'outage', admin: 'operational' });
    expect(snapshot.active.map((each) => each.title)).toEqual(['PostEx bookings failing']);
    expect(snapshot.upcoming.map((each) => each.title)).toEqual(['Database upgrade']);
    // The admin warns of maintenance within a day, and of what goes on.
    expect((await incidents.current(minutes(15))).map((each) => each.title)).toEqual([
      'Database upgrade',
      'PostEx bookings failing',
    ]);

    const page = statusPage(snapshot);
    expect(page.html).toContain('Some of Hatti is down');
    expect(page.html).toContain('PostEx bookings failing');
    expect(page.html).toContain('پوسٹ ایکس بکنگ ناکام');
    expect(page.html).toContain('data-component="checkout" data-state="outage"');
    expect(page.html).toContain(statusTime(minutes(120)));
    expect(page.html).not.toContain('Ayesha');
    expect(statusTime(NOW)).toBe('17 Oct, 2:00 pm');

    const resolved = await incidents.update(
      outage.value.id,
      { status: 'resolved', body: 'PostEx is back; every booking went through.', by: 'Ayesha' },
      minutes(40),
    );
    expect(resolved !== 'not_found' && resolved.ok && resolved.value.resolvedAt).toEqual(
      minutes(40),
    );
    expect(
      await incidents.update(
        outage.value.id,
        { status: 'monitoring', body: 'x', by: 'Ayesha' },
        minutes(41),
      ),
    ).toEqual({ ok: false, problem: 'It has ended: post a new one.' });

    // Maintenance begun early begins then, and is the admin's maintenance until it ends.
    await incidents.update(
      maintenance.value.id,
      { status: 'in_progress', body: 'Begun early.', by: 'Bilal' },
      minutes(100),
    );
    snapshot = await incidents.snapshot(minutes(101));
    expect(snapshot.overall).toBe('outage');
    expect(snapshot.active.map((each) => [each.title, each.startsAt])).toEqual([
      ['Database upgrade', minutes(100)],
    ]);
    expect(snapshot.recent.map((each) => each.title)).toEqual(['PostEx bookings failing']);
    expect(statusJson(snapshot)).toMatchObject({
      overall: 'outage',
      active: [{ kind: 'maintenance', status: 'in_progress', endsAt: minutes(140).toISOString() }],
      recent: [{ status: 'resolved', resolvedAt: minutes(40).toISOString() }],
    });
    expect(JSON.stringify(statusJson(snapshot))).not.toContain('Bilal');

    await incidents.update(
      maintenance.value.id,
      { status: 'completed', body: 'Done.', by: 'Bilal' },
      minutes(130),
    );
    snapshot = await incidents.snapshot(minutes(131));
    expect(snapshot.overall).toBe('operational');
    expect(statusPage(snapshot).html).toContain('Everything is working');
    // The parts' days keep what happened (ADR-528): checkout down 40 minutes, by the impact the
    // incident came to have; the admin's maintenance shown, and not counted against it.
    const day = (component: string, at = snapshot) =>
      at.history.find((each) => each.component === component)!;
    expect(day('checkout').days.at(-1)).toEqual({
      date: '2026-10-17',
      state: 'outage',
      downMinutes: 40,
    });
    expect(day('checkout').uptime).toBe(99.96);
    expect(day('admin')).toMatchObject({ uptime: 100 });
    expect(day('admin').days.at(-1)).toMatchObject({ state: 'outage', downMinutes: 0 });
    expect(day('sms').days.every((each) => each.state === 'operational')).toBe(true);
    // Two weeks on, the page no longer lists them, and its history still has them.
    const later = await incidents.snapshot(minutes(60 * 24 * 15));
    expect(later.recent).toEqual([]);
    expect(day('checkout', later).days.at(-16)).toMatchObject({
      date: '2026-10-17',
      downMinutes: 40,
    });
    expect((await incidents.list()).length).toBe(0);
    expect((await incidents.list({ all: true })).map((each) => each.title)).toEqual([
      'Database upgrade',
      'PostEx bookings failing',
    ]);
  });
});
