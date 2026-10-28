import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

describe.skipIf(!server)('Experts shops hire, over /auth (PRT-03)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  const shop = newId();

  const send = (method: 'GET' | 'POST', url: string, token: string, payload?: unknown) =>
    api.app.inject({
      method,
      url,
      ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
      headers: { authorization: `Bearer ${token}` },
    });

  async function account(): Promise<{ token: string; userId: string }> {
    const signedUp = await api.app.inject({
      method: 'POST',
      url: '/auth/sign-up',
      payload: {
        email: `experts-${randomBytes(4).toString('hex')}@example.pk`,
        password: 'correct horse battery staple',
        name: 'Nida Raza',
      },
    });
    const body = signedUp.json() as { accessToken: string; user: { id: string } };
    return { token: body.accessToken, userId: fromPublicId(body.user.id, 'user') };
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`, [
      shop,
    ]);
    api = await startTestApi(testDb);
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('saves a profile, lists it once Hatti looks, and takes an enquiry for the expert', async () => {
    const expert = await account();
    await admin.query(
      `INSERT INTO identity.partners (user_id, business_name, referral_code)
       VALUES ($1, 'Lens Lahore', 'lens0001')`,
      [expert.userId],
    );
    const saved = await send('POST', '/auth/partner/expert', expert.token, {
      headline: 'Product photos for clothing brands',
      services: ['photography'],
      cities: ['Lahore'],
      languages: ['ur'],
      startingPrice: 15000,
    });
    expect(saved.statusCode).toBe(200);
    const { expert: profile } = saved.json() as Json;
    expect(profile).toMatchObject({
      businessName: 'Lens Lahore',
      startingPrice: 15000,
      listed: false,
    });
    expect(profile.id).toBe(toPublicId('expert', expert.userId));

    const owner = await account();
    await admin.query(
      `INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, 'owner')`,
      [owner.userId, shop],
    );
    expect((await send('GET', '/auth/experts', owner.token)).json()).toEqual({ experts: [] });
    await admin.query('UPDATE identity.expert_profiles SET listed_at = now()');
    const found = (
      await send('GET', '/auth/experts?service=photography&city=lahore', owner.token)
    ).json() as Json;
    expect(found.experts.map((each: Json) => each.businessName)).toEqual(['Lens Lahore']);
    expect((await send('GET', '/auth/experts?service=ads', owner.token)).json()).toEqual({
      experts: [],
    });

    const enquiry = await send('POST', `/auth/experts/${profile.id}/enquiries`, owner.token, {
      shopId: toPublicId('shop', shop),
      service: 'photography',
      message: 'Forty kurtas to shoot before Eid.',
    });
    expect(enquiry.statusCode).toBe(201);
    const again = await send('POST', `/auth/experts/${profile.id}/enquiries`, owner.token, {
      shopId: toPublicId('shop', shop),
      service: 'photography',
      message: 'And again.',
    });
    expect([again.statusCode, (again.json() as Json).error.code]).toEqual([429, 'RATE_LIMITED']);

    // The course, without its answers, scored by Hatti (PRT-04, ADR-858).
    const course = (await send('GET', '/auth/partner/certification', expert.token)).json() as Json;
    expect(course).toMatchObject({ certificate: null, triesLeft: 3 });
    expect(course.course.questions).toHaveLength(10);
    expect(JSON.stringify(course)).not.toContain('"answer"');
    const tried = await send('POST', '/auth/partner/certification', expert.token, {
      answers: Object.fromEntries(course.course.questions.map((each: Json) => [each.id, 9])),
    });
    expect(tried.json()).toEqual({
      score: 0,
      passed: false,
      wrong: course.course.questions.map((each: Json) => each.id),
      certificate: null,
    });

    const received = (await send('GET', '/auth/partner/enquiries', expert.token)).json() as Json;
    expect(received.enquiries).toEqual([
      expect.objectContaining({
        shop: { name: 'Zari', handle: 'zari' },
        sender: { name: 'Nida Raza', email: expect.stringMatching(/@example\.pk$/) },
        service: 'photography',
        message: 'Forty kurtas to shoot before Eid.',
      }),
    ]);
  });
});
