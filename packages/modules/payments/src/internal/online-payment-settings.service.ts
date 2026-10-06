import { InputChecker, actorColumnsOf, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, toDateOrNull, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import {
  auditedPrepaidDiscount,
  checkPrepaidDiscount,
  samePrepaidDiscount,
  type PrepaidDiscountInput,
  type PrepaidDiscountValue,
} from '@hatti/orders/public';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PaymentEvents, type OnlinePaymentSettingsUpdatedPayload } from './events.js';

/** How a shop's customers pay online, beside its gateway accounts (PAY-05). */
export interface OnlinePaymentSettingsRecord {
  /**
   * What checkout takes off the items of orders paid online, after any code, as the shop's
   * prepaid incentive (ADR-222); null for nothing.
   */
  discount: PrepaidDiscountValue | null;
  /** Null while the shop has never set them. */
  updatedAt: Date | null;
}

/** Fields left out stay as they are. */
export interface OnlinePaymentSettingsInput {
  /** Replaces what checkout takes off orders paid online; null takes it away. */
  discount?: PrepaidDiscountInput | null;
}

const NONE: OnlinePaymentSettingsRecord = { discount: null, updatedAt: null };

/** The shop's settings for paying online, in the caller's transaction `tx`. */
export async function onlinePaymentSettingsIn(
  tx: Tx,
  shopId: string,
  options: { lock?: boolean } = {},
): Promise<OnlinePaymentSettingsRecord> {
  const { rows } = await tx.execute<{
    discount_bps: number | null;
    discount_cap: string | null;
    discount_amount: string | null;
    updated_at: string;
  }>(sql`
    SELECT discount_bps, discount_cap, discount_amount, updated_at
      FROM payments.online_payment_settings
     WHERE shop_id = ${shopId}
     ${options.lock ? sql`FOR UPDATE` : sql``}`);
  const row = rows[0];
  if (!row) return NONE;
  return {
    discount:
      row.discount_bps !== null
        ? {
            kind: 'percentage',
            percentageBps: row.discount_bps,
            cap: row.discount_cap === null ? null : BigInt(row.discount_cap),
          }
        : row.discount_amount !== null
          ? { kind: 'fixed_amount', amount: BigInt(row.discount_amount) }
          : null,
    updatedAt: toDateOrNull(row.updated_at),
  };
}

/**
 * Something off for paying online (PAY-05, ADR-222): a percentage of the items, up to a cap, or an
 * amount, which checkout takes off orders paid online after any code, as it takes the shop's own
 * off orders paid by transfer (ADR-077). A change is audited with the discount before and after.
 */
@Injectable()
export class OnlinePaymentSettingsService {
  constructor(private readonly db: Database) {}

  get(tenant: TenantContext): Promise<OnlinePaymentSettingsRecord> {
    return this.db.tenant(tenant.shopId, (tx) => onlinePaymentSettingsIn(tx, tenant.shopId));
  }

  /** Changes the settings, for orders placed from now on. */
  async update(
    tenant: TenantContext,
    input: OnlinePaymentSettingsInput,
  ): Promise<MutationResult<OnlinePaymentSettingsRecord>> {
    const check = new InputChecker();
    const discount =
      input.discount === undefined || input.discount === null
        ? input.discount
        : checkPrepaidDiscount(
            check,
            ['input', 'discount'],
            input.discount,
            tenant.currency,
            'online',
          );
    if (!check.ok) return { ok: false, errors: check.errors };

    return this.db.tenant(tenant.shopId, async (tx) => {
      const current = await onlinePaymentSettingsIn(tx, tenant.shopId, { lock: true });
      const next = discount === undefined ? current.discount : discount;
      if (samePrepaidDiscount(current.discount, next)) return { ok: true, value: current };
      const percentage = next?.kind === 'percentage' ? next : null;
      await tx.execute(sql`
        INSERT INTO payments.online_payment_settings
               (shop_id, discount_bps, discount_cap, discount_amount)
        VALUES (${tenant.shopId}, ${percentage?.percentageBps ?? null},
                ${percentage?.cap ?? null},
                ${next?.kind === 'fixed_amount' ? next.amount : null})
            ON CONFLICT (shop_id) DO UPDATE
                   SET discount_bps = excluded.discount_bps,
                       discount_cap = excluded.discount_cap,
                       discount_amount = excluded.discount_amount,
                       version = payments.online_payment_settings.version + 1,
                       updated_at = now()`);
      const actor = actorColumnsOf(tenant.actor);
      await appendEvent<OnlinePaymentSettingsUpdatedPayload>(tx, tenant.shopId, {
        type: PaymentEvents.OnlinePaymentSettingsUpdated,
        aggregateType: 'online_payment_settings',
        aggregateId: tenant.shopId,
        payload: { changed: ['discount'], actorKind: actor.actorKind, actorId: actor.actorId },
      });
      await recordAudit(tx, tenant.shopId, {
        action: PaymentEvents.OnlinePaymentSettingsUpdated,
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actor,
        details: {
          discount: auditedPrepaidDiscount(next, tenant.currency),
          before: { discount: auditedPrepaidDiscount(current.discount, tenant.currency) },
        },
      });
      return { ok: true, value: await onlinePaymentSettingsIn(tx, tenant.shopId) };
    });
  }
}
