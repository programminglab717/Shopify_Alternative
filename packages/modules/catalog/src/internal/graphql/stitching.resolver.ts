import {
  CurrentTenant,
  Loaders,
  Money,
  RequestLoaders,
  RequireScopes,
  UserError,
  failOne,
  type TenantContext,
} from '@hatti/api';
import { tryFromPublicId } from '@hatti/ids';
import { money } from '@hatti/money';
import {
  Args,
  Field,
  ID,
  InputType,
  Int,
  Mutation,
  ObjectType,
  Parent,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import {
  MEASUREMENTS,
  STITCHING_LIMITS,
  StitchingService,
  measurementProperty,
  type MeasurementKey,
  type StitchingOffer,
} from '../stitching.js';
import { uuidOf } from './mappers.js';
import { Product } from './product.types.js';

@ObjectType({ description: 'A measurement a stitched piece is made to, in inches.' })
export class StitchingMeasurement {
  @Field({ description: 'Its key: "chest".' })
  key!: string;

  @Field({ description: 'What it is: "Chest".' })
  name!: string;

  @Field({ description: 'The cart line property its answer goes in: "Chest (inches)".' })
  property!: string;
}

@ObjectType({
  description:
    'Stitching offered with a product (CAT-09, ADR-802): a line stitched says "Stitching: ' +
    'Stitched" among its properties, each measurement a property of its own in inches.',
})
export class ProductStitching {
  @Field(() => Money, { description: 'What it adds to each unit’s price.' })
  price!: Money;

  @Field(() => Int, { description: 'How many days more a stitched piece takes before it ships.' })
  leadDays!: number;

  @Field(() => [StitchingMeasurement], { description: 'In the order tailors take them.' })
  measurements!: StitchingMeasurement[];
}

@InputType()
export class ProductStitchingInput {
  @Field({ description: 'What it adds to each unit’s price, as "1500".' })
  price!: string;

  @Field(() => Int, {
    description: `${STITCHING_LIMITS.leadDays.min} to ${STITCHING_LIMITS.leadDays.max} days.`,
  })
  leadDays!: number;

  @Field(() => [String], {
    description: `The measurements asked for, by their keys: ${Object.keys(MEASUREMENTS).join(', ')}.`,
  })
  measurements!: string[];
}

@ObjectType()
export class ProductStitchingSetPayload {
  @Field(() => ProductStitching, { nullable: true })
  stitching!: ProductStitching | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

const toStitching = (offer: StitchingOffer, tenant: TenantContext): ProductStitching =>
  Object.assign(new ProductStitching(), {
    price: Money.from(money(BigInt(offer.price), tenant.currency)),
    leadDays: offer.leadDays,
    measurements: offer.measurements.map((key: MeasurementKey) =>
      Object.assign(new StitchingMeasurement(), {
        key,
        name: MEASUREMENTS[key],
        property: measurementProperty(key),
      }),
    ),
  });

/** Stitching offered with a product (CAT-09, ADR-802): a field of products, and setting it. */
@Resolver(() => Product)
export class StitchingResolver {
  constructor(private readonly service: StitchingService) {}

  @ResolveField(() => ProductStitching, {
    nullable: true,
    description: 'The stitching it is offered with, if any (ADR-802).',
  })
  @RequireScopes('read_products')
  async stitching(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() product: Product,
  ): Promise<ProductStitching | null> {
    const loader = loaders.get<string, StitchingOffer>('catalog.stitching', (ids) =>
      this.service.of(tenant, ids),
    );
    const offer = await loader.load(uuidOf('product', product.id));
    return offer ? toStitching(offer, tenant) : null;
  }

  @Mutation(() => ProductStitchingSetPayload, {
    description:
      'Offers stitching with a product, in place of what it offered: what it adds to each ' +
      "unit's price, the days it adds before shipping, and the measurements its page asks for. " +
      'A null `stitching`, and it offers none.',
  })
  @RequireScopes('write_products')
  async productStitchingSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('productId', { type: () => ID }) productId: string,
    @Args('stitching', { type: () => ProductStitchingInput, nullable: true })
    stitching: ProductStitchingInput | null,
  ): Promise<ProductStitchingSetPayload> {
    const id = tryFromPublicId(productId, 'product');
    const result = id
      ? await this.service.set(tenant, id, stitching ?? null)
      : failOne<StitchingOffer | null>(['productId'], 'NOT_FOUND', 'Product not found');
    return Object.assign(new ProductStitchingSetPayload(), {
      stitching: result.ok && result.value ? toStitching(result.value, tenant) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
