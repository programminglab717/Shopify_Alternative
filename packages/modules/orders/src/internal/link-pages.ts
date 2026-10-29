import type { FieldError } from '@hatti/api';
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
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
import { POLICY_TITLES } from '@hatti/online-store/public';
import { taxIncludedWords } from '@hatti/tax/public';
import {
  PK_PROVINCES,
  areaSuggestions,
  findCity,
  maskPkMobile,
  type PkProvinceCode,
} from '@hatti/pk';
import { shownLineProperties } from './documents.js';
import type { AffiliatePageView } from './affiliates.service.js';
import type { DraftLinkView } from './draft-order.service.js';
import type { AddressForm, LinkProblem, LinkShop } from './links.js';
import {
  LOCATION_SCRIPT,
  MAP_SCRIPT,
  locationField,
  locationFormOf,
  pinLine,
  type MapTiles,
} from './location.js';
import {
  gatewayForm,
  gatewayOrigins,
  onlinePaidNotice,
  onlinePaymentProblemWords,
  payOnlineForm,
} from './online-payment-page.js';
import type { OnlineGateway } from './online-payments.js';
import type {
  OrderLinkView,
  ReviewableProduct,
  SubscriptionLinkView,
} from './order-link.service.js';
import { dayText } from './subscriptions.js';
import type { PostPurchaseOffer } from './post-purchase-offer.js';
import { RETURN_NOTE_MAX, type ReturnOffer } from './return-request.service.js';
import type { TrackingView } from './tracking.service.js';
import { deliverySlotText } from './delivery-slot.js';
import type {
  DeliverySlotValue,
  FulfillmentEventRecord,
  FulfillmentRecord,
  OrderRecord,
} from './records.js';
import { addressChangeable, awaitsCustomer, itemName, orderName, termsOwed } from './rules.js';
import {
  RETURN_PREFERENCES,
  RETURN_REASONS,
  type FulfillmentEventStatusValue,
  type ReturnPreferenceValue,
  type ReturnReasonValue,
  type StoredAddressValue,
} from './schema.js';
import {
  shownItems,
  shownOfDraft,
  shownOfOrder,
  type ShownOrder,
  type ShownTerm,
} from './shown-order.js';
import { transferDetails, transferWords } from './transfer-details.js';
import { RECEIPT_LIMITS, RECEIPT_TYPES } from './transfer-receipt.service.js';

/** A link's page and its HTTP status. */
export interface LinkPage extends RenderedPage {
  status: number;
}

// Labels, in the words of the shop's documents.
const LABELS = {
  confirmTitle: { en: 'Confirm your order', ur: 'اپنا آرڈر کنفرم کریں' },
  yourOrder: { en: 'Your order', ur: 'آپ کا آرڈر' },
  bundleHolds: { en: 'Includes:', ur: 'اس میں شامل:' },
  giftMessage: { en: 'Gift message', ur: 'تحفے کا پیغام' },
  subtotal: { en: 'Subtotal', ur: 'ذیلی کل' },
  discount: { en: 'Discount', ur: 'رعایت' },
  transferDiscount: { en: 'Bank transfer discount', ur: 'بینک ٹرانسفر پر رعایت' },
  onlineDiscount: { en: 'Online payment discount', ur: 'آن لائن ادائیگی پر رعایت' },
  shipping: { en: 'Delivery charges', ur: 'ڈیلیوری چارجز' },
  codFee: { en: 'Cash on delivery fee', ur: 'کیش آن ڈیلیوری فیس' },
  total: { en: 'Total', ur: 'کل رقم' },
  advance: { en: 'Paid in advance', ur: 'پیشگی ادائیگی' },
  paid: { en: 'Paid', ur: 'ادا شدہ' },
  payOnDelivery: { en: 'Pay on delivery', ur: 'ڈیلیوری پر ادائیگی' },
  payOnCollection: { en: 'Pay when you collect it', ur: 'وصول کرتے وقت ادائیگی' },
  payByTransfer: { en: 'Pay by bank transfer', ur: 'بینک ٹرانسفر سے ادائیگی' },
  advanceByTransfer: { en: 'Advance by bank transfer', ur: 'ایڈوانس بینک ٹرانسفر سے' },
  shipTo: { en: 'Deliver to', ur: 'ترسیل کا پتہ' },
  collectedBy: { en: 'Collected by', ur: 'وصول کرنے والا' },
  courier: { en: 'Courier', ur: 'کوریئر' },
  track: { en: 'Track', ur: 'ٹریک کریں' },
  confirm: { en: 'Confirm order', ur: 'آرڈر کنفرم کریں' },
  cancelLink: { en: 'Cancel this order', ur: 'یہ آرڈر منسوخ کریں' },
  cancelTitle: { en: 'Cancel your order?', ur: 'آرڈر منسوخ کریں؟' },
  cancelYes: { en: 'Yes, cancel my order', ur: 'جی ہاں، آرڈر منسوخ کریں' },
  keepLink: { en: 'No, keep my order', ur: 'نہیں، آرڈر برقرار رکھیں' },
  confirmedTitle: { en: 'Order confirmed', ur: 'آرڈر کنفرم ہو گیا' },
  placedTitle: { en: 'Order placed', ur: 'آرڈر موصول ہو گیا' },
  awaitingPaymentTitle: { en: 'Waiting for your payment', ur: 'آپ کی ادائیگی کا انتظار ہے' },
  receiptTitle: { en: 'Your receipt', ur: 'آپ کی رسید' },
  receiptFile: { en: 'Photo or PDF of the receipt', ur: 'رسید کی تصویر یا پی ڈی ایف' },
  sendReceipt: { en: 'Send receipt', ur: 'رسید بھیجیں' },
  onItsWayTitle: { en: 'On its way', ur: 'آرڈر راستے میں ہے' },
  outForDeliveryTitle: { en: 'Out for delivery', ur: 'آرڈر ڈیلیوری کے لیے نکل چکا ہے' },
  readyForPickupTitle: { en: 'Ready for pickup', ur: 'آرڈر وصولی کے لیے تیار ہے' },
  deliveredTitle: { en: 'Delivered', ur: 'آرڈر پہنچ گیا' },
  notDeliveredTitle: { en: 'Not delivered', ur: 'آرڈر ڈیلیور نہیں ہوا' },
  cancelledTitle: { en: 'Order cancelled', ur: 'آرڈر منسوخ ہو گیا' },
  mergedTitle: { en: 'Orders joined', ur: 'آرڈر ملا دیے گئے' },
  expiredTitle: { en: 'This link has expired', ur: 'اس لنک کی مدت ختم ہو گئی ہے' },
  notFoundTitle: { en: "This link doesn't work", ur: 'یہ لنک کام نہیں کر رہا' },
  addressTitle: { en: 'Change the address', ur: 'پتہ تبدیل کریں' },
  addAddress: { en: 'Add your address', ur: 'اپنا پتہ لکھیں' },
  name: { en: 'Name', ur: 'نام' },
  address1: { en: 'House and street', ur: 'مکان اور گلی' },
  address2: { en: 'Area (optional)', ur: 'علاقہ (اختیاری)' },
  landmark: { en: 'Nearest landmark (optional)', ur: 'قریبی نشانی (اختیاری)' },
  city: { en: 'City', ur: 'شہر' },
  province: { en: 'Province', ur: 'صوبہ' },
  fromCity: { en: 'From the city', ur: 'شہر کے مطابق' },
  zip: { en: 'Postcode (optional)', ur: 'پوسٹ کوڈ (اختیاری)' },
  phone: { en: 'Phone', ur: 'فون' },
  mobile: { en: 'Mobile number', ur: 'موبائل نمبر' },
  saveAddress: { en: 'Save address', ur: 'پتہ محفوظ کریں' },
  payOnline: { en: 'Pay online', ur: 'آن لائن ادائیگی کریں' },
  backToOrder: { en: 'Back to my order', ur: 'واپس اپنے آرڈر پر' },
  trackTitle: { en: 'Track your order', ur: 'اپنا آرڈر ٹریک کریں' },
  trackAnother: { en: 'Track another order', ur: 'کوئی اور آرڈر ٹریک کریں' },
  reference: { en: 'Order or tracking number', ur: 'آرڈر یا ٹریکنگ نمبر' },
  findOrder: { en: 'Find my order', ur: 'میرا آرڈر تلاش کریں' },
  reviewTitle: { en: 'Rate what you bought', ur: 'اپنی خریداری کو ریٹ کریں' },
  reviewWords: { en: 'Your words (optional)', ur: 'آپ کی رائے (اختیاری)' },
  sendReview: { en: 'Send my rating', ur: 'ریٹنگ بھیجیں' },
  returnTitle: { en: 'Send something back', ur: 'کوئی چیز واپس بھیجیں' },
  returnHowMany: { en: 'How many', ur: 'کتنے' },
  returnWhy: { en: 'Why', ur: 'وجہ' },
  chooseWhy: { en: 'Choose why', ur: 'وجہ منتخب کریں' },
  returnInstead: { en: 'What would you like instead?', ur: 'بدلے میں آپ کیا چاہیں گے؟' },
  returnNote: { en: 'Anything to add (optional)', ur: 'مزید کچھ کہنا ہو (اختیاری)' },
  sendReturn: { en: 'Ask for a return', ur: 'واپسی کی درخواست بھیجیں' },
  skipNext: { en: 'Skip the next order', ur: 'اگلا آرڈر چھوڑ دیں' },
  pauseSubscription: { en: 'Pause', ur: 'روک دیں' },
  resumeSubscription: { en: 'Resume', ur: 'دوبارہ شروع کریں' },
  cancelSubscription: { en: 'Cancel the subscription', ur: 'سبسکرپشن منسوخ کریں' },
} satisfies Record<string, Words>;

/** Why an item goes back, as the order's page offers it (ADR-675). */
const RETURN_REASON_LABELS = {
  size_too_small: { en: 'Too small', ur: 'چھوٹا ہے' },
  size_too_large: { en: 'Too large', ur: 'بڑا ہے' },
  unwanted: { en: 'Not wanted any more', ur: 'اب نہیں چاہیے' },
  not_as_described: { en: 'Not as described', ur: 'بتائے گئے کے مطابق نہیں' },
  wrong_item: { en: 'The wrong item came', ur: 'غلط چیز آئی' },
  defective: { en: 'Faulty or damaged', ur: 'خراب یا ٹوٹا ہوا' },
  other: { en: 'Another reason', ur: 'کوئی اور وجہ' },
} satisfies Record<ReturnReasonValue, Words>;

/** What the shopper may ask for instead of what they send back (ADR-675). */
const RETURN_PREFERENCE_LABELS = {
  exchange: { en: 'Another size or item', ur: 'دوسرا سائز یا کوئی اور چیز' },
  store_credit: { en: 'Store credit', ur: 'اسٹور کریڈٹ' },
  refund: { en: 'My money back', ur: 'میری رقم واپس' },
} satisfies Record<ReturnPreferenceValue, Words>;

/** A parcel's steps, as its page names them (ADR-160): shipped, then each its courier told of. */
const STEP_LABELS = {
  shipped: { en: 'Shipped', ur: 'روانہ ہو گیا' },
  confirmed: { en: 'Booked with the courier', ur: 'کوریئر کے پاس بک ہو گیا' },
  in_transit: { en: 'On its way', ur: 'راستے میں ہے' },
  out_for_delivery: { en: 'Out for delivery', ur: 'ڈیلیوری کے لیے نکل چکا ہے' },
  attempted_delivery: { en: 'Delivery tried', ur: 'ڈیلیوری کی کوشش کی گئی' },
  delivered: { en: 'Delivered', ur: 'پہنچ گیا' },
  returning: { en: 'Going back to the shop', ur: 'دکان کو واپس جا رہا ہے' },
  returned: { en: 'Back with the shop', ur: 'دکان کو واپس پہنچ گیا' },
  failure: { en: 'Not delivered', ur: 'ڈیلیور نہیں ہوا' },
} satisfies Record<FulfillmentEventStatusValue | 'shipped', Words>;

/** The steps of an order's parcels, by parcel, each parcel's in the order they happened. */
export type ParcelSteps = ReadonlyMap<string, readonly FulfillmentEventRecord[]>;

const NO_STEPS: ParcelSteps = new Map();

/** Options for {@link draftLinkPage} and {@link orderLinkPage}. */
export interface LinkPageOptions {
  /**
   * The form the customer asked for, or posted: whether they mean to cancel the order (on an
   * order's link), or its delivery address to fill in or correct.
   */
  form?: 'cancel' | 'address';
  /** Their new address was saved just now. */
  saved?: boolean;
  /** The receipt of their transfer was taken just now (ADR-080). */
  sent?: boolean;
  /** They came back from paying online, and the shop's gateway said it is in (ADR-151). */
  paid?: boolean;
  /** Their rating of what the order brought them was taken just now (ADR-399). */
  reviewed?: boolean;
  /** The item offered them was added just now (ADR-438). */
  added?: boolean;
  /** The return they asked for was taken just now (ADR-675). */
  asked?: boolean;
  /** The tiles of a map to move the address's pin on (ADR-720); none for no map. */
  map?: MapTiles | null;
}

/**
 * The page a draft's link shows: the order to confirm, after the customer adds their address if
 * it has none; once it became an order, how the order is doing; or why there is nothing to show.
 * Bilingual, as the customer's language is not known. Their number is masked, since links get
 * forwarded; the address is whole, for them to check and correct.
 */
export function draftLinkPage(view: DraftLinkView, options: LinkPageOptions = {}): LinkPage {
  switch (view.kind) {
    case 'not_found':
      return notFoundPage();
    case 'expired':
      return expiredPage(view.shop);
    case 'open': {
      const { shop, draft, problem } = view;
      const shown = shownOfDraft(draft, view.tax, view.terms);
      if (options.form === 'address' && onAddressForm(problem)) {
        return addressPage({
          shop,
          address: draft.shippingAddress,
          phone: draft.phone,
          shown,
          digest: view.shown,
          problem,
          map: options.map,
        });
      }
      return confirmPage({
        shop,
        shown,
        digest: view.shown,
        problem,
        saved: Boolean(options.saved) && !problem,
        changeable: true,
        expiresAt: draft.linkExpiresAt,
      });
    }
    case 'completed':
      return (
        orderAddressPage(view, options) ??
        statusPage(view.shop, view.order, {
          problem: view.problem,
          saved: Boolean(options.saved) && !view.problem,
          sent: Boolean(options.sent) && !view.problem,
          changeable: addressChangeable(view.order),
          receipts: view.receipts,
        })
      );
  }
}

/**
 * The page an order's link shows: while a cash-on-delivery order waits for its customer, the
 * order to confirm or cancel; after that, how the order is doing; or why there is nothing to show.
 * Until the order is packed, its address can be corrected on a form of its own. The form asked
 * for comes instead while the order takes it: a cancel form that asks whether they are sure, or
 * the address, filled in as it is or as they typed it.
 */
export function orderLinkPage(view: OrderLinkView, options: LinkPageOptions = {}): LinkPage {
  switch (view.kind) {
    case 'not_found':
      return notFoundPage();
    case 'expired':
      return expiredPage(view.shop);
    case 'order': {
      if (view.gatewayForm && view.onlinePayment) return gatewayFormPage(view);
      const addressForm = orderAddressPage(view, options);
      if (addressForm) return addressForm;
      const { shop, order, problem } = view;
      const saved = Boolean(options.saved) && !problem;
      const changeable = addressChangeable(order);
      if (options.form === 'cancel' && view.cancellable && !problem) {
        return cancelPage(shop, order, view.shown);
      }
      if (!awaitsCustomer(order)) {
        return statusPage(shop, order, {
          problem,
          saved,
          sent: Boolean(options.sent) && !problem,
          paid: Boolean(options.paid) && !problem && view.order.status === 'open',
          changeable,
          cancellable: view.cancellable,
          receipts: view.receipts,
          onlinePayment: view.onlinePayment,
          steps: view.steps,
          reviewable: view.reviewable,
          reviewed: Boolean(options.reviewed) && !problem,
          offer: view.offer,
          added: Boolean(options.added) && !problem,
          storeCredit: view.storeCredit,
          returns: view.returns,
          subscription: view.subscription,
          asked: Boolean(options.asked) && !problem,
        });
      }
      return confirmPage({
        shop,
        shown: shownOfOrder(order, view.terms),
        digest: view.shown,
        problem,
        saved,
        changeable,
        expiresAt: order.link?.expiresAt ?? null,
        order,
      });
    }
  }
}

/**
 * An order's address form, if the customer asked for it or posted it and the order still takes a
 * new address; null for the page they would see otherwise.
 */
function orderAddressPage(
  view: { shop: LinkShop; order: OrderRecord; shown: string; problem: LinkProblem | null },
  options: LinkPageOptions,
): LinkPage | null {
  const { shop, order, problem } = view;
  if (options.form !== 'address' || !addressChangeable(order) || !onAddressForm(problem)) {
    return null;
  }
  return addressPage({
    shop,
    name: orderName(order.number),
    address: order.shippingAddress,
    phone: order.phone,
    shown: shownOfOrder(order),
    digest: view.shown,
    problem,
    map: options.map,
  });
}

/** Whether the address form shows `problem` itself, rather than the page behind it. */
function onAddressForm(problem: LinkProblem | null): boolean {
  return !problem || problem.kind === 'address' || problem.kind === 'changed';
}

function notFoundPage(): LinkPage {
  return page(404, LABELS.notFoundTitle.en, null, [
    heading(LABELS.notFoundTitle),
    paragraphs(
      {
        en: 'It may have been replaced by a newer one. Ask the shop in your chat for a new link.',
        ur: 'ہو سکتا ہے اس کی جگہ نیا لنک بھیجا گیا ہو۔ اپنی چیٹ میں دکان سے نیا لنک مانگیں۔',
      },
      'center muted',
    ),
  ]);
}

function expiredPage(shop: LinkShop): LinkPage {
  return page(410, `${LABELS.expiredTitle.en} · ${shop.name}`, shop, [
    shopName(shop),
    heading(LABELS.expiredTitle),
    paragraphs(
      {
        en: `Ask ${shop.name} in your chat for a new link.`,
        ur: 'اپنی چیٹ میں دکان سے نیا لنک مانگیں۔',
      },
      'center muted',
    ),
  ]);
}

/**
 * The order to confirm: a draft's, or an order's, which the customer may cancel too. While it is
 * `changeable`, they may change its address; a draft without one asks for it before it can be
 * confirmed. The form carries `digest`, what the page showed, and above its button what
 * confirming a draft agrees to (ADR-114).
 */
function confirmPage(options: {
  shop: LinkShop;
  shown: ShownOrder;
  digest: string;
  problem: LinkProblem | null;
  saved?: boolean;
  changeable: boolean;
  expiresAt: Date | null;
  order?: OrderRecord;
}): LinkPage {
  const { shop, shown, problem, order } = options;
  const addressed = shown.address !== null;
  return page(problem ? 409 : 200, `${LABELS.confirmTitle.en} · ${shop.name}`, shop, [
    shopName(shop),
    heading(LABELS.confirmTitle),
    order && html`<p class="center muted">${ltr(orderName(order.number))}</p>`,
    order?.splitFrom && paragraphs(partWords(order.splitFrom), 'center small muted'),
    problem && banner(problemWords(problem, shown)),
    options.saved && savedNotice(),
    summary(shown),
    addressed ? address(shown, { changeable: options.changeable }) : addressWanted(),
    // A draft asking for an advance (ADR-085), or paid by transfer (ADR-223): the account comes
    // with the order.
    addressed &&
      shown.transfer > 0n &&
      paragraphs(shown.cashOnDelivery ? advanceWords(shown) : payAheadWords(shown), 'center'),
    addressed &&
      html`<form method="post">
        <input type="hidden" name="action" value="confirm" />
        <input type="hidden" name="shown" value="${options.digest}" />
        ${shown.terms.length > 0 && paragraphs(termsWords(shown.terms), 'small muted')}
        <button class="button stack" type="submit">${say('bilingual', LABELS.confirm)}</button>
      </form>`,
    order && cancelLink(),
    paragraphs(
      {
        en: 'Anything wrong? Reply to the shop in your chat before you confirm.',
        ur: 'کچھ غلط ہے؟ کنفرم کرنے سے پہلے اپنی چیٹ میں دکان کو بتائیں۔',
      },
      'small muted',
    ),
    options.expiresAt
      ? until(options.expiresAt, shop.timezone)
      : order &&
        paragraphs(
          {
            en: 'Keep this link: it shows where your order is until it arrives.',
            ur: 'یہ لنک محفوظ رکھیں: آرڈر پہنچنے تک آپ یہاں دیکھ سکیں گے کہ وہ کہاں ہے۔',
          },
          'small muted',
        ),
  ]);
}

/** Which order an order split from another is part of (ADR-135), as its customer placed one. */
function partWords(splitFrom: { number: number }): Sentence {
  const from = orderName(splitFrom.number);
  return {
    en: `Part of your order ${from}, sent on its own.`,
    ur: html`یہ آپ کے آرڈر ${ltr(from)} کا حصہ ہے، جو الگ سے بھیجا جا رہا ہے۔`,
  };
}

/**
 * What confirming a draft agrees to (ADR-114), as checkout says what placing an order does
 * (ADR-057): the shop's policies, each opening beside the page, which keeps the order there.
 */
function termsWords(terms: readonly ShownTerm[]): Sentence {
  const link = (term: ShownTerm, title: string) =>
    html`<a href="${term.url}" target="_blank" rel="noopener">${title}</a>`;
  const en = terms.map((term) => link(term, POLICY_TITLES[term.type].en.toLowerCase()));
  const ur = terms.map((term) => link(term, POLICY_TITLES[term.type].ur));
  return {
    en: html`By confirming your order, you agree to the shop's ${listOf(en, ', ', ' and ')}.`,
    ur: html`آرڈر کنفرم کر کے آپ دکان کی ان پالیسیوں سے اتفاق کرتے ہیں:
    ${listOf(ur, '، ', ' اور ')}۔`,
  };
}

/** "a", "a and b", "a, b and c", with the language's comma and "and". */
function listOf(items: readonly Html[], comma: string, and: string): HtmlValue[] {
  return items.map((item, index) => [
    index === 0 ? '' : index === items.length - 1 ? and : comma,
    item,
  ]);
}

/** What a draft asking for an advance tells its customer before they confirm it. */
function advanceWords(shown: ShownOrder): Sentence {
  const advance = amount(shown.transfer, shown.currency);
  return {
    en:
      `Once you confirm, pay ${advance} in advance by bank transfer, to the account the next ` +
      'page shows; the rest when your order arrives.',
    ur: html`کنفرم کرنے کے بعد ${ltr(advance)} ایڈوانس بینک ٹرانسفر سے ادا کریں، اگلے صفحے پر دیے
    گئے اکاؤنٹ میں؛ باقی رقم آرڈر ملنے پر۔`,
  };
}

/**
 * What a draft paid by transfer asks once confirmed (ADR-223): all of it, by transfer to the
 * account its order's page shows, or online there where the shop takes payments online.
 */
function payAheadWords(shown: ShownOrder): Sentence {
  const total = amount(shown.transfer, shown.currency);
  return {
    en:
      `Once you confirm, pay ${total} by bank transfer, to the account the next page shows, or ` +
      'online there where the shop takes it. The shop sends your order once it is paid.',
    ur: html`کنفرم کرنے کے بعد ${ltr(total)} بینک ٹرانسفر سے اگلے صفحے پر دیے گئے اکاؤنٹ میں ادا
    کریں، یا وہیں آن لائن اگر دکان آن لائن ادائیگی لیتی ہے۔ ادائیگی ملتے ہی دکان آپ کا آرڈر بھیج دے
    گی۔`,
  };
}

/** The way to the page that asks whether the customer means to cancel. */
function cancelLink(): Html {
  return html`<div class="text center small">
    <p><a href="?cancel">${say('bilingual', LABELS.cancelLink)}</a></p>
  </div>`;
}

/** Asks whether the customer means to cancel, before anything happens. */
function cancelPage(shop: LinkShop, order: OrderRecord, digest: string): LinkPage {
  const name = orderName(order.number);
  return page(200, `${LABELS.cancelTitle.en} · ${shop.name}`, shop, [
    shopName(shop),
    heading(LABELS.cancelTitle),
    paragraphs(
      {
        en: `Order ${name} will be cancelled, and nothing will be sent to you.`,
        ur: html`آرڈر ${ltr(name)} منسوخ ہو جائے گا اور آپ کو کچھ نہیں بھیجا جائے گا۔`,
      },
      'center',
    ),
    html`<form method="post">
      <input type="hidden" name="action" value="cancel" />
      <input type="hidden" name="shown" value="${digest}" />
      <button class="button danger stack" type="submit">
        ${say('bilingual', LABELS.cancelYes)}
      </button>
    </form>`,
    html`<p class="center"><a href="?">${say('bilingual', LABELS.keepLink)}</a></p>`,
  ]);
}

/**
 * The delivery address to fill in or correct: as it is, or as the customer typed it, with what is
 * wrong. A number the shop has is shown masked, and is for the shop to change; without one, as on
 * a draft sent before the customer gave their address, the form asks for it.
 */
function addressPage(options: {
  shop: LinkShop;
  /** The order's, "#1001"; none for a draft. */
  name?: string;
  address: StoredAddressValue | null;
  phone: string | null;
  shown: ShownOrder;
  digest: string;
  problem: LinkProblem | null;
  /** The tiles of a map to move the pin on (ADR-720); none for no map. */
  map?: MapTiles | null;
}): LinkPage {
  const { shop, problem, digest, map } = options;
  const typed = problem?.kind === 'address' ? problem : null;
  const form = typed?.form ?? formOf(options.address);
  const errors = typed?.errors ?? [];
  const title = options.address ? LABELS.addressTitle : LABELS.addAddress;
  const notice: Sentence | null =
    problem?.kind === 'changed'
      ? {
          en: 'This order changed after you opened it. Check the address again, then save it.',
          ur: 'آپ کے کھولنے کے بعد اس آرڈر میں تبدیلی ہوئی ہے۔ پتہ دوبارہ دیکھ کر محفوظ کریں۔',
        }
      : problem && problemWords(problem, options.shown);
  return page(
    typed ? 422 : problem ? 409 : 200,
    `${title.en} · ${shop.name}`,
    shop,
    [
      shopName(shop),
      heading(title),
      options.name && html`<p class="center muted">${ltr(options.name)}</p>`,
      notice && banner(notice),
      html`<form method="post">
        <input type="hidden" name="action" value="address" />
        <input type="hidden" name="shown" value="${digest}" />
        ${textField('name', LABELS.name, form, errors, { autocomplete: 'name', required: true })}
        ${textField('address1', LABELS.address1, form, errors, {
          autocomplete: 'address-line1',
          required: true,
        })}
        ${textField('address2', LABELS.address2, form, errors, {
          autocomplete: 'address-line2',
          list: 'areas',
        })}
        ${areaList(form.city)}
        ${textField('landmark', LABELS.landmark, form, errors, {
          autocomplete: 'address-line3',
          hint: LANDMARK_HINT,
        })}
        ${textField('city', LABELS.city, form, errors, {
          autocomplete: 'address-level2',
          required: true,
        })}
        ${provinceField(form.province, errors)}
        ${textField('zip', LABELS.zip, form, errors, { autocomplete: 'postal-code', kind: 'digits' })}
        ${phoneField(options.phone, form, errors)} ${locationField(form, errors, form.city, map)}
        <button class="button stack" type="submit">${say('bilingual', LABELS.saveAddress)}</button>
      </form>`,
      html`<p class="center"><a href="?">${say('bilingual', LABELS.backToOrder)}</a></p>`,
    ],
    // The map's script and its tiles' source where there is one (ADR-720).
    map
      ? { scripts: [LOCATION_SCRIPT, MAP_SCRIPT], images: [map.source] }
      : { scripts: [LOCATION_SCRIPT] },
  );
}

/**
 * The form filled in with an address, or empty for none. Its province is left to the city when it
 * is the city's, so that a new city brings its own. The number is never filled in: the page does
 * not show it whole.
 */
function formOf(to: StoredAddressValue | null): AddressForm {
  if (!to) {
    return {
      name: '',
      address1: '',
      address2: '',
      landmark: '',
      city: '',
      province: '',
      zip: '',
      phone: '',
      ...locationFormOf(null),
    };
  }
  const province = to.provinceCode !== findCity(to.city)?.province ? to.provinceCode : null;
  return {
    name: to.name ?? '',
    address1: to.address1 ?? '',
    address2: to.address2 ?? '',
    landmark: to.landmark ?? '',
    city: to.city,
    province: province ?? '',
    zip: to.zip ?? '',
    phone: '',
    ...locationFormOf(to.location),
  };
}

/**
 * A labelled box of the address form, with a hint and what is wrong with it underneath.
 * Autocomplete names the delivery address, for phones that fill it in; typed text runs in its
 * script's direction, and digits and numbers left to right.
 */
function textField(
  name: Exclude<keyof AddressForm, 'province' | 'latitude' | 'longitude'>,
  label: Words,
  form: AddressForm,
  errors: readonly FieldError[],
  options: {
    autocomplete: string;
    required?: boolean;
    kind?: 'digits' | 'tel';
    hint?: Sentence;
    /** The suggestions it offers, by their list's ID. */
    list?: string;
  },
): Html {
  const error = errors.find((each) => each.field[0] === name);
  const described = [options.hint && `${name}-hint`, error && `${name}-error`].filter(Boolean);
  const kind = {
    text: html`type="text" dir="auto"`,
    digits: html`type="text" inputmode="numeric" dir="ltr"`,
    tel: html`type="tel" dir="ltr"`,
  }[options.kind ?? 'text'];
  return html`<div class="field">
    <label class="label" for="${name}">${say('bilingual', label)}</label>
    <input
      id="${name}"
      name="${name}"
      ${kind}
      value="${form[name]}"
      autocomplete="shipping ${options.autocomplete}"
      ${options.list && html`list="${options.list}"`}
      ${options.required && html`aria-required="true"`}
      ${error && html`aria-invalid="true"`}
      ${described.length > 0 && html`aria-describedby="${described.join(' ')}"`}
    />
    ${options.hint && html`<div id="${name}-hint">${paragraphs(options.hint, 'small muted')}</div>`}
    ${error && fieldError(name, error)}
  </div>`;
}

/**
 * The areas the area's box suggests: the city's, or every listed city's, each by its city, while
 * the form has none. Suggestions only: any area may be typed.
 */
function areaList(city: string): Html {
  const options = areaSuggestions(city).map((area) =>
    area.city
      ? html`<option value="${area.value}" label="${area.city}"></option>`
      : html`<option value="${area.value}"></option>`,
  );
  return html`<datalist id="areas">${options}</datalist>`;
}

/** What the landmark's box asks for, under it. */
const LANDMARK_HINT: Sentence = {
  en: 'A mosque, school or shop near you that the rider can ask for.',
  ur: 'آپ کے قریب کوئی مسجد، اسکول یا دکان جس کا رائیڈر پوچھ سکے۔',
};

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
    ${error && fieldError('province', error)}
  </div>`;
}

/**
 * The number the shop has, masked: the customer can see it is theirs, and ask the shop to change
 * it. Without one, a box for it.
 */
function phoneField(phone: string | null, form: AddressForm, errors: readonly FieldError[]): Html {
  if (phone === null) {
    return textField('phone', LABELS.mobile, form, errors, {
      autocomplete: 'tel',
      required: true,
      kind: 'tel',
      hint: {
        en: 'The courier calls this number before delivering.',
        ur: 'کوریئر ڈیلیوری سے پہلے اس نمبر پر کال کرے گا۔',
      },
    });
  }
  return html`<div class="field">
    <p class="label">${say('bilingual', LABELS.phone)}</p>
    <p>${ltr(maskPkMobile(phone))}</p>
    ${paragraphs(
      {
        en: 'To change the number, ask the shop in your chat.',
        ur: 'نمبر تبدیل کرنے کے لیے اپنی چیٹ میں دکان سے کہیں۔',
      },
      'small muted',
    )}
  </div>`;
}

/** What is wrong with a field, in words for the customer, under its box. */
function fieldError(name: string, error: FieldError): Html {
  return html`<div id="${name}-error">${paragraphs(errorWords(error), 'error')}</div>`;
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
    case 'zip':
      return {
        en: 'A postcode has five digits, like 54000.',
        ur: html`پوسٹ کوڈ پانچ ہندسوں کا ہوتا ہے، جیسے ${ltr('54000')}۔`,
      };
    case 'phone':
      return error.code === 'BLANK'
        ? { en: 'Enter your mobile number.', ur: 'اپنا موبائل نمبر لکھیں۔' }
        : {
            en: 'Enter a Pakistani mobile number, like 0300 1234567.',
            ur: html`پاکستانی موبائل نمبر لکھیں، جیسے ${ltr('0300 1234567')}۔`,
          };
    default:
      return { en: 'Check this.', ur: 'اسے دوبارہ دیکھیں۔' };
  }
}

/**
 * How the order is doing, once it no longer waits for the customer. Before it ships, it shows
 * where the order goes, with a way to change that while it is `changeable`: on an order's link,
 * until it is packed.
 */
function statusPage(
  shop: LinkShop,
  order: OrderRecord,
  options: {
    problem?: LinkProblem | null;
    saved?: boolean;
    changeable?: boolean;
    /** Whether the customer may still cancel it here, as the shop's settings allow. */
    cancellable?: boolean;
    /** Their receipt was taken just now. */
    sent?: boolean;
    /** How many receipts for its transfer they sent. */
    receipts?: number;
    /** They came back from paying online, and it is in. */
    paid?: boolean;
    /** What the shop's gateways take online of what the order waits for (ADR-151, ADR-219). */
    onlinePayment?: {
      gateways: OnlineGateway[];
      amount: bigint;
      credit?: bigint | null;
      door?: boolean;
    } | null;
    /** Its parcels' steps on their way (ADR-160). */
    steps?: ParcelSteps;
    /** Once delivered, its products to rate (ADR-399). */
    reviewable?: readonly ReviewableProduct[];
    /** Their rating was taken just now. */
    reviewed?: boolean;
    /** A product offered them to add, paid at the door (ADR-438). */
    offer?: PostPurchaseOffer | null;
    /** The item offered them was added just now. */
    added?: boolean;
    /** What the customer has of store credit with the shop (ADR-596), minor units; 0 for none. */
    storeCredit?: bigint;
    /** Once delivered, what may go back, and their latest return request (ADR-675). */
    returns?: ReturnOffer | null;
    /** The return they asked for was taken just now. */
    asked?: boolean;
    /** The subscription the order is of (ADR-862), to skip, pause, resume or cancel. */
    subscription?: SubscriptionLinkView | null;
  },
): LinkPage {
  const {
    problem = null,
    saved = false,
    sent = false,
    paid = false,
    changeable = false,
    cancellable = false,
    receipts = 0,
    onlinePayment = null,
    steps = NO_STEPS,
    reviewable = [],
    reviewed = false,
    offer = null,
    added = false,
    storeCredit = 0n,
    returns = null,
    asked = false,
    subscription = null,
  } = options;
  const name = orderName(order.number);
  const shown = shownOfOrder(order);
  // What an order on payment terms owes, by transfer, and by when (ADR-920).
  const owing = order.stage === 'cancelled' ? null : termsOwed(order);
  const onTerms = owing &&
    owing.owed > 0n && [
      paragraphs(
        paymentTermsWords(order, owing.owed, owing.overdue, shop.timezone),
        owing.overdue ? 'center error' : 'center strong',
      ),
      transferDetails(order),
      receiptForm(receipts),
    ];
  const pay =
    shown.due > 0n &&
    paragraphs(
      {
        en: `You pay ${amount(shown.due, shown.currency)} when it arrives.`,
        ur: html`آرڈر ملنے پر ${ltr(amount(shown.due, shown.currency))} ادا کریں۔`,
      },
      'center strong',
    );
  const show = (title: Words, sentence: Sentence, mark: boolean, ...rest: HtmlValue[]) =>
    page(
      !problem || (problem.kind === 'payment' && problem.reason !== 'unavailable')
        ? 200
        : problem.kind === 'receipt' ||
            problem.kind === 'review' ||
            (problem.kind === 'return' && problem.reason !== 'waiting')
          ? 422
          : problem.kind === 'payment'
            ? 503
            : 409,
      `${title.en} · ${shop.name}`,
      shop,
      [
        shopName(shop),
        problem && banner(problemWords(problem, shown)),
        saved && savedNotice(),
        sent && receiptNotice(shop),
        paid && onlinePaidNotice(shop.name),
        reviewed && reviewedNotice(shop),
        added && addedNotice(),
        asked && askedNotice(shop),
        mark && html`<div class="mark" aria-hidden="true">✓</div>`,
        heading(title),
        paragraphs(sentence, 'center'),
        order.splitFrom && paragraphs(partWords(order.splitFrom), 'center small muted'),
        ...(onTerms || []),
        ...rest,
        // The customer's store credit, which pays their next order at checkout (ADR-596).
        storeCredit > 0n &&
          paragraphs(
            storeCreditWords(amount(storeCredit, order.currency), shop.name),
            'center small',
          ),
        // The subscription it is of (ADR-862).
        subscription && subscriptionSection(subscription),
      ],
      // Paying online answers with a gateway's page: the form goes on there.
      { formTargets: gatewayOrigins(onlinePayment?.gateways ?? []) },
    );

  switch (order.stage) {
    case 'cancelled':
      if (order.mergedInto) {
        const into = orderName(order.mergedInto.number);
        return show(
          LABELS.mergedTitle,
          {
            en:
              `Your order ${name} was joined with your order ${into}, and ${shop.name} will ` +
              `send them together as ${into}.`,
            ur: html`آپ کا آرڈر ${ltr(name)} آپ کے آرڈر ${ltr(into)} کے ساتھ ملا دیا گیا ہے، اور
            دکان دونوں کو ${ltr(into)} کے طور پر ایک ساتھ بھیجے گی۔`,
          },
          false,
        );
      }
      return show(
        LABELS.cancelledTitle,
        {
          en: `Your order ${name} was cancelled. Ask ${shop.name} in your chat if this is a mistake.`,
          ur: html`آپ کا آرڈر ${ltr(name)} منسوخ ہو چکا ہے۔ اگر یہ غلطی ہے تو اپنی چیٹ میں دکان سے
          پوچھیں۔`,
        },
        false,
      );
    case 'to_pack':
    case 'to_book':
      // Collected rather than sent (ADR-389): no address for it to go to.
      if (order.deliveryMethod === 'pickup') {
        return show(
          LABELS.confirmedTitle,
          {
            en:
              `Thank you! Your order ${name} is confirmed. ${shop.name} will tell you when it is ` +
              'ready for you to pick up.',
            ur: html`شکریہ! آپ کا آرڈر ${ltr(name)} کنفرم ہو گیا ہے۔ وصولی کے لیے تیار ہونے پر دکان
            آپ کو بتائے گی۔`,
          },
          true,
          summary(shown),
          cancellable && cancelLink(),
        );
      }
      return show(
        LABELS.confirmedTitle,
        {
          en: `Thank you! Your order ${name} is confirmed, and ${shop.name} will send it soon.`,
          ur: html`شکریہ! آپ کا آرڈر ${ltr(name)} کنفرم ہو گیا ہے اور جلد روانہ کر دیا جائے گا۔`,
        },
        true,
        pay,
        // Store credit offered for paying the rest online instead (ADR-432).
        onlinePayment && payOnlineForm(onlinePayment, shown.currency, false),
        // Something to add to it, paid at the door with the rest (ADR-438).
        offer && offerForm(offer, shown.currency),
        summary(shown),
        address(shown, { changeable }),
        cancellable && cancelLink(),
      );
    case 'ready_for_pickup':
      return show(
        LABELS.readyForPickupTitle,
        {
          en: `Your order ${name} is ready. Collect it from ${shop.name}, as they told you.`,
          ur: html`آپ کا آرڈر ${ltr(name)} تیار ہے۔ دکان کے بتائے ہوئے پتے سے وصول کریں۔`,
        },
        true,
        shown.due > 0n &&
          paragraphs(
            {
              en: `You pay ${amount(shown.due, shown.currency)} when you collect it.`,
              ur: html`وصولی پر ${ltr(amount(shown.due, shown.currency))} ادا کریں۔`,
            },
            'center strong',
          ),
        summary(shown),
      );
    case 'partially_fulfilled':
    case 'in_transit':
      // With the rider now, as the courier last said of a parcel on its way; or with the shop's
      // own rider, who may be paid online instead of in cash (ADR-846).
      if (
        order.doorParcelId !== null ||
        order.fulfillments.some(
          (parcel) =>
            parcel.status === 'in_transit' &&
            steps.get(parcel.id)?.at(-1)?.status === 'out_for_delivery',
        )
      ) {
        return show(
          LABELS.outForDeliveryTitle,
          {
            en: `Your order ${name} is out for delivery today.`,
            ur: html`آپ کا آرڈر ${ltr(name)} آج ڈیلیوری کے لیے نکل چکا ہے۔`,
          },
          false,
          pay,
          onlinePayment?.door && payOnlineForm(onlinePayment, shown.currency, false),
          parcels(order, steps, shop.timezone),
          summary(shown),
        );
      }
      return show(
        LABELS.onItsWayTitle,
        {
          en: `Your order ${name} is on its way.`,
          ur: html`آپ کا آرڈر ${ltr(name)} راستے میں ہے۔`,
        },
        false,
        pay,
        parcels(order, steps, shop.timezone),
        summary(shown),
      );
    case 'delivered':
    case 'completed':
      return show(
        LABELS.deliveredTitle,
        {
          en: `Your order ${name} was delivered. Thank you for shopping with ${shop.name}!`,
          ur: html`آپ کا آرڈر ${ltr(name)} پہنچ گیا ہے۔ خریداری کا شکریہ!`,
        },
        true,
        reviewForm(reviewable),
        returns && returnSection(shop, returns),
        parcels(order, steps, shop.timezone),
      );
    case 'returning':
    case 'returned':
      return show(
        LABELS.notDeliveredTitle,
        {
          en:
            `Your order ${name} was not delivered and is going back to ${shop.name}. Ask them ` +
            'in your chat if this is a mistake.',
          ur: html`آپ کا آرڈر ${ltr(name)} ڈیلیور نہیں ہوا اور دکان کو واپس بھیجا جا رہا ہے۔ اگر یہ
          غلطی ہے تو اپنی چیٹ میں دکان سے پوچھیں۔`,
        },
        false,
        parcels(order, steps, shop.timezone),
      );
    case 'lost':
      return show(
        LABELS.notDeliveredTitle,
        {
          en:
            `Your order ${name} could not be delivered: the courier lost the parcel. ` +
            `${shop.name} will be in touch.`,
          ur: html`آپ کا آرڈر ${ltr(name)} ڈیلیور نہیں ہو سکا: کوریئر سے پارسل گم ہو گیا۔ دکان آپ سے
          رابطہ کرے گی۔`,
        },
        false,
      );
    case 'awaiting_payment':
      return show(
        LABELS.awaitingPaymentTitle,
        transferWords(order, shop.name),
        false,
        // The rest of a cash-on-delivery order, once its advance is in.
        pay,
        onlinePayment && payOnlineForm(onlinePayment, shown.currency, order.bankAccount !== null),
        transferDetails(order),
        // Paid online alone: no transfer, so no receipt.
        order.paymentMethod !== 'online' && receiptForm(receipts),
        summary(shown),
        address(shown, { changeable }),
        cancellable && cancelLink(),
      );
    case 'needs_confirmation':
    case 'needs_review':
      // Placed by staff and not confirmed yet, or held for review: the customer is not told
      // which.
      return show(
        LABELS.placedTitle,
        {
          en: `Thank you! ${shop.name} has your order ${name} and will be in touch before sending it.`,
          ur: html`شکریہ! آپ کا آرڈر ${ltr(name)} موصول ہو گیا ہے۔ بھیجنے سے پہلے دکان آپ سے رابطہ
          کرے گی۔`,
        },
        true,
        pay,
        summary(shown),
        address(shown, { changeable }),
        cancellable && cancelLink(),
      );
  }
}

/**
 * The shop's tracking page (SHP-05, ADR-251): the form that finds an order by its number or a
 * parcel's tracking number, with the mobile number it was placed with; once found, how it is
 * doing and its parcels' steps, but nothing of its address or items, and the form again below.
 */
export function trackingPage(view: TrackingView): LinkPage {
  const { shop, form } = view;
  const formHtml = (open: boolean) =>
    html`<form method="post" class="${open ? 'stack' : 'section'}">
      ${!open && html`<h2 class="label">${say('bilingual', LABELS.trackAnother)}</h2>`}
      <div class="field">
        <label class="label" for="reference">${say('bilingual', LABELS.reference)}</label>
        <input
          id="reference"
          name="reference"
          type="text"
          dir="ltr"
          autocomplete="off"
          value="${open ? form.reference : ''}"
          aria-required="true"
        />
      </div>
      <div class="field">
        <label class="label" for="phone">${say('bilingual', LABELS.mobile)}</label>
        <input
          id="phone"
          name="phone"
          type="tel"
          dir="ltr"
          autocomplete="tel"
          value="${open ? form.phone : ''}"
          aria-required="true"
        />
      </div>
      <button class="button stack" type="submit">${say('bilingual', LABELS.findOrder)}</button>
    </form>`;
  if (view.kind === 'form') {
    const problem =
      view.problem === 'blank'
        ? {
            en: 'Enter your order or tracking number, and the mobile number you ordered with.',
            ur: 'اپنا آرڈر یا ٹریکنگ نمبر، اور وہ موبائل نمبر لکھیں جس سے آپ نے آرڈر دیا تھا۔',
          }
        : view.problem === 'not_found'
          ? {
              en:
                'We found no order with that number and mobile number. Check them both, or ask ' +
                `${shop.name} in your chat.`,
              ur: 'اس نمبر اور موبائل نمبر کا کوئی آرڈر نہیں ملا۔ دونوں دیکھ لیں، یا اپنی چیٹ میں دکان سے پوچھیں۔',
            }
          : null;
    return page(problem ? 404 : 200, `${LABELS.trackTitle.en} · ${shop.name}`, shop, [
      shopName(shop),
      problem && banner(problem),
      heading(LABELS.trackTitle),
      paragraphs(
        {
          en: 'Enter the number of your order, or the tracking number the courier sent you.',
          ur: 'اپنے آرڈر کا نمبر، یا کوریئر کا بھیجا ہوا ٹریکنگ نمبر لکھیں۔',
        },
        'center muted',
      ),
      formHtml(true),
    ]);
  }
  const { order, steps } = view;
  const name = orderName(order.number);
  const title =
    order.stage === 'cancelled'
      ? LABELS.cancelledTitle
      : order.stage === 'delivered' || order.stage === 'completed'
        ? LABELS.deliveredTitle
        : order.stage === 'returning' || order.stage === 'returned' || order.stage === 'lost'
          ? LABELS.notDeliveredTitle
          : order.stage === 'in_transit' || order.stage === 'partially_fulfilled'
            ? order.fulfillments.some(
                (parcel) =>
                  parcel.status === 'in_transit' &&
                  steps.get(parcel.id)?.at(-1)?.status === 'out_for_delivery',
              )
              ? LABELS.outForDeliveryTitle
              : LABELS.onItsWayTitle
            : order.stage === 'awaiting_payment'
              ? LABELS.awaitingPaymentTitle
              : order.stage === 'to_pack' || order.stage === 'to_book'
                ? LABELS.confirmedTitle
                : order.stage === 'ready_for_pickup'
                  ? LABELS.readyForPickupTitle
                  : LABELS.placedTitle;
  return page(200, `${title.en} · ${shop.name}`, shop, [
    shopName(shop),
    heading(title),
    paragraphs({ en: `Your order ${name}`, ur: html`آپ کا آرڈر ${ltr(name)}` }, 'center'),
    parcels(order, steps, shop.timezone),
    formHtml(false),
  ]);
}

/**
 * On to the shop's gateway, whose page takes the payment's signed form, as JazzCash's does
 * (ADR-163): what to pay, through which gateway, and a button that goes on there.
 */
function gatewayFormPage(view: Extract<OrderLinkView, { kind: 'order' }>): LinkPage {
  const { shop, order } = view;
  const started = view.gatewayForm!;
  const online = view.onlinePayment!;
  const due = formatMoney(money(online.amount, order.currency));
  return page(
    200,
    `${LABELS.payOnline.en} · ${shop.name}`,
    shop,
    [shopName(shop), heading(LABELS.payOnline), gatewayForm(started, due)],
    { formTargets: [new URL(started.url).origin] },
  );
}

/**
 * A page in the shop's colours, with its logo; its forms may go on to `formTargets`, such as the
 * shop's payment gateway (ADR-151), and it runs `scripts`, such as the pin's (ADR-259).
 */
function page(
  status: number,
  title: string,
  shop: LinkShop | null,
  body: HtmlValue[],
  options: {
    formTargets?: readonly string[];
    scripts?: readonly string[];
    images?: readonly string[];
  } = {},
): LinkPage {
  return {
    status,
    ...renderPage({
      title,
      body: html`${body}`,
      accent: shop?.accent,
      images: [...(shop?.logo ? [shop.logo] : []), ...(options.images ?? [])],
      formTargets: options.formTargets ?? [],
      scripts: options.scripts ?? [],
    }),
  };
}

/** The shop's logo, named for those who can't see it; or its name, without one. */
function shopName(shop: LinkShop): Html {
  return shop.logo
    ? html`<p class="shop"><img class="logo" src="${shop.logo}" alt="${shop.name}" /></p>`
    : html`<p class="shop">${text(shop.name)}</p>`;
}

function heading(words: Words): Html {
  return html`<h1 class="title stack">${say('bilingual', words)}</h1>`;
}

/**
 * A sentence in English and in Urdu, which may hold markup: numbers, amounts and dates in an
 * Urdu sentence go in ltr(), or the right-to-left text around them reorders their parts.
 */
interface Sentence {
  en: HtmlValue;
  ur: HtmlValue;
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

/** In place of the address a draft does not have yet: a way to add it. */
function addressWanted(): Html {
  return html`<section class="section">
    <h2 class="label">${say('bilingual', LABELS.shipTo)}</h2>
    ${paragraphs(
      {
        en: 'Add the address to deliver to, then confirm your order.',
        ur: 'ترسیل کا پتہ لکھیں، پھر اپنا آرڈر کنفرم کریں۔',
      },
      '',
    )}
    <a class="button stack" href="?address">${say('bilingual', LABELS.addAddress)}</a>
  </section>`;
}

/**
 * Where the customer sends the receipt of their transfer (ADR-080): a photo, a screenshot or its
 * PDF, up to 10 MB, five an order. The page has no scripts, so the form sends the file itself.
 */
function receiptForm(receipts: number): Html {
  const sent =
    receipts > 0 &&
    paragraphs(
      receipts === 1
        ? { en: 'You sent a receipt.', ur: 'آپ ایک رسید بھیج چکے ہیں۔' }
        : {
            en: `You sent ${receipts} receipts.`,
            ur: html`آپ ${ltr(String(receipts))} رسیدیں بھیج چکے ہیں۔`,
          },
      'small muted',
    );
  if (receipts >= RECEIPT_LIMITS.perOrder) {
    return html`<section class="section">
      <h2 class="label">${say('bilingual', LABELS.receiptTitle)}</h2>
      ${sent}
    </section>`;
  }
  return html`<section class="section">
    <h2 class="label">${say('bilingual', LABELS.receiptTitle)}</h2>
    ${paragraphs(
      {
        en: 'Paid? Send a photo or screenshot of the receipt, or its PDF, so the shop finds your money quickly.',
        ur: 'ادائیگی کر دی؟ رسید کی تصویر، اسکرین شاٹ یا پی ڈی ایف بھیجیں تاکہ دکان آپ کی رقم جلد ڈھونڈ لے۔',
      },
      'small',
    )}
    ${sent}
    <form method="post" enctype="multipart/form-data">
      <input type="hidden" name="action" value="receipt" />
      <div class="field">
        <label class="label" for="receipt">${say('bilingual', LABELS.receiptFile)}</label>
        <input
          id="receipt"
          name="receipt"
          type="file"
          accept="${RECEIPT_TYPES.join(',')}"
          required
        />
      </div>
      <button class="button stack" type="submit">${say('bilingual', LABELS.sendReceipt)}</button>
    </form>
  </section>`;
}

/** Stars as the page reads them out: "4 stars", "4 ستارے". */
function starWords(count: number): Words {
  return count === 1
    ? { en: '1 star', ur: '1 ستارہ' }
    : { en: `${count} stars`, ur: `${count} ستارے` };
}

/**
 * Where the customer rates what their delivered order brought them (MKT-05, ADR-399): each
 * product once, one to five stars, with words if they like; what they said before filled in, to
 * change. Without scripts, as the page has none: five radio buttons a product, drawn as stars,
 * those up to the one chosen filled.
 */
function reviewForm(products: readonly ReviewableProduct[]): Html | false {
  if (products.length === 0) return false;
  return html`<section class="section">
    <h2 class="label">${say('bilingual', LABELS.reviewTitle)}</h2>
    ${paragraphs(
      {
        en: 'Tell other customers how it was. Your first name shows with your rating.',
        ur: 'دوسرے خریداروں کو بتائیں کہ چیز کیسی تھی۔ آپ کی ریٹنگ کے ساتھ آپ کا پہلا نام دکھایا جائے گا۔',
      },
      'small',
    )}
    <form method="post">
      <input type="hidden" name="action" value="review" />
      ${products.map(
        ({ productId, title, review }, index) =>
          html`<fieldset class="field">
            <legend class="label">${text(title)}</legend>
            <div class="stars" dir="ltr">
              ${[1, 2, 3, 4, 5].map((stars) => {
                const words = starWords(stars);
                return html`<label>
                  <input
                    type="radio"
                    name="rating_${productId}"
                    value="${String(stars)}"
                    aria-label="${words.en} · ${words.ur}"
                    ${review?.rating === stars && html`checked`}
                  />★
                </label>`;
              })}
            </div>
            <label class="label" for="body-${String(index)}"
              >${say('bilingual', LABELS.reviewWords)}</label
            >
            <textarea id="body-${String(index)}" name="body_${productId}" maxlength="2000" rows="3">
${review?.body ?? ''}</textarea>
          </fieldset>`,
      )}
      <button class="button stack" type="submit">${say('bilingual', LABELS.sendReview)}</button>
    </form>
  </section>`;
}

/**
 * Where the shopper asks to send something back (ORD-08, ADR-675), within the days the shop
 * takes returns: how many of each item and why, what they would like instead and a note; and
 * how their latest request stands, the shop's reason if it declined. Without scripts: a list of
 * how many for each item, 0 to leave it.
 */
function returnSection(shop: LinkShop, returns: ReturnOffer): Html | false {
  const { until, lines, latest } = returns;
  const open = until !== null && lines.length > 0;
  if (!open && !latest) return false;
  return html`<section class="section">
    <h2 class="label">${say('bilingual', LABELS.returnTitle)}</h2>
    ${latest && paragraphs(requestWords(shop, latest), 'small')}
    ${
      open &&
      html`${paragraphs(returnUntilWords(until, shop.timezone), 'small')}
        <form method="post">
          <input type="hidden" name="action" value="return" />
          ${lines.map(
            ({ lineItemId, units, ...line }) =>
              html`<fieldset class="field">
                <legend class="label">${text(itemName(line))}</legend>
                <label class="label" for="quantity-${lineItemId}"
                  >${say('bilingual', LABELS.returnHowMany)}</label
                >
                <select id="quantity-${lineItemId}" name="quantity_${lineItemId}">
                  ${Array.from(
                    { length: units + 1 },
                    (_, count) => html`<option value="${String(count)}">${String(count)}</option>`,
                  )}
                </select>
                <label class="label" for="reason-${lineItemId}"
                  >${say('bilingual', LABELS.returnWhy)}</label
                >
                <select id="reason-${lineItemId}" name="reason_${lineItemId}">
                  <option value="">${LABELS.chooseWhy.en} · ${LABELS.chooseWhy.ur}</option>
                  ${RETURN_REASONS.map(
                    (reason) =>
                      html`<option value="${reason}">
                        ${RETURN_REASON_LABELS[reason].en} · ${RETURN_REASON_LABELS[reason].ur}
                      </option>`,
                  )}
                </select>
              </fieldset>`,
          )}
          <fieldset class="field">
            <legend class="label">${say('bilingual', LABELS.returnInstead)}</legend>
            ${RETURN_PREFERENCES.map(
              (preference) =>
                html`<label class="choice">
                  <input type="radio" name="preference" value="${preference}" />
                  <span
                    ><span lang="en">${RETURN_PREFERENCE_LABELS[preference].en}</span
                    ><span lang="ur" dir="rtl"
                      >${RETURN_PREFERENCE_LABELS[preference].ur}</span
                    ></span
                  >
                </label>`,
            )}
          </fieldset>
          <div class="field">
            <label class="label" for="return-note">${say('bilingual', LABELS.returnNote)}</label>
            <textarea
              id="return-note"
              name="note"
              maxlength="${String(RETURN_NOTE_MAX)}"
              rows="3"
            ></textarea>
          </div>
          <button class="button stack" type="submit">${say('bilingual', LABELS.sendReturn)}</button>
        </form>`
    }
  </section>`;
}

/** "You can ask until 28 Oct 2026.", the last day in the shop's time zone. */
function returnUntilWords(until: Date, timeZone: string): Sentence {
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(until);
  return {
    en: `You can ask to send items back until ${day}.`,
    ur: html`آپ ${ltr(day)} تک چیزیں واپس بھیجنے کی درخواست کر سکتے ہیں۔`,
  };
}

/** How the shopper's latest return request stands. */
function requestWords(shop: LinkShop, latest: NonNullable<ReturnOffer['latest']>): Sentence {
  const items = latest.lines
    .map((line) => `${String(line.quantity)} × ${itemName(line)}`)
    .join(', ');
  switch (latest.status) {
    case 'requested':
      return {
        en: `${shop.name} has your request to send back ${items}, and will answer it soon.`,
        ur: html`دکان کو ${text(items)} واپس بھیجنے کی آپ کی درخواست مل گئی ہے، وہ جلد جواب دے گی۔`,
      };
    case 'approved':
      return {
        en: `${shop.name} agreed to take back ${items}. They will tell you in your chat how to send it.`,
        ur: html`دکان ${text(items)} واپس لینے پر راضی ہے۔ واپس بھیجنے کا طریقہ آپ کو چیٹ میں بتایا
        جائے گا۔`,
      };
    case 'declined':
      return {
        en: `${shop.name} can't take back ${items}: ${latest.declineReason ?? ''}`,
        ur: html`دکان ${text(items)} واپس نہیں لے سکتی: ${text(latest.declineReason ?? '')}`,
      };
  }
}

function askedNotice(shop: LinkShop): Html {
  return html`<div class="banner done" role="status">
    ${paragraphs(
      {
        en: `Thank you: ${shop.name} has your request, and will answer it in your chat.`,
        ur: 'شکریہ! دکان کو آپ کی درخواست مل گئی ہے، وہ آپ کی چیٹ میں جواب دے گی۔',
      },
      '',
    )}
  </div>`;
}

function reviewedNotice(shop: LinkShop): Html {
  return html`<div class="banner done" role="status">
    ${paragraphs(
      {
        en: `Thank you for your rating! It helps ${shop.name} and its other customers.`,
        ur: 'ریٹنگ کا شکریہ! اس سے دکان اور دوسرے خریداروں کو مدد ملتی ہے۔',
      },
      '',
    )}
  </div>`;
}

function receiptNotice(shop: LinkShop): Html {
  return html`<div class="banner done" role="status">
    ${paragraphs(
      {
        en: `Thank you: ${shop.name} has your receipt, and sends your order once the money is in.`,
        ur: 'شکریہ! دکان کو آپ کی رسید مل گئی ہے، اور رقم ملتے ہی آرڈر بھیج دیا جائے گا۔',
      },
      '',
    )}
  </div>`;
}

function addedNotice(): Html {
  return html`<div class="banner done" role="status">
    ${paragraphs(
      {
        en: "Added to your order. You pay for it with the rest when it's delivered.",
        ur: 'آپ کے آرڈر میں شامل ہو گیا۔ اس کی ادائیگی باقی رقم کے ساتھ ڈیلیوری پر کریں۔',
      },
      '',
    )}
  </div>`;
}

/**
 * The offer made after the purchase (MKT-09, ADR-438): a product the shop pairs with what the
 * order holds, at its price less the shop's percentage, added with one tap, each of its variants
 * for sale a button of its own, and paid at the door. No payment is asked again.
 */
function offerForm(offer: PostPurchaseOffer, currency: CurrencyCode): Html {
  const price = (value: bigint) => formatMoney(money(value, currency));
  const one = offer.variants.length === 1;
  const first = offer.variants[0]!;
  const off = offer.percentOff > 0;
  return html`<form method="post" class="offer">
    <input type="hidden" name="action" value="upsell" />
    ${paragraphs(
      one
        ? {
            en:
              `Add ${offer.title} for ${price(first.price)}` +
              (off ? ` (was ${price(first.was)})` : '') +
              ", and pay for it when it's delivered.",
            ur: html`${text(offer.title)} ${ltr(price(first.price))} میں شامل
            کریں${off && html` (پہلے ${ltr(price(first.was))})`}، اور اس کی ادائیگی ڈیلیوری پر کریں۔`,
          }
        : {
            en:
              `Add ${offer.title}` +
              (off ? `, ${offer.percentOff}% off,` : '') +
              " and pay for it when it's delivered.",
            ur: html`${text(offer.title)}${off && html` ${ltr(`${offer.percentOff}%`)} رعایت پر`}
            شامل کریں، اور اس کی ادائیگی ڈیلیوری پر کریں۔`,
          },
      'center',
    )}
    ${offer.variants.map(
      (variant) =>
        html`<button class="button stack" type="submit" name="variant" value="${variant.variantId}">
          ${say(
            'bilingual',
            one
              ? {
                  en: `Add for ${price(variant.price)}`,
                  ur: `${price(variant.price)} میں شامل کریں`,
                }
              : {
                  en: `Add ${variant.title}, ${price(variant.price)}`,
                  ur: `${variant.title} شامل کریں، ${price(variant.price)}`,
                },
          )}
        </button>`,
    )}
  </form>`;
}

function savedNotice(): Html {
  return html`<div class="banner done" role="status">
    ${paragraphs({ en: 'Your new address is saved.', ur: 'آپ کا نیا پتہ محفوظ ہو گیا ہے۔' }, '')}
  </div>`;
}

function problemWords(problem: LinkProblem, shown: ShownOrder): Sentence {
  switch (problem.kind) {
    case 'changed':
      // A draft's page also names the shop's policies, which may have changed instead.
      return shown.terms.length > 0
        ? {
            en: "This order or the shop's policies changed after you opened it. Check them again, then confirm.",
            ur: 'آپ کے کھولنے کے بعد اس آرڈر یا دکان کی پالیسیوں میں تبدیلی ہوئی ہے۔ انہیں دوبارہ دیکھ کر کنفرم کریں۔',
          }
        : {
            en: 'This order changed after you opened it. Check it again, then confirm.',
            ur: 'آپ کے کھولنے کے بعد اس آرڈر میں تبدیلی ہوئی ہے۔ اسے دوبارہ دیکھ کر کنفرم کریں۔',
          };
    case 'unavailable': {
      const items = problem.lines
        .map((index) => shown.lines[index])
        .filter((line) => line !== undefined)
        .map(itemName)
        .join(', ');
      return {
        en: `Sorry, ${items} can't be ordered now. Ask the shop in your chat what they can offer.`,
        ur: html`معذرت، ${text(items)} اب دستیاب نہیں۔ اپنی چیٹ میں دکان سے پوچھیں۔`,
      };
    }
    case 'refused':
      return {
        en: "Sorry, the shop can't take this order right now. Ask them in your chat.",
        ur: 'معذرت، دکان ابھی یہ آرڈر نہیں لے سکتی۔ اپنی چیٹ میں دکان سے پوچھیں۔',
      };
    case 'too_late':
      return tooLateWords(problem.action);
    case 'receipt':
      return receiptProblemWords(problem.reason);
    case 'address':
      return {
        en: 'Some of the address is missing or not right. See below.',
        ur: 'پتے میں کچھ کمی یا غلطی ہے۔ نیچے دیکھیں۔',
      };
    case 'payment':
      return onlinePaymentProblemWords(problem.reason, shown.transfer > 0n);
    case 'review':
      return {
        en: 'Choose the stars for at least one product, then send.',
        ur: 'کم از کم ایک چیز کے لیے ستارے چنیں، پھر بھیجیں۔',
      };
    case 'return':
      return returnProblemWords(problem.reason);
  }
}

/**
 * The subscription an order is of (CAT-16, ADR-862): its plan, and while it goes on, when its next
 * order is placed, with buttons to skip that order, pause or resume it, and cancel it.
 */
function subscriptionSection(subscription: SubscriptionLinkView): Html {
  const next = dayText(subscription.nextOrderOn);
  const plan = `${subscription.planName}, ${subscription.discountPercent}% off`;
  const words: Sentence =
    subscription.status === 'cancelled'
      ? {
          en: `Your subscription (${plan}) is cancelled: no more orders are placed.`,
          ur: html`آپ کی سبسکرپشن (${text(plan)}) منسوخ ہے: مزید آرڈر نہیں دیے جائیں گے۔`,
        }
      : subscription.status === 'paused'
        ? {
            en: `Your subscription (${plan}) is paused: no orders are placed until you resume it.`,
            ur: html`آپ کی سبسکرپشن (${text(plan)}) رکی ہوئی ہے: دوبارہ شروع کرنے تک کوئی آرڈر نہیں
            دیا جائے گا۔`,
          }
        : {
            en: `You subscribed: ${plan}. Your next order is placed on ${next}, and confirmed with you before it's sent.`,
            ur: html`آپ نے سبسکرائب کیا ہے: ${text(plan)}۔ آپ کا اگلا آرڈر ${ltr(next)} کو دیا جائے
            گا، اور بھیجنے سے پہلے آپ سے کنفرم کیا جائے گا۔`,
          };
  const button = (action: string, label: Words, variant = '') =>
    html`<button class="button ${variant} stack" type="submit" name="action" value="${action}">
      ${say('bilingual', label)}
    </button>`;
  return html`<section class="subscription">
    ${paragraphs(words, 'center')}
    ${
      subscription.status !== 'cancelled' &&
      html`<form method="post">
        ${
          subscription.status === 'active'
            ? html`${button('subscription_skip', LABELS.skipNext, 'secondary')}
              ${button('subscription_pause', LABELS.pauseSubscription, 'secondary')}`
            : button('subscription_resume', LABELS.resumeSubscription)
        }
        ${button('subscription_cancel', LABELS.cancelSubscription, 'danger')}
      </form>`
    }
  </section>`;
}

/** Why the customer can no longer do `action` here, and whom to ask instead. */
function tooLateWords(
  action:
    'cancel' | 'address' | 'receipt' | 'pay' | 'review' | 'upsell' | 'return' | 'subscription',
): Sentence {
  switch (action) {
    case 'subscription':
      return {
        en: 'This subscription was cancelled. Ask the shop in your chat to start another.',
        ur: 'یہ سبسکرپشن منسوخ ہو چکی ہے۔ نئی شروع کرنے کے لیے اپنی چیٹ میں دکان سے پوچھیں۔',
      };
    case 'cancel':
      return {
        en: "This order can't be cancelled here any more. Ask the shop in your chat.",
        ur: 'یہ آرڈر اب یہاں منسوخ نہیں ہو سکتا۔ اپنی چیٹ میں دکان سے پوچھیں۔',
      };
    case 'address':
      return {
        en: "The address can't be changed here any more. Ask the shop in your chat.",
        ur: 'اب یہاں پتہ تبدیل نہیں ہو سکتا۔ اپنی چیٹ میں دکان سے پوچھیں۔',
      };
    case 'receipt':
      return {
        en: 'This order no longer waits for a transfer. Ask the shop in your chat.',
        ur: 'یہ آرڈر اب بینک ٹرانسفر کا انتظار نہیں کر رہا۔ اپنی چیٹ میں دکان سے پوچھیں۔',
      };
    case 'pay':
      return {
        en: 'This order no longer waits for a payment online. Ask the shop in your chat.',
        ur: 'یہ آرڈر اب آن لائن ادائیگی کا انتظار نہیں کر رہا۔ اپنی چیٹ میں دکان سے پوچھیں۔',
      };
    case 'review':
      return {
        en: 'You can rate what you bought once your order is delivered.',
        ur: 'آرڈر پہنچنے کے بعد آپ اپنی خریداری کو ریٹ کر سکتے ہیں۔',
      };
    case 'upsell':
      return {
        en: 'This offer is no longer open. Ask the shop in your chat to add anything else.',
        ur: 'یہ آفر اب دستیاب نہیں۔ کچھ اور شامل کرنے کے لیے اپنی چیٹ میں دکان سے پوچھیں۔',
      };
    case 'return':
      return {
        en: "A return can't be asked for here any more. Ask the shop in your chat.",
        ur: 'اب یہاں واپسی کی درخواست نہیں ہو سکتی۔ اپنی چیٹ میں دکان سے پوچھیں۔',
      };
  }
}

/** Why a return asked for was not taken (ADR-675), and what to do instead. */
function returnProblemWords(reason: 'none' | 'reason' | 'preference' | 'waiting'): Sentence {
  switch (reason) {
    case 'none':
      return {
        en: 'Choose how many of an item you want to send back.',
        ur: 'منتخب کریں کہ کسی چیز کی کتنی تعداد واپس بھیجنی ہے۔',
      };
    case 'reason':
      return {
        en: 'Say why each item you choose goes back.',
        ur: 'ہر منتخب چیز کی واپسی کی وجہ بتائیں۔',
      };
    case 'preference':
      return {
        en: 'Choose what you would like instead: another size, store credit or your money back.',
        ur: 'منتخب کریں کہ بدلے میں کیا چاہیے: دوسرا سائز، اسٹور کریڈٹ یا رقم کی واپسی۔',
      };
    case 'waiting':
      return {
        en: 'The shop has your request already, and will answer it soon.',
        ur: 'دکان کو آپ کی درخواست مل چکی ہے، وہ جلد جواب دے گی۔',
      };
  }
}

/** Why a receipt was not taken, and what to do instead. */
function receiptProblemWords(reason: 'missing' | 'type' | 'size' | 'count'): Sentence {
  switch (reason) {
    case 'missing':
      return {
        en: 'Choose the photo or PDF of your receipt first.',
        ur: 'پہلے اپنی رسید کی تصویر یا پی ڈی ایف منتخب کریں۔',
      };
    case 'type':
      return {
        en: "That file isn't a photo or a PDF. Send a photo or screenshot of the receipt, or its PDF.",
        ur: 'یہ فائل تصویر یا پی ڈی ایف نہیں۔ رسید کی تصویر، اسکرین شاٹ یا پی ڈی ایف بھیجیں۔',
      };
    case 'size':
      return {
        en: 'That file is larger than 10 MB. Send a smaller photo, or a screenshot.',
        ur: html`یہ فائل ${ltr('10 MB')} سے بڑی ہے۔ چھوٹی تصویر یا اسکرین شاٹ بھیجیں۔`,
      };
    case 'count':
      return {
        en: 'You sent as many receipts as an order takes. Ask the shop in your chat.',
        ur: 'آپ اس آرڈر کے لیے زیادہ سے زیادہ رسیدیں بھیج چکے ہیں۔ اپنی چیٹ میں دکان سے پوچھیں۔',
      };
  }
}

function amount(value: bigint, currency: CurrencyCode): string {
  return formatMoney(money(value, currency));
}

/**
 * What the shopper wrote or chose on a line, an embroidered name or an engraving, each on a line
 * of its own (ADR-688); apps' left out.
 */
function propertyLines(properties: Record<string, string>): Html[] {
  return shownLineProperties({ properties }).map(
    ([name, value]) => html`<br /><span class="small">${text(name)}: ${text(value)}</span>`,
  );
}

/** A line sold stitched to measurements (ADR-803): the day it ships by, YYYY-MM-DD, in words. */
function stitchedWords(shipsOn: string): Words {
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${shipsOn}T00:00:00Z`));
  return {
    en: `Stitched to your measurements: ships by ${day}`,
    ur: `آپ کے ناپ پر سلائی: ${day} تک روانہ ہوگا`,
  };
}

/** A line sold on pre-order (ADR-403): the day it ships by, YYYY-MM-DD, in words. */
function preorderWords(shipsOn: string): Words {
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${shipsOn}T00:00:00Z`));
  return { en: `Pre-order: ships by ${day}`, ur: `پیشگی آرڈر: ${day} تک روانہ ہوگا` };
}

/** What a customer has of store credit with the shop, as their order's page says it (ADR-596). */
function storeCreditWords(credit: string, shopName: string): Sentence {
  return {
    en: `You have ${credit} of store credit with ${shopName}. It can pay your next order at checkout.`,
    ur: html`${shopName} کے پاس آپ کا ${ltr(credit)} اسٹور کریڈٹ ہے۔ یہ چیک آؤٹ پر آپ کے اگلے آرڈر
    کی ادائیگی کر سکتا ہے۔`,
  };
}

/** The day delivery is expected by, YYYY-MM-DD (ADR-595): "Thursday 22 October". */
function expectedByWords(day: string): Words {
  const words = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(`${day}T00:00:00Z`));
  return { en: `Expected by ${words}`, ur: `${words} تک پہنچنے کی توقع` };
}

/**
 * What an order on payment terms owes (ADR-888, ADR-920), as its page says it: what to pay by
 * transfer and by which day, in the shop's time zone; or, past it, that it was due.
 */
function paymentTermsWords(
  order: OrderRecord,
  owed: bigint,
  overdue: boolean,
  timezone: string,
): Sentence {
  const due = amount(owed, order.currency);
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(order.paymentDueAt!);
  const days = order.paymentTermsDays ?? 0;
  return overdue
    ? {
        en: `${due} was due by ${day}. Please pay it by bank transfer now.`,
        ur: html`${ltr(due)} کی ادائیگی ${day} تک واجب تھی۔ براہ کرم ابھی بینک ٹرانسفر سے ادا کریں۔`,
      }
    : {
        en: `Your order is on ${days} days' terms: pay ${due} by bank transfer by ${day}.`,
        ur: html`آپ کا آرڈر ${ltr(String(days))} دن کی مہلت پر ہے: ${ltr(due)} ${day} تک بینک
        ٹرانسفر سے ادا کریں۔`,
      };
}

/** The time chosen to have it delivered in, in Pakistan's time (ADR-770). */
function deliverySlotWords(slot: DeliverySlotValue): Words {
  const when = deliverySlotText(slot);
  return { en: `Delivery: ${when}`, ur: `ڈیلیوری: ${when}` };
}

/** The items and what they come to, down to what is paid at the door or by transfer. */
function summary(shown: ShownOrder): Html {
  const row = (label: Words, value: string, className = '') =>
    html`<tr class="${className}">
      <td>${say('bilingual', label)}</td>
      <td class="num">${ltr(value)}</td>
    </tr>`;
  const rs = (value: bigint) => amount(value, shown.currency);
  return html`<section class="section">
    <h2 class="label">${say('bilingual', LABELS.yourOrder)}</h2>
    <table>
      ${shownItems(shown.lines).map((item) => {
        if ('bundle' in item) {
          const { bundle } = item;
          // A bundle once, what it holds under it (ADR-411).
          return html`<tr>
            <td>
              ${ltr(`${bundle.quantity} ×`)} ${text(bundle.title)}
              <br /><span class="small"
                >${say('bilingual', LABELS.bundleHolds)}
                ${bundle.parts.map(
                  (part, index) =>
                    html`${index > 0 && ', '}${ltr(`${part.quantity} ×`)} ${text(part.name)}`,
                )}</span
              >${propertyLines(bundle.properties)}
            </td>
            <td class="num">${ltr(rs(bundle.total))}</td>
          </tr>`;
        }
        const { line } = item;
        return html`<tr>
          <td>
            ${ltr(`${line.quantity} ×`)} ${text(itemName(line))}
            ${
              line.preorderShipsOn &&
              html`<br /><span class="small"
                  >${say('bilingual', preorderWords(line.preorderShipsOn))}</span
                >`
            }${
              line.stitchedShipsOn &&
              html`<br /><span class="small"
                  >${say('bilingual', stitchedWords(line.stitchedShipsOn))}</span
                >`
            }${propertyLines(line.properties ?? {})}
          </td>
          <td class="num">${ltr(rs(line.total))}</td>
        </tr>`;
      })}
    </table>
    ${
      // The time the customer chose to have it delivered in (ADR-770), else the day checkout
      // said to expect it by (ADR-595), while it is still to come.
      shown.deliverySlot
        ? paragraphs(deliverySlotWords(shown.deliverySlot), 'small')
        : shown.deliveryExpectedOn && paragraphs(expectedByWords(shown.deliveryExpectedOn), 'small')
    }
    ${
      // The words to go with it as a gift (ADR-413), as the customer wrote them.
      shown.giftMessage &&
      html`<p class="small">
        ${say('bilingual', LABELS.giftMessage)}: <span dir="auto">${text(shown.giftMessage)}</span>
      </p>`
    }
    <table>
      ${row(LABELS.subtotal, rs(shown.subtotal))}
      ${
        shown.discount > shown.transferDiscount + shown.onlineDiscount &&
        row(
          LABELS.discount,
          `-${rs(shown.discount - shown.transferDiscount - shown.onlineDiscount)}`,
        )
      }
      ${
        shown.transferDiscount > 0n &&
        row(LABELS.transferDiscount, `-${rs(shown.transferDiscount)}`)
      }
      ${shown.onlineDiscount > 0n && row(LABELS.onlineDiscount, `-${rs(shown.onlineDiscount)}`)}
      ${!shown.pickup && row(LABELS.shipping, rs(shown.shipping))}
      ${shown.codFee > 0n && row(LABELS.codFee, rs(shown.codFee))}
      ${row(LABELS.total, rs(shown.total), 'total')}
      ${shown.taxes.map((tax) => row(taxIncludedWords(tax.rate), rs(tax.tax)))}
      ${
        shown.cashOnDelivery
          ? [
              shown.paid > 0n && row(LABELS.advance, `-${rs(shown.paid)}`),
              shown.transfer > 0n && row(LABELS.advanceByTransfer, `-${rs(shown.transfer)}`),
              row(
                shown.pickup ? LABELS.payOnCollection : LABELS.payOnDelivery,
                rs(shown.due),
                'due',
              ),
            ]
          : shown.transfer > 0n
            ? row(LABELS.payByTransfer, rs(shown.transfer), 'due')
            : shown.online > 0n
              ? row(LABELS.payOnline, rs(shown.online), 'due')
              : row(LABELS.paid, rs(shown.paid))
      }
    </table>
  </section>`;
}

/** Where it goes, with the number masked, and a way to change it while it is `changeable`. */
function address(shown: ShownOrder, options: { changeable?: boolean } = {}): Html {
  const to = shown.address;
  if (!to) return html``;
  const province = to.provinceCode ? PK_PROVINCES[to.provinceCode as PkProvinceCode].name : null;
  const lines = [
    text(to.name),
    to.phone && ltr(maskPkMobile(to.phone)),
    text(to.address1),
    to.address2 && text(to.address2),
    to.landmark && text(to.landmark),
    text([[to.city, to.zip].filter(Boolean).join(' '), province].filter(Boolean).join(', ')),
  ].filter((line): line is Html => Boolean(line));
  const pin = pinLine(to.location);
  return html`<section class="section">
    <h2 class="label">${say('bilingual', shown.pickup ? LABELS.collectedBy : LABELS.shipTo)}</h2>
    <p>${lines.map((line, index) => html`${index > 0 && html`<br />`}${line}`)}</p>
    ${pin && html`<p>${pin}</p>`}
    ${
      options.changeable &&
      html`<p><a href="?address">${say('bilingual', LABELS.addressTitle)}</a></p>`
    }
  </section>`;
}

/**
 * Each parcel's courier and tracking number, with a link to follow it where there is one, and its
 * way so far, the latest step first (ADR-160).
 */
function parcels(order: OrderRecord, steps: ParcelSteps, timeZone: string): Html {
  const shown = order.fulfillments.filter(
    (parcel) =>
      parcel.trackingCompany !== null ||
      parcel.trackingNumber !== null ||
      (steps.get(parcel.id)?.length ?? 0) > 0,
  );
  if (shown.length === 0) return html``;
  return html`<section class="section">
    <h2 class="label">${say('bilingual', LABELS.courier)}</h2>
    ${shown.map(
      (parcel) =>
        html`<p>
            ${ltr([parcel.trackingCompany, parcel.trackingNumber].filter(Boolean).join(' '))}
            ${
              parcel.trackingUrl?.startsWith('https://') &&
              html`· <a href="${parcel.trackingUrl}">${say('bilingual', LABELS.track)}</a>`
            }
          </p>
          ${progress(parcel, steps.get(parcel.id) ?? [], timeZone)}`,
    )}
  </section>`;
}

/**
 * A parcel's way so far, the latest step first: shipped, each step its courier told of, and its
 * delivery or return where its courier did not tell of them, as staff marked them.
 */
function progress(
  parcel: FulfillmentRecord,
  steps: readonly FulfillmentEventRecord[],
  timeZone: string,
): Html {
  const told = new Set(steps.map((step) => step.status));
  const way: { words: Words; at: Date; said: string | null }[] = [
    { words: STEP_LABELS.shipped, at: parcel.shippedAt, said: null },
    ...steps.map((step) => ({
      words: STEP_LABELS[step.status],
      at: step.happenedAt,
      said: step.message,
    })),
  ];
  const marked: [Date | null, FulfillmentEventStatusValue][] = [
    [parcel.deliveredAt, 'delivered'],
    [parcel.returningAt, 'returning'],
    [parcel.returnedAt, 'returned'],
    [parcel.lostAt, 'failure'],
  ];
  for (const [at, status] of marked) {
    if (at && !told.has(status)) way.push({ words: STEP_LABELS[status], at, said: null });
  }
  // The latest first; of two at once, the one told of later.
  const latestFirst = way
    .map((step, index) => ({ step, index }))
    .sort((a, b) => b.step.at.getTime() - a.step.at.getTime() || b.index - a.index)
    .map(({ step }) => step);
  return html`<ul class="steps">
    ${latestFirst.map(
      (step) =>
        html`<li>
          <span class="strong">${say('bilingual', step.words)}</span>
          <span class="small muted">· ${ltr(stepTime(step.at, timeZone))}</span>
          ${step.said && html`<br /><span class="small muted">${text(step.said)}</span>`}
        </li>`,
    )}
  </ul>`;
}

/** "3 Oct, 10:15 am", in the shop's time zone. */
function stepTime(at: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return (
    `${parts.day} ${parts.month}, ${parts.hour}:${parts.minute} ` +
    (parts.dayPeriod ?? '').toLowerCase()
  );
}

/** "This link works until 2 Oct 2026, 5:30 pm", in the shop's time zone. */
function until(expiresAt: Date, timeZone: string): Html {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
      .formatToParts(expiresAt)
      .map((part) => [part.type, part.value]),
  );
  const when =
    `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} ` +
    (parts.dayPeriod ?? '').toLowerCase();
  return paragraphs(
    { en: `This link works until ${when}.`, ur: html`یہ لنک ${ltr(when)} تک کام کرے گا۔` },
    'small muted',
  );
}

/** How an affiliate's order stands, for their page: earned, coming, or come back. */
function affiliateStageWords(stage: string): Words {
  return stage === 'delivered' || stage === 'completed'
    ? { en: 'Delivered', ur: 'ڈیلیور ہو گیا' }
    : stage === 'returned' || stage === 'lost'
      ? { en: 'Came back', ur: 'واپس آ گیا' }
      : { en: 'On its way', ur: 'راستے میں' };
}

/**
 * An affiliate's own page, /a/<secret> (MKT-08, ADR-899): their link, code and share, what their
 * orders came to and earned, what the shop paid them and owes, and their latest orders by number
 * and stage, nothing of their customers. In English and Urdu.
 */
export function affiliatePage(view: AffiliatePageView): LinkPage {
  if (view.kind === 'not_found') return notFoundPage();
  const { shop, stats } = view;
  const currency = view.currency as CurrencyCode;
  const rs = (value: bigint) => amount(value, currency);
  const row = (label: Words, value: HtmlValue, className = '') =>
    html`<tr class="${className}">
      <td>${say('bilingual', label)}</td>
      <td class="num">${value}</td>
    </tr>`;
  const share = `${view.commissionBps / 100}%`;
  return page(200, `${view.name} · ${shop.name}`, shop, [
    shopName(shop),
    heading({ en: `Your sales for ${shop.name}`, ur: `${shop.name} کے لیے آپ کی سیل` }),
    paragraphs({ en: text(view.name), ur: text(view.name) }, 'center muted'),
    view.ended &&
      banner({
        en: 'The shop ended your part. Orders placed before it still earn once delivered.',
        ur: 'دکان نے آپ کا حصہ ختم کر دیا ہے۔ اس سے پہلے کے آرڈر ڈیلیور ہونے پر اب بھی کماتے ہیں۔',
      }),
    html`<section class="section">
      <h2 class="label">
        ${say('bilingual', { en: 'Your link and code', ur: 'آپ کا لنک اور کوڈ' })}
      </h2>
      <table>
        ${view.link && row({ en: 'Link', ur: 'لنک' }, html`<code dir="ltr">${text(view.link)}</code>`)}
        ${view.discountCode && row({ en: 'Code', ur: 'کوڈ' }, ltr(view.discountCode))}
        ${row({ en: 'Your share', ur: 'آپ کا حصہ' }, ltr(share))}
      </table>
    </section>`,
    html`<section class="section">
      <h2 class="label">
        ${say('bilingual', { en: 'What you brought', ur: 'آپ کے لائے ہوئے آرڈر' })}
      </h2>
      <table>
        ${row({ en: 'Orders', ur: 'آرڈر' }, ltr(String(stats.orders)))}
        ${row({ en: 'Delivered', ur: 'ڈیلیور ہوئے' }, ltr(String(stats.delivered)))}
        ${row({ en: 'Sales delivered', ur: 'ڈیلیور ہوئی سیل' }, ltr(rs(stats.sales)))}
        ${row({ en: 'Earned', ur: 'کمایا' }, ltr(rs(stats.earned)))}
        ${row({ en: 'Earned once delivered', ur: 'ڈیلیور ہونے پر کمائیں گے' }, ltr(rs(stats.pending)))}
        ${row({ en: 'Paid to you', ur: 'آپ کو ادا ہوا' }, ltr(rs(stats.paid)))}
        ${row({ en: 'Owed to you', ur: 'آپ کا بقایا' }, ltr(rs(stats.owed)), 'total')}
      </table>
    </section>`,
    html`<section class="section">
      <h2 class="label">
        ${say('bilingual', { en: 'Your latest orders', ur: 'آپ کے تازہ آرڈر' })}
      </h2>
      ${
        view.orders.length === 0
          ? paragraphs(
              {
                en: 'No orders yet. Share your link or code, and they show here.',
                ur: 'ابھی کوئی آرڈر نہیں۔ اپنا لنک یا کوڈ شیئر کریں، آرڈر یہاں نظر آئیں گے۔',
              },
              'muted',
            )
          : html`<table>
              ${view.orders.map(
                (order) =>
                  html`<tr>
                    <td>
                      ${ltr(orderName(order.number))} ·
                      ${say('bilingual', affiliateStageWords(order.stage))}
                      <br /><span class="small"
                        >${ltr(
                          order.placedAt.toLocaleDateString('en-GB', {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                            timeZone: shop.timezone,
                          }),
                        )}</span
                      >
                    </td>
                    <td class="num">${ltr(rs(order.commission))}</td>
                  </tr>`,
              )}
            </table>`
      }
    </section>`,
  ]);
}
