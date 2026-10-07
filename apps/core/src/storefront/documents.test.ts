import type { MediaRecord, ProductRecord } from '@hatti/catalog/public';
import { describe, expect, it } from 'vitest';
import { productDoc } from './documents.js';

const media = (id: string, fields: Partial<MediaRecord>): MediaRecord => ({
  id,
  productId: 'p1',
  mediaType: 'image',
  sourceUrl: `https://cdn.example.pk/${id}.jpg`,
  sourceKey: null,
  alt: '',
  position: 1,
  status: 'uploaded',
  width: null,
  height: null,
  imageFormat: null,
  imageSize: null,
  error: null,
  crop: null,
  focalPoint: null,
  previewSourceUrl: null,
  previewSourceKey: null,
  externalVideo: null,
  video: null,
  ...fields,
});

describe("products' documents", () => {
  it("show ready images from Hatti's own address, images by URL meanwhile, and no others", () => {
    const record: ProductRecord = {
      id: 'p1',
      title: 'Lawn Kurta',
      handle: 'lawn-kurta',
      status: 'active',
      description: '',
      vendor: null,
      productType: null,
      tags: [],
      seo: { title: null, description: null },
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      options: [],
      variants: [
        {
          id: 'v1',
          productId: 'p1',
          title: 'Default Title',
          sku: null,
          barcode: null,
          price: 250_000n,
          compareAtPrice: null,
          cost: null,
          weightGrams: null,
          taxable: true,
          taxCode: null,
          position: 1,
          selectedOptions: [],
          mediaId: 'ready',
        },
      ],
      media: [
        media('upload', { sourceKey: 'shops/s1/files/f1/kurta.jpg', status: 'processing' }),
        media('fetching', { status: 'processing' }),
        media('failed', {
          status: 'failed',
          error: { code: 'IMAGE_DOWNLOAD_FAILURE', message: 'Its server answered 404 Not Found' },
        }),
        media('ready', {
          status: 'ready',
          alt: 'Front',
          width: 1200,
          height: 1600,
          imageFormat: 'jpeg',
          imageSize: 245_000,
        }),
        // Cropped square, its focal point set (ADR-257).
        media('cropped', {
          status: 'ready',
          width: 1200,
          height: 1600,
          imageFormat: 'jpeg',
          imageSize: 245_000,
          crop: { left: 0, top: 200, width: 1200, height: 1200 },
          focalPoint: { x: 30, y: 40.5 },
        }),
      ],
    };
    const doc = productDoc(record, new Map(), (each, handle) =>
      each.imageFormat ? `https://hatti.pk/images/s1/${each.id}/${handle}.jpg` : null,
    );
    expect(doc.images).toEqual([
      { src: 'https://cdn.example.pk/fetching.jpg', width: 0, height: 0, alt: null },
      {
        src: 'https://hatti.pk/images/s1/ready/lawn-kurta.jpg',
        width: 1200,
        height: 1600,
        alt: 'Front',
      },
      {
        src: 'https://hatti.pk/images/s1/cropped/lawn-kurta.jpg',
        width: 1200,
        height: 1200,
        alt: null,
        focalPoint: { x: 30, y: 40.5 },
      },
    ]);
    // The variant's image, by its place among those shown.
    expect(doc.variants[0]!.image).toBe(1);
    // No video: its images are its media.
    expect(doc.media).toBeUndefined();
  });

  it("show a product's videos ready to play among its media, its images by their places (ADR-258)", () => {
    const ready = { status: 'ready' as const, imageFormat: 'jpeg' as const, imageSize: 9_000 };
    const record = {
      id: 'p1',
      title: 'Lawn Kurta',
      handle: 'lawn-kurta',
      status: 'active',
      description: '',
      vendor: null,
      productType: null,
      tags: [],
      seo: { title: null, description: null },
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      options: [],
      variants: [],
      media: [
        media('front', { ...ready, width: 1200, height: 1600 }),
        media('film', {
          ...ready,
          mediaType: 'video',
          sourceKey: 'shops/s1/files/f1/kurta.mov',
          previewSourceUrl: 'https://cdn.example.pk/frame.jpg',
          alt: 'Kurta, turning',
          width: 1080,
          height: 1920,
          video: { size: 4_000_000, width: 1080, height: 1920, durationMs: 12_000 },
        }),
        media('youtube', {
          ...ready,
          mediaType: 'external_video',
          sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          externalVideo: { host: 'youtube', id: 'dQw4w9WgXcQ' },
          width: 1280,
          height: 720,
        }),
        // Still being checked: not shown yet.
        media('later', {
          mediaType: 'video',
          status: 'processing',
          sourceKey: 'shops/s1/files/f2/x.mov',
        }),
        media('back', { ...ready, width: 1200, height: 1600 }),
      ],
    } as ProductRecord;
    const doc = productDoc(
      record,
      new Map(),
      (each, handle) =>
        each.imageFormat ? `https://hatti.pk/images/s1/${each.id}/${handle}.jpg` : null,
      new Map(),
      (each, handle) => (each.video ? `https://hatti.pk/videos/s1/${each.id}/${handle}.mp4` : null),
    );
    expect(doc.images.map((image) => image.src)).toEqual([
      'https://hatti.pk/images/s1/front/lawn-kurta.jpg',
      'https://hatti.pk/images/s1/back/lawn-kurta.jpg',
    ]);
    expect(doc.media).toEqual([
      { type: 'image', image: 0 },
      {
        type: 'video',
        id: 'film',
        alt: 'Kurta, turning',
        preview: {
          src: 'https://hatti.pk/images/s1/film/lawn-kurta.jpg',
          width: 1080,
          height: 1920,
          alt: 'Kurta, turning',
        },
        sources: [
          {
            src: 'https://hatti.pk/videos/s1/film/lawn-kurta.mp4',
            mimeType: 'video/mp4',
            format: 'mp4',
            width: 1080,
            height: 1920,
          },
        ],
        durationMs: 12_000,
      },
      {
        type: 'external_video',
        id: 'youtube',
        alt: null,
        preview: {
          src: 'https://hatti.pk/images/s1/youtube/lawn-kurta.jpg',
          width: 1280,
          height: 720,
          alt: null,
        },
        host: 'youtube',
        externalId: 'dQw4w9WgXcQ',
      },
      { type: 'image', image: 1 },
    ]);
  });
});
