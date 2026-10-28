import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { StaffRole } from '@hatti/api';
import { FunctionRunner } from '@hatti/apps/public';
import { answering, echoing, spinning } from '@hatti/apps/testing';
import { base32Decode, totp } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { AppCheckoutFunctions } from './checkout-functions.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const PASSWORD = 'correct horse battery staple';
const FUNCTION = 'id handle title target enabled configuration bytes lastError appName';
const SET = `mutation ($input: AppFunctionInput!) {
  appFunctionSet(input: $input) { appFunction { ${FUNCTION} } userErrors { field message } } }`;
const ENABLE = `mutation ($id: ID!, $enabled: Boolean!, $configuration: String) {
  appFunctionEnable(id: $id, enabled: $enabled, configuration: $configuration) {
    appFunction { ${FUNCTION} } userErrors { field message } } }`;

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

const INPUT = {
  cart: {
    subtotal: 1_500_000,
    currency: 'PKR',
    lines: [
      {
        variantId: 'var_1',
        productId: 'prd_1',
        title: 'Kurta',
        variantTitle: 'M',
        sku: null,
        quantity: 3,
        price: 500_000,
      },
    ],
  },
  deliveryAddress: { city: 'Quetta', province: 'BA' },
  paymentMethods: ['cash_on_delivery', 'bank_transfer'],
};

describe.skipIf(!server)(
  "Apps' functions, given by apps and run at checkout (DEV-07, ADR-868)",
  () => {
    let testDb: TestDatabase;
    let admin: pg.Client;
    let api: TestApi;
    let database: Database;
    const runner = new FunctionRunner();
    const shop = newId();

    const post = (url: string, payload: object, token?: string) =>
      api.app.inject({
        method: 'POST',
        url,
        payload,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });

    async function account(role: StaffRole): Promise<string> {
      const body = (
        await post('/auth/sign-up', {
          email: `functions-${randomBytes(4).toString('hex')}@example.pk`,
          password: PASSWORD,
          name: 'Hina Akhtar',
        })
      ).json() as { accessToken: string; user: { id: string } };
      await admin.query(
        'INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, $3)',
        [fromPublicId(body.user.id, 'user'), shop, role],
      );
      const { secret } = (await post('/auth/two-step/totp/setup', {}, body.accessToken)).json() as {
        secret: string;
      };
      await post(
        '/auth/two-step/totp/confirm',
        { code: totp(base32Decode(secret), Date.now()) },
        body.accessToken,
      );
      return body.accessToken;
    }

    async function gql(token: string, query: string, variables?: object) {
      const response = await api.app.inject({
        method: 'POST',
        url: ADMIN_GRAPHQL_PATH,
        headers: token.startsWith('hat_')
          ? { 'x-hatti-access-token': token, 'idempotency-key': randomUUID() }
          : {
              authorization: `Bearer ${token}`,
              'x-hatti-shop-id': toPublicId('shop', shop),
              'idempotency-key': randomUUID(),
            },
        payload: { query, variables },
      });
      return response.json() as { data?: Record<string, Json> | null; errors?: Json[] };
    }

    async function data(token: string, query: string, variables?: object) {
      const body = await gql(token, query, variables);
      expect(body.errors).toBeUndefined();
      return Object.values(body.data ?? {})[0] as Json;
    }

    beforeAll(async () => {
      testDb = await createTestDatabase(server);
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
      await admin.query(
        `INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`,
        [shop],
      );
      // On Growth, which includes custom apps (ADR-523).
      await admin.query(
        `INSERT INTO billing.subscriptions (shop_id, plan, billing_interval, period_start, period_end)
         VALUES ($1, 'growth', 'monthly', now(), now() + interval '1 month')`,
        [shop],
      );
      api = await startTestApi(testDb);
      database = new Database({ appUrl: testDb.appUrl, applicationName: 'functions-test' });
    });

    afterAll(async () => {
      await runner.close();
      await database?.close();
      await api?.close();
      await admin?.end();
      await testDb?.drop();
    });

    it('runs the functions the shop turned on, with their settings, and keeps what failed', async () => {
      const owner = await account('owner');
      const made = await data(
        owner,
        `mutation ($input: CustomAppInput!) {
        customAppCreate(input: $input) { accessToken userErrors { message } } }`,
        { input: { name: 'COD guard', scopes: ['write_settings'] } },
      );
      const app = made.accessToken as string;
      const functions = new AppCheckoutFunctions(runner);
      const asked = (target: 'pay' | 'validate') =>
        database.tenant(shop, (tx) =>
          target === 'pay'
            ? functions.hiddenPaymentMethods(tx, shop, INPUT)
            : functions.validationErrors(tx, shop, INPUT),
        );

      // Staff can't give one; an app gives only modules that compile.
      expect((await gql(owner, SET, { input: {} })).errors).toBeDefined();
      const wrong = await data(app, SET, {
        input: {
          handle: 'cod-guard',
          title: 'COD guard',
          target: 'payment_customization',
          wasm: 'AAAA',
        },
      });
      expect(wrong.userErrors[0].field).toEqual(['input', 'wasm']);

      const hide = await data(app, SET, {
        input: {
          handle: 'cod-guard',
          title: 'Hide cash on delivery above Rs 10,000',
          target: 'payment_customization',
          wasm: base64(
            answering({ operations: [{ hide: { paymentMethod: 'cash_on_delivery' } }] }),
          ),
        },
      });
      expect(hide.appFunction).toMatchObject({
        enabled: false,
        appName: 'COD guard',
        lastError: null,
      });
      // Off until the shop turns it on: nothing hidden.
      expect(await asked('pay')).toEqual([]);
      const on = await data(owner, ENABLE, {
        id: hide.appFunction.id,
        enabled: true,
        configuration: '{"above":1000000}',
      });
      expect(on.appFunction).toMatchObject({ enabled: true, configuration: '{"above":1000000}' });
      expect(await asked('pay')).toEqual(['cash_on_delivery']);

      // A validation reads what checkout gives it, its settings with it.
      const echo = await data(app, SET, {
        input: {
          handle: 'echo',
          title: 'Echo',
          target: 'cart_validation',
          wasm: base64(echoing()),
        },
      });
      await data(owner, ENABLE, {
        id: echo.appFunction.id,
        enabled: true,
        configuration: '{"x":1}',
      });
      // Its answer, the input itself, is no validation's: nothing refused, its failure kept.
      expect(await asked('validate')).toEqual([]);
      const [kept] = (await data(owner, `{ appFunctions { ${FUNCTION} } }`)).filter(
        (each: Json) => each.handle === 'echo',
      );
      expect(kept.lastError).toBe('Its answer was not of the shape its target asks');

      const refuse = await data(app, SET, {
        input: {
          handle: 'echo',
          title: 'Quetta later',
          target: 'cart_validation',
          wasm: base64(
            answering({ errors: [{ message: 'We deliver to Quetta from next week.' }] }),
          ),
        },
      });
      // A new version runs as the old one did, its failure forgotten.
      expect(refuse.appFunction).toMatchObject({ enabled: true, lastError: null });
      expect(await asked('validate')).toEqual(['We deliver to Quetta from next week.']);

      // One that never ends is stopped: checkout goes on without it.
      await data(app, SET, {
        input: {
          handle: 'cod-guard',
          title: 'Stuck',
          target: 'payment_customization',
          wasm: base64(spinning()),
        },
      });
      expect(await asked('pay')).toEqual([]);
      const [stuck] = (await data(owner, `{ appFunctions { ${FUNCTION} } }`)).filter(
        (each: Json) => each.handle === 'cod-guard',
      );
      expect(stuck.lastError).toBe('It ran past 50 ms');
    });
  },
);
