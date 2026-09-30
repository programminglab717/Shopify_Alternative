import type { ShopProfile } from '@hatti/api';
import {
  DEFAULT_VARIANT_TITLE,
  type CollectionRecord,
  type ProductRecord,
} from '@hatti/catalog/public';
import type {
  MenuItemRecord,
  MenuRecord,
  PreferencesRecord,
  ThemeFileRecord,
  ThemeRecord,
} from '@hatti/online-store/public';
import {
  DOCUMENTS_VERSION,
  type CollectionDoc,
  type MenuDoc,
  type MenuLinkDoc,
  type ProductDoc,
  type ShopDoc,
  type ThemeDoc,
} from '@hatti/storefront-data';

// The storefront's documents, made from the catalog's records (03 §8). Only what a theme may
// show: no costs, barcodes or stock counts.

/** `/collections/all`, every active product, newest first, unless a collection has the handle. */
export const ALL_PRODUCTS = 'all';

/** `available` holds whether stock allows selling each variant; those missing can be sold. */
export function productDoc(
  record: ProductRecord,
  available: ReadonlyMap<string, boolean>,
): ProductDoc {
  const images = record.media.filter((media) => media.status !== 'failed');
  const imageAt = new Map(images.map((media, index) => [media.id, index]));
  const hasOptions = record.options.length > 0;
  return {
    id: record.id,
    handle: record.handle,
    title: record.title,
    descriptionHtml: textToHtml(record.description),
    vendor: record.vendor ?? '',
    productType: record.productType ?? '',
    tags: record.tags,
    // Without options a product has one variant, shown as Shopify shows it.
    options: hasOptions
      ? record.options.map((option) => ({
          name: option.name,
          values: option.values.filter((value) => value.hasVariants).map((value) => value.name),
        }))
      : [{ name: 'Title', values: [DEFAULT_VARIANT_TITLE] }],
    variants: record.variants.map((variant) => ({
      id: variant.id,
      title: variant.title,
      sku: variant.sku,
      price: Number(variant.price),
      compareAtPrice: variant.compareAtPrice === null ? null : Number(variant.compareAtPrice),
      available: available.get(variant.id) ?? true,
      options: hasOptions
        ? record.options.map(
            (option) =>
              variant.selectedOptions.find((selected) => selected.optionId === option.id)?.value ??
              '',
          )
        : [DEFAULT_VARIANT_TITLE],
      image: variant.mediaId === null ? null : (imageAt.get(variant.mediaId) ?? null),
    })),
    images: images.map((media) => ({
      src: media.sourceUrl,
      width: media.width ?? 0,
      height: media.height ?? 0,
      alt: media.alt || null,
    })),
  };
}

export function collectionDoc(record: CollectionRecord, productIds: string[]): CollectionDoc {
  return {
    id: record.id,
    handle: record.handle,
    title: record.title,
    descriptionHtml: textToHtml(record.description),
    image: null,
    productIds,
  };
}

export function allProductsDoc(productIds: string[]): CollectionDoc {
  return {
    id: ALL_PRODUCTS,
    handle: ALL_PRODUCTS,
    title: 'All products',
    descriptionHtml: '',
    image: null,
    productIds,
  };
}

/**
 * A menu as the storefront shows it (ADR-040): a link to a collection or product it cannot show,
 * gone or not active, is left out with the links under it.
 */
export function menuDoc(menu: MenuRecord): MenuDoc {
  return { handle: menu.handle, title: menu.title, links: linkDocs(menu.items) };
}

function linkDocs(items: readonly MenuItemRecord[]): MenuLinkDoc[] {
  return items.flatMap((item) =>
    item.shown && item.url !== null
      ? [
          {
            title: item.title,
            url: item.url,
            type: `${item.type}_link`,
            links: linkDocs(item.items),
          },
        ]
      : [],
  );
}

/**
 * The shop, naming the version of its main theme the storefront shows, with its WhatsApp number.
 * Settings shops cannot change yet: cash on delivery everywhere, without a fee or a limit.
 */
export function shopDoc(
  profile: ShopProfile,
  theme: ThemeDoc | null,
  preferences: PreferencesRecord,
): ShopDoc {
  return {
    version: DOCUMENTS_VERSION,
    name: profile.name,
    handle: profile.handle,
    domain: '',
    whatsapp: preferences.whatsappNumber,
    cod: { available: true, fee: 0, limit: null },
    theme: theme ? { id: theme.id, version: theme.version } : null,
  };
}

/** A shop's main theme: the shop's own files, which the storefront lays over the platform's. */
export function themeDoc(main: { theme: ThemeRecord; files: ThemeFileRecord[] }): ThemeDoc {
  return {
    id: main.theme.id,
    version: main.theme.version,
    base: main.theme.base,
    files: Object.fromEntries(main.files.map((file) => [file.filename, file.body])),
  };
}

/** Plain text as HTML: escaped, paragraphs where lines are blank, line breaks kept. */
export function textToHtml(text: string): string {
  return text
    .split(/\r?\n[^\S\r\n]*\r?\n\s*/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\r?\n/g, '<br>')}</p>`)
    .join('');
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
