import type { ShopProfile } from '@hatti/api';
import type { DeliverySettingsRecord } from '@hatti/checkout/public';
import {
  DEFAULT_VARIANT_TITLE,
  shownSizeOf,
  type BundleRecord,
  type CollectionRecord,
  type MediaRecord,
  type OptionRecord,
  type ProductRecord,
  type ShownReviews,
  type ShownSizeChart,
  EASTERN_WEAR_WORDS,
  piecesWords,
  type EasternWear,
} from '@hatti/catalog/public';
import {
  commentHtml,
  type ArticleRecord,
  type BlogRecord,
  type MenuItemRecord,
  type MenuRecord,
  type PageRecord,
  type DomainRecord,
  type PreferencesRecord,
  type ShownComments,
  type ThemeFileRecord,
  type ThemeRecord,
  type TranslatedFields,
  type TranslationKey,
} from '@hatti/online-store/public';
import {
  DOCUMENTS_VERSION,
  type ArticleDoc,
  type ImageDoc,
  type BlogDoc,
  type BrandDoc,
  type BundleDoc,
  type CollectionDoc,
  type MediaDoc,
  type MenuDoc,
  type MenuLinkDoc,
  type PageDoc,
  type ProductDoc,
  type SeoDoc,
  type ShopDoc,
  type ThemeDoc,
  type EasternWearDoc,
} from '@hatti/storefront-data';

// The storefront's documents, made from the catalog's records (03 §8). Only what a theme may
// show: no costs or stock counts, and a barcode only where it is a GTIN (ADR-483).

/** `/collections/all`, every active product, newest first, unless a collection has the handle. */
export const ALL_PRODUCTS = 'all';

/** The most left of a variant its page says it has, honestly (MKT-14, ADR-445); more are not said. */
export const LOW_STOCK_SHOWN = 5;

/** Where a ready image is served (ADR-158), by its media and its product's handle. */
export type ImageAddress = (media: MediaRecord, handle: string) => string | null;

/** Where a ready video the shop uploaded is served (ADR-258), by its media and product's handle. */
export type VideoAddress = (media: MediaRecord, handle: string) => string | null;

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
  /**
   * What the shop translated, by what it translates: the product's fields (ADR-238), a description
   * as text, and its options' and their values' names (ADR-241).
   */
  translations: ReadonlyMap<string, TranslatedFields> = new Map(),
  videoAddress: VideoAddress = () => null,
  /** Its published reviews (ADR-401), if it has any. */
  reviews?: ShownReviews,
  /** The day it ships by, while it is on pre-order (ADR-403). */
  preorderShipsOn?: string,
  /** The size chart it shows, if any (ADR-407). */
  sizeChart?: ShownSizeChart,
  /** What it holds, where it is a bundle (ADR-411). */
  bundle?: BundleDoc,
  /** The products related to it, the most related first (ADR-434). */
  related?: readonly string[],
  /** The products the shop pairs with it, in its order (ADR-435). */
  complements?: readonly string[],
  /** When the sale it is in now ends (ADR-445), if it is in one. */
  saleEndsAt?: Date,
  /** How many of each variant are left to sell, where 5 or fewer are (ADR-445). */
  left: ReadonlyMap<string, number> = new Map(),
): ProductDoc {
  // Its images; its videos are its media beside them (ADR-258).
  const images = record.media.flatMap((media) => {
    const src = media.mediaType === 'image' ? imageSrc(media, record.handle, address) : null;
    return src === null ? [] : [{ media, src }];
  });
  const imageAt = new Map(images.map(({ media }, index) => [media.id, index]));
  const media = mediaDocs(record, imageAt, address, videoAddress);
  const hasOptions = record.options.length > 0;
  const own = translations.get(record.id) ?? {};
  const locales = new Set(
    [record.id, ...optionIds(record.options)].flatMap((id) =>
      Object.keys(translations.get(id) ?? {}),
    ),
  );
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
      ? shownOptions(record.options).map((option) => ({
          name: option.name,
          values: option.values.map((value) => value.name),
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
      ...(variant.barcode && isGtin(variant.barcode) && { gtin: variant.barcode }),
      ...(left.has(variant.id) && { left: left.get(variant.id) }),
    })),
    images: images.map(({ media, src }) => {
      // As shown: cropped where it is (ADR-257).
      const size = shownSizeOf(media);
      return {
        src,
        width: size?.width ?? 0,
        height: size?.height ?? 0,
        alt: media.alt || null,
        ...(media.focalPoint && { focalPoint: media.focalPoint }),
      };
    }),
    ...(media && { media }),
    // As its collection's feed dates it (ADR-216).
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    seo: record.seo,
    ...translationsDoc(
      Object.fromEntries([...locales].map((locale) => [locale, own[locale] ?? {}])),
      (fields, locale) => ({
        title: fields.title,
        descriptionHtml: fields.body_html === undefined ? undefined : textToHtml(fields.body_html),
        productType: fields.product_type,
        seo: seoTranslation(fields),
        options: optionsIn(record.options, translations, locale),
      }),
    ),
    ...(reviews && {
      reviews: {
        rating: reviews.rating,
        count: reviews.count,
        latest: reviews.latest.map((review) => ({
          id: review.id,
          author: review.author,
          rating: review.rating,
          bodyHtml: review.body === null ? null : commentHtml(review.body),
          createdAt: review.publishedAt.toISOString(),
        })),
      },
    }),
    ...(record.giftCard && { giftCard: true as const }),
    ...(record.easternWear && { easternWear: easternWearDoc(record.easternWear) }),
    ...(record.category && { category: record.category }),
    ...(record.condition !== 'new' && { condition: record.condition }),
    ...(preorderShipsOn && { preorderShipsOn }),
    ...(saleEndsAt && { saleEndsAt: saleEndsAt.toISOString() }),
    ...(sizeChart && { sizeChart }),
    ...(bundle && { bundle }),
    ...(related && related.length > 0 && { related: [...related] }),
    ...(complements && complements.length > 0 && { complements: [...complements] }),
  };
}

/**
 * A product's eastern-wear attributes as pages say them (ADR-477): each in Hatti's words in English
 * and Urdu, which Urdu pages show.
 */
/**
 * Whether a barcode is a GTIN, as feeds take it: 8, 12, 13 or 14 digits, the last the check digit
 * of the rest (ADR-483). A shop's own codes are not.
 */
export function isGtin(code: string): boolean {
  if (!/^(\d{8}|\d{12,14})$/.test(code)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop()!;
  // From the right, the digits are weighed 3, 1, 3, 1...
  const sum = digits
    .reverse()
    .reduce((total, digit, at) => total + digit * (at % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

function easternWearDoc(wear: EasternWear): EasternWearDoc {
  const word = (value: string, words: { en: string; ur: string }) => ({
    value,
    label: words.en,
    ur: words.ur,
  });
  return {
    ...(wear.stitching && {
      stitching: word(wear.stitching, EASTERN_WEAR_WORDS.stitching[wear.stitching]),
    }),
    ...(wear.pieces !== null && { pieces: word(String(wear.pieces), piecesWords(wear.pieces)) }),
    fabrics: wear.fabrics.map((fabric) => word(fabric, EASTERN_WEAR_WORDS.fabrics[fabric])),
    ...(wear.season && { season: word(wear.season, EASTERN_WEAR_WORDS.seasons[wear.season]) }),
  };
}

/**
 * What a bundle holds (ADR-411), its parts as they are now: their products' titles, their variants'
 * where they have options, and a link to each part for sale. None for a product that is no bundle.
 */
export function bundleDoc(
  bundle: BundleRecord | undefined,
  parts: ReadonlyMap<string, ProductRecord>,
): BundleDoc | undefined {
  if (!bundle) return undefined;
  return {
    components: bundle.components.map((component) => {
      const part = parts.get(component.productId);
      return {
        title: part?.title ?? component.productTitle,
        variantTitle:
          component.variantTitle === DEFAULT_VARIANT_TITLE ? null : component.variantTitle,
        quantity: component.quantity,
        handle: part?.status === 'active' ? part.handle : null,
      };
    }),
  };
}

/**
 * A product's media in order, as Shopify's `product.media` (ADR-258): its images by their places
 * among those shown, and its videos ready to play, each with its preview image. None where it has
 * no video to show: its images are its media.
 */
function mediaDocs(
  record: ProductRecord,
  imageAt: ReadonlyMap<string, number>,
  address: ImageAddress,
  videoAddress: VideoAddress,
): MediaDoc[] | undefined {
  const docs = record.media.flatMap((media): MediaDoc[] => {
    if (media.mediaType === 'image') {
      const image = imageAt.get(media.id);
      return image === undefined ? [] : [{ type: 'image', image }];
    }
    const src = media.status === 'ready' ? address(media, record.handle) : null;
    if (src === null || media.width === null || media.height === null) return [];
    const alt = media.alt || null;
    const preview = { src, width: media.width, height: media.height, alt };
    if (media.externalVideo) {
      const { host, id } = media.externalVideo;
      return [{ type: 'external_video', id: media.id, alt, preview, host, externalId: id }];
    }
    const file = media.video && videoAddress(media, record.handle);
    if (!media.video || !file) return [];
    const { width, height, durationMs } = media.video;
    return [
      {
        type: 'video',
        id: media.id,
        alt,
        preview,
        sources: [{ src: file, mimeType: 'video/mp4', format: 'mp4', width, height }],
        durationMs,
      },
    ];
  });
  return docs.some((doc) => doc.type !== 'image') ? docs : undefined;
}

/** A product's options with the values its variants have, as its document shows them. */
function shownOptions(options: readonly OptionRecord[]): OptionRecord[] {
  return options.map((option) => ({
    ...option,
    values: option.values.filter((value) => value.hasVariants),
  }));
}

/** The IDs of a product's options and their values. */
function optionIds(options: readonly OptionRecord[]): string[] {
  return options.flatMap((option) => [option.id, ...option.values.map((value) => value.id)]);
}

/**
 * A product's options as its pages in `locale` show them (ADR-241): each name and value the shop
 * translated in place of its own; none where that changes none of those shown. An option whose
 * values would read the same in the language keeps its own words for them, as a shopper must
 * tell its values apart.
 */
function optionsIn(
  options: readonly OptionRecord[],
  translations: ReadonlyMap<string, TranslatedFields>,
  locale: string,
): ProductDoc['options'] | undefined {
  const nameIn = (id: string) => translations.get(id)?.[locale]?.name;
  let changed = false;
  const shown = shownOptions(options).map((option) => {
    const own = option.values.map((value) => value.name);
    const words = option.values.map((value) => nameIn(value.id) ?? value.name);
    const distinct = new Set(words.map((word) => word.toLowerCase())).size === words.length;
    const shownOption = { name: nameIn(option.id) ?? option.name, values: distinct ? words : own };
    changed ||=
      shownOption.name !== option.name ||
      shownOption.values.some((value, index) => value !== own[index]);
    return shownOption;
  });
  return changed ? shown : undefined;
}

export function collectionDoc(
  record: CollectionRecord,
  productIds: string[],
  /** Its fields the shop translated (ADR-238), a description as text. */
  translations?: TranslatedFields,
): CollectionDoc {
  return {
    id: record.id,
    handle: record.handle,
    title: record.title,
    descriptionHtml: textToHtml(record.description),
    image: null,
    productIds,
    updatedAt: record.updatedAt.toISOString(),
    seo: record.seo,
    ...translationsDoc(translations, (fields) => ({
      title: fields.title,
      descriptionHtml: fields.body_html === undefined ? undefined : textToHtml(fields.body_html),
      seo: seoTranslation(fields),
    })),
  };
}

/** A document's fields in each language the shop translated some into (ADR-238); none without. */
function translationsDoc<T extends object>(
  translations: TranslatedFields | undefined,
  fieldsOf: (fields: Partial<Record<TranslationKey, string>>, locale: string) => T,
): { translations?: Partial<Record<string, T>> } {
  const entries = Object.entries(translations ?? {}).flatMap(([locale, fields]) => {
    if (!fields) return [];
    const shown = defined(fieldsOf(fields, locale));
    return Object.keys(shown).length > 0 ? [[locale, shown] as const] : [];
  });
  return entries.length > 0 ? { translations: Object.fromEntries(entries) } : {};
}

/** An SEO title and description the shop translated; none where it translated neither. */
function seoTranslation(
  fields: Partial<Record<TranslationKey, string>>,
): Partial<SeoDoc> | undefined {
  const seo = defined({ title: fields.meta_title, description: fields.meta_description });
  return Object.keys(seo).length > 0 ? seo : undefined;
}

/** `value` without its fields that are undefined. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
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
export function menuDoc(
  menu: MenuRecord,
  /** What the shop translated of the menu's title and its items' (ADR-238), by their IDs. */
  translations: ReadonlyMap<string, TranslatedFields> = new Map(),
): MenuDoc {
  const doc: MenuDoc = {
    handle: menu.handle,
    title: menu.title,
    links: linkDocs(menu.items, (item) => item.title),
  };
  const items = itemIds(menu.items);
  const locales = new Set(
    [menu.id, ...items].flatMap((id) => Object.keys(translations.get(id) ?? {})),
  );
  if (locales.size === 0) return doc;
  const titleIn = (locale: string, id: string) => translations.get(id)?.[locale]?.title;
  return {
    ...doc,
    translations: Object.fromEntries(
      [...locales].map((locale) => [
        locale,
        defined({
          title: titleIn(locale, menu.id),
          // Its links as they are in the language, where it translated any.
          links: items.some((id) => titleIn(locale, id) !== undefined)
            ? linkDocs(menu.items, (item) => titleIn(locale, item.id) ?? item.title)
            : undefined,
        }),
      ]),
    ),
  };
}

function linkDocs(
  items: readonly MenuItemRecord[],
  titleOf: (item: MenuItemRecord) => string,
): MenuLinkDoc[] {
  return items.flatMap((item) =>
    item.shown && item.url !== null
      ? [
          {
            title: titleOf(item),
            url: item.url,
            type: `${item.type}_link`,
            links: linkDocs(item.items, titleOf),
          },
        ]
      : [],
  );
}

/** The IDs of a menu's items at every level. */
function itemIds(items: readonly MenuItemRecord[]): string[] {
  return items.flatMap((item) => [item.id, ...itemIds(item.items)]);
}

/** A published page (ADR-045): its body was cleaned when it was saved. */
export function pageDoc(
  page: PageRecord & { publishedAt: Date },
  /** Its fields the shop translated (ADR-238), its body cleaned as its own was. */
  translations?: TranslatedFields,
): PageDoc {
  return {
    id: page.id,
    handle: page.handle,
    title: page.title,
    bodyHtml: page.body,
    templateSuffix: page.templateSuffix,
    publishedAt: page.publishedAt.toISOString(),
    updatedAt: page.updatedAt.toISOString(),
    seo: page.seo,
    ...translationsDoc(translations, (fields) => ({
      title: fields.title,
      bodyHtml: fields.body_html,
      seo: seoTranslation(fields),
    })),
  };
}

/**
 * A blog (ADR-177), listing its published articles, the latest first, each with its tags, as
 * the online store's `publishedIn` gives them.
 */
export function blogDoc(
  blog: BlogRecord,
  published: readonly { id: string; tags: string[] }[],
  /** Its title, and those for search engines, as the shop translated them (ADR-238, ADR-244). */
  translations?: TranslatedFields,
): BlogDoc {
  return {
    id: blog.id,
    handle: blog.handle,
    title: blog.title,
    templateSuffix: blog.templateSuffix,
    articles: published.map((article) => ({ id: article.id, tags: article.tags })),
    commentPolicy: blog.commentPolicy,
    updatedAt: blog.updatedAt.toISOString(),
    seo: blog.seo,
    ...translationsDoc(translations, (fields) => ({
      title: fields.title,
      seo: seoTranslation(fields),
    })),
  };
}

/**
 * A published article (ADR-177): its body and summary were cleaned when it was saved; with its
 * image where the API serves it, while it has one (ADR-213); and with its blog's comment policy
 * and the comments the storefront shows, escaped as text (ADR-220).
 */
export function articleDoc(
  article: ArticleRecord & { publishedAt: Date },
  blog: Pick<BlogRecord, 'handle' | 'commentPolicy'>,
  image: ImageDoc | null = null,
  shown: ShownComments | undefined = undefined,
  /** Its fields the shop translated (ADR-238), its body and summary cleaned as its own were. */
  translations?: TranslatedFields,
): ArticleDoc {
  return {
    id: article.id,
    handle: article.handle,
    blogHandle: blog.handle,
    title: article.title,
    bodyHtml: article.body,
    summaryHtml: article.summary,
    author: article.author,
    tags: article.tags,
    publishedAt: article.publishedAt.toISOString(),
    templateSuffix: article.templateSuffix,
    updatedAt: article.updatedAt.toISOString(),
    image,
    commentPolicy: blog.commentPolicy,
    comments: (shown?.comments ?? []).map((comment) => ({
      id: comment.id,
      author: comment.author,
      bodyHtml: commentHtml(comment.body),
      createdAt: comment.createdAt.toISOString(),
    })),
    commentsCount: shown?.count ?? 0,
    seo: article.seo,
    ...translationsDoc(translations, (fields) => ({
      title: fields.title,
      bodyHtml: fields.body_html,
      summaryHtml: fields.summary_html,
      seo: seoTranslation(fields),
    })),
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
  /** Its social sharing image, where it is served (ADR-243); null for none. */
  sharingImage: ImageDoc | null = null,
  /** Its home page's words for search engines as it translated them (ADR-245). */
  translations?: TranslatedFields,
  /** Whether its back in stock automation is on (ADR-429). */
  backInStock = false,
  /** What Hatti verified of it (ADR-465); null for none. */
  verified: 'identity' | 'business' | null = null,
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
    // Left out while off, so a shop that never turned it on keeps its document as it was.
    ...(backInStock && { backInStock: true as const }),
    cod: { available: true, fee: 0, limit: null },
    delivery: {
      charge: Number(delivery.charge),
      freeAbove: delivery.freeAbove === null ? null : Number(delivery.freeAbove),
      days: delivery.days,
      zones: delivery.zones.map((zone) => ({
        name: zone.name,
        cities: zone.cities,
        charge: Number(zone.charge),
        days: zone.days,
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
    // Paused for a while (ADR-252), left out while it is not, so a shop that never paused keeps
    // its document as it was; the storefront compares the time it opens again with its own.
    ...(preferences.maintenance.enabled && {
      maintenance: {
        message: preferences.maintenance.message,
        until: preferences.maintenance.until?.toISOString() ?? null,
      },
    }),
    // Taken down by Hatti (ADR-461), left out while it is not, likewise.
    ...(profile.status === 'suspended' && { suspended: true as const }),
    // Verified by Hatti (ADR-465), left out while it is not, likewise.
    ...(verified && { verified }),
    // Its return window (ADR-468), left out while it says nothing of it, likewise.
    ...(preferences.returns.days !== null && {
      returns: { days: preferences.returns.days, exchangesOnly: preferences.returns.exchangesOnly },
    }),
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
    // Its home page's for search engines and link previews (ADR-243), left out likewise.
    ...((preferences.seo.title !== null || preferences.seo.description !== null) && {
      seo: { title: preferences.seo.title, description: preferences.seo.description },
    }),
    ...(sharingImage && { sharingImage }),
    // Left out while it translated none of them, likewise (ADR-245).
    ...translationsDoc(translations, (fields) => ({ seo: seoTranslation(fields) })),
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
