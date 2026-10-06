import { PageInfo, UserError } from '@hatti/api';
import {
  ArgsType,
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import type { TranslationRecord } from '../translation.service.js';

/** Shopify's TranslatableResourceType; the values are the online store's own kinds (ADR-238). */
export enum TranslatableResourceType {
  PRODUCT = 'product',
  COLLECTION = 'collection',
  ONLINE_STORE_PAGE = 'page',
  ONLINE_STORE_BLOG = 'blog',
  ONLINE_STORE_ARTICLE = 'article',
  MENU = 'menu',
  LINK = 'menuItem',
  SHOP_POLICY = 'shopPolicy',
  PRODUCT_OPTION = 'productOption',
  PRODUCT_OPTION_VALUE = 'productOptionValue',
}

registerEnumType(TranslatableResourceType, {
  name: 'TranslatableResourceType',
  description: "What of a shop's may be translated, as Shopify names it.",
  valuesMap: {
    PRODUCT: {
      description: 'A product: its title, description, type, and SEO title and description.',
    },
    COLLECTION: {
      description: 'A collection: its title, description, and SEO title and description.',
    },
    ONLINE_STORE_PAGE: { description: 'A page: its title, body, and SEO title and description.' },
    ONLINE_STORE_BLOG: { description: 'A blog: its title.' },
    ONLINE_STORE_ARTICLE: {
      description: 'An article: its title, body, summary, and SEO title and description.',
    },
    MENU: { description: 'A menu: its title.' },
    LINK: { description: "A menu's item, at any level: its title." },
    SHOP_POLICY: {
      description:
        "A policy: its body, shown on the storefront's Urdu pages while it translates the policy " +
        'as it is (ADR-239).',
    },
    PRODUCT_OPTION: {
      description: "A product's option, such as Size: its name, shown with its values (ADR-241).",
    },
    PRODUCT_OPTION_VALUE: {
      description:
        "An option's value, such as Small: its name, in each variant's title too (ADR-241).",
    },
  },
});

/** Shopify's LocalizableContentType, as far as Hatti's fields go. */
export enum LocalizableContentType {
  SINGLE_LINE_TEXT_FIELD = 'single_line_text_field',
  MULTI_LINE_TEXT_FIELD = 'multi_line_text_field',
  HTML = 'html',
}

registerEnumType(LocalizableContentType, {
  name: 'LocalizableContentType',
  description: "How a field's words are written, so an editor knows how to take its translation.",
  valuesMap: {
    SINGLE_LINE_TEXT_FIELD: { description: 'Words on one line, such as a title.' },
    MULTI_LINE_TEXT_FIELD: { description: 'Words that may run long, such as an SEO description.' },
    HTML: { description: 'HTML, cleaned when kept of anything that could run.' },
  },
});

@ObjectType({
  description:
    "A field of the shop's own that may be translated, in its own language, as Shopify's " +
    'TranslatableContent: a translation names its digest.',
})
export class TranslatableContent {
  @Field({ description: "The field, by Shopify's key: title, body_html, meta_title…" })
  key!: string;

  @Field(() => String, { nullable: true })
  value!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'SHA-256 of `value`, in hex: give it with a translation of these words.',
  })
  digest!: string | null;

  @Field({ description: "The language it is in: the storefront's own, en." })
  locale!: string;

  @Field(() => LocalizableContentType)
  type!: LocalizableContentType;
}

@ObjectType({
  description: "A field in another of the storefront's languages, as Shopify's Translation.",
})
export class Translation {
  @Field()
  key!: string;

  @Field(() => String, { nullable: true })
  value!: string | null;

  @Field({ description: 'Its language: ur.' })
  locale!: string;

  @Field({
    description:
      "Whether the shop's own words have changed since it was written for them: the storefront " +
      'shows it until it is written again or removed.',
  })
  outdated!: boolean;

  @Field(() => GraphQLISODateTime, { nullable: true })
  updatedAt!: Date | null;
}

@ObjectType({
  description:
    "Something of the shop's that may be translated, as Shopify's TranslatableResource: its " +
    "fields with words, and their translations. The storefront's Urdu pages show each " +
    'translation in place of its field (ADR-238).',
})
export class TranslatableResource {
  @Field(() => ID, {
    description: 'The product, collection, page, blog, article, menu, menu item or policy.',
  })
  resourceId!: string;

  @Field(() => [TranslatableContent])
  translatableContent!: TranslatableContent[];

  /** All its translations; the `translations` field gives those of a language. */
  kept!: TranslationRecord[];
}

@ObjectType()
export class TranslatableResourceEdge {
  @Field()
  cursor!: string;

  @Field(() => TranslatableResource)
  node!: TranslatableResource;
}

@ObjectType()
export class TranslatableResourceConnection {
  @Field(() => [TranslatableResourceEdge])
  edges!: TranslatableResourceEdge[];

  @Field(() => [TranslatableResource])
  nodes!: TranslatableResource[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class TranslatableResourcesArgs {
  @Field(() => TranslatableResourceType)
  resourceType!: TranslatableResourceType;

  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;
}

@InputType({ description: "A field's translation, as Shopify's TranslationInput." })
export class TranslationInput {
  @Field({ description: 'Its language: ur.' })
  locale!: string;

  @Field({ description: "The field, by Shopify's key, as its TranslatableContent names it." })
  key!: string;

  @Field({
    description:
      "Its words: a title on one line; a product's or collection's description as HTML, kept as " +
      'its paragraphs and line breaks, as the description is; HTML of a page or article cleaned ' +
      'of anything that could run.',
  })
  value!: string;

  @Field({
    description:
      "The digest of the shop's own words it translates, as their TranslatableContent gives it: " +
      'refused with STALE if they have changed since.',
  })
  translatableContentDigest!: string;
}

@ObjectType()
export class TranslationsRegisterPayload {
  @Field(() => [Translation], { nullable: true, description: 'Those kept; null on errors.' })
  translations!: Translation[] | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class TranslationsRemovePayload {
  @Field(() => [Translation], { nullable: true, description: 'Those removed; null on errors.' })
  translations!: Translation[] | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
