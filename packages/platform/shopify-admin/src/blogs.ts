import type { ShopifyAdmin, ShopifyResult } from './admin.js';
import { jsonLines, runBulkQuery, type BulkQueryOptions } from './bulk.js';

/** A store's blogs and their articles, as Shopify's bulk queries take them. */
export const BLOGS_BULK_QUERY = `{
  blogs {
    edges {
      node {
        id handle title commentPolicy templateSuffix
        articles {
          edges {
            node {
              id handle title body summary tags isPublished publishedAt templateSuffix
              author { name }
              image { url altText }
            }
          }
        }
      }
    }
  }
}`;

const SHOP = `{ shop { name } }`;

/** An article of a store's blog, as Shopify has it. */
export interface StoreArticle {
  handle: string;
  title: string;
  /** HTML. */
  body: string;
  /** HTML; null for none. */
  summary: string | null;
  author: string | null;
  tags: string[];
  isPublished: boolean;
  publishedAt: string | null;
  templateSuffix: string | null;
  /** Its image at Shopify's CDN (ADR-783); null for none. */
  image: { url: string; altText: string | null } | null;
}

/** A store's blog, with its articles in the store's order. */
export interface StoreBlog {
  handle: string;
  title: string;
  /** Shopify's: CLOSED, MODERATED or AUTO_PUBLISHED. */
  commentPolicy: string;
  templateSuffix: string | null;
  articles: StoreArticle[];
}

/** A store's blogs, read through its Admin API. */
export interface StoreBlogs {
  /** The store's name, as Shopify has it. */
  storeName: string;
  blogs: StoreBlog[];
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/**
 * A store's blogs and their articles through its Admin API (ONB-05, ADR-753): the store asked
 * first, which proves the credentials, then every blog and article in one bulk query. The app
 * needs the read_content scope.
 */
export async function readStoreBlogs(
  admin: ShopifyAdmin,
  options: BulkQueryOptions = {},
): Promise<ShopifyResult<StoreBlogs>> {
  const shop = await admin.graphql<{ shop: { name: string } }>(SHOP);
  if (!shop.ok) return shop;
  const file = await runBulkQuery(admin, BLOGS_BULK_QUERY, options);
  if (!file.ok) {
    return file.kind === 'scope'
      ? {
          ...file,
          message: "The store's app may not read its blogs: give it the read_content access scope",
        }
      : file;
  }
  const blogs = new Map<string, StoreBlog>();
  try {
    for (const line of jsonLines(file.value)) {
      const id = String(line.id ?? '');
      if (id.startsWith('gid://shopify/Blog/')) {
        blogs.set(id, {
          handle: String(line.handle),
          title: String(line.title),
          commentPolicy: text(line.commentPolicy) ?? 'CLOSED',
          templateSuffix: text(line.templateSuffix),
          articles: [],
        });
        continue;
      }
      const blog = typeof line.__parentId === 'string' ? blogs.get(line.__parentId) : undefined;
      if (!blog || !id.startsWith('gid://shopify/Article/')) continue;
      const author = line.author as { name?: unknown } | null | undefined;
      const image = line.image as { url?: unknown; altText?: unknown } | null | undefined;
      const imageUrl = text(image?.url);
      blog.articles.push({
        handle: String(line.handle),
        title: String(line.title),
        body: typeof line.body === 'string' ? line.body : '',
        summary: text(line.summary),
        author: text(author?.name),
        tags: Array.isArray(line.tags) ? line.tags.map(String) : [],
        isPublished: line.isPublished === true,
        publishedAt: text(line.publishedAt),
        templateSuffix: text(line.templateSuffix),
        image: imageUrl === null ? null : { url: imageUrl, altText: text(image?.altText) },
      });
    }
  } catch {
    return { ok: false, kind: 'other', message: "Shopify's export of the store could not be read" };
  }
  return { ok: true, value: { storeName: shop.value.shop.name, blogs: [...blogs.values()] } };
}
