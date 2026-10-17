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
import { newId } from '@hatti/ids';
import { PartnersService, recordPartnerEarning } from './partners.service.js';
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
  let appDb: Database;
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
    appDb = new Database({ appUrl: testDb.appUrl, applicationName: 'partners-test-app' });
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
    await appDb?.close();
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

  it('earns 20% of each plan invoice a store it brought pays, until Hatti pays it out (PRT-02, ADR-505)', async () => {
    const agency = await signUp();
    const { referralCode } = await partners.join(agency, {
      businessName: 'Pixel Media',
      payoutTitle: 'Pixel Media (Pvt) Ltd',
      payoutIban: 'pk36 scbl 0000 0011 2345 6702',
    });
    expect(await partners.profile(agency)).toMatchObject({
      payout: { title: 'Pixel Media (Pvt) Ltd', iban: 'PK36SCBL0000001123456702' },
    });
    expect(
      (
        await authError(
          partners.join(agency, { businessName: 'Pixel Media', payoutIban: 'PK36 1234' }),
        )
      ).details.fields,
    ).toEqual({
      payoutIban: 'Give the IBAN as your bank prints it: PK, then 22 letters and digits',
      payoutTitle: 'Give the account title and its IBAN together',
    });

    // A merchant comes by its link; another types a code that is no one's, or the agency's own.
    const merchant = await signUp();
    const session = (account: { tokens: { accessToken: string } }) =>
      identity.authenticate(account.tokens.accessToken);
    const referred = await identity.openShop(
      await session(merchant),
      { name: 'Zari Lawn', referralCode: ` ${referralCode.toUpperCase()} ` },
      client(),
    );
    const stranger = await signUp();
    await identity.openShop(
      await session(stranger),
      { name: 'Gota', referralCode: 'nosuchco' },
      client(),
    );
    await identity.openShop(
      await session(agency),
      { name: 'Pixel Prints', referralCode },
      client(),
    );
    const shopId = fromPublicId(referred.id, 'shop')!;
    expect((await partners.stores(agency)).map((store) => [store.name, store.kind])).toEqual([
      ['Zari Lawn', 'referred'],
    ]);

    // Its plan paid twice, once again by the same invoice; a shop no partner brought earns none.
    const pay = (shop: string, id: string, amount: bigint, number = '1001') =>
      appDb.tenant(shop, (tx) =>
        recordPartnerEarning(tx, shop, { id, number, plan: 'growth', amount }),
      );
    const first = newId();
    expect(await pay(shopId, first, 299_900n)).toBe(59_980n);
    expect(await pay(shopId, first, 299_900n)).toBeNull();
    expect(await pay(shopId, newId(), 2_999_000n, '1002')).toBe(599_800n);
    const gota = fromPublicId(
      (await identity.openShop(await session(stranger), { name: 'Other' }, client())).id,
      'shop',
    )!;
    expect(await pay(gota, newId(), 299_900n)).toBeNull();
    // Only for the shop of the transaction asking.
    expect(
      await appDb.tenant(gota, (tx) =>
        recordPartnerEarning(tx, shopId, { id: newId(), number: '9', plan: 'pro', amount: 100n }),
      ),
    ).toBeNull();

    const earned = await partners.earnings(agency);
    expect([earned.earned, earned.paidOut, earned.owed]).toEqual([659_780n, 0n, 659_780n]);
    expect(
      earned.entries.map((entry) => [entry.shopName, entry.invoiceNumber, entry.amount]),
    ).toEqual([
      ['Zari Lawn', '1002', 599_800n],
      ['Zari Lawn', '1001', 59_980n],
    ]);
    expect(earned.entries[0]).toMatchObject({ sharePercent: 20, invoiceAmount: 2_999_000n });

    // Hatti's people see what is owed, pay it, and it is owed no more.
    expect((await partners.owed()).find((each) => each.userId === agency.userId)).toMatchObject({
      businessName: 'Pixel Media',
      payout: { iban: 'PK36SCBL0000001123456702' },
      owed: 659_780n,
      entries: 2,
    });
    expect(await partners.payOut(agency.userId, 'IBFT 20261017-88')).toBe(659_780n);
    expect(await partners.payOut(agency.userId, 'again')).toBe(0n);
    expect((await partners.owed()).some((each) => each.userId === agency.userId)).toBe(false);
    const after = await partners.earnings(agency);
    expect([after.paidOut, after.owed]).toEqual([659_780n, 0n]);
    expect(after.entries[0]).toMatchObject({ payoutReference: 'IBFT 20261017-88' });
  });
});
