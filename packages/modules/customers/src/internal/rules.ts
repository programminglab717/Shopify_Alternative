import { parsePkMobile, searchKey } from '@hatti/pk';
import type { BlockReasonValue } from './schema.js';

export const LIMITS = {
  name: 255,
  note: 5_000,
  blocklistNote: 1_000,
} as const;

const BLOCK_REASON_TEXT: Record<BlockReasonValue, string> = {
  fake_orders: 'fake orders',
  refused_deliveries: 'refused deliveries',
  abuse: 'abuse',
  fraud: 'fraud',
  other: 'other reasons',
};

/** Why a number is blocked, for timelines and messages: "refused deliveries". */
export function blockReasonText(reason: BlockReasonValue): string {
  return BLOCK_REASON_TEXT[reason];
}

/** "0300 1234567": how staff read a stored (E.164) number. */
export function displayPhone(e164: string): string {
  return parsePkMobile(e164)?.display ?? e164;
}

/** What a customer's search matches: their name and email. */
export function customerSearchText(name: string | null, email: string | null): string {
  return searchKey([name ?? '', email ?? ''].join(' '));
}
