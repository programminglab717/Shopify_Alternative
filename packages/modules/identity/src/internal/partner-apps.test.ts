import { randomBytes, randomInt } from 'node:crypto';
import { SecretBox } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId } from '@hatti/ids';
import { RateLimiter } from '@hatti/ratelimit';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthError } from './errors.js';
import { IdentityService, type ClientInfo } from './identity.service.js';
import { PARTNER_APP_LIMITS, PartnerAppsService } from './partner-apps.service.js';

const server = testDatabaseServer();
const redisUrl = process.env.REDIS_URL;
const PASSWORD = 'correct horse battery staple';
const PASSKEYS = { rpId: 'localhost', rpName: 'Hatti', origins: ['http://localhost:4000'] };
const REDIRECT = 'https://app.example.pk/callback';
const client = (): ClientInfo => ({ ip: `203.0.113.${randomInt(1, 255)}`, userAgent: 'vitest' });

async function authError(promise: Promise<unknown>): Promise<AuthError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AuthError) return error;
    throw error;
  }
  throw new Error('Expected an AuthError');
}

describe.skipIf(!server || !redisUrl)('Public apps of partners (DEV-05, ADR-851)', () => {
  let testDb: TestDatabase;
  let identityDb: Database;
  let admin: pg.Client;
  let redis: Redis;
  let identity: IdentityService;
  let apps: PartnerAppsService;
  let clock = new Date('2026-10-28T09:00:00Z');
  const prefix = `test-partner-apps-${randomBytes(4).toString('hex')}`;

  const signUp = async () =>
    identity.signUp(
      {
        email: `apps-${randomBytes(4).toString('hex')}@example.pk`,
        password: PASSWORD,
        name: 'Ayesha Khan',
      },
      client(),
    );
  /** A partner with a development store of theirs, which they own. */
  async function partner() {
    const { userId } = await signUp();
    const shopId = newId();
    await admin.query(
      `INSERT INTO identity.partners (user_id, business_name, referral_code)
       VALUES ($1, 'Kite Apps', $2)`,
      [userId, randomBytes(4).toString('hex')],
    );
    await admin.query(
      `INSERT INTO control.shops (id, name, handle, development) VALUES ($1, 'Sandbox', $2, true)`,
      [shopId, `sandbox-${randomBytes(3).toString('hex')}`],
    );
    await admin.query(
      `INSERT INTO identity.partner_stores (shop_id, partner_id, kind) VALUES ($1, $2, 'development')`,
      [shopId, userId],
    );
    await admin.query(
      `INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, 'owner')`,
      [userId, shopId],
    );
    return { userId, shopId, auth: { userId, mfaVerified: true, authenticatedAt: clock } };
  }
  const input = {
    name: 'Kite Reviews',
    appUrl: 'https://app.example.pk',
    redirectUrls: [REDIRECT],
    scopes: ['read_products', 'write_orders'],
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    identityDb = new Database({ appUrl: testDb.identityUrl, applicationName: 'partner-apps-test' });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    redis = new Redis(redisUrl!);
    identity = new IdentityService({
      db: identityDb.app,
      secretBox: new SecretBox([{ id: 'test', key: Buffer.alloc(32, 7) }]),
      rateLimiter: new RateLimiter(redis, prefix),
      passkeys: PASSKEYS,
    });
    apps = new PartnerAppsService({ db: identityDb.app, now: () => clock });
  });

  afterAll(async () => {
    const keys = redis ? await redis.keys(`${prefix}:*`) : [];
    if (keys.length > 0) await redis.del(...keys);
    redis?.disconnect();
    await identityDb?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('is registered by partners alone, checked, and changed keeping its client ID', async () => {
    const stranger = await signUp();
    expect((await authError(apps.create(stranger, input))).code).toBe('NOT_PARTNER');
    const { userId } = await partner();
    const refusals = await Promise.all(
      [
        { ...input, name: ' ' },
        { ...input, appUrl: 'http://app.example.pk' },
        { ...input, redirectUrls: [] },
        { ...input, redirectUrls: ['https://app.example.pk/cb#fragment'] },
        { ...input, scopes: ['read_everything'] },
        { ...input, scopes: [] },
      ].map((bad) => authError(apps.create({ userId }, bad))),
    );
    expect(refusals.map((error) => error.code)).toEqual(Array(6).fill('INVALID_INPUT'));

    const made = await apps.create(
      { userId },
      { ...input, scopes: ['WRITE_ORDERS', 'read_products'] },
    );
    expect(made.app).toMatchObject({ scopes: ['read_products', 'write_orders'], listed: false });
    const changed = await apps.update({ userId }, newIdOf(made.app.id), {
      ...input,
      name: 'Kite Reviews Plus',
    });
    expect(changed).toMatchObject({ name: 'Kite Reviews Plus', clientId: made.app.clientId });
    expect(await apps.apps({ userId })).toEqual([changed]);
    expect((await authError(apps.update(stranger, newIdOf(made.app.id), input))).code).toBe(
      'NOT_PARTNER',
    );

    for (let i = 1; i < PARTNER_APP_LIMITS.apps; i += 1) await apps.create({ userId }, input);
    expect((await authError(apps.create({ userId }, input))).code).toBe('TOO_MANY_APPS');
  });

  it('is approved with a second factor, lately proved, and its code traded once in time', async () => {
    const { userId, shopId, auth } = await partner();
    const { app, clientSecret } = await apps.create({ userId }, input);
    const asked = {
      clientId: app.clientId,
      redirectUri: REDIRECT,
      scope: 'read_products',
      state: 'xyz',
      shopId,
    };
    expect((await authError(apps.authorize({ ...auth, mfaVerified: false }, asked))).code).toBe(
      'MFA_REQUIRED',
    );
    expect(
      (
        await authError(
          apps.authorize(
            { ...auth, authenticatedAt: new Date(clock.getTime() - 16 * 60_000) },
            asked,
          ),
        )
      ).code,
    ).toBe('REAUTHENTICATION_REQUIRED');
    expect((await authError(apps.authorize(auth, { ...asked, scope: 'write_themes' }))).code).toBe(
      'INVALID_INPUT',
    );

    const code = (url: string) => new URL(url).searchParams.get('code')!;
    const late = code(await apps.authorize(auth, asked));
    const onTime = code(await apps.authorize(auth, asked));
    const wrongSecret = await authError(
      apps.redeem({ clientId: app.clientId, clientSecret: 'hcs_nope', code: onTime }),
    );
    expect(wrongSecret.code).toBe('INVALID_GRANT');
    expect(await apps.redeem({ clientId: app.clientId, clientSecret, code: onTime })).toEqual({
      shopId,
      scopes: ['read_products'],
      app: { id: newIdOf(app.id), name: 'Kite Reviews' },
    });
    expect(
      (await authError(apps.redeem({ clientId: app.clientId, clientSecret, code: onTime }))).code,
    ).toBe('INVALID_GRANT');
    clock = new Date(clock.getTime() + PARTNER_APP_LIMITS.codeMs);
    expect(
      (await authError(apps.redeem({ clientId: app.clientId, clientSecret, code: late }))).code,
    ).toBe('INVALID_GRANT');
  });

  it("is listed by Hatti's review for every shop, and taken back", async () => {
    const { userId } = await partner();
    const { app } = await apps.create({ userId }, { ...input, name: 'Waiting app' });
    expect((await apps.all()).find((each) => each.clientId === app.clientId)).toMatchObject({
      listed: false,
      partner: 'Kite Apps',
    });
    expect(await apps.review(app.clientId, true)).toMatchObject({ listed: true });
    expect(await apps.review(app.clientId, false)).toMatchObject({ listed: false });
    expect(await apps.review('hca_unknown', true)).toBeNull();
  });
});

/** The UUID behind an app's public ID, as the service's routes take it. */
function newIdOf(publicId: string): string {
  return fromPublicId(publicId, 'partnerApp');
}
