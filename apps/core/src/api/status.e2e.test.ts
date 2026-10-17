import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { generateAccessToken } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId, toPublicId } from '@hatti/ids';
import { IncidentsService } from '@hatti/trust/public';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const STATUS = `{
  platformStatus {
    statusPageUrl
    incidents {
      id kind impact status components title titleUr startsAt endsAt
      latestUpdate { status body bodyUr postedAt }
    }
  }
}`;

describe.skipIf(!server)("Hatti's status page and the admin's banner (BIL-06)", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  let system: Database;
  let incidents: IncidentsService;
  const shop = newId();
  let token = '';

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`, [
      shop,
    ]);
    // The narrowest token there is: every member of the staff sees the banner.
    const { token: issued, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shop, hash, hint, ['read_products']],
    );
    token = issued;
    system = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'status-test',
    });
    incidents = new IncidentsService(system);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await system?.close();
    await admin?.end();
    await testDb?.drop();
  });

  async function gql(query: string) {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token, 'idempotency-key': randomUUID() },
      payload: { query },
    });
    return response.json<{ data?: Json; errors?: Json[] }>();
  }

  it('shows every part working, then an incident on the page, its JSON and the banner, until it ends', async () => {
    const calm = await app.inject({ method: 'GET', url: '/status' });
    expect(calm.statusCode).toBe(200);
    expect(calm.headers['cache-control']).toContain('stale-if-error=86400');
    expect(calm.headers['content-security-policy']).toBeTruthy();
    expect(calm.body).toContain('Everything is working');
    expect((await gql(STATUS)).data.platformStatus).toEqual({
      statusPageUrl: expect.stringMatching(/\/status$/),
      incidents: [],
    });

    const opened = await incidents.open({
      kind: 'incident',
      impact: 'degraded',
      components: ['whatsapp'],
      title: 'WhatsApp messages delayed',
      titleUr: 'واٹس ایپ پیغامات میں تاخیر',
      body: 'Meta is slow to accept messages; they go out late but go out.',
      by: 'Ayesha',
    });
    if (!opened.ok) throw new Error(opened.problem);
    const ahead = new Date(Date.now() + 3 * 3_600_000);
    const later = await incidents.open({
      kind: 'maintenance',
      impact: 'outage',
      components: ['admin', 'checkout'],
      title: 'Database upgrade',
      body: 'Checkout and the admin are down for 15 minutes.',
      startsAt: ahead,
      endsAt: new Date(ahead.getTime() + 15 * 60_000),
      by: 'Bilal',
    });
    if (!later.ok) throw new Error(later.problem);
    // A week ahead is not the banner's yet.
    await incidents.open({
      kind: 'maintenance',
      impact: 'degraded',
      components: ['storefronts'],
      title: 'Image service move',
      body: 'Pictures may load slowly.',
      startsAt: new Date(Date.now() + 7 * 86_400_000),
      by: 'Bilal',
    });

    const page = await app.inject({ method: 'GET', url: '/status' });
    expect(page.body).toContain('Some of Hatti is slow or partly down');
    expect(page.body).toContain('data-component="whatsapp" data-state="degraded"');
    expect(page.body).toContain('data-component="checkout" data-state="operational"');
    expect(page.body).toContain('واٹس ایپ پیغامات میں تاخیر');
    expect(page.body).toContain('Image service move');

    const json = await app.inject({ method: 'GET', url: '/status.json' });
    expect(json.headers['access-control-allow-origin']).toBe('*');
    expect(json.json()).toMatchObject({
      overall: 'degraded',
      active: [{ title: 'WhatsApp messages delayed', status: 'investigating' }],
      upcoming: [{ title: 'Database upgrade' }, { title: 'Image service move' }],
      recent: [],
    });
    // Each part's 90 days (ADR-528): slowness shows on today's bar, and is not counted as down.
    const whatsapp = json
      .json()
      .history.find((each: { component: string }) => each.component === 'whatsapp');
    expect(whatsapp.days).toHaveLength(90);
    expect(whatsapp).toMatchObject({ uptime: 100 });
    expect(whatsapp.days.at(-1)).toMatchObject({ state: 'degraded', downMinutes: 0 });
    expect(page.body).toContain('data-history="whatsapp"');

    const banner = await gql(STATUS);
    expect(banner.errors).toBeUndefined();
    expect(banner.data.platformStatus.incidents).toEqual([
      {
        id: toPublicId('incident', later.value.id),
        kind: 'MAINTENANCE',
        impact: 'OUTAGE',
        status: 'SCHEDULED',
        components: ['CHECKOUT', 'ADMIN'],
        title: 'Database upgrade',
        titleUr: null,
        startsAt: ahead.toISOString(),
        endsAt: new Date(ahead.getTime() + 15 * 60_000).toISOString(),
        latestUpdate: expect.objectContaining({ status: 'SCHEDULED', bodyUr: null }),
      },
      expect.objectContaining({
        id: toPublicId('incident', opened.value.id),
        kind: 'INCIDENT',
        status: 'INVESTIGATING',
        components: ['WHATSAPP'],
        titleUr: 'واٹس ایپ پیغامات میں تاخیر',
      }),
    ]);

    await incidents.update(opened.value.id, {
      status: 'resolved',
      body: 'Messages go out on time again.',
      by: 'Ayesha',
    });
    const after = await gql(STATUS);
    expect(after.data.platformStatus.incidents.map((each: Json) => each.title)).toEqual([
      'Database upgrade',
    ]);
    const ended = await app.inject({ method: 'GET', url: '/status.json' });
    expect(ended.json()).toMatchObject({
      overall: 'operational',
      active: [],
      recent: [{ title: 'WhatsApp messages delayed', status: 'resolved' }],
    });
  });
});
