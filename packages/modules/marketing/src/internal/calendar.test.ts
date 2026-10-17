import { describe, expect, it } from 'vitest';
import { MARKETING_MOMENTS, addDays, marketingCalendar, marketingDatesOf } from './calendar.js';

const datesOf = (year: number) =>
  Object.fromEntries(
    marketingDatesOf(year).map((date) => [date.moment, [date.startsOn, date.endsOn]]),
  );

describe("Pakistan's marketing calendar (MKT-16, ADR-484)", () => {
  it('dates the Islamic moments a day after Umm al-Qura, as Pakistan sighted them', () => {
    // Pakistan's own: Ramadan from 2 March 2025, Eid ul Fitr on 31 March, Eid ul Adha on 7 June;
    // Ramadan from 19 February 2026.
    expect(datesOf(2025)).toMatchObject({
      ramadan: ['2025-03-02', '2025-03-30'],
      eid_ul_fitr: ['2025-03-31', '2025-04-02'],
      eid_ul_adha: ['2025-06-07', '2025-06-09'],
    });
    expect(datesOf(2026).ramadan?.[0]).toBe('2026-02-19');
    // Ramadan comes twice in 2030, the Islamic year being shorter.
    expect(marketingDatesOf(2030).filter((date) => date.moment === 'ramadan')).toHaveLength(2);
    expect(marketingDatesOf(2030).find((date) => date.moment === 'eid_ul_fitr')).toMatchObject({
      expected: true,
    });
  });

  it('dates the rest by their days and rules, the wedding season into the next year', () => {
    expect(datesOf(2026)).toMatchObject({
      pakistan_day: ['2026-03-23', '2026-03-23'],
      mothers_day: ['2026-05-10', '2026-05-10'],
      independence_day: ['2026-08-14', '2026-08-14'],
      eleven_eleven: ['2026-11-11', '2026-11-11'],
      white_friday: ['2026-11-27', '2026-11-30'],
      twelve_twelve: ['2026-12-12', '2026-12-12'],
      summer_lawn: ['2026-02-15', '2026-04-30'],
      winter_collection: ['2026-10-01', '2026-11-30'],
      wedding_season: ['2026-11-01', '2027-02-28'],
    });
    expect(datesOf(2027).wedding_season?.[1]).toBe('2028-02-29');
    expect(datesOf(2025).white_friday).toEqual(['2025-11-28', '2025-12-01']);
    expect(datesOf(2025).mothers_day?.[0]).toBe('2025-05-11');
    expect(new Set(marketingDatesOf(2026).map((date) => date.moment))).toEqual(
      new Set(MARKETING_MOMENTS),
    );
  });

  it('lists what to promote for from today, soonest first, with each kit', () => {
    const calendar = marketingCalendar('2026-10-17', 60);
    expect(calendar.map((date) => [date.moment, date.promoteFrom])).toEqual([
      // Still on.
      ['winter_collection', '2026-09-17'],
      ['wedding_season', '2026-10-18'],
      ['eleven_eleven', '2026-11-04'],
      ['white_friday', '2026-11-13'],
      // Its promoting begins by 16 December.
      ['twelve_twelve', '2026-12-05'],
    ]);
    expect(calendar[3]!.kit).toEqual({
      code: 'WHITEFRIDAY26',
      percentage: 30,
      message: {
        en: 'White Friday is here: 30% off with code WHITEFRIDAY26, Friday to Monday.',
        ur: 'وائٹ فرائیڈے: جمعہ سے پیر تک کوڈ WHITEFRIDAY26 کے ساتھ 30% رعایت۔',
      },
    });
    // Eid's promoting begins three weeks ahead, in Ramadan.
    const eid = marketingCalendar('2027-01-01').find((date) => date.moment === 'eid_ul_fitr')!;
    expect(eid.promoteFrom).toBe(addDays(eid.startsOn, -21));
    expect(eid.kit.code).toBe('EID27');
    expect(marketingCalendar('2026-10-17', 0).map((date) => date.moment)).toEqual([
      'winter_collection',
    ]);
  });

  it("keeps every kit's words to one SMS campaign, and codes as discount codes take them", () => {
    for (const year of [2026, 2027, 2030]) {
      for (const { kit } of marketingDatesOf(year)) {
        expect(kit.code).toMatch(/^[A-Z0-9]{1,64}$/);
        for (const words of [kit.message.en, kit.message.ur]) {
          expect(words.length).toBeLessThanOrEqual(320);
          expect(words).toContain(kit.code);
          expect(words).toContain(`${kit.percentage}%`);
        }
      }
    }
  });
});
