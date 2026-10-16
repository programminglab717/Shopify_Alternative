import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { type StaffRole, type TenantContext } from '@hatti/api';
import { base32Decode, totp } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import { MessagesService, MessagingSettingsService } from '@hatti/messaging/public';
import { VerificationsService } from '@hatti/trust/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { approveVerification, refuseVerification, revokeVerification } from '../verifications.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();
const PASSWORD = 'correct horse battery staple';

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const STATUS = `{ shopVerification {
  level requests { id level name cnicLast4 ntn status answer }
} }`;
const SUBMIT = `mutation Submit($input: ShopVerificationInput!) {
  shopVerificationSubmit(input: $input) {
    request { id level name cnicLast4 status } userErrors { field code message }
  }
}`;

/** A PNG's signature, then `size` bytes in all. */
const png = (size: number) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(size - 8, 1),
  ]);

describe.skipIf(!server)('Admin GraphQL API: shops verified by Hatti (ONB-11, ADR-465)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let database: Database;
  const shop = newId();

  const post = (url: string, payload: unknown, token?: string) =>
    api.app.inject({
      method: 'POST',
      url,
      payload: payload as Record<string, unknown>,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  /** A member of the shop's staff in `role`, signed in, with a second factor where it needs one. */
  async function member(role: StaffRole): Promise<string> {
    const email = `verify-${randomBytes(4).toString('hex')}@example.pk`;
    const signedUp = await post('/auth/sign-up', { email, password: PASSWORD, name: 'Sana Ahmed' });
    expect(signedUp.statusCode).toBe(201);
    const body = signedUp.json() as { accessToken: string; user: { id: string } };
    await admin.query(
      'INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, $3)',
      [fromPublicId(body.user.id, 'user'), shop, role],
    );
    if (role === 'owner' || role === 'manager') {
      const setup = await post('/auth/two-step/totp/setup', {}, body.accessToken);
      const { secret } = setup.json() as { secret: string };
      const code = totp(base32Decode(secret), Date.now());
      expect(
        (await post('/auth/two-step/totp/confirm', { code }, body.accessToken)).statusCode,
      ).toBe(200);
    }
    return body.accessToken;
  }

  async function gql(token: string, query: string, variables?: Record<string, unknown>) {
    const response = await api.app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: {
        authorization: `Bearer ${token}`,
        'x-hatti-shop-id': toPublicId('shop', shop),
        'idempotency-key': randomUUID(),
      },
      payload: { query, variables },
    });
    return response.json() as { data?: Record<string, Json> | null; errors?: Json[] };
  }

  /** An upload staged through the API, and put where it was staged: its resource URL. */
  async function staged(token: string): Promise<string> {
    const body = await gql(
      token,
      `mutation { stagedUploadsCreate(input: [{
        filename: "cnic.png", mimeType: "image/png", fileSize: "64"
      }]) { stagedTargets { resourceUrl } userErrors { message } } }`,
    );
    const url = body.data!.stagedUploadsCreate.stagedTargets[0].resourceUrl as string;
    await api.storage.put(api.storage.keyOf(url)!, png(64), 'image/png');
    return url;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    api = await startTestApi(testDb);
    database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'verifications-e2e',
    });
  });

  afterAll(async () => {
    await database?.close();
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("takes the owner's request with its photos, and tells the shop of Hatti's decisions", async () => {
    const owner = await member('owner');
    const manager = await member('manager');
    const marketer = await member('marketer');
    expect((await gql(manager, STATUS)).data!.shopVerification).toEqual({
      level: null,
      requests: [],
    });
    expect((await gql(marketer, STATUS)).errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');

    const input = {
      level: 'IDENTITY',
      name: 'Sana Ahmed',
      cnic: '35202-1234567-1',
      documents: [await staged(owner), await staged(owner)],
    };
    // The owner's alone.
    expect((await gql(manager, SUBMIT, { input })).errors?.[0]?.extensions?.code).toBe(
      'ACCESS_DENIED',
    );
    const asked = (await gql(owner, SUBMIT, { input })).data!.shopVerificationSubmit;
    expect(asked).toEqual({
      request: {
        id: expect.stringMatching(/^vrf_/),
        level: 'IDENTITY',
        name: 'Sana Ahmed',
        cnicLast4: '5671',
        status: 'WAITING',
      },
      userErrors: [],
    });
    expect(
      (await gql(owner, SUBMIT, { input: { ...input, documents: [await staged(owner)] } })).data!
        .shopVerificationSubmit.userErrors,
    ).toEqual([
      { field: ['input', 'level'], code: 'TAKEN', message: 'A request waits for Hatti already' },
    ]);

    // Hatti's people decide; the shop hears of each at its alerts number.
    const tenant: TenantContext = {
      shopId: shop,
      currency: 'PKR',
      actor: { kind: 'app', tokenId: newId() },
      scopes: new Set(['write_settings']),
    };
    expect(
      (await new MessagingSettingsService(database).update(tenant, { alertsPhone: '0333 5550009' }))
        .ok,
    ).toBe(true);
    const verifications = new VerificationsService(database, api.storage);
    const messages = new MessagesService(database);
    const told = async () =>
      (
        await admin.query<{ kind: string; recipient: string; variables: Record<string, string> }>(
          `SELECT kind, recipient, variables FROM messaging.messages
            WHERE shop_id = $1 AND kind LIKE 'shop_verif%' ORDER BY created_at, id`,
          [shop],
        )
      ).rows;
    const id = fromPublicId(asked.request.id, 'verification')!;
    expect(
      await approveVerification(database, verifications, messages, id, { by: 'Ayesha' }),
    ).toMatchObject({ status: 'approved', shopName: 'Zari' });
    expect((await gql(manager, STATUS)).data!.shopVerification.level).toBe('IDENTITY');

    const business = (
      await gql(owner, SUBMIT, {
        input: {
          level: 'BUSINESS',
          name: 'Zari Pvt Ltd',
          ntn: '1234567-8',
          documents: [await staged(owner)],
        },
      })
    ).data!.shopVerificationSubmit.request;
    await refuseVerification(
      database,
      verifications,
      messages,
      fromPublicId(business.id, 'verification')!,
      { by: 'Ayesha', answer: 'the certificate is blurred' },
    );
    expect(
      await revokeVerification(database, verifications, messages, shop, 'identity', {
        by: 'Ayesha',
        answer: 'the CNIC was not the owner’s',
      }),
    ).toHaveLength(1);
    expect((await gql(owner, STATUS)).data!.shopVerification).toEqual({
      level: null,
      requests: [
        {
          id: business.id,
          level: 'BUSINESS',
          name: 'Zari Pvt Ltd',
          cnicLast4: null,
          ntn: '1234567-8',
          status: 'REFUSED',
          answer: 'the certificate is blurred',
        },
        {
          id: asked.request.id,
          level: 'IDENTITY',
          name: 'Sana Ahmed',
          cnicLast4: '5671',
          ntn: null,
          status: 'REVOKED',
          answer: 'the CNIC was not the owner’s',
        },
      ],
    });
    expect(await told()).toEqual([
      { kind: 'shop_verified', recipient: '+923335550009', variables: { shop: 'Zari' } },
      {
        kind: 'shop_verification_refused',
        recipient: '+923335550009',
        variables: { shop: 'Zari', note: 'the certificate is blurred' },
      },
      {
        kind: 'shop_verification_revoked',
        recipient: '+923335550009',
        variables: { shop: 'Zari', note: 'the CNIC was not the owner’s' },
      },
    ]);
  });
});
