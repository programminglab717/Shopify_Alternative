import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateAccessToken, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId } from '@hatti/ids';
import {
  MessagesService,
  MessagingSettingsService,
  SmsGatewayProvider,
  SmsSendersService,
} from '@hatti/messaging/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveSmsSender, refuseSmsSender, revokeSmsSender } from '../sms-senders.js';
import { startTestApi, type TestApi } from '../testing/api.js';
import { MessagesSender } from '../worker/notifications.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const STATUS = '{ smsSender { name requests { id name status answer } } }';
const REQUEST = `mutation Request($name: String!) {
  smsSenderRequest(name: $name) {
    request { id name status } userErrors { field code message }
  }
}`;
const WITHDRAW =
  'mutation { smsSenderWithdraw { request { name status } userErrors { message } } }';

describe.skipIf(!server)(
  "Admin GraphQL API: a shop's own SMS sender name (MKT-02, ADR-469)",
  () => {
    let testDb: TestDatabase;
    let admin: pg.Client;
    let api: TestApi;
    let database: Database;
    let gateway: Server;
    let gatewayUrl: string;
    /** What the SMS gateway was asked to send. */
    const texts: { to: string; sender: string }[] = [];
    const shop = newId();
    let token = '';
    let reader = '';

    async function issueToken(scopes: string[]): Promise<string> {
      const { token: issued, hash, hint } = generateAccessToken();
      await admin.query(
        `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
        [shop, hash, hint, scopes],
      );
      return issued;
    }

    async function gql(as: string, query: string, variables?: Record<string, unknown>) {
      const response = await api.app.inject({
        method: 'POST',
        url: ADMIN_GRAPHQL_PATH,
        headers: { 'x-hatti-access-token': as, 'idempotency-key': randomUUID() },
        payload: { query, variables },
      });
      return response.json<{ data?: Json; errors?: Json[] }>();
    }

    beforeAll(async () => {
      testDb = await createTestDatabase(server);
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
      await admin.query(
        `INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`,
        [shop],
      );
      api = await startTestApi(testDb);
      database = new Database({
        appUrl: testDb.appUrl,
        systemUrl: testDb.systemUrl,
        applicationName: 'sms-senders-e2e',
      });
      token = await issueToken(['read_settings', 'write_settings']);
      reader = await issueToken(['read_settings']);
      gateway = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk: Buffer) => (body += chunk.toString()));
        request.on('end', () => {
          texts.push(JSON.parse(body) as { to: string; sender: string });
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ id: `sms-${texts.length}` }));
        });
      });
      await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
      gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/sms`;
    });

    afterAll(async () => {
      await new Promise((resolve) => gateway?.close(resolve));
      await database?.close();
      await api?.close();
      await admin?.end();
      await testDb?.drop();
    });

    it("takes the shop's request, approved for a verified shop, its customers' SMS sent from the name", async () => {
      expect((await gql(reader, STATUS)).data.smsSender).toEqual({ name: null, requests: [] });
      expect((await gql(reader, REQUEST, { name: 'ZARI' })).errors?.[0]?.extensions?.code).toBe(
        'ACCESS_DENIED',
      );
      expect(
        (await gql(token, REQUEST, { name: 'Zari!' })).data.smsSenderRequest.userErrors,
      ).toEqual([
        {
          field: ['name'],
          code: 'INVALID',
          message: 'Give 3 to 11 letters and digits, a letter among them, like ZARI',
        },
      ]);
      // Asked, withdrawn, and asked again.
      await gql(token, REQUEST, { name: 'Zari PK' });
      expect((await gql(token, WITHDRAW)).data.smsSenderWithdraw.request).toEqual({
        name: 'Zari PK',
        status: 'WITHDRAWN',
      });
      const asked = (await gql(token, REQUEST, { name: ' ZARI ' })).data.smsSenderRequest;
      expect(asked).toEqual({
        request: { id: expect.stringMatching(/^snd_/), name: 'ZARI', status: 'WAITING' },
        userErrors: [],
      });

      // The shop hears of Hatti's people's decisions at its alerts number.
      const tenant: TenantContext = {
        shopId: shop,
        currency: 'PKR',
        actor: { kind: 'app', tokenId: newId() },
        scopes: new Set(['write_settings']),
      };
      expect(
        (
          await new MessagingSettingsService(database).update(tenant, {
            alertsPhone: '0333 5550009',
          })
        ).ok,
      ).toBe(true);
      const senders = new SmsSendersService(database);
      const messages = new MessagesService(database);
      const told = async () =>
        (
          await admin.query<{ kind: string; recipient: string; variables: Record<string, string> }>(
            `SELECT kind, recipient, variables FROM messaging.messages
            WHERE shop_id = $1 AND kind LIKE 'sms_sender%' AND channel = 'whatsapp'
            ORDER BY created_at, id`,
            [shop],
          )
        ).rows;
      const id = fromPublicId(asked.request.id, 'smsSender')!;
      // Operators register a name for a business Hatti has verified.
      expect(await approveSmsSender(database, senders, messages, id, { by: 'Ayesha' })).toBe(
        'not_verified',
      );
      await admin.query(
        `INSERT INTO trust.verifications
         (shop_id, level, name, cnic_last4, status, asked_by, decided_at, decided_by)
       VALUES ($1, 'identity', 'Sana Ahmed', '5671', 'approved', $2, now(), 'Ayesha')`,
        [shop, newId()],
      );
      expect(
        await approveSmsSender(database, senders, messages, id, { by: 'Ayesha' }),
      ).toMatchObject({ name: 'ZARI', status: 'approved', shopName: 'Zari' });
      expect((await gql(reader, STATUS)).data.smsSender).toMatchObject({
        name: 'ZARI',
        requests: [
          { name: 'ZARI', status: 'APPROVED' },
          { name: 'Zari PK', status: 'WITHDRAWN' },
        ],
      });
      expect(await told()).toEqual([
        {
          kind: 'sms_sender_approved',
          recipient: '+923335550009',
          variables: expect.objectContaining({ shop: 'Zari', sender: 'ZARI' }),
        },
      ]);

      // A customer's SMS goes from the shop's name; the shop's own alert from Hatti's.
      await messages.queue(shop, {
        kind: 'order_placed',
        channel: 'sms',
        recipient: '+923001110001',
        dedupeKey: 'placed:1',
        variables: { shop: 'Zari', order: '#1001', total: 'Rs 5,250' },
      });
      await messages.queue(shop, {
        kind: 'stock_low',
        channel: 'sms',
        recipient: '+923335550009',
        dedupeKey: 'low:1',
        variables: { shop: 'Zari', product: 'Lawn suit', stock: '3' },
      });
      const sms = new SmsGatewayProvider({ url: gatewayUrl, apiKey: 'key', sender: 'Hatti' });
      const sending = new MessagesSender({
        messages,
        providers: { sms },
        smsSenders: (shopId) => senders.senderOf(shopId),
      });
      await sending.send(shop, new Date());
      expect(texts.map(({ to, sender }) => [to, sender]).sort()).toEqual([
        ['+923001110001', 'ZARI'],
        ['+923335550009', 'Hatti'],
      ]);

      // A second name is refused with why; the first stays. Then it is taken back.
      const second = (await gql(token, REQUEST, { name: 'Zari Lawn' })).data.smsSenderRequest;
      await refuseSmsSender(
        database,
        senders,
        messages,
        fromPublicId(second.request.id, 'smsSender')!,
        { by: 'Ayesha', answer: 'Jazz refused it' },
      );
      expect((await gql(reader, STATUS)).data.smsSender.name).toBe('ZARI');
      expect(
        await revokeSmsSender(database, senders, messages, 'zari', {
          by: 'Ayesha',
          answer: 'Complaints of spam',
        }),
      ).toMatchObject({ name: 'ZARI', status: 'revoked' });
      expect((await gql(reader, STATUS)).data.smsSender.name).toBeNull();
      expect((await told()).map((each) => [each.kind, each.variables.note ?? null])).toEqual([
        ['sms_sender_approved', null],
        ['sms_sender_refused', 'Jazz refused it'],
        ['sms_sender_revoked', 'Complaints of spam'],
      ]);
    });
  },
);
