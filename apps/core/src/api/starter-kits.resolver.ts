import { CurrentTenant, RequireScopes, type TenantContext } from '@hatti/api';
import {
  Args,
  Field,
  Int,
  Mutation,
  ObjectType,
  Query,
  Resolver,
  registerEnumType,
} from '@nestjs/graphql';
import {
  STARTER_KITS,
  StarterKitService,
  starterKit,
  type StarterKitValue,
} from './starter-kits.js';

export enum StarterKit {
  FASHION = 'fashion',
  JEWELLERY = 'jewellery',
  BEAUTY = 'beauty',
  ELECTRONICS = 'electronics',
  GROCERY = 'grocery',
}

registerEnumType(StarterKit, {
  name: 'StarterKit',
  description: 'What a shop sells, set up in one go (ONB-13, ADR-486).',
  valuesMap: {
    FASHION: { description: 'Clothes, stitched and unstitched.' },
    JEWELLERY: { description: 'Jewellery.' },
    BEAUTY: { description: 'Beauty and fragrance.' },
    ELECTRONICS: { description: 'Electronics and accessories.' },
    GROCERY: { description: 'Bakery and grocery.' },
  },
});

@ObjectType({ description: "A collection a kit makes: smart, filled by its products' tag." })
export class StarterKitCollection {
  @Field()
  title!: string;

  @Field()
  handle!: string;

  @Field(() => String, {
    nullable: true,
    description: 'The tag that puts a product in it; null for new arrivals and the sale.',
  })
  tag!: string | null;
}

@ObjectType({ description: 'A starter kit, as applying it would set it up.' })
export class StarterKitPreview {
  @Field(() => StarterKit)
  kit!: StarterKit;

  @Field(() => [StarterKitCollection])
  collections!: StarterKitCollection[];

  @Field(() => [String], { description: 'The size charts it makes, by name.' })
  sizeCharts!: string[];
}

@ObjectType()
export class StarterKitApplyPayload {
  @Field(() => Int, { description: 'Collections made.' })
  collectionsMade!: number;

  @Field(() => Int, {
    description: 'Collections the shop had already, by handle, left as they are.',
  })
  collectionsKept!: number;

  @Field(() => Int)
  sizeChartsMade!: number;

  @Field(() => Int, { description: 'Links to its collections added to the main menu.' })
  menuLinksAdded!: number;
}

@Resolver()
export class StarterKitsResolver {
  constructor(private readonly kits: StarterKitService) {}

  @Query(() => [StarterKitPreview], {
    description: 'The starter kits a shop may apply (ONB-13), and what each sets up.',
  })
  @RequireScopes('read_products')
  starterKits(): StarterKitPreview[] {
    return STARTER_KITS.map((kit) => {
      const found = starterKit(kit);
      return Object.assign(new StarterKitPreview(), {
        kit: kit as StarterKit,
        collections: found.collections.map(({ title, handle, tag }) =>
          Object.assign(new StarterKitCollection(), { title, handle, tag }),
        ),
        sizeCharts: found.sizeCharts.map((chart) => chart.name),
      });
    });
  }

  @Mutation(() => StarterKitApplyPayload, {
    description:
      "Sets up what a kind of shop sells by (ONB-13, ADR-486): the kit's smart collections, " +
      'filled by tags, its size charts, and links to its collections in the main menu. What ' +
      'the shop has already, by handle or name, is left as it is, so a kit may be applied again.',
  })
  @RequireScopes('write_products', 'write_online_store_navigation')
  async starterKitApply(
    @CurrentTenant() tenant: TenantContext,
    @Args('kit', { type: () => StarterKit }) kit: StarterKit,
  ): Promise<StarterKitApplyPayload> {
    return Object.assign(
      new StarterKitApplyPayload(),
      await this.kits.apply(tenant, kit as StarterKitValue),
    );
  }
}
