// What a shop's customers are told about their orders (MSG-01, ADR-146), in English and Urdu: the
// words an SMS carries, and the template of Hatti's shared WhatsApp number that carries the same,
// approved by Meta under its name, its variables in the order its body numbers them, and its
// buttons (COD-01, ADR-147).

/**
 * The notifications a shop's customers get, and the alerts the shop gets itself (ADR-157), each
 * of which the shop may turn off.
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
  'one_time_code',
  'stock_low',
  'stock_out',
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/**
 * Hatti's own messages to the people who run shops, never a shop's to its customers: sent at once
 * for whoever asks, at Hatti's cost, never queued with a shop's or charged to its credit (ADR-159).
 */
export const PLATFORM_MESSAGE_KINDS = ['sign_in_code'] as const;
export type PlatformMessageKind = (typeof PLATFORM_MESSAGE_KINDS)[number];

/** Any message's kind: a shop's, or Hatti's own. */
export type AnyMessageKind = MessageKind | PlatformMessageKind;

/** Messages a shop cannot turn off: what a shopper asked for, as a code to prove their number. */
export const ALWAYS_SENT: readonly MessageKind[] = ['one_time_code'];

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
  text: Record<MessageLanguage, string>;
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
  },
  order_confirmed: {
    whatsapp: 'hatti_order_confirmed',
    category: 'utility',
    parameters: ['shop', 'order'],
    text: {
      en: "Thank you! Your order {order} from {shop} is confirmed. We'll tell you when it ships.",
      ur: 'شکریہ! {shop} سے آپ کا آرڈر {order} کنفرم ہو گیا ہے۔ روانگی پر ہم آپ کو بتائیں گے۔',
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
  },
  order_delivered: {
    whatsapp: 'hatti_order_delivered',
    category: 'utility',
    parameters: ['shop', 'order'],
    text: {
      en: 'Your order {order} from {shop} is delivered. Thank you for shopping with them!',
      ur: '{shop} سے آپ کا آرڈر {order} پہنچا دیا گیا ہے۔ خریداری کا شکریہ!',
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
  },
};

/** A message's words, as an SMS carries them: its tracking link after them, when it has one. */
export function messageText(
  kind: AnyMessageKind,
  language: MessageLanguage,
  variables: MessageVariables,
): string {
  const text = TEMPLATES[kind].text[language].replace(
    /\{(\w+)\}/g,
    (_, name: string) => variables[name as keyof MessageVariables] || NONE,
  );
  return variables.url ? `${text} ${variables.url}` : text;
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
