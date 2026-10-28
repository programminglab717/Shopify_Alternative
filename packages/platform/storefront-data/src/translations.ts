import type {
  ArticleDoc,
  AttributeWordDoc,
  BlogDoc,
  CollectionDoc,
  MenuDoc,
  PageDoc,
  ProductDoc,
  SeoDoc,
  ShopDoc,
  SitemapEntry,
  StoreData,
  ThemeDoc,
} from './documents.js';
import type { HandledKind } from './keys.js';

/** What a document translated may hold: some of its own fields, and of its SEO. */
interface Translatable {
  seo?: SeoDoc;
  translations?: Partial<Record<string, { seo?: Partial<SeoDoc> }>>;
}

/**
 * A document as a page in `locale` shows it (OS-06, ADR-238): each field the shop translated in
 * place of its own, and its SEO title or description each likewise; the rest its own, as is a
 * document of which the shop translated nothing.
 */
export function translated<T extends Translatable>(doc: T, locale: string): T {
  const own = doc.translations?.[locale];
  if (!own) return doc;
  const { seo, ...fields } = own as Record<string, unknown> & { seo?: Partial<SeoDoc> };
  const shown: Record<string, unknown> = { ...(doc as object) };
  for (const [field, value] of Object.entries(fields)) {
    if (value !== undefined) shown[field] = value;
  }
  if (seo) {
    shown.seo = {
      title: seo.title ?? doc.seo?.title ?? null,
      description: seo.description ?? doc.seo?.description ?? null,
    };
  }
  return shown as T;
}

/**
 * A product as a page in `locale` shows it (ADR-241): as {@link translated} gives it, and each of
 * its variants' values in its options' words in the language, its title made of them as the
 * catalog makes it. A variant keeps its ID, so the one a shopper chooses is the same in either
 * language, and a translated option its own name as `ownName` (ADR-568).
 */
export function translatedProduct(doc: ProductDoc, locale: string): ProductDoc {
  const shown = urduWords(translated(doc, locale), locale);
  const options = doc.translations?.[locale]?.options;
  if (!options) return shown;
  return {
    ...shown,
    // Each named as the shop names it too, where it is translated: the filters it chose find
    // options by their own names (ADR-568).
    options: shown.options.map((option, index) => {
      const own = doc.options[index]?.name;
      return own === undefined || own === option.name ? option : { ...option, ownName: own };
    }),
    variants: doc.variants.map((variant) => {
      const values = variant.options.map((value, index) => {
        const at = doc.options[index]?.values.indexOf(value) ?? -1;
        return (at < 0 ? undefined : options[index]?.values[at]) ?? value;
      });
      return { ...variant, options: values, title: values.join(' / ') };
    }),
  };
}

/** A product's eastern-wear attributes in Urdu words on Urdu pages (ADR-477). */
function urduWords(doc: ProductDoc, locale: string): ProductDoc {
  const wear = doc.easternWear;
  if (locale !== 'ur' || !wear) return doc;
  const inUrdu = (word: AttributeWordDoc | undefined) => word && { ...word, label: word.ur };
  return {
    ...doc,
    easternWear: {
      ...defined({
        stitching: inUrdu(wear.stitching),
        pieces: inUrdu(wear.pieces),
        season: inUrdu(wear.season),
      }),
      fabrics: wear.fabrics.map((fabric) => inUrdu(fabric)!),
    },
  };
}

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, each]) => each !== undefined),
  ) as Partial<T>;
}

/**
 * A shop's documents as its pages in `locale` show them (ADR-238): products as
 * {@link translatedProduct} gives each, collections, menus, pages, blogs and articles as
 * {@link translated} does, the shop's own with its home page's words likewise (ADR-245), and
 * policies in the language where the shop gave it (ADR-239); the rest as they are.
 */
export class TranslatedStore implements StoreData {
  constructor(
    private readonly store: StoreData,
    private readonly locale: string,
  ) {}

  async shop(): Promise<ShopDoc> {
    return translated(await this.store.shop(), this.locale);
  }

  async productByHandle(handle: string): Promise<ProductDoc | null> {
    return this.#product(await this.store.productByHandle(handle));
  }

  async products(ids: readonly string[]): Promise<(ProductDoc | null)[]> {
    return (await this.store.products(ids)).map((doc) => this.#product(doc));
  }

  async collectionByHandle(handle: string): Promise<CollectionDoc | null> {
    return this.#one(await this.store.collectionByHandle(handle));
  }

  async menu(handle: string): Promise<MenuDoc | null> {
    return this.#one(await this.store.menu(handle));
  }

  async pageByHandle(handle: string): Promise<PageDoc | null> {
    return this.#one(await this.store.pageByHandle(handle));
  }

  async pages(ids: readonly string[]): Promise<(PageDoc | null)[]> {
    return (await this.store.pages(ids)).map((doc) => this.#one(doc));
  }

  async blogByHandle(handle: string): Promise<BlogDoc | null> {
    return this.#one(await this.store.blogByHandle(handle));
  }

  async articleByHandle(handle: string): Promise<ArticleDoc | null> {
    return this.#one(await this.store.articleByHandle(handle));
  }

  async articles(ids: readonly string[]): Promise<(ArticleDoc | null)[]> {
    return (await this.store.articles(ids)).map((doc) => this.#one(doc));
  }

  redirect(path: string): Promise<string | null> {
    return this.store.redirect(path);
  }

  policy(type: string): Promise<string | null> {
    return this.store.policy(type, this.locale);
  }

  theme(): Promise<ThemeDoc | null> {
    return this.store.theme();
  }

  experimentTheme(): Promise<ThemeDoc | null> {
    return this.store.experimentTheme();
  }

  handles(kind: HandledKind): Promise<string[]> {
    return this.store.handles(kind);
  }

  sitemap(kind: HandledKind): Promise<SitemapEntry[]> {
    return this.store.sitemap(kind);
  }

  productIds(): Promise<string[]> {
    return this.store.productIds();
  }

  #one<T extends Translatable>(doc: T | null): T | null {
    return doc && translated(doc, this.locale);
  }

  #product(doc: ProductDoc | null): ProductDoc | null {
    return doc && translatedProduct(doc, this.locale);
  }
}
