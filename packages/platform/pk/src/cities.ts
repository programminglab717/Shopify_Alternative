import { searchKey } from './text.js';

export interface PkProvince {
  /** ISO 3166-2 subdivision code. */
  readonly iso: string;
  readonly name: string;
  readonly nameUr: string;
  readonly aliases: readonly string[];
}

/** Provinces and territories, keyed by the ISO 3166-2:PK suffix. */
export const PK_PROVINCES = {
  PB: { iso: 'PK-PB', name: 'Punjab', nameUr: 'پنجاب', aliases: [] },
  SD: { iso: 'PK-SD', name: 'Sindh', nameUr: 'سندھ', aliases: ['sind'] },
  KP: {
    iso: 'PK-KP',
    name: 'Khyber Pakhtunkhwa',
    nameUr: 'خیبر پختونخوا',
    aliases: ['kpk', 'kp', 'nwfp'],
  },
  BA: { iso: 'PK-BA', name: 'Balochistan', nameUr: 'بلوچستان', aliases: ['baluchistan'] },
  IS: {
    iso: 'PK-IS',
    name: 'Islamabad Capital Territory',
    nameUr: 'اسلام آباد',
    aliases: ['ict', 'islamabad', 'federal capital'],
  },
  GB: {
    iso: 'PK-GB',
    name: 'Gilgit-Baltistan',
    nameUr: 'گلگت بلتستان',
    aliases: ['gb', 'northern areas'],
  },
  JK: {
    iso: 'PK-JK',
    name: 'Azad Jammu and Kashmir',
    nameUr: 'آزاد جموں و کشمیر',
    aliases: ['ajk', 'azad kashmir'],
  },
} as const satisfies Record<string, PkProvince>;

export type PkProvinceCode = keyof typeof PK_PROVINCES;

export interface PkCity {
  /** Stable slug, safe to store. */
  readonly id: string;
  readonly name: string;
  readonly nameUr: string;
  readonly province: PkProvinceCode;
  /** Short forms, old names and common spellings. */
  readonly aliases: readonly string[];
}

function city(
  id: string,
  name: string,
  nameUr: string,
  province: PkProvinceCode,
  aliases: readonly string[] = [],
): PkCity {
  return Object.freeze({ id, name, nameUr, province, aliases: Object.freeze([...aliases]) });
}

/**
 * Seed list of major cities, larger cities first (approximately, by census population).
 * Address forms use it for suggestions only: customers may type any town.
 */
export const PK_CITIES: readonly PkCity[] = Object.freeze([
  city('karachi', 'Karachi', 'کراچی', 'SD', ['khi']),
  city('lahore', 'Lahore', 'لاہور', 'PB', ['lhr', 'lhe']),
  city('faisalabad', 'Faisalabad', 'فیصل آباد', 'PB', ['lyallpur', 'fsd']),
  city('rawalpindi', 'Rawalpindi', 'راولپنڈی', 'PB', ['pindi', 'rwp']),
  city('gujranwala', 'Gujranwala', 'گوجرانوالہ', 'PB', ['grw']),
  city('peshawar', 'Peshawar', 'پشاور', 'KP', ['psh']),
  city('multan', 'Multan', 'ملتان', 'PB'),
  city('hyderabad', 'Hyderabad', 'حیدرآباد', 'SD', ['hyd', 'haiderabad']),
  city('islamabad', 'Islamabad', 'اسلام آباد', 'IS', ['isb']),
  city('quetta', 'Quetta', 'کوئٹہ', 'BA', ['koita']),
  city('bahawalpur', 'Bahawalpur', 'بہاولپور', 'PB', ['bwp']),
  city('sargodha', 'Sargodha', 'سرگودھا', 'PB', ['sgd']),
  city('sialkot', 'Sialkot', 'سیالکوٹ', 'PB', ['skt']),
  city('sukkur', 'Sukkur', 'سکھر', 'SD'),
  city('larkana', 'Larkana', 'لاڑکانہ', 'SD'),
  city('sheikhupura', 'Sheikhupura', 'شیخوپورہ', 'PB', ['shaikhupura']),
  city('rahim-yar-khan', 'Rahim Yar Khan', 'رحیم یار خان', 'PB', ['ryk']),
  city('jhang', 'Jhang', 'جھنگ', 'PB'),
  city('dera-ghazi-khan', 'Dera Ghazi Khan', 'ڈیرہ غازی خان', 'PB', ['dg khan', 'dgk']),
  city('gujrat', 'Gujrat', 'گجرات', 'PB'),
  city('sahiwal', 'Sahiwal', 'ساہیوال', 'PB', ['montgomery']),
  city('wah-cantt', 'Wah Cantt', 'واہ کینٹ', 'PB', ['wah', 'wah cantonment']),
  city('mardan', 'Mardan', 'مردان', 'KP'),
  city('kasur', 'Kasur', 'قصور', 'PB', ['qasur']),
  city('okara', 'Okara', 'اوکاڑہ', 'PB'),
  city('mingora', 'Mingora', 'مینگورہ', 'KP', ['swat', 'saidu sharif']),
  city('nawabshah', 'Nawabshah', 'نوابشاہ', 'SD', ['benazirabad', 'shaheed benazirabad']),
  city('chiniot', 'Chiniot', 'چنیوٹ', 'PB'),
  city('mirpur-khas', 'Mirpur Khas', 'میرپور خاص', 'SD', ['mirpurkhas']),
  city('abbottabad', 'Abbottabad', 'ایبٹ آباد', 'KP', ['abbotabad']),
  city('muzaffargarh', 'Muzaffargarh', 'مظفر گڑھ', 'PB'),
  city('jhelum', 'Jhelum', 'جہلم', 'PB'),
  city('khanewal', 'Khanewal', 'خانیوال', 'PB'),
  city('kohat', 'Kohat', 'کوہاٹ', 'KP'),
  city('dera-ismail-khan', 'Dera Ismail Khan', 'ڈیرہ اسماعیل خان', 'KP', ['di khan', 'dik']),
  city('hafizabad', 'Hafizabad', 'حافظ آباد', 'PB'),
  city('jacobabad', 'Jacobabad', 'جیکب آباد', 'SD'),
  city('attock', 'Attock', 'اٹک', 'PB', ['campbellpur']),
  city('mianwali', 'Mianwali', 'میانوالی', 'PB'),
  city('vehari', 'Vehari', 'وہاڑی', 'PB'),
  city('mansehra', 'Mansehra', 'مانسہرہ', 'KP'),
  city('nowshera', 'Nowshera', 'نوشہرہ', 'KP'),
  city('turbat', 'Turbat', 'تربت', 'BA', ['kech']),
  city('khuzdar', 'Khuzdar', 'خضدار', 'BA'),
  city('gwadar', 'Gwadar', 'گوادر', 'BA'),
  city('muzaffarabad', 'Muzaffarabad', 'مظفرآباد', 'JK'),
  city('mirpur-ajk', 'Mirpur', 'میرپور', 'JK', ['mirpur ajk', 'new mirpur']),
  city('gilgit', 'Gilgit', 'گلگت', 'GB'),
  city('skardu', 'Skardu', 'سکردو', 'GB'),
]);

interface IndexedEntry<T> {
  readonly item: T;
  readonly keys: readonly string[];
}

function buildIndex<T>(items: readonly T[], names: (item: T) => string[]): IndexedEntry<T>[] {
  return items.map((item) => ({
    item,
    keys: [...new Set(names(item).map((name) => searchKey(name, { compact: true })))],
  }));
}

const CITY_INDEX = buildIndex(PK_CITIES, (c) => [c.name, c.nameUr, c.id, ...c.aliases]);

const PROVINCE_INDEX = buildIndex(
  Object.entries(PK_PROVINCES) as [PkProvinceCode, PkProvince][],
  ([code, p]) => [code, p.iso, p.name, p.nameUr, ...p.aliases],
);

/** Finds a city by exact name, Urdu name or alias, ignoring case, spacing and spelling variants. */
export function findCity(query: string): PkCity | null {
  const key = searchKey(query, { compact: true });
  if (key.length === 0) return null;
  return CITY_INDEX.find((entry) => entry.keys.includes(key))?.item ?? null;
}

/**
 * Suggests cities for a partial query: exact matches first, then prefix matches, then
 * substring matches. Ties keep list order, so bigger cities come first.
 */
export function searchCities(query: string, limit = 10): PkCity[] {
  const key = searchKey(query, { compact: true });
  if (key.length === 0 || limit <= 0) return [];
  const ranked: { city: PkCity; rank: number; order: number }[] = [];
  CITY_INDEX.forEach((entry, order) => {
    let rank = Number.POSITIVE_INFINITY;
    for (const candidate of entry.keys) {
      if (candidate === key) rank = Math.min(rank, 0);
      else if (candidate.startsWith(key)) rank = Math.min(rank, 1);
      else if (candidate.includes(key)) rank = Math.min(rank, 2);
    }
    if (Number.isFinite(rank)) ranked.push({ city: entry.item, rank, order });
  });
  return ranked
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, limit)
    .map((entry) => entry.city);
}

/** Resolves a province from its code, ISO code, English or Urdu name, or a common alias. */
export function findProvince(query: string): PkProvinceCode | null {
  const key = searchKey(query, { compact: true });
  if (key.length === 0) return null;
  return PROVINCE_INDEX.find((entry) => entry.keys.includes(key))?.item[0] ?? null;
}
