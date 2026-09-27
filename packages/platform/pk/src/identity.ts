import { normalizeDigits } from './text.js';

function digitsOnly(input: string): string {
  return normalizeDigits(input).replace(/[\s-]/g, '');
}

/** Normalises a CNIC to 12345-1234567-1, or returns null. Structure only: there is no public checksum. */
export function normalizeCnic(input: string): string | null {
  const digits = digitsOnly(input);
  if (!/^\d{13}$/.test(digits) || /^0+$/.test(digits)) return null;
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
}

/**
 * Normalises an NTN. Companies and AOPs have a 7-digit NTN plus a check digit (1234567-8);
 * individuals use their CNIC as NTN. Returns null for anything else.
 */
export function normalizeNtn(input: string): string | null {
  const digits = digitsOnly(input);
  if (/^\d{8}$/.test(digits) && !/^0+$/.test(digits)) {
    return `${digits.slice(0, 7)}-${digits.slice(7)}`;
  }
  return normalizeCnic(digits);
}
