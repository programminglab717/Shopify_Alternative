import { CurrentTenant, RequireScopes, UserError, failOne, type TenantContext } from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import {
  Args,
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  Mutation,
  ObjectType,
  Parent,
  Query,
  ResolveField,
  Resolver,
  registerEnumType,
} from '@nestjs/graphql';
import { SellingPlanService, type SellingPlanRecord } from '../selling-plans.js';

export enum SellingPlanInterval {
  WEEK = 'WEEK',
  MONTH = 'MONTH',
}

registerEnumType(SellingPlanInterval, { name: 'SellingPlanInterval' });

@ObjectType({ description: 'A variant a selling plan is for alone (ADR-930).' })
export class SellingPlanVariant {
  @Field(() => ID)
  id!: string;

  @Field({ description: "The product's title, and the variant's where it has several." })
  title!: string;
}

@ObjectType({
  description:
    'How the shop sells by subscription (CAT-16, ADR-862): "Every month, 10% off", for its ' +
    "products of a tag, all of them, or chosen variants (ADR-930). A shopper subscribes on a product's page; their order is " +
    "placed again each interval, by cash on delivery, at the plan's price.",
})
export class SellingPlan {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => SellingPlanInterval)
  intervalUnit!: SellingPlanInterval;

  @Field(() => Int, { description: 'Every this many weeks or months: 1 to 12.' })
  intervalCount!: number;

  @Field(() => Int, { description: "What it takes off the items' prices, 0 to 50 percent." })
  discountPercent!: number;

  @Field(() => String, {
    nullable: true,
    description: 'The tag of the products it is for, ignoring case; null for all of them.',
  })
  productTag!: string | null;

  @Field(() => Int, {
    description:
      'How many orders a subscriber takes before they may cancel themselves, 0 to 12; 0 for ' +
      'none (ADR-928). Staff cancel whenever they must.',
  })
  minimumOrders!: number;

  /** Internal IDs of the variants it is for alone, read by `variants`. */
  variantIds!: string[] | null;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class SellingPlanInput {
  @Field()
  name!: string;

  @Field(() => SellingPlanInterval)
  intervalUnit!: SellingPlanInterval;

  @Field(() => Int)
  intervalCount!: number;

  @Field(() => Int)
  discountPercent!: number;

  @Field(() => String, { nullable: true })
  productTag?: string | null;

  @Field(() => Int, { nullable: true, description: '0 to 12; 0 for none, unless given.' })
  minimumOrders?: number | null;

  @Field(() => [ID], {
    nullable: true,
    description:
      'The variants it is for alone, 50 at most, rather than its products of a tag or all of ' +
      'them (ADR-930); none, or not given, for those.',
  })
  variantIds?: string[] | null;
}

@ObjectType()
export class SellingPlanPayload {
  @Field(() => SellingPlan, { nullable: true })
  sellingPlan!: SellingPlan | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class SellingPlanDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedSellingPlanId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

const NOT_FOUND = 'No selling plan of the shop has this ID';
const NO_VARIANT = 'No variant of the shop has one of these IDs';

const toPlan = (record: SellingPlanRecord) =>
  Object.assign(new SellingPlan(), {
    ...record,
    id: toPublicId('sellingPlan', record.id),
    intervalUnit: record.intervalUnit.toUpperCase() as SellingPlanInterval,
  });

const payload = (result: Awaited<ReturnType<SellingPlanService['create']>>) =>
  Object.assign(new SellingPlanPayload(), {
    sellingPlan: result.ok ? toPlan(result.value) : null,
    userErrors: result.ok ? [] : UserError.list(result.errors),
  });

/** The service's input, or null where a variant's ID is no variant's. */
const inputOf = (input: SellingPlanInput) => {
  const variantIds = (input.variantIds ?? []).map((id) => tryFromPublicId(id, 'variant'));
  if (variantIds.some((id) => id === null)) return null;
  return {
    ...input,
    intervalUnit: input.intervalUnit.toLowerCase(),
    variantIds: variantIds as string[],
  };
};

const noVariant = () =>
  failOne<SellingPlanRecord>(['input', 'variantIds'], 'NOT_FOUND', NO_VARIANT);

/** The shop's selling plans (ADR-862). */
@Resolver(() => SellingPlan)
export class SellingPlanResolver {
  constructor(private readonly plans: SellingPlanService) {}

  @Query(() => [SellingPlan], { description: "The shop's selling plans, in the order made." })
  @RequireScopes('read_products')
  async sellingPlans(@CurrentTenant() tenant: TenantContext): Promise<SellingPlan[]> {
    return (await this.plans.list(tenant)).map(toPlan);
  }

  @ResolveField(() => [SellingPlanVariant], {
    nullable: true,
    description: 'The variants it is for alone (ADR-930); null where it is for products.',
  })
  async variants(
    @CurrentTenant() tenant: TenantContext,
    @Parent() plan: SellingPlan,
  ): Promise<SellingPlanVariant[] | null> {
    if (!plan.variantIds) return null;
    return (await this.plans.variantTitles(tenant, plan.variantIds)).map((each) =>
      Object.assign(new SellingPlanVariant(), {
        id: toPublicId('variant', each.id),
        title: each.title,
      }),
    );
  }

  @Mutation(() => SellingPlanPayload, { description: 'Makes a selling plan: ten a shop at most.' })
  @RequireScopes('write_products')
  async sellingPlanCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: SellingPlanInput,
  ): Promise<SellingPlanPayload> {
    const checked = inputOf(input);
    return payload(checked ? await this.plans.create(tenant, checked) : noVariant());
  }

  @Mutation(() => SellingPlanPayload, {
    description: 'Changes a selling plan: subscriptions made already keep it as it was.',
  })
  @RequireScopes('write_products')
  async sellingPlanUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: SellingPlanInput,
  ): Promise<SellingPlanPayload> {
    const uuid = tryFromPublicId(id, 'sellingPlan');
    const checked = inputOf(input);
    if (!uuid) return payload(failOne(['id'], 'NOT_FOUND', NOT_FOUND));
    return payload(checked ? await this.plans.update(tenant, uuid, checked) : noVariant());
  }

  @Mutation(() => SellingPlanDeletePayload, {
    description: 'Deletes a selling plan: subscriptions made with it keep going.',
  })
  @RequireScopes('write_products')
  async sellingPlanDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<SellingPlanDeletePayload> {
    const uuid = tryFromPublicId(id, 'sellingPlan');
    const result = uuid
      ? await this.plans.delete(tenant, uuid)
      : failOne<string>(['id'], 'NOT_FOUND', NOT_FOUND);
    return Object.assign(new SellingPlanDeletePayload(), {
      deletedSellingPlanId: result.ok ? toPublicId('sellingPlan', result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
