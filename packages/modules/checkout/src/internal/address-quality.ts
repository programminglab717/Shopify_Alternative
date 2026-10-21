// How much of an address a rider has to go on (CHK-02, ADR-682): couriers in Pakistan find a
// house by its number, its street or block, and a landmark near it, and an address with none of
// these is the commonest reason a parcel comes back undelivered.

/** What a delivery address leaves out that riders look for. */
export type AddressGap = 'number' | 'street' | 'landmark';

/** Digits, in Latin, Arabic-Indic or Urdu script: "12", "١٢", "۱۲". */
const DIGIT = /[0-9٠-٩۰-۹]/u;

/** Fewer letters than this in the house and street is no street. */
const STREET_LETTERS = 8;

/**
 * What the address leaves out, in the order the page asks for it: a house, flat or shop number;
 * the street or block, where the house-and-street line is a word or two; and, where neither an
 * area nor a landmark is given either, a landmark. Empty for an address a rider can go on.
 */
export function addressGaps(address: {
  address1: string;
  address2: string;
  landmark: string;
}): AddressGap[] {
  const line = address.address1.trim();
  const gaps: AddressGap[] = [];
  if (!DIGIT.test(line)) gaps.push('number');
  const letters = line.match(/\p{L}/gu)?.length ?? 0;
  const words = line.split(/[\s,]+/u).filter(Boolean).length;
  if (letters < STREET_LETTERS || words < 2) gaps.push('street');
  if (!address.address2.trim() && !address.landmark.trim()) gaps.push('landmark');
  return gaps;
}

/**
 * Whether checkout asks the shopper once for more before placing it: for no number or no street,
 * a landmark alone not being worth stopping them for.
 */
export function isVague(gaps: readonly AddressGap[]): boolean {
  return gaps.includes('number') || gaps.includes('street');
}
