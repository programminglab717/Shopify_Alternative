/**
 * Events the messaging module publishes. Payloads are thin: fetch current state through the API.
 */
export const MessagingEvents = {
  MessagingSettingsUpdated: 'messaging_settings.updated',
  MessageReplied: 'message.replied',
  WhatsAppAccountConnected: 'whatsapp_account.connected',
  WhatsAppAccountDisconnected: 'whatsapp_account.disconnected',
} as const;

/**
 * A customer answered one of the shop's messages with one of its buttons (ADR-147), as the
 * message's recipient. The aggregate is the message. Heard once or more: WhatsApp's webhook may
 * say it twice.
 */
export interface MessageRepliedPayload {
  /** The message's kind: "order_confirmation". */
  kind: string;
  orderId: string | null;
  /** The button's payload: "confirm". */
  answer: string;
  channel: 'whatsapp';
  /** When they answered, as WhatsApp says. */
  at: string;
}

/** The shop changed how its customers are told about their orders. */
export interface MessagingSettingsUpdatedPayload {
  /** What changed: "routing", "language" or "disabled". */
  changed: string[];
  actorKind: 'app' | 'staff';
  actorId: string;
}

/**
 * The shop connected its own WhatsApp number (ADR-419), in place of any it had. The aggregate is
 * the shop.
 */
export interface WhatsAppAccountConnectedPayload {
  phoneNumberId: string;
  actorKind: 'app' | 'staff';
  actorId: string;
}

/** The shop disconnected its own WhatsApp number (ADR-419). The aggregate is the shop. */
export interface WhatsAppAccountDisconnectedPayload {
  phoneNumberId: string;
  actorKind: 'app' | 'staff';
  actorId: string;
}
