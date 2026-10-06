import {
  CurrentTenant,
  Loaders,
  RequestLoaders,
  RequireScopes,
  UserError,
  decodeCursor,
  pageSize,
  type FieldError,
  type TenantContext,
} from '@hatti/api';
import { Args, ID, Int, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { ArticleService, type ArticleInput } from '../article.service.js';
import { BlogService } from '../blog.service.js';
import type { BlogRecord } from '../records.js';
import {
  ArticleConnection,
  ArticleCreateInput,
  ArticleCreatePayload,
  ArticleDeletePayload,
  ArticleUpdateInput,
  ArticleUpdatePayload,
  ArticlesArgs,
  BlogArticlesArgs,
  BlogConnection,
  BlogCreateInput,
  BlogCreatePayload,
  BlogDeletePayload,
  BlogUpdateInput,
  BlogUpdatePayload,
  BlogsArgs,
  OnlineStoreArticle,
  OnlineStoreBlog,
} from './blog.types.js';
import { toArticle, toArticleConnection, toBlog, toBlogConnection, uuidOf } from './mappers.js';

@Resolver(() => OnlineStoreBlog)
export class BlogResolver {
  constructor(
    private readonly blogService: BlogService,
    private readonly articleService: ArticleService,
  ) {}

  @Query(() => BlogConnection, { description: "The shop's blogs, oldest first." })
  @RequireScopes('read_content')
  async blogs(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: BlogsArgs,
  ): Promise<BlogConnection> {
    const after = args.after ? uuidOf('blog', decodeCursor(args.after, ['id']).id) : null;
    const { items, hasNextPage } = await this.blogService.list(tenant, {
      first: pageSize(args.first),
      after,
    });
    return toBlogConnection(items, hasNextPage);
  }

  @Query(() => OnlineStoreBlog, { nullable: true })
  @RequireScopes('read_content')
  async blog(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<OnlineStoreBlog | null> {
    const record = await this.blogService.get(tenant, uuidOf('blog', id));
    return record ? toBlog(record) : null;
  }

  @ResolveField(() => Int, { description: 'Its articles, published or not.' })
  async articlesCount(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() blog: OnlineStoreBlog,
  ): Promise<number> {
    const counts = loaders.get<string, number>('blogArticlesCount', (ids) =>
      this.blogService.articleCounts(tenant, ids),
    );
    return (await counts.load(uuidOf('blog', blog.id))) ?? 0;
  }

  @ResolveField(() => ArticleConnection, { description: 'Its articles, oldest first.' })
  async articles(
    @CurrentTenant() tenant: TenantContext,
    @Parent() blog: OnlineStoreBlog,
    @Args() args: BlogArticlesArgs,
  ): Promise<ArticleConnection> {
    const after = args.after ? uuidOf('article', decodeCursor(args.after, ['id']).id) : null;
    const { items, hasNextPage } = await this.articleService.list(tenant, {
      first: pageSize(args.first),
      after,
      blogId: uuidOf('blog', blog.id),
    });
    return toArticleConnection(items, hasNextPage);
  }

  @Mutation(() => BlogCreatePayload, {
    description: 'A new blog, which the storefront shows a moment later, with its articles.',
  })
  @RequireScopes('write_content')
  async blogCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('blog') blog: BlogCreateInput,
  ): Promise<BlogCreatePayload> {
    const result = await this.blogService.create(tenant, blog);
    return Object.assign(new BlogCreatePayload(), {
      blog: result.ok ? toBlog(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(within('blog', result.errors)),
    });
  }

  @Mutation(() => BlogUpdatePayload, {
    description: 'Changes the fields of a blog that are given; the others stay as they are.',
  })
  @RequireScopes('write_content')
  async blogUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('blog') blog: BlogUpdateInput,
  ): Promise<BlogUpdatePayload> {
    const result = await this.blogService.update(tenant, uuidOf('blog', id), blog);
    return Object.assign(new BlogUpdatePayload(), {
      blog: result.ok ? toBlog(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(within('blog', result.errors)),
    });
  }

  @Mutation(() => BlogDeletePayload, {
    description: 'Deletes a blog and its articles. Menus linking to them leave the links out.',
  })
  @RequireScopes('write_content')
  async blogDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<BlogDeletePayload> {
    const result = await this.blogService.delete(tenant, uuidOf('blog', id));
    return Object.assign(new BlogDeletePayload(), {
      deletedBlogId: result.ok ? id : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

@Resolver(() => OnlineStoreArticle)
export class ArticleResolver {
  constructor(
    private readonly blogService: BlogService,
    private readonly articleService: ArticleService,
  ) {}

  @Query(() => ArticleConnection, {
    description: "The articles of the shop's blogs, or of one, oldest first.",
  })
  @RequireScopes('read_content')
  async articles(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: ArticlesArgs,
  ): Promise<ArticleConnection> {
    const after = args.after ? uuidOf('article', decodeCursor(args.after, ['id']).id) : null;
    const { items, hasNextPage } = await this.articleService.list(tenant, {
      first: pageSize(args.first),
      after,
      blogId: args.blogId ? uuidOf('blog', args.blogId) : null,
    });
    return toArticleConnection(items, hasNextPage);
  }

  @Query(() => OnlineStoreArticle, { nullable: true })
  @RequireScopes('read_content')
  async article(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<OnlineStoreArticle | null> {
    const record = await this.articleService.get(tenant, uuidOf('article', id));
    return record ? toArticle(record) : null;
  }

  @ResolveField(() => OnlineStoreBlog, { description: 'The blog it is in.' })
  async blog(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() article: OnlineStoreArticle,
  ): Promise<OnlineStoreBlog> {
    const blogs = loaders.get<string, BlogRecord>('articleBlog', (ids) =>
      this.blogService.byIds(tenant, ids),
    );
    // An article is never without its blog: deleting the blog deletes it.
    return toBlog((await blogs.load(article.blogId))!);
  }

  @Mutation(() => ArticleCreatePayload, {
    description:
      'A new article, which the storefront shows a moment later unless it is not published. ' +
      'Its body and summary are cleaned of anything that could run.',
  })
  @RequireScopes('write_content')
  async articleCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('article') article: ArticleCreateInput,
  ): Promise<ArticleCreatePayload> {
    const result = await this.articleService.create(tenant, {
      ...articleInput(article),
      blogId: uuidOf('blog', article.blogId),
    });
    return Object.assign(new ArticleCreatePayload(), {
      article: result.ok ? toArticle(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(within('article', result.errors)),
    });
  }

  @Mutation(() => ArticleUpdatePayload, {
    description: 'Changes the fields of an article that are given; the others stay as they are.',
  })
  @RequireScopes('write_content')
  async articleUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('article') article: ArticleUpdateInput,
  ): Promise<ArticleUpdatePayload> {
    const result = await this.articleService.update(tenant, uuidOf('article', id), {
      ...articleInput(article),
      blogId: article.blogId ? uuidOf('blog', article.blogId) : undefined,
      redirectNewHandle: article.redirectNewHandle,
    });
    return Object.assign(new ArticleUpdatePayload(), {
      article: result.ok ? toArticle(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(within('article', result.errors)),
    });
  }

  @Mutation(() => ArticleDeletePayload, { description: 'Deletes an article.' })
  @RequireScopes('write_content')
  async articleDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<ArticleDeletePayload> {
    const result = await this.articleService.delete(tenant, uuidOf('article', id));
    return Object.assign(new ArticleDeletePayload(), {
      deletedArticleId: result.ok ? id : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

/** An article's fields as the service takes them; the author as their name. */
function articleInput(article: ArticleCreateInput | ArticleUpdateInput): ArticleInput {
  return {
    title: article.title,
    handle: article.handle,
    body: article.body,
    summary: article.summary,
    author: article.author === undefined ? undefined : (article.author?.name ?? null),
    tags: article.tags,
    isPublished: article.isPublished,
    publishDate: article.publishDate,
    templateSuffix: article.templateSuffix,
    image: article.image && {
      fileId: uuidOf('file', article.image.fileId),
      altText: article.image.altText,
    },
    seo: article.seo,
  };
}

/** Errors on the input's fields, where the request has them: under `blog` or `article`. */
function within(input: string, errors: readonly FieldError[]): FieldError[] {
  return errors.map((error) =>
    error.field.length === 0 || error.field[0] === 'id'
      ? error
      : { ...error, field: [input, ...error.field] },
  );
}
