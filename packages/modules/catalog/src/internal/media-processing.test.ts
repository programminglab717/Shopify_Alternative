import 'reflect-metadata';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { LocalStorage } from '@hatti/storage';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { imagePathOf, parseImagePath } from './images.js';
import { MediaProcessing } from './media-processing.js';
import { MediaService } from './media.service.js';
import { catalogFixture, errorsOf, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('product images (ADR-158)', () => {
  let f: CatalogFixture;
  let processing: MediaProcessing;
  // A minute ahead of the clock: what each test adds is due by then.
  let now = new Date();
  const later = (seconds: number) => new Date(now.getTime() + seconds * 1000);
  const LEASE = 60_000;

  const product = async (tenant = f.a, title = 'Lawn Kurta', images = 3) => {
    const created = unwrap(await f.products.create(tenant, { title }));
    const { mediaIds } = unwrap(
      await f.media.create(
        tenant,
        created.id,
        Array.from({ length: images }, (_, index) => ({
          originalSource: `https://cdn.example.pk/${created.handle}-${index + 1}.jpg`,
        })),
      ),
    );
    return { id: created.id, mediaIds };
  };
  const mediaOf = async (productId: string, tenant = f.a) =>
    (await f.products.get(tenant, productId))!.media;

  beforeAll(async () => {
    f = await catalogFixture(server!);
    processing = new MediaProcessing(f.db);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    now = new Date(Date.now() + 60_000);
  });

  it("takes the shop's own uploads as sources, by their resource URLs", async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hatti-media-'));
    try {
      const storage = new LocalStorage({
        directory,
        baseUrl: 'http://localhost:4000/storage',
        secret: 'a'.repeat(32),
      });
      const media = new MediaService(f.db, storage);
      const { id } = unwrap(await f.products.create(f.a, { title: 'Lawn Kurta' }));
      const mine = `shops/${f.a.shopId}/files/${newId()}/kurta.jpg`;
      const created = unwrap(
        await media.create(f.a, id, [{ originalSource: storage.locationOf(mine), alt: 'Front' }]),
      );
      expect(created.product.media).toMatchObject([
        { sourceUrl: storage.locationOf(mine), sourceKey: mine, status: 'uploaded', error: null },
      ]);
      // Another shop's upload is no source of this one's, nor a file outside the shop's files.
      for (const key of [
        `shops/${f.b.shopId}/files/${newId()}/kurta.jpg`,
        `shops/${f.a.shopId}/receipts/${newId()}/receipt.jpg`,
      ]) {
        expect(
          errorsOf(await media.create(f.a, id, [{ originalSource: storage.locationOf(key) }])),
        ).toEqual([['media.0.originalSource', 'INVALID']]);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('gives the worker each image once, the first added first, until it is settled', async () => {
    const kurta = await product();
    const shawl = await product(f.b, 'Khaddar Shawl', 1);
    expect((await processing.dueShops(now)).sort()).toEqual([f.a.shopId, f.b.shopId].sort());
    const [front, back, side] = kurta.mediaIds;

    const first = await processing.claim(f.a.shopId, now, 2, LEASE);
    expect(first).toEqual([
      {
        id: front,
        productId: kurta.id,
        sourceUrl: 'https://cdn.example.pk/lawn-kurta-1.jpg',
        sourceKey: null,
        attempts: 1,
      },
      expect.objectContaining({ id: back, attempts: 1 }),
    ]);
    // Taken: not given again while its lease lasts.
    expect((await processing.claim(f.a.shopId, now, 10, LEASE)).map((media) => media.id)).toEqual([
      side,
    ]);
    expect(await processing.claim(f.a.shopId, later(30), 10, LEASE)).toEqual([]);
    expect((await mediaOf(kurta.id)).map((media) => media.status)).toEqual([
      'processing',
      'processing',
      'processing',
    ]);

    // Ready: the product changed, for the storefront to show it.
    await f.admin.query('DELETE FROM platform.outbox_events');
    const image = { format: 'jpeg' as const, width: 1200, height: 1600, size: 245_000 };
    expect(await processing.ready(f.a.shopId, front!, image)).toBe('ready');
    expect(await processing.ready(f.a.shopId, front!, image)).toBe('settled');
    const [ready] = await mediaOf(kurta.id);
    expect(ready).toMatchObject({
      status: 'ready',
      width: 1200,
      height: 1600,
      imageFormat: 'jpeg',
      imageSize: 245_000,
      error: null,
    });
    expect(imagePathOf(f.a.shopId, ready!, 'lawn-kurta')).toBe(
      `/images/${f.a.shopId}/${front}/lawn-kurta.jpg`,
    );
    expect(parseImagePath(`/images/${f.a.shopId}/${front}/lawn-kurta.jpg`)).toEqual({
      shopId: f.a.shopId,
      mediaId: front,
      format: 'jpeg',
    });
    for (const path of [
      `/images/${f.a.shopId}/${front}/../lawn-kurta.jpg`,
      `/images/${f.a.shopId}/${front}/lawn-kurta.gif`,
      `/images/${f.a.shopId}/lawn-kurta.jpg`,
    ]) {
      expect(parseImagePath(path), path).toBeNull();
    }

    // Failed, saying why.
    await processing.failed(f.a.shopId, back!, {
      code: 'UNSUPPORTED_IMAGE_FILE_TYPE',
      message: 'It is not a JPEG, PNG, WebP, GIF or AVIF image',
    });
    expect((await mediaOf(kurta.id))[1]).toMatchObject({
      status: 'failed',
      imageFormat: null,
      error: {
        code: 'UNSUPPORTED_IMAGE_FILE_TYPE',
        message: 'It is not a JPEG, PNG, WebP, GIF or AVIF image',
      },
    });
    expect(
      (await f.outbox()).map((event) => [event.event_type, event.aggregate_id, event.payload]),
    ).toEqual([
      ['product.updated', kurta.id, { changed: ['media'], version: 3 }],
      ['product.updated', kurta.id, { changed: ['media'], version: 4 }],
    ]);

    // Tried again later: given again then, its tries counted.
    await processing.retryAt(f.a.shopId, side!, later(120));
    expect(await processing.claim(f.a.shopId, later(90), 10, LEASE)).toEqual([]);
    expect(await processing.claim(f.a.shopId, later(120), 10, LEASE)).toEqual([
      expect.objectContaining({ id: side, attempts: 2 }),
    ]);
    // Its lease run out, as when a worker stops: given again.
    expect(await processing.claim(f.a.shopId, later(181), 10, LEASE)).toEqual([
      expect.objectContaining({ id: side, attempts: 3 }),
    ]);

    // The other shop's images are its own.
    expect((await processing.claim(f.b.shopId, now, 10, LEASE)).map((media) => media.id)).toEqual(
      shawl.mediaIds,
    );
    expect(await processing.dueShops(later(30))).toEqual([]);
  });

  it('records the media gone, alone or with their product, for their images to go', async () => {
    const kurta = await product();
    const [front, back, side] = kurta.mediaIds;
    unwrap(await f.media.delete(f.a, kurta.id, [front!]));
    const [claimed] = await processing.claim(f.a.shopId, now, 1, LEASE);
    expect(claimed?.id).toBe(back);
    unwrap(await f.products.delete(f.a, kurta.id));
    expect(await processing.removals(10)).toEqual(
      [front, back, side].map((mediaId) => ({ shopId: f.a.shopId, mediaId })),
    );
    // A worker that kept an image of a media gone hears so.
    expect(
      await processing.ready(f.a.shopId, back!, {
        format: 'png',
        width: 10,
        height: 10,
        size: 100,
      }),
    ).toBe('gone');
    await processing.removed(f.a.shopId, [front!, back!]);
    expect(await processing.removals(10)).toEqual([{ shopId: f.a.shopId, mediaId: side }]);
  });
});
