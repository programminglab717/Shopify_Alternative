import {
  CurrentTenant,
  Loaders,
  RequestLoaders,
  RequireScopes,
  UserError,
  decodeCursor,
  pageSize,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Args, ID, Int, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { ArticleService } from '../article.service.js';
import { CommentService } from '../comment.service.js';
import type { ArticleRecord, CommentRecord } from '../records.js';
import { OnlineStoreArticle } from './blog.types.js';
import {
  ArticleCommentsArgs,
  CommentApprovePayload,
  CommentConnection,
  CommentDeletePayload,
  CommentNotSpamPayload,
  CommentSpamPayload,
  CommentsArgs,
  OnlineStoreComment,
  type CommentChangePayload,
} from './comment.types.js';
import { toArticle, toComment, toCommentConnection, uuidOf } from './mappers.js';

/**
 * Comments shoppers post on the shop's articles (ADR-220), as Shopify's Admin API has them: the
 * shop lists them, approves those waiting, marks them as spam or not, and deletes them.
 */
@Resolver(() => OnlineStoreComment)
export class CommentResolver {
  constructor(
    private readonly commentService: CommentService,
    private readonly articleService: ArticleService,
  ) {}

  @Query(() => CommentConnection, {
    description: "The comments on the shop's articles, the latest first.",
  })
  @RequireScopes('read_content')
  async comments(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: CommentsArgs,
  ): Promise<CommentConnection> {
    const after = args.after ? uuidOf('comment', decodeCursor(args.after, ['id']).id) : null;
    const { items, hasNextPage } = await this.commentService.list(tenant, {
      first: pageSize(args.first),
      after,
      status: args.status ?? null,
      articleId: args.articleId ? uuidOf('article', args.articleId) : null,
    });
    return toCommentConnection(items, hasNextPage);
  }

  @Query(() => OnlineStoreComment, { nullable: true })
  @RequireScopes('read_content')
  async comment(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<OnlineStoreComment | null> {
    const record = await this.commentService.get(tenant, uuidOf('comment', id));
    return record ? toComment(record) : null;
  }

  @ResolveField(() => OnlineStoreArticle, { description: 'The article it was posted on.' })
  async article(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() comment: OnlineStoreComment,
  ): Promise<OnlineStoreArticle> {
    const articles = loaders.get<string, ArticleRecord>('commentArticle', (ids) =>
      this.articleService.byIds(tenant, ids),
    );
    // A comment is never without its article: deleting the article deletes it.
    return toArticle((await articles.load(comment.articleId))!);
  }

  @Mutation(() => CommentApprovePayload, {
    description: 'Shows a comment on the storefront, as the shop approves it.',
  })
  @RequireScopes('write_content')
  async commentApprove(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<CommentApprovePayload> {
    const result = await this.commentService.approve(tenant, uuidOf('comment', id));
    return changed(new CommentApprovePayload(), result);
  }

  @Mutation(() => CommentSpamPayload, {
    description: 'Marks a comment as spam: the storefront no longer shows it.',
  })
  @RequireScopes('write_content')
  async commentSpam(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<CommentSpamPayload> {
    const result = await this.commentService.markSpam(tenant, uuidOf('comment', id));
    return changed(new CommentSpamPayload(), result);
  }

  @Mutation(() => CommentNotSpamPayload, {
    description: 'A comment marked as spam that is not: shown on the storefront, as one approved.',
  })
  @RequireScopes('write_content')
  async commentNotSpam(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<CommentNotSpamPayload> {
    const result = await this.commentService.markNotSpam(tenant, uuidOf('comment', id));
    return changed(new CommentNotSpamPayload(), result);
  }

  @Mutation(() => CommentDeletePayload, { description: 'Deletes a comment for good.' })
  @RequireScopes('write_content')
  async commentDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<CommentDeletePayload> {
    const result = await this.commentService.delete(tenant, uuidOf('comment', id));
    return Object.assign(new CommentDeletePayload(), {
      deletedCommentId: result.ok ? id : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

/** An article's comments, as Shopify's `Article.comments` and `commentsCount`. */
@Resolver(() => OnlineStoreArticle)
export class ArticleCommentsResolver {
  constructor(private readonly commentService: CommentService) {}

  @ResolveField(() => CommentConnection, { description: 'Its comments, the latest first.' })
  async comments(
    @CurrentTenant() tenant: TenantContext,
    @Parent() article: OnlineStoreArticle,
    @Args() args: ArticleCommentsArgs,
  ): Promise<CommentConnection> {
    const after = args.after ? uuidOf('comment', decodeCursor(args.after, ['id']).id) : null;
    const { items, hasNextPage } = await this.commentService.list(tenant, {
      first: pageSize(args.first),
      after,
      status: args.status ?? null,
      articleId: uuidOf('article', article.id),
    });
    return toCommentConnection(items, hasNextPage);
  }

  @ResolveField(() => Int, { description: 'Its comments, shown or not.' })
  async commentsCount(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() article: OnlineStoreArticle,
  ): Promise<number> {
    const counts = loaders.get<string, number>('articleCommentsCount', (ids) =>
      this.commentService.countsOf(tenant, ids),
    );
    return (await counts.load(uuidOf('article', article.id))) ?? 0;
  }
}

/** A comment change's payload: the comment as it is now, or why it did not change. */
function changed<P extends CommentChangePayload>(
  payload: P,
  result: MutationResult<CommentRecord>,
): P {
  return Object.assign(payload, {
    comment: result.ok ? toComment(result.value) : null,
    userErrors: result.ok ? [] : UserError.list(result.errors),
  });
}
