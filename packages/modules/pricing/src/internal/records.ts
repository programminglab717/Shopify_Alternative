import type { DiscountKindValue } from './schema.js';

/** The pricing module's view of its data, independent of GraphQL. */

export interface DiscountCodeRecord {
  id: string;
  /** As the shop wrote it; shoppers type it in any letter case. */
  code: string;
  title: string;
  kind: DiscountKindValue;
  /** Hundredths of a percent off the order's items: 1050 is 10.5%. Percentage codes only. */
  percentageBps: number | null;
  /** Off the order's items, in minor units of the shop's currency. Fixed-amount codes only. */
  amount: bigint | null;
  /** What the order's items must come to for the code to work. */
  minimumSubtotal: bigint | null;
  startsAt: Date;
  endsAt: Date | null;
  /** Orders that may be placed with it, in all. */
  usageLimit: number | null;
  /** Whether a customer may place only one order with it. */
  oncePerCustomer: boolean;
  /** Orders placed with it so far. */
  used: number;
  /**
   * The catalog's products and collections whose items it is for (ADR-517); neither, the whole
   * order. Free delivery is always for the whole order.
   */
  productIds: string[];
  collectionIds: string[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A discount given without a code to every order that qualifies while it runs (ADR-515). */
export interface AutomaticDiscountRecord {
  id: string;
  /** What shoppers see beside what it takes off: "Eid sale". */
  title: string;
  kind: DiscountKindValue;
  /** Hundredths of a percent off the order's items. Percentage discounts only. */
  percentageBps: number | null;
  /** Off the order's items, in minor units. Fixed-amount discounts only. */
  amount: bigint | null;
  /** What the order's items must come to for it to apply. */
  minimumSubtotal: bigint | null;
  startsAt: Date;
  endsAt: Date | null;
  /** Whether a discount code may be used with it. */
  combinesWithCodes: boolean;
  /**
   * The catalog's products and collections whose items it is for (ADR-517); neither, the whole
   * order. Free delivery is always for the whole order.
   */
  productIds: string[];
  collectionIds: string[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Whether a code works now, by its dates alone. */
export type DiscountStatusValue = 'scheduled' | 'active' | 'expired';

export interface Page<T> {
  items: T[];
  hasNextPage: boolean;
}
