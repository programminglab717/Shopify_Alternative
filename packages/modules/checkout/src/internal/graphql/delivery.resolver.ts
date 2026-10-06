import { CurrentTenant, Money, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { money, type CurrencyCode } from '@hatti/money';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import type { DeliveryDays as Days, DeliverySettingsRecord } from '../delivery.js';
import { DeliveryService } from '../delivery.service.js';
import {
  DeliveryDays,
  DeliverySettings,
  DeliverySettingsUpdateInput,
  DeliverySettingsUpdatePayload,
  DeliveryZone,
} from './delivery.types.js';

@Resolver(() => DeliverySettings)
export class DeliveryResolver {
  constructor(private readonly service: DeliveryService) {}

  @Query(() => DeliverySettings, {
    description: 'What the shop charges to deliver an order, which checkout adds for its city.',
  })
  @RequireScopes('read_settings')
  async deliverySettings(@CurrentTenant() tenant: TenantContext): Promise<DeliverySettings> {
    return toDeliverySettings(await this.service.get(tenant), tenant.currency);
  }

  @Mutation(() => DeliverySettingsUpdatePayload, {
    description:
      'Changes what the shop charges to deliver an order, for checkouts from now on; the ' +
      'storefront shows it a moment later. Those not given stay as they are.',
  })
  @RequireScopes('write_settings')
  async deliverySettingsUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: DeliverySettingsUpdateInput,
  ): Promise<DeliverySettingsUpdatePayload> {
    const result = await this.service.update(tenant, input);
    return Object.assign(new DeliverySettingsUpdatePayload(), {
      deliverySettings: result.ok ? toDeliverySettings(result.value, tenant.currency) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function toDeliverySettings(
  record: DeliverySettingsRecord,
  currency: CurrencyCode,
): DeliverySettings {
  const amount = (value: bigint) => Money.from(money(value, currency));
  return Object.assign(new DeliverySettings(), {
    charge: amount(record.charge),
    freeAbove: record.freeAbove === null ? null : amount(record.freeAbove),
    days: toDays(record.days),
    zones: record.zones.map((zone) =>
      Object.assign(new DeliveryZone(), {
        name: zone.name,
        cities: zone.cities,
        charge: amount(zone.charge),
        days: toDays(zone.days),
      }),
    ),
    updatedAt: record.updatedAt,
  });
}

function toDays(days: Days | null): DeliveryDays | null {
  return days && Object.assign(new DeliveryDays(), { min: days.min, max: days.max });
}
