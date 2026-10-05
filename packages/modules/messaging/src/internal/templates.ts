// What a shop's customers are told about their orders (MSG-01, ADR-146), in English and Urdu: the
// words an SMS carries, and the template of Hatti's shared WhatsApp number that carries the same,
// approved by Meta under its name, its variables in the order its body numbers them, and its
// buttons (COD-01, ADR-147); and, for the order's news, the subject of the email that carries the
// same words to the address its customer gave (ADR-181).

/**
 * The notifications a shop's customers get, and the alerts the shop gets itself (ADR-157), each
 * of which the shop may turn off; and Hatti's notices of the shop's bills, which it may not
 * (ADR-169).
 */
export const MESSAGE_KINDS = [
  'order_placed',
  'order_confirmation',
  'order_confirmed',
  'order_address',
  'order_shipped',
  'order_out_for_delivery',
  'order_delivered',
  'order_cancelled',
  'order_paid',
  'order_advance_paid',
  'order_payment_reminder',
  'order_confirmation_reminder',
  'one_time_code',
  'stock_low',
  'stock_out',
  'invoice_due',
  'plan_ended',
  'credit_low',
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/**
 * Hatti's own messages to the people who run shops, never a shop's to its customers: sent at once
 * for whoever asks, at Hatti's cost, never queued with a shop's or charged to its credit (ADR-159):
 * codes to sign in with, word to a number that another took the place of (ADR-173), and word of a
 * sign-in from a device new to an account (ADR-179).
 */
export const PLATFORM_MESSAGE_KINDS = ['sign_in_code', 'number_replaced', 'sign_in_alert'] as const;
export type PlatformMessageKind = (typeof PLATFORM_MESSAGE_KINDS)[number];

/** Any message's kind: a shop's, or Hatti's own. */
export type AnyMessageKind = MessageKind | PlatformMessageKind;

/**
 * Messages a shop cannot turn off: what a shopper asked for, as a code to prove their number, and
 * Hatti's notices of the shop's bills (ADR-169).
 */
export const ALWAYS_SENT: readonly MessageKind[] = [
  'one_time_code',
  'invoice_due',
  'plan_ended',
  'credit_low',
];

/** What the buttons of a message asking a customer to confirm their order answer (COD-01). */
export const CONFIRMATION_ANSWERS = ['confirm', 'cancel', 'address'] as const;
export type ConfirmationAnswer = (typeof CONFIRMATION_ANSWERS)[number];

/**
 * Meta's categories of WhatsApp templates, which it prices apart (07 §2.3): news of an order its
 * customer placed is utility, a code authentication, and what broadcasts will send marketing.
 */
export const MESSAGE_CATEGORIES = ['utility', 'authentication', 'marketing'] as const;
export type MessageCategory = (typeof MESSAGE_CATEGORIES)[number];

export const MESSAGE_LANGUAGES = ['en', 'ur'] as const;
export type MessageLanguage = (typeof MESSAGE_LANGUAGES)[number];

/** What a message says, filled in as it is queued. */
export interface MessageVariables {
  /** The customer's first name, as their order's address has it. */
  name?: string;
  shop: string;
  /** The order's name, "#1043"; none for a code to place it. */
  order?: string;
  /** "Rs 5,250". */
  total?: string;
  /** What the customer pays the rider: "Rs 5,250" (ADR-160). */
  due?: string;
  courier?: string;
  tracking?: string;
  /** The order's page for its customer, which follows its parcels too (ADR-160). */
  url?: string;
  /** A one-time code (CHK-09): dropped from the message once it is sent. */
  code?: string;
  /** For the shop's own alerts: a product, with its variant, and the units left for sale. */
  product?: string;
  stock?: string;
  /**
   * For the shop's bills with Hatti (ADR-169): an invoice's number, its amount and its plan. For
   * an order's customer (ADR-171): what the shop has received of the order.
   */
  invoice?: string;
  amount?: string;
  plan?: string;
  /** The shop's message credit left: "Rs 85.50". */
  balance?: string;
  /** For a number another replaced (ADR-173): the one in its place, masked, "+92 300 •••4567". */
  phone?: string;
  /**
   * For a reminder to pay (ADR-174): when the order is cancelled unpaid, "4 Oct, 3:00 pm". For a
   * sign-in alert (ADR-179): when the account was signed in to, in Pakistan.
   */
  date?: string;
  /** For a sign-in alert (ADR-179): what signed in, "Chrome on Android". */
  device?: string;
}

/**
 * A button of a WhatsApp template: a quick reply, whose payload the webhook gives back with the
 * customer's answer, or a link to `url`, its last part the variable the template's URL ends with.
 */
export type TemplateButton =
  | { type: 'quick_reply'; payload: string }
  | { type: 'url' }
  /** An authentication template's button that copies the code, which it carries. */
  | { type: 'copy_code' };

interface Template {
  /** The template's name on Hatti's WhatsApp number. */
  whatsapp: string;
  /** Meta's category for it, which prices it (MSG-04). */
  category: MessageCategory;
  /** Its body's variables, {{1}} first. */
  parameters: readonly (keyof MessageVariables)[];
  buttons?: readonly TemplateButton[];
  /**
   * Whether its variables hold a secret, as a code: dropped once it is sent, so no SMS goes in its
   * place after; one asked for anew goes instead.
   */
  secret?: boolean;
  /**
   * Hatti's own notice to the shop about its bills (ADR-169): Hatti pays for it, never the shop's
   * credit, which may be what it is about.
   */
  hattiPays?: boolean;
  text: Record<MessageLanguage, string>;
  /**
   * The subject of the email carrying its words (ADR-181): news of an order with one goes by
   * email too, to the address its customer gave with the order.
   */
  subject?: Record<MessageLanguage, string>;
}

/** Shown for a variable a message lacks: WhatsApp refuses an empty one. */
const NONE = '-';

export const TEMPLATES: Readonly<Record<AnyMessageKind, Template>> = {
  order_placed: {
    whatsapp: 'hatti_order_placed',
    category: 'utility',
    parameters: ['name', 'shop', 'order', 'total'],
    text: {
      en:
        'Assalam-o-Alaikum {name}! Your order {order} from {shop} for {total} is placed. ' +
        "We'll tell you when it ships.",
      ur:
        'السلام علیکم {name}! {shop} سے آپ کا آرڈر {order} ({total}) موصول ہو گیا ہے۔ ' +
        'روانگی پر ہم آپ کو بتائیں گے۔',
    },
    subject: {
      en: 'Your order {order} from {shop}',
      ur: '{shop} سے آپ کا آرڈر {order}',
    },
  },
  order_confirmation: {
    whatsapp: 'hatti_order_confirmation',
    category: 'utility',
    parameters: ['name', 'shop', 'order', 'total'],
    buttons: CONFIRMATION_ANSWERS.map((payload) => ({ type: 'quick_reply', payload })),
    text: {
      en:
        'Assalam-o-Alaikum {name}! Please confirm your order {order} from {shop} for {total}, ' +
        'paid in cash on delivery, so they can send it. Confirm or cancel it here:',
      ur:
        'السلام علیکم {name}! {shop} سے آپ کا آرڈر {order} ({total})، ادائیگی ڈیلیوری پر۔ ' +
        'روانگی کے لیے اسے کنفرم کریں۔ کنفرم یا منسوخ کرنے کے لیے یہ لنک کھولیں:',
    },
    subject: {
      en: 'Please confirm your order {order}',
      ur: 'اپنا آرڈر {order} کنفرم کریں',
    },
  },
  order_confirmation_reminder: {
    whatsapp: 'hatti_order_confirmation_reminder',
    category: 'utility',
    parameters: ['name', 'shop', 'order', 'total'],
    // The same answers as the first ask's (ADR-175).
    buttons: CONFIRMATION_ANSWERS.map((payload) => ({ type: 'quick_reply', payload })),
    text: {
      en:
        'Assalam-o-Alaikum {name}! {shop} is still waiting to hear from you about your order ' +
        '{order} for {total}, paid in cash on delivery. Confirm it so they can send it, or ' +
        'cancel it, here:',
      ur:
        'السلام علیکم {name}! {shop} کو آپ کے آرڈر {order} ({total})، ادائیگی ڈیلیوری پر، کے بارے میں ' +
        'آپ کے جواب کا انتظار ہے۔ روانگی کے لیے اسے کنفرم کریں، یا منسوخ کریں، اس لنک سے:',
    },
    subject: {
      en: 'Your order {order} is still waiting for you to confirm it',
      ur: 'آپ کا آرڈر {order} ابھی آپ کی کنفرمیشن کا منتظر ہے',
    },
  },
  order_confirmed: {
    whatsapp: 'hatti_order_confirmed',
    category: 'utility',
    parameters: ['shop', 'order'],
    text: {
      en: "Thank you! Your order {order} from {shop} is confirmed. We'll tell you when it ships.",
      ur: 'شکریہ! {shop} سے آپ کا آرڈر {order} کنفرم ہو گیا ہے۔ روانگی پر ہم آپ کو بتائیں گے۔',
    },
    subject: {
      en: 'Your order {order} is confirmed',
      ur: 'آپ کا آرڈر {order} کنفرم ہو گیا ہے',
    },
  },
  order_address: {
    whatsapp: 'hatti_order_address',
    category: 'utility',
    parameters: ['order'],
    buttons: [{ type: 'url' }],
    text: {
      en: 'To change the address of your order {order}, open its page:',
      ur: 'اپنے آرڈر {order} کا پتہ بدلنے کے لیے یہ لنک کھولیں:',
    },
  },
  order_shipped: {
    whatsapp: 'hatti_order_shipped',
    category: 'utility',
    parameters: ['shop', 'order', 'courier', 'tracking'],
    // Its page, where the parcel's way shows (ADR-160).
    buttons: [{ type: 'url' }],
    text: {
      en: 'Your order {order} from {shop} is on its way with {courier}. Tracking number: {tracking}.',
      ur: '{shop} سے آپ کا آرڈر {order} {courier} کے ذریعے روانہ ہو گیا ہے۔ ٹریکنگ نمبر: {tracking}',
    },
    subject: {
      en: 'Your order {order} is on its way',
      ur: 'آپ کا آرڈر {order} روانہ ہو گیا ہے',
    },
  },
  order_out_for_delivery: {
    whatsapp: 'hatti_order_out_for_delivery',
    category: 'utility',
    parameters: ['shop', 'order', 'due'],
    buttons: [{ type: 'url' }],
    text: {
      en: 'Your order {order} from {shop} is out for delivery today. Please keep {due} ready for the rider.',
      ur: '{shop} سے آپ کا آرڈر {order} آج ڈیلیوری کے لیے نکل چکا ہے۔ براہ کرم رائیڈر کے لیے {due} تیار رکھیں۔',
    },
    subject: {
      en: 'Your order {order} is out for delivery',
      ur: 'آپ کا آرڈر {order} ڈیلیوری کے لیے نکل چکا ہے',
    },
  },
  order_paid: {
    whatsapp: 'hatti_order_paid',
    category: 'utility',
    parameters: ['name', 'shop', 'amount', 'order'],
    text: {
      en:
        'Assalam-o-Alaikum {name}! {shop} has received your payment of {amount} for order {order}. ' +
        "Thank you! We'll tell you when it ships.",
      ur:
        'السلام علیکم {name}! {shop} کو آپ کے آرڈر {order} کی ادائیگی {amount} موصول ہو گئی ہے۔ ' +
        'شکریہ! روانگی پر ہم آپ کو بتائیں گے۔',
    },
    subject: {
      en: 'We have your payment for order {order}',
      ur: 'آرڈر {order} کی ادائیگی موصول ہو گئی ہے',
    },
  },
  order_advance_paid: {
    whatsapp: 'hatti_order_advance_paid',
    category: 'utility',
    parameters: ['name', 'shop', 'amount', 'order', 'due'],
    text: {
      en:
        'Assalam-o-Alaikum {name}! {shop} has received {amount} for your order {order}. ' +
        'Please keep the remaining {due} ready for the rider.',
      ur:
        'السلام علیکم {name}! {shop} کو آپ کے آرڈر {order} کے لیے {amount} موصول ہو گئے ہیں۔ ' +
        'باقی {due} ڈیلیوری پر رائیڈر کو ادا کریں۔',
    },
    subject: {
      en: 'We have the advance for order {order}',
      ur: 'آرڈر {order} کی پیشگی رقم موصول ہو گئی ہے',
    },
  },
  order_payment_reminder: {
    whatsapp: 'hatti_order_payment_reminder',
    category: 'utility',
    parameters: ['name', 'shop', 'order', 'amount', 'date'],
    // Its page, which says how to pay.
    buttons: [{ type: 'url' }],
    text: {
      en:
        'Assalam-o-Alaikum {name}! Your order {order} from {shop} still waits for its payment of ' +
        '{amount}. Pay it by {date}, or the order is cancelled. Its page says how:',
      ur:
        'السلام علیکم {name}! {shop} سے آپ کا آرڈر {order} اب بھی {amount} کی ادائیگی کا منتظر ہے۔ ' +
        '{date} تک ادائیگی کریں، ورنہ آرڈر منسوخ ہو جائے گا۔ ادائیگی کا طریقہ آرڈر کے صفحے پر ہے:',
    },
    subject: {
      en: 'Your order {order} is waiting for its payment',
      ur: 'آپ کا آرڈر {order} ادائیگی کا منتظر ہے',
    },
  },
  order_delivered: {
    whatsapp: 'hatti_order_delivered',
    category: 'utility',
    parameters: ['shop', 'order'],
    text: {
      en: 'Your order {order} from {shop} is delivered. Thank you for shopping with them!',
      ur: '{shop} سے آپ کا آرڈر {order} پہنچا دیا گیا ہے۔ خریداری کا شکریہ!',
    },
    subject: {
      en: 'Your order {order} is delivered',
      ur: 'آپ کا آرڈر {order} پہنچا دیا گیا ہے',
    },
  },
  one_time_code: {
    whatsapp: 'hatti_one_time_code',
    category: 'authentication',
    parameters: ['code'],
    buttons: [{ type: 'copy_code' }],
    secret: true,
    text: {
      en: '{code} is your code to place your order with {shop}. It works for 10 minutes. Never share it.',
      ur: '{shop} پر آرڈر دینے کے لیے آپ کا کوڈ {code} ہے۔ یہ 10 منٹ کام کرے گا۔ کسی کو نہ بتائیں۔',
    },
  },
  sign_in_code: {
    whatsapp: 'hatti_sign_in_code',
    category: 'authentication',
    parameters: ['code'],
    buttons: [{ type: 'copy_code' }],
    secret: true,
    text: {
      en: '{code} is your Hatti code. It works for 10 minutes. Never share it, not even with Hatti.',
      ur: 'ہٹی کے لیے آپ کا کوڈ {code} ہے۔ یہ 10 منٹ کام کرے گا۔ کسی کو نہ بتائیں، ہٹی کو بھی نہیں۔',
    },
  },
  number_replaced: {
    whatsapp: 'hatti_number_replaced',
    category: 'utility',
    parameters: ['phone'],
    text: {
      en: "Hatti: this number no longer signs in to your Hatti account; {phone} does now. If you didn't change it, contact Hatti's support at once.",
      ur: 'ہٹی: یہ نمبر اب آپ کے ہٹی اکاؤنٹ میں سائن ان نہیں کرتا، اب {phone} کرتا ہے۔ اگر یہ تبدیلی آپ نے نہیں کی تو فوراً ہٹی کی سپورٹ سے رابطہ کریں۔',
    },
  },
  sign_in_alert: {
    whatsapp: 'hatti_sign_in_alert',
    category: 'utility',
    parameters: ['device', 'date'],
    text: {
      en: "Hatti: your account was signed in to from {device} on {date}. If it wasn't you, sign that device out from your sessions in Hatti's admin and contact Hatti's support at once.",
      ur: 'ہٹی: آپ کے اکاؤنٹ میں {date} کو {device} سے سائن ان ہوا۔ اگر یہ آپ نہیں تھے تو ہٹی کے ایڈمن میں اپنے سیشنز سے اس ڈیوائس کو سائن آؤٹ کریں اور فوراً ہٹی کی سپورٹ سے رابطہ کریں۔',
    },
  },
  stock_low: {
    whatsapp: 'hatti_stock_low',
    category: 'utility',
    parameters: ['shop', 'product', 'stock'],
    text: {
      en: '{shop}: {product} is running low, with {stock} left for sale online. Restock it in Hatti.',
      ur: '{shop}: {product} کا اسٹاک کم ہے، آن لائن فروخت کے لیے {stock} باقی ہیں۔ ہٹی میں اسٹاک بڑھائیں۔',
    },
  },
  stock_out: {
    whatsapp: 'hatti_stock_out',
    category: 'utility',
    parameters: ['shop', 'product'],
    text: {
      en: '{shop}: {product} is out of stock online. Restock it in Hatti.',
      ur: '{shop}: {product} آن لائن اسٹاک میں ختم ہو گیا ہے۔ ہٹی میں اسٹاک بڑھائیں۔',
    },
  },
  order_cancelled: {
    whatsapp: 'hatti_order_cancelled',
    category: 'utility',
    parameters: ['shop', 'order'],
    text: {
      en: 'Your order {order} from {shop} is cancelled. Please contact {shop} with any questions.',
      ur: '{shop} سے آپ کا آرڈر {order} منسوخ کر دیا گیا ہے۔ سوالات کے لیے {shop} سے رابطہ کریں۔',
    },
    subject: {
      en: 'Your order {order} is cancelled',
      ur: 'آپ کا آرڈر {order} منسوخ کر دیا گیا ہے',
    },
  },
  invoice_due: {
    whatsapp: 'hatti_invoice_due',
    category: 'utility',
    parameters: ['shop', 'invoice', 'plan', 'amount'],
    hattiPays: true,
    text: {
      en: "Hatti: invoice {invoice} for {shop}'s next period on {plan}, {amount}, waits for payment. Pay it from Hatti's admin to keep the plan.",
      ur: 'ہٹی: {shop} کے {plan} پلان کی اگلی مدت کی انوائس {invoice}، {amount}، ادائیگی کی منتظر ہے۔ پلان جاری رکھنے کے لیے ہٹی کے ایڈمن سے ادا کریں۔',
    },
  },
  plan_ended: {
    whatsapp: 'hatti_plan_ended',
    category: 'utility',
    parameters: ['shop'],
    hattiPays: true,
    text: {
      en: "Hatti: {shop}'s plan has ended, its invoice unpaid, and the shop is on Free now. Choose a plan again from Hatti's admin.",
      ur: 'ہٹی: {shop} کا پلان ختم ہو گیا ہے کیونکہ اس کی انوائس ادا نہیں ہوئی، اور دکان اب فری پلان پر ہے۔ ہٹی کے ایڈمن سے دوبارہ پلان منتخب کریں۔',
    },
  },
  credit_low: {
    whatsapp: 'hatti_credit_low',
    category: 'utility',
    parameters: ['shop', 'balance'],
    hattiPays: true,
    text: {
      en: "Hatti: {shop}'s message credit is down to {balance}. Messages to customers wait once it runs out: buy more from Hatti's admin.",
      ur: 'ہٹی: {shop} کا میسج کریڈٹ {balance} رہ گیا ہے۔ کریڈٹ ختم ہونے پر صارفین کو پیغامات رک جائیں گے: ہٹی کے ایڈمن سے مزید خریدیں۔',
    },
  },
};

/** Whether the shop's credit pays for a message of `kind`: not for Hatti's own notices (ADR-169). */
export function paidByShop(kind: MessageKind): boolean {
  return !TEMPLATES[kind].hattiPays;
}

/** `words` with each {variable} filled in: the variable's value, or a dash for one it lacks. */
function fill(words: string, variables: MessageVariables): string {
  return words.replace(
    /\{(\w+)\}/g,
    (_, name: string) => variables[name as keyof MessageVariables] || NONE,
  );
}

/** A message's words, as an SMS carries them: its tracking link after them, when it has one. */
export function messageText(
  kind: AnyMessageKind,
  language: MessageLanguage,
  variables: MessageVariables,
): string {
  const text = fill(TEMPLATES[kind].text[language], variables);
  return variables.url ? `${text} ${variables.url}` : text;
}

/**
 * The notifications that go by email too (ADR-181): the news of an order, to the address its
 * customer gave with it. Not the answers WhatsApp's buttons bring, nor codes, nor the shop's own
 * alerts.
 */
export const EMAILED_KINDS: readonly MessageKind[] = MESSAGE_KINDS.filter(
  (kind) => TEMPLATES[kind].subject,
);

/** An email of a message: its subject, and its body as text and as HTML. */
export interface MessageEmail {
  subject: string;
  text: string;
  html: string;
}

/** What an email says around a message's words (ADR-181). */
const EMAIL_WORDS = {
  button: { en: 'Open your order', ur: 'اپنا آرڈر کھولیں' },
  why: {
    en: "{shop} sent this through Hatti because you gave this email with your order. Replies to it aren't read.",
    ur: '{shop} نے یہ ای میل ہٹی کے ذریعے بھیجی ہے کیونکہ آپ نے اپنے آرڈر کے ساتھ یہ ای میل دی تھی۔ اس ای میل کے جواب پڑھے نہیں جاتے۔',
  },
} as const;

/**
 * A message as an email carries it (ADR-181): its subject, and its words as text and as HTML, its
 * link a button, right to left in Urdu, with why it came. Null for a kind no email carries.
 */
export function messageEmail(
  kind: AnyMessageKind,
  language: MessageLanguage,
  variables: MessageVariables,
): MessageEmail | null {
  const { subject, text } = TEMPLATES[kind];
  if (!subject) return null;
  const words = fill(text[language], variables);
  const why = fill(EMAIL_WORDS.why[language], variables);
  const { url } = variables;
  const rtl = language === 'ur';
  return {
    subject: fill(subject[language], variables).replace(/\s+/g, ' ').trim(),
    text: [words, url, why].filter(Boolean).join('\n\n'),
    html:
      `<!doctype html><html lang="${language}"${rtl ? ' dir="rtl"' : ''}>` +
      '<body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1f2933">' +
      `<p>${escapeHtml(words)}</p>` +
      (url
        ? `<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 16px;` +
          'background:#0f766e;color:#ffffff;border-radius:6px;text-decoration:none">' +
          `${escapeHtml(EMAIL_WORDS.button[language])}</a></p>` +
          `<p dir="ltr" style="font-size:13px;word-break:break-all">${escapeHtml(url)}</p>`
        : '') +
      `<p style="font-size:13px;color:#52606d">${escapeHtml(why)}</p></body></html>`,
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A WhatsApp template's body variables, in its order. */
export function templateParameters(kind: AnyMessageKind, variables: MessageVariables): string[] {
  return TEMPLATES[kind].parameters.map((name) => variables[name] || NONE);
}

/**
 * A WhatsApp template's buttons as a message sends them: each quick reply with its payload, and
 * a link with the last part of the message's URL, which the template's own URL ends with.
 */
export function templateButtons(
  kind: AnyMessageKind,
  variables: MessageVariables,
): { type: 'button'; sub_type: string; index: string; parameters: object[] }[] {
  return (TEMPLATES[kind].buttons ?? []).map((button, index) =>
    button.type === 'quick_reply'
      ? {
          type: 'button',
          sub_type: 'quick_reply',
          index: String(index),
          parameters: [{ type: 'payload', payload: button.payload }],
        }
      : {
          type: 'button',
          // WhatsApp sends a code's copy button as a URL button carrying the code.
          sub_type: 'url',
          index: String(index),
          parameters: [
            {
              type: 'text',
              text: button.type === 'url' ? lastPart(variables.url) : variables.code || NONE,
            },
          ],
        },
  );
}

/** The kinds whose messages hold a secret, dropped once sent. */
export const SECRET_KINDS: readonly MessageKind[] = MESSAGE_KINDS.filter(
  (kind) => TEMPLATES[kind].secret,
);

function lastPart(url: string | undefined): string {
  return url?.replace(/\/+$/, '').split('/').pop() || NONE;
}

/** The words that ask a shop to stop writing, in English, Roman Urdu and Urdu (MSG-09). */
const STOP_WORDS = new Set([
  'stop',
  'unsubscribe',
  'band karo',
  'band kro',
  'bnd karo',
  'بند کرو',
  'بند کریں',
]);

/** Whether a reply asks the shop to stop: one of the words, alone, in any case or spacing. */
export function asksToStop(text: string): boolean {
  const said = text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return STOP_WORDS.has(said);
}
