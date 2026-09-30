import { parsePkMobile } from '@hatti/pk';
import { POLICY_TITLES, type PolicyLocale, type PolicyType } from './policy-types.js';

/** What a draft says of the shop, as it has set it. */
export interface PolicyFacts {
  shopName: string;
  /** Its storefront's address: https://www.zari.pk. */
  storefrontUrl: string;
  /** Its WhatsApp number, in E.164; null while it has none. */
  whatsapp: string | null;
  /** What delivery costs where no zone names, as shoppers read it: "Rs 250". */
  deliveryCharge: string;
  /** Whether that is nothing. */
  deliveryFree: boolean;
  /** From what subtotal delivery is free, as shoppers read it; null when it never is. */
  freeDeliveryFrom: string | null;
  /** Cities with a charge of their own. */
  zones: readonly { name: string; cities: readonly string[]; charge: string }[];
}

/**
 * A first draft of one of the shop's policies (ADR-056), in English or Urdu, filled in from what
 * the shop has set: its name, address, WhatsApp number and delivery charges. For the shop to read,
 * change and save; never saved by itself. It is not legal advice.
 */
export function policyDraft(
  type: PolicyType,
  locale: PolicyLocale,
  facts: PolicyFacts,
): { title: string; body: string } {
  const text = { shop: escape(facts.shopName), url: escape(facts.storefrontUrl) };
  const whatsapp = facts.whatsapp
    ? (parsePkMobile(facts.whatsapp)?.display ?? facts.whatsapp)
    : null;
  const drafts = locale === 'ur' ? URDU : ENGLISH;
  return {
    title: POLICY_TITLES[type][locale],
    // Written across lines here; one line of HTML, words apart and tags together.
    body: drafts[type]({ ...text, whatsapp: whatsapp && escape(whatsapp), facts })
      .replace(/\s*\n\s*/g, ' ')
      .replace(/>\s+</g, '><')
      .trim(),
  };
}

interface DraftText {
  shop: string;
  url: string;
  whatsapp: string | null;
  facts: PolicyFacts;
}

type Drafts = Readonly<Record<PolicyType, (text: DraftText) => string>>;

/** How shoppers reach the shop: its WhatsApp number, else its storefront. */
const contactEn = ({ whatsapp, url }: DraftText) =>
  whatsapp ? `WhatsApp us at ${whatsapp}` : `Contact us through our store at ${url}`;

const ENGLISH: Drafts = {
  refund_policy: (text) => `
    <p>We want you to be happy with what you buy from ${text.shop}. If something is not right,
    you can return it within 7 days of delivery.</p>
    <h2>What can be returned</h2>
    <ul>
    <li>Items unused and unwashed, with their tags and packaging.</li>
    <li>Items that arrived damaged, faulty or not as ordered: tell us within 48 hours of delivery,
    with a photo.</li>
    </ul>
    <p>Fabric that has been cut or stitched, and items on final sale, cannot be returned unless
    they arrived damaged or wrong.</p>
    <h2>How to return</h2>
    <p>${contactEn(text)} with your order number. We will tell you where to send the item, or
    have a courier collect it.</p>
    <h2>Refunds</h2>
    <p>Once we have the item and have checked it, we refund you within 7 working days: by bank
    transfer, Easypaisa or JazzCash for orders paid in cash on delivery, or to the card or account
    you paid with. Delivery charges are refunded only when the item arrived damaged or wrong.</p>
    <h2>Exchanges</h2>
    <p>We are glad to exchange an item for another size or colour while we have it in stock.</p>`,
  privacy_policy: (text) => `
    <p>This policy says what ${text.shop} collects about you when you shop at ${text.url}, and
    what we do with it.</p>
    <h2>What we collect</h2>
    <ul>
    <li>Your name, mobile number and delivery address, to deliver your order and confirm it with
    you.</li>
    <li>What you order, and whether you took delivery, to serve you better next time.</li>
    <li>How you use our store, such as the pages you visit, to keep it working and make it
    better.</li>
    </ul>
    <h2>How we use it</h2>
    <p>We use your details to take and deliver your orders, to call or message you about them,
    and, if you agree, to tell you about new products and offers. You can stop our messages at
    any time.</p>
    <h2>Who we share it with</h2>
    <p>We give your name, number and address to the courier that delivers your order, and to the
    companies that run our store for us. We do not sell your details.</p>
    <h2>Your choices</h2>
    <p>You can ask to see the details we keep about you, to correct them or to delete them:
    ${contactEn(text)}. We keep records of orders as the law requires.</p>`,
  terms_of_service: (text) => `
    <p>These terms apply when you shop at ${text.shop}, at ${text.url}. By placing an order, you
    agree to them.</p>
    <h2>Orders</h2>
    <p>Prices are in Pakistani rupees and include any taxes that apply. We may call or message you
    to confirm a cash-on-delivery order before we send it, and may cancel an order we cannot
    confirm.</p>
    <h2>Cash on delivery</h2>
    <p>Please pay the courier when your order arrives. If you refuse an order you confirmed, we
    may ask you to pay in advance next time.</p>
    <h2>Delivery and returns</h2>
    <p>Delivery times are estimates. Our shipping policy gives our charges and times, and our
    refund policy what can be returned.</p>
    <h2>Changes</h2>
    <p>We may change these terms from time to time. The terms on this page when you order are the
    ones that apply to it.</p>
    <h2>Law</h2>
    <p>These terms are governed by the laws of Pakistan.</p>
    <h2>Contact</h2>
    <p>${contactEn(text)}.</p>`,
  shipping_policy: (text) => `
    <p>We deliver across Pakistan.</p>
    <h2>Charges</h2>
    ${chargesEn(text.facts)}
    <h2>Delivery times</h2>
    <p>Once we confirm your order, it usually arrives within 2 to 4 working days in major cities,
    and within 4 to 7 working days elsewhere.</p>
    <h2>Cash on delivery</h2>
    <p>Pay the courier in cash when your order arrives. We send you your parcel's tracking number
    once it is on its way.</p>
    <h2>Questions</h2>
    <p>${contactEn(text)}.</p>`,
  contact_information: (text) => `
    <p>${text.shop}</p>
    <ul>
    ${text.whatsapp ? `<li>WhatsApp: ${text.whatsapp}</li>` : ''}
    <li>Online: <a href="${text.url}">${text.url}</a></li>
    </ul>`,
};

function chargesEn(facts: PolicyFacts): string {
  const zones = facts.zones.map(
    (zone) =>
      `<li>${escape(zone.name)} (${escape(zone.cities.join(', '))}): ${escape(zone.charge)}</li>`,
  );
  const everywhere = facts.deliveryFree ? 'free' : `${escape(facts.deliveryCharge)} an order`;
  const list =
    zones.length > 0
      ? `<ul>${zones.join('')}<li>Everywhere else: ${everywhere}</li></ul>`
      : `<p>Delivery is ${everywhere}.</p>`;
  const free = facts.freeDeliveryFrom
    ? `<p>Delivery is free on orders of ${escape(facts.freeDeliveryFrom)} or more.</p>`
    : '';
  return list + free;
}

/** Numbers and addresses left to right, in right-to-left text. */
const ltr = (text: string) => `<span dir="ltr">${text}</span>`;

const contactUr = ({ whatsapp, url }: DraftText) =>
  whatsapp ? `ہمیں ${ltr(whatsapp)} پر واٹس ایپ کریں` : `ہم سے ${ltr(url)} پر رابطہ کریں`;

const URDU: Drafts = {
  refund_policy: (text) => `
    <p>ہم چاہتے ہیں کہ آپ ${text.shop} سے خریداری کر کے خوش ہوں۔ اگر کوئی چیز ٹھیک نہ ہو تو آپ
    اسے ڈیلیوری کے 7 دن کے اندر واپس کر سکتے ہیں۔</p>
    <h2>کیا واپس ہو سکتا ہے</h2>
    <ul>
    <li>ایسی اشیاء جو استعمال یا دھلی نہ ہوں، اپنے ٹیگ اور پیکنگ کے ساتھ۔</li>
    <li>ایسی اشیاء جو خراب، ٹوٹی ہوئی یا آرڈر سے مختلف پہنچیں: ڈیلیوری کے 48 گھنٹے کے اندر تصویر
    کے ساتھ ہمیں بتائیں۔</li>
    </ul>
    <p>کٹا یا سلا ہوا کپڑا اور فائنل سیل کی اشیاء واپس نہیں ہو سکتیں، سوائے اس کے کہ وہ خراب یا غلط
    پہنچیں۔</p>
    <h2>واپسی کیسے کریں</h2>
    <p>اپنے آرڈر نمبر کے ساتھ ${contactUr(text)}۔ ہم آپ کو بتائیں گے کہ چیز کہاں بھیجنی ہے، یا
    کوریئر سے منگوا لیں گے۔</p>
    <h2>رقم کی واپسی</h2>
    <p>چیز ملنے اور جانچنے کے بعد ہم 7 کاروباری دنوں میں رقم واپس کر دیتے ہیں: کیش آن ڈیلیوری
    آرڈرز کی بینک ٹرانسفر، ایزی پیسہ یا جیز کیش سے، ورنہ اسی کارڈ یا اکاؤنٹ میں جس سے ادائیگی
    ہوئی۔ ڈیلیوری چارجز صرف اس صورت میں واپس ہوتے ہیں جب چیز خراب یا غلط پہنچی ہو۔</p>
    <h2>تبادلہ</h2>
    <p>اسٹاک میں ہو تو ہم خوشی سے کسی دوسرے سائز یا رنگ سے تبادلہ کر دیتے ہیں۔</p>`,
  privacy_policy: (text) => `
    <p>یہ پالیسی بتاتی ہے کہ جب آپ ${ltr(text.url)} پر خریداری کرتے ہیں تو ${text.shop} آپ کے بارے
    میں کیا معلومات جمع کرتا ہے اور ان کا کیا کرتا ہے۔</p>
    <h2>ہم کیا جمع کرتے ہیں</h2>
    <ul>
    <li>آپ کا نام، موبائل نمبر اور ڈیلیوری کا پتہ، تاکہ آپ کا آرڈر پہنچا سکیں اور آپ سے اس کی
    تصدیق کر سکیں۔</li>
    <li>آپ نے کیا آرڈر کیا اور کیا ڈیلیوری وصول کی، تاکہ اگلی بار بہتر خدمت کر سکیں۔</li>
    <li>آپ ہماری دکان کیسے استعمال کرتے ہیں، جیسے کون سے صفحات دیکھتے ہیں، تاکہ اسے چلتا رکھیں
    اور بہتر بنائیں۔</li>
    </ul>
    <h2>ہم انہیں کیسے استعمال کرتے ہیں</h2>
    <p>ہم آپ کی معلومات آپ کے آرڈر لینے اور پہنچانے، ان کے بارے میں آپ کو کال یا پیغام کرنے، اور
    آپ کی رضامندی سے نئی مصنوعات اور آفرز کی خبر دینے کے لیے استعمال کرتے ہیں۔ آپ کسی بھی وقت
    ہمارے پیغامات بند کروا سکتے ہیں۔</p>
    <h2>ہم کس سے شیئر کرتے ہیں</h2>
    <p>ہم آپ کا نام، نمبر اور پتہ اس کوریئر کو دیتے ہیں جو آپ کا آرڈر پہنچاتا ہے، اور ان کمپنیوں
    کو جو ہماری دکان چلانے میں ہماری مدد کرتی ہیں۔ ہم آپ کی معلومات فروخت نہیں کرتے۔</p>
    <h2>آپ کے اختیارات</h2>
    <p>آپ اپنی معلومات دیکھنے، درست کرنے یا مٹانے کی درخواست کر سکتے ہیں: ${contactUr(text)}۔
    ہم آرڈرز کا ریکارڈ قانون کے مطابق رکھتے ہیں۔</p>`,
  terms_of_service: (text) => `
    <p>یہ شرائط ${ltr(text.url)} پر ${text.shop} سے خریداری پر لاگو ہوتی ہیں۔ آرڈر دے کر آپ ان سے
    اتفاق کرتے ہیں۔</p>
    <h2>آرڈرز</h2>
    <p>قیمتیں پاکستانی روپے میں ہیں اور ان میں قابلِ اطلاق ٹیکس شامل ہیں۔ کیش آن ڈیلیوری آرڈر
    بھیجنے سے پہلے ہم تصدیق کے لیے آپ کو کال یا پیغام کر سکتے ہیں، اور جس آرڈر کی تصدیق نہ ہو
    سکے اسے منسوخ کر سکتے ہیں۔</p>
    <h2>کیش آن ڈیلیوری</h2>
    <p>آرڈر پہنچنے پر کوریئر کو ادائیگی کریں۔ اگر آپ تصدیق شدہ آرڈر وصول کرنے سے انکار کریں تو
    اگلی بار ہم پیشگی ادائیگی کا کہہ سکتے ہیں۔</p>
    <h2>ڈیلیوری اور واپسی</h2>
    <p>ڈیلیوری کے اوقات اندازاً ہیں۔ ہماری ترسیل کی پالیسی چارجز اور اوقات بتاتی ہے، اور واپسی کی
    پالیسی بتاتی ہے کہ کیا واپس ہو سکتا ہے۔</p>
    <h2>تبدیلیاں</h2>
    <p>ہم وقتاً فوقتاً یہ شرائط بدل سکتے ہیں۔ آرڈر کے وقت اس صفحے پر موجود شرائط ہی اس پر لاگو
    ہوں گی۔</p>
    <h2>قانون</h2>
    <p>یہ شرائط پاکستان کے قوانین کے تابع ہیں۔</p>
    <h2>رابطہ</h2>
    <p>${contactUr(text)}۔</p>`,
  shipping_policy: (text) => `
    <p>ہم پورے پاکستان میں ڈیلیوری کرتے ہیں۔</p>
    <h2>چارجز</h2>
    ${chargesUr(text.facts)}
    <h2>ڈیلیوری کا وقت</h2>
    <p>تصدیق کے بعد آرڈرز عام طور پر بڑے شہروں میں 2 سے 4 کاروباری دنوں اور دوسرے علاقوں میں 4
    سے 7 کاروباری دنوں میں پہنچ جاتے ہیں۔</p>
    <h2>کیش آن ڈیلیوری</h2>
    <p>آرڈر پہنچنے پر کوریئر کو نقد ادائیگی کریں۔ پارسل روانہ ہوتے ہی ہم آپ کو اس کا ٹریکنگ نمبر
    بھیج دیتے ہیں۔</p>
    <h2>سوالات</h2>
    <p>${contactUr(text)}۔</p>`,
  contact_information: (text) => `
    <p>${text.shop}</p>
    <ul>
    ${text.whatsapp ? `<li>واٹس ایپ: ${ltr(text.whatsapp)}</li>` : ''}
    <li>آن لائن: <a href="${text.url}">${ltr(text.url)}</a></li>
    </ul>`,
};

function chargesUr(facts: PolicyFacts): string {
  const zones = facts.zones.map(
    (zone) =>
      `<li>${escape(zone.name)} (${escape(zone.cities.join('، '))}): ${ltr(escape(zone.charge))}</li>`,
  );
  const everywhere = facts.deliveryFree ? 'مفت' : `فی آرڈر ${ltr(escape(facts.deliveryCharge))}`;
  const list =
    zones.length > 0
      ? `<ul>${zones.join('')}<li>باقی تمام جگہوں پر: ${everywhere}</li></ul>`
      : `<p>ڈیلیوری ${everywhere} ہے۔</p>`;
  const free = facts.freeDeliveryFrom
    ? `<p>${ltr(escape(facts.freeDeliveryFrom))} یا اس سے زیادہ کے آرڈرز پر ڈیلیوری مفت ہے۔</p>`
    : '';
  return list + free;
}

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
