// Hatti's course for partners (PRT-04, ADR-858): what a partner should know to set a shop up and
// run it well, in English and Urdu, and the questions that certify they do. Its version changes
// as it does; a certificate is of the version passed.

export interface Words {
  en: string;
  ur: string;
}

export interface Lesson {
  id: string;
  title: Words;
  body: Words;
}

export interface Question {
  id: string;
  prompt: Words;
  options: Words[];
  /** The right option, by its place. */
  answer: number;
}

export const COURSE_VERSION = '2026-10';

export const LESSONS: readonly Lesson[] = [
  {
    id: 'cod',
    title: { en: 'Cash on delivery, confirmed', ur: 'کیش آن ڈیلیوری، تصدیق کے ساتھ' },
    body: {
      en:
        'Most orders in Pakistan are paid at the door, and many are never collected. Every new ' +
        'cash-on-delivery order goes to the Confirmation Desk: the customer gets a WhatsApp ' +
        'message with Confirm and Cancel buttons, and agents call those who do not answer. Only ' +
        'confirmed orders are packed, so fewer parcels come back. Set up the desk, the agents and ' +
        'the WhatsApp number before a shop opens.',
      ur:
        'پاکستان میں زیادہ تر آرڈرز دروازے پر ادا ہوتے ہیں، اور بہت سے وصول ہی نہیں ہوتے۔ ہر نیا کیش آن ' +
        'ڈیلیوری آرڈر کنفرمیشن ڈیسک پر جاتا ہے: گاہک کو تصدیق اور منسوخی کے بٹنوں والا واٹس ایپ پیغام ' +
        'ملتا ہے، اور جو جواب نہ دیں انہیں ایجنٹ کال کرتے ہیں۔ صرف تصدیق شدہ آرڈرز پیک ہوتے ہیں، اس لیے ' +
        'کم پارسل واپس آتے ہیں۔ دکان کھلنے سے پہلے ڈیسک، ایجنٹ اور واٹس ایپ نمبر تیار کریں۔',
    },
  },
  {
    id: 'couriers',
    title: { en: 'Couriers and the cash they owe', ur: 'کوریئرز اور ان کے پاس رقم' },
    body: {
      en:
        'Add the shop’s courier accounts under Settings › Couriers, with rules for which courier ' +
        'takes which city. Packed orders are booked from Shipping, where labels and the load ' +
        'sheet are printed. Couriers pay cash on delivery back later: upload their statements on ' +
        'the Cash page, and Hatti matches them to the shop’s parcels and shows what is still owed.',
      ur:
        'دکان کے کوریئر اکاؤنٹس سیٹنگز › کوریئرز میں شامل کریں، اس اصول کے ساتھ کہ کون سا کوریئر کس شہر ' +
        'جاتا ہے۔ پیک شدہ آرڈرز شپنگ سے بک ہوتے ہیں، جہاں لیبل اور لوڈ شیٹ پرنٹ ہوتے ہیں۔ کوریئرز ' +
        'کیش بعد میں واپس کرتے ہیں: ان کے اسٹیٹمنٹ کیش کے صفحے پر اپلوڈ کریں، ہٹی انہیں دکان کے پارسلز ' +
        'سے ملا کر بتاتا ہے کہ کتنی رقم باقی ہے۔',
    },
  },
  {
    id: 'store',
    title: { en: 'The online store, in two languages', ur: 'آن لائن اسٹور، دو زبانوں میں' },
    body: {
      en:
        'A shop’s look is a theme: one of Hatti’s themes with the shop’s own settings and ' +
        'sections, changed in the theme editor and previewed before it is published. Copy the ' +
        'live theme before big changes, or publish one at a time set ahead. Translate products, ' +
        'pages and menus under Urdu; AI drafts them, and the shop checks them.',
      ur:
        'دکان کی شکل ایک تھیم ہے: ہٹی کی کوئی تھیم دکان کی اپنی سیٹنگز اور سیکشنز کے ساتھ، جو تھیم ایڈیٹر ' +
        'میں بدلی جاتی ہے اور شائع کرنے سے پہلے دیکھی جاتی ہے۔ بڑی تبدیلیوں سے پہلے لائیو تھیم کی کاپی ' +
        'بنائیں، یا ایک وقت مقرر کر کے شائع کریں۔ مصنوعات، صفحات اور مینیو کا ترجمہ اردو میں کریں؛ اے آئی ' +
        'مسودہ بناتا ہے اور دکان اسے دیکھتی ہے۔',
    },
  },
  {
    id: 'payments',
    title: { en: 'Paying online', ur: 'آن لائن ادائیگی' },
    body: {
      en:
        'Besides cash on delivery, a shop takes bank transfers and Raast, which its staff ' +
        'confirm from the receipt the customer sends, and card and wallet payments through a ' +
        'gateway it connects with its own merchant account. A shop may ask an advance on cash ' +
        'on delivery, paid by transfer before the parcel ships: an amount, a share of the items or ' +
        'the delivery charge, on every order or above a total.',
      ur:
        'کیش آن ڈیلیوری کے علاوہ، دکان بینک ٹرانسفر اور راست لیتی ہے، جن کی تصدیق عملہ گاہک کی بھیجی رسید ' +
        'سے کرتا ہے، اور کارڈ اور والیٹ کی ادائیگیاں اس گیٹ وے سے جو وہ اپنے مرچنٹ اکاؤنٹ سے جوڑتی ہے۔ ' +
        'دکان کیش آن ڈیلیوری پر ایڈوانس مانگ سکتی ہے، جو پارسل بھیجنے سے پہلے ٹرانسفر سے ادا ہو: ایک رقم، ' +
        'اشیاء کا حصہ یا ڈیلیوری چارج، ہر آرڈر پر یا ایک رقم سے زیادہ کے آرڈرز پر۔',
    },
  },
  {
    id: 'staff',
    title: { en: 'Staff, and handing a store over', ur: 'عملہ، اور اسٹور حوالے کرنا' },
    body: {
      en:
        'Each member of a shop’s staff has a role: owner, manager, confirmation agent, packer, ' +
        'marketer or accountant, or a custom role made from one. Owners, managers and ' +
        'accountants need two-step verification. A partner builds a store as its owner on a development store, ' +
        'closed to shoppers, then invites the client as a manager and hands the store over from ' +
        'Settings › Staff: the client becomes its owner, and the store opens.',
      ur:
        'دکان کے عملے کے ہر رکن کا ایک کردار ہے: مالک، مینیجر، کنفرمیشن ایجنٹ، پیکر، مارکیٹر یا اکاؤنٹنٹ، ' +
        'یا ان میں سے کسی سے بنا اپنا کردار۔ مالکان، مینیجرز اور اکاؤنٹنٹس کے لیے دو مرحلہ تصدیق ضروری ہے۔ پارٹنر ' +
        'ڈویلپمنٹ اسٹور پر مالک کے طور پر اسٹور بناتا ہے، جو خریداروں کے لیے بند ہوتا ہے، پھر کلائنٹ کو ' +
        'مینیجر کے طور پر بلاتا ہے اور سیٹنگز › عملہ سے اسٹور حوالے کرتا ہے: کلائنٹ مالک بن جاتا ہے اور ' +
        'اسٹور کھل جاتا ہے۔',
    },
  },
  {
    id: 'grow',
    title: { en: 'Growing a shop', ur: 'دکان کو بڑھانا' },
    body: {
      en:
        'Connect Meta, TikTok and Google from the online store so that their ads learn from real ' +
        'orders; give their catalogues the shop’s catalog feed. WhatsApp messages, broadcasts and ' +
        'automations bring customers back, sent only to those who agreed, and stopped when they ' +
        'ask. Reports show sales, returns and what each ad brought.',
      ur:
        'آن لائن اسٹور سے میٹا، ٹک ٹاک اور گوگل جوڑیں تاکہ ان کے اشتہارات اصل آرڈرز سے سیکھیں؛ ان کے ' +
        'کیٹلاگز کو دکان کی کیٹلاگ فیڈ دیں۔ واٹس ایپ پیغامات، براڈکاسٹس اور آٹومیشنز گاہکوں کو واپس لاتے ' +
        'ہیں، صرف انہیں جو راضی ہوں، اور ان کے کہنے پر بند ہو جاتے ہیں۔ رپورٹس فروخت، واپسیاں اور ہر ' +
        'اشتہار کا نتیجہ دکھاتی ہیں۔',
    },
  },
];

const options = (...pairs: [string, string][]): Words[] => pairs.map(([en, ur]) => ({ en, ur }));

export const QUESTIONS: readonly Question[] = [
  {
    id: 'q-confirm',
    prompt: {
      en: 'Which cash-on-delivery orders are packed?',
      ur: 'کون سے کیش آن ڈیلیوری آرڈرز پیک ہوتے ہیں؟',
    },
    options: options(
      ['Every order, as it comes', 'ہر آرڈر، جیسے ہی آئے'],
      ['Orders the customer or an agent confirmed', 'وہ آرڈرز جن کی گاہک یا ایجنٹ نے تصدیق کی'],
      ['Orders over Rs 5,000', '5,000 روپے سے زیادہ کے آرڈرز'],
    ),
    answer: 1,
  },
  {
    id: 'q-no-answer',
    prompt: {
      en: 'A customer does not answer the confirmation message. What happens?',
      ur: 'گاہک تصدیقی پیغام کا جواب نہیں دیتا۔ پھر کیا ہوتا ہے؟',
    },
    options: options(
      ['The order is cancelled at once', 'آرڈر فوراً منسوخ ہو جاتا ہے'],
      [
        'An agent calls them from the Confirmation Desk',
        'کنفرمیشن ڈیسک سے ایجنٹ انہیں کال کرتا ہے',
      ],
      ['The order is shipped anyway', 'آرڈر پھر بھی بھیج دیا جاتا ہے'],
    ),
    answer: 1,
  },
  {
    id: 'q-courier-cash',
    prompt: {
      en: 'How does a shop see the cash its couriers still owe?',
      ur: 'دکان کیسے دیکھتی ہے کہ کوریئرز کے پاس کتنی رقم باقی ہے؟',
    },
    options: options(
      [
        'By uploading the couriers’ statements on the Cash page',
        'کیش کے صفحے پر کوریئرز کے اسٹیٹمنٹ اپلوڈ کر کے',
      ],
      ['By calling each courier', 'ہر کوریئر کو کال کر کے'],
      ['It cannot', 'نہیں دیکھ سکتی'],
    ),
    answer: 0,
  },
  {
    id: 'q-courier-rules',
    prompt: {
      en: 'Where does a shop say which courier takes which city?',
      ur: 'دکان کہاں بتاتی ہے کہ کون سا کوریئر کس شہر جائے؟',
    },
    options: options(
      ['In each order, by hand', 'ہر آرڈر میں ہاتھ سے'],
      ['In Settings › Couriers, as rules', 'سیٹنگز › کوریئرز میں، اصولوں کے طور پر'],
      ['In the theme editor', 'تھیم ایڈیٹر میں'],
    ),
    answer: 1,
  },
  {
    id: 'q-theme',
    prompt: {
      en: 'What is the safe way to make big changes to a live store’s look?',
      ur: 'لائیو اسٹور کی شکل میں بڑی تبدیلیاں کرنے کا محفوظ طریقہ کیا ہے؟',
    },
    options: options(
      ['Edit the live theme directly', 'لائیو تھیم کو سیدھا بدلیں'],
      [
        'Copy the theme, change and preview the copy, then publish it',
        'تھیم کی کاپی بنائیں، اسے بدل کر دیکھیں، پھر شائع کریں',
      ],
      ['Close the store first', 'پہلے اسٹور بند کریں'],
    ),
    answer: 1,
  },
  {
    id: 'q-urdu',
    prompt: {
      en: 'How does a shop get its products in Urdu?',
      ur: 'دکان اپنی مصنوعات اردو میں کیسے لاتی ہے؟',
    },
    options: options(
      [
        'AI drafts the translations under Urdu, and the shop checks them',
        'اے آئی اردو میں ترجمے کا مسودہ بناتا ہے اور دکان اسے دیکھتی ہے',
      ],
      ['It makes a second store', 'دوسرا اسٹور بنا کر'],
      ['Urdu is not possible', 'اردو ممکن نہیں'],
    ),
    answer: 0,
  },
  {
    id: 'q-transfer',
    prompt: {
      en: 'A customer pays by bank transfer. Who confirms it?',
      ur: 'گاہک بینک ٹرانسفر سے ادائیگی کرتا ہے۔ اس کی تصدیق کون کرتا ہے؟',
    },
    options: options(
      ['The courier', 'کوریئر'],
      [
        'The shop’s staff, from the receipt the customer sends',
        'دکان کا عملہ، گاہک کی بھیجی رسید سے',
      ],
      ['Nobody: it is assumed paid', 'کوئی نہیں: ادا شدہ مان لیا جاتا ہے'],
    ),
    answer: 1,
  },
  {
    id: 'q-two-step',
    prompt: {
      en: 'Who must use two-step verification?',
      ur: 'دو مرحلہ تصدیق کس کے لیے ضروری ہے؟',
    },
    options: options(
      ['Only packers', 'صرف پیکرز'],
      ['Owners, managers and accountants', 'مالکان، مینیجرز اور اکاؤنٹنٹس'],
      ['Nobody', 'کسی کے لیے نہیں'],
    ),
    answer: 1,
  },
  {
    id: 'q-handover',
    prompt: {
      en: 'How does a partner give a finished store to their client?',
      ur: 'پارٹنر تیار اسٹور اپنے کلائنٹ کو کیسے دیتا ہے؟',
    },
    options: options(
      ['Shares their own password', 'اپنا پاس ورڈ دے کر'],
      [
        'Invites the client as a manager, then hands the store over from Settings › Staff',
        'کلائنٹ کو مینیجر کے طور پر بلا کر، پھر سیٹنگز › عملہ سے اسٹور حوالے کر کے',
      ],
      ['Opens a new store in the client’s name', 'کلائنٹ کے نام پر نیا اسٹور کھول کر'],
    ),
    answer: 1,
  },
  {
    id: 'q-marketing',
    prompt: {
      en: 'Who may a shop send WhatsApp broadcasts to?',
      ur: 'دکان واٹس ایپ براڈکاسٹ کسے بھیج سکتی ہے؟',
    },
    options: options(
      ['Anyone whose number it has', 'جس کا بھی نمبر اس کے پاس ہو'],
      [
        'Customers who agreed, until they ask it to stop',
        'ان گاہکوں کو جو راضی ہوں، جب تک وہ بند کرنے کو نہ کہیں',
      ],
      ['Only new customers', 'صرف نئے گاہکوں کو'],
    ),
    answer: 1,
  },
];

/** Right answers needed to pass, of the ten. */
export const PASS_MARK = 8;
