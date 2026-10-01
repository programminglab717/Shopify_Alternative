import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { TrustBadgeService } from '../trust-badge.service.js';
import type { TrustBadgeKind, TrustBadgeValue } from '../trust-badges.js';
import {
  CheckoutTrustBadge,
  CheckoutTrustBadgeInput,
  CheckoutTrustBadgeKind,
  CheckoutTrustBadgesUpdatePayload,
} from './trust-badge.types.js';

const KINDS = {
  cash_on_delivery: CheckoutTrustBadgeKind.CASH_ON_DELIVERY,
  open_parcel: CheckoutTrustBadgeKind.OPEN_PARCEL,
  exchange: CheckoutTrustBadgeKind.EXCHANGE,
  returns: CheckoutTrustBadgeKind.RETURNS,
  original: CheckoutTrustBadgeKind.ORIGINAL,
  whatsapp: CheckoutTrustBadgeKind.WHATSAPP,
} satisfies Record<TrustBadgeKind, CheckoutTrustBadgeKind>;

const KIND_VALUES = Object.fromEntries(
  Object.entries(KINDS).map(([value, kind]) => [kind, value]),
) as Record<CheckoutTrustBadgeKind, TrustBadgeKind>;

@Resolver()
export class TrustBadgeResolver {
  constructor(private readonly service: TrustBadgeService) {}

  @Query(() => [CheckoutTrustBadge], {
    description: "The badges the shop chose for its checkout's page, in their order.",
  })
  @RequireScopes('read_settings')
  async checkoutTrustBadges(@CurrentTenant() tenant: TenantContext): Promise<CheckoutTrustBadge[]> {
    return (await this.service.get(tenant)).map(toBadge);
  }

  @Mutation(() => CheckoutTrustBadgesUpdatePayload, {
    description:
      "Replaces the badges the checkout's page shows, in the order given: up to 4, each once. " +
      "WHATSAPP needs the shop's WhatsApp number, from the online store's preferences.",
  })
  @RequireScopes('write_settings')
  async checkoutTrustBadgesUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('badges', { type: () => [CheckoutTrustBadgeInput] }) badges: CheckoutTrustBadgeInput[],
  ): Promise<CheckoutTrustBadgesUpdatePayload> {
    const result = await this.service.update(
      tenant,
      badges.map((badge) => ({ kind: KIND_VALUES[badge.kind], days: badge.days })),
    );
    return Object.assign(new CheckoutTrustBadgesUpdatePayload(), {
      checkoutTrustBadges: result.ok ? result.value.map(toBadge) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function toBadge(badge: TrustBadgeValue): CheckoutTrustBadge {
  return Object.assign(new CheckoutTrustBadge(), { kind: KINDS[badge.kind], days: badge.days });
}
