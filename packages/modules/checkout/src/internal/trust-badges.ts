import type { InputChecker } from '@hatti/api';

/**
 * The badges a checkout's page may show under its button, from the platform's set, worded in
 * English and Urdu (CHK-14, ADR-086): cash on delivery; opening the parcel before paying for it;
 * an exchange or returns within so many days; original products; and help on WhatsApp. Or one in
 * the shop's own words, as it writes them (ADR-711).
 */
export const TRUST_BADGE_KINDS = [
  'cash_on_delivery',
  'open_parcel',
  'exchange',
  'returns',
  'original',
  'whatsapp',
  'custom',
] as const;

export type TrustBadgeKind = (typeof TRUST_BADGE_KINDS)[number];

/**
 * A badge the shop chose; `days` for an exchange or returns, null for the rest; `text` for one in
 * its own words alone.
 */
export interface TrustBadgeValue {
  kind: TrustBadgeKind;
  days: number | null;
  text?: string;
}

export interface TrustBadgeInput {
  kind: TrustBadgeKind;
  /** For an exchange or returns: within how many days, 1 to 90. */
  days?: number | null;
  /** For one in the shop's own words: what it says, up to 60 characters on one line. */
  text?: string | null;
}

export const TRUST_BADGE_LIMITS = { badges: 4, days: 90, text: 60 } as const;

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
  const seen = new Set<string>();
  const badges = inputs.map((input, index): TrustBadgeValue => {
    const at = [...field, String(index)];
    const text = input.kind === 'custom' ? ownWords(check, [...at, 'text'], input.text) : null;
    if (input.kind !== 'custom' && (input.text ?? '').trim() !== '') {
      check.addMessage([...at, 'text'], 'INVALID', 'Only a badge in your own words takes text');
    }
    // A badge in the shop's own words may come more than once, saying something else each time.
    const key = input.kind === 'custom' ? text && `custom:${text.toLowerCase()}` : input.kind;
    if (key !== null && seen.has(key)) {
      check.addMessage([...at, 'kind'], 'INVALID', 'Each badge once');
    }
    if (key !== null) seen.add(key);
    const given = input.days ?? null;
    if (!takesDays(input.kind)) {
      if (given !== null) {
        check.addMessage(
          [...at, 'days'],
          'INVALID',
          'Only an exchange or returns badge takes a number of days',
        );
      }
      return text === null
        ? { kind: input.kind, days: null }
        : { kind: input.kind, days: null, text };
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

/** What a badge in the shop's own words says: one line, its spaces tidied; null if wrong. */
function ownWords(check: InputChecker, field: string[], value: string | null | undefined) {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') {
    check.addMessage(field, 'BLANK', 'Say what the badge says, such as "Stitched in Lahore"');
    return null;
  }
  if (text.length > TRUST_BADGE_LIMITS.text) {
    check.addMessage(
      field,
      'TOO_LONG',
      `A badge says at most ${TRUST_BADGE_LIMITS.text} characters`,
    );
    return null;
  }
  return text;
}
