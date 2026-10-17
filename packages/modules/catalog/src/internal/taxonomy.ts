import type { InputChecker } from './input-checker.js';

// Product taxonomy (CAT-18, ADR-483): the standard categories shopping feeds and ads ask a product
// for, as Google's product taxonomy writes them, those Pakistani shops sell in. A product has one
// or none; Shopify's export names them the same way.

/** The categories a product may be in, each its path in Google's product taxonomy. */
export const PRODUCT_CATEGORIES = [
  'Apparel & Accessories > Clothing',
  'Apparel & Accessories > Clothing > Dresses',
  'Apparel & Accessories > Clothing > Shirts & Tops',
  'Apparel & Accessories > Clothing > Pants',
  'Apparel & Accessories > Clothing > Skirts',
  'Apparel & Accessories > Clothing > Outerwear',
  'Apparel & Accessories > Clothing > Sleepwear & Loungewear',
  'Apparel & Accessories > Clothing > Traditional & Ceremonial Clothing',
  'Apparel & Accessories > Clothing > Traditional & Ceremonial Clothing > Saris & Lehengas',
  'Apparel & Accessories > Clothing Accessories > Scarves & Shawls',
  'Apparel & Accessories > Shoes',
  'Apparel & Accessories > Handbags, Wallets & Cases > Handbags',
  'Apparel & Accessories > Jewelry',
  'Apparel & Accessories > Jewelry > Bracelets',
  'Apparel & Accessories > Jewelry > Earrings',
  'Apparel & Accessories > Jewelry > Necklaces',
  'Apparel & Accessories > Jewelry > Rings',
  'Apparel & Accessories > Jewelry > Watches',
  'Health & Beauty > Personal Care > Cosmetics',
  'Health & Beauty > Personal Care > Cosmetics > Perfume & Cologne',
  'Health & Beauty > Personal Care > Cosmetics > Skin Care',
  'Health & Beauty > Personal Care > Hair Care',
  'Home & Garden > Decor',
  'Home & Garden > Kitchen & Dining',
  'Home & Garden > Linens & Bedding > Bedding',
  'Food, Beverages & Tobacco > Food Items',
  'Electronics',
  'Electronics > Communications > Telephony > Mobile Phone Accessories',
  'Baby & Toddler',
  'Toys & Games',
  'Sporting Goods',
  'Arts & Entertainment > Hobbies & Creative Arts > Arts & Crafts',
  'Media > Books',
] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

/** Whether a product is new, refurbished or used, as feeds say it. */
export const PRODUCT_CONDITIONS = ['new', 'refurbished', 'used'] as const;
export type ProductCondition = (typeof PRODUCT_CONDITIONS)[number];

const BY_LOWER = new Map<string, ProductCategory>(
  PRODUCT_CATEGORIES.map((category) => [category.toLowerCase(), category]),
);

/** The category a path names, however it is spaced or cased; null where it names none. */
export function productCategoryOf(path: string | null | undefined): ProductCategory | null {
  if (!path) return null;
  const tidy = path
    .split('>')
    .map((part) => part.trim().replace(/\s+/g, ' '))
    .join(' > ')
    .toLowerCase();
  return BY_LOWER.get(tidy) ?? null;
}

/** A category given: one of Hatti's, blank or null clearing it; undefined left as it is. */
export function checkCategory(
  check: InputChecker,
  field: string[],
  input: string | null | undefined,
): ProductCategory | null | undefined {
  if (input === undefined) return undefined;
  if (input === null || input.trim() === '') return null;
  const category = productCategoryOf(input);
  if (!category)
    check.add(field, 'INVALID', `"${input.slice(0, 80)}" is not a category Hatti offers`);
  return category;
}

/** A condition given: one of new, refurbished or used; null or undefined leaves it. */
export function checkCondition(
  check: InputChecker,
  field: string[],
  input: string | null | undefined,
): ProductCondition | undefined {
  if (input === undefined || input === null) return undefined;
  if ((PRODUCT_CONDITIONS as readonly string[]).includes(input)) return input as ProductCondition;
  check.add(field, 'INVALID', `must be one of ${PRODUCT_CONDITIONS.join(', ')}`);
  return undefined;
}
