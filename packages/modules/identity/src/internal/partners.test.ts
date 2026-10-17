import { randomBytes, randomInt } from 'node:crypto';
import { SecretBox, base32Decode, totp } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId } from '@hatti/ids';
import { RateLimiter } from '@hatti/ratelimit';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthError } from './errors.js';
import { IdentityService, type ClientInfo } from './identity.service.js';
import { PartnersService } from './partners.service.js';
import { StaffService } from './staff.service.js';

const server = testDatabaseServer();
const redisUrl = process.env.REDIS_URL;
const PASSWORD = 'correct horse battery staple';
const PASSKEYS = { rpId: 'localhost', rpName: 'Hatti', origins: ['http://localhost:4000'] };
const client = (): ClientInfo => ({ ip: `203.0.113.${randomInt(1, 255)}`, userAgent: 'vitest' });
const uniqueEmail = () => `partner-${randomBytes(4).toString('hex')}@example.pk`;

async function authError(promise: Promise<unknown>): Promise<AuthError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AuthError) return error;
    throw error;
  }
  throw new Error('Expected an AuthError');
}

describe.skipIf(!server || !redisUrl)("Hatti's partners (PRT-01, ADR-504)", () => {
  let testDb: TestDatabase;
  let identityDb: Database;
  let admin: pg.Client;
  let redis: Redis;
  let identity: IdentityService;
  let partners: PartnersService;
  let staff: StaffService;
  const prefix = `test-partners-${randomBytes(4).toString('hex')}`;

  const signUp = async () =>
    identity.signUp({ email: uniqueEmail(), password: PASSWORD, name: 'Bilal Ahmed' }, client());
  const shopOf = async (shopId: string) =>
    (
      await admin.query<{ development: boolean; handle: string }>(
        'SELECT development, handle FROM control.shops WHERE id = $1',
        [shopId],
      )
    ).rows[0];

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    identityDb = new Database({ appUrl: testDb.identityUrl, applicationName: 'partners-test' });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    redis = new Redis(redisUrl!);
    const options = { db: identityDb.app };
    identity = new IdentityService({
      ...options,
      secretBox: new SecretBox([{ id: 'test', key: Buffer.alloc(32, 7) }]),
      rateLimiter: new RateLimiter(redis, prefix),
      passkeys: PASSKEYS,
    });
    partners = new PartnersService(options);
    staff = new StaffService(options);
  });

  afterAll(async () => {
    const keys = redis ? await redis.keys(`${prefix}:*`) : [];
    if (keys.length > 0) await redis.del(...keys);
    redis?.disconnect();
    await identityDb?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('joins with a business name and a referral code, and changes its details keeping the code', async () => {
    const agency = await signUp();
    expect(await partners.profile(agency)).toBeNull();
    // Nothing of a partner's until they join.
    expect((await authError(partners.stores(agency))).code).toBe('NOT_PARTNER');
    const refused = await authError(
      partners.join(agency, { businessName: '  ', website: 'http://pixel.pk' }),
    );
    expect(refused.details.fields).toEqual({
      businessName: 'Name your business, in 120 characters or fewer',
      website: 'Give its address, starting https://',
    });

    const joined = await partners.join(agency, { businessName: ' Pixel Media ' });
    expect(joined).toMatchObject({ businessName: 'Pixel Media', website: null });
    expect(joined.referralCode).toMatch(/^[a-z2-9]{8}$/);
    const changed = await partners.join(agency, {
      businessName: 'Pixel Media Lahore',
      website: 'https://pixel.pk',
    });
    expect(changed).toEqual({
      ...joined,
      businessName: 'Pixel Media Lahore',
      website: 'https://pixel.pk',
    });
    expect(await partners.profile(agency)).toEqual(changed);
    expect(await partners.stores(agency)).toEqual([]);
  });

  it('opens development stores, closed until each is handed to its client, and lists its stores', async () => {
    const agency = await signUp();
    expect(
      (await authError(partners.openDevelopmentStore(agency, { name: 'Zari Lawn' }))).code,
    ).toBe('NOT_PARTNER');
    await partners.join(agency, { businessName: 'Pixel Media' });

    const opened = await partners.openDevelopmentStore(agency, { name: 'Zari Lawn' });
    expect(opened).toMatchObject({ name: 'Zari Lawn', handle: 'zari-lawn', role: 'owner' });
    const shopId = fromPublicId(opened.id, 'shop')!;
    expect(await shopOf(shopId)).toEqual({ development: true, handle: 'zari-lawn' });
    // Its storefront is published as any new shop's.
    const events = await admin.query<{ event_type: string }>(
      'SELECT event_type FROM platform.outbox_events WHERE shop_id = $1 ORDER BY id',
      [shopId],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual(['shop.opened']);
    expect(
      (await authError(partners.openDevelopmentStore(agency, { name: 'X', handle: 'zari-lawn' })))
        .code,
    ).toBe('HANDLE_TAKEN');

    // A client's shop the agency was let into, and one of its own, which is not a client's.
    const clientShop = await signUp();
    const theirs = await identity.openShop(
      await identity.authenticate(clientShop.tokens.accessToken),
      { name: 'Gota Kinari' },
      client(),
    );
    const own = await identity.openShop(
      await identity.authenticate(agency.tokens.accessToken),
      { name: 'Pixel Prints' },
      client(),
    );
    await identity.grantMembership({
      userId: agency.userId,
      shopId: fromPublicId(theirs.id, 'shop')!,
      role: 'marketer',
    });
    expect(fromPublicId(own.id, 'shop')).not.toBeNull();
    const listed = await partners.stores(agency);
    expect(listed.map((store) => [store.name, store.kind, store.role])).toEqual([
      ['Gota Kinari', 'client', 'marketer'],
      ['Zari Lawn', 'development', 'owner'],
    ]);

    // Handed to its client, a manager with a second factor: open, and the agency a manager.
    const owner = await signUp();
    await identity.grantMembership({ userId: owner.userId, shopId, role: 'manager' });
    const session = await identity.authenticate(owner.tokens.accessToken);
    const { secret } = await identity.setUpTotp(session);
    await identity.confirmTotp(session, totp(base32Decode(secret), Date.now()), client());
    expect(await staff.transferOwnership(agency, shopId, owner.userId)).toMatchObject({
      ok: true,
    });
    expect(await shopOf(shopId)).toMatchObject({ development: false });
    const after = await admin.query<{ event_type: string }>(
      'SELECT event_type FROM platform.outbox_events WHERE shop_id = $1 ORDER BY id',
      [shopId],
    );
    expect(after.rows.map((row) => row.event_type)).toEqual([
      'shop.opened',
      'shop.development_store_transferred',
    ]);
    const zari = (await partners.stores(agency)).find((store) => store.name === 'Zari Lawn')!;
    expect(zari).toMatchObject({ kind: 'transferred', role: 'manager' });
    expect(zari.transferredAt).toBeInstanceOf(Date);
    // Handed on again by its new owner, it stays the agency's, transferred once.
    expect(
      (
        await admin.query('SELECT transferred_to FROM identity.partner_stores WHERE shop_id = $1', [
          shopId,
        ])
      ).rows,
    ).toEqual([{ transferred_to: owner.userId }]);
  });

  it('builds 20 development stores at once at most, none counted among the shops it owns', async () => {
    const agency = await signUp();
    await partners.join(agency, { businessName: 'Studio 92' });
    for (let at = 0; at < 20; at += 1) {
      await partners.openDevelopmentStore(agency, { name: `Client ${at}` });
    }
    expect(
      (await authError(partners.openDevelopmentStore(agency, { name: 'One more' }))).message,
    ).toBe('A partner builds 20 development stores at once at most: hand one over first');
    // Its own shops are counted apart.
    expect(
      (
        await identity.openShop(
          await identity.authenticate(agency.tokens.accessToken),
          { name: 'Studio Store' },
          client(),
        )
      ).role,
    ).toBe('owner');
  });
});
