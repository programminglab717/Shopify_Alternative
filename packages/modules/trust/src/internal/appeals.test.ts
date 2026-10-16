import 'reflect-metadata';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appealPage } from './appeal-page.js';
import { AppealsService, appealToken } from './appeals.service.js';
import { TakedownsService } from './takedowns.service.js';

const server = testDatabaseServer();
const NOW = new Date('2026-10-16T08:00:00.000Z');
const later = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

describe.skipIf(!server)('Appeals of stores taken down (TNS-01, ADR-462)', () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let takedowns: TakedownsService;
  let appeals: AppealsService;
  const zari = newId();

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'appeals-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`, [
      zari,
    ]);
    takedowns = new TakedownsService(db);
    appeals = new AppealsService(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("takes the owner's side through the link, one waiting at a time, refused with why, and upheld by restoring", async () => {
    const token = appealToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    await takedowns.suspend(
      'zari',
      {
        reason: 'scam',
        note: 'Advances taken for orders never sent',
        by: 'Ayesha',
        appealToken: token,
      },
      NOW,
    );
    // Only its digest is kept; other links name nothing.
    const { rows } = await admin.query<{ appeal_digest: Buffer }>(
      'SELECT appeal_digest FROM trust.takedowns',
    );
    expect(rows[0]!.appeal_digest).toHaveLength(32);
    expect(rows[0]!.appeal_digest.toString('utf8')).not.toContain(token);
    for (const other of [appealToken(), 'short', `${token.slice(0, 31)}!`]) {
      expect(await appeals.view(other)).toBeNull();
      expect(await appeals.appeal(other, 'Hello')).toBeNull();
    }
    expect(await appeals.view(token)).toMatchObject({
      shopName: 'Zari',
      reason: 'scam',
      note: 'Advances taken for orders never sent',
      restoredAt: null,
      appeals: [],
      canAppeal: true,
    });

    expect(await appeals.appeal(token, '  ', later(1))).toMatchObject({
      ok: false,
      problem: 'blank',
    });
    expect(await appeals.appeal(token, 'x'.repeat(2001), later(1))).toMatchObject({
      ok: false,
      problem: 'too_long',
    });
    const sent = await appeals.appeal(
      token,
      ' Every order was sent; tracking attached. ',
      later(1),
    );
    expect(sent).toMatchObject({
      ok: true,
      view: {
        canAppeal: false,
        appeals: [
          { words: 'Every order was sent; tracking attached.', status: 'open', answer: null },
        ],
      },
    });
    expect(await appeals.appeal(token, 'Again', later(2))).toMatchObject({
      ok: false,
      problem: 'waiting',
    });

    const [waiting] = await appeals.list();
    expect(waiting).toMatchObject({ shopHandle: 'zari', reason: 'scam', status: 'open' });
    const refused = await appeals.refuse(
      waiting!.id,
      { by: 'Bilal', answer: 'Tracking shows none delivered' },
      later(3),
    );
    expect(refused).toMatchObject({ status: 'refused', answeredBy: 'Bilal' });
    expect(await appeals.refuse(waiting!.id, { by: 'Bilal', answer: 'Again' })).toBe('answered');
    expect(await appeals.refuse(newId(), { by: 'Bilal', answer: 'x' })).toBe('not_found');
    expect(await appeals.list()).toEqual([]);

    // Another, which restoring the store upholds; none more after.
    expect((await appeals.appeal(token, 'Refunded every advance today.', later(4)))?.ok).toBe(true);
    await takedowns.restore('zari', { note: 'Every advance refunded', by: 'Bilal' }, later(5));
    const view = await appeals.view(token);
    expect(view?.appeals.map((appeal) => [appeal.status, appeal.answer])).toEqual([
      ['refused', 'Tracking shows none delivered'],
      ['upheld', 'Every advance refunded'],
    ]);
    expect(view?.canAppeal).toBe(false);
    expect(await appeals.appeal(token, 'More', later(6))).toMatchObject({
      ok: false,
      problem: 'restored',
    });

    // Its page: why, each appeal with Hatti's answer, and the form while one may come.
    const page = appealPage(view);
    expect(page.status).toBe(200);
    expect(page.html).toContain('Your store is open again');
    expect(page.html).toContain('Advances taken for orders never sent');
    expect(page.html).toContain('Tracking shows none delivered');
    expect(page.html).not.toContain('<form');
    expect(appealPage(null).status).toBe(404);
  });
});
