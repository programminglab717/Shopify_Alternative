import 'reflect-metadata';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MutationResult, TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { FileService } from '@hatti/files/public';
import { newId } from '@hatti/ids';
import { LocalStorage } from '@hatti/storage';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TrustEvents } from './takedowns.service.js';
import { VerificationsService, cnicDigits, ntnOf } from './verifications.service.js';

const server = testDatabaseServer();
const NOW = new Date('2026-10-16T08:00:00.000Z');

/** A PNG's signature, then `size` bytes in all. */
const png = (size: number) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(size - 8, 1),
  ]);

const problems = <T>(result: MutationResult<T>) =>
  result.ok ? [] : result.errors.map((error) => [error.field.join('.'), error.code]);

describe.skipIf(!server)('Shops verified by Hatti (ONB-11, ADR-465)', () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let storage: LocalStorage;
  let directory: string;
  let verifications: VerificationsService;
  let files: FileService;
  const zari = newId();
  const other = newId();
  const ownerId = newId();
  const tenant = (shopId: string): TenantContext => ({
    shopId,
    currency: 'PKR',
    scopes: new Set(['write_settings', 'write_files']),
    actor: {
      kind: 'staff',
      userId: ownerId,
      sessionId: newId(),
      role: 'owner',
      authenticatedAt: NOW,
    },
  });

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'verifications-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name, handle, status)
       VALUES ($1, 'Zari', 'zari', 'active'), ($2, 'Other', 'other', 'active')`,
      [zari, other],
    );
    directory = await mkdtemp(join(tmpdir(), 'hatti-verifications-'));
    storage = new LocalStorage({
      directory,
      baseUrl: 'https://hatti.test/storage',
      secret: 's'.repeat(32),
    });
    verifications = new VerificationsService(db, storage);
    files = new FileService(db, storage);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  /** An upload staged for the shop, and in storage: its resource URL. */
  const staged = async (shopId: string, data: Buffer, put = true) => {
    const result = await files.stage(tenant(shopId), [
      { filename: 'CNIC.png', mimeType: 'image/png', fileSize: String(data.length) },
    ]);
    if (!result.ok) throw new Error('not staged');
    const [upload] = result.value;
    if (put) await storage.put(storage.keyOf(upload!.resourceUrl)!, data, 'image/png');
    return upload!.resourceUrl;
  };
  const stored = async (shopId: string, id: string) =>
    (await storage.head(`shops/${shopId}/verifications/${id}/1.png`)) !== null;
  const events = async () =>
    (
      await admin.query<{ event_type: string; payload: { level: string | null } }>(
        `SELECT event_type, payload FROM platform.outbox_events
          WHERE shop_id = $1 AND event_type = $2 ORDER BY occurred_at, id`,
        [zari, TrustEvents.VerificationChanged],
      )
    ).rows.map((row) => row.payload.level);

  it('reads CNICs and NTNs as people write them', () => {
    expect(cnicDigits('35202-1234567-1')).toBe('3520212345671');
    expect(cnicDigits(' 3520212345671 ')).toBe('3520212345671');
    expect(cnicDigits('35202-1234567')).toBeNull();
    expect(cnicDigits('3520-21234567-1')).toBeNull();
    expect(ntnOf('1234567-8')).toBe('1234567-8');
    expect(ntnOf('12345678')).toBe('1234567-8');
    expect(ntnOf('35202-1234567-1')).toBe('3520212345671');
    expect(ntnOf('123456')).toBeNull();
  });

  it('verifies the owner, then the business, its documents deleted once decided, and takes them back', async () => {
    // Nothing to verify a business by before its owner; nothing without a document.
    expect(
      problems(
        await verifications.submit(
          tenant(zari),
          { level: 'business', name: 'Zari Pvt Ltd', ntn: '1234567-8', documents: [] },
          ownerId,
          NOW,
        ),
      ),
    ).toEqual([['input.documents', 'BLANK']]);
    expect(
      problems(
        await verifications.submit(
          tenant(zari),
          {
            level: 'business',
            name: 'Zari Pvt Ltd',
            ntn: '1234567-8',
            documents: [await staged(zari, png(64))],
          },
          ownerId,
          NOW,
        ),
      ),
    ).toEqual([['input.level', 'INVALID']]);
    expect(
      problems(
        await verifications.submit(
          tenant(zari),
          { level: 'identity', name: ' ', cnic: '1234', documents: ['x', 'y', 'z', 'w'] },
          ownerId,
          NOW,
        ),
      ),
    ).toEqual([
      ['input.name', 'BLANK'],
      ['input.cnic', 'INVALID'],
      ['input.documents', 'TOO_MANY'],
    ]);
    // Only the shop's own staged uploads, uploaded, and photos or PDFs.
    for (const [document, code] of [
      [await staged(other, png(64)), 'NOT_FOUND'],
      [await staged(zari, png(64), false), 'NOT_FOUND'],
      [await staged(zari, Buffer.from('not a photo')), 'INVALID'],
    ] as const) {
      expect(
        problems(
          await verifications.submit(
            tenant(zari),
            {
              level: 'identity',
              name: 'Sana Ahmed',
              cnic: '35202-1234567-1',
              documents: [document],
            },
            ownerId,
            NOW,
          ),
        ),
      ).toEqual([['input.documents.0', code]]);
    }

    const front = await staged(zari, png(64));
    const asked = await verifications.submit(
      tenant(zari),
      {
        level: 'identity',
        name: ' Sana Ahmed ',
        cnic: '35202-1234567-1',
        documents: [front, await staged(zari, png(80))],
      },
      ownerId,
      NOW,
    );
    if (!asked.ok) throw new Error(JSON.stringify(asked.errors));
    expect(asked.value).toMatchObject({
      level: 'identity',
      name: 'Sana Ahmed',
      cnicLast4: '5671',
      ntn: null,
      status: 'waiting',
      askedBy: ownerId,
    });
    // The uploads are the request's now: copied where verifications keep them, gone where staged.
    expect(await stored(zari, asked.value.id)).toBe(true);
    expect(await storage.head(storage.keyOf(front)!)).toBeNull();
    // One request waits at a time.
    expect(
      problems(
        await verifications.submit(
          tenant(zari),
          {
            level: 'identity',
            name: 'Sana Ahmed',
            cnic: '35202-1234567-1',
            documents: [await staged(zari, png(64))],
          },
          ownerId,
          NOW,
        ),
      ),
    ).toEqual([['input.level', 'TAKEN']]);

    // Hatti's people see it in full while it waits, with links to its documents.
    const [waiting] = await verifications.list();
    expect(waiting).toMatchObject({
      id: asked.value.id,
      shopName: 'Zari',
      shopHandle: 'zari',
      cnic: '3520212345671',
    });
    expect(waiting!.documents).toHaveLength(2);
    expect(verifications.documentLinks(waiting!)[0]).toMatch(
      new RegExp(`^https://hatti\\.test/storage/shops/${zari}/verifications/`),
    );

    const approved = await verifications.approve(asked.value.id, { by: 'Ayesha' }, NOW);
    expect(approved).toMatchObject({ status: 'approved', decidedBy: 'Ayesha', cnic: null });
    expect(typeof approved !== 'string' && approved.documents).toEqual([]);
    expect(await stored(zari, asked.value.id)).toBe(false);
    expect(await verifications.approve(asked.value.id, { by: 'Ayesha' }, NOW)).toBe('decided');
    expect(await verifications.approve(newId(), { by: 'Ayesha' }, NOW)).toBe('not_found');
    expect((await verifications.status(tenant(zari))).level).toBe('identity');

    // Then the business, refused with why, asked again and approved.
    const business = async () => {
      const result = await verifications.submit(
        tenant(zari),
        {
          level: 'business',
          name: 'Zari Pvt Ltd',
          ntn: '1234567 8',
          documents: [await staged(zari, png(64))],
        },
        ownerId,
        NOW,
      );
      if (!result.ok) throw new Error(JSON.stringify(result.errors));
      return result.value;
    };
    const first = await business();
    expect(first.ntn).toBe('1234567-8');
    expect(
      await verifications.refuse(first.id, { by: 'Ayesha', answer: 'The certificate is blurred' }),
    ).toMatchObject({ status: 'refused', answer: 'The certificate is blurred' });
    expect(await stored(zari, first.id)).toBe(false);
    const second = await business();
    await verifications.approve(second.id, { by: 'Ayesha' }, NOW);
    const status = await verifications.status(tenant(zari));
    expect(status.level).toBe('business');
    expect(status.requests.map((request) => [request.level, request.status])).toEqual([
      ['business', 'approved'],
      ['business', 'refused'],
      ['identity', 'approved'],
    ]);
    // The other shop is not verified, and sees none of these.
    expect(await verifications.status(tenant(other))).toEqual({ level: null, requests: [] });

    // Taking the owner's back takes the business's with it.
    expect(await verifications.revoke('nobody', 'identity', { by: 'Ayesha', answer: 'x' })).toBe(
      'not_found',
    );
    const revoked = await verifications.revoke(
      ' Zari ',
      'identity',
      { by: 'Ayesha', answer: 'The CNIC was another person’s' },
      NOW,
    );
    expect(Array.isArray(revoked) && revoked.map((each) => each.level).sort()).toEqual([
      'business',
      'identity',
    ]);
    expect((await verifications.status(tenant(zari))).level).toBeNull();
    expect(await verifications.revoke('zari', 'identity', { by: 'Ayesha', answer: 'x' })).toBe(
      'not_verified',
    );
    // Its storefront hears of each change of level.
    expect(await events()).toEqual(['identity', 'business', null]);
  });
});
