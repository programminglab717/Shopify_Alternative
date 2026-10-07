import 'reflect-metadata';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { LocalStorage } from '@hatti/storage';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanImageKey, imagePathOf, parseImagePath, shownSizeOf } from './images.js';
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
        mediaType: 'image',
        sourceUrl: 'https://cdn.example.pk/lawn-kurta-1.jpg',
        sourceKey: null,
        previewSourceUrl: null,
        previewSourceKey: null,
        externalVideo: null,
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
      crop: null,
      format: 'jpeg',
    });
    for (const path of [
      `/images/${f.a.shopId}/${front}/../lawn-kurta.jpg`,
      `/images/${f.a.shopId}/${front}/lawn-kurta.gif`,
      `/images/${f.a.shopId}/lawn-kurta.jpg`,
      `/images/${f.a.shopId}/${front}/crop-1-2-3/lawn-kurta.jpg`,
      `/images/${f.a.shopId}/${front}/crop-1-2-3-45678/lawn-kurta.jpg`,
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

  it('crops a ready image from its whole clean copy, and marks what matters in it (ADR-257)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hatti-crops-'));
    try {
      const storage = new LocalStorage({
        directory,
        baseUrl: 'http://localhost:4000/storage',
        secret: 'a'.repeat(32),
      });
      const media = new MediaService(f.db, storage);
      const kurta = await product(f.a, 'Lawn Kurta', 2);
      const [front, back] = kurta.mediaIds;
      // The worker made the front ready: 800 × 600, red growing across and blue down.
      const raw = Buffer.alloc(800 * 600 * 3);
      for (let at = 0; at < 800 * 600; at++) {
        raw[at * 3] = Math.round((255 * (at % 800)) / 800);
        raw[at * 3 + 2] = Math.round((255 * Math.floor(at / 800)) / 600);
      }
      const whole = await sharp(raw, { raw: { width: 800, height: 600, channels: 3 } })
        .jpeg({ quality: 100 })
        .toBuffer();
      await storage.put(cleanImageKey(f.a.shopId, front!, 'jpeg'), whole, 'image/jpeg');
      await processing.claim(f.a.shopId, now, 1, LEASE);
      await processing.ready(f.a.shopId, front!, {
        format: 'jpeg',
        width: 800,
        height: 600,
        size: whole.length,
      });

      const crop = (crop: unknown, id = front!) =>
        media.update(f.a, kurta.id, [{ id, crop: crop as never }]);
      // Refused: an image not ready yet, a crop outside the image, too small, too long, in parts
      // of pixels.
      expect(errorsOf(await crop({ left: 0, top: 0, width: 100, height: 100 }, back))).toEqual([
        ['media.0.crop', 'INVALID'],
      ]);
      for (const wrong of [
        { left: 500, top: 0, width: 400, height: 300 },
        { left: 0, top: 0, width: 15, height: 300 },
        { left: 0, top: 0, width: 800, height: 39 },
        { left: 0.5, top: 0, width: 400, height: 300 },
        { left: -1, top: 0, width: 400, height: 300 },
      ]) {
        expect(errorsOf(await crop(wrong)), JSON.stringify(wrong)).toEqual([
          ['media.0.crop', 'INVALID'],
        ]);
      }
      // Nothing made of them.
      expect(
        await storage.head(cleanImageKey(f.a.shopId, front!, 'jpeg', 'crop-500-0-400-300')),
      ).toBeNull();

      // Cropped, with what matters in it, to the hundredth.
      await f.admin.query('DELETE FROM platform.outbox_events');
      const cropped = unwrap(
        await media.update(f.a, kurta.id, [
          {
            id: front!,
            crop: { left: 400, top: 300, width: 400, height: 300 },
            focalPoint: { x: 25, y: 75.555 },
          },
        ]),
      ).media[0]!;
      expect(cropped).toMatchObject({
        width: 800,
        height: 600,
        crop: { left: 400, top: 300, width: 400, height: 300 },
        focalPoint: { x: 25, y: 75.56 },
      });
      expect(shownSizeOf(cropped)).toEqual({ width: 400, height: 300 });
      const path = imagePathOf(f.a.shopId, cropped, 'lawn-kurta');
      expect(path).toBe(`/images/${f.a.shopId}/${front}/crop-400-300-400-300/lawn-kurta.jpg`);
      expect(parseImagePath(path!)).toEqual({
        shopId: f.a.shopId,
        mediaId: front,
        crop: 'crop-400-300-400-300',
        format: 'jpeg',
      });
      // Its clean copy kept beside the whole image's, which stays as it was.
      const part = await storage.read(
        cleanImageKey(f.a.shopId, front!, 'jpeg', 'crop-400-300-400-300'),
      );
      const { data, info } = await sharp(part!.body).raw().toBuffer({ resolveWithObject: true });
      expect([info.width, info.height]).toEqual([400, 300]);
      expect(Math.abs(data[0]! - 128)).toBeLessThan(8);
      expect(Math.abs(data[2]! - 128)).toBeLessThan(8);
      expect((await storage.read(cleanImageKey(f.a.shopId, front!, 'jpeg')))!.body).toEqual(whole);
      expect((await f.outbox()).map((event) => [event.event_type, event.payload])).toEqual([
        ['product.updated', { changed: ['media'], version: 4 }],
      ]);

      // Its focal point alone; then another crop, which clears it, as it was of the image shown.
      const pointed = unwrap(
        await media.update(f.a, kurta.id, [{ id: front!, focalPoint: { x: 50, y: 10 } }]),
      ).media[0]!;
      expect([pointed.crop?.left, pointed.focalPoint]).toEqual([400, { x: 50, y: 10 }]);
      const square = unwrap(await crop({ left: 100, top: 0, width: 600, height: 600 })).media[0]!;
      expect([square.crop, square.focalPoint]).toEqual([
        { left: 100, top: 0, width: 600, height: 600 },
        null,
      ]);
      expect(
        errorsOf(
          await media.update(f.a, kurta.id, [{ id: front!, focalPoint: { x: 101, y: 50 } }]),
        ),
      ).toEqual([['media.0.focalPoint', 'INVALID']]);
      // All of it again: as a crop of all of it is.
      expect(unwrap(await crop({ left: 0, top: 0, width: 800, height: 600 })).media[0]!.crop).toBe(
        null,
      );
      unwrap(await crop({ left: 400, top: 300, width: 400, height: 300 }));
      expect(unwrap(await crop(null)).media[0]!.crop).toBeNull();
      // Another shop crops none of the shop's.
      expect(errorsOf(await media.update(f.b, kurta.id, [{ id: front!, crop: null }]))).toEqual([
        ['productId', 'NOT_FOUND'],
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('adds YouTube and Vimeo videos by their addresses, and uploaded ones with a preview image (ADR-258)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hatti-videos-'));
    try {
      const storage = new LocalStorage({
        directory,
        baseUrl: 'http://localhost:4000/storage',
        secret: 'a'.repeat(32),
      });
      const media = new MediaService(f.db, storage);
      const { id } = unwrap(await f.products.create(f.a, { title: 'Lawn Kurta' }));
      const upload = (name: string) =>
        storage.locationOf(`shops/${f.a.shopId}/files/${newId()}/${name}`);
      const video = upload('kurta.mov');
      const created = unwrap(
        await media.create(f.a, id, [
          {
            originalSource: 'https://youtu.be/dQw4w9WgXcQ?si=share',
            mediaContentType: 'EXTERNAL_VIDEO',
          },
          {
            originalSource: 'https://vimeo.com/channels/staffpicks/76979871',
            mediaContentType: 'EXTERNAL_VIDEO',
            previewImageSource: 'https://cdn.example.pk/cover.jpg',
          },
          {
            originalSource: video,
            mediaContentType: 'VIDEO',
            previewImageSource: upload('frame.jpg'),
            alt: 'Kurta, turning',
          },
        ]),
      );
      expect(created.product.media).toMatchObject([
        {
          mediaType: 'external_video',
          sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          externalVideo: { host: 'youtube', id: 'dQw4w9WgXcQ' },
          previewSourceUrl: null,
          status: 'uploaded',
        },
        {
          mediaType: 'external_video',
          sourceUrl: 'https://vimeo.com/76979871',
          externalVideo: { host: 'vimeo', id: '76979871' },
          previewSourceUrl: 'https://cdn.example.pk/cover.jpg',
          previewSourceKey: null,
        },
        {
          mediaType: 'video',
          sourceUrl: video,
          sourceKey: storage.keyOf(video),
          previewSourceKey: expect.stringMatching(/\/frame\.jpg$/),
          alt: 'Kurta, turning',
          video: null,
        },
      ]);
      // Refused: another site's video, a video by URL or an upload not a video, one without its
      // preview, and an image with one.
      expect(
        errorsOf(
          await media.create(f.a, id, [
            { originalSource: 'https://example.com/watch?v=1', mediaContentType: 'EXTERNAL_VIDEO' },
            {
              originalSource: 'https://cdn.example.pk/kurta.mp4',
              mediaContentType: 'VIDEO',
              previewImageSource: 'https://cdn.example.pk/cover.jpg',
            },
            { originalSource: upload('kurta.mp4'), mediaContentType: 'VIDEO' },
            {
              originalSource: upload('photo.jpg'),
              mediaContentType: 'VIDEO',
              previewImageSource: 'https://cdn.example.pk/cover.jpg',
            },
            {
              originalSource: 'https://cdn.example.pk/kurta.jpg',
              previewImageSource: 'https://cdn.example.pk/cover.jpg',
            },
          ]),
        ),
      ).toEqual([
        ['media.0.originalSource', 'INVALID'],
        ['media.1.originalSource', 'INVALID'],
        ['media.2.previewImageSource', 'BLANK'],
        ['media.3.originalSource', 'INVALID'],
        ['media.4.previewImageSource', 'INVALID'],
      ]);

      // The worker takes them with what it needs; an uploaded video ready with its own facts.
      const [youtube, vimeo, uploaded] = created.mediaIds;
      const claimed = await processing.claim(f.a.shopId, now, 10, LEASE);
      expect(claimed).toMatchObject([
        { id: youtube, mediaType: 'external_video', externalVideo: { host: 'youtube' } },
        { id: vimeo, previewSourceUrl: 'https://cdn.example.pk/cover.jpg' },
        { id: uploaded, mediaType: 'video', sourceKey: storage.keyOf(video) },
      ]);
      const preview = { format: 'jpeg' as const, width: 1080, height: 1920, size: 90_000 };
      const facts = { size: 4_000_000, width: 1080, height: 1920, durationMs: 12_000 };
      expect(await processing.ready(f.a.shopId, uploaded!, preview, facts)).toBe('ready');
      const ready = (await mediaOf(id))[2]!;
      expect([ready.status, ready.video, ready.width]).toEqual(['ready', facts, 1080]);

      // A video is neither cropped, nor marked, nor a variant's image.
      expect(
        errorsOf(
          await media.update(f.a, id, [
            { id: uploaded!, crop: { left: 0, top: 0, width: 500, height: 500 } },
          ]),
        ),
      ).toEqual([['media.0.crop', 'INVALID']]);
      expect(
        errorsOf(await media.update(f.a, id, [{ id: uploaded!, focalPoint: { x: 10, y: 10 } }])),
      ).toEqual([['media.0.focalPoint', 'INVALID']]);
      const [variant] = (await f.products.get(f.a, id))!.variants;
      expect(
        errorsOf(await f.variants.bulkUpdate(f.a, id, [{ id: variant!.id, mediaId: uploaded! }])),
      ).toEqual([['variants.0.mediaId', 'INVALID']]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
