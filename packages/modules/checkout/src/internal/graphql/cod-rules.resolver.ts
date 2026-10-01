import { CurrentTenant, Money, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { money, type CurrencyCode } from '@hatti/money';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import type { CodRulesRecord } from '../cod-rules.js';
import { CodRulesService } from '../cod-rules.service.js';
import {
  CashOnDeliverySettings,
  CashOnDeliverySettingsInput,
  CashOnDeliverySettingsUpdatePayload,
} from './cod-rules.types.js';

@Resolver()
export class CodRulesResolver {
  constructor(private readonly service: CodRulesService) {}

  @Query(() => CashOnDeliverySettings, {
    description: "The shop's rules for cash on delivery at checkout.",
  })
  @RequireScopes('read_settings')
  async cashOnDeliverySettings(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<CashOnDeliverySettings> {
    return toSettings(await this.service.get(tenant), tenant.currency);
  }

  @Mutation(() => CashOnDeliverySettingsUpdatePayload, {
    description:
      "Changes the shop's rules for cash on delivery, for checkouts from now on. Those not " +
      'given stay as they are.',
  })
  @RequireScopes('write_settings')
  async cashOnDeliverySettingsUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: CashOnDeliverySettingsInput,
  ): Promise<CashOnDeliverySettingsUpdatePayload> {
    const result = await this.service.update(tenant, input);
    return Object.assign(new CashOnDeliverySettingsUpdatePayload(), {
      cashOnDeliverySettings: result.ok ? toSettings(result.value, tenant.currency) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function toSettings(record: CodRulesRecord, currency: CurrencyCode): CashOnDeliverySettings {
  return Object.assign(new CashOnDeliverySettings(), {
    maxOrderTotal:
      record.maxOrderTotal === null ? null : Money.from(money(record.maxOrderTotal, currency)),
    unavailableCities: record.unavailableCities,
    refusedDeliveriesLimit: record.refusedDeliveriesLimit,
    fee: Money.from(money(record.fee, currency)),
    updatedAt: record.updatedAt,
  });
}
