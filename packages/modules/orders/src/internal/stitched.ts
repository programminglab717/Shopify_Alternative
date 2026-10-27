import type { StitchingOffer } from '@hatti/catalog/public';

/** Pakistan keeps UTC+5 all year. */
const PK_OFFSET_MS = 5 * 3_600_000;

/**
 * The day a line sold stitched ships by (CAT-09, ADR-803), YYYY-MM-DD: the day it was sold in
 * Pakistan, or its pre-order's day if later, and the days its product's stitching takes; null
 * where its product offers none now.
 */
export function stitchedShipsOn(
  placedAt: Date,
  offer: StitchingOffer | undefined,
  preorderShipsOn: string | null,
): string | null {
  if (!offer) return null;
  const sold = new Date(placedAt.getTime() + PK_OFFSET_MS).toISOString().slice(0, 10);
  const from = preorderShipsOn && preorderShipsOn > sold ? preorderShipsOn : sold;
  const day = new Date(`${from}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + offer.leadDays);
  return day.toISOString().slice(0, 10);
}
