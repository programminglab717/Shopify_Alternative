// Web chat (MSG-10, ADR-810): shoppers write to the shop from its online store, and read its
// answers there. The storefront sends what they write on to the core, which keeps it as a
// conversation of the shop's inbox, and asks the core for the answers while the chat is open.

import { STOREFRONT_API_PREFIX } from './cart.js';

/**
 * POST a {@link WebChatStartRequest}: a shopper's first message, answered with a
 * {@link WebChatResponse} and the token their browser keeps; 422, with a
 * {@link WebChatErrorResponse}, says what was wrong with it; 404 while the shop's chat is off.
 */
export function webChatPath(shopId: string): string {
  return `${STOREFRONT_API_PREFIX}shops/${shopId}/web-chat`;
}

/**
 * POST a {@link WebChatWriteRequest}: another message of the session's, answered with a
 * {@link WebChatResponse}; 404 for a session that is none, or a chat turned off.
 */
export function webChatMessagesPath(shopId: string): string {
  return `${webChatPath(shopId)}/messages`;
}

/**
 * POST a {@link WebChatReadRequest}: the session's messages, answered with a
 * {@link WebChatResponse}; 404 for a session that is none, or a chat turned off.
 */
export function webChatReadPath(shopId: string): string {
  return `${webChatPath(shopId)}/read`;
}

export const WEB_CHAT_LIMITS = {
  name: 80,
  /** Characters of a message. */
  body: 2_000,
  /** What the chat says before the shopper writes. */
  greeting: 200,
  /** Messages a session may write in an hour. */
  perHour: 30,
  /** The latest messages a session reads. */
  read: 100,
} as const;

export interface WebChatStartRequest {
  name: string;
  /** Their mobile number, as they typed it. */
  phone: string;
  body: string;
}

export interface WebChatWriteRequest {
  token: string;
  body: string;
}

export interface WebChatReadRequest {
  token: string;
}

/** A message of the chat: the shopper's, or the shop's answer. */
export interface WebChatMessageJson {
  id: string;
  /** `inbound` for the shopper's, `outbound` for the shop's. */
  direction: 'inbound' | 'outbound';
  body: string;
  /** ISO 8601. */
  at: string;
}

export interface WebChatResponse {
  /** The session's token: given once, when the chat starts; the browser keeps it. */
  token?: string;
  /** What the session wrote and was answered, the oldest first. */
  messages: WebChatMessageJson[];
}

/** What was wrong with a message, by field: "name", "phone", "body". */
export interface WebChatErrorResponse {
  errors: { field: string; message: string }[];
}
