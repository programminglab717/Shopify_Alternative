import { html, renderPage, say, type Html, type RenderedPage, type Words } from '@hatti/documents';
import {
  REPORT_REASON_VALUES,
  RIGHTS_ACTING_AS_VALUES,
  RIGHTS_KIND_VALUES,
} from '@hatti/storefront-api';

// The page a shopper reports a store to Hatti from (TNS-01, ADR-460): linked from every store's
// footer, at /report and /ur/report. In English and Urdu, as the platform's other pages for
// customers are, and in the platform's markup, since it is Hatti's page, not the shop's.

/** The longest details a report takes, as the core does. */
export const REPORT_DETAILS_MAX = 2000;

const REASONS: Record<(typeof REPORT_REASON_VALUES)[number], Words> = {
  never_delivered: {
    en: 'I ordered and it never came',
    ur: 'میں نے آرڈر دیا مگر سامان نہیں پہنچا',
  },
  not_as_described: {
    en: 'What came was not what was shown',
    ur: 'جو آیا وہ دکھائے گئے سامان جیسا نہیں تھا',
  },
  counterfeit: { en: 'Fake or copied goods', ur: 'نقلی یا جعلی سامان' },
  prohibited: { en: 'Selling what is not allowed', ur: 'ممنوعہ چیزیں بیچ رہی ہے' },
  scam: { en: 'A scam or fraud', ur: 'دھوکا یا فراڈ' },
  impersonation: {
    en: 'Pretending to be another brand or person',
    ur: 'کسی اور برانڈ یا شخص کا روپ دھارے ہوئے ہے',
  },
  other: { en: 'Something else', ur: 'کچھ اور' },
};

const WORDS = {
  title: { en: 'Report this store', ur: 'اس دکان کی شکایت کریں' },
  reason: { en: 'What is wrong?', ur: 'کیا مسئلہ ہے؟' },
  choose: { en: 'Choose one', ur: 'ایک چنیں' },
  details: { en: 'What happened', ur: 'کیا ہوا' },
  phone: {
    en: 'Your mobile number (if Hatti may reach you)',
    ur: 'آپ کا موبائل نمبر (اگر ہٹی آپ سے رابطہ کرے)',
  },
  orderName: {
    en: 'Order number (if it is about one)',
    ur: 'آرڈر نمبر (اگر کسی آرڈر کے بارے میں ہے)',
  },
  send: { en: 'Send the report', ur: 'شکایت بھیجیں' },
  thanks: { en: 'Thank you: Hatti has your report', ur: 'شکریہ: ہٹی کو آپ کی شکایت مل گئی ہے' },
  back: { en: 'Back to the store', ur: 'دکان پر واپس جائیں' },
} satisfies Record<string, Words>;

const ERRORS: Record<string, Words> = {
  reason: { en: 'Choose what is wrong.', ur: 'چنیں کہ کیا مسئلہ ہے۔' },
  details: {
    en: `Say what happened, in up to ${REPORT_DETAILS_MAX.toLocaleString('en')} letters.`,
    ur: `بتائیں کہ کیا ہوا، زیادہ سے زیادہ ${REPORT_DETAILS_MAX.toLocaleString('en')} حروف میں۔`,
  },
  phone: {
    en: 'Enter a Pakistani mobile number, such as 0300 1234567.',
    ur: 'پاکستانی موبائل نمبر لکھیں، جیسے 0300 1234567۔',
  },
  orderName: {
    en: 'An order number is 40 letters at most.',
    ur: 'آرڈر نمبر زیادہ سے زیادہ 40 حروف کا ہوتا ہے۔',
  },
  daily: {
    en: 'You have reported this store today already: Hatti is looking into it.',
    ur: 'آپ آج اس دکان کی شکایت کر چکے ہیں: ہٹی اسے دیکھ رہا ہے۔',
  },
  base: {
    en: 'Hatti could not take the report. Please try again.',
    ur: 'ہٹی شکایت نہیں لے سکا۔ دوبارہ کوشش کریں۔',
  },
};

/** What the shopper typed, to show again where something was wrong. */
export interface ReportForm {
  reason: string;
  details: string;
  phone: string;
  orderName: string;
  /** The store's page they came from, a path on it. */
  from: string;
}

export const EMPTY_REPORT: ReportForm = {
  reason: '',
  details: '',
  phone: '',
  orderName: '',
  from: '',
};

/** What was wrong with a report, by field, as the core says it. */
export type ReportErrors = readonly { field: string; message: string }[];

/** The report page's form: what is wrong, what happened, and how to reach the shopper if they say. */
export function reportPage(
  shopName: string,
  form: ReportForm,
  errors: ReportErrors,
  options: { urdu: boolean },
): RenderedPage {
  const wrong = (field: string): Words | null => {
    const error = errors.find((each) => each.field === field);
    if (!error) return null;
    if (field === 'base') return /already/.test(error.message) ? ERRORS.daily! : ERRORS.base!;
    return ERRORS[field] ?? ERRORS.base!;
  };
  const base = wrong('base');
  return renderPage({
    title: `${WORDS.title.en} · ${shopName}`,
    body: html`
      <p class="shop"><bdi>${shopName}</bdi></p>
      <h1 class="title stack">${say('bilingual', WORDS.title)}</h1>
      <div class="text">
        <p lang="en">
          Tell Hatti, the platform <bdi>${shopName}</bdi> runs on, what is wrong. Hatti's people
          look at every report within 48 hours. The store is not told who reported it.
        </p>
        <p lang="ur" dir="rtl">
          ہٹی کو بتائیں، جس پر <bdi>${shopName}</bdi> چلتی ہے، کہ کیا مسئلہ ہے۔ ہٹی کی ٹیم ہر شکایت
          48 گھنٹوں میں دیکھتی ہے۔ دکان کو نہیں بتایا جاتا کہ شکایت کس نے کی۔
        </p>
      </div>
      ${base && html`<div role="alert">${errorText(base)}</div>`}
      <form method="post" action="${options.urdu ? '/ur/report' : '/report'}">
        <input type="hidden" name="from" value="${form.from}" />
        <div class="field">
          <label class="label" for="reason">${say('bilingual', WORDS.reason)}</label>
          <select
            id="reason"
            name="reason"
            aria-required="true"
            ${wrong('reason') && html`aria-invalid="true" aria-describedby="reason-error"`}
          >
            <option value="">${WORDS.choose.en} · ${WORDS.choose.ur}</option>
            ${REPORT_REASON_VALUES.map(
              (reason) =>
                html`<option value="${reason}" ${reason === form.reason && html`selected`}>
                  ${REASONS[reason].en} · ${REASONS[reason].ur}
                </option>`,
            )}
          </select>
          ${fieldError('reason', wrong('reason'))}
        </div>
        <div class="field">
          <label class="label" for="details">${say('bilingual', WORDS.details)}</label>
          <textarea
            id="details"
            name="details"
            dir="auto"
            maxlength="${REPORT_DETAILS_MAX}"
            aria-required="true"
            ${wrong('details') && html`aria-invalid="true" aria-describedby="details-error"`}
          >
${form.details}</textarea>
          ${fieldError('details', wrong('details'))}
        </div>
        ${input('phone', WORDS.phone, form.phone, wrong('phone'), {
          type: 'tel',
          autocomplete: 'tel',
        })}
        ${input('orderName', WORDS.orderName, form.orderName, wrong('orderName'), {
          type: 'text',
          autocomplete: 'off',
        })}
        <button class="button" type="submit">${say('bilingual', WORDS.send)}</button>
      </form>
      <p class="center muted">
        <a href="${options.urdu ? '/ur/report/rights' : '/report/rights'}"
          >${say('bilingual', RIGHTS_WORDS.link)}</a
        >
      </p>
    `,
  });
}

/** The page after a report is taken: its number, to quote to Hatti, and the way back. */
export function reportTakenPage(
  shopName: string,
  id: string,
  options: { back: string },
): RenderedPage {
  return renderPage({
    title: `${WORDS.thanks.en} · ${shopName}`,
    body: html`
      <p class="shop"><bdi>${shopName}</bdi></p>
      <h1 class="title stack">${say('bilingual', WORDS.thanks)}</h1>
      <p class="center"><strong class="num select-all" dir="ltr">${id}</strong></p>
      <div class="text center muted">
        <p lang="en">
          That is its number. Hatti's people look at it within 48 hours, and message you if you gave
          your number.
        </p>
        <p lang="ur" dir="rtl">
          یہ اس کا نمبر ہے۔ ہٹی کی ٹیم اسے 48 گھنٹوں میں دیکھے گی، اور اگر آپ نے اپنا نمبر دیا ہے تو
          آپ کو پیغام بھیجے گی۔
        </p>
      </div>
      <p class="center">
        <a href="${options.back}">${say('bilingual', WORDS.back)}</a>
      </p>
    `,
  });
}

function input(
  name: string,
  label: Words,
  value: string,
  error: Words | null,
  options: { type: 'tel' | 'text' | 'email'; autocomplete: string },
): Html {
  return html`<div class="field">
    <label class="label" for="${name}">${say('bilingual', label)}</label>
    <input
      id="${name}"
      name="${name}"
      type="${options.type}"
      ${options.type === 'text' ? html`dir="auto"` : html`dir="ltr"`}
      value="${value}"
      autocomplete="${options.autocomplete}"
      ${error && html`aria-invalid="true" aria-describedby="${name}-error"`}
    />
    ${fieldError(name, error)}
  </div>`;
}

function fieldError(name: string, error: Words | null): Html | null {
  return error && html`<div id="${name}-error">${errorText(error)}</div>`;
}

function errorText(error: Words): Html {
  return html`<p class="error" lang="en">${error.en}</p>
    <p class="error" lang="ur" dir="rtl">${error.ur}</p>`;
}

const TAKEN_DOWN = {
  title: { en: 'This store is not available', ur: 'یہ دکان دستیاب نہیں ہے' },
} satisfies Record<string, Words>;

/**
 * The page a store Hatti has taken down shows on every address (ADR-461), in place of its own: its
 * name, and that Hatti closed it after what shoppers reported, in English and Urdu.
 */
export function takenDownPage(shopName: string): RenderedPage {
  return renderPage({
    title: `${TAKEN_DOWN.title.en} · ${shopName}`,
    body: html`
      <p class="shop"><bdi>${shopName}</bdi></p>
      <h1 class="title stack">${say('bilingual', TAKEN_DOWN.title)}</h1>
      <div class="text center muted">
        <p lang="en">
          Hatti has taken <bdi>${shopName}</bdi> down after what shoppers reported of it. Its pages
          and its checkout are closed. If you paid it for an order, keep your receipt.
        </p>
        <p lang="ur" dir="rtl">
          خریداروں کی شکایات کے بعد ہٹی نے <bdi>${shopName}</bdi> کو بند کر دیا ہے۔ اس کے صفحات اور
          چیک آؤٹ بند ہیں۔ اگر آپ نے اسے کسی آرڈر کی ادائیگی کی ہے تو اپنی رسید سنبھال کر رکھیں۔
        </p>
      </div>
    `,
  });
}

// Rights complaints (TNS-04, ADR-474): the owner of a trademark or copyright, or someone acting
// for them, names the store's listings that infringe it, at /report/rights and /ur/report/rights.
// Hatti's page, as the report page is, in English and Urdu.

/** The most listings one complaint names, as the core takes. */
export const RIGHTS_LISTINGS_MAX = 20;

const RIGHTS_KINDS: Record<(typeof RIGHTS_KIND_VALUES)[number], Words> = {
  trademark: {
    en: 'My trademark or brand name is used',
    ur: 'میرا ٹریڈ مارک یا برانڈ نام استعمال ہوا ہے',
  },
  copyright: {
    en: 'My photos, designs or writing are copied',
    ur: 'میری تصویریں، ڈیزائن یا تحریر نقل کی گئی ہیں',
  },
  counterfeit: {
    en: 'Fake goods sold as my brand',
    ur: 'میرے برانڈ کے نام پر نقلی سامان بیچا جا رہا ہے',
  },
};

const ACTING_AS: Record<(typeof RIGHTS_ACTING_AS_VALUES)[number], Words> = {
  owner: { en: 'I own the right', ur: 'یہ حق میرا ہے' },
  agent: { en: 'I act for its owner', ur: 'میں اس کے مالک کی طرف سے ہوں' },
};

const RIGHTS_WORDS = {
  link: {
    en: 'Own a brand or work these listings copy? Send a rights complaint',
    ur: 'کیا یہ اشیاء آپ کے برانڈ یا کام کی نقل ہیں؟ حقوق کی شکایت بھیجیں',
  },
  title: { en: 'Rights complaint', ur: 'حقوق کی شکایت' },
  kind: { en: 'What right do the listings infringe?', ur: 'یہ اشیاء کس حق کی خلاف ورزی کرتی ہیں؟' },
  choose: { en: 'Choose one', ur: 'ایک چنیں' },
  rightsOwner: { en: "The right's owner (brand or company)", ur: 'حق کا مالک (برانڈ یا کمپنی)' },
  registration: {
    en: 'Registration number (if registered)',
    ur: 'رجسٹریشن نمبر (اگر رجسٹرڈ ہے)',
  },
  complainant: { en: 'Your full name', ur: 'آپ کا پورا نام' },
  actingAs: { en: 'You are', ur: 'آپ' },
  email: { en: 'Your email', ur: 'آپ کا ای میل' },
  phone: {
    en: 'Your mobile number (if Hatti may call)',
    ur: 'آپ کا موبائل نمبر (اگر ہٹی کال کرے)',
  },
  listings: {
    en: "The listings' addresses, one on each line",
    ur: 'اشیاء کے ایڈریس، ہر لائن پر ایک',
  },
  details: {
    en: 'How they infringe it',
    ur: 'یہ کس طرح خلاف ورزی کرتی ہیں',
  },
  sworn: {
    en: 'I believe in good faith that these listings are not authorised by the owner of the right or the law, and what I say here is accurate. I own the right or may act for its owner.',
    ur: 'میں نیک نیتی سے سمجھتا/سمجھتی ہوں کہ ان اشیاء کی اجازت حق کے مالک یا قانون نے نہیں دی، اور جو میں نے یہاں لکھا ہے وہ درست ہے۔ یہ حق میرا ہے یا میں اس کے مالک کی طرف سے ہوں۔',
  },
  signature: { en: 'Type your full name to sign', ur: 'دستخط کے لیے اپنا پورا نام لکھیں' },
  send: { en: 'Send the complaint', ur: 'شکایت بھیجیں' },
  thanks: { en: 'Hatti has your complaint', ur: 'ہٹی کو آپ کی شکایت مل گئی ہے' },
} satisfies Record<string, Words>;

const RIGHTS_ERRORS: Record<string, Words> = {
  kind: { en: 'Choose what right the listings infringe.', ur: 'چنیں کہ کس حق کی خلاف ورزی ہے۔' },
  rightsOwner: { en: "Name the right's owner.", ur: 'حق کے مالک کا نام لکھیں۔' },
  registration: {
    en: 'A registration number is 100 letters at most.',
    ur: 'رجسٹریشن نمبر زیادہ سے زیادہ 100 حروف کا ہوتا ہے۔',
  },
  complainant: { en: 'Give your full name.', ur: 'اپنا پورا نام لکھیں۔' },
  actingAs: {
    en: 'Say whether you own the right or act for its owner.',
    ur: 'بتائیں کہ حق آپ کا ہے یا آپ مالک کی طرف سے ہیں۔',
  },
  email: {
    en: 'Enter an email Hatti can reach you at, like name@example.com.',
    ur: 'ایسا ای میل لکھیں جس پر ہٹی آپ سے رابطہ کر سکے، جیسے name@example.com۔',
  },
  phone: {
    en: 'Enter a Pakistani mobile number, such as 0300 1234567.',
    ur: 'پاکستانی موبائل نمبر لکھیں، جیسے 0300 1234567۔',
  },
  listings: {
    en: `Give the address of each product on this store, one on each line, ${RIGHTS_LISTINGS_MAX} at most.`,
    ur: `اس دکان پر ہر پروڈکٹ کا ایڈریس دیں، ہر لائن پر ایک، زیادہ سے زیادہ ${RIGHTS_LISTINGS_MAX}۔`,
  },
  details: {
    en: `Say how the listings infringe the right, in up to ${REPORT_DETAILS_MAX.toLocaleString('en')} letters.`,
    ur: `بتائیں کہ یہ اشیاء کس طرح خلاف ورزی کرتی ہیں، زیادہ سے زیادہ ${REPORT_DETAILS_MAX.toLocaleString('en')} حروف میں۔`,
  },
  sworn: {
    en: 'Tick the statement to send the complaint.',
    ur: 'شکایت بھیجنے کے لیے بیان پر نشان لگائیں۔',
  },
  signature: { en: 'Type your full name to sign.', ur: 'دستخط کے لیے اپنا پورا نام لکھیں۔' },
  daily: {
    en: 'You have sent this store enough complaints today: Hatti is looking into them.',
    ur: 'آپ آج اس دکان کی کافی شکایات بھیج چکے ہیں: ہٹی انہیں دیکھ رہا ہے۔',
  },
  base: {
    en: 'Hatti could not take the complaint. Please try again.',
    ur: 'ہٹی شکایت نہیں لے سکا۔ دوبارہ کوشش کریں۔',
  },
};

/** What the complainant typed, to show again where something was wrong. */
export interface RightsForm {
  kind: string;
  rightsOwner: string;
  registration: string;
  complainant: string;
  actingAs: string;
  email: string;
  phone: string;
  listings: string;
  details: string;
  sworn: boolean;
  signature: string;
}

export const EMPTY_RIGHTS: RightsForm = {
  kind: '',
  rightsOwner: '',
  registration: '',
  complainant: '',
  actingAs: '',
  email: '',
  phone: '',
  listings: '',
  details: '',
  sworn: false,
  signature: '',
};

/** A listing's address as the complainant gave it, and the product handle it names. */
export interface ListingAddress {
  handle: string;
  line: string;
}

/**
 * The product handles a complaint's lines name: each line an address on this store, whole or
 * its path, such as https://zari.hatti.pk/products/lawn or /ur/products/lawn. Lines on another
 * host, or not a product's, are wrong.
 */
export function listingAddresses(
  text: string,
  hosts: readonly string[],
): { found: ListingAddress[]; wrong: string[] } {
  const found: ListingAddress[] = [];
  const wrong: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const absolute = /^https?:\/\//i.test(line)
      ? line
      : line.startsWith('/')
        ? null
        : /^[a-z0-9.-]+\.[a-z]{2,}\//i.test(line)
          ? `https://${line}`
          : null;
    let url: URL;
    try {
      url = new URL(absolute ?? line, 'http://storefront.invalid');
    } catch {
      wrong.push(line);
      continue;
    }
    if (absolute && !hosts.includes(url.hostname.toLowerCase())) {
      wrong.push(line);
      continue;
    }
    const match = /^(?:\/ur)?(?:\/collections\/[^/]+)?\/products\/([^/]+)\/?$/.exec(url.pathname);
    let handle: string | null;
    try {
      handle = match ? decodeURIComponent(match[1]!).toLowerCase() : null;
    } catch {
      handle = null;
    }
    if (handle) found.push({ handle, line });
    else wrong.push(line);
  }
  return { found, wrong };
}

/** The rights complaint page's form: the right, whose, who complains, the listings, and the oath. */
export function rightsPage(
  shopName: string,
  form: RightsForm,
  errors: ReportErrors,
  options: { urdu: boolean },
): RenderedPage {
  const wrong = (field: string): Words | null => {
    const error = errors.find((each) => each.field === field);
    if (!error) return null;
    if (field === 'base') {
      return /today/.test(error.message) ? RIGHTS_ERRORS.daily! : RIGHTS_ERRORS.base!;
    }
    return RIGHTS_ERRORS[field] ?? RIGHTS_ERRORS.base!;
  };
  const base = wrong('base');
  const select = (
    name: string,
    label: Words,
    value: string,
    choices: readonly string[],
    names: Record<string, Words>,
  ) =>
    html`<div class="field">
      <label class="label" for="${name}">${say('bilingual', label)}</label>
      <select
        id="${name}"
        name="${name}"
        aria-required="true"
        ${wrong(name) && html`aria-invalid="true" aria-describedby="${name}-error"`}
      >
        <option value="">${RIGHTS_WORDS.choose.en} · ${RIGHTS_WORDS.choose.ur}</option>
        ${choices.map(
          (choice) =>
            html`<option value="${choice}" ${choice === value && html`selected`}>
              ${names[choice]!.en} · ${names[choice]!.ur}
            </option>`,
        )}
      </select>
      ${fieldError(name, wrong(name))}
    </div>`;
  const area = (name: 'listings' | 'details', label: Words, value: string, max: number) =>
    html`<div class="field">
      <label class="label" for="${name}">${say('bilingual', label)}</label>
      <textarea
        id="${name}"
        name="${name}"
        dir="${name === 'listings' ? 'ltr' : 'auto'}"
        maxlength="${max}"
        aria-required="true"
        ${wrong(name) && html`aria-invalid="true" aria-describedby="${name}-error"`}
      >
${value}</textarea>
      ${fieldError(name, wrong(name))}
    </div>`;
  return renderPage({
    title: `${RIGHTS_WORDS.title.en} · ${shopName}`,
    body: html`
      <p class="shop"><bdi>${shopName}</bdi></p>
      <h1 class="title stack">${say('bilingual', RIGHTS_WORDS.title)}</h1>
      <div class="text">
        <p lang="en">
          If listings on <bdi>${shopName}</bdi> infringe your trademark or copyright, or sell fakes
          as your brand, tell Hatti, the platform it runs on. Hatti's people decide within 48 hours
          and take down listings that infringe. Hatti may give the store your name, email and
          complaint, so it can answer you.
        </p>
        <p lang="ur" dir="rtl">
          اگر <bdi>${shopName}</bdi> پر اشیاء آپ کے ٹریڈ مارک یا کاپی رائٹ کی خلاف ورزی کرتی ہیں، یا
          آپ کے برانڈ کے نام پر نقلی سامان بیچتی ہیں، تو ہٹی کو بتائیں، جس پر یہ دکان چلتی ہے۔ ہٹی
          کی ٹیم 48 گھنٹوں میں فیصلہ کرتی ہے اور خلاف ورزی کرنے والی اشیاء ہٹا دیتی ہے۔ ہٹی آپ کا
          نام، ای میل اور شکایت دکان کو دے سکتا ہے تاکہ وہ آپ کو جواب دے سکے۔
        </p>
      </div>
      ${base && html`<div role="alert">${errorText(base)}</div>`}
      <form method="post" action="${options.urdu ? '/ur/report/rights' : '/report/rights'}">
        ${select('kind', RIGHTS_WORDS.kind, form.kind, RIGHTS_KIND_VALUES, RIGHTS_KINDS)}
        ${input('rightsOwner', RIGHTS_WORDS.rightsOwner, form.rightsOwner, wrong('rightsOwner'), {
          type: 'text',
          autocomplete: 'organization',
        })}
        ${input(
          'registration',
          RIGHTS_WORDS.registration,
          form.registration,
          wrong('registration'),
          { type: 'text', autocomplete: 'off' },
        )}
        ${area('listings', RIGHTS_WORDS.listings, form.listings, 10_000)}
        ${area('details', RIGHTS_WORDS.details, form.details, REPORT_DETAILS_MAX)}
        ${input('complainant', RIGHTS_WORDS.complainant, form.complainant, wrong('complainant'), {
          type: 'text',
          autocomplete: 'name',
        })}
        ${select('actingAs', RIGHTS_WORDS.actingAs, form.actingAs, RIGHTS_ACTING_AS_VALUES, ACTING_AS)}
        ${input('email', RIGHTS_WORDS.email, form.email, wrong('email'), {
          type: 'email',
          autocomplete: 'email',
        })}
        ${input('phone', RIGHTS_WORDS.phone, form.phone, wrong('phone'), {
          type: 'tel',
          autocomplete: 'tel',
        })}
        <div class="field">
          <label class="choice">
            <input
              type="checkbox"
              name="sworn"
              value="1"
              ${form.sworn && html`checked`}
              ${wrong('sworn') && html`aria-invalid="true" aria-describedby="sworn-error"`}
            />
            <span
              ><span lang="en">${RIGHTS_WORDS.sworn.en}</span
              ><span lang="ur" dir="rtl">${RIGHTS_WORDS.sworn.ur}</span></span
            >
          </label>
          ${fieldError('sworn', wrong('sworn'))}
        </div>
        ${input('signature', RIGHTS_WORDS.signature, form.signature, wrong('signature'), {
          type: 'text',
          autocomplete: 'name',
        })}
        <button class="button" type="submit">${say('bilingual', RIGHTS_WORDS.send)}</button>
      </form>
    `,
  });
}

/** The page after a complaint is taken: its number, to quote to Hatti, and what happens next. */
export function rightsTakenPage(
  shopName: string,
  id: string,
  options: { back: string },
): RenderedPage {
  return renderPage({
    title: `${RIGHTS_WORDS.thanks.en} · ${shopName}`,
    body: html`
      <p class="shop"><bdi>${shopName}</bdi></p>
      <h1 class="title stack">${say('bilingual', RIGHTS_WORDS.thanks)}</h1>
      <p class="center"><strong class="num select-all" dir="ltr">${id}</strong></p>
      <div class="text center muted">
        <p lang="en">
          That is its number. Hatti's people decide within 48 hours and write to you by email.
        </p>
        <p lang="ur" dir="rtl">
          یہ اس کا نمبر ہے۔ ہٹی کی ٹیم 48 گھنٹوں میں فیصلہ کرے گی اور آپ کو ای میل پر بتائے گی۔
        </p>
      </div>
      <p class="center">
        <a href="${options.back}">${say('bilingual', WORDS.back)}</a>
      </p>
    `,
  });
}
