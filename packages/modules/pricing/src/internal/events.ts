import type { DiscountKindValue } from './schema.js';

/** Events the pricing module publishes. Payloads are thin: fetch current state through the API. */
export const PricingEvents = {
  DiscountCodeCreated: 'discount_code.created',
  DiscountCodeUpdated: 'discount_code.updated',
  DiscountCodeDeleted: 'discount_code.deleted',
  /** An order was placed with the code. */
  DiscountCodeRedeemed: 'discount_code.redeemed',
} as const;

/** A discount code made, changed or deleted. */
export interface DiscountCodeChangedPayload {
  code: string;
  kind: DiscountKindValue;
  version: number;
}

/** An order placed with a code, and what the code took off it. */
export interface DiscountCodeRedeemedPayload {
  code: string;
  orderId: string;
  /** Minor units, as a string. */
  amount: string;
}
