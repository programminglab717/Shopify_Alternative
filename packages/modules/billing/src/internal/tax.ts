// Provincial sales tax on Hatti's own invoices (BIL-02, ADR-512): plans and credit are priced
// exclusive of it (docs/product/03), and each invoice carries it at the rate of the revenue
// authority Hatti is registered with, where Hatti is registered at all.

/** The revenue authorities that tax services: Punjab, Sindh, Khyber Pakhtunkhwa, Balochistan, and FBR for Islamabad. */
export const TAX_AUTHORITIES = ['PRA', 'SRB', 'KPRA', 'BRA', 'ICT'] as const;
export type TaxAuthority = (typeof TAX_AUTHORITIES)[number];

/**
 * Each authority's standard rate on services, in basis points (docs/research/03 §6.7): what an
 * invoice is taxed at unless the host's configuration says otherwise, as when a reduced rate for
 * IT services applies.
 */
export const SERVICE_TAX_RATES: Readonly<Record<TaxAuthority, number>> = {
  PRA: 1600,
  SRB: 1500,
  KPRA: 1500,
  BRA: 1500,
  ICT: 1500,
};

/** Hatti's own registration for sales tax on services, from the host's configuration. */
export interface HattiTax {
  authority: TaxAuthority;
  /** Hatti's registration number with the authority. */
  registration: string;
  /** Basis points: 1600 for 16%. */
  rate: number;
  /** Hatti's national tax number, printed on its invoices; null where none is set. */
  ntn: string | null;
}

export const BILLING_TAX = Symbol('BILLING_TAX');

/** The tax on `net` paisa at `rate` basis points, to the paisa, halves rounded up. */
export function taxOn(net: bigint, rate: number): bigint {
  return (net * BigInt(rate) + 5_000n) / 10_000n;
}
