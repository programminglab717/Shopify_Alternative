import { PageInfo, UserError } from '@hatti/api';
import {
  ArgsType,
  Field,
  GraphQLISODateTime,
  ID,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';

/** Shopify's comment statuses that Hatti's comments take; the values are its own (ADR-220). */
export enum CommentStatus {
  PENDING = 'pending',
  PUBLISHED = 'published',
  SPAM = 'spam',
}

registerEnumType(CommentStatus, {
  name: 'CommentStatus',
  description: 'Whether a comment waits for the shop, shows on the storefront, or was spam.',
  valuesMap: {
    PENDING: { description: 'Waiting for the shop to approve it, its blog moderating comments.' },
    PUBLISHED: { description: 'Shown on its article on the storefront.' },
    SPAM: { description: 'Taken for spam by the shop: not shown.' },
  },
});

@ObjectType({ description: 'Who posted a comment, as they gave it.' })
export class CommentAuthor {
  @Field({ description: 'The name it is signed with, as the storefront shows it.' })
  name!: string;

  @Field({ description: 'Where the shop may answer; the storefront never shows it.' })
  email!: string;
}

@ObjectType('Comment', {
  description:
    'A comment a shopper posted on an article from its page on the storefront (ADR-220), shown ' +
    "there once published, as its blog's comment policy says.",
})
export class OnlineStoreComment {
  @Field(() => ID)
  id!: string;

  @Field(() => CommentAuthor)
  author!: CommentAuthor;

  @Field({ description: 'Plain text, as typed.' })
  body!: string;

  @Field({ description: 'The body as the storefront shows it: escaped, its lines kept.' })
  bodyHtml!: string;

  @Field(() => CommentStatus)
  status!: CommentStatus;

  @Field({ description: 'Whether the storefront shows it.' })
  isPublished!: boolean;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When the storefront began showing it; null while it has not.',
  })
  publishedAt!: Date | null;

  @Field(() => String, {
    nullable: true,
    description: 'Where it was posted from, for telling spam; null when not known.',
  })
  ip!: string | null;

  @Field(() => String, { nullable: true, description: 'The browser it was posted from.' })
  userAgent!: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;

  /** The article's own ID, for the `article` field. */
  articleId!: string;
}

@ObjectType()
export class CommentEdge {
  @Field()
  cursor!: string;

  @Field(() => OnlineStoreComment)
  node!: OnlineStoreComment;
}

@ObjectType()
export class CommentConnection {
  @Field(() => [CommentEdge])
  edges!: CommentEdge[];

  @Field(() => [OnlineStoreComment])
  nodes!: OnlineStoreComment[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class ArticleCommentsArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;

  @Field(() => CommentStatus, { nullable: true, description: 'Those with this status alone.' })
  status?: CommentStatus | null;
}

@ArgsType()
export class CommentsArgs extends ArticleCommentsArgs {
  @Field(() => ID, { nullable: true, description: "One article's comments alone." })
  articleId?: string | null;
}

/** What approving a comment, or saying whether it is spam, gives back, as Shopify's payloads. */
@ObjectType({ isAbstract: true })
export abstract class CommentChangePayload {
  @Field(() => OnlineStoreComment, { nullable: true })
  comment!: OnlineStoreComment | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class CommentApprovePayload extends CommentChangePayload {}

@ObjectType()
export class CommentSpamPayload extends CommentChangePayload {}

@ObjectType()
export class CommentNotSpamPayload extends CommentChangePayload {}

@ObjectType()
export class CommentDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedCommentId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
