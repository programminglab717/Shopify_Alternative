import 'reflect-metadata';
import { PublicSite, type MutationResult, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { legalDocument, type LegalDocument } from '@hatti/legal';
import { MessagesService, MessagingSettingsService } from '@hatti/messaging/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LegalChangeNotices } from './legal-notices.js';

const server = testDatabaseServer();
const FIRST = new Date('2026-10-01T09:00:00Z');
const CHANGED = new Date('2026-11-01T09:00:00Z');

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
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

/** Hatti's terms, at `version`. */
const terms = (version: string): LegalDocument => ({ ...legalDocument('terms')!, version });

describe.skipIf(!server)("Shops told of new versions of Hatti's legal documents (ADR-742)", () => {
  let testDb: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  const [zari, noor, closed, late] = [newId(), newId(), newId(), newId()];

  const notices = (documents: LegalDocument[]) =>
    new LegalChangeNotices(
      database,
      new MessagesService(database),
      new PublicSite('https://hatti.pk'),
      undefined,
      documents,
    );

  /** The notices queued, oldest first: their shop, number, key and words. */
  const told = async () =>
    (
      await admin.query<{
        shop_id: string;
        recipient: string;
        dedupe_key: string;
        variables: Record<string, string>;
      }>(
        `SELECT shop_id, recipient, dedupe_key, variables FROM messaging.messages
          WHERE kind = 'legal_changed' ORDER BY created_at, id`,
      )
    ).rows;

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'legal-notices-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name, status, closed_at, created_at) VALUES
         ($1, 'Zari Fashions', 'active', NULL, '2026-01-01'),
         ($2, 'Noor', 'active', NULL, '2026-01-01'),
         ($3, 'Gone', 'closed', '2026-09-01', '2026-01-01'),
         ($4, 'Late', 'active', NULL, $5)`,
      [zari, noor, closed, late, new Date(CHANGED.getTime() + 60_000)],
    );
    const settings = new MessagingSettingsService(database);
    unwrap(await settings.update(tenant(zari), { alertsPhone: '0300 1112223' }));
    unwrap(await settings.update(tenant(noor), { alertsPhone: '0300 4445556', language: 'ur' }));
    unwrap(await settings.update(tenant(closed), { alertsPhone: '0300 7778889' }));
    unwrap(await settings.update(tenant(late), { alertsPhone: '0300 1231234' }));
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("announces a document's new version to every shop open before it, in its language, once", async () => {
    // The first version of each is what owners agreed to in opening their shops: not announced.
    expect(await notices([terms('2026-10-01')]).sweep(FIRST)).toBe(0);
    expect(await notices([terms('2026-10-01')]).sweep(new Date(FIRST.getTime() + 60_000))).toBe(0);
    expect(await told()).toEqual([]);

    const changed = notices([terms('2026-12-01')]);
    expect(await changed.sweep(CHANGED)).toBe(2);
    expect(await told()).toEqual(
      expect.arrayContaining([
        {
          shop_id: zari,
          recipient: '+923001112223',
          dedupe_key: 'legal_changed:terms:2026-12-01',
          variables: {
            shop: 'Zari Fashions',
            title: legalDocument('terms')!.title.en,
            date: '1 December 2026',
            url: 'https://hatti.pk/legal/terms',
          },
        },
        {
          shop_id: noor,
          recipient: '+923004445556',
          dedupe_key: 'legal_changed:terms:2026-12-01',
          variables: expect.objectContaining({
            shop: 'Noor',
            title: legalDocument('terms')!.title.ur,
            url: 'https://hatti.pk/legal/terms',
          }),
        },
      ]),
    );
    // Not the closed shop, nor one opened after: it agreed to this version.
    expect((await told()).map((each) => each.shop_id).sort()).toEqual([zari, noor].sort());

    // Told once, however often the sweep runs.
    expect(await changed.sweep(new Date(CHANGED.getTime() + 3_600_000))).toBe(0);
    expect(await told()).toHaveLength(2);
    const { rows } = await admin.query(
      `SELECT handle, version, announce, notified_at FROM platform.legal_versions ORDER BY version`,
    );
    expect(rows).toEqual([
      { handle: 'terms', version: '2026-10-01', announce: false, notified_at: null },
      { handle: 'terms', version: '2026-12-01', announce: true, notified_at: CHANGED },
    ]);
  });

  it('passes over a version a newer one replaced before it was announced', async () => {
    await admin.query(
      `INSERT INTO platform.legal_versions (handle, version, first_seen_at, announce)
       VALUES ('terms', '2026-11-15', $1, true)`,
      [CHANGED],
    );
    expect(
      await notices([terms('2026-12-01')]).sweep(new Date(CHANGED.getTime() + 7_200_000)),
    ).toBe(0);
    const { rows } = await admin.query<{ notified_at: Date | null }>(
      `SELECT notified_at FROM platform.legal_versions WHERE version = '2026-11-15'`,
    );
    expect(rows[0]!.notified_at).not.toBeNull();
    expect(await told()).toHaveLength(2);
  });
});
