import { PageInfo, UserError } from '@hatti/api';
import {
  ArgsType,
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  ObjectType,
} from '@nestjs/graphql';

@ObjectType('Blog', {
  description:
    "A shop's blog, such as News, which its storefront shows at /blogs/{handle}, listing its " +
    'published articles, the latest first.',
})
export class OnlineStoreBlog {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;

  @Field({ description: 'Names it in its address, /blogs/{handle}.' })
  handle!: string;

  @Field(() => String, {
    nullable: true,
    description:
      "Another of the theme's blog templates, `news` for blog.news.json; null for blog.json.",
  })
  templateSuffix!: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType({ description: 'Who an article is by.' })
export class ArticleAuthor {
  @Field({ description: 'The name it is signed with.' })
  name!: string;
}

@ObjectType('Article', {
  description:
    "An article of one of the shop's blogs, which its storefront shows at " +
    '/blogs/{blog}/{handle} once published.',
})
export class OnlineStoreArticle {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;

  @Field({ description: 'Names it in its address, /blogs/{blog}/{handle}; unique in its blog.' })
  handle!: string;

  @Field({
    description:
      'HTML, as it was cleaned when saved: text and its formatting, links, images and tables. ' +
      'Scripts, style sheets, frames, forms and event handlers are taken out.',
  })
  body!: string;

  @Field(() => String, {
    nullable: true,
    description: "HTML that the blog's page shows of it, cleaned as the body is; null for none.",
  })
  summary!: string | null;

  @Field(() => ArticleAuthor, { nullable: true, description: 'Null when it is signed by no one.' })
  author!: ArticleAuthor | null;

  @Field(() => [String])
  tags!: string[];

  @Field({ description: 'Whether the storefront shows it.' })
  isPublished!: boolean;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When it was published, as its page says; null while it is not.',
  })
  publishedAt!: Date | null;

  @Field(() => String, {
    nullable: true,
    description:
      "Another of the theme's article templates, `recipe` for article.recipe.json; null for " +
      'article.json.',
  })
  templateSuffix!: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;

  /** The blog's own ID, for the `blog` field. */
  blogId!: string;
}

@ObjectType()
export class BlogEdge {
  @Field()
  cursor!: string;

  @Field(() => OnlineStoreBlog)
  node!: OnlineStoreBlog;
}

@ObjectType()
export class BlogConnection {
  @Field(() => [BlogEdge])
  edges!: BlogEdge[];

  @Field(() => [OnlineStoreBlog])
  nodes!: OnlineStoreBlog[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ObjectType()
export class ArticleEdge {
  @Field()
  cursor!: string;

  @Field(() => OnlineStoreArticle)
  node!: OnlineStoreArticle;
}

@ObjectType()
export class ArticleConnection {
  @Field(() => [ArticleEdge])
  edges!: ArticleEdge[];

  @Field(() => [OnlineStoreArticle])
  nodes!: OnlineStoreArticle[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class BlogsArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;
}

@ArgsType()
export class BlogArticlesArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;
}

@ArgsType()
export class ArticlesArgs extends BlogArticlesArgs {
  @Field(() => ID, { nullable: true, description: "One blog's articles alone." })
  blogId?: string | null;
}

@InputType({ description: 'A new blog.' })
export class BlogCreateInput {
  @Field()
  title!: string;

  @Field(() => String, {
    nullable: true,
    description: 'Made from the title when not given: "News" gives news.',
  })
  handle?: string | null;

  @Field(() => String, { nullable: true })
  templateSuffix?: string | null;
}

@InputType({ description: 'Changes to a blog: fields left out stay as they are.' })
export class BlogUpdateInput {
  @Field(() => String, { nullable: true })
  title?: string | null;

  @Field(() => String, { nullable: true })
  handle?: string | null;

  @Field(() => String, { nullable: true, description: 'Blank for blog.json.' })
  templateSuffix?: string | null;

  @Field(() => Boolean, {
    nullable: true,
    description:
      "With a new handle, whether the blog's old address sends shoppers to its new one: a URL " +
      "redirect is made, as on Shopify, for the blog's own page. False unless given.",
  })
  redirectNewHandle?: boolean | null;
}

@InputType({ description: 'Who an article is by.' })
export class AuthorInput {
  @Field(() => String, { nullable: true, description: 'The name it is signed with.' })
  name?: string | null;
}

@InputType({ description: 'A new article.' })
export class ArticleCreateInput {
  @Field(() => ID, { description: 'The blog it is in.' })
  blogId!: string;

  @Field()
  title!: string;

  @Field(() => String, {
    nullable: true,
    description: 'Made from the title when not given; unique in its blog.',
  })
  handle?: string | null;

  @Field(() => String, { nullable: true, description: 'HTML, cleaned before it is kept.' })
  body?: string | null;

  @Field(() => String, { nullable: true, description: 'HTML, cleaned before it is kept.' })
  summary?: string | null;

  @Field(() => AuthorInput, { nullable: true })
  author?: AuthorInput | null;

  @Field(() => [String], { nullable: true })
  tags?: string[] | null;

  @Field(() => Boolean, { nullable: true, description: 'Published unless false.' })
  isPublished?: boolean | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description:
      'When it was published, as its page says, for one written before: never in the future. ' +
      'Now when not given.',
  })
  publishDate?: Date | null;

  @Field(() => String, { nullable: true })
  templateSuffix?: string | null;
}

@InputType({ description: 'Changes to an article: fields left out stay as they are.' })
export class ArticleUpdateInput {
  @Field(() => ID, { nullable: true, description: 'Another blog to move it to.' })
  blogId?: string | null;

  @Field(() => String, { nullable: true })
  title?: string | null;

  @Field(() => String, { nullable: true })
  handle?: string | null;

  @Field(() => String, { nullable: true, description: 'HTML, cleaned before it is kept.' })
  body?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'HTML, cleaned before it is kept; blank for none.',
  })
  summary?: string | null;

  @Field(() => AuthorInput, { nullable: true })
  author?: AuthorInput | null;

  @Field(() => [String], { nullable: true })
  tags?: string[] | null;

  @Field(() => Boolean, { nullable: true })
  isPublished?: boolean | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When it was published, as its page says: never in the future.',
  })
  publishDate?: Date | null;

  @Field(() => String, { nullable: true, description: 'Blank for article.json.' })
  templateSuffix?: string | null;

  @Field(() => Boolean, {
    nullable: true,
    description:
      "With a new handle or blog, whether the article's old address sends shoppers to its new " +
      'one: a URL redirect is made, as on Shopify. False unless given.',
  })
  redirectNewHandle?: boolean | null;
}

@ObjectType()
export class BlogCreatePayload {
  @Field(() => OnlineStoreBlog, { nullable: true })
  blog!: OnlineStoreBlog | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class BlogUpdatePayload {
  @Field(() => OnlineStoreBlog, { nullable: true })
  blog!: OnlineStoreBlog | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class BlogDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedBlogId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class ArticleCreatePayload {
  @Field(() => OnlineStoreArticle, { nullable: true })
  article!: OnlineStoreArticle | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class ArticleUpdatePayload {
  @Field(() => OnlineStoreArticle, { nullable: true })
  article!: OnlineStoreArticle | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class ArticleDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedArticleId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
