import type { TenantContext } from '@hatti/api';
import { activeProductsIn } from '@hatti/catalog/public';
import { DeliveryService } from '@hatti/checkout/public';
import { Database } from '@hatti/db';
import { shopLogoOf } from '@hatti/files/public';
import { liveCourierAccountsIn } from '@hatti/logistics/public';
import { shopPoliciesOf, shopPreferencesOf } from '@hatti/online-store/public';
import { bankTransferSettingsIn } from '@hatti/orders/public';
import { realGatewayAccountsIn } from '@hatti/payments/public';
import { Injectable } from '@nestjs/common';

/**
 * What a new shop sets up before it sells (ONB-02, ADR-095), in the order it is asked to: its
 * products on sale, its delivery charges, a courier to book its parcels with (ADR-232), a way to
 * be paid ahead of delivery, its policies, its logo, its WhatsApp number, and its store open to
 * shoppers.
 */
export const SETUP_STEPS = [
  'products',
  'delivery',
  'couriers',
  'payments',
  'policies',
  'brand',
  'whatsapp',
  'open',
] as const;
export type SetupStepValue = (typeof SETUP_STEPS)[number];

/** The policies the checklist asks for: those shoppers look for before buying. */
export const SETUP_POLICIES = [
  'refund_policy',
  'privacy_policy',
  'terms_of_service',
  'shipping_policy',
] as const;

/** A step of the checklist, and whether the shop has done it. */
export interface SetupStepRecord {
  step: SetupStepValue;
  done: boolean;
  /** How far along a step of many things is: products on sale, policies written; else null. */
  count: number | null;
}

/**
 * The shop's setup checklist, worked out when asked from what each module keeps, in one
 * transaction: nothing is stored, so a step is done as soon as what it asks for is, and undone
 * when it no longer is.
 */
@Injectable()
export class SetupChecklistService {
  constructor(
    private readonly db: Database,
    private readonly delivery: DeliveryService,
  ) {}

  get(tenant: TenantContext): Promise<SetupStepRecord[]> {
    const { shopId } = tenant;
    return this.db.tenant(shopId, async (tx) => {
      const products = await activeProductsIn(tx, shopId);
      const delivery = await this.delivery.settingsOf(tx, shopId);
      const couriers = await liveCourierAccountsIn(tx, shopId);
      const bankTransfer = await bankTransferSettingsIn(tx, shopId);
      const gateways = await realGatewayAccountsIn(tx, shopId);
      const policies = new Set((await shopPoliciesOf(tx, shopId)).map((policy) => policy.type));
      const logo = await shopLogoOf(tx, shopId);
      const preferences = await shopPreferencesOf(tx, shopId);
      const written = SETUP_POLICIES.filter((type) => policies.has(type)).length;
      const steps: Record<SetupStepValue, Omit<SetupStepRecord, 'step'>> = {
        products: { done: products > 0, count: products },
        delivery: { done: delivery.updatedAt !== null, count: null },
        couriers: { done: couriers > 0, count: null },
        // Cash on delivery needs nothing. Paying online needs a gateway's account that takes real
        // money (ADR-232); transfers, Raast and advances, the shop's bank account.
        payments: { done: gateways > 0 || bankTransfer.account !== null, count: null },
        policies: { done: written === SETUP_POLICIES.length, count: written },
        brand: { done: logo !== null, count: null },
        whatsapp: { done: preferences.whatsappNumber !== null, count: null },
        open: { done: !preferences.passwordEnabled, count: null },
      };
      return SETUP_STEPS.map((step) => ({ step, ...steps[step] }));
    });
  }
}
