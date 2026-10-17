// Pakistan's marketing calendar (MKT-16, ADR-484): the moments Pakistani shoppers buy for, each
// year's dates, when to start promoting, and a campaign kit for each. Islamic moments follow the
// moon: their dates come from the Umm al-Qura calendar (through Intl, whose ICU data has it) a
// day later, as Pakistan's sighting usually is, and are expected until the Ruet-e-Hilal
// committee sights the moon. The rest fall on fixed days, or on rules (the last Friday of
// November). Days are YYYY-MM-DD, in the shop's time zone.

export const MARKETING_MOMENTS = [
  'ramadan',
  'eid_ul_fitr',
  'eid_ul_adha',
  'pakistan_day',
  'mothers_day',
  'independence_day',
  'eleven_eleven',
  'white_friday',
  'twelve_twelve',
  'summer_lawn',
  'winter_collection',
  'wedding_season',
] as const;

export type MarketingMomentValue = (typeof MARKETING_MOMENTS)[number];

/** A ready-made campaign for a moment: a discount code to make, and words to send. */
export interface CampaignKit {
  /** The code to suggest, its year's last two digits after it: EID26. */
  code: string;
  /** The percentage off to suggest. */
  percentage: number;
  /** A broadcast's words, naming the code and percentage, short enough for one SMS campaign. */
  message: { en: string; ur: string };
}

/** A moment's dates in a year, with its kit. */
export interface MarketingDate {
  moment: MarketingMomentValue;
  /** Its first day. */
  startsOn: string;
  /** Its last day: the same as the first for a day of its own. */
  endsOn: string;
  /** When shops begin promoting for it: what a kit's code starts on. */
  promoteFrom: string;
  /** Whether its dates wait on the moon's sighting. */
  expected: boolean;
  kit: CampaignKit;
}

interface Kit {
  base: string;
  percentage: number;
  en: string;
  ur: string;
}

// {code} and {percentage} are filled in.
const KITS: Record<MarketingMomentValue, Kit> = {
  ramadan: {
    base: 'RAMADAN',
    percentage: 10,
    en: 'Ramadan Mubarak! Get {percentage}% off this Ramadan with code {code}.',
    ur: 'رمضان مبارک! اس رمضان کوڈ {code} کے ساتھ {percentage}% رعایت حاصل کریں۔',
  },
  eid_ul_fitr: {
    base: 'EID',
    percentage: 15,
    en: 'Get ready for Eid: {percentage}% off with code {code}. Order early to have it before Eid.',
    ur: 'عید کی تیاری کریں: کوڈ {code} کے ساتھ {percentage}% رعایت۔ عید سے پہلے پانے کے لیے جلد آرڈر کریں۔',
  },
  eid_ul_adha: {
    base: 'EIDADHA',
    percentage: 10,
    en: 'Eid ul Adha Mubarak! {percentage}% off with code {code}.',
    ur: 'عید الاضحیٰ مبارک! کوڈ {code} کے ساتھ {percentage}% رعایت۔',
  },
  pakistan_day: {
    base: 'PAKDAY',
    percentage: 23,
    en: 'Celebrate Pakistan Day, 23 March: {percentage}% off with code {code}.',
    ur: 'یومِ پاکستان، 23 مارچ: کوڈ {code} کے ساتھ {percentage}% رعایت۔',
  },
  mothers_day: {
    base: 'AMMI',
    percentage: 10,
    en: "For Mother's Day: {percentage}% off gifts for Ammi with code {code}.",
    ur: 'ماں کے دن کے لیے: امی کے تحفوں پر کوڈ {code} کے ساتھ {percentage}% رعایت۔',
  },
  independence_day: {
    base: 'AZADI',
    percentage: 14,
    en: 'Jashn-e-Azadi Mubarak! {percentage}% off for 14 August with code {code}.',
    ur: 'جشنِ آزادی مبارک! 14 اگست پر کوڈ {code} کے ساتھ {percentage}% رعایت۔',
  },
  eleven_eleven: {
    base: 'ELEVEN',
    percentage: 11,
    en: '11.11 sale: {percentage}% off on 11 November with code {code}.',
    ur: '11.11 سیل: 11 نومبر کو کوڈ {code} کے ساتھ {percentage}% رعایت۔',
  },
  white_friday: {
    base: 'WHITEFRIDAY',
    percentage: 30,
    en: 'White Friday is here: {percentage}% off with code {code}, Friday to Monday.',
    ur: 'وائٹ فرائیڈے: جمعہ سے پیر تک کوڈ {code} کے ساتھ {percentage}% رعایت۔',
  },
  twelve_twelve: {
    base: 'TWELVE',
    percentage: 12,
    en: '12.12 sale: {percentage}% off on 12 December with code {code}.',
    ur: '12.12 سیل: 12 دسمبر کو کوڈ {code} کے ساتھ {percentage}% رعایت۔',
  },
  summer_lawn: {
    base: 'LAWN',
    percentage: 10,
    en: 'The new lawn collection is here! {percentage}% off with code {code}.',
    ur: 'نئی لان کلیکشن آ گئی ہے! کوڈ {code} کے ساتھ {percentage}% رعایت۔',
  },
  winter_collection: {
    base: 'WINTER',
    percentage: 15,
    en: 'Our winter collection is here! {percentage}% off with code {code}.',
    ur: 'ہماری سردیوں کی کلیکشن آ گئی ہے! کوڈ {code} کے ساتھ {percentage}% رعایت۔',
  },
  wedding_season: {
    base: 'SHAADI',
    percentage: 10,
    en: 'Shaadi season: {percentage}% off for the weddings with code {code}.',
    ur: 'شادیوں کا موسم: کوڈ {code} کے ساتھ {percentage}% رعایت۔',
  },
};

/** The days before a moment shops begin promoting for it. */
const LEAD_DAYS: Record<MarketingMomentValue, number> = {
  ramadan: 14,
  // Eid's shopping starts in Ramadan's first weeks, and parcels take days.
  eid_ul_fitr: 21,
  eid_ul_adha: 14,
  pakistan_day: 7,
  mothers_day: 10,
  independence_day: 14,
  eleven_eleven: 7,
  white_friday: 14,
  twelve_twelve: 7,
  summer_lawn: 14,
  winter_collection: 14,
  wedding_season: 14,
};

/** The most days ahead a calendar looks. */
export const CALENDAR_DAYS_MAX = 731;

const DAY_MS = 86_400_000;

/** The day `days` after `day` (before, if negative). */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function ymd(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

/** The day of the week of `day`, Sunday 0. */
function weekday(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

const HIJRI = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});

const hijriByYear = new Map<number, Map<string, string>>();

/** Each day of a Gregorian year by its Umm al-Qura date, "year-month-day" (1-based months). */
function hijriDaysOf(year: number): Map<string, string> {
  let days = hijriByYear.get(year);
  if (days) return days;
  days = new Map();
  for (let day = ymd(year, 1, 1); day.startsWith(String(year)); day = addDays(day, 1)) {
    const parts = HIJRI.formatToParts(new Date(`${day}T12:00:00Z`));
    const part = (type: string) => parts.find((each) => each.type === type)?.value;
    days.set(`${Number.parseInt(part('year') ?? '', 10)}-${part('month')}-${part('day')}`, day);
  }
  hijriByYear.set(year, days);
  return days;
}

/** The Gregorian days of `year` that are the Islamic `month`'s `day`, as Pakistan sights it. */
function islamicDaysIn(year: number, month: number, day: number): string[] {
  const found: string[] = [];
  for (const [hijri, gregorian] of hijriDaysOf(year)) {
    if (hijri.endsWith(`-${month}-${day}`)) found.push(addDays(gregorian, 1));
  }
  return found.sort();
}

function kitOf(moment: MarketingMomentValue, startsOn: string): CampaignKit {
  const kit = KITS[moment];
  const code = `${kit.base}${startsOn.slice(2, 4)}`;
  const fill = (text: string) =>
    text.replace('{code}', code).replace('{percentage}', String(kit.percentage));
  return { code, percentage: kit.percentage, message: { en: fill(kit.en), ur: fill(kit.ur) } };
}

function dated(
  moment: MarketingMomentValue,
  startsOn: string,
  endsOn: string,
  expected = false,
): MarketingDate {
  return {
    moment,
    startsOn,
    endsOn,
    promoteFrom: addDays(startsOn, -LEAD_DAYS[moment]),
    expected,
    kit: kitOf(moment, startsOn),
  };
}

/** Each moment that starts in the Gregorian `year`. */
export function marketingDatesOf(year: number): MarketingDate[] {
  const dates: MarketingDate[] = [];
  // 1 Ramadan to the day before Eid, which is 1 Shawwal: 29 or 30 days.
  for (const startsOn of islamicDaysIn(year, 9, 1)) {
    const eid = islamicDaysIn(Number(addDays(startsOn, 31).slice(0, 4)), 10, 1).find(
      (day) => day > startsOn,
    );
    dates.push(dated('ramadan', startsOn, addDays(eid ?? addDays(startsOn, 30), -1), true));
  }
  for (const startsOn of islamicDaysIn(year, 10, 1)) {
    dates.push(dated('eid_ul_fitr', startsOn, addDays(startsOn, 2), true));
  }
  for (const startsOn of islamicDaysIn(year, 12, 10)) {
    dates.push(dated('eid_ul_adha', startsOn, addDays(startsOn, 2), true));
  }
  const day = (month: number, date: number) => ymd(year, month, date);
  dates.push(dated('pakistan_day', day(3, 23), day(3, 23)));
  // The second Sunday of May.
  const firstOfMay = day(5, 1);
  const mothersDay = addDays(firstOfMay, ((7 - weekday(firstOfMay)) % 7) + 7);
  dates.push(dated('mothers_day', mothersDay, mothersDay));
  dates.push(dated('independence_day', day(8, 14), day(8, 14)));
  dates.push(dated('eleven_eleven', day(11, 11), day(11, 11)));
  // The last Friday of November, to the Monday after.
  const lastOfNovember = day(11, 30);
  const whiteFriday = addDays(lastOfNovember, -((weekday(lastOfNovember) + 2) % 7));
  dates.push(dated('white_friday', whiteFriday, addDays(whiteFriday, 3)));
  dates.push(dated('twelve_twelve', day(12, 12), day(12, 12)));
  // Lawn's new collections launch from mid-February into spring.
  dates.push(dated('summer_lawn', day(2, 15), day(4, 30)));
  dates.push(dated('winter_collection', day(10, 1), day(11, 30)));
  // The wedding season, November to the end of February.
  dates.push(dated('wedding_season', day(11, 1), addDays(ymd(year + 1, 3, 1), -1)));
  return dates;
}

/**
 * The moments to promote for from `today` through `days` ahead: those not yet over whose
 * promoting begins by then, soonest first.
 */
export function marketingCalendar(today: string, days = 365): MarketingDate[] {
  const until = addDays(today, Math.min(Math.max(days, 0), CALENDAR_DAYS_MAX));
  const first = Number(today.slice(0, 4)) - 1;
  const last = Number(until.slice(0, 4)) + 1;
  const dates: MarketingDate[] = [];
  for (let year = first; year <= last; year++) dates.push(...marketingDatesOf(year));
  return dates
    .filter((date) => date.endsOn >= today && date.promoteFrom <= until)
    .sort(
      (a, b) =>
        a.startsOn.localeCompare(b.startsOn) ||
        MARKETING_MOMENTS.indexOf(a.moment) - MARKETING_MOMENTS.indexOf(b.moment),
    );
}
