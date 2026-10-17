import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
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
  registerEnumType,
} from '@nestjs/graphql';
import { COPY_DRAFT_LIMITS, CopyDraftService } from '../copy-drafts.service.js';
import { failOne } from '../input-checker.js';

export enum CopyLanguage {
  ENGLISH = 'ENGLISH',
  URDU = 'URDU',
  ROMAN_URDU = 'ROMAN_URDU',
}

registerEnumType(CopyLanguage, {
  name: 'CopyLanguage',
  description:
    'The language AI copy is written in: English, Urdu in its own script, or Roman Urdu, Urdu ' +
    'in Latin letters as shoppers write it on WhatsApp.',
});

const LANGUAGE = {
  [CopyLanguage.ENGLISH]: 'en',
  [CopyLanguage.URDU]: 'ur',
  [CopyLanguage.ROMAN_URDU]: 'roman_ur',
} as const;

@InputType({ description: 'One of a product’s options and its values, as its form has them.' })
export class ProductCopyOptionInput {
  @Field()
  name!: string;

  @Field(() => [String])
  values!: string[];
}

@InputType({ description: 'What the shop says of a product, for the AI to write its copy from.' })
export class ProductCopyDraftInput {
  @Field(() => CopyLanguage)
  language!: CopyLanguage;

  @Field(() => ID, {
    nullable: true,
    description: 'The product it is for; none for a product still being added.',
  })
  productId?: string | null;

  @Field(() => String, { nullable: true })
  title?: string | null;

  @Field(() => String, { nullable: true })
  productType?: string | null;

  @Field(() => String, { nullable: true })
  vendor?: string | null;

  @Field(() => [String], { nullable: true })
  tags?: string[] | null;

  @Field(() => [ProductCopyOptionInput], { nullable: true })
  options?: ProductCopyOptionInput[] | null;

  @Field(() => String, {
    nullable: true,
    description:
      'The shop’s own words of it: fabric, pieces, measurements, care, what is in the box.',
  })
  notes?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'Its description as it stands, which the draft may build on.',
  })
  description?: string | null;

  @Field(() => Boolean, {
    nullable: true,
    defaultValue: false,
    description:
      'Whether the AI looks at the product’s first three ready photos too, saying what they ' +
      'plainly show (APP-02): for a product added from a photo, with nothing else said of it. ' +
      'Needs `productId`.',
  })
  usePhotos?: boolean | null;
}

@ObjectType({
  description: 'A draft of a product’s copy, never kept: the shop checks it and saves it.',
})
export class ProductCopyDraft {
  @Field()
  title!: string;

  @Field({ description: 'Paragraphs and lists alone: p, ul, ol, li, strong, em and br.' })
  descriptionHtml!: string;

  @Field({ description: 'The title search engines show, at most 70 characters.' })
  seoTitle!: string;

  @Field({ description: 'The description search engines show, at most 320 characters.' })
  seoDescription!: string;
}

@ObjectType()
export class ProductCopyDraftPayload {
  @Field(() => ProductCopyDraft, { nullable: true, description: 'The draft; null on errors.' })
  draft!: ProductCopyDraft | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class ProductCopyDrafting {
  @Field(() => Boolean, { description: 'Whether this Hatti writes products’ copy with AI at all.' })
  available!: boolean;

  @Field(() => Int, { description: 'Drafts the shop asked for in the last 24 hours.' })
  usedToday!: number;

  @Field(() => Int, { description: 'Drafts a shop may ask for in 24 hours.' })
  limitPerDay!: number;

  @Field(() => Int, {
    nullable: true,
    description:
      "The AI credits of the shop's plan left this month, each spent on a draft the AI gives " +
      '(ADR-533): none left, it drafts no more until the next month.',
  })
  creditsLeft!: number | null;

  @Field(() => Int, {
    nullable: true,
    description: "AI credits the shop's plan includes a month.",
  })
  creditsPerMonth!: number | null;
}

/** AI drafts of products' copy (CAT-20, ADR-471). */
@Resolver()
export class CopyDraftResolver {
  constructor(private readonly service: CopyDraftService) {}

  @Query(() => ProductCopyDrafting, {
    description:
      'Whether the shop may ask for AI drafts of products’ copy (CAT-20), and how many it asked ' +
      'for in the last 24 hours.',
  })
  @RequireScopes('read_products')
  async productCopyDrafting(@CurrentTenant() tenant: TenantContext): Promise<ProductCopyDrafting> {
    return Object.assign(new ProductCopyDrafting(), await this.service.drafting(tenant));
  }

  @Mutation(() => ProductCopyDraftPayload, {
    description:
      "An AI draft of a product's title, description and search engine title and description, " +
      'from what the shop says of it, in the language asked for (CAT-20, ADR-471). It says ' +
      'nothing the shop did not; nothing is kept: the shop checks it in its form and saves it. ' +
      `${COPY_DRAFT_LIMITS.perDay} a day per shop.`,
  })
  @RequireScopes('write_products')
  async productCopyDraft(
    @CurrentTenant() tenant: TenantContext,
    @Args('input', { type: () => ProductCopyDraftInput }) input: ProductCopyDraftInput,
  ): Promise<ProductCopyDraftPayload> {
    const productId = input.productId ? tryFromPublicId(input.productId, 'product') : null;
    const result =
      input.productId && !productId
        ? failOne(['input', 'productId'], 'NOT_FOUND', 'No such product')
        : await this.service.draft(tenant, {
            language: LANGUAGE[input.language],
            productId,
            title: input.title,
            productType: input.productType,
            vendor: input.vendor,
            tags: input.tags ?? [],
            options: input.options ?? [],
            notes: input.notes,
            description: input.description,
            usePhotos: input.usePhotos ?? false,
          });
    return Object.assign(new ProductCopyDraftPayload(), {
      draft: result.ok ? Object.assign(new ProductCopyDraft(), result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
