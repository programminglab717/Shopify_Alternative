import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import {
  Args,
  Field,
  GraphQLISODateTime,
  ID,
  Int,
  Mutation,
  ObjectType,
  Query,
  Resolver,
} from '@nestjs/graphql';
import { DarazService, type DarazAccountRecord } from '../daraz.service.js';

@ObjectType({ description: 'A Daraz order left out, and why.' })
export class DarazLeftOut {
  @Field()
  darazOrderId!: string;

  @Field()
  error!: string;

  @Field(() => GraphQLISODateTime)
  at!: Date;
}

@ObjectType({
  description:
    "The shop's Daraz Seller Center account (CH-06, ADR-875): its SKUs' stock, and prices where " +
    'asked, kept in step with a location here, and its orders brought in as the shop’s own.',
})
export class DarazAccount {
  @Field({ description: 'The seller as Daraz names them.' })
  account!: string;

  @Field(() => String, { nullable: true })
  sellerId!: string | null;

  @Field(() => ID, { description: 'Where its stock comes from and its orders ship from.' })
  locationId!: string;

  @Field({ description: "Whether Daraz's prices follow the shop's; its stock always does." })
  syncPrices!: boolean;

  @Field(() => GraphQLISODateTime, { nullable: true })
  syncedAt!: Date | null;

  @Field(() => String, { nullable: true, description: 'Why the last sync failed, if it did.' })
  lastError!: string | null;

  @Field(() => GraphQLISODateTime)
  connectedAt!: Date;

  @Field(() => [DarazLeftOut], { description: 'Daraz orders left out, the latest first.' })
  leftOut!: DarazLeftOut[];
}

@ObjectType()
export class DarazConnection {
  @Field({ description: 'Whether shops may connect Daraz here.' })
  available!: boolean;

  @Field(() => DarazAccount, { nullable: true })
  account!: DarazAccount | null;
}

@ObjectType()
export class DarazAccountPayload {
  @Field(() => DarazAccount, { nullable: true })
  account!: DarazAccount | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class DarazSyncResult {
  @Field(() => Int)
  imported!: number;

  @Field(() => Int)
  cancelled!: number;

  @Field(() => Int)
  leftOut!: number;

  @Field(() => Int, { description: 'SKUs whose stock or price Daraz was given.' })
  pushed!: number;
}

function toAccount(record: DarazAccountRecord): DarazAccount {
  return Object.assign(new DarazAccount(), {
    ...record,
    locationId: toPublicId('location', record.locationId),
    leftOut: record.leftOut.map((each) => Object.assign(new DarazLeftOut(), each)),
  });
}

/** The shop's Daraz account (CH-06, ADR-875), kept by those who change its settings. */
@Resolver()
export class DarazResolver {
  constructor(private readonly service: DarazService) {}

  @Query(() => DarazConnection, { description: "Whether the shop's Daraz account is connected." })
  @RequireScopes('read_settings')
  async daraz(@CurrentTenant() tenant: TenantContext): Promise<DarazConnection> {
    const account = await this.service.account(tenant);
    return Object.assign(new DarazConnection(), {
      available: this.service.available,
      account: account && toAccount(account),
    });
  }

  @Query(() => String, {
    nullable: true,
    description:
      'Where to send the shop to authorise Hatti on Daraz, coming back to `redirectUri` with a ' +
      'code and the state to give darazConnect; null where Daraz isn’t set up here.',
  })
  @RequireScopes('write_settings')
  darazConnectUrl(
    @CurrentTenant() tenant: TenantContext,
    @Args('redirectUri') redirectUri: string,
  ): string | null {
    return this.service.connectUrl(tenant, redirectUri);
  }

  @Mutation(() => DarazAccountPayload, {
    description:
      "Connects the shop's Daraz account with the code Daraz gave on its way back, selling from " +
      'the primary location unless told. Orders placed on Daraz from now on come in.',
  })
  @RequireScopes('write_settings')
  async darazConnect(
    @CurrentTenant() tenant: TenantContext,
    @Args('code') code: string,
    @Args('state') state: string,
    @Args('locationId', { type: () => ID, nullable: true }) locationId?: string | null,
  ): Promise<DarazAccountPayload> {
    const result = await this.service.connect(tenant, {
      code,
      state,
      locationId: locationId
        ? (tryFromPublicId(locationId, 'location') ?? '00000000-0000-0000-0000-000000000000')
        : null,
    });
    return Object.assign(new DarazAccountPayload(), {
      account: result.ok ? toAccount(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => DarazAccountPayload, {
    description:
      "The location the Daraz account sells from, and whether its prices follow the shop's.",
  })
  @RequireScopes('write_settings')
  async darazAccountUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('locationId', { type: () => ID, nullable: true }) locationId?: string | null,
    @Args('syncPrices', { type: () => Boolean, nullable: true }) syncPrices?: boolean | null,
  ): Promise<DarazAccountPayload> {
    const result = await this.service.update(tenant, {
      locationId: locationId
        ? (tryFromPublicId(locationId, 'location') ?? '00000000-0000-0000-0000-000000000000')
        : null,
      syncPrices: syncPrices ?? null,
    });
    return Object.assign(new DarazAccountPayload(), {
      account: result.ok ? toAccount(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => Boolean, {
    description: "Forgets the shop's Daraz account; the orders it brought in stay the shop's.",
  })
  @RequireScopes('write_settings')
  async darazDisconnect(@CurrentTenant() tenant: TenantContext): Promise<boolean> {
    return this.service.disconnect(tenant);
  }

  @Mutation(() => DarazSyncResult, {
    nullable: true,
    description: 'Syncs the Daraz account now, as the worker does every few minutes.',
  })
  @RequireScopes('write_settings')
  async darazSync(@CurrentTenant() tenant: TenantContext): Promise<DarazSyncResult | null> {
    const result = await this.service.sync(tenant.shopId);
    return result && Object.assign(new DarazSyncResult(), result);
  }
}
