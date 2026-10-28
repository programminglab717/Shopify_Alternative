import {
  PHOTO_SEARCH_BYTES,
  type PhotoSearchRefusal,
  type PhotoSearchRequest,
  type PhotoSearchResponse,
} from '@hatti/storefront-api';

// Visual search (SRC-07, ADR-870): the theme's search section, where the shop allows it, sends a
// shopper's photo here as a data URL, made small in the browser first; the core reads it into a
// search, and the shopper is sent to that search's page, as if they had typed it. The photo goes
// to the core and on to the AI, and is kept by neither.

export const PHOTO_SEARCH_PATH = '/search/photo';

/** The most a request's body may be: the photo as base64 in a data URL, and a little more. */
export const PHOTO_SEARCH_BODY_MAX = Math.ceil(PHOTO_SEARCH_BYTES / 3) * 4 + 1024;

const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

/** The photo a request's JSON body carries as `{ "image": "data:image/jpeg;base64,…" }`. */
export function photoRequestOf(body: unknown): PhotoSearchRequest | null {
  const image = (body as { image?: unknown } | null)?.image;
  if (typeof image !== 'string') return null;
  const match = DATA_URL.exec(image);
  if (!match) return null;
  return { mediaType: match[1] as PhotoSearchRequest['mediaType'], image: match[2]! };
}

const WORDS: Readonly<
  Record<string, Readonly<Record<PhotoSearchRefusal | 'invalid' | 'none', string>>>
> = {
  en: {
    invalid: 'That photo could not be read. Please try a JPEG or PNG photo.',
    none: 'We could not see a product in that photo. Please try another.',
    unavailable: 'Search by photo is not available just now.',
    no_credits: 'Search by photo is not available just now.',
    too_many: 'Search by photo is busy just now. Please try again later.',
  },
  ur: {
    invalid: 'یہ تصویر پڑھی نہ جا سکی۔ براہ کرم JPEG یا PNG تصویر آزمائیں۔',
    none: 'اس تصویر میں کوئی چیز نظر نہیں آئی۔ براہ کرم کوئی اور تصویر آزمائیں۔',
    unavailable: 'تصویر سے تلاش ابھی دستیاب نہیں۔',
    no_credits: 'تصویر سے تلاش ابھی دستیاب نہیں۔',
    too_many: 'تصویر سے تلاش ابھی مصروف ہے۔ براہ کرم کچھ دیر بعد آزمائیں۔',
  },
};

/** What the shopper is told of a photo they sent, in their page's language. */
export function photoSearchMessage(
  locale: string,
  why: PhotoSearchRefusal | 'invalid' | 'none',
): string {
  return (WORDS[locale] ?? WORDS.en!)[why];
}

/**
 * Where a photo read into a search sends the shopper: that search's page, under `prefix` for a
 * page in Urdu; null where it was read into none.
 */
export function photoSearchLocation(answer: PhotoSearchResponse, prefix: string): string | null {
  if (answer.query === null) return null;
  return `${prefix}/search?${new URLSearchParams({ q: answer.query, type: 'product' })}`;
}
