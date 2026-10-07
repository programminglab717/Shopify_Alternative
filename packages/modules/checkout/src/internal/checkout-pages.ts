import type { FieldError } from '@hatti/api';
import type { MarketingChannelValue } from '@hatti/customers/public';
import {
  html,
  ltr,
  renderPage,
  say,
  text,
  type Html,
  type HtmlValue,
  type RenderedPage,
  type Words,
} from '@hatti/documents';
import { formatMoney, money } from '@hatti/money';
import { POLICY_TITLES, policyHandle, type PolicyType } from '@hatti/online-store/public';
import {
  COD_CASH_LIMIT,
  cashPastLimitOf,
  gatewayForm,
  gatewayNames,
  gatewayOrigins,
  onlinePaidNotice,
  onlinePaymentProblemWords,
  orderName,
  payOnlineForm,
  prepaidDiscountOf,
  taxByRate,
  transferDetails,
  transferWords,
  type OrderRecord,
} from '@hatti/orders/public';
import {
  PK_CITIES,
  PK_PROVINCES,
  areaSuggestions,
  findCity,
  maskPkMobile,
  type PkProvinceCode,
} from '@hatti/pk';
import type { DiscountCodeRecord, DiscountRefusal } from '@hatti/pricing/public';
import type { CartJson } from '@hatti/storefront-api';
import { orderTaxOf, taxIncludedWords, taxesByRate, type TaxRates } from '@hatti/tax/public';
import {
  advanceAmountOf,
  advanceOf,
  type CodAdvanceValue,
  type CodRefusal,
  type CodRulesRecord,
} from './cod-rules.js';
import type { TrustBadgeValue } from './trust-badges.js';
import {
  itemName,
  shownProperties,
  type CheckoutDiscount,
  type CheckoutForm,
  type CheckoutPayments,
  type CheckoutProblem,
  type CheckoutShop,
  type CheckoutView,
  type ClosedLinkReason,
} from './checkout.service.js';
import { deliveryDays, type DeliveryDays, type DeliverySettingsRecord } from './delivery.js';
import { MARKETING_FIELDS, marketingTicked, marketingWords } from './marketing.js';
import { checkoutTotals } from './totals.js';

/** A checkout's page and its HTTP status. */
export interface CheckoutPage extends RenderedPage {
  status: number;
}

const LABELS = {
  title: { en: 'Checkout', ur: 'چیک آؤٹ' },
  yourOrder: { en: 'Your order', ur: 'آپ کا آرڈر' },
  subtotal: { en: 'Subtotal', ur: 'ذیلی کل' },
  discount: { en: 'Discount', ur: 'رعایت' },
  transferDiscount: { en: 'Bank transfer discount', ur: 'بینک ٹرانسفر پر رعایت' },
  onlineDiscount: { en: 'Online payment discount', ur: 'آن لائن ادائیگی پر رعایت' },
  discountCode: { en: 'Discount code', ur: 'ڈسکاؤنٹ کوڈ' },
  apply: { en: 'Apply', ur: 'لاگو کریں' },
  remove: { en: 'Remove', ur: 'ہٹائیں' },
  delivery: { en: 'Delivery', ur: 'ڈیلیوری' },
  free: { en: 'Free', ur: 'مفت' },
  byCity: { en: 'By city', ur: 'شہر کے مطابق' },
  total: { en: 'Total', ur: 'کل رقم' },
  payOnDelivery: { en: 'Pay on delivery', ur: 'ڈیلیوری پر ادائیگی' },
  codFee: { en: 'Cash on delivery fee', ur: 'کیش آن ڈیلیوری فیس' },
  advanceByTransfer: { en: 'Advance by bank transfer', ur: 'ایڈوانس بینک ٹرانسفر سے' },
  deliverTo: { en: 'Deliver to', ur: 'ترسیل کا پتہ' },
  payment: { en: 'Payment', ur: 'ادائیگی' },
  note: { en: 'Your note', ur: 'آپ کا نوٹ' },
  name: { en: 'Name', ur: 'نام' },
  mobile: { en: 'Mobile number', ur: 'موبائل نمبر' },
  email: { en: 'Email (optional)', ur: 'ای میل (اختیاری)' },
  city: { en: 'City', ur: 'شہر' },
  address1: { en: 'House and street', ur: 'مکان اور گلی' },
  address2: { en: 'Area (optional)', ur: 'علاقہ (اختیاری)' },
  landmark: { en: 'Nearest landmark (optional)', ur: 'قریبی نشانی (اختیاری)' },
  province: { en: 'Province', ur: 'صوبہ' },
  fromCity: { en: 'From the city', ur: 'شہر کے مطابق' },
  placeOrder: { en: 'Place order', ur: 'آرڈر دیں' },
  code: { en: 'Code', ur: 'کوڈ' },
  codeBySms: { en: 'Send the code by SMS instead', ur: 'کوڈ ایس ایم ایس سے بھیجیں' },
  codeOnWhatsapp: { en: 'Send a new code on WhatsApp', ur: 'واٹس ایپ پر نیا کوڈ بھیجیں' },
  storeCredit: { en: 'Store credit', ur: 'اسٹور کریڈٹ' },
  backToCart: { en: 'Back to cart', ur: 'واپس کارٹ پر' },
  continueShopping: { en: 'Continue shopping', ur: 'خریداری جاری رکھیں' },
  placedTitle: { en: 'Thank you!', ur: 'شکریہ!' },
  emptyTitle: { en: 'Your cart is empty', ur: 'آپ کا کارٹ خالی ہے' },
  expiredTitle: { en: 'This checkout has expired', ur: 'اس چیک آؤٹ کی مدت ختم ہو گئی ہے' },
  notFoundTitle: { en: "This checkout doesn't exist", ur: 'یہ چیک آؤٹ موجود نہیں' },
} satisfies Record<string, Words>;

/**
 * A sentence in English and in Urdu, which may hold markup: numbers and amounts in an Urdu
 * sentence go in ltr(), or the right-to-left text around them reorders their parts.
 */
interface Sentence {
  en: HtmlValue;
  ur: HtmlValue;
}

/** What the page says of a payment link that opens no checkout (ADR-248), and with what status. */
const CLOSED_LINK_WORDS = {
  not_found: {
    status: 404,
    title: { en: "This link doesn't exist", ur: 'یہ لنک موجود نہیں' },
    next: {
      en: 'Check the link you were sent, or order from the online store.',
      ur: 'آپ کو بھیجا گیا لنک دیکھیں، یا آن لائن اسٹور سے آرڈر کریں۔',
    },
  },
  closed: {
    status: 410,
    title: { en: 'This link no longer takes orders', ur: 'یہ لنک اب آرڈر نہیں لیتا' },
    next: {
      en: 'Ask the shop for a new link, or order from its online store.',
      ur: 'دکان سے نیا لنک مانگیں، یا اس کے آن لائن اسٹور سے آرڈر کریں۔',
    },
  },
  sold_out: {
    status: 200,
    title: { en: 'This is sold out for now', ur: 'یہ ابھی دستیاب نہیں' },
    next: {
      en: 'Ask the shop when it will be back, or see what else it has.',
      ur: 'دکان سے پوچھیں کہ یہ دوبارہ کب آئے گا، یا اس کی دوسری چیزیں دیکھیں۔',
    },
  },
} satisfies Record<ClosedLinkReason, { status: number; title: Words; next: Sentence }>;

/**
 * The page a checkout shows (ADR-044): the cart to order, with the form for who receives it and
 * where; once placed, the order; or why there is nothing to show. In English and Urdu, as
 * customers' links' pages are, and without scripts: it works on any phone.
 */
export function checkoutPage(view: CheckoutView): CheckoutPage {
  switch (view.kind) {
    case 'not_found':
      return page(404, LABELS.notFoundTitle.en, null, [
        heading(LABELS.notFoundTitle),
        paragraphs(
          {
            en: 'Go back to the shop and check out from your cart again.',
            ur: 'دکان پر واپس جا کر اپنے کارٹ سے دوبارہ چیک آؤٹ کریں۔',
          },
          'center muted',
        ),
      ]);
    case 'expired':
      return page(410, `${LABELS.expiredTitle.en} · ${view.shop.name}`, view.shop, [
        shopName(view.shop),
        heading(LABELS.expiredTitle),
        paragraphs(
          {
            en: 'Check out from your cart again: it has what you chose.',
            ur: 'اپنے کارٹ سے دوبارہ چیک آؤٹ کریں: آپ کی چنی ہوئی چیزیں اس میں موجود ہیں۔',
          },
          'center muted',
        ),
        link(`${view.shop.storefront}/cart`, LABELS.backToCart),
      ]);
    case 'closed': {
      const words = CLOSED_LINK_WORDS[view.reason];
      return page(words.status, `${words.title.en} · ${view.shop.name}`, view.shop, [
        shopName(view.shop),
        heading(words.title),
        paragraphs(words.next, 'center muted'),
        link(view.shop.storefront, LABELS.continueShopping),
      ]);
    }
    case 'empty':
      return page(200, `${LABELS.emptyTitle.en} · ${view.shop.name}`, view.shop, [
        shopName(view.shop),
        heading(LABELS.emptyTitle),
        link(view.shop.storefront, LABELS.continueShopping),
      ]);
    case 'open':
      return openPage(view);
    case 'placed':
      return placedPage(view);
  }
}

/** The cart to order, what it comes to, and who receives it where; with what stopped it. */
function openPage(view: Extract<CheckoutView, { kind: 'open' }>): CheckoutPage {
  const { shop, cart, delivery, discount, payments, form, problem } = view;
  const { codRules } = payments;
  const errors = problem?.kind === 'address' ? problem.errors : [];
  const status =
    problem?.kind === 'address' || problem?.kind === 'discount'
      ? 422
      : problem?.kind === 'too_many'
        ? 429
        : problem?.kind === 'code'
          ? { sent: 200, wrong: 422, expired: 422, too_many: 429 }[problem.state]
          : problem
            ? 409
            : 200;
  // The code sent to the number, where the shop asks for one (CHK-09): its box above the button,
  // and other codes asked for below it, so pressing Enter in the box places the order.
  const asked = problem?.kind === 'code' && problem.state !== 'too_many' ? problem : null;
  const agreement = agreementWords(shop);
  // No way to pay can take this cart: there is nothing to fill in, only the cart to change.
  const ways = { transfer: payments.bankTransfer !== null, online: payments.online !== null };
  const orderable =
    problem?.kind !== 'cod_limit' && (payments.codRefusal === null || ways.transfer || ways.online);
  // Paid at the door, unless the shopper may choose otherwise; by transfer, where it alone may.
  const onDelivery = orderable && !ways.transfer && !ways.online;
  const codOffered = orderable && payments.codRefusal === null;
  const byTransfer = orderable && ways.transfer && !ways.online && payments.codRefusal !== null;
  const onlineAlone = orderable && ways.online && !ways.transfer && payments.codRefusal !== null;
  const code = discount?.record ?? null;
  const totals = checkoutTotals(BigInt(cart.subtotal), delivery, form.city, code);
  // What paying by transfer takes off the items, after the code (ADR-077), and paying online
  // (ADR-222).
  const transferOff = payments.bankTransfer
    ? prepaidDiscountOf(payments.transferDiscount, totals.subtotal - totals.discount, 'PKR')
    : 0n;
  const onlineOff = payments.online
    ? prepaidDiscountOf(payments.onlineDiscount, totals.subtotal - totals.discount, 'PKR')
    : 0n;
  // What paying on delivery asks for in advance (ADR-084), as the page says it whatever its
  // cities and customers; and what it asks of this order, unknown while the city isn't typed,
  // where it is the delivery charge or the shop names cities, or while the shop asks it of
  // customers who refused parcels or are new to it, whom the page doesn't look up (ADR-089),
  // or by the order's risk, scored as it is placed (ADR-094).
  const order = {
    items: totals.subtotal - totals.discount,
    delivery: totals.freeDelivery ? 0n : totals.delivery,
  };
  const askedAhead = advanceAmountOf(payments.advance, order, 'PKR');
  const advance = advanceOf(payments.advance, { ...order, city: form.city }, 'PKR');
  // What the order comes to past the law's cap, which cash on delivery asks in advance where the
  // order may pass it (ADR-188): null while its total isn't known.
  const pastLimit = !payments.capAdvance
    ? 0n
    : totals.total === null
      ? null
      : cashPastLimitOf({ currency: 'PKR', total: totals.total + codRules.fee });
  return page(status, `${LABELS.title.en} · ${shop.name}`, shop, [
    shopName(shop),
    heading(LABELS.title),
    // A code's problem is said by its field.
    problem && problem.kind !== 'discount' && banner(problemWords(problem, ways)),
    cartSummary(
      cart,
      delivery,
      form.city,
      code,
      {
        onDelivery,
        fee: onDelivery ? codRules.fee : 0n,
        // What the one way to pay takes off, where it is the only one.
        off: byTransfer ? transferOff : onlineAlone ? onlineOff : 0n,
        offWay: onlineAlone ? 'online' : 'transfer',
        // The shop's advance or the law's, whichever is more.
        advance: onDelivery
          ? (advance ?? 0n) > (pastLimit ?? 0n)
            ? (advance ?? 0n)
            : (pastLimit ?? 0n)
          : 0n,
      },
      view.tax,
    ),
    discountSection(discount, problem?.kind === 'discount' ? problem : null),
    orderable &&
      html`<form method="post">
        <input type="hidden" name="shown" value="${view.shown}" />
        ${field('name', LABELS.name, form, errors, { autocomplete: 'name', required: true })}
        ${field('phone', LABELS.mobile, form, errors, {
          autocomplete: 'tel',
          required: true,
          kind: 'tel',
          hint: {
            en: 'The shop and the courier call this number.',
            ur: 'دکان اور کوریئر اس نمبر پر کال کریں گے۔',
          },
        })}
        ${field('email', LABELS.email, form, errors, {
          autocomplete: 'email',
          kind: 'email',
          hint: {
            en: "Your order's news comes here too.",
            ur: 'آپ کے آرڈر کی اطلاعات یہاں بھی آئیں گی۔',
          },
        })}
        ${marketingChoices(shop.name, view.marketing, form.marketing)}
        ${field('city', LABELS.city, form, errors, {
          autocomplete: 'address-level2',
          required: true,
          list: 'cities',
        })}
        <datalist id="cities">
          ${PK_CITIES.map((city) => html`<option value="${city.name}"></option>`)}
        </datalist>
        ${field('address1', LABELS.address1, form, errors, {
          autocomplete: 'address-line1',
          required: true,
        })}
        ${field('address2', LABELS.address2, form, errors, {
          autocomplete: 'address-line2',
          list: 'areas',
        })}
        ${areaList(form.city)}
        ${field('landmark', LABELS.landmark, form, errors, {
          autocomplete: 'address-line3',
          hint: {
            en: 'A mosque, school or shop near you that the rider can ask for.',
            ur: 'آپ کے قریب کوئی مسجد، اسکول یا دکان جس کا رائیڈر پوچھ سکے۔',
          },
        })}
        ${provinceField(form.province, errors)}
        ${paymentSection(shop, payments, form.payment, { transferOff, onlineOff }, askedAhead, pastLimit)}
        ${view.storeCredit && storeCreditChoice(form.storeCredit === '1')} ${asked && codeField()}
        ${agreement && paragraphs(agreement, 'small muted')}
        <button class="button stack" type="submit">${say('bilingual', LABELS.placeOrder)}</button>
        ${asked && codeAgain(asked.channel)}
      </form>`,
    orderable && badgeList(shop, codOffered),
    link(`${shop.storefront}/cart`, LABELS.backToCart),
    policyLinks(shop),
  ]);
}

/**
 * A box for each channel the shop offers its news and offers on (ADR-187), unticked until the
 * shopper ticks it: placing the order records their consent on it, in these words.
 */
function marketingChoices(
  shopName: string,
  offered: readonly MarketingChannelValue[],
  marketing: string | undefined,
): Html[] {
  const ticked = marketingTicked(marketing, offered);
  return offered.map((channel) => {
    const words = marketingWords(shopName, channel);
    return html`<label class="choice">
      <input
        type="checkbox"
        name="${MARKETING_FIELDS[channel]}"
        value="1"
        ${ticked.includes(channel) && html`checked`}
      />
      <span><span lang="en">${words.en}</span><span lang="ur" dir="rtl">${words.ur}</span></span>
    </label>`;
  });
}

/**
 * Paying with the store credit the shopper's number has (ADR-186): theirs once they prove the
 * number with a code, which the page asks for as it places the order.
 */
function storeCreditChoice(checked: boolean): Html {
  return html`<label class="choice">
    <input type="checkbox" name="storeCredit" value="1" ${checked && html`checked`} />
    <span
      ><span lang="en"
        >Pay with my store credit. We send a code to your number to check it is yours.</span
      ><span lang="ur" dir="rtl"
        >میرے اسٹور کریڈٹ سے ادائیگی کریں۔ نمبر آپ کا ہونے کی تصدیق کے لیے ہم اس پر کوڈ بھیجیں
        گے۔</span
      ></span
    >
  </label>`;
}

/**
 * How the page offers to pay: on delivery, by bank transfer, or a choice of the two, on delivery
 * unless the shopper chose otherwise; with what the shop's rules keep cash on delivery to, its fee
 * for it, what it asks for in advance (`asked`, null while it is a delivery charge not known yet)
 * and where and of whom it asks it, and what paying by transfer or online takes off. A
 * transfer's account is shown once the order is placed, with the order's number to give as its
 * reference.
 */
function paymentSection(
  shop: CheckoutShop,
  payments: CheckoutPayments,
  chosen: string,
  { transferOff, onlineOff }: { transferOff: bigint; onlineOff: bigint },
  asked: bigint | null,
  pastLimit: bigint | null,
): Html {
  const { codRefusal, codRules, bankTransfer, online } = payments;
  const terms = codTermsWords(codRules);
  // The law's cap, where the order may pass it (ADR-188).
  const law = pastLimit === 0n ? null : lawAdvanceWords(pastLimit, payments.advance !== null);
  const fee = codRules.fee > 0n ? amount(codRules.fee) : null;
  // Beside another way to pay, the fee is said with the option; alone, the summary adds it.
  const withFee = fee !== null && (bankTransfer !== null || online !== null);
  const ahead = advanceWords(payments.advance, asked);
  const askedOf =
    ahead && payments.advance && advanceTermsWords(payments.advance, payments.advanceProduct);
  const onDelivery: Sentence = askedOf
    ? {
        en:
          `Cash on delivery: you pay when your order arrives${withFee ? `, with a ${fee} fee` : ''}. ` +
          `${askedOf.en}, you pay ${ahead.en} in advance by bank transfer.`,
        ur: html`ڈیلیوری پر نقد ادائیگی: آرڈر ملنے پر رقم ادا
        کریں${withFee && html`، ${ltr(fee)} فیس کے ساتھ`}۔ ${askedOf.ur}، ${ahead.ur} ایڈوانس بینک
        ٹرانسفر سے ادا کریں۔`,
      }
    : ahead
      ? {
          en:
            `Cash on delivery: you pay ${ahead.en} in advance by bank transfer, and the rest when ` +
            `your order arrives${withFee ? `, with a ${fee} fee` : ''}.`,
          ur: html`ڈیلیوری پر نقد ادائیگی: ${ahead.ur} ایڈوانس بینک ٹرانسفر سے ادا کریں، اور باقی
          رقم آرڈر ملنے پر${withFee && html`، ${ltr(fee)} فیس کے ساتھ`}۔`,
        }
      : withFee
        ? {
            en: `Cash on delivery: you pay when your order arrives, with a ${fee} fee.`,
            ur: html`ڈیلیوری پر نقد ادائیگی: آرڈر ملنے پر رقم ادا کریں، ${ltr(fee)} فیس کے ساتھ۔`,
          }
        : {
            en: 'Cash on delivery: you pay when your order arrives.',
            ur: 'ڈیلیوری پر نقد ادائیگی: آرڈر ملنے پر رقم ادا کریں۔',
          };
  if (!bankTransfer && !online) {
    return html`<section class="section">
      <h2 class="label">${say('bilingual', LABELS.payment)}</h2>
      ${paragraphs(onDelivery, '')} ${law && paragraphs(law, 'small muted')}
      ${terms && paragraphs(terms, 'small muted')}
    </section>`;
  }
  const off = transferOff > 0n ? amount(transferOff) : null;
  const byTransfer: Sentence | null = bankTransfer && {
    en:
      `Bank transfer${off ? `, ${off} off` : ''}: once your order is placed, you see ` +
      `${shop.name}'s account at ${bankTransfer.bankName}, and they send your order when the ` +
      'money is in.',
    ur: html`بینک ٹرانسفر${off && html`، ${ltr(off)} کی رعایت`}: آرڈر دینے کے بعد آپ کو
    ${text(bankTransfer.bankName)} میں دکان کا اکاؤنٹ نظر آئے گا، اور رقم ملتے ہی آرڈر بھیج دیا جائے
    گا۔`,
  };
  // Paying online (ADR-152): once the order is placed, through the shop's gateway the shopper
  // chooses then (ADR-219), with what the shop takes off for it (ADR-222).
  const names = online && gatewayNames(online);
  const offOnline = onlineOff > 0n ? amount(onlineOff) : null;
  const byGateway: Sentence | null = names && {
    en:
      `Pay online, by card or wallet${offOnline ? `, ${offOnline} off` : ''}: once your order ` +
      `is placed, you pay through ${names.en}, and ${shop.name} sends your order when the ` +
      'payment is in.',
    ur: html`آن لائن ادائیگی، کارڈ یا والیٹ سے${offOnline && html`، ${ltr(offOnline)} کی رعایت`}:
    آرڈر دینے کے بعد آپ ${names.ur} کے ذریعے ادائیگی کریں گے، اور ادائیگی ملتے ہی آرڈر بھیج دیا جائے
    گا۔`,
  };
  const choice = (value: string, sentence: Sentence, checked: boolean) =>
    html`<label class="choice">
      <input type="radio" name="payment" value="${value}" ${checked && html`checked`} />
      <span
        ><span lang="en">${sentence.en}</span><span lang="ur" dir="rtl">${sentence.ur}</span></span
      >
    </label>`;
  if (codRefusal) {
    const limit = amount(COD_CASH_LIMIT);
    const why = paragraphs(
      codRefusal.reason === 'law'
        ? {
            en: `By law, cash on delivery can't collect more than ${limit} an order.`,
            ur: html`قانون کے مطابق ڈیلیوری پر نقد ادائیگی ایک آرڈر پر ${ltr(limit)} سے زیادہ نہیں
            ہو سکتی۔`,
          }
        : codLimitWords(codRefusal, { transfer: byTransfer !== null, online: byGateway !== null }),
      'small muted',
    );
    // Both ways to pay before: a choice of the two, by transfer unless the shopper chose otherwise.
    if (byTransfer && byGateway) {
      const viaGateway = chosen === 'online';
      return html`<section class="section" role="radiogroup" aria-labelledby="payment">
        <h2 class="label" id="payment">${say('bilingual', LABELS.payment)}</h2>
        ${choice('bank_transfer', byTransfer, !viaGateway)}
        ${choice('online', byGateway, viaGateway)} ${why}
      </section>`;
    }
    return html`<section class="section">
      <h2 class="label">${say('bilingual', LABELS.payment)}</h2>
      <input type="hidden" name="payment" value="${byTransfer ? 'bank_transfer' : 'online'}" />
      ${paragraphs((byTransfer ?? byGateway)!, '')} ${why}
    </section>`;
  }
  const picked =
    chosen === 'bank_transfer' && byTransfer
      ? 'bank_transfer'
      : chosen === 'online' && byGateway
        ? 'online'
        : 'cash_on_delivery';
  // The law's cap, then the shop's terms, after what the option says.
  const after = [law, terms].filter((part) => part !== null);
  const cash =
    after.length === 0
      ? onDelivery
      : {
          en: html`${onDelivery.en}${after.map((part) => html` ${part.en}`)}`,
          ur: html`${onDelivery.ur}${after.map((part) => html` ${part.ur}`)}`,
        };
  return html`<section class="section" role="radiogroup" aria-labelledby="payment">
    <h2 class="label" id="payment">${say('bilingual', LABELS.payment)}</h2>
    ${choice('cash_on_delivery', cash, picked === 'cash_on_delivery')}
    ${byTransfer && choice('bank_transfer', byTransfer, picked === 'bank_transfer')}
    ${byGateway && choice('online', byGateway, picked === 'online')}
  </section>`;
}

/**
 * What the law's cap asks of an order paid on delivery (ADR-188): what it comes to past the cap,
 * `past`, in advance; at least that, where the shop asks an advance of its own, which may be
 * more. Said of any order while its total isn't known (null).
 */
function lawAdvanceWords(past: bigint | null, ownAdvance: boolean): Sentence {
  const limit = amount(COD_CASH_LIMIT);
  if (past === null) {
    return {
      en:
        `By law, cash on delivery collects at most ${limit} an order: what an order comes to ` +
        'past that, you pay in advance by bank transfer.',
      ur: html`قانون کے مطابق ڈیلیوری پر نقد ادائیگی ایک آرڈر پر ${ltr(limit)} سے زیادہ نہیں ہو
      سکتی: اس سے زائد رقم ایڈوانس بینک ٹرانسفر سے ادا کریں۔`,
    };
  }
  const rs = amount(past);
  return {
    en:
      `By law, cash on delivery collects at most ${limit} an order, so you pay ` +
      `${ownAdvance ? 'at least ' : ''}${rs} of this one in advance by bank transfer.`,
    ur: html`قانون کے مطابق ڈیلیوری پر نقد ادائیگی ایک آرڈر پر ${ltr(limit)} سے زیادہ نہیں ہو سکتی،
    اس لیے اس آرڈر کے ${ownAdvance && 'کم از کم '}${ltr(rs)} ایڈوانس بینک ٹرانسفر سے ادا کریں۔`,
  };
}

/**
 * What cash on delivery asks for `advance`, as the page says it beside the option (ADR-084): its
 * amount, or the delivery charge; null for nothing.
 */
function advanceWords(
  rule: CodAdvanceValue | null,
  advance: bigint | null,
): { en: string; ur: HtmlValue } | null {
  if (!rule || advance === 0n) return null;
  if (rule.kind === 'delivery') return { en: 'the delivery charge', ur: 'ڈیلیوری چارجز' };
  const rs = amount(advance ?? 0n);
  return { en: rs, ur: ltr(rs) };
}

/**
 * For what, where, and of whom, the shop asks its advance (ADR-089, ADR-094, ADR-224), as the page
 * says it before anything is typed: "With Bridal lehenga in your cart, on orders to Quetta or
 * Gilgit, if you refused a delivery from this shop before". The cart's `product` it is asked for,
 * where it asks it for products it tags; every city it names, so that a shopper knows whether it
 * asks them; of customers and by risk, its rule alone, the page looking nobody up. Null when it
 * asks every order.
 */
function advanceTermsWords(
  advance: CodAdvanceValue,
  product: string | null,
): { en: string; ur: HtmlValue } | null {
  const { cities, refusedDeliveries: refused, newCustomers, riskScore } = advance;
  const every = cities.length === 0 && refused === null && !newCustomers && riskScore === null;
  if (product === null && every) return null;
  const what =
    product === null
      ? null
      : { en: `with ${product} in your cart`, ur: html`آپ کے کارٹ میں ${text(product)} ہونے پر` };
  const urNames = cities.map((name) => findCity(name)?.nameUr ?? name);
  const where =
    cities.length === 0
      ? null
      : {
          en: `on orders to ${cities.length > 1 ? `${cities.slice(0, -1).join(', ')} or ` : ''}${cities.at(-1)}`,
          ur: `${urNames.length > 1 ? `${urNames.slice(0, -1).join('، ')} یا ` : ''}${urNames.at(-1)} کے آرڈرز پر`,
        };
  const who =
    refused === null
      ? null
      : refused === 1
        ? {
            en: 'if you refused a delivery from this shop before',
            ur: html`اگر آپ پہلے اس دکان کی کوئی ڈیلیوری لینے سے انکار کر چکے ہیں`,
          }
        : {
            en: `if you refused ${refused} deliveries or more from this shop before`,
            ur: html`اگر آپ پہلے اس دکان کی ${ltr(String(refused))} یا زیادہ ڈیلیوریز لینے سے انکار
            کر چکے ہیں`,
          };
  const fresh = newCustomers
    ? {
        en: 'if no order from this shop has reached you before',
        ur: html`اگر اس دکان کا کوئی آرڈر پہلے آپ تک نہیں پہنچا`,
      }
    : null;
  const risky =
    riskScore === null
      ? null
      : {
          en: "if the shop's checks on your order call for it",
          ur: html`اگر دکان کی جانچ کے مطابق آپ کے آرڈر پر یہ ضروری ہو`,
        };
  const parts = [what, where, who, fresh, risky].filter((part) => part !== null);
  const en = parts.map((part) => part.en).join(', ');
  return {
    en: `${en.charAt(0).toUpperCase()}${en.slice(1)}`,
    ur: html`${parts.map((part, index) => (index === 0 ? part.ur : html`، ${part.ur}`))}`,
  };
}

/**
 * The badges the shop chose, under the button (ADR-086): cash on delivery and opening the parcel
 * only where the page offers cash on delivery for the cart (`codOffered`); an exchange or
 * returns linked to the refund policy where the shop has one; help on WhatsApp where it has a
 * number. Nothing when none is left.
 */
function badgeList(shop: CheckoutShop, codOffered: boolean): Html | false {
  const refund = shop.policies.some((policy) => policy.type === 'refund_policy');
  const items = shop.badges.flatMap((badge) => {
    const words = badgeWords(badge);
    switch (badge.kind) {
      case 'cash_on_delivery':
      case 'open_parcel':
        return codOffered ? [words] : [];
      case 'exchange':
      case 'returns':
        return [refund ? policyLink(shop, 'refund_policy', words) : words];
      case 'whatsapp':
        return shop.whatsapp
          ? [
              html`<a href="https://wa.me/${shop.whatsapp.slice(1)}" target="_blank" rel="noopener"
                >${words}</a
              >`,
            ]
          : [];
      case 'original':
        return [words];
    }
  });
  return (
    items.length > 0 &&
    html`<ul class="badges stack">
      ${items.map((item) => html`<li>${item}</li>`)}
    </ul>`
  );
}

/** A badge in English and Urdu: "7-day exchange". */
function badgeWords(badge: TrustBadgeValue): Html {
  const days = String(badge.days ?? 0);
  const words: { en: string; ur: HtmlValue } = (() => {
    switch (badge.kind) {
      case 'cash_on_delivery':
        return { en: 'Cash on delivery', ur: 'کیش آن ڈیلیوری' };
      case 'open_parcel':
        return {
          en: 'Open your parcel before you pay',
          ur: 'ادائیگی سے پہلے پارسل کھول کر دیکھیں',
        };
      case 'exchange':
        return { en: `${days}-day exchange`, ur: html`${ltr(days)} دن میں تبدیلی` };
      case 'returns':
        return { en: `${days}-day returns`, ur: html`${ltr(days)} دن میں واپسی` };
      case 'original':
        return { en: '100% original products', ur: html`${ltr('100%')} اصل مصنوعات` };
      case 'whatsapp':
        return { en: 'Help on WhatsApp', ur: 'واٹس ایپ پر مدد' };
    }
  })();
  return html`<span class="both"
    ><span lang="en">${words.en}</span> <span lang="ur" dir="rtl">${words.ur}</span></span
  >`;
}

/** What happens next: the shop calls to confirm, or waits for the transfer. */
function nextWords(shop: CheckoutShop, order: OrderRecord): Sentence {
  const name = orderName(order.number);
  // Its money, or its advance, to pay by transfer (ADR-074, ADR-083).
  if (order.stage === 'awaiting_payment') return transferWords(order, shop.name);
  // Paid, or its advance paid: there is no call to confirm it.
  if (
    order.paymentMethod === 'bank_transfer' ||
    order.paymentMethod === 'online' ||
    order.advanceDue > 0n
  ) {
    return {
      en: `Your order ${name} is placed. ${shop.name} will be in touch before sending it.`,
      ur: html`آپ کا آرڈر ${ltr(name)} موصول ہو گیا ہے۔ بھیجنے سے پہلے دکان آپ سے رابطہ کرے گی۔`,
    };
  }
  const phone = order.shippingAddress.phone && maskPkMobile(order.shippingAddress.phone);
  return {
    en: `Your order ${name} is placed. ${shop.name} will call or message you${
      phone ? ` on ${phone}` : ''
    } to confirm it before sending it.`,
    ur: html`آپ کا آرڈر ${ltr(name)} موصول ہو گیا ہے۔ بھیجنے سے پہلے دکان
    ${phone && html`${ltr(phone)} پر`} رابطہ کر کے اسے کنفرم کرے گی۔`,
  };
}

/**
 * The order placed: what happens next, how paying online went, where to pay a transfer or a way
 * to pay online, what it comes to, and where it goes.
 */
function placedPage(view: Extract<CheckoutView, { kind: 'placed' }>): CheckoutPage {
  const { shop, order, online, payment } = view;
  // On to the shop's gateway, whose page takes the payment's signed form (ADR-163).
  if (view.gatewayForm && online) {
    return page(
      200,
      `${LABELS.placedTitle.en} · ${shop.name}`,
      shop,
      [
        shopName(shop),
        heading({ en: 'Pay online', ur: 'آن لائن ادائیگی کریں' }),
        gatewayForm(view.gatewayForm, amount(online.amount)),
      ],
      [new URL(view.gatewayForm.url).origin],
    );
  }
  const to = order.shippingAddress;
  const phone = to.phone && maskPkMobile(to.phone);
  const rs = (value: bigint) => amount(value);
  // A transfer is the other way to pay what it waits for, where the order has the account.
  const transfer = order.bankAccount !== null;
  return page(
    payment === 'unavailable' ? 503 : 200,
    `${LABELS.placedTitle.en} · ${shop.name}`,
    shop,
    [
      shopName(shop),
      payment === 'paid'
        ? onlinePaidNotice(shop.name)
        : payment && banner(onlinePaymentProblemWords(payment, transfer)),
      html`<div class="mark" aria-hidden="true">✓</div>`,
      heading(LABELS.placedTitle),
      paragraphs(nextWords(shop, order), 'center'),
      // What it waits for, online through the shop's gateway (ADR-152), beside the transfer's.
      online && payOnlineForm(online, order.currency, transfer),
      transferDetails(order),
      order.codAmount > 0n &&
        paragraphs(
          {
            en: `You pay ${rs(order.codAmount)} when it arrives.`,
            ur: html`آرڈر ملنے پر ${ltr(rs(order.codAmount))} ادا کریں۔`,
          },
          'center strong',
        ),
      html`<section class="section">
        <h2 class="label">${say('bilingual', LABELS.yourOrder)}</h2>
        <table>
          ${order.lines.map((line) =>
            itemRow(line.quantity, itemName(line.title, line.variantTitle), rs(line.total)),
          )}
        </table>
        <table>
          ${row(LABELS.subtotal, rs(order.subtotal))}
          ${
            // The code's, then what paying by transfer or online took off (ADR-077, ADR-222).
            order.discount > order.transferDiscount + order.onlineDiscount &&
            row(
              order.discountCodes.length > 0
                ? {
                    en: `${LABELS.discount.en} (${order.discountCodes.join(', ')})`,
                    ur: LABELS.discount.ur,
                  }
                : LABELS.discount,
              `−${rs(order.discount - order.transferDiscount - order.onlineDiscount)}`,
            )
          }
          ${
            order.transferDiscount > 0n &&
            row(LABELS.transferDiscount, `−${rs(order.transferDiscount)}`)
          }
          ${order.onlineDiscount > 0n && row(LABELS.onlineDiscount, `−${rs(order.onlineDiscount)}`)}
          ${row(LABELS.delivery, order.shipping === 0n ? LABELS.free : rs(order.shipping))}
          ${order.codFee > 0n && row(LABELS.codFee, rs(order.codFee))}
          ${row(LABELS.total, rs(order.total), 'total')}
          ${[...taxByRate(order)].map(([rate, tax]) => row(taxIncludedWords(rate), rs(tax)))}
          ${view.storeCredit > 0n && row(LABELS.storeCredit, `−${rs(view.storeCredit)}`)}
        </table>
      </section>`,
      to.name &&
        html`<section class="section">
          <h2 class="label">${say('bilingual', LABELS.deliverTo)}</h2>
          <p>
            ${text(to.name)}<br />${phone && html`${ltr(phone)}<br />`}${text(to.address1)}<br />
            ${to.address2 && html`${text(to.address2)}<br />`}
            ${to.landmark && html`${text(to.landmark)}<br />`}${text(addressTail(to))}
          </p>
        </section>`,
      link(shop.storefront, LABELS.continueShopping),
      policyLinks(shop),
    ],
    // Paying online answers with a gateway's page: the form goes on there.
    gatewayOrigins(online?.gateways ?? []),
  );
}

/**
 * The cart's items and what they come to, paid `onDelivery` where that is the only way to pay,
 * with the shop's `fee` for it and less the `advance` it asks for by transfer; or by transfer
 * where that alone is, less what it takes off (`off`). Delivery is exact once the shopper typed a
 * city, or when every city costs the same; until then, the shop's charges. With the total, the
 * sales tax it includes at the shop's `tax` (ADR-096).
 */
function cartSummary(
  cart: CartJson,
  delivery: DeliverySettingsRecord,
  city: string,
  code: DiscountCodeRecord | null,
  pay: {
    onDelivery: boolean;
    fee: bigint;
    off: bigint;
    /** Whose `off` is: paying by transfer's or online's. */
    offWay: 'transfer' | 'online';
    advance: bigint;
  },
  tax: TaxRates,
): Html {
  const totals = checkoutTotals(BigInt(cart.subtotal), delivery, city, code);
  const charge = totals.delivery;
  // How long delivery takes to the city typed, or wherever it goes until one is (ADR-235).
  const days = deliveryDays(delivery, city.trim() === '' ? null : city);
  const { onDelivery, fee, off, advance } = pay;
  // As placing the order works it out: on the items after what is taken off them, and on
  // delivery and the fee where the shop's include it.
  const included =
    totals.total === null
      ? null
      : orderTaxOf(tax, {
          lines: cart.items.map((item) => ({
            total: BigInt(item.linePrice),
            taxable: item.taxable,
            taxCode: item.taxCode,
          })),
          discount: totals.discount + off,
          charges: (totals.freeDelivery ? 0n : (charge ?? 0n)) + fee,
        });
  // The code once, beside the English: a bilingual label says it twice otherwise.
  const discountLabel = code && {
    en: `${LABELS.discount.en} (${code.code})`,
    ur: LABELS.discount.ur,
  };
  return html`<section class="section">
    <h2 class="label">${say('bilingual', LABELS.yourOrder)}</h2>
    <table>
      ${cart.items.map((item) =>
        itemRow(
          item.quantity,
          itemName(item.title, item.variantTitle),
          amount(BigInt(item.linePrice)),
          shownProperties(item.properties),
        ),
      )}
    </table>
    <table>
      ${row(LABELS.subtotal, amount(totals.subtotal))}
      ${discountLabel && totals.discount > 0n && row(discountLabel, `−${amount(totals.discount)}`)}
      ${
        off > 0n &&
        row(
          pay.offWay === 'online' ? LABELS.onlineDiscount : LABELS.transferDiscount,
          `−${amount(off)}`,
        )
      }
      ${row(
        LABELS.delivery,
        totals.freeDelivery || charge === 0n
          ? LABELS.free
          : charge === null
            ? LABELS.byCity
            : amount(charge),
      )}
      ${fee > 0n && row(LABELS.codFee, amount(fee))}
      ${
        totals.total !== null &&
        (advance > 0n
          ? [
              row(LABELS.total, amount(totals.total + fee)),
              row(LABELS.advanceByTransfer, `−${amount(advance)}`),
              row(LABELS.payOnDelivery, amount(totals.total + fee - advance), 'due'),
            ]
          : row(
              onDelivery ? LABELS.payOnDelivery : LABELS.total,
              amount(totals.total + fee - off),
              'due',
            ))
      }
      ${
        // A line a rate, as the order's invoice will have them.
        included !== null &&
        [...taxesByRate([...included.lines, { rate: included.rate, tax: included.charges }])].map(
          ([rate, tax]) => row(taxIncludedWords(rate), amount(tax)),
        )
      }
    </table>
    ${totals.total === null && paragraphs(chargesWords(delivery), 'small muted')}
    ${days && paragraphs(deliveryDaysWords(days), 'small muted')}
    ${
      cart.note !== '' &&
      html`<p class="small muted">
        ${say('bilingual', LABELS.note)}: <span dir="auto">${text(cart.note)}</span>
      </p>`
    }
  </section>`;
}

/** How many working days delivery takes, as the summary says it under the charge. */
function deliveryDaysWords(days: DeliveryDays): Sentence {
  const { min, max } = days;
  const en = (n: number) => `${n} working day${n === 1 ? '' : 's'}`;
  const ur = (n: number) => `${n} کام کے ${n === 1 ? 'دن' : 'دنوں'}`;
  if (max === 0) return { en: 'Delivered the same day.', ur: 'اسی دن ڈیلیوری۔' };
  if (min === max) return { en: `Delivered in ${en(max)}.`, ur: `${ur(max)} میں ڈیلیوری۔` };
  if (min === 0) return { en: `Delivered within ${en(max)}.`, ur: `${ur(max)} کے اندر ڈیلیوری۔` };
  return {
    en: `Delivered in ${min} to ${en(max)}.`,
    ur: `${min} سے ${ur(max)} میں ڈیلیوری۔`,
  };
}

/** What delivery costs where, for a shopper who has not typed their city yet. */
function chargesWords(delivery: DeliverySettingsRecord): Sentence {
  const zones = delivery.zones.map((zone) => {
    const cities = zone.cities.slice(0, 5).join(', ') + (zone.cities.length > 5 ? '…' : '');
    return { cities, charge: amount(zone.charge) };
  });
  const everywhere = amount(delivery.charge);
  const freeFrom = delivery.freeAbove === null ? null : amount(delivery.freeAbove);
  const zoneWords = zones.map((zone) => html`؛ ${ltr(zone.cities)} میں ${ltr(zone.charge)}`);
  const freeWords = freeFrom && html` ${ltr(freeFrom)} یا زیادہ کے آرڈر پر ڈیلیوری مفت۔`;
  return {
    en:
      `Delivery is ${everywhere}` +
      zones.map((zone) => `; ${zone.charge} in ${zone.cities}`).join('') +
      '.' +
      (freeFrom ? ` Free on orders of ${freeFrom} or more.` : ''),
    // One line: a line break would put a space before each "؛" and "۔".
    ur: html`ڈیلیوری ${ltr(everywhere)}${zoneWords}۔${freeWords}`,
  };
}

/** How many cities the page names that the shop takes no cash on delivery in; the rest it counts. */
const CITIES_SHOWN = 5;

/**
 * What the shop's rules keep cash on delivery to, as the page says it under the option: "Up to
 * Rs 25,000 an order, and not in Gilgit or Skardu." Null when they keep it from nothing a page
 * can say; the rule on customers' refusals it leaves for when it applies.
 */
function codTermsWords(rules: CodRulesRecord): Sentence | null {
  const max = rules.maxOrderTotal === null ? null : amount(rules.maxOrderTotal);
  const cities = rules.unavailableCities;
  if (max === null && cities.length === 0) return null;
  const shown = cities.slice(0, CITIES_SHOWN);
  const more = cities.length - shown.length;
  const en = (names: string[]) =>
    more > 0
      ? `${names.join(', ')} and ${more} more ${more === 1 ? 'city' : 'cities'}`
      : names.length > 1
        ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
        : names.join('');
  const urNames = shown.map((name) => findCity(name)?.nameUr ?? name);
  const ur =
    more > 0
      ? html`${urNames.join('، ')} اور ${ltr(String(more))} مزید شہروں`
      : urNames.length > 1
        ? `${urNames.slice(0, -1).join('، ')} اور ${urNames[urNames.length - 1]}`
        : urNames.join('');
  const enParts = [max && `up to ${max} an order`, cities.length > 0 && `not in ${en(shown)}`];
  const enText = enParts.filter(Boolean).join(', and ');
  return {
    en: `${enText.charAt(0).toUpperCase()}${enText.slice(1)}.`,
    ur: html`${max && html`ایک آرڈر پر ${ltr(max)} تک`}${max && cities.length > 0 && '، '}${
      cities.length > 0 && html`${ur} میں نہیں`
    }۔`,
  };
}

/**
 * Why the shop's rules keep cash on delivery from a cart, before the shopper types: its total, or
 * a product in it.
 */
function codLimitWords(refusal: CodRefusal, ways: PrepaidWays): Sentence {
  if (refusal.reason === 'product') {
    return {
      en: `Cash on delivery isn't available for ${refusal.title}.`,
      ur: html`${text(refusal.title)} کے لیے ڈیلیوری پر نقد ادائیگی دستیاب نہیں۔`,
    };
  }
  const max = refusal.reason === 'total' ? amount(refusal.max) : null;
  if (max === null) return codRefusalWords(refusal, ways);
  return {
    en: `Cash on delivery is for orders up to ${max}.`,
    ur: html`ڈیلیوری پر نقد ادائیگی ${ltr(max)} تک کے آرڈرز کے لیے ہے۔`,
  };
}

/** The ways to pay before the order arrives that the page offers. */
interface PrepaidWays {
  transfer: boolean;
  online: boolean;
}

/**
 * Why the shop's rules keep cash on delivery from the order, and what the shopper can do: pay by
 * transfer, or online, where the shop takes it. A refused customer is not told why, nor a risky
 * order.
 */
function codRefusalWords(refusal: CodRefusal, ways: PrepaidWays): Sentence {
  // How else they can pay, as "Pay … instead" says it.
  const by =
    ways.transfer && ways.online
      ? { en: 'online or by bank transfer', ur: 'آن لائن یا بینک ٹرانسفر سے' }
      : ways.online
        ? { en: 'online', ur: 'آن لائن' }
        : ways.transfer
          ? { en: 'by bank transfer', ur: 'بینک ٹرانسفر سے' }
          : null;
  const instead = {
    en: by ? ` Pay ${by.en} instead.` : ' Ask the shop how else you can pay.',
    ur: by
      ? ` اس کے بجائے ${by.ur} ادائیگی کریں۔`
      : ' ادائیگی کے کسی اور طریقے کے لیے دکان سے رابطہ کریں۔',
  };
  switch (refusal.reason) {
    case 'total': {
      const max = amount(refusal.max);
      return {
        en:
          `Cash on delivery is for orders up to ${max}.` +
          (by
            ? ` Pay ${by.en}, or remove some items from your cart.`
            : ' Remove some items from your cart, or ask the shop how else you can pay.'),
        ur: html`ڈیلیوری پر نقد ادائیگی ${ltr(max)} تک کے آرڈرز کے لیے
        ہے۔${
          by
            ? ` ${by.ur} ادائیگی کریں، یا اپنے کارٹ سے کچھ چیزیں ہٹائیں۔`
            : ' اپنے کارٹ سے کچھ چیزیں ہٹائیں، یا ادائیگی کے کسی اور طریقے کے لیے دکان سے رابطہ کریں۔'
        }`,
      };
    }
    case 'product':
      return {
        en:
          `Cash on delivery isn't available for ${refusal.title}.` +
          (by
            ? ` Pay ${by.en}, or remove it from your cart.`
            : ' Remove it from your cart, or ask the shop how else you can pay.'),
        ur: html`${text(refusal.title)} کے لیے ڈیلیوری پر نقد ادائیگی دستیاب
        نہیں۔${
          by
            ? ` ${by.ur} ادائیگی کریں، یا اسے اپنے کارٹ سے ہٹا دیں۔`
            : ' اسے اپنے کارٹ سے ہٹا دیں، یا ادائیگی کے کسی اور طریقے کے لیے دکان سے رابطہ کریں۔'
        }`,
      };
    case 'city': {
      const urdu = findCity(refusal.city)?.nameUr ?? refusal.city;
      return {
        en: `Cash on delivery isn't available in ${refusal.city}.${instead.en}`,
        ur: html`${text(urdu)} میں ڈیلیوری پر نقد ادائیگی دستیاب نہیں۔${instead.ur}`,
      };
    }
    case 'customer':
      return {
        en: `Cash on delivery isn't available for this order.${instead.en}`,
        ur: `اس آرڈر کے لیے ڈیلیوری پر نقد ادائیگی دستیاب نہیں۔${instead.ur}`,
      };
    case 'link':
      return by
        ? {
            en: `This link is for paying in advance. Pay ${by.en} to place your order.`,
            ur: `یہ لنک پیشگی ادائیگی کے لیے ہے۔ آرڈر دینے کے لیے ${by.ur} ادائیگی کریں۔`,
          }
        : {
            en: `This link is for paying in advance.${instead.en}`,
            ur: `یہ لنک پیشگی ادائیگی کے لیے ہے۔${instead.ur}`,
          };
    // Softly: what the shop asks of the order, not what its checks found (ADR-099).
    case 'risk':
      return by
        ? {
            en: `The shop asks for this order to be paid in advance. Pay ${by.en} to place it.`,
            ur: `دکان اس آرڈر کی پیشگی ادائیگی چاہتی ہے۔ آرڈر دینے کے لیے ${by.ur} ادائیگی کریں۔`,
          }
        : {
            en: `Cash on delivery isn't available for this order.${instead.en}`,
            ur: `اس آرڈر کے لیے ڈیلیوری پر نقد ادائیگی دستیاب نہیں۔${instead.ur}`,
          };
  }
}

/** Where the code sent to the shopper's number is typed (CHK-09, ADR-148). */
function codeField(): Html {
  return html`<div class="field">
    <label class="label" for="code">${say('bilingual', LABELS.code)}</label>
    <input
      id="code"
      name="code"
      type="text"
      inputmode="numeric"
      autocomplete="one-time-code"
      maxlength="6"
      dir="ltr"
      aria-required="true"
    />
  </div>`;
}

/** Another code asked for: by SMS, or anew on WhatsApp, as the last went. */
function codeAgain(channel: 'whatsapp' | 'sms'): Html {
  return html`<button class="button secondary stack" type="submit" name="resend" value="sms">
      ${say('bilingual', LABELS.codeBySms)}
    </button>
    ${
      channel === 'sms' &&
      html`<button class="button secondary stack" type="submit" name="resend" value="whatsapp">
        ${say('bilingual', LABELS.codeOnWhatsapp)}
      </button>`
    }`;
}

function codeWords(problem: Extract<CheckoutProblem, { kind: 'code' }>): Sentence {
  const phone = problem.phone;
  const where =
    problem.channel === 'sms'
      ? { en: 'by SMS', ur: 'ایس ایم ایس سے' }
      : { en: 'on WhatsApp', ur: 'واٹس ایپ پر' };
  switch (problem.state) {
    case 'sent':
      return {
        en: `To place your order, type the code we sent ${where.en} to ${phone}.`,
        ur: html`آرڈر دینے کے لیے وہ کوڈ لکھیں جو ہم نے ${where.ur} ${ltr(phone)} پر بھیجا ہے۔`,
      };
    case 'wrong':
      return {
        en: `That is not the code we sent ${where.en} to ${phone}. Check it and type it again.`,
        ur: html`یہ وہ کوڈ نہیں جو ہم نے ${where.ur} ${ltr(phone)} پر بھیجا۔ دیکھ کر دوبارہ لکھیں۔`,
      };
    case 'expired':
      return {
        en: 'That code no longer works. Ask for a new one below.',
        ur: 'یہ کوڈ اب کام نہیں کرتا۔ نیچے سے نیا کوڈ منگوائیں۔',
      };
    case 'too_many':
      return {
        en:
          `We sent ${phone} as many codes as we can for now. Try again later, or message the ` +
          'shop in your chat.',
        ur: html`ہم ${ltr(phone)} پر ابھی جتنے کوڈ بھیج سکتے تھے بھیج چکے ہیں۔ کچھ دیر بعد دوبارہ
        کوشش کریں، یا اپنی چیٹ میں دکان کو پیغام بھیجیں۔`,
      };
  }
}

function problemWords(
  problem: CheckoutProblem,
  ways: PrepaidWays = { transfer: false, online: false },
): Sentence {
  switch (problem.kind) {
    case 'code':
      return codeWords(problem);
    case 'changed':
      return {
        en:
          "Your cart, the delivery charges or the shop's policies changed while you were here. " +
          'Check your order again.',
        ur: 'آپ کے یہاں ہوتے ہوئے کارٹ، ڈیلیوری چارجز یا دکان کی پالیسیاں بدل گئیں۔ اپنا آرڈر دوبارہ دیکھیں۔',
      };
    case 'address':
      return {
        en: 'Some of your details are missing or not right. See below.',
        ur: 'آپ کی معلومات میں کچھ کمی یا غلطی ہے۔ نیچے دیکھیں۔',
      };
    case 'unavailable':
      return {
        en: 'Some of your cart is no longer available. Go back to your cart to change it.',
        ur: 'آپ کے کارٹ کی کچھ چیزیں اب دستیاب نہیں۔ کارٹ پر واپس جا کر تبدیلی کریں۔',
      };
    case 'refused':
      return {
        en: "Sorry, the shop can't take orders right now. Please try again later.",
        ur: 'معذرت، دکان ابھی آرڈر نہیں لے سکتی۔ براہ کرم بعد میں دوبارہ کوشش کریں۔',
      };
    case 'no_store_credit':
      return {
        en:
          'This number has no store credit with the shop. Place your order without it, or ' +
          'check the number.',
        ur: 'اس نمبر پر دکان کا کوئی اسٹور کریڈٹ نہیں۔ اس کے بغیر آرڈر دیں، یا نمبر دیکھ لیں۔',
      };
    case 'too_many':
      return problem.by === 'phone'
        ? {
            en:
              'This number has placed as many orders today as checkout takes in a day. To ' +
              'order more, message the shop in your chat.',
            ur: 'اس نمبر سے آج اتنے آرڈر ہو چکے ہیں جتنے چیک آؤٹ ایک دن میں لیتا ہے۔ مزید آرڈر کے لیے اپنی چیٹ میں دکان کو پیغام بھیجیں۔',
          }
        : {
            en:
              'Many orders came from your internet connection in the last hour. Try again ' +
              'later, or message the shop in your chat.',
            ur: 'پچھلے ایک گھنٹے میں آپ کے انٹرنیٹ کنکشن سے بہت سے آرڈر آئے ہیں۔ کچھ دیر بعد دوبارہ کوشش کریں، یا اپنی چیٹ میں دکان کو پیغام بھیجیں۔',
          };
    case 'discount':
      return refusalWords(problem.code, problem.refusal);
    case 'cod_unavailable':
      return codRefusalWords(problem.refusal, ways);
    case 'cod_limit': {
      const limit = amount(COD_CASH_LIMIT);
      return {
        en:
          `By law, cash on delivery can't collect more than ${limit} an order. Remove some ` +
          'items from your cart, or ask the shop about paying part in advance.',
        ur: html`قانون کے مطابق ڈیلیوری پر نقد ادائیگی ایک آرڈر پر ${ltr(limit)} سے زیادہ نہیں ہو
        سکتی۔ اپنے کارٹ سے کچھ چیزیں ہٹائیں، یا کچھ رقم پیشگی ادا کرنے کے لیے دکان سے رابطہ کریں۔`,
      };
    }
  }
}

/**
 * The discount code: a form to apply one, or the one applied, with a form to take it off; what
 * went wrong under it. Forms of their own, posted with an `action`, which place nothing: they
 * come before the address, which a shopper applying a code has not typed yet.
 */
function discountSection(
  discount: CheckoutDiscount | null,
  problem: Extract<CheckoutProblem, { kind: 'discount' }> | null,
): Html {
  const said =
    problem && html`<div id="discount-error">${paragraphs(problemWords(problem), 'error')}</div>`;
  if (discount) {
    return html`<section class="section">
      <h2 class="label">${say('bilingual', LABELS.discountCode)}</h2>
      ${paragraphs(
        discount.record
          ? {
              en: html`<strong dir="ltr">${discount.code}</strong> is applied.`,
              ur: html`${ltr(discount.code)} لاگو ہو گیا ہے۔`,
            }
          : refusalWords(discount.code, discount.refusal),
        discount.record ? '' : 'error',
      )}
      ${said}
      <form method="post">
        <input type="hidden" name="action" value="remove_discount" />
        <button class="button secondary" type="submit">${say('bilingual', LABELS.remove)}</button>
      </form>
    </section>`;
  }
  return html`<section class="section">
    <form method="post">
      <input type="hidden" name="action" value="discount" />
      <label class="label" for="discount">${say('bilingual', LABELS.discountCode)}</label>
      <input
        id="discount"
        name="discount"
        type="text"
        dir="ltr"
        value="${problem?.code ?? ''}"
        autocomplete="off"
        autocapitalize="characters"
        spellcheck="false"
        maxlength="64"
        ${problem && html`aria-invalid="true" aria-describedby="discount-error"`}
      />
      ${said}
      <button class="button secondary" type="submit">${say('bilingual', LABELS.apply)}</button>
    </form>
  </section>`;
}

/** Why a code takes nothing off, in both languages. */
function refusalWords(code: string, refusal: DiscountRefusal | { reason: 'attempts' }): Sentence {
  switch (refusal.reason) {
    case 'unknown':
      return {
        en: html`There's no discount code <span dir="ltr">${code}</span> here. Check it and try
          again.`,
        ur: html`${ltr(code)} نام کا کوئی ڈسکاؤنٹ کوڈ نہیں ملا۔ کوڈ دیکھ کر دوبارہ کوشش کریں۔`,
      };
    case 'scheduled': {
      const day = dayOf(refusal.startsAt);
      return {
        en: html`<span dir="ltr">${code}</span> starts on ${day}.`,
        ur: html`${ltr(code)} ${ltr(day)} سے شروع ہو گا۔`,
      };
    }
    case 'expired':
      return {
        en: html`<span dir="ltr">${code}</span> has ended.`,
        ur: html`${ltr(code)} کی مدت ختم ہو چکی ہے۔`,
      };
    case 'minimum': {
      const minimum = amount(refusal.minimum);
      return {
        en: html`<span dir="ltr">${code}</span> is for orders of ${minimum} or more.`,
        ur: html`${ltr(code)} صرف ${ltr(minimum)} یا زیادہ کے آرڈر کے لیے ہے۔`,
      };
    }
    case 'used_up':
      return {
        en: html`<span dir="ltr">${code}</span> has been used up.`,
        ur: html`${ltr(code)} پورا استعمال ہو چکا ہے۔`,
      };
    case 'used':
      return {
        en: html`You have used <span dir="ltr">${code}</span> before, and it is for one order each.
          Remove it to place your order.`,
        ur: html`آپ ${ltr(code)} پہلے استعمال کر چکے ہیں، اور یہ ہر گاہک کے ایک آرڈر کے لیے ہے۔ آرڈر
        دینے کے لیے اسے ہٹائیں۔`,
      };
    case 'attempts':
      return {
        en: "This checkout can't take more discount codes.",
        ur: 'یہ چیک آؤٹ مزید ڈسکاؤنٹ کوڈ نہیں لے سکتا۔',
      };
  }
}

/** "5 October 2026", in Pakistan's time. */
function dayOf(at: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Karachi',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(at);
}

/**
 * A labelled box of the form, with a hint and what is wrong underneath. Autocomplete names the
 * delivery address, for phones that fill it in; typed text runs in its script's direction, and
 * numbers left to right.
 */
function field(
  name: Exclude<keyof CheckoutForm, 'province'>,
  label: Words,
  form: CheckoutForm,
  errors: readonly FieldError[],
  options: {
    autocomplete: string;
    required?: boolean;
    kind?: 'tel' | 'email';
    list?: string;
    hint?: Sentence;
  },
): Html {
  const error = errors.find((each) => each.field[0] === name);
  const described = [options.hint && `${name}-hint`, error && `${name}-error`].filter(Boolean);
  return html`<div class="field">
    <label class="label" for="${name}">${say('bilingual', label)}</label>
    <input
      id="${name}"
      name="${name}"
      ${options.kind ? html`type="${options.kind}" dir="ltr"` : html`type="text" dir="auto"`}
      value="${form[name] ?? ''}"
      autocomplete="shipping ${options.autocomplete}"
      ${options.list && html`list="${options.list}"`}
      ${options.required && html`aria-required="true"`}
      ${error && html`aria-invalid="true"`}
      ${described.length > 0 && html`aria-describedby="${described.join(' ')}"`}
    />
    ${options.hint && html`<div id="${name}-hint">${paragraphs(options.hint, 'small muted')}</div>`}
    ${error && html`<div id="${name}-error">${paragraphs(errorWords(error), 'error')}</div>`}
  </div>`;
}

/**
 * The areas the area's box suggests: the city's once one is typed, or, while none is, every
 * listed city's, each by its city, as the page has no scripts to change them as it is typed.
 */
function areaList(city: string): Html {
  const options = areaSuggestions(city).map((area) =>
    area.city
      ? html`<option value="${area.value}" label="${area.city}"></option>`
      : html`<option value="${area.value}"></option>`,
  );
  return html`<datalist id="areas">${options}</datalist>`;
}

/** The province to pick, or none, to take it from the city. */
function provinceField(value: string, errors: readonly FieldError[]): Html {
  const error = errors.find((each) => each.field[0] === 'province');
  const option = (code: string, words: Words) =>
    html`<option value="${code}" ${code === value && html`selected`}>
      ${words.en} · ${words.ur}
    </option>`;
  return html`<div class="field">
    <label class="label" for="province">${say('bilingual', LABELS.province)}</label>
    <select
      id="province"
      name="province"
      autocomplete="shipping address-level1"
      ${error && html`aria-invalid="true" aria-describedby="province-error"`}
    >
      ${option('', LABELS.fromCity)}
      ${Object.entries(PK_PROVINCES).map(([code, province]) =>
        option(code, { en: province.name, ur: province.nameUr }),
      )}
    </select>
    ${error && html`<div id="province-error">${paragraphs(errorWords(error), 'error')}</div>`}
  </div>`;
}

function errorWords(error: FieldError): Sentence {
  const field = error.field[0];
  if (error.code === 'BLANK') {
    switch (field) {
      case 'name':
        return {
          en: 'Enter the name of who receives the parcel.',
          ur: 'پارسل وصول کرنے والے کا نام لکھیں۔',
        };
      case 'phone':
        return { en: 'Enter your mobile number.', ur: 'اپنا موبائل نمبر لکھیں۔' };
      case 'address1':
        return { en: 'Enter the house number and street.', ur: 'مکان نمبر اور گلی لکھیں۔' };
      case 'city':
        return { en: 'Enter the city.', ur: 'شہر کا نام لکھیں۔' };
    }
  }
  if (error.code === 'TOO_LONG') {
    return { en: 'This is too long. Shorten it.', ur: 'یہ بہت لمبا ہے، اسے مختصر کریں۔' };
  }
  switch (field) {
    case 'province':
      return { en: 'Choose a province from the list.', ur: 'فہرست میں سے صوبہ منتخب کریں۔' };
    case 'phone':
      return {
        en: 'Enter a Pakistani mobile number, like 0300 1234567.',
        ur: html`پاکستانی موبائل نمبر لکھیں، جیسے ${ltr('0300 1234567')}۔`,
      };
    case 'email':
      return {
        en: 'Enter an email like ayesha@example.com, or leave it empty.',
        ur: html`ای میل لکھیں، جیسے ${ltr('ayesha@example.com')}، یا اسے خالی چھوڑ دیں۔`,
      };
    default:
      return { en: 'Check this.', ur: 'اسے دوبارہ دیکھیں۔' };
  }
}

/**
 * A page in its shop's colours, with its logo (CHK-14), or the platform's when it has no shop to
 * show.
 */
function page(
  status: number,
  title: string,
  shop: CheckoutShop | null,
  body: HtmlValue[],
  formTargets: readonly string[] = [],
): CheckoutPage {
  return {
    status,
    ...renderPage({
      title,
      body: html`${body}`,
      accent: shop?.accent,
      images: shop?.logo ? [shop.logo] : [],
      formTargets,
    }),
  };
}

/** The shop's logo, named for those who can't see it (ADR-081); or its name, without one. */
function shopName(shop: CheckoutShop): Html {
  return shop.logo
    ? html`<p class="shop"><img class="logo" src="${shop.logo}" alt="${shop.name}" /></p>`
    : html`<p class="shop">${text(shop.name)}</p>`;
}

/**
 * The shop's policies, linked at the foot of the page as Shopify's checkout links them (ADR-056).
 * Each opens beside the checkout, which keeps what the shopper typed.
 */
function policyLinks(shop: CheckoutShop): Html | false {
  const item = ({ type }: { type: PolicyType }) =>
    html`<p>${policyLink(shop, type, say('bilingual', POLICY_TITLES[type]))}</p>`;
  return (
    shop.policies.length > 0 &&
    html`<nav class="section center small" aria-label="Policies">${shop.policies.map(item)}</nav>`
  );
}

/**
 * What placing the order agrees to (ADR-057): the shop's policies, each linked, but for its
 * contact information, which promises nothing. Nothing when it has none.
 */
function agreementWords(shop: CheckoutShop): Sentence | null {
  const terms = shop.policies.filter((policy) => policy.type !== 'contact_information');
  if (terms.length === 0) return null;
  const en = terms.map(({ type }) => policyLink(shop, type, POLICY_TITLES[type].en.toLowerCase()));
  // In Urdu, its Urdu pages, which show the shop's own words where it gave no Urdu (ADR-239).
  const ur = terms.map(({ type }) => policyLink(shop, type, POLICY_TITLES[type].ur, 'ur'));
  return {
    en: html`By placing your order, you agree to the shop's ${listOf(en, ', ', ' and ')}.`,
    ur: html`آرڈر دے کر آپ دکان کی ان پالیسیوں سے اتفاق کرتے ہیں: ${listOf(ur, '، ', ' اور ')}۔`,
  };
}

/**
 * A policy's page, opening beside the checkout, which keeps what the shopper typed: in Urdu, the
 * storefront's Urdu page.
 */
function policyLink(
  shop: CheckoutShop,
  type: PolicyType,
  title: HtmlValue,
  locale: 'en' | 'ur' = 'en',
): Html {
  const href = `${shop.storefront}${locale === 'ur' ? '/ur' : ''}/policies/${policyHandle(type)}`;
  return html`<a href="${href}" target="_blank" rel="noopener">${title}</a>`;
}

/** "a", "a and b", "a, b and c", with the language's comma and "and". */
function listOf(items: readonly Html[], comma: string, and: string): HtmlValue[] {
  return items.map((item, index) => [
    index === 0 ? '' : index === items.length - 1 ? and : comma,
    item,
  ]);
}

function heading(words: Words): Html {
  return html`<h1 class="title stack">${say('bilingual', words)}</h1>`;
}

/** A sentence in English, then in Urdu, right to left. */
function paragraphs(sentence: Sentence, className: string): Html {
  return html`<div class="text ${className}">
    <p lang="en">${sentence.en}</p>
    <p lang="ur" dir="rtl">${sentence.ur}</p>
  </div>`;
}

function banner(sentence: Sentence): Html {
  return html`<div class="banner" role="alert">${paragraphs(sentence, '')}</div>`;
}

function link(href: string, words: Words): Html {
  return html`<p class="center"><a href="${href}">${say('bilingual', words)}</a></p>`;
}

function row(label: Words, value: string | Words, className = ''): Html {
  return html`<tr class="${className}">
    <td>${say('bilingual', label)}</td>
    <td class="num">${typeof value === 'string' ? ltr(value) : say('bilingual', value)}</td>
  </tr>`;
}

/** A line: how many of what, what they come to, and what the shopper added, such as an engraving. */
function itemRow(
  quantity: number,
  name: string,
  total: string,
  properties: readonly [string, string][] = [],
): Html {
  return html`<tr>
    <td>
      ${ltr(`${quantity} ×`)} <span dir="auto">${text(name)}</span>
      ${properties.map(
        ([key, value]) => html`<br /><span class="small muted">${text(`${key}: ${value}`)}</span>`,
      )}
    </td>
    <td class="num">${ltr(total)}</td>
  </tr>`;
}

/** "Lahore, Punjab", as the order keeps its city and province. */
function addressTail(to: OrderRecord['shippingAddress']): string {
  const province = to.provinceCode ? PK_PROVINCES[to.provinceCode as PkProvinceCode].name : null;
  return [to.city, province].filter(Boolean).join(', ');
}

function amount(value: bigint): string {
  return formatMoney(money(value, 'PKR'));
}
