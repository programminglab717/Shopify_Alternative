import 'reflect-metadata';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MutationResult, StaffRole, TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { LocalStorage } from '@hatti/storage';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { storeExports } from './schema.js';
import { STORE_EXPORT_LIMITS, StoreExportService } from './store-export.service.js';

const server = testDatabaseServer();

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = new Date('2026-10-13T09:00:00Z');

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(`Expected success, got ${JSON.stringify(result.errors)}`);
  return result.value;
}

const userOf = (tenant: TenantContext) =>
  tenant.actor.kind === 'staff' ? tenant.actor.userId : null;

function codesOf(result: MutationResult<unknown>): string[] {
  if (result.ok) throw new Error('Expected user errors, got success');
  return result.errors.map((error) => error.code);
}

describe.skipIf(!server)('The whole store exported (ADM-10, ADR-415)', () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let directory: string;
  let storage: LocalStorage;
  let service: StoreExportService;
  const shopA = newId();
  const shopB = newId();

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'store-exports-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name, currency) VALUES ($1, 'A', 'PKR'), ($2, 'B', 'USD')`,
      [shopA, shopB],
    );
    directory = await mkdtemp(join(tmpdir(), 'hatti-store-exports-'));
    storage = new LocalStorage({
      directory,
      baseUrl: 'http://localhost:4000/storage',
      secret: 's'.repeat(32),
    });
    service = new StoreExportService(db, storage);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await admin.query(
      'DELETE FROM files.store_exports; DELETE FROM identity.memberships; ' +
        'DELETE FROM identity.users; DELETE FROM platform.outbox_events; ' +
        'DELETE FROM platform.audit_log',
    );
  });

  /** A member of staff of `shopId`, as the tenant they ask as. */
  async function staff(role: StaffRole, shopId = shopA): Promise<TenantContext> {
    const id = newId();
    await admin.query('INSERT INTO identity.users (id, email, name) VALUES ($1, $2, $3)', [
      id,
      `${role}-${id.slice(-6)}@example.pk`,
      role,
    ]);
    await admin.query(
      'INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, $3)',
      [id, shopId, role],
    );
    return {
      shopId,
      currency: 'PKR',
      scopes: new Set(),
      actor: { kind: 'staff', userId: id, sessionId: newId(), role, authenticatedAt: START },
    };
  }

  async function outbox() {
    const { rows } = await admin.query<{ event_type: string; payload: unknown }>(
      'SELECT event_type, payload FROM platform.outbox_events ORDER BY id',
    );
    return rows.map((row) => [row.event_type, row.payload]);
  }

  it('matches the migrated table', async () => {
    await db.tenant(shopA, (tx) => tx.select().from(storeExports).limit(1));
  });

  it('is asked for one at a time, made by a worker as its owner, and downloaded for a week', async () => {
    const owner = await staff('owner');
    const asked = unwrap(await service.request(owner, START));
    expect(asked).toMatchObject({ status: 'pending', requestedBy: userOf(owner), key: null });
    expect(service.urlOf(asked)).toBeNull();
    expect(codesOf(await service.request(owner, START))).toEqual(['IN_USE']);

    // A worker finds it, and takes it: as its owner, in the shop's currency.
    expect(await service.waiting(START)).toEqual([{ shopId: shopA, id: asked.id }]);
    const task = await service.take(shopA, asked.id, START);
    expect(task).toMatchObject({ shopId: shopA, id: asked.id, role: 'owner', currency: 'PKR' });
    // Held: no other worker takes it while the first makes it.
    expect(await service.waiting(START)).toEqual([]);
    expect(await service.take(shopA, asked.id, START)).toBeNull();

    // An empty ZIP: its end record alone.
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
    await service.finish(shopA, asked.id, zip, new Date(START.getTime() + 60_000));
    const [ready] = await service.list(owner);
    expect(ready).toMatchObject({ status: 'ready', size: 22, error: null });
    expect(ready!.expiresAt).toEqual(new Date(START.getTime() + 60_000 + 7 * DAY));
    const url = service.urlOf(ready!);
    expect(url).toContain(`shops/${shopA}/exports/${asked.id}.zip`);
    expect(url).toContain('store-export-2026-10-13.zip');
    expect((await storage.read(ready!.key!))?.body).toEqual(zip);

    // A week on, storage lets it go, and it says so.
    expect(await service.expire(new Date(START.getTime() + 7 * DAY))).toBe(0);
    expect(await service.expire(new Date(START.getTime() + 8 * DAY))).toBe(1);
    const [expired] = await service.list(owner);
    expect(expired).toMatchObject({ status: 'expired', key: null });
    expect(service.urlOf(expired!)).toBeNull();
    expect(await storage.head(ready!.key!)).toBeNull();

    expect(await outbox()).toEqual([
      ['store_export.requested', {}],
      ['store_export.ready', { size: 22 }],
    ]);
    const { rows: audit } = await admin.query<{ action: string; actor_role: string }>(
      'SELECT action, actor_role FROM platform.audit_log',
    );
    expect(audit).toEqual([{ action: 'store.export_requested', actor_role: 'owner' }]);
  });

  it('is asked for three times a day at most, and fails once tried as often as it may be', async () => {
    const owner = await staff('owner');
    for (const hour of [0, 1]) {
      const at = new Date(START.getTime() + hour * HOUR);
      const asked = unwrap(await service.request(owner, at));
      await service.take(shopA, asked.id, at);
      await service.fail(shopA, asked.id, 'Out of memory', at);
    }
    const third = unwrap(await service.request(owner, new Date(START.getTime() + 2 * HOUR)));
    // Each try holds it for half an hour; the third try is its last.
    let at = new Date(START.getTime() + 2 * HOUR);
    for (let attempt = 1; attempt <= STORE_EXPORT_LIMITS.attempts; attempt++) {
      expect(await service.take(shopA, third.id, at)).not.toBeNull();
      at = new Date(at.getTime() + STORE_EXPORT_LIMITS.leaseMs);
    }
    expect(await service.waiting(at)).toEqual([{ shopId: shopA, id: third.id }]);
    expect(await service.take(shopA, third.id, at)).toBeNull();
    expect((await service.list(owner))[0]).toMatchObject({
      status: 'failed',
      error: 'It could not be made: ask for another',
    });
    expect(codesOf(await service.request(owner, at))).toEqual(['TOO_MANY']);
    // A day after the first, one more.
    unwrap(await service.request(owner, new Date(START.getTime() + DAY + 1)));
  });

  it("says when whoever asked is no longer the shop's owner, and keeps each shop's to itself", async () => {
    const owner = await staff('owner');
    const asked = unwrap(await service.request(owner, START));
    await admin.query("UPDATE identity.memberships SET role = 'manager' WHERE user_id = $1", [
      userOf(owner),
    ]);
    expect(await service.take(shopA, asked.id, START)).toMatchObject({ role: 'manager' });
    await admin.query('DELETE FROM identity.memberships');
    expect(
      await service.take(shopA, asked.id, new Date(START.getTime() + STORE_EXPORT_LIMITS.leaseMs)),
    ).toMatchObject({ role: null });

    const theirs = await staff('owner', shopB);
    expect(await service.list(theirs)).toEqual([]);
    // Another shop's export is not this shop's to finish.
    await service.finish(shopB, asked.id, Buffer.from('zip'), START);
    expect((await service.list(owner))[0]).toMatchObject({ status: 'pending' });
    // Nor is an app's to ask for.
    const app: TenantContext = {
      shopId: shopA,
      currency: 'PKR',
      scopes: new Set(),
      actor: { kind: 'app', tokenId: newId() },
    };
    expect(codesOf(await service.request(app, START))).toEqual(['INVALID']);
  });
});
