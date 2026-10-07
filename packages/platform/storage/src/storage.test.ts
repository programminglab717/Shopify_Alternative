import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extensionOf, sniffContentType } from './file-types.js';
import { LocalStorage } from './local-storage.js';
import { isObjectKey, maxUploadBytesOf } from './object-storage.js';
import { S3Storage } from './s3-storage.js';

/** What a stream gives, whole. */
async function text(stream: Readable | null): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

const KEY = 'shops/0196/files/0197/receipt.jpg';
const NOW = new Date('2026-10-01T09:00:00Z');

/** The query of `url`, as a route gets it. */
const queryOf = (url: string) => Object.fromEntries(new URL(url).searchParams);

describe('object keys', () => {
  it('are paths of plain segments', () => {
    expect(isObjectKey(KEY)).toBe(true);
    for (const key of ['', '/shops/a', 'shops/../a', 'shops/./a', 'shops//a', 'a b', '.hidden']) {
      expect(isObjectKey(key), key).toBe(false);
    }
  });
});

describe('file types', () => {
  it('are told by their first bytes, whatever a name or a browser says', () => {
    const bytes = (...values: (number | string)[]) =>
      Buffer.concat(
        values.map((value) => Buffer.from(typeof value === 'string' ? value : [value])),
      );
    expect(sniffContentType(bytes(0xff, 0xd8, 0xff, 0xdb))).toBe('image/jpeg');
    expect(sniffContentType(bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
    expect(sniffContentType(bytes('RIFF', 0x24, 0, 0, 0, 'WEBPVP8 '))).toBe('image/webp');
    expect(sniffContentType(bytes('GIF87a'))).toBe('image/gif');
    expect(sniffContentType(bytes('%PDF-1.4'))).toBe('application/pdf');
    // A sound in RIFF, a page, a cut-off signature: none of them.
    for (const start of [
      bytes('RIFF', 0x24, 0, 0, 0, 'WAVE'),
      bytes('<html>'),
      bytes(0x89, 'PN'),
    ]) {
      expect(sniffContentType(start)).toBeNull();
    }
    expect(extensionOf('image/jpeg')).toBe('jpg');
    expect(extensionOf('application/pdf')).toBe('pdf');
  });

  it("take phones' videos by their first box's brand, and a HEIC photo for none (ADR-258)", () => {
    const box = (brand: string) =>
      Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from(`ftyp${brand}`)]);
    expect(sniffContentType(box('isom'))).toBe('video/mp4');
    expect(sniffContentType(box('mp42'))).toBe('video/mp4');
    expect(sniffContentType(box('qt  '))).toBe('video/quicktime');
    for (const brand of ['heic', 'mif1', 'avif', 'abcd']) {
      expect(sniffContentType(box(brand)), brand).toBeNull();
    }
    expect([extensionOf('video/mp4'), extensionOf('video/quicktime')]).toEqual(['mp4', 'mov']);
    expect([maxUploadBytesOf('video/mp4'), maxUploadBytesOf('image/jpeg')]).toEqual([
      100 * 1024 * 1024,
      20 * 1024 * 1024,
    ]);
  });
});

describe('LocalStorage', () => {
  let directory: string;
  let now = NOW;
  let storage: LocalStorage;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hatti-storage-'));
    storage = new LocalStorage({
      directory,
      baseUrl: 'http://localhost:4000/storage/',
      secret: 'a'.repeat(32),
      now: () => now,
    });
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('signs uploads and downloads that only it accepts, until they expire', () => {
    const upload = storage.signUpload(KEY, { contentType: 'image/jpeg', contentLength: 5 }, 600);
    expect(upload.url.startsWith(`http://localhost:4000/storage/${KEY}?`)).toBe(true);
    expect(upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/jpeg' } });
    const query = queryOf(upload.url);
    expect(storage.verify('PUT', KEY, query)).toEqual({
      method: 'PUT',
      contentType: 'image/jpeg',
      contentLength: 5,
    });
    // Another size, type, key or way, or a field added, and it is no one's.
    expect(storage.verify('PUT', KEY, { ...query, length: '6' })).toBeNull();
    expect(storage.verify('PUT', KEY, { ...query, type: 'text/html' })).toBeNull();
    expect(storage.verify('PUT', 'shops/0196/files/0197/other.jpg', query)).toBeNull();
    expect(storage.verify('GET', KEY, query)).toBeNull();
    expect(storage.verify('PUT', KEY, { ...query, extra: '1' })).toBeNull();

    const download = storage.signDownload(KEY, 60, { filename: 'Receipt 12.jpg' });
    expect(storage.verify('GET', KEY, queryOf(download))).toEqual({
      method: 'GET',
      filename: 'Receipt 12.jpg',
    });
    now = new Date(NOW.getTime() + 61_000);
    expect(storage.verify('GET', KEY, queryOf(download))).toBeNull();
    expect(storage.verify('PUT', KEY, query)).not.toBeNull();
    now = NOW;
  });

  it('keeps files with their types, and names them by location', async () => {
    expect(await storage.head(KEY)).toBeNull();
    expect(await storage.readStart(KEY, 4)).toBeNull();
    await storage.put(KEY, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01]), 'image/jpeg');
    expect(await storage.head(KEY)).toEqual({ size: 5, contentType: 'image/jpeg' });
    expect([...(await storage.readStart(KEY, 3))!]).toEqual([0xff, 0xd8, 0xff]);
    expect((await storage.read(KEY))?.contentType).toBe('image/jpeg');
    expect(storage.keyOf(storage.locationOf(KEY))).toBe(KEY);
    expect(storage.keyOf('http://localhost:4000/storage/shops/../etc/passwd')).toBeNull();
    expect(storage.keyOf('https://example.com/storage/shops/a')).toBeNull();
    await storage.delete(KEY);
    expect(await storage.head(KEY)).toBeNull();
    await storage.delete(KEY);
  });

  it('reads a file as it streams, the range asked for alone', async () => {
    const video = 'shops/0196/images/0199/video.mp4';
    expect(await storage.stream(video)).toBeNull();
    await storage.put(video, Buffer.from('0123456789'), 'video/mp4');
    expect((await text(await storage.stream(video))).toString()).toBe('0123456789');
    expect((await text(await storage.stream(video, { start: 2, end: 5 }))).toString()).toBe('2345');
    expect((await text(await storage.stream(video, { start: 9, end: 9 }))).toString()).toBe('9');
  });

  it('removes everything under a prefix, and nothing beside it', async () => {
    const prefix = 'shops/0196/images/0198/';
    for (const name of ['clean.jpg', '540.webp', '540.avif']) {
      await storage.put(`${prefix}${name}`, Buffer.from(name), 'image/jpeg');
    }
    await storage.put('shops/0196/images/01980/clean.jpg', Buffer.from('beside'), 'image/jpeg');
    await storage.deletePrefix(prefix);
    expect(await storage.read(`${prefix}clean.jpg`)).toBeNull();
    expect(await storage.head(`${prefix}540.avif`)).toBeNull();
    expect((await storage.read('shops/0196/images/01980/clean.jpg'))?.body.toString()).toBe(
      'beside',
    );
    // Nothing there: nothing to do.
    await storage.deletePrefix(prefix);
    for (const bad of ['shops/0196/images/0198', '/shops/', 'shops/../', '']) {
      await expect(storage.deletePrefix(bad), bad).rejects.toThrow('Not an object prefix');
    }
  });
});

describe('S3Storage', () => {
  interface Sent {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: Uint8Array;
  }

  function storageWith(respond: (sent: Sent) => Response) {
    const sent: Sent[] = [];
    const storage = new S3Storage({
      endpoint: 'https://acct.r2.cloudflarestorage.com/',
      bucket: 'hatti-files',
      region: 'auto',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET' },
      now: () => NOW,
      fetch: (async (url: URL, init: RequestInit) => {
        const request = {
          url: String(url),
          method: init.method ?? 'GET',
          headers: init.headers as Record<string, string>,
          body: init.body as Uint8Array | undefined,
        };
        sent.push(request);
        return respond(request);
      }) as typeof fetch,
    });
    return { storage, sent };
  }

  it('signs uploads for their size and type, and downloads to show by name', () => {
    const { storage } = storageWith(() => new Response(null));
    const upload = storage.signUpload(KEY, { contentType: 'image/png', contentLength: 2048 }, 900);
    const query = queryOf(upload.url);
    expect(upload.url.startsWith(`https://acct.r2.cloudflarestorage.com/hatti-files/${KEY}?`)).toBe(
      true,
    );
    expect(query).toMatchObject({
      'X-Amz-Credential': 'AKID/20261001/auto/s3/aws4_request',
      'X-Amz-Expires': '900',
      'X-Amz-SignedHeaders': 'content-length;content-type;host',
    });
    expect(upload.headers).toEqual({ 'content-type': 'image/png' });
    const download = storage.signDownload(KEY, 300, { filename: 'رسید.jpg' });
    expect(queryOf(download)['response-content-disposition']).toBe(
      `inline; filename="____.jpg"; filename*=UTF-8''%D8%B1%D8%B3%DB%8C%D8%AF.jpg`,
    );
    expect(storage.keyOf(storage.locationOf(KEY))).toBe(KEY);
    expect(storage.keyOf('https://acct.r2.cloudflarestorage.com/other/x')).toBeNull();
  });

  it('reads, writes and removes objects through signed requests', async () => {
    const { storage, sent } = storageWith((request) =>
      request.method === 'HEAD'
        ? request.url.endsWith('missing.jpg')
          ? new Response(null, { status: 404 })
          : new Response(null, { headers: { 'content-length': '5', 'content-type': 'image/jpeg' } })
        : request.method === 'GET'
          ? new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 206 })
          : new Response(null, { status: request.method === 'DELETE' ? 204 : 200 }),
    );
    expect(await storage.head(KEY)).toEqual({ size: 5, contentType: 'image/jpeg' });
    expect(await storage.head('shops/a/missing.jpg')).toBeNull();
    expect([...(await storage.readStart(KEY, 3))!]).toEqual([0xff, 0xd8, 0xff]);
    await storage.put(KEY, Buffer.from('hello'), 'text/plain');
    await storage.delete(KEY);
    expect(sent.map((request) => request.method)).toEqual(['HEAD', 'HEAD', 'GET', 'PUT', 'DELETE']);
    expect(sent[2]!.headers.range).toBe('bytes=0-2');
    const put = sent[3]!;
    expect(put.headers).toMatchObject({
      'content-type': 'text/plain',
      'content-length': '5',
      'x-amz-content-sha256': '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    });
    expect(put.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKID\/20261001\/auto\/s3\/aws4_request, SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    await expect(
      storageWith(() => new Response('denied', { status: 403 })).storage.head(KEY),
    ).rejects.toThrow(`Storage HEAD ${KEY} failed: 403`);
  });

  it('streams objects, a range asked for by its header', async () => {
    const { storage, sent } = storageWith((request) =>
      request.url.endsWith('missing.mp4')
        ? new Response(null, { status: 404 })
        : new Response(request.headers.range ? '2345' : '0123456789', {
            status: request.headers.range ? 206 : 200,
          }),
    );
    expect((await text(await storage.stream(KEY, { start: 2, end: 5 }))).toString()).toBe('2345');
    expect(sent[0]!.headers.range).toBe('bytes=2-5');
    expect((await text(await storage.stream(KEY))).toString()).toBe('0123456789');
    expect(sent[1]!.headers.range).toBeUndefined();
    expect(await storage.stream('shops/a/missing.mp4')).toBeNull();
  });

  it('reads whole objects, and removes a prefix a listing page at a time', async () => {
    const prefix = 'shops/0196/images/0198/';
    const listing = (keys: string[], next: string | null) =>
      new Response(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>hatti-files</Name>` +
          keys.map((key) => `<Contents><Key>${key}</Key><Size>3</Size></Contents>`).join('') +
          `<IsTruncated>${next !== null}</IsTruncated>` +
          (next ? `<NextContinuationToken>${next}</NextContinuationToken>` : '') +
          `</ListBucketResult>`,
      );
    const { storage, sent } = storageWith((request) => {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.searchParams.get('list-type') === '2') {
        return url.searchParams.get('continuation-token') === 'page&2'
          ? listing([`${prefix}540.avif`], null)
          : listing([`${prefix}clean.jpg`, `${prefix}540.webp`], 'page&amp;2');
      }
      if (request.method === 'GET') {
        return url.pathname.endsWith('missing.jpg')
          ? new Response(null, { status: 404 })
          : new Response('whole', { headers: { 'content-type': 'image/jpeg' } });
      }
      return new Response(null, { status: 204 });
    });
    expect(await storage.read(KEY)).toEqual({
      body: Buffer.from('whole'),
      contentType: 'image/jpeg',
    });
    expect(await storage.read('shops/a/missing.jpg')).toBeNull();
    sent.length = 0;
    await storage.deletePrefix(prefix);
    expect(
      sent.map((request) => {
        const url = new URL(request.url);
        return `${request.method} ${url.pathname}${url.search ? ` ${url.searchParams.get('continuation-token') ?? url.searchParams.get('prefix')}` : ''}`;
      }),
    ).toEqual([
      `GET /hatti-files/ ${prefix}`,
      `DELETE /hatti-files/${prefix}clean.jpg`,
      `DELETE /hatti-files/${prefix}540.webp`,
      'GET /hatti-files/ page&2',
      `DELETE /hatti-files/${prefix}540.avif`,
    ]);
    expect(sent[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
  });
});
