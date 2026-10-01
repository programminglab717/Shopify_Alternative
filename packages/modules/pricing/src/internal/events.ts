import type { DiscountKindValue } from './schema.js';

/** Events the pricing module publishes. Payloads are thin: fetch current state through the API. */
export const PricingEvents = {
  DiscountCodeCreated: 'discount_code.created',
  DiscountCodeUpdated: 'discount_code.updated',
  DiscountCodeDeleted: 'discount_code.deleted',
} as const;

/** A discount code made, changed or deleted. */
export interface DiscountCodeChangedPayload {
  code: string;
  kind: DiscountKindValue;
  version: number;
}
