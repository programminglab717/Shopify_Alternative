import type { ProductDoc, StoreData, VariantDoc } from '@hatti/storefront-data';
import { escapeHtml, imageAddress, unescapeHtml } from './liquid.js';

// Catalog feeds (MKT-11, ADR-142): a shop's products as Google Merchant Center fetches them, in
// its RSS 2.0 format, which Meta's catalogs take too: an item for each variant, grouped by its
// product, linking to it on the shop's own address. Ads and free listings are made from them, and
// the pixels' and conversions' content IDs to come name the same variants.

/** Products fetched a round trip at a time. */
export const FEED_CHUNK = 100;

/** What the platforms take at most: Google's limits. */
const LIMITS = { title: 150, description: 5_000, additionalImages: 10 };

/** Option names whose values are an item's size and colour, in any letter case. */
const SIZE = /^size$/i;
const COLOUR = /^colou?r$/i;

/** The shop, as its feed names it. */
export interface FeedShop {
  name: string;
}

/** The feed, a part at a time: its head, a chunk of products' items each, then its end. */
export async function* productFeed(
  store: Pick<StoreData, 'productIds' | 'products'>,
  shop: FeedShop,
  origin: string,
): AsyncGenerator<string> {
  yield '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n<channel>\n' +
    `<title>${xml(shop.name)}</title>\n<link>${xml(`${origin}/`)}</link>\n` +
    `<description>${xml(`Products of ${shop.name}`)}</description>\n`;
  // In the same order each time, so a feed fetched twice reads alike.
  const ids = (await store.productIds()).sort();
  for (let at = 0; at < ids.length; at += FEED_CHUNK) {
    const products = await store.products(ids.slice(at, at + FEED_CHUNK));
    const items = products.map((product) => (product ? feedItems(product, shop, origin) : ''));
    if (items.some(Boolean)) yield items.join('');
  }
  yield '</channel>\n</rss>\n';
}

/**
 * A product's items, one a variant, as Google's product data specification has them; none for a
 * product without an image, which Google and Meta both refuse.
 */
export function feedItems(product: ProductDoc, shop: FeedShop, origin: string): string {
  const [firstImage] = product.images;
  if (!firstImage) return '';
  const description = clip(textOf(product.descriptionHtml), LIMITS.description) || product.title;
  const grouped = product.variants.length > 1;
  return product.variants
    .map((variant) => {
      const image = (variant.image !== null && product.images[variant.image]) || firstImage;
      const others = product.images
        .filter((each) => each !== image)
        .slice(0, LIMITS.additionalImages);
      const onSale = variant.compareAtPrice !== null && variant.compareAtPrice > variant.price;
      const fields: [string, string][] = [
        ['g:id', variant.id],
        ...(grouped ? [['g:item_group_id', product.id] as [string, string]] : []),
        ['g:title', clip(titleOf(product, variant), LIMITS.title)],
        ['g:description', description],
        [
          'g:link',
          `${origin}/products/${encodeURIComponent(product.handle)}` +
            `?variant=${encodeURIComponent(variant.id)}`,
        ],
        ['g:image_link', imageAddress(image.src, origin, 1200)],
        ...others.map((each): [string, string] => [
          'g:additional_image_link',
          imageAddress(each.src, origin, 1200),
        ]),
        ['g:availability', variant.available ? 'in_stock' : 'out_of_stock'],
        // On sale, the price it was is its price, as the platforms show a sale.
        ['g:price', priceOf(onSale ? variant.compareAtPrice! : variant.price)],
        ...(onSale ? [['g:sale_price', priceOf(variant.price)] as [string, string]] : []),
        ['g:brand', clip(product.vendor || shop.name, 70)],
        ['g:condition', 'new'],
        // Shops make most of what they sell: no barcodes to give.
        ['g:identifier_exists', 'no'],
        ...(product.productType
          ? [['g:product_type', clip(product.productType, 750)] as [string, string]]
          : []),
        ...optionFields(product, variant),
      ];
      const body = fields.map(([name, value]) => `<${name}>${xml(value)}</${name}>`).join('');
      return `<item>${body}</item>\n`;
    })
    .join('');
}

/** The product's title, with the variant's where it has more than one. */
function titleOf(product: ProductDoc, variant: VariantDoc): string {
  return product.variants.length > 1 ? `${product.title} - ${variant.title}` : product.title;
}

/** Its size and colour, from options so named. */
function optionFields(product: ProductDoc, variant: VariantDoc): [string, string][] {
  const fields: [string, string][] = [];
  product.options.forEach((option, index) => {
    const value = variant.options[index];
    if (!value) return;
    if (SIZE.test(option.name)) fields.push(['g:size', clip(value, 100)]);
    else if (COLOUR.test(option.name)) fields.push(['g:color', clip(value, 100)]);
  });
  return fields;
}

/** Paisa as the platforms take a price: "2499.00 PKR". */
function priceOf(paisa: number): string {
  return `${(paisa / 100).toFixed(2)} PKR`;
}

/** A product's description as text, its tags gone and what was escaped as it was. */
function textOf(html: string): string {
  return unescapeHtml(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** Text as XML holds it: escaped, without the control characters XML 1.0 has no place for. */
function xml(text: string): string {
  return escapeHtml(text.replace(/(?![\t\n\r])\p{Cc}/gu, ''));
}
