import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { MediaProcessing } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId } from '@hatti/ids';
import type { FetchResult } from '@hatti/images';
import pg from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { phoneVideo } from '../testing/videos.js';
import { ProductImages } from '../worker/product-images.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const MEDIA = `query ($id: ID!) {
  product(id: $id) {
    media {
      id status sourceUrl width height
      image { url width height altText }
      mediaErrors { code message }
    }
  }
}`;

const CHROME = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';

/** A phone's photo: 300 × 200 as stored, held upright, with where it was taken. */
const photo = () =>
  sharp({ create: { width: 300, height: 200, channels: 3, background: '#7a1f3d' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExifMerge({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '24/1 51/1 36/1' } })
    .toBuffer();

describe.skipIf(!server)("Products' images: uploaded or fetched, checked, served", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let worker: Database;
  let token: string;
  const shop = newId();
  const purged: string[] = [];

  async function gql(query: string, variables?: Record<string, unknown>) {
    const response = await api.app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token, 'idempotency-key': newId() },
      payload: { query, variables },
    });
    const body = response.json() as { data?: Record<string, Json> | null; errors?: Json[] };
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  /** The worker's images, fetching from no network: the test's images by URL. */
  const images = (sources: Record<string, Buffer>) =>
    new ProductImages({
      processing: new MediaProcessing(worker),
      storage: api.storage,
      fetcher: {
        fetch: async (url): Promise<FetchResult> =>
          sources[url]
            ? { ok: true, body: sources[url] }
            : { ok: false, transient: false, code: 'IMAGE_DOWNLOAD_FAILURE', message: 'Not here' },
      },
      edge: { purge: async (tags) => void purged.push(...tags) },
    });

  const get = (url: string, accept?: string) =>
    api.app.inject({
      method: 'GET',
      url: url.replace('http://localhost:4000', ''),
      headers: accept ? { accept } : {},
    });

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    const issued = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, '{write_products,write_files}')`,
      [shop, issued.hash, issued.hint],
    );
    token = issued.token;
    api = await startTestApi(testDb);
    worker = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'images-test:worker',
    });
  });

  afterAll(async () => {
    await worker?.close();
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('makes uploads and URLs ready, says why one failed, and serves each as browsers ask', async () => {
    const product = (
      await gql('mutation { productCreate(input: { title: "Lawn Kurta" }) { product { id } } }')
    ).product;
    // The phone's photo, uploaded straight to storage.
    const taken = await photo();
    const staged = await gql(
      `mutation ($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl } } }`,
      {
        input: [{ filename: 'kurta.jpg', mimeType: 'image/jpeg', fileSize: String(taken.length) }],
      },
    );
    const [target] = staged.stagedTargets;
    const put = await api.app.inject({
      method: 'PUT',
      url: target.url.replace('http://localhost:4000', ''),
      payload: taken,
      headers: { 'content-type': 'image/jpeg' },
    });
    expect(put.statusCode).toBe(200);
    const back = await sharp({
      create: { width: 900, height: 1200, channels: 3, background: '#1f3d7a' },
    })
      .png()
      .toBuffer();
    const created = await gql(
      `mutation ($id: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $id, media: $media) {
          media { id status image { url } mediaErrors { code } } userErrors { field code } } }`,
      {
        id: product.id,
        media: [
          { originalSource: target.resourceUrl, alt: 'Front' },
          { originalSource: 'https://cdn.example.pk/back.png' },
          { originalSource: 'https://cdn.example.pk/size-chart.pdf' },
        ],
      },
    );
    expect(created.userErrors).toEqual([]);
    expect(created.media).toEqual(
      created.media.map((media: Json) => ({
        id: media.id,
        status: 'UPLOADED',
        image: null,
        mediaErrors: [],
      })),
    );

    const later = new Date(Date.now() + 60_000);
    const ready = await images({
      'https://cdn.example.pk/back.png': back,
      'https://cdn.example.pk/size-chart.pdf': Buffer.from('%PDF-1.7 a size chart'),
    }).process(shop, later);
    expect(ready).toBe(2);

    const [front, behind, chart] = (await gql(MEDIA, { id: product.id })).media;
    const frontId = fromPublicId(front.id, 'media');
    expect(front).toEqual({
      id: front.id,
      status: 'READY',
      sourceUrl: target.resourceUrl,
      // Turned as the phone was held.
      width: 200,
      height: 300,
      image: {
        url: `http://localhost:4000/images/${shop}/${frontId}/lawn-kurta.jpg`,
        width: 200,
        height: 300,
        altText: 'Front',
      },
      mediaErrors: [],
    });
    expect(behind).toMatchObject({
      status: 'READY',
      image: {
        url: `http://localhost:4000/images/${shop}/${fromPublicId(behind.id, 'media')}/lawn-kurta.jpg`,
        width: 900,
        height: 1200,
        altText: null,
      },
    });
    expect(chart).toMatchObject({
      status: 'FAILED',
      image: null,
      mediaErrors: [
        {
          code: 'UNSUPPORTED_IMAGE_FILE_TYPE',
          message: 'It is not a JPEG, PNG, WebP, GIF or AVIF image',
        },
      ],
    });

    // Its clean copy, as a crawler fetching a link's preview asks: JPEG, nothing of the phone's.
    const clean = await get(front.image.url);
    expect(clean.statusCode).toBe(200);
    expect(clean.headers).toMatchObject({
      'content-type': 'image/jpeg',
      'cache-control': 'public, max-age=31536000, immutable',
      vary: 'Accept',
      'cache-tag': `hatti:${shop}:image:${frontId}`,
      'x-content-type-options': 'nosniff',
    });
    const cleanly = await sharp(clean.rawPayload).metadata();
    expect([cleanly.width, cleanly.height, cleanly.exif, cleanly.orientation]).toEqual([
      200,
      300,
      undefined,
      undefined,
    ]);

    // A browser asking for 165 pixels gets AVIF at 192, made once and kept.
    const small = await get(`${front.image.url}?width=165`, CHROME);
    expect(small.headers['content-type']).toBe('image/avif');
    const smallSize = await sharp(small.rawPayload).metadata();
    expect([smallSize.format, smallSize.width, smallSize.height]).toEqual(['heif', 192, 288]);
    expect(await api.storage.head(`shops/${shop}/images/${frontId}/192.avif`)).not.toBeNull();
    const again = await get(`${front.image.url}?width=192`, CHROME);
    expect(again.rawPayload.equals(small.rawPayload)).toBe(true);
    // WebP where AVIF is not taken; never wider than the image.
    const wide = await get(`${front.image.url}?width=4000`, 'image/webp,*/*');
    expect(wide.headers['content-type']).toBe('image/webp');
    expect((await sharp(wide.rawPayload).metadata()).width).toBe(200);

    // Nothing else of storage is served here.
    for (const url of [
      `/images/${shop}/${newId()}/lawn-kurta.jpg`,
      `/images/${shop}/${frontId}/lawn-kurta.png`,
      `/images/${shop}/${frontId}/clean.jpg/../../files/x`,
      `/images/${shop}/${frontId}`,
    ]) {
      expect((await get(url)).statusCode, url).toBe(404);
    }

    // Deleted: its images go from storage and the edge.
    await gql(
      `mutation ($id: ID!, $ids: [ID!]!) {
        productDeleteMedia(productId: $id, mediaIds: $ids) { deletedMediaIds } }`,
      { id: product.id, ids: [front.id] },
    );
    expect(await images({}).remove()).toBe(1);
    expect(purged).toEqual([`hatti:${shop}:image:${frontId}`]);
    expect(await api.storage.head(`shops/${shop}/images/${frontId}/clean.jpg`)).toBeNull();
    expect(await api.storage.head(`shops/${shop}/images/${frontId}/192.avif`)).toBeNull();
    expect((await get(front.image.url)).statusCode).toBe(404);
    expect((await get(behind.image.url)).statusCode).toBe(200);
    expect(await images({}).remove()).toBe(0);
  });

  it('crops an image through the Admin API, serving the crop at every size and keeping the whole (ADR-257)', async () => {
    const product = (
      await gql('mutation { productCreate(input: { title: "Khaddar Shawl" }) { product { id } } }')
    ).product;
    const whole = await sharp({
      create: { width: 800, height: 600, channels: 3, background: '#3d7a1f' },
    })
      .jpeg()
      .toBuffer();
    const created = await gql(
      `mutation ($id: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $id, media: $media) { media { id } userErrors { field } } }`,
      { id: product.id, media: [{ originalSource: 'https://cdn.example.pk/shawl.jpg' }] },
    );
    const mediaId = created.media[0].id as string;
    const uuid = fromPublicId(mediaId, 'media');
    await images({ 'https://cdn.example.pk/shawl.jpg': whole }).process(
      shop,
      new Date(Date.now() + 60_000),
    );

    const UPDATE = `mutation ($id: ID!, $media: [UpdateMediaInput!]!) {
      productUpdateMedia(productId: $id, media: $media) {
        product { media { crop { left top width height } focalPoint { x y }
          image { url width height } wholeImage { url width height } } }
        userErrors { field code message } } }`;
    const refused = await gql(UPDATE, {
      id: product.id,
      media: [{ id: mediaId, crop: { left: 500, top: 0, width: 400, height: 300 } }],
    });
    expect(refused.userErrors).toEqual([
      {
        field: ['media', '0', 'crop'],
        code: 'INVALID',
        message: "Crop within the image's 800 × 600 pixels",
      },
    ]);
    const cropped = await gql(UPDATE, {
      id: product.id,
      media: [
        {
          id: mediaId,
          crop: { left: 400, top: 300, width: 400, height: 300 },
          focalPoint: { x: 25, y: 75 },
        },
      ],
    });
    expect(cropped.userErrors).toEqual([]);
    const base = `http://localhost:4000/images/${shop}/${uuid}`;
    expect(cropped.product.media[0]).toEqual({
      crop: { left: 400, top: 300, width: 400, height: 300 },
      focalPoint: { x: 25, y: 75 },
      image: { url: `${base}/crop-400-300-400-300/khaddar-shawl.jpg`, width: 400, height: 300 },
      wholeImage: { url: `${base}/khaddar-shawl.jpg`, width: 800, height: 600 },
    });

    // The crop at its own size, and smaller in AVIF; the whole as it was.
    const { image, wholeImage } = cropped.product.media[0];
    const shown = await get(image.url);
    expect([shown.statusCode, shown.headers['content-type']]).toEqual([200, 'image/jpeg']);
    const shownSize = await sharp(shown.rawPayload).metadata();
    expect([shownSize.width, shownSize.height]).toEqual([400, 300]);
    const small = await get(`${image.url}?width=165`, CHROME);
    const smallSize = await sharp(small.rawPayload).metadata();
    expect([smallSize.format, smallSize.width, smallSize.height]).toEqual(['heif', 192, 144]);
    expect(
      await api.storage.head(`shops/${shop}/images/${uuid}/crop-400-300-400-300/192.avif`),
    ).not.toBeNull();
    const wholeSize = await sharp((await get(wholeImage.url)).rawPayload).metadata();
    expect([wholeSize.width, wholeSize.height]).toEqual([800, 600]);
    // No crop the shop did not make.
    expect((await get(`${base}/crop-0-0-100-100/khaddar-shawl.jpg`)).statusCode).toBe(404);

    // Gone with its media, crops and all.
    await gql(
      `mutation ($id: ID!, $ids: [ID!]!) {
        productDeleteMedia(productId: $id, mediaIds: $ids) { deletedMediaIds } }`,
      { id: product.id, ids: [mediaId] },
    );
    await images({}).remove();
    expect(
      await api.storage.head(`shops/${shop}/images/${uuid}/crop-400-300-400-300/clean.jpg`),
    ).toBeNull();
    expect((await get(image.url)).statusCode).toBe(404);
  });

  it("takes a product's videos, uploaded or YouTube's, and plays an uploaded one a range at a time (ADR-258)", async () => {
    const product = (
      await gql(
        'mutation { productCreate(input: { title: "Chikankari Kurta" }) { product { id } } }',
      )
    ).product;
    const video = phoneVideo('avc1');
    const staged = await gql(
      `mutation ($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl } userErrors { field } } }`,
      {
        input: [
          { filename: 'Kurta.MOV', mimeType: 'video/quicktime', fileSize: String(video.length) },
        ],
      },
    );
    const [target] = staged.stagedTargets;
    const put = await api.app.inject({
      method: 'PUT',
      url: target.url.replace('http://localhost:4000', ''),
      payload: video,
      headers: { 'content-type': 'video/quicktime' },
    });
    expect(put.statusCode).toBe(200);
    const created = await gql(
      `mutation ($id: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $id, media: $media) {
          media { id mediaContentType status } userErrors { field code } } }`,
      {
        id: product.id,
        media: [
          {
            originalSource: target.resourceUrl,
            mediaContentType: 'VIDEO',
            previewImageSource: 'https://cdn.example.pk/frame.jpg',
            alt: 'Kurta, turning',
          },
          {
            originalSource: 'https://www.youtube.com/shorts/dQw4w9WgXcQ',
            mediaContentType: 'EXTERNAL_VIDEO',
          },
        ],
      },
    );
    expect(created.userErrors).toEqual([]);
    expect(created.media.map((media: Json) => media.mediaContentType)).toEqual([
      'VIDEO',
      'EXTERNAL_VIDEO',
    ]);
    const frame = await sharp({
      create: { width: 90, height: 160, channels: 3, background: '#7a1f3d' },
    })
      .jpeg()
      .toBuffer();
    await images({
      'https://cdn.example.pk/frame.jpg': frame,
      'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg': frame,
    }).process(shop, new Date(Date.now() + 60_000));

    const [uploaded, youtube] = (
      await gql(
        `query ($id: ID!) { product(id: $id) { media {
          id mediaContentType status alt image { url } previewImage { url width height }
          video { duration sources { url mimeType format width height fileSize } }
          externalVideo { host externalId originUrl embedUrl } } } }`,
        { id: product.id },
      )
    ).media;
    const uuid = fromPublicId(uploaded.id, 'media');
    expect(uploaded).toMatchObject({
      mediaContentType: 'VIDEO',
      status: 'READY',
      alt: 'Kurta, turning',
      image: null,
      previewImage: {
        url: `http://localhost:4000/images/${shop}/${uuid}/chikankari-kurta.jpg`,
        width: 90,
        height: 160,
      },
      video: {
        duration: 12_000,
        sources: [
          {
            url: `http://localhost:4000/videos/${shop}/${uuid}/chikankari-kurta.mp4`,
            mimeType: 'video/mp4',
            format: 'mp4',
            width: 1080,
            height: 1920,
            fileSize: video.length,
          },
        ],
      },
      externalVideo: null,
    });
    expect(youtube).toMatchObject({
      mediaContentType: 'EXTERNAL_VIDEO',
      status: 'READY',
      video: null,
      externalVideo: {
        host: 'YOUTUBE',
        externalId: 'dQw4w9WgXcQ',
        originUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
      },
    });

    // Whole, then a range at a time as a browser's player asks, never past its end.
    const { url } = uploaded.video.sources[0];
    const whole = await get(url);
    expect([
      whole.statusCode,
      whole.headers['content-type'],
      whole.headers['accept-ranges'],
    ]).toEqual([200, 'video/mp4', 'bytes']);
    expect(whole.rawPayload.length).toBe(video.length);
    expect(whole.headers).toMatchObject({
      'cache-control': 'public, max-age=31536000, immutable',
      'cache-tag': `hatti:${shop}:image:${uuid}`,
    });
    const ranged = (range: string) =>
      api.app.inject({
        method: 'GET',
        url: url.replace('http://localhost:4000', ''),
        headers: { range },
      });
    const first = await ranged('bytes=0-7');
    expect([first.statusCode, first.headers['content-range'], first.rawPayload.length]).toEqual([
      206,
      `bytes 0-7/${video.length}`,
      8,
    ]);
    expect(first.rawPayload.toString('latin1', 4, 8)).toBe('ftyp');
    const rest = await ranged(`bytes=${video.length - 4}-`);
    expect(rest.headers['content-range']).toBe(
      `bytes ${video.length - 4}-${video.length - 1}/${video.length}`,
    );
    expect((await ranged(`bytes=${video.length}-`)).statusCode).toBe(416);
    expect((await get(`/videos/${shop}/${newId()}/chikankari-kurta.mp4`)).statusCode).toBe(404);

    // Gone with its media.
    await gql(
      `mutation ($id: ID!, $ids: [ID!]!) {
        productDeleteMedia(productId: $id, mediaIds: $ids) { deletedMediaIds } }`,
      { id: product.id, ids: [uploaded.id] },
    );
    await images({}).remove();
    expect((await get(url)).statusCode).toBe(404);
  });
});
