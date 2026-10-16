import 'reflect-metadata';
import type { MutationResult, TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmsSendersService, smsSenderName } from './sms-senders.service.js';

const server = testDatabaseServer();

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(`Expected success, got ${JSON.stringify(result.errors)}`);
  return result.value;
}

function tenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_settings']),
  };
}

describe("Shops' own SMS sender names (MKT-02, ADR-469)", () => {
  it('takes 3 to 11 letters, digits and single spaces, a letter among them', () => {
    expect(smsSenderName('  Zari   Lawn ')).toBe('Zari Lawn');
    expect(smsSenderName('ZARI')).toBe('ZARI');
    expect(smsSenderName('PK')).toBeNull();
    expect(smsSenderName('ZariLawnPK12')).toBeNull();
    expect(smsSenderName('03001234567')).toBeNull();
    expect(smsSenderName('Zari!')).toBeNull();
  });
});

describe.skipIf(!server)("Shops' own SMS sender names, kept (MKT-02, ADR-469)", () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let senders: SmsSendersService;
  const a = tenant(newId());
  const b = tenant(newId());

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'sms-senders-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari'), ($2, 'Gul', 'gul')`,
      [a.shopId, b.shopId],
    );
    senders = new SmsSendersService(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('asks, one request at a time, approves it, replaces it with another, and takes it back', async () => {
    const blank = await senders.request(a, { name: ' ' }, newId());
    expect(blank.ok ? null : blank.errors[0]!.code).toBe('BLANK');
    const asker = newId();
    const first = unwrap(await senders.request(a, { name: 'zari  pk' }, asker));
    expect(first).toMatchObject({ name: 'zari pk', status: 'waiting', askedBy: asker });
    const again = await senders.request(a, { name: 'ZARI' }, asker);
    expect(again.ok ? null : again.errors[0]!.message).toBe('A request waits for Hatti already');
    // Withdrawn, then asked again.
    expect((await senders.withdraw(a))?.status).toBe('withdrawn');
    expect(await senders.withdraw(a)).toBeNull();
    const zari = unwrap(await senders.request(a, { name: 'ZARI' }, asker));
    expect(await senders.list()).toEqual([
      expect.objectContaining({ id: zari.id, shopName: 'Zari', shopHandle: 'zari' }),
    ]);

    // Approved: the shop's SMS go from it.
    expect(await senders.senderOf(a.shopId)).toBeNull();
    const approved = await senders.approve(zari.id, { by: 'Ayesha', note: 'Jazz and Telenor' });
    expect(approved).toMatchObject({ status: 'approved', decidedBy: 'Ayesha' });
    expect(await senders.approve(zari.id, { by: 'Ayesha' })).toBe('decided');
    expect(await senders.senderOf(a.shopId)).toBe('ZARI');
    const same = await senders.request(a, { name: 'zari' }, asker);
    expect(same.ok ? null : same.errors[0]!.message).toBe('Your SMS go from this name already');

    // Another shop cannot have it.
    const gul = unwrap(await senders.request(b, { name: 'Zari' }, newId()));
    expect(await senders.approve(gul.id, { by: 'Ayesha' })).toBe('taken');
    const refused = await senders.refuse(gul.id, { by: 'Ayesha', answer: 'Zari is taken' });
    expect(refused).toMatchObject({ status: 'refused', answer: 'Zari is taken' });
    expect(await senders.senderOf(b.shopId)).toBeNull();

    // A new name approved replaces the one before.
    const lawn = unwrap(await senders.request(a, { name: 'Zari Lawn' }, asker));
    await senders.approve(lawn.id, { by: 'Ayesha' });
    expect(await senders.senderOf(a.shopId)).toBe('Zari Lawn');
    const status = await senders.status(a);
    expect(status.name).toBe('Zari Lawn');
    expect(status.requests.map((request) => [request.name, request.status])).toEqual([
      ['Zari Lawn', 'approved'],
      ['ZARI', 'replaced'],
      ['zari pk', 'withdrawn'],
    ]);
    // Each shop sees its own alone.
    expect((await senders.status(b)).requests.map((request) => request.name)).toEqual(['Zari']);

    // Taken back: the shared sender again.
    const revoked = await senders.revoke('zari', { by: 'Ayesha', answer: 'Spam complaints' });
    expect(revoked).toMatchObject({ name: 'Zari Lawn', status: 'revoked' });
    expect(await senders.senderOf(a.shopId)).toBeNull();
    expect(await senders.revoke('zari', { by: 'Ayesha', answer: 'Again' })).toBe('not_approved');
    expect(await senders.revoke('nobody', { by: 'Ayesha', answer: 'Again' })).toBe('not_found');
    expect(await senders.list()).toEqual([]);
  });
});
