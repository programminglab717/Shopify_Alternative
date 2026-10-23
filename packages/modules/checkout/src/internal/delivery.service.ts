import { InputChecker, fail, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import {
  NO_DELIVERY_SETTINGS,
  checkDeliverySettings,
  type DeliverySettingsInput,
  type DeliverySettingsRecord,
} from './delivery.js';
import { CheckoutEvents, type DeliverySettingsUpdatedPayload } from './events.js';
import { deliverySettings } from './schema.js';

/**
 * What a shop charges to deliver an order (ADR-043): one charge for everywhere, zones of cities
 * with charges of their own, and a subtotal from which delivery is free; and how many working
 * days delivery takes, everywhere and in each zone (ADR-235); and what heavier orders cost more
 * (ADR-702), and what larger orders pay at most (ADR-721); and the times of the day it delivers in
 * (ADR-768). Checkout adds the charge for the shopper's city and the cart's weight, and says how long delivery takes there; the storefront shows the charges and
 * the days. A shop that set nothing charges nothing, and says nothing of the days.
 */
@Injectable()
export class DeliveryService {
  constructor(private readonly db: Database) {}

  get(tenant: TenantContext): Promise<DeliverySettingsRecord> {
    return this.db.tenant(tenant.shopId, (tx) => this.settingsOf(tx, tenant.shopId));
  }

  /**
   * Changes those given, `zones` replacing them all; records `delivery_settings.updated` if
   * anything changed.
   */
  async update(
    tenant: TenantContext,
    input: DeliverySettingsInput,
  ): Promise<MutationResult<DeliverySettingsRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const before = await this.settingsOf(tx, tenant.shopId, { lock: true });
      const check = new InputChecker();
      const next = checkDeliverySettings(check, before, input, tenant.currency);
      if (!next) return fail(check.errors);
      const changed = [
        ...(next.charge !== before.charge ? ['charge'] : []),
        ...(next.freeAbove !== before.freeAbove ? ['freeAbove'] : []),
        ...(JSON.stringify(next.days) !== JSON.stringify(before.days) ? ['days'] : []),
        ...(JSON.stringify(stored(next.zones)) !== JSON.stringify(stored(before.zones))
          ? ['zones']
          : []),
        ...(next.cutoffHour !== (before.cutoffHour ?? null) ? ['cutoffHour'] : []),
        ...(JSON.stringify(storedWeights(next.weights)) !==
        JSON.stringify(storedWeights(before.weights))
          ? ['weights']
          : []),
        ...(JSON.stringify(storedValueRates(next.valueRates)) !==
        JSON.stringify(storedValueRates(before.valueRates))
          ? ['valueRates']
          : []),
        ...(JSON.stringify(next.slots ?? []) !== JSON.stringify(before.slots ?? [])
          ? ['slots']
          : []),
        ...(next.slotDays !== (before.slotDays ?? 7) ? ['slotDays'] : []),
        ...(next.slotLeadHours !== (before.slotLeadHours ?? 2) ? ['slotLeadHours'] : []),
        ...(next.slotCapacity !== (before.slotCapacity ?? null) ? ['slotCapacity'] : []),
      ];
      if (changed.length === 0) return { ok: true, value: before };
      const values = {
        charge: next.charge,
        freeAbove: next.freeAbove,
        minDays: next.days?.min ?? null,
        maxDays: next.days?.max ?? null,
        zones: stored(next.zones),
        cutoffHour: next.cutoffHour ?? null,
        weights: storedWeights(next.weights),
        valueRates: storedValueRates(next.valueRates),
        slots: next.slots ?? [],
        slotDays: next.slotDays ?? 7,
        slotLeadHours: next.slotLeadHours ?? 2,
        slotCapacity: next.slotCapacity ?? null,
      };
      await tx
        .insert(deliverySettings)
        .values({ shopId: tenant.shopId, ...values })
        .onConflictDoUpdate({
          target: deliverySettings.shopId,
          set: { ...values, updatedAt: sql`now()` },
        });
      await appendEvent<DeliverySettingsUpdatedPayload>(tx, tenant.shopId, {
        type: CheckoutEvents.DeliverySettingsUpdated,
        aggregateType: 'delivery_settings',
        aggregateId: tenant.shopId,
        payload: { changed },
      });
      return { ok: true, value: await this.settingsOf(tx, tenant.shopId) };
    });
  }

  /**
   * The shop's charges, in the caller's transaction `tx`: for checkout, and for read models built
   * outside the module, such as the storefront's.
   */
  async settingsOf(
    tx: Tx,
    shopId: string,
    options: { lock?: boolean } = {},
  ): Promise<DeliverySettingsRecord> {
    const query = tx.select().from(deliverySettings).where(eq(deliverySettings.shopId, shopId));
    const [row] = options.lock ? await query.for('update') : await query;
    if (!row) return NO_DELIVERY_SETTINGS;
    return {
      charge: row.charge,
      freeAbove: row.freeAbove,
      days:
        row.minDays === null || row.maxDays === null
          ? null
          : { min: row.minDays, max: row.maxDays },
      zones: row.zones.map((zone) => ({
        name: zone.name,
        cities: zone.cities,
        charge: BigInt(zone.charge),
        days: zone.days ?? null,
      })),
      cutoffHour: row.cutoffHour,
      weights: row.weights.map((weight) => ({
        aboveGrams: weight.aboveGrams,
        charge: BigInt(weight.charge),
      })),
      valueRates: row.valueRates.map((rate) => ({
        fromSubtotal: BigInt(rate.fromSubtotal),
        charge: BigInt(rate.charge),
      })),
      slots: row.slots.map((slot) => ({ from: slot.from, until: slot.until })),
      slotDays: row.slotDays,
      slotLeadHours: row.slotLeadHours,
      slotCapacity: row.slotCapacity,
      updatedAt: row.updatedAt,
    };
  }
}

function stored(zones: DeliverySettingsRecord['zones']) {
  return zones.map((zone) => ({
    name: zone.name,
    cities: zone.cities,
    charge: zone.charge.toString(),
    days: zone.days,
  }));
}

function storedValueRates(rates: DeliverySettingsRecord['valueRates']) {
  return (rates ?? []).map((rate) => ({
    fromSubtotal: rate.fromSubtotal.toString(),
    charge: rate.charge.toString(),
  }));
}

function storedWeights(weights: DeliverySettingsRecord['weights']) {
  return (weights ?? []).map((weight) => ({
    aboveGrams: weight.aboveGrams,
    charge: weight.charge.toString(),
  }));
}
