// Spin to win (OS-08, ADR-900): a shop's wheel of offers on its sign-up pop-up. The storefront
// asks the core for the wheel's slices to draw it, then sends on the shopper's number; the core
// signs them up, chooses their slice and makes their code, once a number.

import { STOREFRONT_API_PREFIX } from './cart.js';

/**
 * GET the shop's wheel, a {@link SpinWheelResponse}; 404 while it has none turned on. POST a
 * {@link SpinRequest}: a shopper's spin, answered with a {@link SpinResponse}; 422, with a
 * {@link SpinErrorResponse}, says what was wrong with it.
 */
export function spinsPath(shopId: string): string {
  return `${STOREFRONT_API_PREFIX}shops/${shopId}/spins`;
}

/** The wheel as a page draws it: its slices' words, in the shop's order. */
export interface SpinWheelResponse {
  slices: { label: string }[];
}

export interface SpinRequest {
  /** The mobile number typed. */
  phone: string;
  /** The words the form showed beside it; the platform's when left out. */
  consent?: string;
}

export interface SpinResponse {
  /** The slice the wheel stops at, by its place from 0. */
  slice: number;
  label: string;
  /** The shopper's own code, for one order; null for a slice that gives none. */
  code: string | null;
  /** When the code stops working. */
  endsAt: string | null;
  /** Whether the number spun before: its slice and code then, not a new one. */
  again: boolean;
}

/** What was wrong with a spin, by field: "phone". */
export interface SpinErrorResponse {
  errors: { field: string; message: string }[];
}
