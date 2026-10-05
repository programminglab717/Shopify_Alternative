import type { Tx } from '@hatti/db';
import type { MessageChannel } from './providers.js';
import {
  TEMPLATES,
  messageText,
  paidByShop,
  type MessageCategory,
  type MessageKind,
  type MessageLanguage,
  type MessageVariables,
} from './templates.js';

/** What sending a message costs, before what it is priced at (MSG-04, ADR-155). */
export interface MessageCost {
  channel: MessageChannel;
  /** Meta's category of its template. */
  category: MessageCategory;
  /** The parts an SMS goes in, each priced; one for WhatsApp, or an email. */
  parts: number;
}

/**
 * What a shop's messages are paid from (MSG-04, ADR-155), which another module keeps: each
 * message is paid for as it is sent, at its price, and waits while the shop's credit cannot pay
 * for it.
 */
export abstract class MessageCharges {
  /** Paisa: what a message costs the shop. */
  abstract priceOf(cost: MessageCost): bigint;

  /** Paisa: the shop's credit now. */
  abstract balanceOf(shopId: string): Promise<bigint>;

  /** Takes the price of message `id`, just sent, from the shop's credit, once, in `tx`. */
  abstract chargeIn(tx: Tx, shopId: string, id: string, cost: MessageCost): Promise<void>;

  /** Gives back what message `id` was charged, once, in `tx`: it was never delivered. */
  abstract refundIn(tx: Tx, shopId: string, id: string): Promise<void>;
}

/**
 * Whether the shop's credit pays for a message: not for Hatti's own notices to the shop (ADR-169),
 * nor for an email, which costs Hatti next to nothing (ADR-181).
 */
export function chargedFor(message: { channel: MessageChannel; kind: MessageKind }): boolean {
  return message.channel !== 'email' && paidByShop(message.kind);
}

/** What a message costs to send: its channel, its template's category, and its SMS's parts. */
export function messageCostOf(message: {
  channel: MessageChannel;
  kind: MessageKind;
  language: MessageLanguage;
  variables: MessageVariables;
}): MessageCost {
  return {
    channel: message.channel,
    category: TEMPLATES[message.kind].category,
    parts:
      message.channel === 'sms'
        ? smsParts(messageText(message.kind, message.language, message.variables))
        : 1,
  };
}

/** GSM 03.38's alphabet, seven bits a character; and its extension, which takes two. */
const GSM_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
const GSM_EXTENDED = new Set('^{}\\[~]|€\f');

/**
 * The parts an SMS of `text` goes in, as gateways charge for it: 160 characters alone, or 153 a
 * part of a longer one, in GSM's alphabet, its extension's characters counting two; 70, or 67 a
 * part, in UCS-2, which Urdu needs, as does any character GSM lacks.
 */
export function smsParts(text: string): number {
  let septets = 0;
  for (const char of text) {
    if (GSM_BASIC.has(char)) septets += 1;
    else if (GSM_EXTENDED.has(char)) septets += 2;
    else return text.length <= 70 ? 1 : Math.ceil(text.length / 67);
  }
  return septets <= 160 ? 1 : Math.ceil(septets / 153);
}
