import { createHash } from 'node:crypto';
import { SEO_LIMITS, type InputChecker, type SeoValue } from '@hatti/api';
import { htmlToText, textToHtml } from '@hatti/catalog/public';
import { BLOG_LIMITS } from './blog.service.js';
import { PAGE_LIMITS, cleanPageBody } from './page-body.js';

// What of a shop's content may be put in another of the storefront's languages, as Shopify's
// translatable resources have it (OS-06, ADR-238), and how a translation is checked.

/** The language a shop's own content is in, as its storefront's default. */
export const PRIMARY_LOCALE = 'en';

/** The languages a shop's content may be translated into: the storefront's besides its own. */
export const TRANSLATION_LOCALES = ['ur'] as const;
export type TranslationLocale = (typeof TRANSLATION_LOCALES)[number];

export function isTranslationLocale(value: string): value is TranslationLocale {
  return (TRANSLATION_LOCALES as readonly string[]).includes(value);
}

/** What may be translated, as Shopify's TranslatableResourceType names them. */
export const TRANSLATABLE_KINDS = [
  'product',
  'collection',
  'page',
  'blog',
  'article',
  'menu',
  'menuItem',
  'shopPolicy',
] as const;
export type TranslatableKind = (typeof TRANSLATABLE_KINDS)[number];

export function isTranslatableKind(value: string): value is TranslatableKind {
  return (TRANSLATABLE_KINDS as readonly string[]).includes(value);
}

/** A field that may be translated, by Shopify's key for it. */
export const TRANSLATION_KEYS = [
  'title',
  'body_html',
  'summary_html',
  'product_type',
  'meta_title',
  'meta_description',
  'body',
] as const;
export type TranslationKey = (typeof TRANSLATION_KEYS)[number];

/** Each kind's fields that may be translated, in the order the API lists them. */
export const TRANSLATABLE_FIELDS: Readonly<Record<TranslatableKind, readonly TranslationKey[]>> = {
  product: ['title', 'body_html', 'product_type', 'meta_title', 'meta_description'],
  collection: ['title', 'body_html', 'meta_title', 'meta_description'],
  page: ['title', 'body_html', 'meta_title', 'meta_description'],
  blog: ['title'],
  article: ['title', 'body_html', 'summary_html', 'meta_title', 'meta_description'],
  menu: ['title'],
  menuItem: ['title'],
  // Shown only while it translates the policy as it is (ADR-239).
  shopPolicy: ['body'],
};

/** How a field's words are written, as Shopify's LocalizableContentType. */
export type ContentTypeValue = 'single_line_text_field' | 'multi_line_text_field' | 'html';

const CONTENT_TYPES: Readonly<Record<TranslationKey, ContentTypeValue>> = {
  title: 'single_line_text_field',
  body_html: 'html',
  summary_html: 'html',
  product_type: 'single_line_text_field',
  meta_title: 'single_line_text_field',
  meta_description: 'multi_line_text_field',
  body: 'html',
};

/** The most translations one call registers. */
export const TRANSLATION_LIMITS = {
  perCall: 100,
  /** A title or a type, in characters, as the shop's own. */
  title: 255,
  /** A product's or collection's description as text, in characters, as the catalog's. */
  description: 100_000,
} as const;

/** One field's words in the shop's own language, as Shopify's TranslatableContent. */
export interface TranslatableContentRecord {
  key: TranslationKey;
  value: string;
  /** SHA-256 of `value`, in hex: a translation names it, so it is known what it was written for. */
  digest: string;
  type: ContentTypeValue;
}

/** SHA-256 of words, in hex, as Shopify's translatableContentDigest. */
export function digestOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The fields of a resource that have words, in the order of `keys`, each with its digest. */
function contentOf(
  keys: readonly TranslationKey[],
  values: Partial<Record<TranslationKey, string | null>>,
): TranslatableContentRecord[] {
  return keys.flatMap((key) => {
    const value = values[key] ?? '';
    return value === '' ? [] : [{ key, value, digest: digestOf(value), type: CONTENT_TYPES[key] }];
  });
}

/** What of a resource's own may be translated, as the API gives it and checks digests against. */
export interface TranslatableSource {
  title?: string;
  /** A product's or collection's description, as text. */
  description?: string;
  /** A page's, article's or policy's body, as HTML. */
  body?: string;
  summary?: string;
  productType?: string | null;
  seo?: SeoValue;
}

/**
 * A resource's fields that may be translated and have words: a product's or collection's
 * description as the storefront shows it, its paragraphs as HTML; its SEO title and description
 * where the shop wrote them (ADR-231).
 */
export function translatableContent(
  kind: TranslatableKind,
  source: TranslatableSource,
): TranslatableContentRecord[] {
  return contentOf(TRANSLATABLE_FIELDS[kind], {
    title: source.title,
    body_html: source.description !== undefined ? textToHtml(source.description) : source.body,
    summary_html: source.summary,
    product_type: source.productType,
    meta_title: source.seo?.title,
    meta_description: source.seo?.description,
    body: source.body,
  });
}

/**
 * Whether a field's translation is kept as text, as a product's or collection's description is
 * kept (ADR-238): the API gives and takes it as HTML, and the storefront shows it as it shows the
 * description.
 */
export function keptAsText(kind: TranslatableKind, key: TranslationKey): boolean {
  return key === 'body_html' && (kind === 'product' || kind === 'collection');
}

/** A translation's words as the API gives them: a description kept as text, as HTML. */
export function translationValue(
  kind: TranslatableKind,
  key: TranslationKey,
  kept: string,
): string {
  return keptAsText(kind, key) ? textToHtml(kept) : kept;
}

/**
 * A translation's words as they are kept, checked as the shop's own field is: a title on one
 * line and as long; a product's or collection's description as text; a page's, article's or
 * policy's HTML cleaned of anything that could run. Errors go under `field`.
 */
export function checkTranslation(
  check: InputChecker,
  field: string[],
  kind: TranslatableKind,
  key: TranslationKey,
  value: string,
): string {
  const line = (max: number) => {
    const text = value.replace(/\s+/g, ' ').trim();
    if (text.length > max)
      check.add(field, 'TOO_LONG', `is too long (maximum is ${max} characters)`);
    return text;
  };
  let words: string;
  if (key === 'title' || key === 'product_type') words = line(TRANSLATION_LIMITS.title);
  else if (key === 'meta_title') words = line(SEO_LIMITS.title);
  else if (key === 'meta_description') words = line(SEO_LIMITS.description);
  else if (keptAsText(kind, key)) {
    words = htmlToText(value);
    if (words.length > TRANSLATION_LIMITS.description) {
      check.add(
        field,
        'TOO_LONG',
        `is too long (maximum is ${TRANSLATION_LIMITS.description} characters)`,
      );
    }
  } else {
    // A policy's body is cleaned as a page's is, and as long.
    const max = key === 'summary_html' ? BLOG_LIMITS.summary : PAGE_LIMITS.body;
    words = cleanPageBody(value);
    if (Buffer.byteLength(words) > max) {
      check.add(field, 'TOO_LONG', `is too long (maximum is ${max / 1024} KB)`);
    }
  }
  if (words === '') check.add(field, 'BLANK', "can't be blank");
  return words;
}
