import { CurrencyCode, CurrentTenant, shopProfile, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { toPublicId } from '@hatti/ids';
import { Field, ID, ObjectType, Query, Resolver } from '@nestjs/graphql';

@ObjectType({ description: 'The shop that the access token belongs to.' })
export class Shop {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => CurrencyCode)
  currencyCode!: string;

  @Field({ description: 'IANA time zone, e.g. Asia/Karachi.' })
  timezone!: string;
}

@Resolver(() => Shop)
export class ShopResolver {
  constructor(private readonly db: Database) {}

  @Query(() => Shop, { description: 'The shop of the current access token.' })
  async shop(@CurrentTenant() tenant: TenantContext): Promise<Shop> {
    const row = await this.db.tenant(tenant.shopId, (tx) => shopProfile(tx, tenant.shopId));
    return Object.assign(new Shop(), {
      id: toPublicId('shop', row.id),
      name: row.name,
      currencyCode: row.currency,
      timezone: row.timezone,
    });
  }
}
