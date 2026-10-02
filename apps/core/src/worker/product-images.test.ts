import 'reflect-metadata';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TenantContext } from '@hatti/api';
import { MediaProcessing, MediaService, ProductService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import type { FetchResult } from '@hatti/images';
import { LocalStorage } from '@hatti/storage';
import pg from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IMAGE_ATTEMPTS, ProductImages, imageRetryDelayMs } from './product-images.js';

const server = testDatabaseServer();

describe.skipIf(!server)("The worker's product images (ADR-158)", () => {
  let testDb: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  let directory: string;
  let storage: LocalStorage;
  let products: ProductService;
  let media: MediaService;
  const tenant: TenantContext = {
    shopId: newId(),
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_products']),
  };
  /** What the fetcher answers next, by URL. */
  let answers: Record<string, () => Promise<FetchResult>> = {};
  const fetched: string[] = [];

  const worker = () =>
    new ProductImages({
      processing: new MediaProcessing(database),
      storage,
      fetcher: {
        fetch: async (url) => {
          fetched.push(url);
          return answers[url]!();
        },
      },
    });

  /** A product with one image, from `source`; its media's ID. */
  async function imageFrom(source: string): Promise<string> {
    const product = await products.create(tenant, { title: 'Lawn Kurta' });
    if (!product.ok) throw new Error('no product');
    const created = await media.create(tenant, product.value.id, [{ originalSource: source }]);
    if (!created.ok) throw new Error(JSON.stringify(created.errors));
    return created.value.mediaIds[0]!;
  }

  const row = async (id: string) =>
    (
      await admin.query<{
        status: string;
        attempts: number;
        next_attempt_at: Date | null;
        error_code: string | null;
        error_message: string | null;
      }>(
        `SELECT status, attempts, next_attempt_at, error_code, error_message
           FROM catalog.product_media WHERE id = $1`,
        [id],
      )
    ).rows[0];

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'product-images-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [tenant.shopId]);
    directory = await mkdtemp(join(tmpdir(), 'hatti-product-images-'));
    storage = new LocalStorage({
      directory,
      baseUrl: 'http://localhost:4000/storage',
      secret: 's'.repeat(32),
    });
    products = new ProductService(database);
    media = new MediaService(database, storage);
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
    await testDb?.drop();
    await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await admin.query('DELETE FROM catalog.products; DELETE FROM catalog.media_removals');
    answers = {};
    fetched.length = 0;
  });

  it('tries a source that does not answer again, for about half an hour, then fails it', async () => {
    expect([1, 2, 3, 4, 5, 6, 10].map((attempts) => imageRetryDelayMs(attempts) / 60_000)).toEqual([
      1, 2, 4, 8, 16, 30, 30,
    ]);
    const url = 'https://cdn.example.pk/kurta.jpg';
    answers[url] = async () => ({
      ok: false,
      transient: true,
      code: 'IMAGE_DOWNLOAD_FAILURE',
      message: 'Its server answered 503 Service Unavailable',
    });
    const id = await imageFrom(url);
    let at = new Date(Date.now() + 60_000);
    for (let attempt = 1; attempt < IMAGE_ATTEMPTS; attempt++) {
      expect(await worker().sweep(at)).toEqual({ ready: 0, removed: 0 });
      const waiting = await row(id);
      expect(waiting).toMatchObject({ status: 'processing', attempts: attempt, error_code: null });
      expect(waiting!.next_attempt_at!.getTime() - at.getTime()).toBe(imageRetryDelayMs(attempt));
      // Not due again before then.
      expect(await worker().sweep(new Date(at.getTime() + 1000))).toEqual({ ready: 0, removed: 0 });
      at = waiting!.next_attempt_at!;
    }
    expect(fetched).toHaveLength(IMAGE_ATTEMPTS - 1);
    await worker().sweep(at);
    expect(await row(id)).toEqual({
      status: 'failed',
      attempts: IMAGE_ATTEMPTS,
      next_attempt_at: null,
      error_code: 'IMAGE_DOWNLOAD_FAILURE',
      error_message: 'Its server answered 503 Service Unavailable',
    });
  });

  it("fails an upload that is gone, or too large, and keeps nothing of one gone while it's made", async () => {
    const gone = await imageFrom(
      storage.locationOf(`shops/${tenant.shopId}/files/${newId()}/kurta.jpg`),
    );
    const largeKey = `shops/${tenant.shopId}/files/${newId()}/poster.jpg`;
    await storage.put(largeKey, Buffer.alloc(21 * 1024 * 1024, 1), 'image/jpeg');
    const large = await imageFrom(storage.locationOf(largeKey));
    const url = 'https://cdn.example.pk/shawl.jpg';
    const deleted = await imageFrom(url);
    answers[url] = async () => {
      // The merchant deletes the product while its image is fetched.
      await admin.query(
        'DELETE FROM catalog.products WHERE id = (SELECT product_id FROM catalog.product_media WHERE id = $1)',
        [deleted],
      );
      const body = await sharp({
        create: { width: 40, height: 30, channels: 3, background: '#335577' },
      })
        .jpeg()
        .toBuffer();
      return { ok: true, body };
    };

    expect(await worker().sweep(new Date(Date.now() + 60_000))).toEqual({ ready: 0, removed: 1 });
    expect(await row(gone)).toMatchObject({
      status: 'failed',
      error_code: 'IMAGE_DOWNLOAD_FAILURE',
      error_message: 'The uploaded file is gone: upload it again',
    });
    expect(await row(large)).toMatchObject({
      status: 'failed',
      error_code: 'INVALID_IMAGE_FILE_SIZE',
      error_message: 'The image is over 20 MB',
    });
    // Its clean copy went with it, and its removal was done in the same round.
    expect(await row(deleted)).toBeUndefined();
    expect(await storage.head(`shops/${tenant.shopId}/images/${deleted}/clean.jpg`)).toBeNull();
    expect(
      (await admin.query('SELECT count(*)::int AS left FROM catalog.media_removals')).rows[0],
    ).toEqual({ left: 0 });
  });
});
