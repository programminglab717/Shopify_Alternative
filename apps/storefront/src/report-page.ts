import { html, renderPage, say, type Html, type RenderedPage, type Words } from '@hatti/documents';
import { REPORT_REASON_VALUES } from '@hatti/storefront-api';

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
  options: { type: 'tel' | 'text'; autocomplete: string },
): Html {
  return html`<div class="field">
    <label class="label" for="${name}">${say('bilingual', label)}</label>
    <input
      id="${name}"
      name="${name}"
      type="${options.type}"
      ${options.type === 'tel' ? html`dir="ltr"` : html`dir="auto"`}
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
