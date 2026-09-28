import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { RiskSettingsService } from '../risk-settings.service.js';
import { toRiskSettings } from './mappers.js';
import {
  OrderRiskSettings,
  OrderRiskSettingsInput,
  OrderRiskSettingsUpdatePayload,
} from './order.types.js';

@Resolver()
export class RiskResolver {
  constructor(private readonly settings: RiskSettingsService) {}

  @Query(() => OrderRiskSettings, {
    description: "When risky cash-on-delivery orders wait for review: the shop's policy.",
  })
  @RequireScopes('read_settings')
  async orderRiskSettings(@CurrentTenant() tenant: TenantContext): Promise<OrderRiskSettings> {
    return toRiskSettings(await this.settings.get(tenant), tenant.currency);
  }

  @Mutation(() => OrderRiskSettingsUpdatePayload, {
    description:
      'Changes when risky cash-on-delivery orders wait for review, for orders placed or ' +
      're-addressed from now on.',
  })
  @RequireScopes('write_settings')
  async orderRiskSettingsUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: OrderRiskSettingsInput,
  ): Promise<OrderRiskSettingsUpdatePayload> {
    const result = await this.settings.update(tenant, input);
    return Object.assign(new OrderRiskSettingsUpdatePayload(), {
      riskSettings: result.ok ? toRiskSettings(result.value, tenant.currency) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
