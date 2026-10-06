import type { InputChecker } from './input.js';

/**
 * What search engines and link previews are told of a product, collection, page or article in
 * place of its own title and text (OS-09, ADR-231), as Shopify's `seo` has it: null for its own.
 */
export interface SeoValue {
  title: string | null;
  description: string | null;
}

/** As given: a field left out stays as it is; null or blank clears it. */
export interface SeoInputValue {
  title?: string | null;
  description?: string | null;
}

/**
 * The longest each may be: more than search engines show, so that what a shop kept on Shopify,
 * where apps write them too, comes in whole.
 */
export const SEO_LIMITS = { title: 255, description: 1_000 } as const;

/** Neither: the title and text of its own. */
export const NO_SEO: SeoValue = Object.freeze({ title: null, description: null });

/**
 * `input` checked at `field`, each on one line: what it changes, a field left out absent from
 * it. Null clears both, and so does a blank field its own.
 */
export function checkSeo(
  check: InputChecker,
  field: string[],
  input: SeoInputValue | null | undefined,
): Partial<SeoValue> {
  if (input === undefined) return {};
  if (input === null) return { ...NO_SEO };
  const changes: Partial<SeoValue> = {};
  for (const key of ['title', 'description'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    const text = value?.replace(/\s+/g, ' ').trim() ?? '';
    if (text.length > SEO_LIMITS[key]) {
      check.addMessage(
        [...field, key],
        'TOO_LONG',
        `SEO ${key} is too long (maximum is ${SEO_LIMITS[key]} characters)`,
      );
    }
    changes[key] = text === '' ? null : text;
  }
  return changes;
}
