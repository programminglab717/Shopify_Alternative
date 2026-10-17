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

    it("gives shops an outage's opening and ending to hear on WhatsApp, each until sent, and nothing else (ADR-544)", async () => {
      // A slow part, and what was said of it, reach shops by the page and its emails alone.
      const slow = await incidents.open(
        {
          kind: 'incident',
          impact: 'degraded',
          components: ['sms'],
          title: 'SMS slow',
          body: 'Slow.',
          by: 'Hamza',
        },
        minutes(300),
      );
      if (!slow.ok) throw new Error(slow.problem);
      const down = await incidents.open(
        {
          kind: 'incident',
          impact: 'outage',
          components: ['checkout', 'payments'],
          title: 'Checkout down',
          titleUr: 'چیک آؤٹ بند',
          body: 'Orders cannot be placed.',
          by: 'Hamza',
        },
        minutes(301),
      );
      if (!down.ok) throw new Error(down.problem);
      const due = await subscriptions.shopNoticesDue(minutes(302));
      expect(due).toEqual([
        expect.objectContaining({
          incidentId: down.value.id,
          kind: 'incident',
          title: 'Checkout down',
          titleUr: 'چیک آؤٹ بند',
          components: ['checkout', 'payments'],
          status: 'investigating',
        }),
      ]);
      // Given again until it is sent.
      expect(await subscriptions.shopNoticesDue(minutes(303))).toEqual(due);
      await subscriptions.shopNoticeSent(due[0]!.updateId, minutes(303));
      expect(await subscriptions.shopNoticesDue(minutes(304))).toEqual([]);

      // What is said while it lasts is not sent; its ending is.
      for (const [status, at] of [
        ['identified', 310],
        ['resolved', 320],
      ] as const) {
        await incidents.update(down.value.id, { status, body: status, by: 'Hamza' }, minutes(at));
      }
      const ended = await subscriptions.shopNoticesDue(minutes(321));
      expect(ended.map((notice) => notice.status)).toEqual(['resolved']);
      await subscriptions.shopNoticeSent(ended[0]!.updateId, minutes(321));

      // Maintenance putting a part out of service: its setting, and its completion, while fresh.
      const planned = await incidents.open(
        {
          kind: 'maintenance',
          impact: 'outage',
          components: ['admin'],
          title: 'Admin upgrade',
          body: 'The admin is down for an hour.',
          startsAt: minutes(2000),
          endsAt: minutes(2060),
          by: 'Hamza',
        },
        minutes(330),
      );
      if (!planned.ok) throw new Error(planned.problem);
      // Missed for over six hours: put aside, never sent.
      expect(await subscriptions.shopNoticesDue(minutes(330 + 7 * 60))).toEqual([]);
      await incidents.update(
        planned.value.id,
        { status: 'completed', body: 'Done.', by: 'Hamza' },
        minutes(2061),
      );
      expect(
        (await subscriptions.shopNoticesDue(minutes(2062))).map((notice) => [
          notice.kind,
          notice.status,
        ]),
      ).toEqual([['maintenance', 'completed']]);
    });
  });
});
