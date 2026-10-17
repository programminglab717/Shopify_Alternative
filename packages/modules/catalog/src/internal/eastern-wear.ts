import type { InputChecker } from '@hatti/api';

// Eastern-wear attributes (CAT-08, ADR-477): how Pakistani shoppers choose a suit before its size
// or colour. Whether it comes stitched, in how many pieces, of what fabrics, and for which season,
// from Hatti's own words for each, so that every shop's "lawn" is the same lawn to filter by.

/** Whether a suit comes stitched: unstitched fabric is most of what sells. */
export const STITCHING = ['unstitched', 'semi_stitched', 'stitched'] as const;
export type Stitching = (typeof STITCHING)[number];

/** Its fabrics, those Pakistani shops sell eastern wear in. */
export const FABRICS = [
  'lawn',
  'cambric',
  'cotton',
  'khaddar',
  'karandi',
  'linen',
  'marina',
  'viscose',
  'dobby',
  'jacquard',
  'chiffon',
  'georgette',
  'organza',
  'net',
  'silk',
  'raw_silk',
  'velvet',
  'jamawar',
  'wool',
  'pashmina',
] as const;
export type Fabric = (typeof FABRICS)[number];

/** The season it is for. */
export const SEASONS = ['summer', 'winter', 'festive', 'all_season'] as const;
export type Season = (typeof SEASONS)[number];

export const EASTERN_WEAR_LIMITS = {
  /** A suit of shirt, trousers and dupatta is 3 pieces; a kurta alone 1. */
  pieces: { min: 1, max: 4 },
  /** A shirt of one fabric, a dupatta of another: at most this many. */
  fabrics: 3,
} as const;

/** A product's eastern-wear attributes; each may be unsaid. */
export interface EasternWear {
  stitching: Stitching | null;
  pieces: number | null;
  fabrics: Fabric[];
  season: Season | null;
}

/** What may be given for them: a field left out is unsaid. */
export interface EasternWearInput {
  stitching?: string | null;
  pieces?: number | null;
  fabrics?: readonly string[] | null;
  season?: string | null;
}

/** Each attribute's words, in English and Urdu, for the admin, storefronts and search. */
export const EASTERN_WEAR_WORDS: {
  stitching: Record<Stitching, { en: string; ur: string }>;
  fabrics: Record<Fabric, { en: string; ur: string }>;
  seasons: Record<Season, { en: string; ur: string }>;
} = {
  stitching: {
    unstitched: { en: 'Unstitched', ur: 'ان سلا' },
    semi_stitched: { en: 'Semi-stitched', ur: 'نیم سلا' },
    stitched: { en: 'Stitched', ur: 'سلا ہوا' },
  },
  fabrics: {
    lawn: { en: 'Lawn', ur: 'لان' },
    cambric: { en: 'Cambric', ur: 'کیمبرک' },
    cotton: { en: 'Cotton', ur: 'کاٹن' },
    khaddar: { en: 'Khaddar', ur: 'کھدر' },
    karandi: { en: 'Karandi', ur: 'کرنڈی' },
    linen: { en: 'Linen', ur: 'لینن' },
    marina: { en: 'Marina', ur: 'مارینا' },
    viscose: { en: 'Viscose', ur: 'وسکوز' },
    dobby: { en: 'Dobby', ur: 'ڈوبی' },
    jacquard: { en: 'Jacquard', ur: 'جیکارڈ' },
    chiffon: { en: 'Chiffon', ur: 'شیفون' },
    georgette: { en: 'Georgette', ur: 'جارجٹ' },
    organza: { en: 'Organza', ur: 'آرگنزا' },
    net: { en: 'Net', ur: 'نیٹ' },
    silk: { en: 'Silk', ur: 'سلک' },
    raw_silk: { en: 'Raw silk', ur: 'را سلک' },
    velvet: { en: 'Velvet', ur: 'ویلویٹ' },
    jamawar: { en: 'Jamawar', ur: 'جامہ وار' },
    wool: { en: 'Wool', ur: 'اون' },
    pashmina: { en: 'Pashmina', ur: 'پشمینہ' },
  },
  seasons: {
    summer: { en: 'Summer', ur: 'گرمیاں' },
    winter: { en: 'Winter', ur: 'سردیاں' },
    festive: { en: 'Festive', ur: 'تہوار' },
    all_season: { en: 'All season', ur: 'ہر موسم' },
  },
};

/** "3-piece", as shops say it, in English and Urdu. */
export function piecesWords(pieces: number): { en: string; ur: string } {
  return { en: `${pieces}-piece`, ur: `${pieces} پیس` };
}

/** None of them said. */
export function isUnsaid(value: EasternWear): boolean {
  return (
    value.stitching === null &&
    value.pieces === null &&
    value.fabrics.length === 0 &&
    value.season === null
  );
}

/**
 * Eastern-wear attributes as given, checked against Hatti's words: each fabric once, in the
 * order given. Null for none given, or for all of them unsaid.
 */
export function checkEasternWear(
  check: InputChecker,
  field: string[],
  input: EasternWearInput | null | undefined,
): EasternWear | null {
  if (!input) return null;
  const one = <T extends string>(
    name: string,
    value: string | null | undefined,
    allowed: readonly T[],
  ) => {
    if (value === null || value === undefined || value === '') return null;
    if (!(allowed as readonly string[]).includes(value)) {
      check.add([...field, name], 'INVALID', `must be one of ${allowed.join(', ')}`);
      return null;
    }
    return value as T;
  };
  const stitching = one('stitching', input.stitching, STITCHING);
  const season = one('season', input.season, SEASONS);
  let pieces: number | null = null;
  if (input.pieces !== null && input.pieces !== undefined) {
    pieces = check.integer([...field, 'pieces'], input.pieces, EASTERN_WEAR_LIMITS.pieces);
  }
  const fabrics: Fabric[] = [];
  for (const fabric of input.fabrics ?? []) {
    const known = one('fabrics', fabric, FABRICS);
    if (known && !fabrics.includes(known)) fabrics.push(known);
  }
  if (fabrics.length > EASTERN_WEAR_LIMITS.fabrics) {
    check.add([...field, 'fabrics'], 'TOO_MANY', `can have at most ${EASTERN_WEAR_LIMITS.fabrics}`);
  }
  const value = { stitching, pieces, fabrics, season };
  return isUnsaid(value) ? null : value;
}

/** The words search finds a product by for its attributes: "Unstitched 3-piece Lawn Summer". */
export function easternWearText(value: EasternWear | null | undefined): string {
  if (!value) return '';
  return [
    value.stitching && EASTERN_WEAR_WORDS.stitching[value.stitching].en,
    value.pieces && `${value.pieces} piece ${value.pieces}pc`,
    ...value.fabrics.map((fabric) => EASTERN_WEAR_WORDS.fabrics[fabric].en),
    value.season && EASTERN_WEAR_WORDS.seasons[value.season].en,
  ]
    .filter(Boolean)
    .join(' ');
}
