import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { FileService } from '@hatti/files/public';
import { ArticleService, BlogService, type CommentPolicyValue } from '@hatti/online-store/public';
import { readStoreBlogs, type StoreArticle } from '@hatti/shopify-admin';
import { Args, Field, Int, Mutation, ObjectType, Resolver } from '@nestjs/graphql';
import { ShopifyStores, storeGiven, storeRefusalOf } from './shopify-stores.js';

/** Blogs and articles read at a time, for the handles the shop has. */
const BATCH = 250;

/** Shopify's comment policies, as the shop's blogs keep them. */
const COMMENT_POLICY: Readonly<Record<string, CommentPolicyValue>> = {
  CLOSED: 'closed',
  MODERATED: 'moderated',
  AUTO_PUBLISHED: 'auto_published',
};

@ObjectType({
  description: "A store's blog or article that did not go in, or an article's image, and why.",
})
export class StoreArticleImportError {
  @Field({ description: "The blog's handle at the store." })
  blog!: string;

  @Field(() => String, {
    nullable: true,
    description: "The article's handle at the store; null for the blog itself.",
  })
  article!: string | null;

  @Field()
  message!: string;
}

@ObjectType()
export class BlogsImportFromShopifyPayload {
  @Field(() => Int, { description: 'Blogs the store has.' })
  blogs!: number;

  @Field(() => Int, { description: 'Blogs made, or that would be in a dry run.' })
  blogsCreated!: number;

  @Field(() => Int, { description: 'Articles the store has.' })
  articles!: number;

  @Field(() => Int, { description: 'Articles made, or that would be in a dry run.' })
  created!: number;

  @Field(() => Int, {
    description: 'Articles left as they are: their blog has an article with their handles already.',
  })
  skipped!: number;

  @Field(() => Int, {
    description: "Articles' images brought, as the shop's files (ADR-783); none in a dry run.",
  })
  images!: number;

  @Field(() => [StoreArticleImportError])
  articleErrors!: StoreArticleImportError[];

  @Field()
  dryRun!: boolean;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

/**
 * A Shopify store's blogs and their articles through its Admin API (ONB-05, ADR-753): a blog the
 * shop has by handle is kept and its articles go into it; each article is made as
 * `articleCreate` makes one, keeping its handle and so its address.
 */
@Resolver()
export class BlogsFromShopifyResolver {
  constructor(
    private readonly blogs: BlogService,
    private readonly articles: ArticleService,
    private readonly files: FileService,
    private readonly shopify: ShopifyStores,
  ) {}

  @Mutation(() => BlogsImportFromShopifyPayload, {
    description:
      "Imports a Shopify store's blogs and their articles through its Admin API (ONB-05, " +
      'ADR-753), each keeping its handle and so its address at /blogs/{blog}/{article}: a ' +
      "blog's title and comment policy; an article's title, body, summary, author, tags, and " +
      'whether it is shown and since when. A blog the shop has by handle takes the articles; ' +
      'articles whose handles their blog has are left as they are. Give the store and its app as ' +
      'productsImportFromShopify takes them; the app needs the read_content access scope. ' +
      "An article's image is fetched from Shopify and kept as one of the shop's files " +
      '(ADR-783); one that cannot be is said in articleErrors, the article made without it. ' +
      'Nothing given is kept. dryRun reads the store and counts, changing nothing.',
  })
  @RequireScopes('write_content')
  async blogsImportFromShopify(
    @CurrentTenant() tenant: TenantContext,
    @Args('store', {
      description:
        "The store's address at Shopify, as zari.myshopify.com, its name, or a link to its admin.",
    })
    store: string,
    @Args('accessToken', { nullable: true }) accessToken?: string,
    @Args('clientId', { nullable: true }) clientId?: string,
    @Args('clientSecret', { nullable: true }) clientSecret?: string,
    @Args('dryRun', { nullable: true }) dryRun?: boolean,
  ): Promise<BlogsImportFromShopifyPayload> {
    const dry = dryRun ?? false;
    const payload = (values: Partial<BlogsImportFromShopifyPayload>) =>
      Object.assign(new BlogsImportFromShopifyPayload(), {
        blogs: 0,
        blogsCreated: 0,
        articles: 0,
        created: 0,
        skipped: 0,
        images: 0,
        articleErrors: [],
        dryRun: dry,
        userErrors: [],
        ...values,
      });
    const refused = (refusal: { field: string[] | null; code: string; message: string }) =>
      payload({ userErrors: [UserError.of(refusal.field, refusal.code, refusal.message)] });

    const given = storeGiven(store, accessToken, clientId, clientSecret);
    if (!given.ok) return refused(given);
    const read = await readStoreBlogs(
      this.shopify.connect(given.shop, given.credentials),
      this.shopify.bulk,
    );
    if (!read.ok) return refused(storeRefusalOf(read));
    const storeBlogs = read.value.blogs;
    if (storeBlogs.length === 0) {
      return refused({
        field: ['store'],
        code: 'BLANK',
        message: `${read.value.storeName} has no blogs`,
      });
    }

    const counts = { blogsCreated: 0, created: 0, skipped: 0, images: 0 };
    const articleErrors: StoreArticleImportError[] = [];
    const failed = (blog: string, article: string | null, message: string) =>
      articleErrors.push(Object.assign(new StoreArticleImportError(), { blog, article, message }));
    const shopBlogs = await this.#blogIds(tenant);
    for (const blog of storeBlogs) {
      let blogId = shopBlogs.get(blog.handle) ?? null;
      if (!blogId) {
        if (dry) {
          counts.blogsCreated++;
          counts.created += blog.articles.length;
          continue;
        }
        const made = await this.blogs.create(tenant, {
          title: blog.title,
          handle: blog.handle,
          templateSuffix: blog.templateSuffix,
          commentPolicy: COMMENT_POLICY[blog.commentPolicy] ?? 'closed',
        });
        if (!made.ok) {
          failed(blog.handle, null, made.errors.map((error) => error.message).join('; '));
          continue;
        }
        counts.blogsCreated++;
        blogId = made.value.id;
      }
      const handles = await this.#articleHandles(tenant, blogId);
      for (const article of blog.articles) {
        if (handles.has(article.handle)) {
          counts.skipped++;
          continue;
        }
        if (dry) {
          counts.created++;
          continue;
        }
        const image = await this.#imageOf(tenant, article);
        if (typeof image === 'string') {
          failed(blog.handle, article.handle, `Its image was not brought: ${image}`);
        }
        const made = await this.articles.create(tenant, {
          blogId,
          title: article.title,
          handle: article.handle,
          body: article.body,
          summary: article.summary,
          author: article.author,
          tags: article.tags,
          isPublished: article.isPublished,
          // Shown since when the store showed it.
          ...(article.isPublished &&
            article.publishedAt && { publishDate: new Date(article.publishedAt) }),
          templateSuffix: article.templateSuffix,
          ...(typeof image === 'object' && { image }),
        });
        const kept = typeof image === 'object' && image !== null ? image.fileId : null;
        if (made.ok) {
          counts.created++;
          if (kept) counts.images++;
          handles.add(article.handle);
          continue;
        }
        // The image goes with the article that did not.
        if (kept) await this.files.delete(tenant, [kept]);
        if (made.errors.some((error) => error.code === 'TAKEN')) {
          counts.skipped++;
        } else {
          failed(blog.handle, article.handle, made.errors.map((error) => error.message).join('; '));
        }
      }
    }
    return payload({
      blogs: storeBlogs.length,
      articles: storeBlogs.reduce((sum, blog) => sum + blog.articles.length, 0),
      ...counts,
      articleErrors,
    });
  }

  /**
   * The store's image of `article` kept as one of the shop's files, as the article takes it
   * (ADR-783): null for none; why not when it could not be fetched or kept.
   */
  async #imageOf(
    tenant: TenantContext,
    article: StoreArticle,
  ): Promise<{ fileId: string; altText: string } | null | string> {
    if (!article.image) return null;
    const fetched = await this.shopify.images.fetch(article.image.url);
    if (!fetched.ok) return fetched.message;
    const altText = article.image.altText ?? '';
    const made = await this.files.createImage(tenant, {
      filename: filenameOf(article.image.url, article.handle),
      body: fetched.body,
      alt: altText,
    });
    if (!made.ok) return made.errors.map((error) => error.message).join('; ');
    return { fileId: made.value.id, altText };
  }

  /** The shop's blogs' IDs by their handles. */
  async #blogIds(tenant: TenantContext): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    let after: string | null = null;
    for (;;) {
      const page = await this.blogs.list(tenant, { first: BATCH, after });
      for (const blog of page.items) ids.set(blog.handle, blog.id);
      if (!page.hasNextPage || page.items.length === 0) return ids;
      after = page.items.at(-1)!.id;
    }
  }

  /** The handles of a blog's articles. */
  async #articleHandles(tenant: TenantContext, blogId: string): Promise<Set<string>> {
    const handles = new Set<string>();
    let after: string | null = null;
    for (;;) {
      const page = await this.articles.list(tenant, { first: BATCH, after, blogId });
      for (const article of page.items) handles.add(article.handle);
      if (!page.hasNextPage || page.items.length === 0) return handles;
      after = page.items.at(-1)!.id;
    }
  }
}

/** The name of the file at `url`, as its path ends; `fallback` where it names none. */
export function filenameOf(url: string, fallback: string): string {
  let name = '';
  try {
    name = decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '');
  } catch {
    // Not a URL, or not one whose name reads: the fallback.
  }
  return (name.trim() || fallback).slice(0, 255);
}
