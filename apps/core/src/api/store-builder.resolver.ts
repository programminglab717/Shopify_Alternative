import {
  CurrentTenant,
  InputChecker,
  RequireScopes,
  UserError,
  type TenantContext,
} from '@hatti/api';
import { toPublicId } from '@hatti/ids';
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
import { STORE_BUILDER_LIMITS, StoreBuilderService, type StorePlan } from './store-builder.js';
import { StarterKit } from './starter-kits.resolver.js';
import type { StarterKitValue } from './starter-kits.js';

@ObjectType({ description: "What the store builder makes of a shop's description (ONB-03)." })
export class StoreBuildPlan {
  @Field(() => StarterKit, {
    nullable: true,
    description: 'The starter kit its words call for most; null when they call for none.',
  })
  kit!: StarterKit | null;

  @Field({ description: "The main theme's accent colour, such as #9F1239." })
  accentColour!: string;

  @Field({ description: 'The About us page, as HTML: the description, a paragraph each.' })
  aboutHtml!: string;

  @Field({ description: "What search engines are told of the home page: the shop's name." })
  seoTitle!: string;

  @Field({ description: 'And its description: the first sentence, at most 160 characters.' })
  seoDescription!: string;
}

@ObjectType()
export class StoreBuildPage {
  @Field(() => ID)
  id!: string;

  @Field()
  handle!: string;
}

@ObjectType()
export class StoreBuildPayload {
  @Field(() => StoreBuildPlan, { nullable: true, description: 'Null when nothing was done.' })
  plan!: StoreBuildPlan | null;

  @Field(() => Int)
  collectionsMade!: number;

  @Field(() => Int)
  sizeChartsMade!: number;

  @Field(() => Int)
  menuLinksAdded!: number;

  @Field({ description: 'Whether the main theme took the accent; false where there is none.' })
  accentSet!: boolean;

  @Field(() => StoreBuildPage, {
    nullable: true,
    description: 'The About us page made; null where the shop had one, at about-us.',
  })
  aboutPage!: StoreBuildPage | null;

  @Field({ description: "Whether the home page's SEO was set; false where the shop set its own." })
  seoSet!: boolean;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@InputType()
export class StoreBuildInput {
  @Field({
    description:
      'What the shop sells, and for whom, in a few lines: 20 to 2,000 characters. A blank line ' +
      'starts a paragraph of its About us page.',
  })
  description!: string;

  @Field(() => StarterKit, {
    nullable: true,
    description: 'The kit to apply, where its words call for another; else the one they call for.',
  })
  kit?: StarterKit | null;

  @Field(() => String, {
    nullable: true,
    description: "A hex colour, such as #0F766E, for the theme's accent; else the kit's.",
  })
  accentColour?: string | null;
}

/** The checked description, kit and accent; or what is wrong with them. */
function checked(input: StoreBuildInput) {
  const check = new InputChecker();
  const description = check.text(['input', 'description'], input.description, {
    required: true,
    max: STORE_BUILDER_LIMITS.description.max,
  });
  if (description !== null && description.length < STORE_BUILDER_LIMITS.description.min) {
    check.add(
      ['input', 'description'],
      'INVALID',
      `must have at least ${STORE_BUILDER_LIMITS.description.min} characters`,
    );
  }
  const accent = input.accentColour?.trim() || null;
  if (accent !== null && !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(accent)) {
    check.add(['input', 'accentColour'], 'INVALID', 'must be a hex colour, such as #0F766E');
  }
  return { check, description, accent };
}

function toPlan(plan: StorePlan): StoreBuildPlan {
  return Object.assign(new StoreBuildPlan(), {
    kit: plan.kit as StarterKit | null,
    accentColour: plan.accent,
    aboutHtml: plan.about,
    seoTitle: plan.seo.title,
    seoDescription: plan.seo.description,
  });
}

/** The store builder (ONB-03, ADR-502). */
@Resolver()
export class StoreBuilderResolver {
  constructor(private readonly builder: StoreBuilderService) {}

  @Query(() => StoreBuildPlan, {
    description:
      "What storeBuild would make of the shop's description (ONB-03): its kit, accent, About " +
      'us page and home page SEO. Changes nothing.',
  })
  @RequireScopes('read_products')
  async storeBuildPlan(
    @CurrentTenant() tenant: TenantContext,
    @Args('description') description: string,
  ): Promise<StoreBuildPlan> {
    return toPlan(await this.builder.plan(tenant, description));
  }

  @Mutation(() => StoreBuildPayload, {
    description:
      'Sets the shop up from a few lines saying what it sells (ONB-03, ADR-502): the starter kit ' +
      "its words call for, or the one given (ADR-486); the kit's accent, or the one given, in " +
      "the main theme's settings; an About us page of the lines; and the home page's SEO. A " +
      'page at about-us, and SEO the shop set, are left as they are.',
  })
  @RequireScopes(
    'write_products',
    'write_online_store_navigation',
    'write_online_store_pages',
    'write_themes',
    'write_settings',
  )
  async storeBuild(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: StoreBuildInput,
  ): Promise<StoreBuildPayload> {
    const { check, description, accent } = checked(input);
    if (!check.ok || description === null) {
      return Object.assign(new StoreBuildPayload(), {
        plan: null,
        collectionsMade: 0,
        sizeChartsMade: 0,
        menuLinksAdded: 0,
        accentSet: false,
        aboutPage: null,
        seoSet: false,
        userErrors: UserError.list(check.errors),
      });
    }
    const built = await this.builder.build(tenant, {
      description,
      kit: input.kit === undefined ? undefined : (input.kit as StarterKitValue | null),
      accent,
    });
    return Object.assign(new StoreBuildPayload(), {
      ...built,
      plan: toPlan(built.plan),
      aboutPage: built.aboutPage && {
        id: toPublicId('page', built.aboutPage.id),
        handle: built.aboutPage.handle,
      },
      userErrors: [],
    });
  }
}
