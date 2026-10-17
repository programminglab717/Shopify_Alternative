import 'reflect-metadata';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IncidentsService } from './incidents.service.js';
import { statusPage, statusSubscriptionPage } from './status-page.js';
import { StatusSubscriptionsService, subscriberEmail } from './status-subscriptions.service.js';

const server = testDatabaseServer();
const NOW = new Date('2026-10-17T09:00:00.000Z');
const minutes = (count: number) => new Date(NOW.getTime() + count * 60_000);

describe("The status page's emails (BIL-06, ADR-535)", () => {
  it('takes addresses as given, in lower case', () => {
    expect(subscriberEmail('  Ayesha@Example.PK ')).toBe('ayesha@example.pk');
    expect(subscriberEmail('ayesha')).toBeNull();
    expect(subscriberEmail(`${'a'.repeat(250)}@b.pk`)).toBeNull();
  });

  it('asks on the status page, and says each link page plainly', () => {
    const page = statusPage({
      overall: 'operational',
      components: [],
      active: [],
      upcoming: [],
      recent: [],
      history: [],
    }).html;
    expect(page).toContain('action="/status/subscribe"');
    expect(page).toContain('Get these by email');
    const asked = statusSubscriptionPage({ kind: 'asked' });
    expect(asked.status).toBe(200);
    expect(asked.html).toContain('a link to confirm is on its way');
    expect(statusSubscriptionPage({ kind: 'wrong' }).status).toBe(422);
    expect(statusSubscriptionPage({ kind: 'not_found' }).status).toBe(404);
    const toConfirm = statusSubscriptionPage({
      kind: 'link',
      view: { email: 'a@b.pk', confirmed: false },
    }).html;
    expect(toConfirm).toContain('name="action" value="confirm"');
    expect(
      statusSubscriptionPage({ kind: 'link', view: { email: 'a@b.pk', confirmed: true } }).html,
    ).toContain('name="action" value="stop"');
  });

  describe.skipIf(!server)('kept and taken', () => {
    let testDb: TestDatabase;
    let db: Database;
    let admin: pg.Client;
    let subscriptions: StatusSubscriptionsService;
    let incidents: IncidentsService;

    beforeAll(async () => {
      testDb = await createTestDatabase(server!);
      db = new Database({
        appUrl: testDb.appUrl,
        systemUrl: testDb.systemUrl,
        applicationName: 'status-subscriptions-test',
      });
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
      subscriptions = new StatusSubscriptionsService(db);
      incidents = new IncidentsService(db);
    });

    afterAll(async () => {
      await db?.close();
      await admin?.end();
      await testDb?.drop();
    });

    it('emails a link to confirm once an hour at most, and updates only to confirmed addresses, each once', async () => {
      expect(await subscriptions.subscribe('not an address', NOW)).toBe(false);
      expect(await subscriptions.subscribe('Ayesha@Example.pk', NOW)).toBe(true);
      expect(await subscriptions.subscribe('bilal@example.pk', NOW)).toBe(true);
      const asked = await subscriptions.takeConfirmations(minutes(1));
      expect(asked.map((each) => each.email).sort()).toEqual([
        'ayesha@example.pk',
        'bilal@example.pk',
      ]);
      expect(await subscriptions.takeConfirmations(minutes(2))).toEqual([]);
      // Asked again within the hour: nothing more; an hour on, the link again.
      await subscriptions.subscribe('ayesha@example.pk', minutes(30));
      expect(await subscriptions.takeConfirmations(minutes(31))).toEqual([]);
      await subscriptions.subscribe('ayesha@example.pk', minutes(61));
      const again = await subscriptions.takeConfirmations(minutes(62));
      expect(again.map((each) => each.email)).toEqual(['ayesha@example.pk']);

      const ayesha = again[0]!.token;
      expect(await subscriptions.view(ayesha)).toEqual({
        email: 'ayesha@example.pk',
        confirmed: false,
      });
      expect(await subscriptions.confirm(ayesha, minutes(63))).toEqual({
        email: 'ayesha@example.pk',
        confirmed: true,
      });
      // Confirmed, asking again sends no link.
      await subscriptions.subscribe('ayesha@example.pk', minutes(200));
      expect(await subscriptions.takeConfirmations(minutes(201))).toEqual([]);
      expect(await subscriptions.view('x'.repeat(40))).toBeNull();
      expect(await subscriptions.confirm('short')).toBeNull();

      // An update posted goes to Ayesha alone, once.
      const opened = await incidents.open(
        {
          kind: 'incident',
          impact: 'degraded',
          components: ['whatsapp'],
          title: 'WhatsApp messages delayed',
          titleUr: 'واٹس ایپ پیغامات میں تاخیر',
          body: "Meta's servers are slow; messages go out late.",
          by: 'Hamza',
        },
        minutes(210),
      );
      if (!opened.ok) throw new Error(opened.problem);
      const taken = await subscriptions.takeUpdates(minutes(211));
      expect(taken.updates).toEqual([
        expect.objectContaining({
          title: 'WhatsApp messages delayed',
          titleUr: 'واٹس ایپ پیغامات میں تاخیر',
          status: 'investigating',
          components: ['whatsapp'],
        }),
      ]);
      expect(taken.recipients).toEqual([{ email: 'ayesha@example.pk', token: ayesha }]);
      expect(await subscriptions.takeUpdates(minutes(212))).toEqual({
        updates: [],
        recipients: [],
      });
      // One missed for over a day is taken, and given to no one.
      await incidents.update(
        opened.value.id,
        { status: 'resolved', body: 'Back to normal.', by: 'Hamza' },
        minutes(220),
      );
      expect((await subscriptions.takeUpdates(minutes(220 + 25 * 60))).updates).toEqual([]);

      // Stopped, the address is forgotten.
      expect(await subscriptions.unsubscribe(ayesha)).toBe(true);
      expect(await subscriptions.unsubscribe(ayesha)).toBe(false);
      const { rows } = await admin.query<{ email: string }>(
        'SELECT email FROM trust.status_subscribers',
      );
      expect(rows).toEqual([{ email: 'bilal@example.pk' }]);
    });
  });
});
