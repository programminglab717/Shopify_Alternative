import { searchKey } from './text.js';

// Pakistani shoppers' commerce words (SRC-02, ADR-481): words that name the same thing in English,
// Roman Urdu and Urdu script, so a shopper who types "juta" finds the shop's "shoes", and one who
// types "قمیض" its "kameez". Each group is one meaning; its words are folded by `searchKey`, as
// what is searched is. A kind of a thing is not the thing: a khussa is a shoe, but a shopper
// asking for shoes may not want khussas, so they are not one group.

/** Words that mean the same, each group one meaning, as shoppers type them. */
export const COMMERCE_LEXICON: readonly (readonly string[])[] = [
  // Clothes.
  ['kameez', 'qameez', 'قمیض'],
  ['shalwar', 'salwar', 'شلوار'],
  ['dupatta', 'dupata', 'دوپٹہ', 'دوپٹا'],
  ['kurta', 'کرتا'],
  ['kurti', 'کرتی'],
  ['suit', 'suits', 'jora', 'joray', 'جوڑا', 'جوڑے'],
  ['shawl', 'shawls', 'شال'],
  ['trouser', 'trousers', 'pant', 'pants', 'پتلون'],
  ['shirt', 'shirts', 'شرٹ'],
  ['lehenga', 'lehnga', 'لہنگا'],
  ['sherwani', 'شیروانی'],
  ['waistcoat', 'waistcoats', 'واسکٹ'],
  ['scarf', 'scarves', 'hijab', 'حجاب'],
  // Shoes.
  ['shoe', 'shoes', 'juta', 'joota', 'jutay', 'جوتا', 'جوتے'],
  ['slipper', 'slippers', 'chappal', 'chappals', 'چپل'],
  ['sandal', 'sandals', 'سینڈل'],
  // Jewellery, bags and the rest.
  ['bangle', 'bangles', 'churi', 'churiyan', 'چوڑی', 'چوڑیاں'],
  ['ring', 'rings', 'anguthi', 'انگوٹھی'],
  ['earring', 'earrings', 'bali', 'baliyan', 'بالی', 'بالیاں'],
  ['necklace', 'necklaces', 'haar', 'ہار'],
  ['watch', 'watches', 'ghari', 'گھڑی'],
  ['bag', 'bags', 'بیگ'],
  ['perfume', 'perfumes', 'fragrance', 'khushbu', 'خوشبو'],
  ['attar', 'itar', 'عطر'],
  // Fabrics.
  ['lawn', 'لان'],
  ['cotton', 'suti', 'سوتی'],
  ['silk', 'resham', 'ریشم'],
  ['khaddar', 'khadi', 'کھدر'],
  ['chiffon', 'شیفون'],
  ['velvet', 'makhmal', 'مخمل'],
  ['embroidered', 'embroidery', 'kadhai', 'کڑھائی'],
  // Who it is for, and when.
  ['women', 'womens', 'ladies', 'khawateen', 'خواتین'],
  ['men', 'mens', 'gents', 'mard', 'مرد'],
  ['kids', 'children', 'bachay', 'بچے'],
  ['bridal', 'bride', 'dulhan', 'دلہن'],
  ['wedding', 'shaadi', 'shadi', 'شادی'],
  ['eid', 'عید'],
  ['summer', 'garmi', 'گرمی'],
  ['winter', 'sardi', 'سردی'],
  // Colours.
  ['red', 'laal', 'lal', 'surkh', 'لال', 'سرخ'],
  ['green', 'hara', 'sabz', 'ہرا', 'سبز'],
  ['black', 'kala', 'کالا', 'سیاہ'],
  ['white', 'safaid', 'safed', 'سفید'],
  ['blue', 'neela', 'نیلا'],
  ['yellow', 'peela', 'پیلا'],
  ['pink', 'gulabi', 'گلابی'],
  ['golden', 'gold', 'sunehra', 'سنہرا'],
];

const GROUPS = new Map<string, string[]>();
for (const group of COMMERCE_LEXICON) {
  const keys = [...new Set(group.map((word) => searchKey(word)))];
  for (const key of keys) {
    GROUPS.set(key, [...new Set([...(GROUPS.get(key) ?? []), ...keys.filter((k) => k !== key)])]);
  }
}

/**
 * The other words, as `searchKey` folds them, that mean what the folded word `key` means: none
 * where it is not a commerce word Hatti knows.
 */
export function synonymsOf(key: string): readonly string[] {
  return GROUPS.get(key) ?? [];
}
