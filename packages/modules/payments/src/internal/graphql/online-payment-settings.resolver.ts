import { CurrentTenant, Money, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { money, type CurrencyCode } from '@hatti/money';
import type { PrepaidDiscountValue } from '@hatti/orders/public';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  OnlinePaymentSettingsService,
  type OnlinePaymentSettingsRecord,
} from '../online-payment-settings.service.js';
import {
  OnlinePaymentDiscount,
  OnlinePaymentDiscountKind,
  OnlinePaymentSettings,
  OnlinePaymentSettingsInput,
  OnlinePaymentSettingsUpdatePayload,
} from './online-payment-settings.types.js';

/** What paying online takes off (PAY-05, ADR-222): shop settings, as its gateway accounts are. */
@Resolver()
export class OnlinePaymentSettingsResolver {
  constructor(private readonly settings: OnlinePaymentSettingsService) {}

  @Query(() => OnlinePaymentSettings, {
    description: "The shop's settings for paying online, beside its gateway accounts.",
  })
  @RequireScopes('read_settings')
  async onlinePaymentSettings(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<OnlinePaymentSettings> {
    return toSettings(await this.settings.get(tenant), tenant.currency);
  }

  @Mutation(() => OnlinePaymentSettingsUpdatePayload, {
    description:
      'Changes what checkout takes off orders paid online, for orders placed from now on: ' +
      'orders placed before keep what was taken off them. Audited with the discount before ' +
      'and after.',
  })
  @RequireScopes('write_settings')
  async onlinePaymentSettingsUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: OnlinePaymentSettingsInput,
  ): Promise<OnlinePaymentSettingsUpdatePayload> {
    const result = await this.settings.update(tenant, {
      ...(input.discount !== undefined && { discount: input.discount }),
    });
    return Object.assign(new OnlinePaymentSettingsUpdatePayload(), {
      onlinePaymentSettings: result.ok ? toSettings(result.value, tenant.currency) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function toSettings(
  record: OnlinePaymentSettingsRecord,
  currency: CurrencyCode,
): OnlinePaymentSettings {
  return Object.assign(new OnlinePaymentSettings(), {
    discount: record.discount && toDiscount(record.discount, currency),
    updatedAt: record.updatedAt,
  });
}

function toDiscount(discount: PrepaidDiscountValue, currency: CurrencyCode): OnlinePaymentDiscount {
  const amount = (value: bigint) => Money.from(money(value, currency));
  return Object.assign(
    new OnlinePaymentDiscount(),
    discount.kind === 'percentage'
      ? {
          kind: OnlinePaymentDiscountKind.PERCENTAGE,
          percentage: discount.percentageBps / 100,
          cap: discount.cap === null ? null : amount(discount.cap),
          amount: null,
        }
      : {
          kind: OnlinePaymentDiscountKind.FIXED_AMOUNT,
          percentage: null,
          cap: null,
          amount: amount(discount.amount),
        },
  );
}
