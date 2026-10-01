import type { FieldError } from '@hatti/api';
import { DEFAULT_VARIANT_TITLE } from '@hatti/catalog/public';
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
import {
  PK_PROVINCES,
  areaSuggestions,
  findCity,
  maskPkMobile,
  type PkProvinceCode,
} from '@hatti/pk';
import type { DraftLinkView } from './draft-order.service.js';
import type { AddressForm, LinkProblem, LinkShop } from './links.js';
import type { OrderLinkView } from './order-link.service.js';
import type { OrderRecord } from './records.js';
import { addressChangeable, awaitsCustomer, orderName } from './rules.js';
import type { StoredAddressValue } from './schema.js';
import { shownOfDraft, shownOfOrder, type ShownOrder } from './shown-order.js';
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
  subtotal: { en: 'Subtotal', ur: 'ذیلی کل' },
  discount: { en: 'Discount', ur: 'رعایت' },
  transferDiscount: { en: 'Bank transfer discount', ur: 'بینک ٹرانسفر پر رعایت' },
  shipping: { en: 'Delivery charges', ur: 'ڈیلیوری چارجز' },
  codFee: { en: 'Cash on delivery fee', ur: 'کیش آن ڈیلیوری فیس' },
  total: { en: 'Total', ur: 'کل رقم' },
  advance: { en: 'Paid in advance', ur: 'پیشگی ادائیگی' },
  paid: { en: 'Paid', ur: 'ادا شدہ' },
  payOnDelivery: { en: 'Pay on delivery', ur: 'ڈیلیوری پر ادائیگی' },
  payByTransfer: { en: 'Pay by bank transfer', ur: 'بینک ٹرانسفر سے ادائیگی' },
  shipTo: { en: 'Deliver to', ur: 'ترسیل کا پتہ' },
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
  deliveredTitle: { en: 'Delivered', ur: 'آرڈر پہنچ گیا' },
  notDeliveredTitle: { en: 'Not delivered', ur: 'آرڈر ڈیلیور نہیں ہوا' },
  cancelledTitle: { en: 'Order cancelled', ur: 'آرڈر منسوخ ہو گیا' },
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
  backToOrder: { en: 'Back to my order', ur: 'واپس اپنے آرڈر پر' },
} satisfies Record<string, Words>;

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
      const shown = shownOfDraft(draft);
      if (options.form === 'address' && onAddressForm(problem)) {
        return addressPage({
          shop,
          address: draft.shippingAddress,
          phone: draft.phone,
          shown,
          digest: view.shown,
          problem,
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
          changeable: addressChangeable(view.order),
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
          changeable,
          cancellable: view.cancellable,
          receipts: view.receipts,
        });
      }
      return confirmPage({
        shop,
        shown: shownOfOrder(order),
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
 * confirmed. The form carries `digest`, what the page showed.
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
    problem && banner(problemWords(problem, shown)),
    options.saved && savedNotice(),
    summary(shown),
    addressed ? address(shown, { changeable: options.changeable }) : addressWanted(),
    addressed &&
      html`<form method="post">
        <input type="hidden" name="action" value="confirm" />
        <input type="hidden" name="shown" value="${options.digest}" />
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
}): LinkPage {
  const { shop, problem, digest } = options;
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
  return page(typed ? 422 : problem ? 409 : 200, `${title.en} · ${shop.name}`, shop, [
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
      ${phoneField(options.phone, form, errors)}
      <button class="button stack" type="submit">${say('bilingual', LABELS.saveAddress)}</button>
    </form>`,
    html`<p class="center"><a href="?">${say('bilingual', LABELS.backToOrder)}</a></p>`,
  ]);
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
  };
}

/**
 * A labelled box of the address form, with a hint and what is wrong with it underneath.
 * Autocomplete names the delivery address, for phones that fill it in; typed text runs in its
 * script's direction, and digits and numbers left to right.
 */
function textField(
  name: Exclude<keyof AddressForm, 'province'>,
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
  },
): LinkPage {
  const {
    problem = null,
    saved = false,
    sent = false,
    changeable = false,
    cancellable = false,
    receipts = 0,
  } = options;
  const name = orderName(order.number);
  const shown = shownOfOrder(order);
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
      problem ? (problem.kind === 'receipt' ? 422 : 409) : 200,
      `${title.en} · ${shop.name}`,
      shop,
      [
        shopName(shop),
        problem && banner(problemWords(problem, shown)),
        saved && savedNotice(),
        sent && receiptNotice(shop),
        mark && html`<div class="mark" aria-hidden="true">✓</div>`,
        heading(title),
        paragraphs(sentence, 'center'),
        ...rest,
      ],
    );

  switch (order.stage) {
    case 'cancelled':
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
      return show(
        LABELS.confirmedTitle,
        {
          en: `Thank you! Your order ${name} is confirmed, and ${shop.name} will send it soon.`,
          ur: html`شکریہ! آپ کا آرڈر ${ltr(name)} کنفرم ہو گیا ہے اور جلد روانہ کر دیا جائے گا۔`,
        },
        true,
        pay,
        summary(shown),
        address(shown, { changeable }),
        cancellable && cancelLink(),
      );
    case 'partially_fulfilled':
    case 'in_transit':
      return show(
        LABELS.onItsWayTitle,
        {
          en: `Your order ${name} is on its way.`,
          ur: html`آپ کا آرڈر ${ltr(name)} راستے میں ہے۔`,
        },
        false,
        pay,
        parcels(order),
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
        transferDetails(order),
        receiptForm(receipts),
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
 * A page in its shop's colours, with its logo, as its checkout's page is (ADR-069, ADR-081); or
 * the platform's when it has no shop to show.
 */
function page(status: number, title: string, shop: LinkShop | null, body: HtmlValue[]): LinkPage {
  return {
    status,
    ...renderPage({
      title,
      body: html`${body}`,
      accent: shop?.accent,
      images: shop?.logo ? [shop.logo] : [],
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

function savedNotice(): Html {
  return html`<div class="banner done" role="status">
    ${paragraphs({ en: 'Your new address is saved.', ur: 'آپ کا نیا پتہ محفوظ ہو گیا ہے۔' }, '')}
  </div>`;
}

function problemWords(problem: LinkProblem, shown: ShownOrder): Sentence {
  switch (problem.kind) {
    case 'changed':
      return {
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
  }
}

/** Why the customer can no longer do `action` here, and whom to ask instead. */
function tooLateWords(action: 'cancel' | 'address' | 'receipt'): Sentence {
  switch (action) {
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

/** "Peshawari Chappal (8)"; a product without options by its title alone. */
function itemName(line: { title: string; variantTitle: string }): string {
  return line.variantTitle === DEFAULT_VARIANT_TITLE
    ? line.title
    : `${line.title} (${line.variantTitle})`;
}

function amount(value: bigint, currency: CurrencyCode): string {
  return formatMoney(money(value, currency));
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
      ${shown.lines.map(
        (line) =>
          html`<tr>
            <td>${ltr(`${line.quantity} ×`)} ${text(itemName(line))}</td>
            <td class="num">${ltr(rs(line.total))}</td>
          </tr>`,
      )}
    </table>
    <table>
      ${row(LABELS.subtotal, rs(shown.subtotal))}
      ${
        shown.discount > shown.transferDiscount &&
        row(LABELS.discount, `-${rs(shown.discount - shown.transferDiscount)}`)
      }
      ${
        shown.transferDiscount > 0n &&
        row(LABELS.transferDiscount, `-${rs(shown.transferDiscount)}`)
      }
      ${row(LABELS.shipping, rs(shown.shipping))}
      ${shown.codFee > 0n && row(LABELS.codFee, rs(shown.codFee))}
      ${row(LABELS.total, rs(shown.total), 'total')}
      ${
        shown.cashOnDelivery
          ? [
              shown.paid > 0n && row(LABELS.advance, `-${rs(shown.paid)}`),
              row(LABELS.payOnDelivery, rs(shown.due), 'due'),
            ]
          : shown.transfer > 0n
            ? row(LABELS.payByTransfer, rs(shown.transfer), 'due')
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
  return html`<section class="section">
    <h2 class="label">${say('bilingual', LABELS.shipTo)}</h2>
    <p>${lines.map((line, index) => html`${index > 0 && html`<br />`}${line}`)}</p>
    ${
      options.changeable &&
      html`<p><a href="?address">${say('bilingual', LABELS.addressTitle)}</a></p>`
    }
  </section>`;
}

/** Each parcel's courier and tracking number, with a link to follow it where there is one. */
function parcels(order: OrderRecord): Html {
  const tracked = order.fulfillments.filter(
    (parcel) => parcel.trackingCompany !== null || parcel.trackingNumber !== null,
  );
  if (tracked.length === 0) return html``;
  return html`<section class="section">
    <h2 class="label">${say('bilingual', LABELS.courier)}</h2>
    ${tracked.map(
      (parcel) =>
        html`<p>
          ${ltr([parcel.trackingCompany, parcel.trackingNumber].filter(Boolean).join(' '))}
          ${
            parcel.trackingUrl?.startsWith('https://') &&
            html`· <a href="${parcel.trackingUrl}">${say('bilingual', LABELS.track)}</a>`
          }
        </p>`,
    )}
  </section>`;
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
