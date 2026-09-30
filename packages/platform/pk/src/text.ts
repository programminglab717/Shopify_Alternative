/**
 * Text normalisation for search and matching. The same function must be applied to
 * indexed text and to queries, so spelling variants land on the same key.
 */

const EASTERN_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;

/** Converts Arabic-Indic (٠-٩) and Urdu/Persian (۰-۹) digits to ASCII digits. */
export function normalizeDigits(input: string): string {
  return input.replace(EASTERN_DIGITS, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/** Letters typed on Arabic keyboards that Urdu writes with different code points. */
const URDU_LETTER_MAP: Readonly<Record<string, string>> = {
  '\u064A': '\u06CC', // ي Arabic yeh → ی Farsi yeh
  '\u0649': '\u06CC', // ى alef maksura → ی
  '\u0643': '\u06A9', // ك Arabic kaf → ک keheh
  '\u0647': '\u06C1', // ه heh → ہ heh goal
  '\u06C0': '\u06C1', // ۀ heh with yeh above → ہ
  '\u0629': '\u06C1', // ة teh marbuta → ہ
};
const URDU_LETTER_PATTERN = /[\u064A\u0649\u0643\u0647\u06C0\u0629]/g;

/** Harakat, superscript alef, tatweel, zero-width and bidi control characters. */
const URDU_NOISE = /[\u064B-\u065F\u0670\u0640\u200B-\u200F\u061C]/g;

/**
 * Unifies Arabic/Urdu letter variants and strips diacritics and invisible characters.
 * Lossless enough to apply to stored names, unlike {@link searchKey}.
 */
export function normalizeUrduScript(input: string): string {
  return input
    .replace(URDU_NOISE, '')
    .replace(URDU_LETTER_PATTERN, (letter) => URDU_LETTER_MAP[letter] ?? letter);
}

/**
 * Heh forms that people use interchangeably when typing: ھ do-chashmi heh, and ە ae,
 * which is what NFKD leaves of ۀ once the hamza is stripped.
 */
const HEH_VARIANTS = /[\u06BE\u06D5]/g;

/**
 * Folds common Roman Urdu spelling variants of one lowercase Latin token:
 * qameez/kameez/kamiz → kamiz · shalvar → shalwar · joray/jorey → jore · khussa → khusa
 */
function foldLatinToken(token: string): string {
  if (!/^[a-z0-9]+$/.test(token)) return token;
  return token
    .replace(/q/g, 'k')
    .replace(/v/g, 'w')
    .replace(/zh/g, 'z')
    .replace(/ee|ii/g, 'i')
    .replace(/oo|uu/g, 'u')
    .replace(/aa/g, 'a')
    .replace(/(?:ay|ey|ai|ae)$/, 'e')
    .replace(/([a-z])\1+/g, '$1');
}

export interface SearchKeyOptions {
  /** Drop spaces as well, e.g. "Rahim Yar Khan" → "rahimyarkhan". */
  compact?: boolean;
}

/**
 * Lossy key for matching Latin, Roman Urdu and Urdu-script text. Compatibility forms
 * (Arabic presentation forms, full-width digits) are decomposed, accents and hamza
 * stripped, letter variants unified and Roman Urdu spellings folded.
 */
export function searchKey(input: string, options: SearchKeyOptions = {}): string {
  const text = normalizeUrduScript(
    normalizeDigits(input)
      .normalize('NFKD')
      .replace(/\p{M}+/gu, ''),
  )
    .replace(HEH_VARIANTS, '\u06C1')
    .toLowerCase();
  const tokens = text
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0)
    .map(foldLatinToken);
  return tokens.join(options.compact ? '' : ' ');
}

/**
 * What the key of a word still being typed starts with, however the word goes on: its key
 * without a last vowel, which the rest of the word may fold away. "kame", on its way to
 * "kameez", keys as "kame", but "kameez" as "kamiz": both start "kam". Keys of one or two
 * letters, and words in Urdu script, stay as they are.
 */
export function prefixKey(key: string): string {
  return /^[a-z0-9]{3,}$/.test(key) && /[aeiou]$/.test(key) ? key.slice(0, -1) : key;
}
