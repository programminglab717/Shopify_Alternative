// Sign-ups through the online store's form (ADR-189): Shopify's customer form, which themes'
// newsletter sections post, that the storefront sends on to the core, which keeps the shopper's
// consent to the shop's news and offers.

import { STOREFRONT_API_PREFIX } from './cart.js';

/**
 * POST a {@link SignUpRequest}: a shopper's sign-up, answered with a {@link SignUpResponse}; 422,
 * with a {@link SignUpErrorResponse}, says what was wrong with it.
 */
export function signUpsPath(shopId: string): string {
  return `${STOREFRONT_API_PREFIX}shops/${shopId}/sign-ups`;
}

export const SIGN_UP_LIMITS = {
  /** Tags a form gives the customer. */
  tags: 5,
} as const;

/** A sign-up's fields, as Shopify's customer form names them under `contact[…]`. */
export interface SignUpRequest {
  /** The mobile number typed: `contact[phone]`. */
  phone: string;
  /** Tags for the customer, comma-separated: `contact[tags]`, such as "newsletter". */
  tags?: string;
  /** The words the form showed beside it: `contact[consent]`; the platform's when left out. */
  consent?: string;
}

export interface SignUpResponse {
  /** Whether the number was new to the shop. */
  created: boolean;
  /** Whether the customer's consent changed: not where they were subscribed already. */
  subscribed: boolean;
}

/** What was wrong with a sign-up, by field: "phone". */
export interface SignUpErrorResponse {
  errors: { field: string; message: string }[];
}
