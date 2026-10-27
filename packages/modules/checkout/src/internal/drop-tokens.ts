// Drop tokens (INV-09, ADR-821): during a drop, checkout first takes each line's units from a pool
// of the variant's tokens, started from its stock the first time one is asked for; once the pool
// is empty, the order is refused at once, with no lock taken on the stock's rows. An order that is
// not placed gives its tokens back. Stock is still taken by the order as for any other, so a pool
// that is wrong refuses or lets through more orders than it should, and never oversells.

/** A pool: a drop's variant. */
export interface DropTokenPool {
  dropId: string;
  variantId: string;
}

/**
 * Where drops' token pools are kept, as the host application can: in Valkey. Without it, as in
 * tests, checkout takes no tokens.
 */
export abstract class DropTokens {
  /**
   * Takes `quantity` of `pool`'s tokens: whether there were so many. A pool not yet started is
   * started from `stock()`, kept until `expiresAt`; an empty one is started again from it now and
   * then, as orders cancelled or stock added give it more.
   */
  abstract take(
    pool: DropTokenPool,
    quantity: number,
    stock: () => Promise<number>,
    expiresAt: Date,
  ): Promise<boolean>;

  /** Gives back `quantity` taken from `pool` by an order not placed. */
  abstract giveBack(pool: DropTokenPool, quantity: number): Promise<void>;
}

/** Tokens taken by a checkout, given back unless its order is placed. */
export type DropClaim = { pool: DropTokenPool; quantity: number };
