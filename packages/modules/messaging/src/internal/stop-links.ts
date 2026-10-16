import { html, renderPage, say, type Html, type Words } from '@hatti/documents';
import type { MessageLanguage } from './templates.js';

// The link an SMS campaign's message ends on (MKT-02, ADR-458): SMS brings no "STOP" back, as
// WhatsApp does (MSG-09), so each message carries a link to its own page, which stops the shop's
// SMS to the number once the customer says so. The link is its message's ID, 22 characters.

/** Where stop links are, on the core's own address: /s/<token>. */
export const STOP_LINK_PATH = 's';

/** A message's stop link's token: its ID's 16 bytes, base64url. */
export function stopToken(messageId: string): string {
  return Buffer.from(messageId.replace(/-/g, ''), 'hex').toString('base64url');
}

/** The message a stop link's token names; null for one that names none. */
export function messageIdOf(token: string): string | null {
  if (!/^[A-Za-z0-9_-]{22}$/.test(token)) return null;
  const hex = Buffer.from(token, 'base64url').toString('hex');
  if (hex.length !== 32) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** What a stop link's page says: whose messages, to which number, and whether they stopped. */
export interface StopLinkView {
  shop: string;
  /** The number, its middle hidden: "0300 ••••567". */
  phone: string;
  language: MessageLanguage;
  stopped: boolean;
}

const WORDS = {
  title: { en: 'Stop messages', ur: 'پیغامات بند کریں' },
  ask: {
    en: 'Stop {shop} sending offers by SMS to {phone}?',
    ur: 'کیا {shop} کی آفرز کے ایس ایم ایس {phone} پر بند کر دیں؟',
  },
  stop: { en: 'Stop these messages', ur: 'یہ پیغامات بند کریں' },
  stopped: {
    en: '{shop} will send no more offers by SMS to {phone}.',
    ur: '{shop} اب {phone} پر آفرز کے ایس ایم ایس نہیں بھیجے گا۔',
  },
  notFound: { en: "This link isn't known", ur: 'یہ لنک معلوم نہیں' },
} satisfies Record<string, Words>;

function filled(words: Words, view: StopLinkView): Words {
  const fill = (text: string) => text.replace('{shop}', view.shop).replace('{phone}', view.phone);
  return { en: fill(words.en), ur: fill(words.ur) };
}

/** A stop link's page: asking first, then saying it is done; or that the link isn't known. */
export function stopLinkPage(view: StopLinkView | null): {
  status: number;
  html: string;
  contentSecurityPolicy: string;
} {
  if (!view) {
    const page = renderPage({
      title: WORDS.notFound.en,
      body: html`<h1 class="title stack">${say('bilingual', WORDS.notFound)}</h1>`,
    });
    return { status: 404, ...page };
  }
  const language = view.language === 'ur' ? 'urdu' : 'english';
  let body: Html;
  if (view.stopped) {
    body = html`<div class="banner done stack" role="status">
      <p>${say(language, filled(WORDS.stopped, view))}</p>
    </div>`;
  } else {
    body = html`<p>${say(language, filled(WORDS.ask, view))}</p>
      <form method="post" class="stack">
        <button type="submit">${say(language, WORDS.stop)}</button>
      </form>`;
  }
  const page = renderPage({
    title: WORDS.title.en,
    body: html`<h1 class="title stack">${say(language, WORDS.title)}</h1>
      ${body}`,
  });
  return { status: 200, ...page };
}
