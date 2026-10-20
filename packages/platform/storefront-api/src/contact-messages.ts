// Messages through the online store's contact form (OS-08, ADR-589): Shopify's contact form, which
// themes' contact pages post, that the storefront sends on to the core, which keeps them for the
// shop's staff to read.

import { STOREFRONT_API_PREFIX } from './cart.js';

/**
 * POST a {@link ContactMessageRequest}: a shopper's message, answered with a
 * {@link ContactMessageResponse}; 422, with a {@link ContactMessageErrorResponse}, says what was
 * wrong with it.
 */
export function contactMessagesPath(shopId: string): string {
  return `${STOREFRONT_API_PREFIX}shops/${shopId}/contact-messages`;
}

export const CONTACT_MESSAGE_LIMITS = {
  name: 255,
  email: 254,
  /** Characters of what they wrote. */
  body: 5_000,
  /** The form's other fields, and how long their names and values may be. */
  fields: 20,
  fieldName: 64,
  fieldValue: 1_000,
  page: 512,
  userAgent: 512,
} as const;

/** A message's fields, as Shopify's contact form names them under `contact[…]`. */
export interface ContactMessageRequest {
  /** `contact[name]`. */
  name?: string;
  /** `contact[email]`: an email or a mobile number is needed, to answer them. */
  email?: string;
  /** `contact[phone]`: a mobile number. */
  phone?: string;
  /** What they wrote: `contact[body]`. */
  body: string;
  /** The form's other fields by their names: `contact[Order number]`. */
  fields?: Record<string, string>;
  /** The storefront's path the form was on. */
  page?: string;
  language?: 'en' | 'ur';
  /** Where it came from, as the storefront saw the shopper. */
  ip?: string;
  userAgent?: string;
}

export interface ContactMessageResponse {
  /** The message's ID: `cform_…`. */
  id: string;
}

/** What was wrong with a message, by field: "email", "phone", "body". */
export interface ContactMessageErrorResponse {
  errors: { field: string; message: string }[];
}
