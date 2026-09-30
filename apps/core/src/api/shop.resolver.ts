import {
  CurrencyCode,
  CurrentTenant,
  StorefrontSite,
  shopProfile,
  type TenantContext,
} from '@hatti/api';
import { Database } from '@hatti/db';
import { toPublicId } from '@hatti/ids';
import { Field, ID, ObjectType, Query, Resolver } from '@nestjs/graphql';

@ObjectType({ description: 'The shop that the access token belongs to.' })
export class Shop {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field({
    description:
      'Names the storefront on the platform, as "zari" does for zari.hatti.pk. Given when the ' +
      'shop is made; it does not change.',
  })
  handle!: string;

  @Field({ description: "The storefront's address, such as https://zari.hatti.pk." })
  url!: string;

  @Field(() => CurrencyCode)
  currencyCode!: string;

  @Field({ description: 'IANA time zone, e.g. Asia/Karachi.' })
  timezone!: string;
}

@Resolver(() => Shop)
export class ShopResolver {
  constructor(
    private readonly db: Database,
    private readonly storefronts: StorefrontSite,
  ) {}

  @Query(() => Shop, { description: 'The shop of the current access token.' })
  async shop(@CurrentTenant() tenant: TenantContext): Promise<Shop> {
    const row = await this.db.tenant(tenant.shopId, (tx) => shopProfile(tx, tenant.shopId));
    return Object.assign(new Shop(), {
      id: toPublicId('shop', row.id),
      name: row.name,
      handle: row.handle,
      url: this.storefronts.url(row.handle),
      currencyCode: row.currency,
      timezone: row.timezone,
    });
  }
}
