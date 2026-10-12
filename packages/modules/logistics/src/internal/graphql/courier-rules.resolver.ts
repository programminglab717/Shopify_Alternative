import { CurrentTenant, Money, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { money, type CurrencyCode } from '@hatti/money';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { CourierBookingService } from '../bookings.service.js';
import { CourierRuleService, type CourierRuleRecord } from '../courier-rules.service.js';
import { uuidOf } from './couriers.resolver.js';
import {
  CourierAccountChoice,
  CourierRule,
  CourierRuleInput,
  CourierRulesUpdatePayload,
} from './couriers.types.js';

/**
 * The shop's courier rules (SHP-06, ADR-382): read by those who book orders, as accounts are;
 * changed by those who change the shop's settings, as accounts are.
 */
@Resolver(() => CourierRule)
export class CourierRuleResolver {
  constructor(
    private readonly rules: CourierRuleService,
    private readonly bookings: CourierBookingService,
  ) {}

  @Query(() => [CourierRule], {
    description:
      "The shop's courier rules, in their order: an order booked without an account named goes " +
      "with the first it matches, else with the shop's default account.",
  })
  @RequireScopes('read_orders')
  async courierRules(@CurrentTenant() tenant: TenantContext): Promise<CourierRule[]> {
    const records = await this.rules.list(tenant);
    return records.map((record) => toRule(record, tenant.currency));
  }

  @Query(() => [CourierAccountChoice], {
    description:
      'The account each of up to 250 orders would be booked with now without one named: the ' +
      "first courier rule it matches, else the shop's default.",
  })
  @RequireScopes('read_orders')
  async courierAccountsFor(
    @CurrentTenant() tenant: TenantContext,
    @Args('orderIds', { type: () => [ID] }) orderIds: string[],
  ): Promise<CourierAccountChoice[]> {
    const choices = await this.bookings.accountsFor(
      tenant,
      orderIds.map((id) => uuidOf('order', id)),
    );
    return choices.map((choice) =>
      Object.assign(new CourierAccountChoice(), {
        orderId: toPublicId('order', choice.orderId),
        accountId: choice.accountId && toPublicId('courierAccount', choice.accountId),
        ruleId: choice.ruleId && toPublicId('courierRule', choice.ruleId),
        chargeEstimate:
          choice.estimate === null ? null : Money.from(money(choice.estimate, tenant.currency)),
      }),
    );
  }

  @Mutation(() => CourierRulesUpdatePayload, {
    description:
      "Replaces the shop's courier rules with these, in this order; none for none. Each names " +
      'one of its live accounts, and cities, a range of cash to collect, or both: up to 50.',
  })
  @RequireScopes('write_settings')
  async courierRulesUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('rules', { type: () => [CourierRuleInput] }) rules: CourierRuleInput[],
  ): Promise<CourierRulesUpdatePayload> {
    const result = await this.rules.replace(
      tenant,
      rules.map((rule) => ({ ...rule, accountId: uuidOf('courierAccount', rule.accountId) })),
    );
    return Object.assign(new CourierRulesUpdatePayload(), {
      courierRules: result.ok
        ? result.value.map((record) => toRule(record, tenant.currency))
        : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function toRule(record: CourierRuleRecord, currency: CurrencyCode): CourierRule {
  const amount = (value: bigint | null) =>
    value === null ? null : Money.from(money(value, currency));
  return Object.assign(new CourierRule(), {
    id: toPublicId('courierRule', record.id),
    accountId: toPublicId('courierAccount', record.accountId),
    accountArchived: record.accountArchived,
    cities: record.cities,
    codAtLeast: amount(record.codAtLeast),
    codBelow: amount(record.codBelow),
  });
}
