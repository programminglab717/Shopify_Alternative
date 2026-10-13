import { InputChecker, type MutationResult, type TenantContext } from '@hatti/api';
import { VariantService } from '@hatti/catalog/public';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { CheckoutEvents, type GiftOptionsUpdatedPayload } from './events.js';
import { giftOptions } from './schema.js';

/** What the shop offers to send a gift with, as kept (CHK-16, ADR-413). */
export interface GiftOptions {
  /** The variant sold as gift wrap; null for none. */
  wrapVariantId: string | null;
  /** Whether checkout asks for a gift message. */
  messages: boolean;
}

/** The gift wrap as the shop's settings show it: its variant as the catalog has it now. */
export interface GiftWrap {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  /** Minor units. */
  price: bigint;
  /** Its product is active: checkout offers it. */
  forSale: boolean;
}

export interface GiftOptionsInput {
  /** Null for no gift wrap. */
  wrapVariantId: string | null;
  messages: boolean;
}

const NONE: GiftOptions = { wrapVariantId: null, messages: false };

/** The shop's gift options, in the caller's transaction `tx`: neither until it chooses. */
export async function giftOptionsIn(tx: Tx, shopId: string): Promise<GiftOptions> {
  const [row] = await tx
    .select({ wrapVariantId: giftOptions.wrapVariantId, messages: giftOptions.messages })
    .from(giftOptions)
    .where(eq(giftOptions.shopId, shopId));
  return row ?? NONE;
}

/**
 * Gift wrap and gift messages at checkout (CHK-16, ADR-413): one of the shop's variants, which
 * the checkout's page adds to the cart when the shopper asks, at its own price; and a message the
 * order keeps for its packing slip.
 */
@Injectable()
export class GiftOptionsService {
  constructor(
    private readonly db: Database,
    private readonly variants: VariantService,
  ) {}

  /** The shop's gift options, with its gift wrap as the catalog has it now; none once deleted. */
  get(tenant: TenantContext): Promise<{ wrap: GiftWrap | null; messages: boolean }> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const options = await giftOptionsIn(tx, tenant.shopId);
      return { wrap: await this.#wrapIn(tx, tenant.shopId, options), messages: options.messages };
    });
  }

  /**
   * Sets the variant sold as gift wrap, null for none, and whether checkout asks for a gift
   * message; records `gift_options.updated` if they changed. The variant must be the shop's.
   */
  async update(
    tenant: TenantContext,
    input: GiftOptionsInput,
  ): Promise<MutationResult<{ wrap: GiftWrap | null; messages: boolean }>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const check = new InputChecker();
      const wrap =
        input.wrapVariantId === null ? null : await this.#wrapIn(tx, tenant.shopId, input);
      if (input.wrapVariantId !== null && !wrap) {
        check.addMessage(
          ['input', 'wrapVariantId'],
          'NOT_FOUND',
          'No variant of the shop has this ID',
        );
      }
      if (!check.ok) return { ok: false, errors: check.errors };
      const before = await giftOptionsIn(tx, tenant.shopId);
      const now: GiftOptions = { wrapVariantId: input.wrapVariantId, messages: input.messages };
      await tx
        .insert(giftOptions)
        .values({ shopId: tenant.shopId, ...now })
        .onConflictDoUpdate({
          target: giftOptions.shopId,
          set: { ...now, updatedAt: sql`now()` },
        });
      if (before.wrapVariantId !== now.wrapVariantId || before.messages !== now.messages) {
        await appendEvent<GiftOptionsUpdatedPayload>(tx, tenant.shopId, {
          type: CheckoutEvents.GiftOptionsUpdated,
          aggregateType: 'gift_options',
          aggregateId: tenant.shopId,
          payload: now,
        });
      }
      return { ok: true, value: { wrap, messages: now.messages } };
    });
  }

  async #wrapIn(
    tx: Tx,
    shopId: string,
    options: Pick<GiftOptions, 'wrapVariantId'>,
  ): Promise<GiftWrap | null> {
    if (!options.wrapVariantId) return null;
    const snapshot = (await this.variants.snapshotsOf(tx, shopId, [options.wrapVariantId])).get(
      options.wrapVariantId,
    );
    return snapshot
      ? {
          variantId: options.wrapVariantId,
          productTitle: snapshot.productTitle,
          variantTitle: snapshot.variantTitle,
          price: snapshot.price,
          forSale: snapshot.productStatus === 'active',
        }
      : null;
  }
}
