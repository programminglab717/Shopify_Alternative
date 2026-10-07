import type { MapPoint } from './location.js';
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
  /** Its centre, roughly: how far an address's pin may be from it is counted from here. */
  readonly centre: MapPoint;
}

function city(
  id: string,
  name: string,
  nameUr: string,
  province: PkProvinceCode,
  [latitude, longitude]: readonly [number, number],
  aliases: readonly string[] = [],
): PkCity {
  return Object.freeze({
    id,
    name,
    nameUr,
    province,
    aliases: Object.freeze([...aliases]),
    centre: Object.freeze({ latitude, longitude }),
  });
}

/**
 * Seed list of major cities, larger cities first (approximately, by census population).
 * Address forms use it for suggestions only: customers may type any town.
 */
export const PK_CITIES: readonly PkCity[] = Object.freeze([
  city('karachi', 'Karachi', 'کراچی', 'SD', [24.8607, 67.0011], ['khi']),
  city('lahore', 'Lahore', 'لاہور', 'PB', [31.5204, 74.3587], ['lhr', 'lhe']),
  city('faisalabad', 'Faisalabad', 'فیصل آباد', 'PB', [31.4504, 73.135], ['lyallpur', 'fsd']),
  city('rawalpindi', 'Rawalpindi', 'راولپنڈی', 'PB', [33.5651, 73.0169], ['pindi', 'rwp']),
  city('gujranwala', 'Gujranwala', 'گوجرانوالہ', 'PB', [32.1877, 74.1945], ['grw']),
  city('peshawar', 'Peshawar', 'پشاور', 'KP', [34.0151, 71.5249], ['psh']),
  city('multan', 'Multan', 'ملتان', 'PB', [30.1575, 71.5249]),
  city('hyderabad', 'Hyderabad', 'حیدرآباد', 'SD', [25.396, 68.3578], ['hyd', 'haiderabad']),
  city('islamabad', 'Islamabad', 'اسلام آباد', 'IS', [33.6844, 73.0479], ['isb']),
  city('quetta', 'Quetta', 'کوئٹہ', 'BA', [30.1798, 66.975], ['koita']),
  city('bahawalpur', 'Bahawalpur', 'بہاولپور', 'PB', [29.3956, 71.6836], ['bwp']),
  city('sargodha', 'Sargodha', 'سرگودھا', 'PB', [32.0836, 72.6711], ['sgd']),
  city('sialkot', 'Sialkot', 'سیالکوٹ', 'PB', [32.4945, 74.5229], ['skt']),
  city('sukkur', 'Sukkur', 'سکھر', 'SD', [27.7052, 68.8574]),
  city('larkana', 'Larkana', 'لاڑکانہ', 'SD', [27.56, 68.2264]),
  city('sheikhupura', 'Sheikhupura', 'شیخوپورہ', 'PB', [31.7131, 73.9783], ['shaikhupura']),
  city('rahim-yar-khan', 'Rahim Yar Khan', 'رحیم یار خان', 'PB', [28.4202, 70.2952], ['ryk']),
  city('jhang', 'Jhang', 'جھنگ', 'PB', [31.2681, 72.3181]),
  city(
    'dera-ghazi-khan',
    'Dera Ghazi Khan',
    'ڈیرہ غازی خان',
    'PB',
    [30.0561, 70.6348],
    ['dg khan', 'dgk'],
  ),
  city('gujrat', 'Gujrat', 'گجرات', 'PB', [32.5731, 74.0789]),
  city('sahiwal', 'Sahiwal', 'ساہیوال', 'PB', [30.6682, 73.1114], ['montgomery']),
  city('wah-cantt', 'Wah Cantt', 'واہ کینٹ', 'PB', [33.7715, 72.7511], ['wah', 'wah cantonment']),
  city('mardan', 'Mardan', 'مردان', 'KP', [34.1986, 72.0404]),
  city('kasur', 'Kasur', 'قصور', 'PB', [31.1187, 74.4507], ['qasur']),
  city('okara', 'Okara', 'اوکاڑہ', 'PB', [30.8138, 73.4534]),
  city('mingora', 'Mingora', 'مینگورہ', 'KP', [34.7717, 72.36], ['swat', 'saidu sharif']),
  city(
    'nawabshah',
    'Nawabshah',
    'نوابشاہ',
    'SD',
    [26.2442, 68.41],
    ['benazirabad', 'shaheed benazirabad'],
  ),
  city('chiniot', 'Chiniot', 'چنیوٹ', 'PB', [31.7167, 72.9833]),
  city('mirpur-khas', 'Mirpur Khas', 'میرپور خاص', 'SD', [25.5276, 69.0111], ['mirpurkhas']),
  city('abbottabad', 'Abbottabad', 'ایبٹ آباد', 'KP', [34.1688, 73.2215], ['abbotabad']),
  city('muzaffargarh', 'Muzaffargarh', 'مظفر گڑھ', 'PB', [30.0703, 71.1933]),
  city('jhelum', 'Jhelum', 'جہلم', 'PB', [32.9425, 73.7257]),
  city('khanewal', 'Khanewal', 'خانیوال', 'PB', [30.3017, 71.9321]),
  city('kohat', 'Kohat', 'کوہاٹ', 'KP', [33.5869, 71.4414]),
  city(
    'dera-ismail-khan',
    'Dera Ismail Khan',
    'ڈیرہ اسماعیل خان',
    'KP',
    [31.8314, 70.9019],
    ['di khan', 'dik'],
  ),
  city('hafizabad', 'Hafizabad', 'حافظ آباد', 'PB', [32.0709, 73.688]),
  city('jacobabad', 'Jacobabad', 'جیکب آباد', 'SD', [28.2769, 68.4514]),
  city('attock', 'Attock', 'اٹک', 'PB', [33.766, 72.3609], ['campbellpur']),
  city('mianwali', 'Mianwali', 'میانوالی', 'PB', [32.5839, 71.537]),
  city('vehari', 'Vehari', 'وہاڑی', 'PB', [30.0452, 72.3489]),
  city('mansehra', 'Mansehra', 'مانسہرہ', 'KP', [34.3302, 73.1968]),
  city('nowshera', 'Nowshera', 'نوشہرہ', 'KP', [34.0153, 71.9747]),
  city('turbat', 'Turbat', 'تربت', 'BA', [26.0031, 63.0544], ['kech']),
  city('khuzdar', 'Khuzdar', 'خضدار', 'BA', [27.8, 66.6167]),
  city('gwadar', 'Gwadar', 'گوادر', 'BA', [25.1264, 62.3225]),
  city('muzaffarabad', 'Muzaffarabad', 'مظفرآباد', 'JK', [34.37, 73.4711]),
  city('mirpur-ajk', 'Mirpur', 'میرپور', 'JK', [33.1484, 73.7518], ['mirpur ajk', 'new mirpur']),
  city('gilgit', 'Gilgit', 'گلگت', 'GB', [35.9208, 74.3089]),
  city('skardu', 'Skardu', 'سکردو', 'GB', [35.2971, 75.6333]),
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
