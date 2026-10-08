// The admin's words in English and Urdu (docs/design/01 §3): plain, respectful ("aap"), with the
// loanwords merchants use (order, parcel, courier, COD). Urdu must give every key English does.

const en = {
  'app.name': 'Hatti',
  'app.tagline': 'Your shop, orders and cash in one place.',
  'language.toggle': 'اردو',
  'language.toggleLabel': 'Switch to Urdu',
  'state.loading': 'Loading…',
  'state.error': 'Something went wrong. Check your connection and try again.',
  'action.retry': 'Try again',
} as const;

export type MessageKey = keyof typeof en;

const ur: Record<MessageKey, string> = {
  'app.name': 'ہٹی',
  'app.tagline': 'آپ کی دکان، آرڈر اور کیش ایک جگہ۔',
  'language.toggle': 'English',
  'language.toggleLabel': 'انگریزی میں دیکھیں',
  'state.loading': 'لوڈ ہو رہا ہے…',
  'state.error': 'کچھ غلط ہو گیا۔ اپنا کنکشن دیکھیں اور دوبارہ کوشش کریں۔',
  'action.retry': 'دوبارہ کوشش کریں',
};

export const messages: Readonly<Record<'en' | 'ur', Readonly<Record<MessageKey, string>>>> = {
  en,
  ur,
};
