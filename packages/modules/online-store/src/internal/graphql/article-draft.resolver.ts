import { CurrentTenant, RequireScopes, UserError, failOne, type TenantContext } from '@hatti/api';
import { COPY_LANGUAGE, CopyLanguage } from '@hatti/catalog/public';
import { tryFromPublicId } from '@hatti/ids';
import {
  Args,
  Field,
  ID,
  InputType,
  Int,
  Mutation,
  ObjectType,
  Query,
  Resolver,
} from '@nestjs/graphql';
import { ARTICLE_DRAFT_ASKS, ArticleDraftService } from '../article-drafts.js';

@InputType({ description: 'What the shop wants an article to say (MKT-15, ADR-801).' })
export class ArticleCopyDraftInput {
  @Field(() => CopyLanguage)
  language!: CopyLanguage;

  @Field({ description: 'What it is about: "How to care for lawn suits in summer".' })
  topic!: string;

  @Field(() => String, {
    nullable: true,
    description:
      "What it must say, in the shop's own words: its products, its facts, its points. The " +
      'article says nothing of the shop it does not.',
  })
  notes?: string | null;

  @Field(() => ID, { nullable: true, description: 'The blog it is for, whose kind it keeps to.' })
  blogId?: string | null;
}

@ObjectType()
export class ArticleCopyDraft {
  @Field()
  title!: string;

  @Field({
    description:
      'Paragraphs, headings and lists alone: p, h2, h3, ul, ol, li, strong, em, br and blockquote.',
  })
  bodyHtml!: string;

  @Field({ description: "A sentence or two for the blog's list and feed: p, strong, em and br." })
  summaryHtml!: string;

  @Field({ description: 'The title search engines show, at most 70 characters.' })
  seoTitle!: string;

  @Field({ description: 'The description search engines show, at most 320 characters.' })
  seoDescription!: string;
}

@ObjectType()
export class ArticleCopyDraftPayload {
  @Field(() => ArticleCopyDraft, { nullable: true, description: 'The draft; null on errors.' })
  draft!: ArticleCopyDraft | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class ArticleCopyDrafting {
  @Field({ description: 'Whether this Hatti writes articles with AI at all.' })
  available!: boolean;

  @Field(() => Int, { description: 'Drafts of articles asked for in the last 24 hours.' })
  usedToday!: number;

  @Field(() => Int, { description: 'Drafts of articles a shop may ask for in 24 hours.' })
  limitPerDay!: number;

  @Field(() => Int, {
    nullable: true,
    description:
      "The AI credits of the shop's plan left this month, each spent on a draft the AI gives " +
      '(ADR-533): none left, it drafts no more until the next month.',
  })
  creditsLeft!: number | null;

  @Field(() => Int, { nullable: true, description: "AI credits the shop's plan includes a month." })
  creditsPerMonth!: number | null;
}

/** AI drafts of blog articles (MKT-15, ADR-801). */
@Resolver()
export class ArticleDraftResolver {
  constructor(private readonly service: ArticleDraftService) {}

  @Query(() => ArticleCopyDrafting, {
    description: 'Whether the shop may ask for AI drafts of articles, and how many it has today.',
  })
  @RequireScopes('write_content')
  async articleCopyDrafting(@CurrentTenant() tenant: TenantContext): Promise<ArticleCopyDrafting> {
    return Object.assign(new ArticleCopyDrafting(), await this.service.drafting(tenant));
  }

  @Mutation(() => ArticleCopyDraftPayload, {
    description:
      "An AI draft of a blog article's title, body, summary and search engine title and " +
      'description, from what the shop wants it to say, in the language asked for (MKT-15, ' +
      'ADR-801). It says nothing of the shop the shop did not; nothing is kept: the shop checks ' +
      'it in its form and saves it. Each draft spends one of the AI credits of the shop’s plan; ' +
      `${ARTICLE_DRAFT_ASKS.perDay} a day per shop.`,
  })
  @RequireScopes('write_content')
  async articleCopyDraft(
    @CurrentTenant() tenant: TenantContext,
    @Args('input', { type: () => ArticleCopyDraftInput }) input: ArticleCopyDraftInput,
  ): Promise<ArticleCopyDraftPayload> {
    const blogId = input.blogId ? tryFromPublicId(input.blogId, 'blog') : null;
    const result =
      input.blogId && !blogId
        ? failOne(['input', 'blogId'], 'NOT_FOUND', 'No such blog')
        : await this.service.draft(tenant, {
            language: COPY_LANGUAGE[input.language],
            topic: input.topic,
            notes: input.notes,
            blogId,
          });
    return Object.assign(new ArticleCopyDraftPayload(), {
      draft: result.ok ? Object.assign(new ArticleCopyDraft(), result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
