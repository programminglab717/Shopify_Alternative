import {
  CALL_KINDS,
  MESSAGE_KINDS,
  TEMPLATES,
  TO_THE_SHOP_KINDS,
  WHATSAPP_ONLY_KINDS,
  type MessageKind,
  type MessageLanguage,
  type MessageVariables,
} from './templates.js';
import type { PreparedTemplate } from './whatsapp-business.js';

// Hatti's library of order templates (07 §2.2, ADR-537): the news of an order its customer
// placed, sent from the shop's own number once Meta approves the template on the shop's own
// WhatsApp Business Account, under the very name it has on Hatti's number, so that a message is
// the same whichever number sends it.

/**
 * What a shop's own number may send in Hatti's place: Hatti's utility templates to the shop's
 * customers. Not codes, which WhatsApp's authentication category takes, nor what goes to the shop
 * itself, nor the gift card's code, kept nowhere once sent, nor marketing, which the shop's own
 * templates send.
 */
export const LIBRARY_KINDS: readonly MessageKind[] = MESSAGE_KINDS.filter(
  (kind) =>
    TEMPLATES[kind].category === 'utility' &&
    !TEMPLATES[kind].secret &&
    !TEMPLATES[kind].hattiPays &&
    !TO_THE_SHOP_KINDS.includes(kind) &&
    !WHATSAPP_ONLY_KINDS.includes(kind) &&
    // A call is read out by the voice gateway, never sent as a template (ADR-611).
    !CALL_KINDS.includes(kind),
);

export const LIBRARY_LANGUAGES: readonly MessageLanguage[] = ['en', 'ur'];

/** How the library is sent: an account at most once a day, a few shops each round. */
export const LIBRARY_LIMITS = {
  retryHours: 24,
  shopsPerSweep: 10,
} as const;

/** What Meta is shown as each variable's example, as it asks with a template that has them. */
const EXAMPLES: Partial<Record<keyof MessageVariables, string>> = {
  name: 'Ayesha',
  shop: "Ayesha's Closet",
  order: '#1001',
  total: 'Rs 4,500',
  courier: 'TCS',
  tracking: '7712345678',
  due: 'Rs 4,500',
  location: 'Gulberg branch',
  address: '12 Main Boulevard, Lahore',
  amount: 'Rs 500',
  balance: 'Rs 1,200',
  date: '30 Oct',
};

/** The words of the buttons that answer, by what they answer. */
const ANSWER_LABELS: Record<string, Record<MessageLanguage, string>> = {
  confirm: { en: 'Confirm', ur: 'کنفرم کریں' },
  cancel: { en: 'Cancel', ur: 'منسوخ کریں' },
  address: { en: 'Change address', ur: 'پتہ بدلیں' },
  retry: { en: 'Deliver again', ur: 'دوبارہ ڈیلیور کریں' },
  call: { en: 'Call me first', ur: 'پہلے کال کریں' },
};

/** The words of the button opening the order's page. */
const LINK_LABELS: Partial<Record<MessageKind, Record<MessageLanguage, string>>> = {
  order_address: { en: 'Change address', ur: 'پتہ بدلیں' },
  order_shipped: { en: 'Track your order', ur: 'آرڈر ٹریک کریں' },
  order_out_for_delivery: { en: 'Track your order', ur: 'آرڈر ٹریک کریں' },
  order_part_paid: { en: 'Pay the rest', ur: 'باقی ادائیگی کریں' },
  order_payment_reminder: { en: 'Pay now', ur: 'ابھی ادائیگی کریں' },
  payment_terms_due: { en: 'Pay now', ur: 'ابھی ادائیگی کریں' },
  payment_terms_overdue: { en: 'Pay now', ur: 'ابھی ادائیگی کریں' },
  return_approved: { en: 'See your order', ur: 'اپنا آرڈر دیکھیں' },
  return_declined: { en: 'See your order', ur: 'اپنا آرڈر دیکھیں' },
  review_request: { en: 'Rate your order', ur: 'رائے دیں' },
};
const LINK_LABEL: Record<MessageLanguage, string> = { en: 'View your order', ur: 'آرڈر دیکھیں' };

/** What a body that would begin with a variable begins with, as Meta refuses one that does. */
const GREETING: Record<MessageLanguage, string> = {
  en: 'Assalam-o-Alaikum!',
  ur: 'السلام علیکم!',
};
const FULL_STOP: Record<MessageLanguage, string> = { en: '.', ur: '۔' };

/**
 * The variables of the template of `kind` in `language`, one for each place its words name one,
 * in the order they come: {{1}} the first. Numbered so, rather than as Hatti's own number has
 * them, a template on a shop's account never has its variables out of order or one twice.
 */
export function libraryVariables(
  kind: MessageKind,
  language: MessageLanguage,
): (keyof MessageVariables)[] {
  return [...TEMPLATES[kind].text[language].matchAll(/\{(\w+)\}/g)].map(
    (match) => match[1] as keyof MessageVariables,
  );
}

/** A message's body variables as its template on the shop's account takes them. */
export function libraryParameters(
  kind: MessageKind,
  language: MessageLanguage,
  variables: MessageVariables,
): string[] {
  return libraryVariables(kind, language).map((name) => variables[name] || '-');
}

/**
 * Hatti's template of `kind` in `language`, as the shop's account is asked to approve it: its
 * words with Meta's {{1}} in place of each variable, as libraryVariables numbers them, a greeting
 * before one that would begin with a variable and a full stop after one that would end with one,
 * as Meta refuses either; its buttons' words; and a link to the order's page, `orderPage`
 * followed by the order's own part.
 */
export function libraryTemplate(
  kind: MessageKind,
  language: MessageLanguage,
  orderPage: string,
): PreparedTemplate {
  const template = TEMPLATES[kind];
  let count = 0;
  let body = template.text[language].replace(/\{\w+\}/g, () => `{{${++count}}}`);
  if (body.startsWith('{{')) body = `${GREETING[language]} ${body}`;
  if (body.endsWith('}}')) body = `${body}${FULL_STOP[language]}`;
  const examples = libraryVariables(kind, language).map((name) => EXAMPLES[name] ?? '1001');
  const buttons = (template.buttons ?? []).map((button) =>
    button.type === 'quick_reply'
      ? { type: 'QUICK_REPLY', text: ANSWER_LABELS[button.payload]![language] }
      : {
          type: 'URL',
          text: (LINK_LABELS[kind] ?? LINK_LABEL)[language],
          url: `${orderPage}{{1}}`,
          example: [`${orderPage}Xk3fQ9`],
        },
  );
  return {
    name: template.whatsapp,
    language,
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: body,
        ...(examples.length > 0 ? { example: { body_text: [examples] } } : {}),
      },
      ...(buttons.length > 0 ? [{ type: 'BUTTONS', buttons }] : []),
    ],
  };
}

/** The key a template of the library is known by in a set of those approved. */
export function libraryKey(kind: string, language: string): string {
  return `${kind}:${language}`;
}
