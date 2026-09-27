import { normalizeDigits } from './text.js';

export interface PkMobileNumber {
  /** +923001234567, the storage format */
  e164: string;
  /** 03001234567 */
  national: string;
  /** 0300 1234567, the display format */
  display: string;
}

/**
 * Parses a Pakistani mobile number in any common format:
 * 03001234567, 0300-1234567, +92 300 1234567, 923001234567, 00923001234567, 3001234567,
 * including Urdu digits. Returns null for landlines and invalid input.
 */
export function parsePkMobile(input: string): PkMobileNumber | null {
  const digits = normalizeDigits(input).replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(digits)) return null;

  let subscriber: string;
  if (digits.startsWith('+92')) subscriber = digits.slice(3);
  else if (digits.startsWith('0092')) subscriber = digits.slice(4);
  else if (digits.startsWith('92') && digits.length === 12) subscriber = digits.slice(2);
  else if (digits.startsWith('0') && digits.length === 11) subscriber = digits.slice(1);
  else if (digits.length === 10) subscriber = digits;
  else return null;

  if (!/^3\d{9}$/.test(subscriber)) return null;
  return {
    e164: `+92${subscriber}`,
    national: `0${subscriber}`,
    display: `0${subscriber.slice(0, 3)} ${subscriber.slice(3)}`,
  };
}

export function isPkMobile(input: string): boolean {
  return parsePkMobile(input) !== null;
}
