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
    ]);
    // The variant's image, by its place among those shown.
    expect(doc.variants[0]!.image).toBe(1);
  });
});
