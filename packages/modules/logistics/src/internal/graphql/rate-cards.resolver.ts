import { CurrentTenant, Money, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { money, type CurrencyCode } from '@hatti/money';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { RateCardService, type RateCardRecord } from '../rate-cards.service.js';
import { uuidOf } from './couriers.resolver.js';
import {
  CourierRateCard,
  CourierRateCardInput,
  CourierRateCardPayload,
  CourierRateCardRemovePayload,
} from './couriers.types.js';

/**
 * Courier accounts' rate cards (SHP-07, ADR-383): read by those who book orders, as accounts are;
 * set by those who change the shop's settings, as accounts are.
 */
@Resolver(() => CourierRateCard)
export class RateCardResolver {
  constructor(private readonly cards: RateCardService) {}

  @Query(() => [CourierRateCard], { description: "The shop's courier accounts' rate cards." })
  @RequireScopes('read_orders')
  async courierRateCards(@CurrentTenant() tenant: TenantContext): Promise<CourierRateCard[]> {
    const records = await this.cards.list(tenant);
    return records.map((record) => toCard(record, tenant.currency));
  }

  @Mutation(() => CourierRateCardPayload, {
    description:
      "Sets a courier account's rate card whole. Parcels booked with the account from then on " +
      'are estimated by it; those booked before keep their estimates.',
  })
  @RequireScopes('write_settings')
  async courierRateCardSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('accountId', { type: () => ID }) accountId: string,
    @Args('input') input: CourierRateCardInput,
  ): Promise<CourierRateCardPayload> {
    const result = await this.cards.set(tenant, uuidOf('courierAccount', accountId), input);
    return Object.assign(new CourierRateCardPayload(), {
      courierRateCard: result.ok ? toCard(result.value, tenant.currency) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => CourierRateCardRemovePayload, {
    description:
      "Takes a courier account's rate card away: its parcels are no longer estimated, those " +
      'estimated keeping their estimates.',
  })
  @RequireScopes('write_settings')
  async courierRateCardRemove(
    @CurrentTenant() tenant: TenantContext,
    @Args('accountId', { type: () => ID }) accountId: string,
  ): Promise<CourierRateCardRemovePayload> {
    const result = await this.cards.remove(tenant, uuidOf('courierAccount', accountId));
    return Object.assign(new CourierRateCardRemovePayload(), {
      removed: result.ok,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function toCard(record: RateCardRecord, currency: CurrencyCode): CourierRateCard {
  const amount = (value: bigint) => Money.from(money(value, currency));
  return Object.assign(new CourierRateCard(), {
    accountId: toPublicId('courierAccount', record.accountId),
    originCity: record.originCity,
    localFirst: amount(record.localFirst),
    localEach: amount(record.localEach),
    otherFirst: amount(record.otherFirst),
    otherEach: amount(record.otherEach),
    codFeePercent: record.codFeeBp / 100,
    returnPercent: record.returnBp / 100,
    updatedAt: record.updatedAt,
  });
}
