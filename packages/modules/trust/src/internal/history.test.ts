import { describe, expect, it } from 'vitest';
import { historyOf, type HistoryIncident } from './incidents.service.js';
import { statusJson, statusPage } from './status-page.js';

// 2 pm in Pakistan: today has had 14 hours, and the 89 days before it make the history.
const NOW = new Date('2026-10-17T09:00:00.000Z');
const minutes = (count: number) => new Date(NOW.getTime() + count * 60_000);
const START = new Date('2026-07-19T19:00:00.000Z');

const incident = (
  components: HistoryIncident['components'],
  startsAt: Date,
  resolvedAt: Date | null,
  impact: HistoryIncident['impact'] = 'outage',
  kind: HistoryIncident['kind'] = 'incident',
): HistoryIncident => ({ kind, impact, components, startsAt, resolvedAt });

describe("The status page's 90 days of each part (BIL-06, ADR-528)", () => {
  const history = historyOf(
    [
      // Checkout down twice, the two overlapping: 50 minutes in all, not 65.
      incident(['checkout', 'couriers'], minutes(-60), minutes(-30)),
      incident(['checkout'], minutes(-45), minutes(-10)),
      // Maintenance posted ahead takes the admin down, and is not counted against it.
      incident(['admin'], minutes(-26 * 60), minutes(-24 * 60), 'outage', 'maintenance'),
      // Slow payments are shown, and not counted as down.
      incident(['payments'], minutes(-3 * 1440), minutes(-3 * 1440 + 90), 'degraded'),
      // Across Pakistan's midnight: half an hour on each day.
      incident(
        ['whatsapp'],
        new Date('2026-10-15T18:30:00.000Z'),
        new Date('2026-10-15T19:30:00.000Z'),
      ),
      // Still down: counted until now.
      incident(['sms'], minutes(-120), null),
      // Begun before the history: counted from its first day's midnight.
      incident(
        ['email'],
        new Date(START.getTime() - 2 * 3_600_000),
        new Date(START.getTime() + 3_600_000),
      ),
      // Ended before the history: not counted.
      incident(['storefronts'], new Date(START.getTime() - 5 * 3_600_000), START),
    ],
    NOW,
  );
  const of = (component: string) => history.find((each) => each.component === component)!;

  it('counts each part down only for incidents that took it down, each minute once', () => {
    expect(history.map((each) => each.component)).toEqual([
      'storefronts',
      'checkout',
      'admin',
      'payments',
      'couriers',
      'whatsapp',
      'sms',
      'email',
    ]);
    // 129,000 minutes since the first day's midnight.
    expect(Object.fromEntries(history.map((each) => [each.component, each.uptime]))).toEqual({
      storefronts: 100,
      checkout: 99.96,
      admin: 100,
      payments: 100,
      couriers: 99.97,
      whatsapp: 99.95,
      sms: 99.9,
      email: 99.95,
    });
  });

  it("says each of Pakistan's days how it worked, today the last", () => {
    const checkout = of('checkout').days;
    expect(checkout).toHaveLength(90);
    expect(checkout[0]).toEqual({ date: '2026-07-20', state: 'operational', downMinutes: 0 });
    expect(checkout.at(-1)).toEqual({ date: '2026-10-17', state: 'outage', downMinutes: 50 });
    expect(of('admin').days.at(-2)).toEqual({
      date: '2026-10-16',
      state: 'outage',
      downMinutes: 0,
    });
    expect(of('payments').days.at(-4)).toEqual({
      date: '2026-10-14',
      state: 'degraded',
      downMinutes: 0,
    });
    expect(of('whatsapp').days.slice(-3, -1)).toEqual([
      { date: '2026-10-15', state: 'outage', downMinutes: 30 },
      { date: '2026-10-16', state: 'outage', downMinutes: 30 },
    ]);
    expect(of('sms').days.at(-1)).toMatchObject({ state: 'outage', downMinutes: 120 });
    expect(of('email').days[0]).toMatchObject({ state: 'outage', downMinutes: 60 });
    expect(of('storefronts').days.every((day) => day.state === 'operational')).toBe(true);
  });

  it('shows the days as bars with the uptime on the page, and in its JSON', () => {
    const snapshot = {
      overall: 'outage' as const,
      components: history.map(({ component }) => ({
        component,
        state: component === 'sms' ? ('outage' as const) : ('operational' as const),
      })),
      active: [],
      upcoming: [],
      recent: [],
      history,
    };
    const page = statusPage(snapshot).html;
    expect(page.match(/class="bars"/g)).toHaveLength(8);
    expect(page).toContain('<span class="strong" data-uptime="checkout">99.96%</span>');
    expect(page).toContain('aria-label="100.00% · Up the last 90 days');
    expect(page).toContain('title="17 Oct: Down 50 minutes"');
    expect(page).toContain('title="20 Jul: Working"');
    expect(page).toContain('title="16 Oct: Down"');
    expect(page).toContain('title="14 Oct: Slow or partly down"');
    expect(statusJson(snapshot)).toMatchObject({
      history: expect.arrayContaining([
        expect.objectContaining({
          component: 'sms',
          uptime: 99.9,
          days: expect.arrayContaining([{ date: '2026-10-17', state: 'outage', downMinutes: 120 }]),
        }),
      ]),
    });
  });
});
