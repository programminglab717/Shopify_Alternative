// What a shop's customers are told about their orders (MSG-01, ADR-146), in English and Urdu: the
// words an SMS carries, and the template of Hatti's shared WhatsApp number that carries the same,
// approved by Meta under its name, its variables in the order its body numbers them.

/** The notifications a shop's customers get, each of which the shop may turn off. */
export const MESSAGE_KINDS = [
  'order_placed',
  'order_shipped',
  'order_delivered',
  'order_cancelled',
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const MESSAGE_LANGUAGES = ['en', 'ur'] as const;
export type MessageLanguage = (typeof MESSAGE_LANGUAGES)[number];

/** What a message says, filled in as it is queued. */
export interface MessageVariables {
  /** The customer's first name, as their order's address has it. */
  name?: string;
  shop: string;
  /** The order's name, "#1043". */
  order: string;
  /** "Rs 5,250". */
  total?: string;
  courier?: string;
  tracking?: string;
  /** Where the courier tracks the parcel. */
  url?: string;
}

interface Template {
  /** The template's name on Hatti's WhatsApp number. */
  whatsapp: string;
  /** Its body's variables, {{1}} first. */
  parameters: readonly (keyof MessageVariables)[];
  text: Record<MessageLanguage, string>;
}

/** Shown for a variable a message lacks: WhatsApp refuses an empty one. */
const NONE = '-';

export const TEMPLATES: Readonly<Record<MessageKind, Template>> = {
  order_placed: {
    whatsapp: 'hatti_order_placed',
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
  order_shipped: {
    whatsapp: 'hatti_order_shipped',
    parameters: ['shop', 'order', 'courier', 'tracking'],
    text: {
      en: 'Your order {order} from {shop} is on its way with {courier}. Tracking number: {tracking}.',
      ur: '{shop} سے آپ کا آرڈر {order} {courier} کے ذریعے روانہ ہو گیا ہے۔ ٹریکنگ نمبر: {tracking}',
    },
  },
  order_delivered: {
    whatsapp: 'hatti_order_delivered',
    parameters: ['shop', 'order'],
    text: {
      en: 'Your order {order} from {shop} is delivered. Thank you for shopping with them!',
      ur: '{shop} سے آپ کا آرڈر {order} پہنچا دیا گیا ہے۔ خریداری کا شکریہ!',
    },
  },
  order_cancelled: {
    whatsapp: 'hatti_order_cancelled',
    parameters: ['shop', 'order'],
    text: {
      en: 'Your order {order} from {shop} is cancelled. Please contact {shop} with any questions.',
      ur: '{shop} سے آپ کا آرڈر {order} منسوخ کر دیا گیا ہے۔ سوالات کے لیے {shop} سے رابطہ کریں۔',
    },
  },
};

/** A message's words, as an SMS carries them: its tracking link after them, when it has one. */
export function messageText(
  kind: MessageKind,
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
export function templateParameters(kind: MessageKind, variables: MessageVariables): string[] {
  return TEMPLATES[kind].parameters.map((name) => variables[name] || NONE);
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
