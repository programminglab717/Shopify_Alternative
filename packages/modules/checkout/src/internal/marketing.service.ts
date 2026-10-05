import { InputChecker, type MutationResult, type TenantContext } from '@hatti/api';
import type { MarketingChannelValue } from '@hatti/customers/public';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { CheckoutEvents, type MarketingOptionsUpdatedPayload } from './events.js';
import { DEFAULT_MARKETING_CHANNELS, checkMarketingChannels } from './marketing.js';
import { marketingOptions } from './schema.js';

/**
 * The channels the shop's checkout offers boxes for its news and offers on, in the caller's
 * transaction `tx` (ADR-187): WhatsApp alone until the shop chooses.
 */
export async function checkoutMarketingIn(
  tx: Tx,
  shopId: string,
): Promise<MarketingChannelValue[]> {
  const [row] = await tx
    .select({ channels: marketingOptions.channels })
    .from(marketingOptions)
    .where(eq(marketingOptions.shopId, shopId));
  return row ? row.channels : [...DEFAULT_MARKETING_CHANNELS];
}

/**
 * The boxes a shop's checkout offers for its news and offers (CUS-04, ADR-187): one for each
 * channel it chooses, each unticked until the shopper ticks it.
 */
@Injectable()
export class CheckoutMarketingService {
  constructor(private readonly db: Database) {}

  get(tenant: TenantContext): Promise<MarketingChannelValue[]> {
    return this.db.tenant(tenant.shopId, (tx) => checkoutMarketingIn(tx, tenant.shopId));
  }

  /**
   * Sets the channels checkouts' pages offer from now on, none for no boxes; records
   * `marketing_options.updated` if they changed. The shop's choice is kept as its own, even where
   * it is what a shop that chose nothing is offered.
   */
  async update(
    tenant: TenantContext,
    channels: readonly MarketingChannelValue[],
  ): Promise<MutationResult<MarketingChannelValue[]>> {
    const check = new InputChecker();
    const chosen = checkMarketingChannels(check, ['channels'], channels);
    if (!chosen) return { ok: false, errors: check.errors };
    return this.db.tenant(tenant.shopId, async (tx) => {
      const before = await checkoutMarketingIn(tx, tenant.shopId);
      await tx
        .insert(marketingOptions)
        .values({ shopId: tenant.shopId, channels: chosen })
        .onConflictDoUpdate({
          target: marketingOptions.shopId,
          set: { channels: chosen, updatedAt: sql`now()` },
        });
      if (before.join() !== chosen.join()) {
        await appendEvent<MarketingOptionsUpdatedPayload>(tx, tenant.shopId, {
          type: CheckoutEvents.MarketingOptionsUpdated,
          aggregateType: 'marketing_options',
          aggregateId: tenant.shopId,
          payload: { channels: chosen },
        });
      }
      return { ok: true, value: chosen };
    });
  }
}
