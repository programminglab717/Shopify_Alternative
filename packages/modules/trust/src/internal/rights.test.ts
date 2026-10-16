import 'reflect-metadata';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RightsComplaintsService, type RightsComplaintInput } from './rights.service.js';

const server = testDatabaseServer();
const NOW = new Date('2026-10-16T08:00:00.000Z');

describe.skipIf(!server)('Rights complaints (TNS-04, ADR-474)', () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let rights: RightsComplaintsService;
  const zari = newId();
  const lawn = newId();
  const shawl = newId();

  const complaint = (changes: Partial<RightsComplaintInput> = {}): RightsComplaintInput => ({
    kind: 'counterfeit',
    rightsOwner: 'Gul Ahmed Textile Mills',
    registration: 'TM 123456',
    complainant: 'Sana Iqbal',
    actingAs: 'agent',
    email: 'legal@example.pk',
    phone: '0300 1234567',
    listings: [
      {
        id: lawn,
        title: 'Gul Ahmed lawn 3-pc (master copy)',
        url: 'https://zari.hatti.pk/products/lawn',
      },
      { id: shawl, title: 'Shawl', url: 'https://zari.hatti.pk/products/shawl' },
    ],
    details: 'Sold as Gul Ahmed lawn; Gul Ahmed never made or sold these. The label is a copy.',
    signature: 'Sana Iqbal',
    sworn: true,
    client: '203.0.113.9',
    language: 'en',
    ...changes,
  });

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'rights-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`, [
      zari,
    ]);
    rights = new RightsComplaintsService(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('takes a sworn complaint naming listings, due in 48 hours, and refuses one missing what it must say', async () => {
    const bad = await rights.complain(
      zari,
      complaint({
        kind: 'dislike',
        rightsOwner: ' ',
        actingAs: 'fan',
        email: 'nobody',
        phone: '123',
        listings: [{ id: 'lawn', title: 'Lawn', url: '/products/lawn' }],
        signature: '',
        sworn: false,
      }),
      NOW,
    );
    expect(bad.ok || bad.errors.map((error) => [error.field[0], error.code])).toEqual([
      ['kind', 'INVALID'],
      ['rightsOwner', 'BLANK'],
      ['actingAs', 'INVALID'],
      ['email', 'INVALID'],
      ['phone', 'INVALID'],
      ['listings', 'INVALID'],
      ['signature', 'BLANK'],
      ['sworn', 'INVALID'],
    ]);
    const blank = await rights.complain(zari, complaint({ email: '', listings: [] }), NOW);
    expect(blank.ok || blank.errors.map((error) => [error.field[0], error.code])).toEqual([
      ['email', 'BLANK'],
      ['listings', 'INVALID'],
    ]);

    const taken = await rights.complain(
      zari,
      complaint({ listings: [...complaint().listings, complaint().listings[0]!] }),
      NOW,
    );
    if (!taken.ok) throw new Error(JSON.stringify(taken.errors));
    const [open] = await rights.list();
    expect(open).toMatchObject({
      id: taken.value.id,
      shopName: 'Zari',
      shopHandle: 'zari',
      kind: 'counterfeit',
      rightsOwner: 'Gul Ahmed Textile Mills',
      registration: 'TM 123456',
      actingAs: 'agent',
      email: 'legal@example.pk',
      phone: '+923001234567',
      status: 'open',
      swornAt: NOW,
      dueAt: new Date(NOW.getTime() + 48 * 3_600_000),
    });
    // Each listing once, as the store showed it.
    expect(open!.listings.map((listing) => listing.id)).toEqual([lawn, shawl]);

    // Five a day of one store from one address.
    for (let i = 0; i < 4; i++)
      expect((await rights.complain(zari, complaint(), NOW)).ok).toBe(true);
    const sixth = await rights.complain(zari, complaint(), NOW);
    expect(sixth.ok || sixth.errors[0]!.message).toMatch(/enough complaints today/);
    expect((await rights.complain(zari, complaint({ client: '198.51.100.7' }), NOW)).ok).toBe(true);
    expect((await rights.complain(newId(), complaint(), NOW)).ok).toBe(false);
  });

  it('decides a complaint once, with who and why', async () => {
    const taken = await rights.complain(zari, complaint({ client: null }), NOW);
    if (!taken.ok) throw new Error('not taken');
    const decided = await rights.decide(taken.value.id, {
      status: 'dismissed',
      by: 'Ayesha',
      note: 'The shop sells its own label, not Gul Ahmed',
    });
    expect(decided).toMatchObject({ status: 'dismissed', decidedBy: 'Ayesha' });
    expect(
      await rights.decide(taken.value.id, { status: 'upheld', by: 'Ayesha', note: 'again' }),
    ).toBe('decided');
    expect(await rights.decide(newId(), { status: 'upheld', by: 'A', note: 'n' })).toBe(
      'not_found',
    );
    expect((await rights.list()).some((each) => each.id === taken.value.id)).toBe(false);
    expect((await rights.get(taken.value.id))?.decision).toMatch(/own label/);
  });
});
