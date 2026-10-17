import type { StatusUpdate } from './messages.service.js';
import type { InboundMessage } from './whatsapp-webhook.js';

// Hatti's support WhatsApp number (BIL-05, ADR-560): what a shop's staff write to it is not a
// customer's to any shop, and is never kept in a shop's inbox, nor stops or answers its
// messages. WhatsApp's webhook hands it to whoever keeps Hatti's support requests, through this
// port, which the messaging module does not depend on; and the statuses of Hatti's answers from
// the number, which no message of the shops' is, likewise.

/** Hatti's support WhatsApp number, as WhatsApp's Cloud API names it; null where none is set. */
export interface SupportLineSettings {
  /** The number's ID in WhatsApp's Cloud API, which a message written to it names. */
  phoneNumberId: string;
}

export const SUPPORT_LINE = Symbol('SUPPORT_LINE');

/** Where what is written to Hatti's support number is kept. */
export interface SupportInbox {
  /** Keeps `message`, written to the support number: whether it was kept, as of a member of staff. */
  recordWhatsApp(message: InboundMessage): Promise<boolean>;
  /** How the answers sent from the support number went: those not its own are given back. */
  recordStatuses?(updates: readonly StatusUpdate[]): Promise<StatusUpdate[]>;
}

export const SUPPORT_INBOX = Symbol('SUPPORT_INBOX');
