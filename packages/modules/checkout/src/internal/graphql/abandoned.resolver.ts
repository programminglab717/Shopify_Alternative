import {
  CurrentTenant,
  Money,
  RequireScopes,
  UserError,
  badUserInput,
  shownPhone,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { money, type CurrencyCode } from '@hatti/money';
import { toDiscountCode } from '@hatti/pricing/public';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  AbandonedCheckoutService,
  type AbandonedCheckoutRecord,
  type RecoverySettingsRecord,
} from '../abandoned.service.js';
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
    description:
      'Whether, and how long after they leave, the shop reminds shoppers (ADR-393), and the code ' +
      'it offers them after (ADR-426).',
  })
  @RequireScopes('read_settings')
  async checkoutRecoverySettings(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<CheckoutRecoverySettings> {
    return toSettings(tenant, await this.service.settings(tenant));
  }

  @Mutation(() => CheckoutRecoverySettingsUpdatePayload, {
    description:
      'Sets how long after a shopper leaves checkout, having typed their number, they are ' +
      'reminded once on WhatsApp, of 30, 60, 180 or 600 minutes; null for never. And which of ' +
      "the shop's discount codes, a percentage or an amount off, those still not ordering are " +
      'offered 12, 24 or 48 hours after the reminder (ADR-426): left out, the offer stays as it ' +
      'is; null for none. No offer goes without the reminder. Each reminder and offer is a ' +
      'marketing message, charged to the shop as its messages are.',
  })
  @RequireScopes('write_settings')
  async checkoutRecoverySettingsUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('reminderAfterMinutes', { type: () => Int, nullable: true })
    reminderAfterMinutes: number | null,
    @Args('offerDiscountCodeId', { type: () => ID, nullable: true })
    offerDiscountCodeId?: string | null,
    @Args('offerAfterHours', { type: () => Int, nullable: true })
    offerAfterHours?: number | null,
  ): Promise<CheckoutRecoverySettingsUpdatePayload> {
    let codeId = offerDiscountCodeId;
    if (offerDiscountCodeId) {
      codeId = tryFromPublicId(offerDiscountCodeId, 'discountCode');
      if (!codeId) {
        throw badUserInput(`Invalid discountCode id: ${offerDiscountCodeId.slice(0, 64)}`);
      }
    }
    const result = await this.service.updateSettings(tenant, {
      reminderAfterMinutes: reminderAfterMinutes ?? null,
      offerCodeId: codeId,
      offerAfterHours,
    });
    return Object.assign(new CheckoutRecoverySettingsUpdatePayload(), {
      checkoutRecoverySettings: result.ok ? toSettings(tenant, result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function toSettings(
  tenant: TenantContext,
  record: RecoverySettingsRecord,
): CheckoutRecoverySettings {
  return Object.assign(new CheckoutRecoverySettings(), {
    reminderAfterMinutes: record.reminderAfterMinutes,
    offerDiscountCode: record.offer
      ? toDiscountCode(record.offer.code, tenant.currency as CurrencyCode)
      : null,
    offerAfterHours: record.offer?.afterHours ?? null,
  });
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
    offeredAt: record.offeredAt,
    offerCode: record.offerCode,
    recoveredOrder: record.recoveredOrder && {
      id: toPublicId('order', record.recoveredOrder.id),
      name: `#${record.recoveredOrder.number}`,
    },
  });
}
