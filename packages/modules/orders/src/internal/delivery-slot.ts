import type { DeliverySlotValue } from './records.js';

/** Pakistan keeps UTC+5 all year. */
const PK_OFFSET_MS = 5 * 3_600_000;

/**
 * The time an order is to be delivered in (CHK-15, ADR-770), as pages and slips say it, in
 * Pakistan's time: "Saturday 24 October, 10:00 – 13:00".
 */
export function deliverySlotText(slot: DeliverySlotValue): string {
  const starts = new Date(slot.startsAt.getTime() + PK_OFFSET_MS);
  const ends = new Date(slot.endsAt.getTime() + PK_OFFSET_MS);
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(starts);
  const clock = (at: Date) => at.toISOString().slice(11, 16);
  return `${day}, ${clock(starts)} – ${clock(ends)}`;
}
