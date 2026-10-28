import { randomBytes } from 'node:crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountEmail } from './account-emails.js';
import { AuthError } from './errors.js';
import { ExpertsService } from './experts.service.js';

const server = testDatabaseServer();

async function authError(promise: Promise<unknown>): Promise<AuthError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AuthError) return error;
    throw error;
  }
  throw new Error('Expected an AuthError');
}

describe.skipIf(!server)('Experts shops hire (PRT-03, ADR-855)', () => {
  let testDb: TestDatabase;
  let identityDb: Database;
  let admin: pg.Client;
  let experts: ExpertsService;
  const sent: AccountEmail[] = [];
  const shop = newId();

  /** An account, verified, of `name`: its ID. */
  async function user(name: string, language = 'en'): Promise<string> {
    const id = newId();
    await admin.query(
      `INSERT INTO identity.users (id, name, email, email_verified_at, language)
       VALUES ($1, $2, $3, now(), $4)`,
      [id, name, `${randomBytes(4).toString('hex')}@example.pk`, language],
    );
    return id;
  }
  async function partner(name: string, business: string, language = 'en'): Promise<string> {
    const id = await user(name, language);
    await admin.query(
      `INSERT INTO identity.partners (user_id, business_name, referral_code) VALUES ($1, $2, $3)`,
      [id, business, randomBytes(4).toString('hex')],
    );
    return id;
  }
  const member = (userId: string, role: string) =>
    admin.query('INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, $3)', [
      userId,
      shop,
      role,
    ]);

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    identityDb = new Database({ appUrl: testDb.identityUrl, applicationName: 'experts-test' });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`, [
      shop,
    ]);
    experts = new ExpertsService({
      db: identityDb.app,
      emails: {
        adminUrl: 'https://admin.hatti.pk/',
        sender: {
          async send(email: AccountEmail): Promise<boolean> {
            sent.push(email);
            return true;
          },
        },
      },
    });
  });

  afterAll(async () => {
    await identityDb?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("keeps a partner's profile, checked, and shows it once Hatti lists it, as shops filter", async () => {
    const stranger = await user('Omar');
    expect(
      (
        await authError(
          experts.save(stranger, {
            headline: 'Shoots',
            services: ['photography'],
            languages: ['ur'],
          }),
        )
      ).code,
    ).toBe('NOT_PARTNER');
    const lens = await partner('Ayesha', 'Lens Lahore');
    const refusals = await Promise.all(
      [
        { headline: ' ', services: ['photography'], languages: ['ur'] },
        { headline: 'Shoots', services: ['juggling'], languages: ['ur'] },
        { headline: 'Shoots', services: ['photography'], languages: [] },
        { headline: 'Shoots', services: ['photography'], languages: ['ur'], startingPrice: 150n },
      ].map((input) => authError(experts.save(lens, input))),
    );
    expect(refusals.map((error) => error.code)).toEqual(Array(4).fill('INVALID_INPUT'));

    const saved = await experts.save(lens, {
      headline: 'Product photos for clothing brands',
      services: ['photography', 'content'],
      cities: [' Lahore ', 'Online', 'Lahore'],
      languages: ['ur', 'en'],
      startingPrice: 1_500_000n,
    });
    expect(saved).toMatchObject({
      businessName: 'Lens Lahore',
      services: ['photography', 'content'],
      cities: ['Lahore', 'Online'],
      languages: ['en', 'ur'],
      startingPrice: 1_500_000n,
      listed: false,
    });
    const ads = await partner('Bilal', 'Grow Ads');
    await experts.save(ads, {
      headline: 'Meta and TikTok ads',
      services: ['ads'],
      cities: ['Karachi'],
      languages: ['en'],
    });
    expect(await experts.directory()).toEqual([]);

    await experts.review(lens, true);
    await experts.review(ads, true);
    expect((await experts.directory()).map((each) => each.businessName).sort()).toEqual([
      'Grow Ads',
      'Lens Lahore',
    ]);
    expect(
      (await experts.directory({ service: 'photography' })).map((each) => each.businessName),
    ).toEqual(['Lens Lahore']);
    expect((await experts.directory({ city: 'karachi' })).map((each) => each.businessName)).toEqual(
      ['Grow Ads'],
    );
    expect(await experts.directory({ language: 'ur', service: 'ads' })).toEqual([]);
    // Taken back, it shows no more.
    await experts.review(ads, false);
    expect((await experts.directory()).map((each) => each.businessName)).toEqual(['Lens Lahore']);
  });

  it("takes owners' and managers' enquiries, a day's few, and emails them to the expert", async () => {
    const studio = await partner('Hira', 'Rang Studio', 'ur');
    await experts.save(studio, {
      headline: 'Stores set up',
      services: ['setup', 'migration'],
      languages: ['ur'],
    });
    await experts.review(studio, true);
    const owner = await user('Sana');
    await member(owner, 'owner');
    const packer = await user('Kamran');
    await member(packer, 'packer');
    const ask = (from: string, input: Partial<{ service: string; message: string }> = {}) =>
      experts.enquire(from, {
        partnerId: studio,
        shopId: shop,
        service: input.service ?? 'migration',
        message: input.message ?? 'We sell on Shopify and want to move 400 products.',
      });

    expect((await authError(ask(packer))).code).toBe('FORBIDDEN');
    expect((await authError(ask(owner, { service: 'ads' }))).code).toBe('INVALID_INPUT');
    expect((await authError(ask(owner, { message: '  ' }))).code).toBe('INVALID_INPUT');
    sent.length = 0;
    await ask(owner);
    // One a day to each expert.
    expect((await authError(ask(owner))).code).toBe('RATE_LIMITED');

    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe('Zari کی طرف سے دوسرے پلیٹ فارم سے منتقلی کے بارے میں پوچھا گیا');
    expect(sent[0]!.text).toContain('https://admin.hatti.pk/partners');

    expect(await experts.enquiries(studio)).toEqual([
      {
        id: expect.any(String),
        shop: { id: shop, name: 'Zari', handle: 'zari' },
        sender: { name: 'Sana', email: expect.stringMatching(/@example\.pk$/) },
        service: 'migration',
        message: 'We sell on Shopify and want to move 400 products.',
        createdAt: expect.any(Date),
      },
    ]);
    // An expert not listed takes none.
    await experts.review(studio, false);
    expect((await authError(ask(owner))).code).toBe('NOT_FOUND');
  });
});
