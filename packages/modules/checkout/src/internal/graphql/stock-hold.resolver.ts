import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { StockHoldService } from '../stock-holds.js';
import { CheckoutStockHold, CheckoutStockHoldUpdatePayload } from './stock-hold.types.js';

@Resolver()
export class StockHoldResolver {
  constructor(private readonly service: StockHoldService) {}

  @Query(() => CheckoutStockHold, {
    description:
      "How long the shop's checkouts hold their carts' stock (ADR-715): none until it chooses.",
  })
  @RequireScopes('read_settings')
  async checkoutStockHold(@CurrentTenant() tenant: TenantContext): Promise<CheckoutStockHold> {
    return Object.assign(new CheckoutStockHold(), { minutes: await this.service.get(tenant) });
  }

  @Mutation(() => CheckoutStockHoldUpdatePayload, {
    description:
      "Sets how many minutes a checkout holds its cart's stock, from 5 to 60, or null for none. " +
      'Holds already taken keep theirs.',
  })
  @RequireScopes('write_settings')
  async checkoutStockHoldUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('minutes', { type: () => Int, nullable: true }) minutes: number | null,
  ): Promise<CheckoutStockHoldUpdatePayload> {
    const result = await this.service.update(tenant, minutes ?? null);
    return Object.assign(new CheckoutStockHoldUpdatePayload(), {
      checkoutStockHold: result.ok
        ? Object.assign(new CheckoutStockHold(), { minutes: result.value })
        : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
