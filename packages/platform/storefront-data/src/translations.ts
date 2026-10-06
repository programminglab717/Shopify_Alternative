import type {
  ArticleDoc,
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
 * A shop's documents as its pages in `locale` show them (ADR-238): products, collections, menus,
 * pages, blogs and articles as {@link translated} gives each; the rest as they are.
 */
export class TranslatedStore implements StoreData {
  constructor(
    private readonly store: StoreData,
    private readonly locale: string,
  ) {}

  shop(): Promise<ShopDoc> {
    return this.store.shop();
  }

  async productByHandle(handle: string): Promise<ProductDoc | null> {
    return this.#one(await this.store.productByHandle(handle));
  }

  async products(ids: readonly string[]): Promise<(ProductDoc | null)[]> {
    return (await this.store.products(ids)).map((doc) => this.#one(doc));
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
    return this.store.policy(type);
  }

  theme(): Promise<ThemeDoc | null> {
    return this.store.theme();
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
}
