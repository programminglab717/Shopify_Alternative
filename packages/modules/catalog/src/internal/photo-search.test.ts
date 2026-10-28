import { describe, expect, it } from 'vitest';
import { photoOf } from './photo-search.js';

const PNG = Buffer.from('89504e470d0a1a0a00', 'hex');
const JPEG = Buffer.from('ffd8ffe000', 'hex');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const base64 = (bytes: Buffer) => bytes.toString('base64');

describe("A shopper's photo, as the storefront sends it (SRC-07, ADR-870)", () => {
  it('takes a JPEG, PNG or WebP whose bytes are what it says, and nothing else', () => {
    expect(photoOf({ image: base64(PNG), mediaType: 'image/png' })).toEqual({
      mediaType: 'image/png',
      data: PNG,
    });
    expect(photoOf({ image: base64(JPEG), mediaType: 'image/jpeg' })?.data).toEqual(JPEG);
    expect(photoOf({ image: base64(WEBP), mediaType: 'image/webp' })?.mediaType).toBe('image/webp');
    // Another type's bytes, a type the AI isn't given, what is not base64, or nothing.
    expect(photoOf({ image: base64(JPEG), mediaType: 'image/png' })).toBeNull();
    expect(photoOf({ image: base64(PNG), mediaType: 'image/gif' })).toBeNull();
    expect(photoOf({ image: 'not base64!', mediaType: 'image/png' })).toBeNull();
    expect(photoOf({ image: '', mediaType: 'image/png' })).toBeNull();
    expect(photoOf(null)).toBeNull();
    // Larger than the storefront sends.
    const large = Buffer.concat([PNG, Buffer.alloc(1_600_000)]);
    expect(photoOf({ image: base64(large), mediaType: 'image/png' })).toBeNull();
  });
});
