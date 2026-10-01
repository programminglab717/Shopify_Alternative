import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalStorage } from './local-storage.js';
import { isObjectKey } from './object-storage.js';
import { S3Storage } from './s3-storage.js';

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
});
