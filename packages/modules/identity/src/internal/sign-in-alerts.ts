// Word to an account's owner of a sign-in from a device new to it (ADM-02, ADR-179): what signed
// in, as its user agent says, and when, in Pakistan. A device is new when none of the account's
// sessions was used from it lately: the same ID its client keeps for it, or, from a client that
// keeps none, the same user agent, version numbers aside, since browsers update every few weeks.

/**
 * The header in which a client sends, with each sign-in, the random ID it keeps for the device it
 * runs on: 16 to 128 URL-safe characters, made once and kept while the device keeps its data.
 */
export const DEVICE_HEADER = 'x-hatti-device';

export const SIGN_IN_ALERT = {
  /** How long a device stays known: one of the account's sessions was used from it within this. */
  knownDays: 90,
  /** Alerts an account is sent in a day at most, whatever signs in to it. */
  perAccountDaily: 5,
} as const;

/** What an alert says around the device: English or Urdu. */
export type SignInAlertLanguage = 'en' | 'ur';

/** Systems, the first a user agent names: a phone's before the desktop's its browser mimics. */
const SYSTEMS: readonly [RegExp, string][] = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/Windows/, 'Windows'],
  [/CrOS/, 'ChromeOS'],
  [/Macintosh|Mac OS X/, 'Mac'],
  [/Linux/, 'Linux'],
];

/** Browsers, the first a user agent names: those built on Chrome or Safari before them. */
const BROWSERS: readonly [RegExp, string][] = [
  [/Edg(?:e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/UCBrowser\//, 'UC Browser'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Version\/[\d.]+.*Safari\//, 'Safari'],
];

const first = (patterns: readonly [RegExp, string][], userAgent: string): string | null =>
  patterns.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;

/**
 * What signed in, as its user agent says: "Chrome on Android", or "Android پر Chrome". Only words
 * of Hatti's own, never the user agent's, which whoever signs in writes.
 */
export function describeDevice(userAgent: string | null, language: SignInAlertLanguage): string {
  const browser = userAgent ? first(BROWSERS, userAgent) : null;
  const system = userAgent ? first(SYSTEMS, userAgent) : null;
  if (language === 'ur') {
    if (system) return `${system} پر ${browser ?? 'کوئی براؤزر'}`;
    return browser ?? 'نامعلوم ڈیوائس';
  }
  if (system) return `${browser ?? 'a browser'} on ${system}`;
  return browser ?? 'an unknown device';
}

/** `at` in Pakistan, as an alert says it: "5 Oct, 3:04 pm". */
export function pakistanTime(at: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Karachi',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(at);
}
