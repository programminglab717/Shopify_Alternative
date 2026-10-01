import type { InputChecker } from '@hatti/api';

/**
 * The badges a checkout's page may show under its button, from the platform's set, worded in
 * English and Urdu (CHK-14, ADR-086): cash on delivery; opening the parcel before paying for it;
 * an exchange or returns within so many days; original products; and help on WhatsApp.
 */
export const TRUST_BADGE_KINDS = [
  'cash_on_delivery',
  'open_parcel',
  'exchange',
  'returns',
  'original',
  'whatsapp',
] as const;

export type TrustBadgeKind = (typeof TRUST_BADGE_KINDS)[number];

/** A badge the shop chose; `days` for an exchange or returns, null for the rest. */
export interface TrustBadgeValue {
  kind: TrustBadgeKind;
  days: number | null;
}

export interface TrustBadgeInput {
  kind: TrustBadgeKind;
  /** For an exchange or returns: within how many days, 1 to 90. */
  days?: number | null;
}

export const TRUST_BADGE_LIMITS = { badges: 4, days: 90 } as const;

/** The badges that take a number of days. */
export function takesDays(kind: TrustBadgeKind): boolean {
  return kind === 'exchange' || kind === 'returns';
}

/**
 * The badges `inputs` give, in their order, checked; null after adding what is wrong to `check`,
 * at `field`.
 */
export function checkTrustBadges(
  check: InputChecker,
  field: string[],
  inputs: readonly TrustBadgeInput[],
): TrustBadgeValue[] | null {
  const before = check.errors.length;
  if (inputs.length > TRUST_BADGE_LIMITS.badges) {
    check.addMessage(field, 'TOO_MANY', `At most ${TRUST_BADGE_LIMITS.badges} badges`);
    return null;
  }
  const seen = new Set<TrustBadgeKind>();
  const badges = inputs.map((input, index): TrustBadgeValue => {
    const at = [...field, String(index)];
    if (seen.has(input.kind)) {
      check.addMessage([...at, 'kind'], 'INVALID', 'Each badge once');
    }
    seen.add(input.kind);
    const given = input.days ?? null;
    if (!takesDays(input.kind)) {
      if (given !== null) {
        check.addMessage(
          [...at, 'days'],
          'INVALID',
          'Only an exchange or returns badge takes a number of days',
        );
      }
      return { kind: input.kind, days: null };
    }
    if (given === null) {
      check.addMessage([...at, 'days'], 'BLANK', 'Say within how many days, such as 7');
      return { kind: input.kind, days: null };
    }
    const days = check.integer([...at, 'days'], given, { min: 1, max: TRUST_BADGE_LIMITS.days });
    return { kind: input.kind, days };
  });
  return check.errors.length > before ? null : badges;
}
