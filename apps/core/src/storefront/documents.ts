import type { ShopProfile } from '@hatti/api';
import type { DeliverySettingsRecord } from '@hatti/checkout/public';
import {
  DEFAULT_VARIANT_TITLE,
  type CollectionRecord,
  type MediaRecord,
  type ProductRecord,
} from '@hatti/catalog/public';
import type {
  ArticleRecord,
  BlogRecord,
  MenuItemRecord,
  MenuRecord,
  PageRecord,
  DomainRecord,
  PreferencesRecord,
  ThemeFileRecord,
  ThemeRecord,
} from '@hatti/online-store/public';
import {
  DOCUMENTS_VERSION,
  type ArticleDoc,
  type ImageDoc,
  type BlogDoc,
  type BrandDoc,
  type CollectionDoc,
  type MenuDoc,
  type MenuLinkDoc,
  type PageDoc,
  type ProductDoc,
  type ShopDoc,
  type ThemeDoc,
} from '@hatti/storefront-data';

// The storefront's documents, made from the catalog's records (03 §8). Only what a theme may
// show: no costs, barcodes or stock counts.

/** `/collections/all`, every active product, newest first, unless a collection has the handle. */
export const ALL_PRODUCTS = 'all';

/** Where a ready image is served (ADR-158), by its media and its product's handle. */
export type ImageAddress = (media: MediaRecord, handle: string) => string | null;

/**
 * Where the storefront shows an image from: Hatti's own copy once ready (ADR-158); meanwhile an
 * image by URL from its source; an upload not until it is ready, nor one that failed.
 */
function imageSrc(media: MediaRecord, handle: string, address: ImageAddress): string | null {
  if (media.status === 'ready') return address(media, handle);
  return media.status !== 'failed' && media.sourceKey === null ? media.sourceUrl : null;
}

/**
 * `available` holds whether stock allows selling each variant; those missing can be sold.
 * `address` says where ready images are served.
 */
export function productDoc(
  record: ProductRecord,
  available: ReadonlyMap<string, boolean>,
  address: ImageAddress,
): ProductDoc {
  const images = record.media.flatMap((media) => {
    const src = imageSrc(media, record.handle, address);
    return src === null ? [] : [{ media, src }];
  });
  const imageAt = new Map(images.map(({ media }, index) => [media.id, index]));
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
    images: images.map(({ media, src }) => ({
      src,
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
 * A menu as the storefront shows it (ADR-040): a link to a collection, product or page it cannot
 * show, gone, not active or not published, is left out with the links under it.
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

/** A published page (ADR-045): its body was cleaned when it was saved. */
export function pageDoc(page: PageRecord & { publishedAt: Date }): PageDoc {
  return {
    id: page.id,
    handle: page.handle,
    title: page.title,
    bodyHtml: page.body,
    templateSuffix: page.templateSuffix,
    publishedAt: page.publishedAt.toISOString(),
  };
}

/**
 * A blog (ADR-177), listing its published articles, the latest first, each with its tags, as
 * the online store's `publishedIn` gives them.
 */
export function blogDoc(
  blog: BlogRecord,
  published: readonly { id: string; tags: string[] }[],
): BlogDoc {
  return {
    id: blog.id,
    handle: blog.handle,
    title: blog.title,
    templateSuffix: blog.templateSuffix,
    articles: published.map((article) => ({ id: article.id, tags: article.tags })),
  };
}

/**
 * A published article (ADR-177): its body and summary were cleaned when it was saved; with its
 * image where the API serves it, while it has one (ADR-213).
 */
export function articleDoc(
  article: ArticleRecord & { publishedAt: Date },
  blogHandle: string,
  image: ImageDoc | null = null,
): ArticleDoc {
  return {
    id: article.id,
    handle: article.handle,
    blogHandle,
    title: article.title,
    bodyHtml: article.body,
    summaryHtml: article.summary,
    author: article.author,
    tags: article.tags,
    publishedAt: article.publishedAt.toISOString(),
    templateSuffix: article.templateSuffix,
    updatedAt: article.updatedAt.toISOString(),
    image,
  };
}

/**
 * The shop, naming the version of its main theme the storefront shows, with its WhatsApp number
 * and what it charges for delivery. Settings shops cannot change yet: cash on delivery everywhere,
 * without a fee or a limit.
 */
export function shopDoc(
  profile: ShopProfile,
  theme: ThemeDoc | null,
  preferences: PreferencesRecord,
  delivery: DeliverySettingsRecord,
  domains: readonly DomainRecord[] = [],
  /** The policies it has, by type, in Shopify's order. */
  policies: readonly string[] = [],
  /** Its Meta pixel's ID, while it has Meta connected (ADR-144). */
  metaPixelId: string | null = null,
  /** Where its logos are served (ADR-205). */
  brand: BrandDoc = { logo: null, squareLogo: null },
): ShopDoc {
  return {
    version: DOCUMENTS_VERSION,
    name: profile.name,
    handle: profile.handle,
    domain: domains.find((domain) => domain.isPrimary)?.host ?? '',
    domains: domains.map((domain) => domain.host),
    // The days its sessions are counted in (ADR-180).
    timezone: profile.timezone,
    whatsapp: preferences.whatsappNumber,
    cod: { available: true, fee: 0, limit: null },
    delivery: {
      charge: Number(delivery.charge),
      freeAbove: delivery.freeAbove === null ? null : Number(delivery.freeAbove),
      zones: delivery.zones.map((zone) => ({
        name: zone.name,
        cities: zone.cities,
        charge: Number(zone.charge),
      })),
    },
    theme: theme ? { id: theme.id, version: theme.version } : null,
    // Closed until it opens: what the storefront checks passwords against, never the password.
    password:
      preferences.passwordEnabled && preferences.passwordVerifier
        ? {
            verifier: preferences.passwordVerifier,
            message: textToHtml(preferences.passwordMessage),
          }
        : null,
    robotsRules: preferences.robotsTxtRules,
    policies: [...policies],
    // Left out without one, so a shop without one keeps its document as it was.
    ...(metaPixelId && { metaPixelId }),
    // Left out while it set nothing of it, for the same reason.
    ...((preferences.linkPage.bio !== '' ||
      preferences.linkPage.links.length > 0 ||
      preferences.linkPage.productIds.length > 0) && {
      linkPage: {
        bio: preferences.linkPage.bio,
        links: preferences.linkPage.links.map(({ title, url }) => ({ title, url })),
        productIds: [...preferences.linkPage.productIds],
        // Left out while none is chosen, as in documents written before they could be.
        ...(preferences.linkPage.variantIds.some((id) => id !== null) && {
          variantIds: [...preferences.linkPage.variantIds],
        }),
      },
    }),
    // Left out without either, for the same reason.
    ...((brand.logo !== null || brand.squareLogo !== null) && {
      brand: { logo: brand.logo, squareLogo: brand.squareLogo },
    }),
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
