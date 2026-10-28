import 'reflect-metadata';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId, toPublicId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consoleAgentToken, startTestConsole, type TestConsole } from '../testing/console.js';
import { fakeOidcProvider } from '../testing/oidc-provider.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const CLIENT = { id: 'hatti-console', secret: 'the-console-secret-of-hatti' };

describe.skipIf(!server)(
  "Hatti's console: shops looked up, and couriers' city names (ADR-881)",
  () => {
    let testDb: TestDatabase;
    let admin: pg.Client;
    let testConsole: TestConsole;
    let provider: Awaited<ReturnType<typeof fakeOidcProvider>>;
    let token = '';
    const zari = newId();
    const other = newId();
    const owner = newId();

    const call = async (method: 'GET' | 'POST', url: string, payload?: object) => {
      const response = await testConsole.app.inject({
        method,
        url: `/console/api${url}`,
        ...(payload && { payload }),
        headers: { authorization: `Bearer ${token}` },
      });
      return { status: response.statusCode, body: response.json() as Json };
    };

    beforeAll(async () => {
      testDb = await createTestDatabase(server);
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
      await admin.query(
        `INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari'), ($2, 'Gul Lawn', 'gul-lawn')`,
        [zari, other],
      );
      await admin.query(
        `INSERT INTO identity.users (id, name, email, phone_e164)
       VALUES ($1, 'Sana Ahmed', 'sana@zari.pk', '+923001234567')`,
        [owner],
      );
      await admin.query(
        `INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, 'owner')`,
        [owner, zari],
      );
      await admin.query(
        `INSERT INTO identity.support_grants (id, shop_id, granted_by, note, expires_at)
       VALUES ($1, $2, $3, 'Order #1043 won''t ship', now() + interval '1 hour')`,
        [newId(), zari, owner],
      );
      await admin.query(
        `INSERT INTO trust.verifications
         (shop_id, level, name, cnic_last4, status, asked_by, decided_at, decided_by)
       VALUES ($1, 'identity', 'Sana Ahmed', '5671', 'approved', $2, now(), 'Ayesha')`,
        [zari, owner],
      );
      await admin.query(
        `INSERT INTO trust.store_signals (shop_id, kind, detail) VALUES ($1, 'prepaid_unshipped', '{}')`,
        [zari],
      );
      for (const shop of [zari, other, newId(), newId()]) {
        if (shop !== zari && shop !== other) {
          await admin.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, $2, $3)`, [
            shop,
            `Shop ${shop.slice(-4)}`,
            `shop-${shop.slice(-6)}`,
          ]);
        }
        await admin.query(
          `INSERT INTO logistics.shop_courier_cities (shop_id, courier, city_key, city, courier_city)
         VALUES ($1, 'postex', 'chak45', 'Chak 45', 'CHAK 45 SB')`,
          [shop],
        );
      }
      provider = await fakeOidcProvider(CLIENT);
      testConsole = await startTestConsole(testDb, {
        issuer: provider.issuer,
        clientId: CLIENT.id,
        clientSecret: CLIENT.secret,
        consoleUrl: 'https://console.hatti.example',
      });
      token = await consoleAgentToken(testConsole, admin, provider, 'ayesha@hatti.pk', 'Ayesha');
    });

    afterAll(async () => {
      await testConsole?.close();
      provider?.http.close();
      await admin?.end();
      await testDb?.drop();
    });

    it('finds a shop by its name, handle or ID, and shows its standing, each look logged', async () => {
      const id = toPublicId('shop', zari);
      expect((await call('GET', '/shops?query=zar')).body.shops).toEqual([
        expect.objectContaining({
          id,
          name: 'Zari',
          handle: 'zari',
          status: 'active',
          plan: 'free',
        }),
      ]);
      expect(
        (await call('GET', '/shops?query=gul-l')).body.shops.map((each: Json) => each.name),
      ).toEqual(['Gul Lawn']);
      expect((await call('GET', `/shops?query=${id}`)).body.shops).toHaveLength(1);
      // Too little to look for, and the wildcards of LIKE are words like any other.
      expect((await call('GET', '/shops?query=z')).body.shops).toEqual([]);
      expect((await call('GET', '/shops?query=%25%25')).body.shops).toEqual([]);

      const standing = (await call('GET', `/shops/${id}`)).body;
      expect(standing).toMatchObject({
        shop: { id, name: 'Zari' },
        owner: { name: 'Sana Ahmed', email: 'sana@zari.pk', phone: '+923001234567' },
        verified: ['identity'],
        openReports: 0,
        openSupportRequests: 0,
        standingSignals: 1,
        downSince: null,
        supportAccess: { until: expect.any(String), note: "Order #1043 won't ship" },
      });
      expect((await call('GET', `/shops/${toPublicId('shop', newId())}`)).status).toBe(404);
      const log = (await call('GET', '/actions')).body.actions;
      expect(log.map((each: Json) => [each.action, each.subject])).toEqual([['shop.view', id]]);
      // What was done to the shop shows on its page, the latest first: this look among it.
      expect(
        (await call('GET', `/shops/${id}`)).body.actions.map((each: Json) => each.action),
      ).toEqual(['shop.view', 'shop.view']);
    });

    it("shows the names shops give a city with a courier, and keeps and forgets Hatti's own", async () => {
      expect((await call('GET', '/courier-cities')).body.couriers).toEqual(['postex']);
      const review = (await call('GET', '/courier-cities/postex')).body;
      expect(review.shops).toEqual([
        {
          cityKey: 'chak45',
          city: 'Chak 45',
          names: [{ courierCity: 'CHAK 45 SB', shops: 4 }],
          shared: 'CHAK 45 SB',
        },
      ]);
      expect(review.hatti).toEqual([]);
      expect(
        (await call('POST', '/courier-cities/postex/keep', { city: 'Chak 45' })).body.error.fields,
      ).toEqual({ courierCity: 'BLANK' });
      expect(
        (
          await call('POST', '/courier-cities/postex/keep', {
            city: 'Chak 45',
            courierCity: 'CHAK NO 45 SB',
          })
        ).body,
      ).toEqual({ kept: { city: 'Chak 45', courierCity: 'CHAK NO 45 SB' } });
      expect((await call('GET', '/courier-cities/postex')).body.hatti).toEqual([
        { city: 'Chak 45', courierCity: 'CHAK NO 45 SB' },
      ]);
      expect(
        (await call('POST', '/courier-cities/postex/forget', { city: 'chak 45' })).body,
      ).toEqual({
        forgotten: 'chak 45',
      });
      expect(
        (await call('POST', '/courier-cities/postex/forget', { city: 'Chak 45' })).status,
      ).toBe(404);
      expect((await call('GET', '/courier-cities/Post-Ex')).status).toBe(404);
    });
  },
);
