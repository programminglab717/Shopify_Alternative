import type { WebChatMessageJson } from '@hatti/storefront-api';
import { cookieOf } from './cart.js';

// The chat on a shop's pages (MSG-10, ADR-811): the browser keeps its session's token in a
// cookie of its own, which the theme's script never reads; the storefront sends what the shopper
// writes on to the core and gives the script the session's messages.

export const CHAT_COOKIE = 'hatti_chat';

/** How long a browser keeps its chat: a month after it last wrote. */
const CHAT_SECONDS = 30 * 24 * 3600;

/** A session's token, as the core makes them. */
const CHAT_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The session's token the request's cookie keeps; null for none, or one that cannot be one. */
export function chatTokenOf(cookies: string | undefined): string | null {
  const token = cookieOf(cookies, CHAT_COOKIE);
  return token !== null && CHAT_TOKEN.test(token) ? token : null;
}

/** The cookie that keeps the session's `token`. */
export function chatCookie(token: string, options: { secure: boolean }): string {
  return (
    `${CHAT_COOKIE}=${token}; Path=/; Max-Age=${CHAT_SECONDS}; HttpOnly; ` +
    `SameSite=Lax${options.secure ? '; Secure' : ''}`
  );
}

/** The `Set-Cookie` header that forgets a session the core no longer knows. */
export function chatCookieCleared(options: { secure: boolean }): string {
  return `${CHAT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${options.secure ? '; Secure' : ''}`;
}

/** The session's messages, as the theme's script shows them: who wrote, what, and when. */
export function chatMessagesJson(messages: readonly WebChatMessageJson[]) {
  return messages.map((message) => ({
    from: message.direction === 'inbound' ? 'shopper' : 'shop',
    body: message.body,
    at: message.at,
  }));
}
