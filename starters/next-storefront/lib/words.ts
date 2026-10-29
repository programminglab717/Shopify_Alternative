import type { Language } from './language';

// The starter's own words, in English and Urdu (ADR-926). The shop's words, its products and
// collections, come from the Storefront API in the shopper's language.

const WORDS = {
  en: {
    cart: 'Cart',
    footer: 'Pay cash when your order arrives, or online at checkout.',
    search: 'Search',
    searchProducts: 'Search products',
    more: 'More products',
    nothing: 'Nothing here yet.',
    soldOut: 'Sold out',
    soldOutOption: ' (sold out)',
    choose: 'Choose',
    quantity: 'Quantity',
    addToCart: 'Add to cart',
    yourCart: 'Your cart',
    emptyCart: 'Nothing in it yet.',
    shopNow: 'Shop now',
    quantityOf: 'Quantity of',
    update: 'Update',
    subtotal: 'Subtotal',
    checkout: 'Check out',
    notFound: 'Not found',
    notHere: "This page isn't here.",
    back: 'Back to the shop',
    switchTo: 'اردو',
  },
  ur: {
    cart: 'کارٹ',
    footer: 'آرڈر ملنے پر نقد ادا کریں، یا چیک آؤٹ پر آن لائن۔',
    search: 'تلاش',
    searchProducts: 'مصنوعات تلاش کریں',
    more: 'مزید مصنوعات',
    nothing: 'یہاں ابھی کچھ نہیں۔',
    soldOut: 'ختم ہو گیا',
    soldOutOption: ' (ختم)',
    choose: 'منتخب کریں',
    quantity: 'تعداد',
    addToCart: 'کارٹ میں ڈالیں',
    yourCart: 'آپ کی کارٹ',
    emptyCart: 'اس میں ابھی کچھ نہیں۔',
    shopNow: 'خریداری کریں',
    quantityOf: 'تعداد:',
    update: 'تبدیل کریں',
    subtotal: 'کل رقم',
    checkout: 'چیک آؤٹ',
    notFound: 'نہیں ملا',
    notHere: 'یہ صفحہ یہاں نہیں ہے۔',
    back: 'دکان پر واپس جائیں',
    switchTo: 'English',
  },
} as const satisfies Record<Language, Record<string, string>>;

export type Words = (typeof WORDS)[Language];

/** The starter's words in `language`. */
export function wordsOf(language: Language): Words {
  return WORDS[language];
}
