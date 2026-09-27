import { CurrencyCode, CurrentTenant, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { toPublicId } from '@hatti/ids';
import { Field, ID, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { eq } from 'drizzle-orm';
import { pgSchema, text, uuid } from 'drizzle-orm/pg-core';

// The shop directory belongs to the control plane; this read-only view is all the API needs.
const shops = pgSchema('control').table('shops', {
  id: uuid('id').notNull(),
  name: text('name').notNull(),
  currency: text('currency').notNull(),
  timezone: text('timezone').notNull(),
});

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
    const [row] = await this.db.tenant(tenant.shopId, (tx) =>
      tx.select().from(shops).where(eq(shops.id, tenant.shopId)),
    );
    if (!row) throw new Error('Authenticated shop not found');
    return Object.assign(new Shop(), {
      id: toPublicId('shop', row.id),
      name: row.name,
      currencyCode: row.currency,
      timezone: row.timezone,
    });
  }
}
