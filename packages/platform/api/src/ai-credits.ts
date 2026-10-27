/** What an AI draft spends one of a shop's monthly AI credits on (BIL-01, ADR-533). */
export type AiCreditUse = 'product_copy' | 'translation' | 'article';

/** A shop's AI credits this month. */
export interface AiCreditBalance {
  /** How many its plan includes a month. */
  perMonth: number;
  /** How many of the month's own are spent. */
  used: number;
  /** Credits the shop bought (ADR-539) and has not spent: they last until spent. */
  bought: number;
  /** What it has left to spend: the month's own, then those it bought. */
  left: number;
  /** The plan's name, such as "Free", to say which. */
  plan: string;
  /** When they come back: the next month's start in Pakistan's time. */
  renewsAt: Date;
}

/**
 * A shop's AI credits, as the billing module keeps them (ADR-533). Modules that ask the AI for a
 * draft ask first whether the shop has a credit left, and spend one once the AI gives the draft;
 * without it, as in most tests, AI drafts are not counted.
 */
export abstract class AiCredits {
  /** The shop's credits in the month of `at`. */
  abstract balanceOf(shopId: string, at?: Date): Promise<AiCreditBalance>;

  /** One credit spent at `at` on a draft the AI gave for `use`. */
  abstract spend(shopId: string, use: AiCreditUse, at?: Date): Promise<void>;
}

/** Why the AI drafts no more this month, naming the plan and when they come back. */
export function aiCreditsMessage(balance: AiCreditBalance): string {
  return (
    `The ${balance.plan} plan includes ${balance.perMonth} AI credits a month, and this month's ` +
    'are used: they come back on the 1st, or buy more, or choose a bigger plan for more'
  );
}
