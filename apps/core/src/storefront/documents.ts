import type { ShopProfile } from '@hatti/api';
import type { DeliverySettingsRecord } from '@hatti/checkout/public';
import {
  DEFAULT_VARIANT_TITLE,
  type CollectionRecord,
  type MediaRecord,
  type OptionRecord,
  type ProductRecord,
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
  type CollectionDoc,
  type MenuDoc,
  type MenuLinkDoc,
  type PageDoc,
  type ProductDoc,
  type SeoDoc,
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
  /**
   * What the shop translated, by what it translates: the product's fields (ADR-238), a description
   * as text, and its options' and their values' names (ADR-241).
   */
  translations: ReadonlyMap<string, TranslatedFields> = new Map(),
): ProductDoc {
  const images = record.media.flatMap((media) => {
    const src = imageSrc(media, record.handle, address);
    return src === null ? [] : [{ media, src }];
  });
  const imageAt = new Map(images.map(({ media }, index) => [media.id, index]));
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
    })),
    images: images.map(({ media, src }) => ({
      src,
      width: media.width ?? 0,
      height: media.height ?? 0,
      alt: media.alt || null,
    })),
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
  };
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
