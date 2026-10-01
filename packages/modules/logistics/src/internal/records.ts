import type { RemittanceOutcomeValue } from './schema.js';

/** A courier's remittance statement, as imported. Amounts are in minor units. */
export interface CodRemittanceRecord {
  id: string;
  courier: string;
  reference: string | null;
  lineCount: number;
  /** The cash the courier collected on the statement's parcels. */
  collected: bigint;
  charges: bigint;
  /** Withheld by the courier. */
  tax: bigint;
  /** What the courier paid over: the statement's net, else collected less charges and tax. */
  paid: bigint;
  /** What of the cash was received on orders. */
  received: bigint;
  /** What of the cash paid claims for parcels the courier lost (ADR-093). */
  compensated: bigint;
  /** Lines to look into: all but those received in full, charges alone and claims paid. */
  issueCount: number;
  createdAt: Date;
}

/** A line of a statement, and what became of it. */
export interface CodRemittanceLineRecord {
  /** Its row in the file; the header is row 1. */
  row: number;
  trackingNumber: string;
  fulfillmentId: string | null;
  orderId: string | null;
  orderNumber: number | null;
  outcome: RemittanceOutcomeValue;
  collected: bigint;
  charges: bigint;
  tax: bigint;
  /** What the order still owed as the line was taken; null for a line that matched no parcel. */
  owed: bigint | null;
  received: bigint;
}

/** Outcomes that need no one to look into them. */
export const SETTLED_OUTCOMES: readonly RemittanceOutcomeValue[] = [
  'received',
  'charged',
  'compensated',
];
