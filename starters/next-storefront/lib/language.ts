import { cookies } from 'next/headers';

// The shopper's language (ADR-926): English unless they chose Urdu, kept in a cookie of this
// site's. The Storefront API answers the catalog in it through `@inContext`, the shop's Urdu
// words where it wrote them; pages in Urdu are right to left.

export const LANGUAGE_COOKIE = 'hatti_language';

export type Language = 'en' | 'ur';

/** The language this shopper chose. */
export async function languageOf(): Promise<Language> {
  return (await cookies()).get(LANGUAGE_COOKIE)?.value === 'ur' ? 'ur' : 'en';
}

/** As the Storefront API's `@inContext(language:)` takes it. */
export function languageCode(language: Language): 'EN' | 'UR' {
  return language === 'ur' ? 'UR' : 'EN';
}
