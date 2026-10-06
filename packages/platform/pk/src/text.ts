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

/**
 * How many typos turn `typed` into `word`: letters added, taken away or changed, and two letters
 * side by side swapped, each one typo. With `prefix`, into whichever start of `word` is nearest,
 * as for a word still being typed. Counting stops once past `max`, giving `max + 1`.
 */
export function typoDistance(
  typed: string,
  word: string,
  options: { prefix?: boolean; max?: number } = {},
): number {
  const a = Array.from(typed);
  const b = Array.from(word);
  const max = options.max ?? Number.POSITIVE_INFINITY;
  if (!options.prefix && Math.abs(a.length - b.length) > max) return max + 1;
  // Rows of the table of distances between starts of `typed` and starts of `word`.
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, at) => at);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      let best = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, before[j - 2]! + 1);
      }
      current[j] = best;
    }
    if (Math.min(...current) > max) return max + 1;
    before = previous;
    previous = current;
  }
  const distance = options.prefix ? Math.min(...previous) : previous[b.length]!;
  return Math.min(distance, max + 1);
}

/**
 * How many typos a word typed may have and still find a word: none in one under four letters
 * or with a digit, as sizes and codes are; one under eight letters; two from eight.
 */
export function typosAllowed(typed: string): number {
  const length = Array.from(typed).length;
  if (length < 4 || /\p{N}/u.test(typed)) return 0;
  return length < 8 ? 1 : 2;
}

/** A word of a catalog's that a word typed may be meant as, and how many typos away it is. */
export interface Correction {
  word: string;
  typos: number;
}

/** Words a word typed may be meant as, at most. */
export const CORRECTIONS = 5;

/**
 * For each of the keys `typed`, the words of `vocabulary` it may be meant as: itself alone where
 * a word holds it as typed; else the words within the typos its length allows
 * ({@link typosAllowed}), the nearest first, then the shortest, at most {@link CORRECTIONS}; none
 * where no word is that near. With `prefix`, the last is a word still being typed, matched
 * against the starts of words.
 */
export function correctionsOf(
  typed: readonly string[],
  vocabulary: readonly string[],
  options: { prefix?: boolean } = {},
): Correction[][] {
  return typed.map((key, at) => {
    if (vocabulary.some((word) => word.includes(key))) return [{ word: key, typos: 0 }];
    const allowed = typosAllowed(key);
    if (allowed === 0) return [];
    const prefix = options.prefix === true && at === typed.length - 1;
    const near: Correction[] = [];
    for (const word of vocabulary) {
      const typos = typoDistance(key, word, { prefix, max: allowed });
      if (typos <= allowed) near.push({ word, typos });
    }
    return near
      .sort(
        (a, b) => a.typos - b.typos || a.word.length - b.word.length || (a.word < b.word ? -1 : 1),
      )
      .slice(0, CORRECTIONS);
  });
}
