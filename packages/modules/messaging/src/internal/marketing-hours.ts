// The hours marketing may reach a shop's customers (07 §1): from 10 in the morning until 9 at
// night in the shop's own time zone. A broadcast is queued, and its messages sent, in them alone
// (ADR-422).

export const MARKETING_HOURS = { opens: 10, closes: 21 } as const;

/**
 * Whether marketing may go at `at` in `timeZone`, and when it may next if not: the next 10 am
 * there, to the minute.
 */
export function marketingHours(timeZone: string, at: Date): { open: boolean; nextOpen: Date } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((each) => each.type === type)?.value ?? 0);
  const hour = part('hour');
  const sinceHour = (part('minute') * 60 + part('second')) * 1000 + at.getMilliseconds();
  const open = hour >= MARKETING_HOURS.opens && hour < MARKETING_HOURS.closes;
  // Hours until the next opening, from the start of this one.
  const hours =
    hour < MARKETING_HOURS.opens ? MARKETING_HOURS.opens - hour : 24 - hour + MARKETING_HOURS.opens;
  const nextOpen = open ? at : new Date(at.getTime() + hours * 3_600_000 - sinceHour);
  return { open, nextOpen };
}
