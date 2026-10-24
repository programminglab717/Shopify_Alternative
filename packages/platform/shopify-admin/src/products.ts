import type { ShopifyAdmin, ShopifyResult } from './admin.js';
import { jsonLines, runBulkQuery, type BulkQueryOptions } from './bulk.js';

/**
 * A store's products, their images and variants, as Shopify's bulk queries take them: each
 * connection whole, its nodes on lines of their own. A variant's own image is `image`, which
 * Shopify answers in this version though it leaves it for `media` later (ADR-749).
 */
export const PRODUCTS_BULK_QUERY = `{
  products {
    edges {
      node {
        id handle title descriptionHtml vendor productType tags status isGiftCard
        seo { title description }
        category { fullName }
        options { name position }
        media {
          edges {
            node {
              ... on MediaImage { id image { url altText } }
              ... on Video { id alt sources { url mimeType height } }
              ... on ExternalVideo { id alt originUrl }
            }
          }
        }
        variants {
          edges {
            node {
              id sku price compareAtPrice barcode taxable inventoryPolicy inventoryQuantity
              selectedOptions { name value }
              image { url }
              inventoryItem {
                tracked
                unitCost { amount }
                measurement { weight { unit value } }
              }
            }
          }
        }
      }
    }
  }
}`;

const SHOP = `{ shop { name currencyCode } }`;

/** A variant of a store's product, as the bulk query gives it. */
export interface StoreVariant {
  sku: string | null;
  price: string;
  compareAtPrice: string | null;
  barcode: string | null;
  taxable: boolean;
  inventoryPolicy: string;
  inventoryQuantity: number | null;
  selectedOptions: { name: string; value: string }[];
  image: { url: string } | null;
  inventoryItem: {
    tracked: boolean;
    unitCost: { amount: string } | null;
    measurement: { weight: { unit: string; value: number } | null } | null;
  } | null;
}

/** A store's product, with its images and variants in the store's order. */
export interface StoreProduct {
  handle: string;
  title: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  tags: string[];
  status: string;
  isGiftCard: boolean;
  seo: { title: string | null; description: string | null };
  category: { fullName: string } | null;
  options: { name: string; position: number }[];
  images: { url: string; altText: string | null }[];
  /** Its videos (ADR-794): those Shopify keeps, by an MP4 of them, and YouTube's or Vimeo's. */
  videos: StoreVideo[];
  variants: StoreVariant[];
}

/** A product's video at the store: one Shopify keeps, by its MP4's URL, or a YouTube or Vimeo one. */
export interface StoreVideo {
  type: 'video' | 'external_video';
  url: string;
  alt: string | null;
}

/** The tallest MP4 of a video Shopify keeps up to 1080 pixels, else its shortest: one to bring. */
function mp4Of(
  sources: readonly { url?: string; mimeType?: string; height?: number }[],
): string | null {
  const mp4s = sources
    .filter((source) => source.mimeType === 'video/mp4' && typeof source.url === 'string')
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
  return (mp4s.find((source) => (source.height ?? 0) <= 1080) ?? mp4s.at(-1))?.url ?? null;
}

/** The products in a bulk query's file, each with the images and variants that name it. */
export function storeProductsOf(text: string): StoreProduct[] {
  const products = new Map<string, StoreProduct>();
  for (const line of jsonLines(text)) {
    const id = String(line.id ?? '');
    const parent = typeof line.__parentId === 'string' ? products.get(line.__parentId) : undefined;
    if (id.startsWith('gid://shopify/Product/')) {
      const node = line as unknown as Omit<StoreProduct, 'images' | 'variants'>;
      products.set(id, {
        handle: node.handle,
        title: node.title,
        descriptionHtml: node.descriptionHtml ?? '',
        vendor: node.vendor ?? '',
        productType: node.productType ?? '',
        tags: node.tags ?? [],
        status: node.status ?? 'DRAFT',
        isGiftCard: node.isGiftCard ?? false,
        seo: node.seo ?? { title: null, description: null },
        category: node.category ?? null,
        options: [...(node.options ?? [])].sort((a, b) => a.position - b.position),
        images: [],
        videos: [],
        variants: [],
      });
    } else if (parent && id.startsWith('gid://shopify/ProductVariant/')) {
      parent.variants.push(line as unknown as StoreVariant);
    } else if (parent && id.startsWith('gid://shopify/MediaImage/')) {
      const image = (line as { image?: { url?: string; altText?: string | null } | null }).image;
      // An image Shopify has not finished processing has no address yet.
      if (image?.url) parent.images.push({ url: image.url, altText: image.altText ?? null });
    } else if (parent && id.startsWith('gid://shopify/Video/')) {
      const video = line as {
        alt?: string | null;
        sources?: { url?: string; mimeType?: string; height?: number }[];
      };
      const url = mp4Of(video.sources ?? []);
      if (url) parent.videos.push({ type: 'video', url, alt: video.alt || null });
    } else if (parent && id.startsWith('gid://shopify/ExternalVideo/')) {
      const video = line as { alt?: string | null; originUrl?: string };
      if (video.originUrl) {
        parent.videos.push({
          type: 'external_video',
          url: video.originUrl,
          alt: video.alt || null,
        });
      }
    }
    // 3D models come as their parents' IDs alone, and are left.
  }
  return [...products.values()];
}

/** The headings of Shopify's product CSV that a store's products fill, in its export's order. */
const HEADINGS = [
  'Handle',
  'Title',
  'Body (HTML)',
  'Vendor',
  'Product Category',
  'Type',
  'Tags',
  'Published',
  'Option1 Name',
  'Option1 Value',
  'Option2 Name',
  'Option2 Value',
  'Option3 Name',
  'Option3 Value',
  'Variant SKU',
  'Variant Grams',
  'Variant Inventory Tracker',
  'Variant Inventory Qty',
  'Variant Inventory Policy',
  'Variant Price',
  'Variant Compare At Price',
  'Variant Taxable',
  'Variant Barcode',
  'Image Src',
  'Image Position',
  'Image Alt Text',
  'Gift Card',
  'SEO Title',
  'SEO Description',
  'Variant Image',
  'Cost per item',
  'Status',
] as const;
type Heading = (typeof HEADINGS)[number];

/** Grams in each of Shopify's units of weight. */
const GRAMS: Readonly<Record<string, number>> = {
  GRAMS: 1,
  KILOGRAMS: 1_000,
  OUNCES: 28.349_523_125,
  POUNDS: 453.592_37,
};

/** A store's products as Shopify's product export, and the handle each of its rows is of. */
export interface StoreProductsCsv {
  csv: string;
  /** The handle of each row under the headings, the first being row 2, as imports count. */
  rowHandles: string[];
}

/**
 * Products as Shopify's own product export writes them (ONB-05): a product's first row its
 * fields, its first variant and its first image; each further row a variant, an image, or both.
 * Every cell is quoted, and nothing is changed for spreadsheets, which never open the file.
 */
export function storeProductsCsv(products: readonly StoreProduct[]): StoreProductsCsv {
  const rows: string[][] = [HEADINGS.slice()];
  const rowHandles: string[] = [];
  for (const product of products) {
    const count = Math.max(product.variants.length, product.images.length, 1);
    for (let at = 0; at < count; at++) {
      const cells: Partial<Record<Heading, string>> = { Handle: product.handle };
      if (at === 0) {
        Object.assign(cells, {
          Title: product.title,
          'Body (HTML)': product.descriptionHtml,
          Vendor: product.vendor,
          'Product Category': product.category?.fullName ?? '',
          Type: product.productType,
          Tags: product.tags.join(', '),
          Published: product.status === 'ACTIVE' ? 'TRUE' : 'FALSE',
          'Gift Card': product.isGiftCard ? 'TRUE' : 'FALSE',
          'SEO Title': product.seo.title ?? '',
          'SEO Description': product.seo.description ?? '',
          Status: product.status.toLowerCase(),
        });
        product.options.slice(0, 3).forEach((option, index) => {
          cells[`Option${index + 1} Name` as Heading] = option.name;
        });
      }
      const variant = product.variants[at];
      if (variant) Object.assign(cells, variantCells(product, variant));
      const image = product.images[at];
      if (image) {
        cells['Image Src'] = image.url;
        cells['Image Position'] = String(at + 1);
        cells['Image Alt Text'] = image.altText ?? '';
      }
      rows.push(HEADINGS.map((heading) => cells[heading] ?? ''));
      rowHandles.push(product.handle);
    }
  }
  return { csv: rows.map((row) => row.map(quoted).join(',')).join('\r\n') + '\r\n', rowHandles };
}

/** A variant's cells: its options' values by the product's options' order, its price and stock. */
function variantCells(
  product: StoreProduct,
  variant: StoreVariant,
): Partial<Record<Heading, string>> {
  const cells: Partial<Record<Heading, string>> = {};
  product.options.slice(0, 3).forEach((option, index) => {
    const selected = variant.selectedOptions.find((each) => each.name === option.name);
    cells[`Option${index + 1} Value` as Heading] = selected?.value ?? '';
  });
  const item = variant.inventoryItem;
  const weight = item?.measurement?.weight;
  const grams =
    weight && GRAMS[weight.unit] !== undefined ? weight.value * GRAMS[weight.unit]! : null;
  Object.assign(cells, {
    'Variant SKU': variant.sku ?? '',
    'Variant Grams': grams === null ? '' : String(Math.round(grams)),
    // Stock where Shopify tracked it, which the import sets at the shop's primary location.
    'Variant Inventory Tracker': item?.tracked ? 'shopify' : '',
    'Variant Inventory Qty':
      item?.tracked && variant.inventoryQuantity !== null ? String(variant.inventoryQuantity) : '',
    'Variant Inventory Policy': variant.inventoryPolicy.toLowerCase(),
    'Variant Price': variant.price,
    'Variant Compare At Price': variant.compareAtPrice ?? '',
    'Variant Taxable': variant.taxable ? 'TRUE' : 'FALSE',
    'Variant Barcode': variant.barcode ?? '',
    'Variant Image': variant.image?.url ?? '',
    'Cost per item': item?.unitCost?.amount ?? '',
  });
  return cells;
}

function quoted(cell: string): string {
  return `"${cell.replace(/"/g, '""')}"`;
}

/** A store's products, read through its Admin API, as Shopify's product export would give them. */
export interface StoreProducts extends StoreProductsCsv {
  /** The store's name, as Shopify has it. */
  storeName: string;
  /** The currency the store prices in, ISO 4217. */
  currency: string;
  products: number;
  /** The videos of the products that have any, by their handles (ADR-794), which no CSV holds. */
  videos: { handle: string; videos: StoreVideo[] }[];
}

/**
 * A store's products through its Admin API (ONB-05, ADR-749): the store and its currency asked
 * first, which also proves the credentials before Shopify is asked for an export; then its
 * products, images and variants in one bulk query; then Shopify's product CSV of them.
 */
export async function readStoreProducts(
  admin: ShopifyAdmin,
  options: BulkQueryOptions = {},
): Promise<ShopifyResult<StoreProducts>> {
  const shop = await admin.graphql<{ shop: { name: string; currencyCode: string } }>(SHOP);
  if (!shop.ok) return shop;
  const file = await runBulkQuery(admin, PRODUCTS_BULK_QUERY, options);
  if (!file.ok) return file;
  let products: StoreProduct[];
  try {
    products = storeProductsOf(file.value);
  } catch {
    return { ok: false, kind: 'other', message: "Shopify's export of the store could not be read" };
  }
  return {
    ok: true,
    value: {
      storeName: shop.value.shop.name,
      currency: shop.value.shop.currencyCode,
      products: products.length,
      videos: products
        .filter((product) => product.videos.length > 0)
        .map(({ handle, videos }) => ({ handle, videos })),
      ...storeProductsCsv(products),
    },
  };
}
