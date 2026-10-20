import 'reflect-metadata';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MutationResult, TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { LocalStorage } from '@hatti/storage';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BrandService, shopLogoOf } from './brand.service.js';
import { FileService, type StagedUploadInput } from './file.service.js';
import { fileVersionOf, keyName, looksLike } from './file-types.js';
import type { FileRecord } from './records.js';
import { brands as brandsTable, files as filesTable } from './schema.js';

const server = testDatabaseServer();

function tenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_files']),
  };
}

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(`Expected success, got ${JSON.stringify(result.errors)}`);
  return result.value;
}

function errorsOf(result: MutationResult<unknown>): [string, string][] {
  if (result.ok) throw new Error('Expected user errors, got success');
  return result.errors.map((error) => [error.field.join('.'), error.code]);
}

/** A PNG's signature, then `size` bytes in all. */
const png = (size: number) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(size - 8),
  ]);
const pdf = Buffer.from('%PDF-1.7\n%receipt\n');
const webp = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ');

describe('file types', () => {
  it('are told by their first bytes', () => {
    expect(looksLike('image/png', png(16))).toBe(true);
    expect(looksLike('image/jpeg', png(16))).toBe(false);
    expect(looksLike('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe1]))).toBe(true);
    expect(looksLike('image/gif', Buffer.from('GIF89a...'))).toBe(true);
    expect(looksLike('image/webp', Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 '))).toBe(true);
    expect(looksLike('image/webp', Buffer.from('RIFF\x10\x00\x00\x00WAVEfmt '))).toBe(false);
    expect(looksLike('application/pdf', pdf)).toBe(true);
    expect(looksLike('application/pdf', Buffer.from('<html>'))).toBe(false);
  });

  it('name keys with letters, digits and their extension', () => {
    expect(keyName('Lawn collection (2).JPEG', 'image/jpeg')).toBe('Lawn-collection-2.jpg');
    expect(keyName('رسید.png', 'image/png')).toBe('file.png');
    expect(keyName('Café menu.pdf', 'application/pdf')).toBe('Cafe-menu.pdf');
  });
});

describe.skipIf(!server)('FileService', () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let directory: string;
  let storage: LocalStorage;
  let service: FileService;
  let brands: BrandService;
  const a = tenant(newId());
  const b = tenant(newId());

  const stage = (inputs: StagedUploadInput[], owner = a) => service.stage(owner, inputs);
  const keyOf = (resourceUrl: string) => storage.keyOf(resourceUrl)!;

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({ appUrl: testDb.appUrl, applicationName: 'files-test' });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      a.shopId,
      b.shopId,
    ]);
    directory = await mkdtemp(join(tmpdir(), 'hatti-files-'));
    storage = new LocalStorage({
      directory,
      baseUrl: 'http://localhost:4000/storage',
      secret: 's'.repeat(32),
    });
    service = new FileService(db, storage);
    brands = new BrandService(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await admin.query(
      'DELETE FROM files.brands; DELETE FROM files.files; DELETE FROM platform.outbox_events',
    );
  });

  async function outbox() {
    const { rows } = await admin.query<{ event_type: string; payload: unknown }>(
      'SELECT event_type, payload FROM platform.outbox_events ORDER BY id',
    );
    return rows;
  }

  it('matches the migrated tables', async () => {
    await db.tenant(a.shopId, async (tx) => {
      await tx.select().from(filesTable).limit(1);
      await tx.select().from(brandsTable).limit(1);
    });
  });

  /** A file of `owner`'s, uploaded and made: `size` bytes of `type`. */
  async function made(owner: TenantContext, filename: string, data: Buffer, type: string) {
    const [upload] = unwrap(
      await stage([{ filename, mimeType: type, fileSize: String(data.length) }], owner),
    );
    await storage.put(keyOf(upload!.resourceUrl), data, type);
    return unwrap(await service.create(owner, [{ originalSource: upload!.resourceUrl }]))[0]!;
  }

  it("keeps the shop's logo, one of its images, until its file goes", async () => {
    expect(await brands.get(a)).toEqual({ logo: null, squareLogo: null, updatedAt: null });
    const logo = await made(a, 'Zari logo.png', png(64), 'image/png');
    const catalogue = await made(a, 'Catalogue.pdf', pdf, 'application/pdf');
    const theirs = await made(b, 'B.png', png(32), 'image/png');
    await admin.query('DELETE FROM platform.outbox_events');
    // Not a PDF, nor another shop's file, nor one that isn't.
    expect(errorsOf(await brands.update(a, { logo: catalogue.id }))).toEqual([
      ['input.logo', 'INVALID'],
    ]);
    const refused = await brands.update(a, { logo: catalogue.id });
    expect(refused.ok ? null : refused.errors[0]!.message).toBe(
      'A logo is an image: JPEG, PNG, WebP or GIF, not application/pdf',
    );
    for (const id of [theirs.id, newId()]) {
      expect(errorsOf(await brands.update(a, { logo: id }))).toEqual([['input.logo', 'NOT_FOUND']]);
    }
    expect(await outbox()).toEqual([]);

    const set = unwrap(await brands.update(a, { logo: logo.id }));
    expect(set.logo).toMatchObject<Partial<FileRecord>>({
      id: logo.id,
      filename: 'Zari logo.png',
      contentType: 'image/png',
    });
    expect(set.updatedAt).toBeInstanceOf(Date);
    expect(await db.tenant(a.shopId, (tx) => shopLogoOf(tx, a.shopId))).toEqual({
      id: logo.id,
      key: logo.key,
      contentType: 'image/png',
    });
    expect(await db.tenant(b.shopId, (tx) => shopLogoOf(tx, b.shopId))).toBeNull();
    // The same again, or nothing given, changes nothing.
    unwrap(await brands.update(a, { logo: logo.id }));
    unwrap(await brands.update(a, {}));
    expect((await outbox()).map((event) => [event.event_type, event.payload])).toEqual([
      ['shop_brand.updated', { changed: ['logo'] }],
    ]);
    expect(await brands.get(b)).toEqual({ logo: null, squareLogo: null, updatedAt: null });

    // Its file deleted, the shop has no logo.
    unwrap(await service.delete(a, [logo.id]));
    expect((await brands.get(a)).logo).toBeNull();
    expect(await db.tenant(a.shopId, (tx) => shopLogoOf(tx, a.shopId))).toBeNull();
    const another = await made(a, 'Zari logo 2.webp', webp, 'image/webp');
    unwrap(await brands.update(a, { logo: another.id }));
    expect(unwrap(await brands.update(a, { logo: null })).logo).toBeNull();
    expect(
      (await outbox()).filter((event) => event.event_type === 'shop_brand.updated'),
    ).toHaveLength(3);
  });

  it("keeps the shop's square logo beside its logo, each its own, until its file goes (ADR-205)", async () => {
    const logo = await made(a, 'Zari wide.png', png(64), 'image/png');
    const square = await made(a, 'Zari square.webp', webp, 'image/webp');
    const catalogue = await made(a, 'Catalogue.pdf', pdf, 'application/pdf');
    await admin.query('DELETE FROM platform.outbox_events');
    // Checked as the logo is, under its own name.
    expect(errorsOf(await brands.update(a, { logo: logo.id, squareLogo: catalogue.id }))).toEqual([
      ['input.squareLogo', 'INVALID'],
    ]);
    expect(errorsOf(await brands.update(a, { squareLogo: newId() }))).toEqual([
      ['input.squareLogo', 'NOT_FOUND'],
    ]);
    expect(await outbox()).toEqual([]);

    const both = unwrap(await brands.update(a, { logo: logo.id, squareLogo: square.id }));
    expect([both.logo?.id, both.squareLogo?.id]).toEqual([logo.id, square.id]);
    expect(await db.tenant(a.shopId, (tx) => shopLogoOf(tx, a.shopId, 'squareLogo'))).toEqual({
      id: square.id,
      key: square.key,
      contentType: 'image/webp',
    });
    // One changed alone leaves the other as it was.
    const alone = unwrap(await brands.update(a, { squareLogo: null }));
    expect([alone.logo?.id, alone.squareLogo]).toEqual([logo.id, null]);
    unwrap(await brands.update(a, { squareLogo: square.id }));
    expect((await outbox()).map((event) => [event.event_type, event.payload])).toEqual([
      ['shop_brand.updated', { changed: ['logo', 'squareLogo'] }],
      ['shop_brand.updated', { changed: ['squareLogo'] }],
      ['shop_brand.updated', { changed: ['squareLogo'] }],
    ]);
    // Its file deleted, the shop has no square logo, and keeps its logo.
    unwrap(await service.delete(a, [square.id]));
    expect(await brands.get(a)).toMatchObject({ logo: { id: logo.id }, squareLogo: null });
    expect(await db.tenant(a.shopId, (tx) => shopLogoOf(tx, a.shopId, 'squareLogo'))).toBeNull();
    expect(await brands.get(b)).toEqual({ logo: null, squareLogo: null, updatedAt: null });
  });

  it('stages uploads, checked: where to put each, signed for its size and type', async () => {
    expect(errorsOf(await stage([]))).toEqual([['input', 'BLANK']]);
    const many = Array.from({ length: 11 }, () => ({
      filename: 'a.png',
      mimeType: 'image/png',
      fileSize: '100',
    }));
    expect(errorsOf(await stage(many))).toEqual([['input', 'TOO_MANY']]);
    expect(
      errorsOf(
        await stage([
          { filename: ' ', mimeType: 'text/html', fileSize: '0' },
          { filename: 'big.pdf', mimeType: 'application/pdf', fileSize: '20971521' },
        ]),
      ),
    ).toEqual([
      ['input.0.filename', 'BLANK'],
      ['input.0.mimeType', 'INVALID'],
      ['input.0.fileSize', 'INVALID'],
      ['input.1.fileSize', 'INVALID'],
    ]);

    const [upload] = unwrap(
      await stage([{ filename: 'Lawn collection.png', mimeType: 'IMAGE/PNG', fileSize: '100' }]),
    );
    const key = keyOf(upload!.resourceUrl);
    expect(key).toMatch(
      new RegExp(`^shops/${a.shopId}/files/[0-9a-f-]{36}/Lawn-collection\\.png$`),
    );
    expect(upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/png' } });
    const query = Object.fromEntries(new URL(upload!.url).searchParams);
    expect(storage.verify('PUT', key, query)).toEqual({
      method: 'PUT',
      contentType: 'image/png',
      contentLength: 100,
    });
    // Staged, not yet a file.
    expect((await service.list(a, { first: 10 })).items).toEqual([]);

    // A product's video weighs up to 100 MiB, anything else 20 (ADR-258).
    const MiB = 1024 * 1024;
    const [video] = unwrap(
      await stage([
        { filename: 'Kurta.MOV', mimeType: 'video/quicktime', fileSize: String(60 * MiB) },
      ]),
    );
    expect(keyOf(video!.resourceUrl)).toMatch(/\/Kurta\.mov$/);
    expect(
      errorsOf(
        await stage([
          { filename: 'big.jpg', mimeType: 'image/jpeg', fileSize: String(60 * MiB) },
          { filename: 'long.mp4', mimeType: 'video/mp4', fileSize: String(100 * MiB + 1) },
        ]),
      ),
    ).toEqual([
      ['input.0.fileSize', 'INVALID'],
      ['input.1.fileSize', 'INVALID'],
    ]);
  });

  it('makes files of uploads that are in, of the size and type they were staged as', async () => {
    const [image, receipt] = unwrap(
      await stage([
        { filename: 'Lawn collection.png', mimeType: 'image/png', fileSize: '100' },
        {
          filename: 'Receipt #1023.pdf',
          mimeType: 'application/pdf',
          fileSize: String(pdf.length),
        },
      ]),
    );
    const sources = [
      { originalSource: image!.resourceUrl, alt: ' Three lawn suits ' },
      { originalSource: receipt!.resourceUrl },
    ];
    // Nothing uploaded yet: nothing made, and the staged uploads wait.
    expect(errorsOf(await service.create(a, sources))).toEqual([
      ['files.0.originalSource', 'INVALID'],
      ['files.1.originalSource', 'INVALID'],
    ]);
    await storage.put(keyOf(image!.resourceUrl), png(100), 'image/png');
    await storage.put(keyOf(receipt!.resourceUrl), pdf, 'application/pdf');
    const made = unwrap(await service.create(a, sources));
    expect(made).toMatchObject([
      {
        filename: 'Lawn collection.png',
        contentType: 'image/png',
        size: 100,
        alt: 'Three lawn suits',
      },
      { filename: 'Receipt #1023.pdf', contentType: 'application/pdf', size: pdf.length, alt: '' },
    ]);
    expect((await outbox()).map((event) => [event.event_type, event.payload])).toEqual([
      ['file.created', { contentType: 'image/png', size: 100 }],
      ['file.created', { contentType: 'application/pdf', size: pdf.length }],
    ]);
    // Made again, it is what it was; another shop can't make a file of it.
    expect(unwrap(await service.create(a, [sources[0]!]))[0]!.id).toBe(made[0]!.id);
    expect((await outbox()).length).toBe(2);
    expect(errorsOf(await service.create(b, [sources[0]!]))).toEqual([
      ['files.0.originalSource', 'NOT_FOUND'],
    ]);
    expect(
      errorsOf(await service.create(a, [{ originalSource: 'https://example.com/a.png' }])),
    ).toEqual([['files.0.originalSource', 'NOT_FOUND']]);

    const page = await service.list(a, { first: 1 });
    expect(page).toMatchObject({ items: [{ id: made[1]!.id }], hasNextPage: true });
    expect(
      (await service.list(a, { first: 5, after: made[1]!.id })).items.map((f) => f.id),
    ).toEqual([made[0]!.id]);
    expect(await service.get(b, made[0]!.id)).toBeNull();
    // Its URL shows it, by its name, for an hour.
    const url = new URL(service.urlOf(made[1]!));
    expect(
      storage.verify('GET', decodeURIComponent(url.pathname.slice('/storage/'.length)), {
        ...Object.fromEntries(url.searchParams),
      }),
    ).toEqual({ method: 'GET', filename: 'Receipt #1023.pdf' });
  });

  it('removes uploads that are not what they were staged as', async () => {
    const [disguised, short] = unwrap(
      await stage([
        { filename: 'photo.jpg', mimeType: 'image/jpeg', fileSize: '24' },
        { filename: 'banner.png', mimeType: 'image/png', fileSize: '100' },
      ]),
    );
    await storage.put(
      keyOf(disguised!.resourceUrl),
      Buffer.from('<script>alert(1)</script>').subarray(0, 24),
      'image/jpeg',
    );
    await storage.put(keyOf(short!.resourceUrl), png(50), 'image/png');
    const refused = await service.create(a, [
      { originalSource: disguised!.resourceUrl },
      { originalSource: short!.resourceUrl },
    ]);
    expect(refused.ok ? [] : refused.errors.map((error) => error.message)).toEqual([
      'The upload is not the image/jpeg it was staged as',
      'The upload is 50 bytes, not the 100 it was staged as',
    ]);
    expect(await storage.head(keyOf(disguised!.resourceUrl))).toBeNull();
    expect(await storage.head(keyOf(short!.resourceUrl))).toBeNull();
  });

  it('deletes files and what storage keeps of them', async () => {
    const [upload] = unwrap(
      await stage([{ filename: 'a.png', mimeType: 'image/png', fileSize: '16' }]),
    );
    await storage.put(keyOf(upload!.resourceUrl), png(16), 'image/png');
    const [file] = unwrap(await service.create(a, [{ originalSource: upload!.resourceUrl }]));
    expect(errorsOf(await service.delete(b, [file!.id]))).toEqual([['fileIds.0', 'NOT_FOUND']]);
    expect(unwrap(await service.delete(a, [file!.id]))).toEqual([file!.id]);
    expect(await storage.head(file!.key)).toBeNull();
    expect((await outbox()).map((event) => event.event_type)).toEqual([
      'file.created',
      'file.deleted',
    ]);
  });

  it('renames files, keeping their extensions and where storage keeps them (ADR-638)', async () => {
    const [first, second] = unwrap(
      await stage([
        { filename: 'IMG_2041.PNG', mimeType: 'image/png', fileSize: '16' },
        { filename: 'guide.pdf', mimeType: 'application/pdf', fileSize: String(pdf.length) },
      ]),
    );
    await storage.put(keyOf(first!.resourceUrl), png(16), 'image/png');
    await storage.put(keyOf(second!.resourceUrl), pdf, 'application/pdf');
    const [photo, guide] = unwrap(
      await service.create(a, [
        { originalSource: first!.resourceUrl },
        { originalSource: second!.resourceUrl },
      ]),
    );
    await admin.query('DELETE FROM platform.outbox_events');

    const renamed = unwrap(
      await service.update(a, [
        { id: photo!.id, filename: ' Eid banner.png ', alt: 'Lawn on a rooftop' },
        { id: guide!.id, filename: 'Size guide.PDF' },
      ]),
    );
    expect(renamed.map((file) => [file.filename, file.alt, file.key])).toEqual([
      ['Eid banner.png', 'Lawn on a rooftop', photo!.key],
      ['Size guide.PDF', '', guide!.key],
    ]);
    expect((await service.get(a, photo!.id))!.filename).toBe('Eid banner.png');
    expect((await outbox()).map((event) => [event.event_type, event.payload])).toEqual([
      ['file.updated', { changed: ['filename', 'alt'] }],
      ['file.updated', { changed: ['filename'] }],
    ]);

    // Nothing changed records nothing; the alt alone may change.
    await admin.query('DELETE FROM platform.outbox_events');
    unwrap(await service.update(a, [{ id: guide!.id, filename: 'Size guide.PDF' }]));
    expect(unwrap(await service.update(a, [{ id: guide!.id, alt: 'Sizes' }]))[0]!.filename).toBe(
      'Size guide.PDF',
    );
    expect((await outbox()).map((event) => event.payload)).toEqual([{ changed: ['alt'] }]);

    expect(
      errorsOf(
        await service.update(a, [
          { id: photo!.id, filename: 'Eid banner.jpg' },
          { id: guide!.id, filename: 'Size guide' },
        ]),
      ),
    ).toEqual([
      ['files.0.filename', 'INVALID'],
      ['files.1.filename', 'INVALID'],
    ]);
    expect(errorsOf(await service.update(a, [{ id: photo!.id, filename: '  ' }]))).toEqual([
      ['files.0.filename', 'BLANK'],
    ]);
    expect(errorsOf(await service.update(b, [{ id: photo!.id, filename: 'x.png' }]))).toEqual([
      ['files.0.id', 'NOT_FOUND'],
    ]);
    expect(
      errorsOf(
        await service.update(a, [
          { id: photo!.id, alt: 'a' },
          { id: photo!.id, alt: 'b' },
        ]),
      ),
    ).toEqual([['files', 'INVALID']]);
    expect(errorsOf(await service.update(a, []))).toEqual([['files', 'BLANK']]);
  });

  it('replaces what a file holds, keeping its ID, the old one removed from storage (ADR-647)', async () => {
    const [first, guideUpload] = unwrap(
      await stage([
        { filename: 'Eid banner.png', mimeType: 'image/png', fileSize: '16' },
        { filename: 'guide.pdf', mimeType: 'application/pdf', fileSize: String(pdf.length) },
      ]),
    );
    await storage.put(keyOf(first!.resourceUrl), png(16), 'image/png');
    await storage.put(keyOf(guideUpload!.resourceUrl), pdf, 'application/pdf');
    const [banner, guide] = unwrap(
      await service.create(a, [
        { originalSource: first!.resourceUrl, alt: 'Lawn' },
        { originalSource: guideUpload!.resourceUrl },
      ]),
    );
    expect(fileVersionOf(banner!.key)).toBe(banner!.id.slice(-8));
    const [next, notUploaded, aPdf] = unwrap(
      await stage([
        { filename: 'Eid banner 2026.png', mimeType: 'image/png', fileSize: '24' },
        { filename: 'later.png', mimeType: 'image/png', fileSize: '20' },
        { filename: 'sizes.pdf', mimeType: 'application/pdf', fileSize: String(pdf.length) },
      ]),
    );
    await storage.put(keyOf(next!.resourceUrl), png(24), 'image/png');
    await storage.put(keyOf(aPdf!.resourceUrl), pdf, 'application/pdf');
    await admin.query('DELETE FROM platform.outbox_events');

    // An image by an image, a PDF by a PDF; an upload not in yet, or another shop's, is none.
    expect(
      errorsOf(
        await service.update(a, [
          { id: banner!.id, originalSource: aPdf!.resourceUrl },
          { id: guide!.id, originalSource: notUploaded!.resourceUrl },
        ]),
      ),
    ).toEqual([['files.1.originalSource', 'INVALID']]);
    expect(
      errorsOf(await service.update(a, [{ id: banner!.id, originalSource: aPdf!.resourceUrl }])),
    ).toEqual([['files.0.originalSource', 'INVALID']]);
    expect(
      errorsOf(await service.update(b, [{ id: banner!.id, originalSource: next!.resourceUrl }])),
    ).toEqual([['files.0.originalSource', 'NOT_FOUND']]);
    // Named as its upload unless given a name, which keeps the upload's extension.
    expect(
      errorsOf(
        await service.update(a, [
          { id: banner!.id, originalSource: next!.resourceUrl, filename: 'Eid.jpg' },
        ]),
      ),
    ).toEqual([['files.0.filename', 'INVALID']]);
    expect(
      errorsOf(
        await service.update(a, [
          { id: banner!.id, originalSource: next!.resourceUrl },
          { id: guide!.id, originalSource: next!.resourceUrl },
        ]),
      ),
    ).toEqual([['files', 'INVALID']]);
    expect(await outbox()).toEqual([]);

    const [replaced] = unwrap(
      await service.update(a, [{ id: banner!.id, originalSource: ` ${next!.resourceUrl} ` }]),
    );
    expect(replaced).toMatchObject({
      id: banner!.id,
      filename: 'Eid banner 2026.png',
      contentType: 'image/png',
      size: 24,
      alt: 'Lawn',
      key: keyOf(next!.resourceUrl),
    });
    // Its addresses name what it holds now; what it held is gone, and the upload is no file.
    expect(fileVersionOf(replaced!.key)).not.toBe(fileVersionOf(banner!.key));
    expect(await storage.head(banner!.key)).toBeNull();
    expect(await storage.head(replaced!.key)).not.toBeNull();
    expect((await service.list(a, { first: 10 })).items.map((file) => file.id).sort()).toEqual(
      [banner!.id, guide!.id].sort(),
    );
    expect((await outbox()).map((event) => [event.event_type, event.payload])).toEqual([
      ['file.updated', { changed: ['file', 'filename'] }],
    ]);
    // An upload taken is taken.
    expect(
      errorsOf(await service.update(a, [{ id: guide!.id, originalSource: next!.resourceUrl }])),
    ).toEqual([['files.0.originalSource', 'NOT_FOUND']]);
    const [pdfReplaced] = unwrap(
      await service.update(a, [
        { id: guide!.id, originalSource: aPdf!.resourceUrl, filename: 'Size guide.pdf' },
      ]),
    );
    expect(pdfReplaced).toMatchObject({ id: guide!.id, filename: 'Size guide.pdf' });
  });

  it('finds files by the words of their names, in any case, newest first (ADR-636)', async () => {
    const made = async (filename: string, owner = a) => {
      const [upload] = unwrap(
        await stage([{ filename, mimeType: 'image/png', fileSize: '16' }], owner),
      );
      await storage.put(keyOf(upload!.resourceUrl), png(16), 'image/png');
      const [file] = unwrap(await service.create(owner, [{ originalSource: upload!.resourceUrl }]));
      return file!;
    };
    const banner = await made('Eid lawn banner.png');
    const lawn = await made('lawn_2026.png');
    await made('Kurta.png');
    await made('Lawn of B.png', b);
    const names = async (query: string | null, first = 10) =>
      (await service.list(a, { first, query })).items.map((file) => file.filename);

    expect(await names('LAWN')).toEqual([lawn.filename, banner.filename]);
    expect(await names('lawn eid')).toEqual([banner.filename]);
    // A word's % or _ is itself, not a wildcard; spaces and nothing find them all.
    expect(await names('lawn_')).toEqual([lawn.filename]);
    expect(await names('%')).toEqual([]);
    expect(await names('  ')).toHaveLength(3);
    expect(await names(null, 1)).toEqual(['Kurta.png']);
  });

  it('sweeps uploads staged a day ago and never made files, as the shop stages more', async () => {
    const [old] = unwrap(
      await stage([{ filename: 'old.png', mimeType: 'image/png', fileSize: '16' }]),
    );
    await storage.put(keyOf(old!.resourceUrl), png(16), 'image/png');
    await admin.query(
      "UPDATE files.files SET created_at = now() - interval '25 hours' WHERE key = $1",
      [keyOf(old!.resourceUrl)],
    );
    unwrap(await stage([{ filename: 'new.png', mimeType: 'image/png', fileSize: '16' }]));
    const { rows } = await admin.query<{ filename: string }>('SELECT filename FROM files.files');
    expect(rows).toEqual([{ filename: 'new.png' }]);
    expect(await storage.head(keyOf(old!.resourceUrl))).toBeNull();
  });
});
