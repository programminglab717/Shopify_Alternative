import { describe, expect, it } from 'vitest';
import {
  PK_CITIES,
  PK_CITY_AREAS,
  areaSuggestions,
  areasOf,
  findCity,
  findProvince,
  formatIban,
  isValidIban,
  normalizeCnic,
  normalizeDigits,
  normalizeNtn,
  normalizePkIban,
  maskPkMobile,
  normalizeUrduScript,
  parsePkMobile,
  prefixKey,
  searchCities,
  searchKey,
} from './index.js';

describe('parsePkMobile', () => {
  it.each([
    '03001234567',
    '0300-1234567',
    '0300 123 4567',
    '+92 300 1234567',
    '+92-300-1234567',
    '923001234567',
    '00923001234567',
    '3001234567',
    '(0300) 1234567',
    '۰۳۰۰۱۲۳۴۵۶۷',
  ])('parses %s', (input) => {
    expect(parsePkMobile(input)).toEqual({
      e164: '+923001234567',
      national: '03001234567',
      display: '0300 1234567',
    });
  });

  it.each([
    ['landline', '0421234567'],
    ['landline in E.164', '+92421234567'],
    ['too short', '0300123456'],
    ['too long', '030012345678'],
    ['letters', '0300-CALL-ME'],
    ['empty', ''],
    ['foreign number', '+971501234567'],
  ])('rejects %s', (_label, input) => {
    expect(parsePkMobile(input)).toBeNull();
  });

  it('masks the middle of a number, and hides anything else whole', () => {
    expect(maskPkMobile('+923001234567')).toBe('0300 ••••567');
    expect(maskPkMobile('0333-5551234')).toBe('0333 ••••234');
    expect(maskPkMobile('+92421234567')).toBe('••••');
  });
});

describe('CNIC and NTN', () => {
  it('normalises a CNIC typed with or without dashes', () => {
    expect(normalizeCnic('3520212345671')).toBe('35202-1234567-1');
    expect(normalizeCnic('35202-1234567-1')).toBe('35202-1234567-1');
    expect(normalizeCnic('۳۵۲۰۲۱۲۳۴۵۶۷۱')).toBe('35202-1234567-1');
  });

  it('rejects malformed CNICs', () => {
    expect(normalizeCnic('35202-1234567')).toBeNull();
    expect(normalizeCnic('0000000000000')).toBeNull();
    expect(normalizeCnic('35202-12345X7-1')).toBeNull();
  });

  it('accepts company NTNs and CNICs used as NTN', () => {
    expect(normalizeNtn('12345678')).toBe('1234567-8');
    expect(normalizeNtn('1234567-8')).toBe('1234567-8');
    expect(normalizeNtn('35202-1234567-1')).toBe('35202-1234567-1');
    expect(normalizeNtn('123456')).toBeNull();
    expect(normalizeNtn('00000000')).toBeNull();
  });
});

describe('IBAN', () => {
  it('validates the mod-97 check digits', () => {
    expect(isValidIban('PK36SCBL0000001123456702')).toBe(true);
    expect(isValidIban('PK36SCBL0000001123456703')).toBe(false);
    expect(isValidIban('GB82WEST12345698765432')).toBe(true);
  });

  it('normalises Pakistani IBANs only', () => {
    expect(normalizePkIban('pk36 scbl 0000 0011 2345 6702')).toBe('PK36SCBL0000001123456702');
    expect(normalizePkIban('GB82WEST12345698765432')).toBeNull();
    expect(normalizePkIban('PK36SCBL000000112345670')).toBeNull();
  });

  it('formats in groups of four', () => {
    expect(formatIban('PK36SCBL0000001123456702')).toBe('PK36 SCBL 0000 0011 2345 6702');
  });
});

describe('text normalisation', () => {
  it('converts Eastern digits', () => {
    expect(normalizeDigits('۰۳۰۰')).toBe('0300');
    expect(normalizeDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
  });

  it('unifies Arabic and Urdu letter forms', () => {
    // Arabic kaf and yeh, as typed on an Arabic keyboard.
    expect(normalizeUrduScript('\u0643\u0631\u0627\u0686\u064A')).toBe('کراچی');
    // Tatweel and a zero-width non-joiner are dropped.
    expect(normalizeUrduScript('لا\u0640ہور\u200C')).toBe('لاہور');
  });

  it.each([
    ['Qameez', 'kameez', 'kamiz'],
    ['joray', 'jorey', 'jore'],
    ['khussa', 'khusa', 'khusa'],
    ['shalvar', 'shalwar', 'shalwar'],
    ['Lawn Suit', 'lawn  suit', 'lawn suit'],
    ['Café', 'cafe', 'cafe'],
  ])('folds %s and %s to %s', (a, b, key) => {
    expect(searchKey(a)).toBe(key);
    expect(searchKey(b)).toBe(key);
  });

  it('matches Urdu typed with Arabic letters, heh variants and hamza', () => {
    expect(searchKey('كراچي')).toBe(searchKey('کراچی'));
    expect(searchKey('بهائی')).toBe(searchKey('بھائی'));
    expect(searchKey('فیصل آباد', { compact: true })).toBe(
      searchKey('فیصل\u200Cآباد', { compact: true }),
    );
  });

  it('can drop spaces', () => {
    expect(searchKey('Rahim Yar Khan', { compact: true })).toBe('rahimyarkhan');
  });

  it.each([
    ['kame', 'kameez'],
    ['kamee', 'qameez'],
    ['chappa', 'chappal'],
    ['sho', 'shoes'],
    ['cho', 'choori'],
    ['jora', 'joray'],
    ['peshawa', 'Peshawari'],
  ])('keys %s, as typed so far, as the start of %s', (typed, word) => {
    expect(searchKey(word).startsWith(prefixKey(searchKey(typed)))).toBe(true);
  });

  it('leaves short keys, whole words and Urdu script as they are', () => {
    expect(['ka', 'lawn', 'kamiz', 'شلوار'].map(prefixKey)).toEqual([
      'ka',
      'lawn',
      'kamiz',
      'شلوار',
    ]);
  });
});

describe('areas', () => {
  it("are the larger cities', each named once", () => {
    for (const [id, areas] of Object.entries(PK_CITY_AREAS)) {
      expect(
        PK_CITIES.some((city) => city.id === id),
        id,
      ).toBe(true);
      expect(new Set(areas).size, id).toBe(areas.length);
      expect(
        areas.every((area) => area.trim() === area && area.length <= 40),
        id,
      ).toBe(true);
    }
  });

  it('suggests those of a city typed as customers type it, and none for other towns', () => {
    expect(areasOf('khi')).toBe(PK_CITY_AREAS.karachi);
    expect(areasOf('Pindi')).toContain('Satellite Town');
    expect(areasOf('اسلام آباد')).toContain('G-11');
    expect(areasOf('Okara')).toEqual([]);
    expect(areasOf('Atlantis')).toEqual([]);
    expect(areasOf('')).toEqual([]);
  });

  it("suggests every city's areas, by the city, while a form has none", () => {
    const all = areaSuggestions(' ');
    expect(all).toHaveLength(Object.values(PK_CITY_AREAS).flat().length);
    expect(all[0]).toEqual({ value: 'Clifton', city: 'Karachi' });
    expect(all).toContainEqual({ value: 'G-11', city: 'Islamabad' });
    expect(areaSuggestions('Lahore')[0]).toEqual({ value: 'DHA', city: null });
    expect(areaSuggestions('Okara')).toEqual([]);
  });
});

describe('cities', () => {
  it('has unique ids', () => {
    const ids = PK_CITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([
    ['Pindi', 'rawalpindi'],
    ['راولپنڈی', 'rawalpindi'],
    ['lyallpur', 'faisalabad'],
    ['Faisal Abad', 'faisalabad'],
    ['RYK', 'rahim-yar-khan'],
    ['D.G. Khan', 'dera-ghazi-khan'],
    ['dera ghazi khan', 'dera-ghazi-khan'],
    ['كراچي', 'karachi'],
    ['Mirpur', 'mirpur-ajk'],
    ['mirpurkhas', 'mirpur-khas'],
  ])('finds %s', (query, id) => {
    expect(findCity(query)?.id).toBe(id);
  });

  it('returns null for unknown or empty input', () => {
    expect(findCity('Atlantis')).toBeNull();
    expect(findCity('  ')).toBeNull();
  });

  it('ranks exact, then prefix, then substring matches', () => {
    const ids = searchCities('gujra').map((c) => c.id);
    expect(ids).toEqual(['gujranwala', 'gujrat']);
    expect(searchCities('mirpur').map((c) => c.id)).toEqual(['mirpur-ajk', 'mirpur-khas']);
    expect(searchCities('abad', 3).map((c) => c.id)).toEqual([
      'faisalabad',
      'hyderabad',
      'islamabad',
    ]);
    expect(searchCities('')).toEqual([]);
  });

  it('resolves provinces from codes, names and aliases', () => {
    expect(findProvince('KPK')).toBe('KP');
    expect(findProvince('Khyber Pakhtunkhwa')).toBe('KP');
    expect(findProvince('PK-SD')).toBe('SD');
    expect(findProvince('سندھ')).toBe('SD');
    expect(findProvince('Baluchistan')).toBe('BA');
    expect(findProvince('Narnia')).toBeNull();
  });
});
