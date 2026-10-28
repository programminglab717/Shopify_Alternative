import type { Locale } from '../i18n/locale';

// The help centre (BIL-05, ADR-508): short answers to what shops ask most, in English and Urdu,
// kept with the admin so that they work offline and on Free, where the help centre is how a shop
// helps itself before it asks Hatti's people.

export interface HelpArticle {
  id: string;
  title: Record<Locale, string>;
  body: Record<Locale, string>;
}

export const HELP_ARTICLES: readonly HelpArticle[] = [
  {
    id: 'confirm-orders',
    title: {
      en: 'Confirming cash-on-delivery orders',
      ur: 'کیش آن ڈیلیوری آرڈرز کی تصدیق',
    },
    body: {
      en:
        'Orders waiting to be confirmed are on the Confirmation Desk. The customer gets a WhatsApp ' +
        'message with buttons; your agents call those who don’t answer. Confirmed orders move to ' +
        'To pack.',
      ur:
        'تصدیق کے منتظر آرڈرز کنفرمیشن ڈیسک پر ہوتے ہیں۔ گاہک کو بٹنوں والا واٹس ایپ پیغام جاتا ہے؛ ' +
        'جو جواب نہ دیں، آپ کے ایجنٹ انہیں کال کرتے ہیں۔ تصدیق شدہ آرڈرز پیک کرنے کی فہرست میں چلے جاتے ہیں۔',
    },
  },
  {
    id: 'book-couriers',
    title: { en: 'Booking a courier', ur: 'کوریئر کی بکنگ' },
    body: {
      en:
        'Add your courier account in Settings, under Couriers. Packed orders are booked from ' +
        'Shipping, where labels and the load sheet are printed too.',
      ur:
        'اپنا کوریئر اکاؤنٹ سیٹنگز میں کوریئرز پر شامل کریں۔ پیک شدہ آرڈرز شپنگ سے بک ہوتے ہیں، ' +
        'اور لیبل اور لوڈ شیٹ بھی وہیں سے پرنٹ ہوتے ہیں۔',
    },
  },
  {
    id: 'courier-cash',
    title: { en: 'Cash your couriers owe you', ur: 'کوریئرز کے پاس آپ کی رقم' },
    body: {
      en:
        'Upload the courier’s statement on the Cash page. Hatti matches it to your parcels and ' +
        'shows what is still owed, and for how long.',
      ur:
        'کوریئر کا اسٹیٹمنٹ کیش کے صفحے پر اپلوڈ کریں۔ ہٹی اسے آپ کے پارسلز سے ملاتا ہے اور دکھاتا ہے ' +
        'کہ کتنی رقم کب سے باقی ہے۔',
    },
  },
  {
    id: 'returning-parcels',
    title: { en: 'Parcels coming back', ur: 'واپس آنے والے پارسل' },
    body: {
      en:
        'Parcels on their way back are listed under Returns. When one arrives, scan or type its ' +
        'tracking number so that its stock comes back.',
      ur:
        'واپس آنے والے پارسل ریٹرنز میں نظر آتے ہیں۔ پارسل پہنچنے پر اس کا ٹریکنگ نمبر اسکین یا درج کریں ' +
        'تاکہ اس کا اسٹاک واپس آ جائے۔',
    },
  },
  {
    id: 'online-payments',
    title: { en: 'Taking payments online', ur: 'آن لائن ادائیگیاں' },
    body: {
      en:
        'Open Online payments in Settings and connect JazzCash, Easypaisa, Safepay or another ' +
        'gateway with your own account. Online gateways are not on the Free plan.',
      ur:
        'سیٹنگز میں آن لائن ادائیگیاں کھولیں اور جاز کیش، ایزی پیسہ، سیف پے یا کوئی اور گیٹ وے اپنے ' +
        'اکاؤنٹ سے جوڑیں۔ فری پلان پر آن لائن گیٹ وے دستیاب نہیں۔',
    },
  },
  {
    id: 'own-domain',
    title: { en: 'Your own domain', ur: 'اپنا ڈومین' },
    body: {
      en:
        'Add your domain under Domains in Settings, and set the record shown there with your ' +
        'domain provider. Hatti checks it by itself. Your own domain is not on the Free plan.',
      ur:
        'سیٹنگز میں ڈومینز پر اپنا ڈومین شامل کریں اور وہاں دکھایا گیا ریکارڈ اپنے ڈومین فراہم کنندہ ' +
        'کے پاس لگائیں۔ ہٹی اسے خود چیک کرتا ہے۔ فری پلان پر اپنا ڈومین دستیاب نہیں۔',
    },
  },
  {
    id: 'plan-and-bills',
    title: { en: 'Your plan and bills', ur: 'آپ کا پلان اور بل' },
    body: {
      en:
        'Change your plan and see your bills under Billing in Settings. Bills can be paid by ' +
        'card, bank transfer or Raast.',
      ur:
        'سیٹنگز میں بلنگ پر اپنا پلان بدلیں اور بل دیکھیں۔ بل کارڈ، بینک ٹرانسفر یا راست سے ادا کیے ' +
        'جا سکتے ہیں۔',
    },
  },
  {
    id: 'staff',
    title: { en: 'Adding staff', ur: 'عملہ شامل کرنا' },
    body: {
      en:
        'Invite someone by email or mobile number under Staff in Settings, and choose their ' +
        'role: each role sees only its own work.',
      ur:
        'سیٹنگز میں اسٹاف پر کسی کو ای میل یا موبائل نمبر سے دعوت دیں اور ان کا کردار چنیں: ہر کردار ' +
        'صرف اپنا کام دیکھتا ہے۔',
    },
  },
  {
    id: 'store-in-urdu',
    title: { en: 'Your store in Urdu', ur: 'اردو میں اسٹور' },
    body: {
      en:
        'Translate your products, pages and menus under Urdu in the Online store. Have AI draft ' +
        'them, then check and save.',
      ur:
        'آن لائن اسٹور میں اردو پر اپنی مصنوعات، صفحات اور مینیو کا ترجمہ کریں۔ اے آئی سے مسودہ بنوائیں، ' +
        'پھر دیکھ کر محفوظ کریں۔',
    },
  },
  {
    id: 'whatsapp-catalogue',
    title: { en: 'Selling from your WhatsApp catalogue', ur: 'واٹس ایپ کیٹلاگ سے فروخت' },
    body: {
      en:
        'Copy your catalog feed’s address from the Meta tab of the Online store, and add it as a ' +
        'data source of your catalogue in Meta’s Commerce Manager, then connect that catalogue to ' +
        'your WhatsApp number. A customer who sends you a cart from it gets a link to your ' +
        'checkout with those items, their number filled in; the cart shows in your inbox.',
      ur:
        'آن لائن اسٹور کے میٹا ٹیب سے اپنی کیٹلاگ فیڈ کا پتا کاپی کریں اور میٹا کے کامرس مینیجر میں ' +
        'اپنے کیٹلاگ کے ڈیٹا سورس کے طور پر شامل کریں، پھر وہ کیٹلاگ اپنے واٹس ایپ نمبر سے جوڑیں۔ ' +
        'جو گاہک اس سے کارٹ بھیجے، اسے ان چیزوں کے ساتھ آپ کے چیک آؤٹ کا لنک ملتا ہے، اس کا نمبر بھرا ہوا؛ ' +
        'کارٹ آپ کے ان باکس میں نظر آتا ہے۔',
    },
  },
];

/** The articles a search finds, by their words in either language; all of them for none. */
export function searchArticles(query: string): readonly HelpArticle[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return HELP_ARTICLES;
  return HELP_ARTICLES.filter((article) => {
    const text = [article.title.en, article.body.en, article.title.ur, article.body.ur]
      .join(' ')
      .toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}
