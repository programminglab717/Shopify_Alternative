import 'reflect-metadata';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SecretBox } from '@hatti/crypto';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { LocalStorage } from '@hatti/storage';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DigitalProductEvents,
  DigitalProductService,
  digitalFilesIn,
  digitalProductIdsIn,
  issueLicenceKeyIn,
} from './digital-products.js';
import { catalogFixture, errorsOf, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Digital products (CAT-13, ADR-813)', () => {
  let f: CatalogFixture;
  let directory: string;
  let storage: LocalStorage;
  let digital: DigitalProductService;
  const box = new SecretBox([{ id: 'k1', key: randomBytes(32) }]);

  const product = async (title: string, extra: object = {}, tenant = f.a) =>
    unwrap(await f.products.create(tenant, { title, status: 'active', ...extra })).id;

  beforeAll(async () => {
    f = await catalogFixture(server!);
    directory = await mkdtemp(join(tmpdir(), 'digital-'));
    storage = new LocalStorage({
      directory,
      baseUrl: 'http://localhost:4000/storage',
      secret: 'a'.repeat(32),
    });
    digital = new DigitalProductService(f.db, storage, box);
  }, 120_000);
  afterAll(async () => {
    await f?.close();
    await rm(directory, { recursive: true, force: true });
  });
  beforeEach(() => f.reset());

  it("is made digital with Hatti's defaults, changed, and made goods again, its files gone from storage", async () => {
    const ebook = await product('Lawn embroidery patterns (PDF)');
    expect(unwrap(await digital.set(f.a, ebook, {}))).toEqual({
      downloadLimit: 5,
      linkDays: 30,
      licenceKeys: false,
      files: [],
      keysLeft: 0,
      keysIssued: 0,
    });
    expect(unwrap(await digital.set(f.a, ebook, { linkDays: 7 }))).toMatchObject({
      downloadLimit: 5,
      linkDays: 7,
    });
    expect(
      await f.db.tenant(f.a.shopId, (tx) => digitalProductIdsIn(tx, f.a.shopId, [ebook, newId()])),
    ).toEqual(new Set([ebook]));

    // A file staged, uploaded, and sold.
    const staged = unwrap(
      await digital.fileStage(f.a, ebook, {
        filename: 'Patterns – Eid 2026.pdf',
        contentType: 'application/pdf',
        size: 11,
      }),
    );
    expect(staged).toMatchObject({
      file: { filename: 'Patterns – Eid 2026.pdf', status: 'staged', size: 11 },
      method: 'PUT',
      url: expect.any(String),
    });
    expect(errorsOf(await digital.fileCreate(f.a, staged.file.id))).toEqual([['id', 'INVALID']]);
    const { rows } = await f.admin.query<{ key: string }>(
      'SELECT key FROM catalog.digital_files WHERE id = $1',
      [staged.file.id],
    );
    expect(rows[0]!.key).toMatch(
      new RegExp(`^shops/${f.a.shopId}/digital/${staged.file.id}/Patterns-Eid-2026\\.pdf$`),
    );
    await storage.put(rows[0]!.key, Buffer.from('%PDF-1.7 hi'), 'application/pdf');
    expect(unwrap(await digital.fileCreate(f.a, staged.file.id)).status).toBe('ready');
    expect(await f.db.tenant(f.a.shopId, (tx) => digitalFilesIn(tx, f.a.shopId, ebook))).toEqual([
      {
        id: staged.file.id,
        key: rows[0]!.key,
        filename: 'Patterns – Eid 2026.pdf',
        size: 11,
      },
    ]);
    expect(digital.downloadUrl(rows[0]!.key, 'Patterns.pdf')).toEqual(expect.any(String));

    // Goods again: the file goes, from storage too, and it is digital no more.
    expect(await digital.unset(f.a, ebook)).toBe(true);
    expect(await storage.head(rows[0]!.key)).toBeNull();
    expect((await digital.of(f.a, [ebook])).has(ebook)).toBe(false);
    expect(await digital.unset(f.a, ebook)).toBe(false);
    const events = (await f.outbox()).filter(
      (event) => event.event_type === DigitalProductEvents.Updated,
    );
    expect(events.map((event) => event.payload)).toEqual([{ digital: true }, { digital: false }]);
  });

  it('refuses gift cards, limits out of range, files of no kind or too heavy, and another shop', async () => {
    const card = await product('Gift card', { giftCard: true });
    expect(errorsOf(await digital.set(f.a, card, {}))).toEqual([['productId', 'INVALID']]);
    const ebook = await product('Ebook');
    expect(errorsOf(await digital.set(f.a, ebook, { downloadLimit: 0, linkDays: 400 }))).toEqual([
      ['input.downloadLimit', 'INVALID'],
      ['input.linkDays', 'INVALID'],
    ]);
    expect(errorsOf(await digital.set(f.b, ebook, {}))).toEqual([['productId', 'NOT_FOUND']]);
    // Not digital yet: no files.
    expect(
      errorsOf(
        await digital.fileStage(f.a, ebook, {
          filename: 'a.zip',
          contentType: 'application/zip',
          size: 1,
        }),
      ),
    ).toEqual([['productId', 'NOT_FOUND']]);
    unwrap(await digital.set(f.a, ebook, {}));
    expect(
      errorsOf(
        await digital.fileStage(f.a, ebook, {
          filename: ' ',
          contentType: 'zip',
          size: 3 * 1024 ** 3,
        }),
      ),
    ).toEqual([
      ['input.filename', 'BLANK'],
      ['input.contentType', 'INVALID'],
      ['input.size', 'INVALID'],
    ]);
  });

  it('keeps licence keys sealed, once each, and gives each unit of a line one, once', async () => {
    const software = await product('Inventory app licence');
    unwrap(await digital.set(f.a, software, { licenceKeys: true }));
    expect(
      unwrap(await digital.keysAdd(f.a, software, [' AAAA-1111 ', 'BBBB-2222', 'AAAA-1111'])),
    ).toEqual({ added: 2, already: 0 });
    expect(unwrap(await digital.keysAdd(f.a, software, ['BBBB-2222', 'CCCC-3333']))).toEqual({
      added: 1,
      already: 1,
    });
    expect(errorsOf(await digital.keysAdd(f.a, software, [' ']))).toEqual([['keys', 'BLANK']]);
    expect(errorsOf(await digital.keysAdd(f.a, software, ['x'.repeat(501)]))).toEqual([
      ['keys.0', 'TOO_LONG'],
    ]);
    // Never kept as typed.
    const { rows } = await f.admin.query<{ sealed: string; hint: string }>(
      'SELECT sealed, hint FROM catalog.licence_keys ORDER BY created_at, id',
    );
    expect(rows.map((row) => row.hint)).toEqual(['1111', '2222', '3333']);
    expect(rows.some((row) => row.sealed.includes('AAAA'))).toBe(false);

    const unit = (lineUnit: number) => ({ orderId: newId(), lineItemId: LINE, lineUnit });
    const LINE = newId();
    const issue = (lineUnit: number) =>
      f.db.tenant(f.a.shopId, (tx) =>
        issueLicenceKeyIn(tx, f.a.shopId, software, unit(lineUnit), box),
      );
    expect(await issue(1)).toBe('AAAA-1111');
    // The same unit asked again: the same key.
    expect(await issue(1)).toBe('AAAA-1111');
    expect(await issue(2)).toBe('BBBB-2222');
    expect(await issue(3)).toBe('CCCC-3333');
    expect(await issue(4)).toBeNull();
    expect((await digital.of(f.a, [software])).get(software)).toMatchObject({
      keysLeft: 0,
      keysIssued: 3,
    });
    const keys = await digital.keys(f.a, software);
    expect(keys.map((key) => [key.hint, key.issuedAt !== null])).toEqual([
      ['3333', true],
      ['2222', true],
      ['1111', true],
    ]);
    // A key given stays; one not given goes.
    expect(await digital.keyDelete(f.a, keys[0]!.id)).toBe(false);
    unwrap(await digital.keysAdd(f.a, software, ['DDDD-4444']));
    const left = (await digital.keys(f.a, software))[0]!;
    expect(await digital.keyDelete(f.b, left.id)).toBe(false);
    expect(await digital.keyDelete(f.a, left.id)).toBe(true);
  });
});
