import { scriptJson } from './liquid.js';

// An age gate (OS-15, ADR-889): a shop selling what is only for adults asks each visitor to
// confirm their age before its pages show. Pages are the same for every visitor, kept at the edge,
// so the gate is the browser's to show, as the consent banner is (ADR-551): until a visitor says
// they are old enough, the page is hidden behind it.

/** The cookie keeping a visitor's answer, the age they confirmed. */
export const AGE_COOKIE = 'hatti_age';

/** How long a visitor who said they are old enough is not asked again: a month. */
const AGE_MAX_AGE = 30 * 24 * 60 * 60;

/** What the gate says, in the storefront's languages; `{age}` is the shop's. */
const AGE_WORDS = {
  en: {
    label: 'Age check',
    question: 'This store is for those {age} or older. Are you {age} or older?',
    yes: 'Yes, I am {age} or older',
    no: 'No',
    refused: "Sorry, this store isn't for you.",
  },
  ur: {
    label: 'عمر کی تصدیق',
    question:
      'یہ اسٹور {age} سال یا زیادہ عمر والوں کے لیے ہے۔ کیا آپ کی عمر {age} سال یا زیادہ ہے؟',
    yes: 'جی ہاں، میری عمر {age} سال یا زیادہ ہے',
    no: 'نہیں',
    refused: 'معذرت، یہ اسٹور آپ کے لیے نہیں ہے۔',
  },
} as const;

/**
 * The script a page's head carries while the shop asks visitors' age: the page hidden at once,
 * where the visitor has not said they are `age` or older, and a dialog asking, in the page's
 * language. Yes keeps their answer for a month, and shows the page; no leaves it hidden.
 */
export function ageGateScript(age: number, locale: string): string {
  const source = locale === 'ur' ? AGE_WORDS.ur : AGE_WORDS.en;
  const words = Object.fromEntries(
    Object.entries(source).map(([key, text]) => [key, text.replaceAll('{age}', String(age))]),
  );
  return `(function () {
  try {
    var found = document.cookie.match(/(?:^|;\\s*)${AGE_COOKIE}=(\\d+)(?:;|$)/);
    if (found && Number(found[1]) >= ${age}) return;
    var root = document.documentElement;
    root.classList.add('hatti-age-gate');
    var words = ${scriptJson(words)};
    var show = function () {
      var gate = document.createElement('div');
      gate.id = 'hatti-age';
      gate.setAttribute('role', 'dialog');
      gate.setAttribute('aria-modal', 'true');
      gate.setAttribute('aria-label', words.label);
      gate.dir = ${scriptJson(locale === 'ur' ? 'rtl' : 'ltr')};
      var box = document.createElement('div');
      var text = document.createElement('p');
      text.textContent = words.question;
      box.append(text);
      var yes = document.createElement('button');
      yes.type = 'button';
      yes.textContent = words.yes;
      yes.setAttribute('data-age', 'yes');
      yes.addEventListener('click', function () {
        document.cookie = '${AGE_COOKIE}=${age}; path=/; max-age=${AGE_MAX_AGE}; samesite=lax' +
          (location.protocol === 'https:' ? '; secure' : '');
        gate.remove();
        root.classList.remove('hatti-age-gate');
      });
      var no = document.createElement('button');
      no.type = 'button';
      no.textContent = words.no;
      no.setAttribute('data-age', 'no');
      no.addEventListener('click', function () {
        text.textContent = words.refused;
        yes.remove();
        no.remove();
      });
      box.append(yes, no);
      gate.append(box);
      document.body.append(gate);
      yes.focus();
    };
    if (document.body) show();
    else addEventListener('DOMContentLoaded', show);
  } catch (error) {}
})();`;
}

/** The gate's look: the page hidden, and the question over it. */
export const AGE_GATE_STYLE =
  'html.hatti-age-gate body>*:not(#hatti-age){visibility:hidden}' +
  '#hatti-age{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;' +
  'justify-content:center;padding:16px;background:#f5f5f5;font:16px/1.5 system-ui,sans-serif;color:#1a1a1a}' +
  '#hatti-age>div{max-width:420px;display:flex;flex-direction:column;gap:12px;text-align:center}' +
  '#hatti-age p{margin:0}#hatti-age button{min-height:44px;padding:0 16px;border-radius:6px;' +
  'border:1px solid #1a1a1a;background:#fff;color:#1a1a1a;font:inherit;font-weight:600;cursor:pointer}' +
  '#hatti-age button[data-age=yes]{background:#1a1a1a;color:#fff}';

/** The gate's tags for a page's head, while the shop asks visitors' age; empty while it does not. */
export function ageGateTags(age: number | undefined, locale: string): string {
  if (!age) return '';
  return (
    `<style>${AGE_GATE_STYLE}</style>` +
    `<script data-hatti-age>${ageGateScript(age, locale)}</script>`
  );
}
