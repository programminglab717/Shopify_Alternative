import { createHash } from 'node:crypto';

// Prohibited-items screening (TNS-03, ADR-473): what Hatti's Acceptable Use Policy forbids selling
// in Pakistan (11 §6), found in a product's own words before it goes on sale. Words, not their
// parts: "gunmetal" is not a gun. A product Hatti's people cleared is not screened again until its
// words change.

/** What Hatti does not allow selling, each with the words that name it. */
export const PROHIBITED_GOODS = {
  weapons: [
    'pistol',
    'pistols',
    'revolver',
    'rifle',
    'rifles',
    'shotgun',
    'ammunition',
    'ammo',
    'bullets',
    'kalashnikov',
    'ak-47',
    'ak47',
    'پستول',
    'بندوق',
    'کلاشنکوف',
    'گولیاں',
  ],
  narcotics: [
    'heroin',
    'cocaine',
    'charas',
    'hashish',
    'marijuana',
    'cannabis',
    'crystal meth',
    'methamphetamine',
    'afeem',
    'چرس',
    'ہیروئن',
    'افیون',
  ],
  alcohol: ['whisky', 'whiskey', 'vodka', 'tequila', 'sharab', 'شراب'],
  medicines: ['tramadol', 'alprazolam', 'xanax', 'codeine', 'oxycodone', 'diazepam'],
  counterfeits: ['replica', 'first copy', 'master copy', 'aaa copy', '1st copy', 'copy of brand'],
  // Ivory the colour is everywhere in fashion: elephant ivory alone.
  wildlife: [
    'elephant ivory',
    'ivory tusk',
    'pangolin',
    'tiger skin',
    'leopard skin',
    'شیر کی کھال',
  ],
  gambling: ['betting tips', 'satta', 'جوا'],
} as const;

export type ProhibitedGood = keyof typeof PROHIBITED_GOODS;

/** A product's words that are screened. */
export interface ScreenedWords {
  title: string;
  description?: string | null;
  productType?: string | null;
  vendor?: string | null;
  tags?: readonly string[];
}

/** What a screening found: the kind of goods, and the words that named it. */
export interface ScreeningFinding {
  good: ProhibitedGood;
  words: string[];
}

/** Text as screened: lower case, its HTML's tags and its punctuation gone, its spaces single. */
function normalised(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^\p{L}\p{N}-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
}

const PATTERNS = Object.entries(PROHIBITED_GOODS).map(([good, words]) => ({
  good: good as ProhibitedGood,
  words: words.map((word) => ({ word, padded: normalised(word) })),
}));

function textOf(words: ScreenedWords): string {
  return [words.title, words.description, words.productType, words.vendor, ...(words.tags ?? [])]
    .filter(Boolean)
    .join(' \n ');
}

/** What of Hatti's prohibited goods a product's words name, each with the words found. */
export function screen(words: ScreenedWords): ScreeningFinding[] {
  const text = normalised(textOf(words));
  const findings: ScreeningFinding[] = [];
  for (const pattern of PATTERNS) {
    const found = pattern.words.filter(({ padded }) => text.includes(padded));
    if (found.length > 0)
      findings.push({ good: pattern.good, words: found.map((each) => each.word) });
  }
  return findings;
}

/** The digest of a product's screened words, which a clearance by Hatti's people holds. */
export function screeningDigest(words: ScreenedWords): string {
  return createHash('sha256')
    .update(normalised(textOf(words)))
    .digest('hex');
}

const NAMES: Record<ProhibitedGood, string> = {
  weapons: 'weapons and ammunition',
  narcotics: 'drugs',
  alcohol: 'alcohol',
  medicines: 'prescription medicines',
  counterfeits: 'copies of other brands',
  wildlife: 'protected wildlife',
  gambling: 'gambling',
};

/** Why a product may not go on sale, as its form says it. */
export function screeningMessage(findings: readonly ScreeningFinding[]): string {
  const goods = findings.map((finding) => NAMES[finding.good]).join(', ');
  const words = findings.flatMap((finding) => finding.words.map((word) => `"${word}"`)).join(', ');
  return (
    `Hatti doesn't allow selling ${goods} (it found ${words}). Keep it as a draft, or ask ` +
    "Hatti's support to review it if this is a mistake"
  );
}
