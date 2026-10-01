import { InputChecker, type FieldError, type MutationResult } from '@hatti/api';
import { secretToken, sha256 } from '@hatti/crypto';
import { LINK_HOURS } from './rules.js';

/** Where links' pages are: /d/<secret> for a draft order, /o/<secret> for an order. */
export const DRAFT_LINK_PATH = 'd';
export const ORDER_LINK_PATH = 'o';

/** 128 random bits in base64url: short enough for an SMS, and not to be guessed. */
const TOKEN_BYTES = 16;
const TOKEN = /^[A-Za-z0-9_-]{22}$/;
const HOUR_MS = 3_600_000;

/** A new link's secret, and its SHA-256 digest: all Hatti keeps of it. */
export function newLinkToken(): { token: string; hash: Buffer } {
  const token = secretToken('', TOKEN_BYTES);
  return { token, hash: sha256(token) };
}

/** The digest to find a link by; null for anything that cannot be a link's secret. */
export function linkHashOf(token: string): Buffer | null {
  return TOKEN.test(token) ? sha256(token) : null;
}

/** When a new link stops working: after `expiresInHours`, 72 unless given, at most 720. */
export function linkExpiry(
  expiresInHours: number | null | undefined,
): MutationResult<{ hours: number; expiresAt: Date }> {
  const check = new InputChecker();
  const hours = check.integer(['expiresInHours'], expiresInHours ?? LINK_HOURS.default, {
    min: 1,
    max: LINK_HOURS.max,
  });
  if (!check.ok || hours === null) return { ok: false, errors: check.errors };
  return { ok: true, value: { hours, expiresAt: new Date(Date.now() + hours * HOUR_MS) } };
}

/** The shop, as a link's page names it. */
export interface LinkShop {
  name: string;
  /** For the time the link stops working. */
  timezone: string;
}

/**
 * A delivery address as the customer typed it on their link's page, every field as posted.
 * `phone` counts only where the page asked for it, on a draft without a number: once the shop
 * has one, the page shows it masked and it stays as it is.
 */
export interface AddressForm {
  name: string;
  address1: string;
  /** The area. */
  address2: string;
  landmark: string;
  city: string;
  /** A province's code, or blank to take it from the city. */
  province: string;
  zip: string;
  phone: string;
}

/** Why what the customer asked for through a link did not happen; the page shows the order again. */
export type LinkProblem =
  /** What the page showed changed after the customer opened it. */
  | { kind: 'changed' }
  /** A draft's lines that cannot be sold now, by their place in it: sold out or off sale. */
  | { kind: 'unavailable'; lines: number[] }
  /** The shop cannot take the order now, such as when its location closed. */
  | { kind: 'refused' }
  /**
   * The order moved on, so the customer can no longer cancel it (once confirmed or shipped),
   * change its address (once packed or shipped) or send a receipt for it (once paid) here.
   */
  | { kind: 'too_late'; action: 'cancel' | 'address' | 'receipt' }
  /**
   * A receipt the customer sent that was not taken: no file, not a photo or a PDF, too large, or
   * one more than an order takes (ADR-080).
   */
  | { kind: 'receipt'; reason: 'missing' | 'type' | 'size' | 'count' }
  /** An address the customer typed that does not check out, to show again with what is wrong. */
  | { kind: 'address'; form: AddressForm; errors: FieldError[] };

/**
 * wa.me with a message: to `phone` (E.164), for callers who see numbers whole, or to a chat the
 * sender picks.
 */
export function whatsappUrl(message: string, phone: string | null): string {
  return `https://wa.me/${phone ? phone.slice(1) : ''}?text=${encodeURIComponent(message)}`;
}
