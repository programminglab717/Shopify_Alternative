import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
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
  "Hatti's console: partners' apps, themes and profiles, and their payouts (ADR-880)",
  () => {
    let testDb: TestDatabase;
    let admin: pg.Client;
    let testConsole: TestConsole;
    let provider: Awaited<ReturnType<typeof fakeOidcProvider>>;
    let token = '';
    const partner = newId();
    const studio = newId();
    const clientId = `hca_${randomBytes(16).toString('hex')}`;
    let themeListing = '';

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
        `INSERT INTO identity.users (id, name, email) VALUES ($1, 'Hira', 'hira@rang.pk')`,
        [partner],
      );
      await admin.query(
        `INSERT INTO identity.partners (user_id, business_name, referral_code, payout_title, payout_iban)
       VALUES ($1, 'Rang Studio', 'r4ngst2d', 'Rang Studio', 'PK36SCBL0000001123456702')`,
        [partner],
      );
      await admin.query(
        `INSERT INTO control.shops (id, name, handle, development) VALUES ($1, 'Rang lab', 'rang-lab', true)`,
        [studio],
      );
      await admin.query(
        `INSERT INTO identity.partner_apps
              (partner_id, name, app_url, redirect_urls, scopes, client_id, client_secret_digest)
       VALUES ($1, 'Rang Reviews', 'https://reviews.rang.pk', ARRAY['https://reviews.rang.pk/back'],
               ARRAY['read_products'], $2, $3)`,
        [partner, clientId, randomBytes(32)],
      );
      const { rows } = await admin.query<{ id: string }>(
        `INSERT INTO identity.partner_themes
              (partner_id, source_shop, source_theme, name, base, files, price)
       VALUES ($1, $2, $3, 'Basant', 'hatti-base', '{}', 500000) RETURNING id`,
        [partner, studio, newId()],
      );
      themeListing = toPublicId('themeListing', rows[0]!.id);
      await admin.query(
        `INSERT INTO identity.expert_profiles (partner_id, headline, services, languages)
       VALUES ($1, 'Lawn stores, set up in a week', ARRAY['setup', 'design'], ARRAY['en', 'ur'])`,
        [partner],
      );
      for (const amount of [59800, 30000]) {
        await admin.query(
          `INSERT INTO identity.partner_earnings
                (partner_id, shop_id, invoice_id, invoice_number, plan, invoice_amount,
                 share_percent, amount)
         VALUES ($1, $2, $3, 1, 'growth', $4 * 5, 20, $4)`,
          [partner, studio, newId(), amount],
        );
      }
      provider = await fakeOidcProvider(CLIENT);
      testConsole = await startTestConsole(testDb, {
        issuer: provider.issuer,
        clientId: CLIENT.id,
        clientSecret: CLIENT.secret,
        consoleUrl: 'https://console.hatti.example',
      });
      token = await consoleAgentToken(testConsole, admin, provider, 'sana@hatti.pk', 'Sana');
    });

    afterAll(async () => {
      await testConsole?.close();
      provider?.http.close();
      await admin?.end();
      await testDb?.drop();
    });

    it("lists a partner's app, theme and profile for every shop, and takes them back", async () => {
      expect((await call('GET', '/partner-apps')).body.apps).toEqual([
        expect.objectContaining({
          clientId,
          name: 'Rang Reviews',
          partner: 'Rang Studio',
          scopes: ['read_products'],
          redirectUrls: ['https://reviews.rang.pk/back'],
          listed: false,
        }),
      ]);
      expect((await call('POST', `/partner-apps/${clientId}/list`)).body.app).toMatchObject({
        listed: true,
      });
      expect((await call('POST', `/partner-apps/${clientId}/unlist`)).body.app.listed).toBe(false);
      expect((await call('POST', `/partner-apps/hca_nothing/list`)).status).toBe(404);
      expect((await call('POST', `/partner-apps/${clientId}/approve`)).status).toBe(404);

      expect((await call('GET', '/partner-themes')).body.themes).toEqual([
        expect.objectContaining({
          id: themeListing,
          name: 'Basant',
          designer: 'Rang Studio',
          price: 'Rs 5,000',
          listed: false,
          preview: { shopId: toPublicId('shop', studio), themeId: expect.stringMatching(/^thm_/) },
        }),
      ]);
      expect((await call('POST', `/partner-themes/${themeListing}/list`)).body.theme.listed).toBe(
        true,
      );

      const expert = toPublicId('expert', partner);
      expect((await call('GET', '/experts')).body.experts).toEqual([
        expect.objectContaining({
          id: expert,
          businessName: 'Rang Studio',
          headline: 'Lawn stores, set up in a week',
          services: ['setup', 'design'],
          startingPrice: null,
          listed: false,
        }),
      ]);
      expect((await call('POST', `/experts/${expert}/list`)).body.expert.listed).toBe(true);
    });

    it('pays a partner what they are owed, once the transfer is made', async () => {
      const id = toPublicId('user', partner);
      expect((await call('GET', '/partner-payouts')).body.partners).toEqual([
        {
          id,
          businessName: 'Rang Studio',
          email: 'hira@rang.pk',
          payout: { title: 'Rang Studio', iban: 'PK36SCBL0000001123456702' },
          owed: 'Rs 898',
          entries: 2,
        },
      ]);
      expect((await call('POST', `/partner-payouts/${id}/pay`, {})).body.error.fields).toEqual({
        reference: 'BLANK',
      });
      expect(
        (await call('POST', `/partner-payouts/${id}/pay`, { reference: 'FT24109999' })).body,
      ).toEqual({ paid: 'Rs 898', nothingOwed: false });
      expect((await call('GET', '/partner-payouts')).body.partners).toEqual([]);
      expect(
        (await call('POST', `/partner-payouts/${id}/pay`, { reference: 'FT24109999' })).body,
      ).toEqual({ paid: 'Rs 0', nothingOwed: true });
      const log = (await call('GET', '/actions')).body.actions.map((each: Json) => each.action);
      expect(log).toContain('partner_payout.pay');
      expect(log).toContain('partner_app.list');
      expect(log).toContain('partner_theme.list');
      expect(log).toContain('expert.list');
    });
  },
);
