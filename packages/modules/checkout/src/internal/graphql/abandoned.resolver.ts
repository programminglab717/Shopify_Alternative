import {
  CurrentTenant,
  Money,
  RequireScopes,
  UserError,
  shownPhone,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { money, type CurrencyCode } from '@hatti/money';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AbandonedCheckoutService, type AbandonedCheckoutRecord } from '../abandoned.service.js';
import {
  AbandonedCheckout,
  CheckoutRecoverySettings,
  CheckoutRecoverySettingsUpdatePayload,
} from './abandoned.types.js';

@Resolver()
export class AbandonedCheckoutResolver {
  constructor(private readonly service: AbandonedCheckoutService) {}

  @Query(() => [AbandonedCheckout], {
    description:
      'Checkouts shoppers left after typing their number, the latest first, `first` at a time ' +
      'after the one `after` names; kept 30 days (CHK-12, ADR-393).',
  })
  @RequireScopes('read_orders')
  async abandonedCheckouts(
    @CurrentTenant() tenant: TenantContext,
    @Args('first', { type: () => Int, nullable: true }) first?: number | null,
    @Args('after', { type: () => ID, nullable: true }) after?: string | null,
  ): Promise<AbandonedCheckout[]> {
    const afterId = after ? tryFromPublicId(after, 'abandonedCheckout') : null;
    if (after && !afterId) return [];
    const records = await this.service.list(tenant, { first: first ?? undefined, after: afterId });
    return records.map((record) => toAbandoned(tenant, record));
  }

  @Query(() => CheckoutRecoverySettings, {
    description: 'Whether, and how long after they leave, the shop reminds shoppers (ADR-393).',
  })
  @RequireScopes('read_settings')
  async checkoutRecoverySettings(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<CheckoutRecoverySettings> {
    return Object.assign(new CheckoutRecoverySettings(), await this.service.settings(tenant));
  }

  @Mutation(() => CheckoutRecoverySettingsUpdatePayload, {
    description:
      'Sets how long after a shopper leaves checkout, having typed their number, they are ' +
      'reminded once on WhatsApp, of 30, 60, 180 or 600 minutes; null for never. Each reminder ' +
      'is a marketing message, charged to the shop as its messages are.',
  })
  @RequireScopes('write_settings')
  async checkoutRecoverySettingsUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('reminderAfterMinutes', { type: () => Int, nullable: true })
    reminderAfterMinutes: number | null,
  ): Promise<CheckoutRecoverySettingsUpdatePayload> {
    const result = await this.service.updateSettings(tenant, {
      reminderAfterMinutes: reminderAfterMinutes ?? null,
    });
    return Object.assign(new CheckoutRecoverySettingsUpdatePayload(), {
      checkoutRecoverySettings: result.ok
        ? Object.assign(new CheckoutRecoverySettings(), result.value)
        : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function toAbandoned(tenant: TenantContext, record: AbandonedCheckoutRecord): AbandonedCheckout {
  return Object.assign(new AbandonedCheckout(), {
    id: toPublicId('abandonedCheckout', record.id),
    createdAt: record.createdAt,
    abandonedAt: record.contactAt,
    name: record.name,
    phone: shownPhone(tenant, record.phone),
    lineItems: record.lines.map((line) => ({
      ...line,
      variantId: toPublicId('variant', line.variantId),
    })),
    subtotalPrice: Money.from(money(record.subtotal, record.currency as CurrencyCode)),
    remindedAt: record.remindedAt,
    recoveredOrder: record.recoveredOrder && {
      id: toPublicId('order', record.recoveredOrder.id),
      name: `#${record.recoveredOrder.number}`,
    },
  });
}
