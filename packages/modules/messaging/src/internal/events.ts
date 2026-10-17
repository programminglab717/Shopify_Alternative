/**
 * Events the messaging module publishes. Payloads are thin: fetch current state through the API.
 */
export const MessagingEvents = {
  MessagingSettingsUpdated: 'messaging_settings.updated',
  MessageReplied: 'message.replied',
  WhatsAppAccountConnected: 'whatsapp_account.connected',
  WhatsAppAccountDisconnected: 'whatsapp_account.disconnected',
  WhatsAppTemplateCreated: 'whatsapp_template.created',
  WhatsAppTemplateDeleted: 'whatsapp_template.deleted',
  WhatsAppTemplateStatusChanged: 'whatsapp_template.status_changed',
  BroadcastScheduled: 'broadcast.scheduled',
  BroadcastCancelled: 'broadcast.cancelled',
  BroadcastSent: 'broadcast.sent',
  MarketingAutomationUpdated: 'marketing_automation.updated',
  ConversationMessageReceived: 'conversation.message_received',
} as const;

/**
 * A customer wrote to the shop on WhatsApp, kept in its conversation with them (ADR-545). The
 * aggregate is the conversation.
 */
export interface ConversationMessageReceivedPayload {
  messageId: string;
  /** When they wrote, as WhatsApp says. */
  at: string;
}

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

/** The shop wrote one of its own templates, or deleted one (ADR-420). The aggregate is it. */
export interface WhatsAppTemplateChangedPayload {
  name: string;
  language: 'en' | 'ur';
  actorKind: 'app' | 'staff';
  actorId: string;
}

/** Meta approved, rejected, paused or disabled one of the shop's templates (ADR-420). */
export interface WhatsAppTemplateStatusPayload {
  status: 'pending' | 'approved' | 'rejected' | 'paused' | 'disabled';
  /** Why, where Meta says. */
  reason: string | null;
}

/** The shop scheduled a broadcast, or cancelled one (ADR-421). The aggregate is the broadcast. */
export interface BroadcastChangedPayload {
  /** When it goes, or was to. */
  sendAt: string;
  actorKind: 'app' | 'staff';
  actorId: string;
}

/** Every message of a broadcast is queued (ADR-422). The aggregate is the broadcast. */
export interface BroadcastSentPayload {
  /** The customers it was queued for. */
  recipients: number;
}

/**
 * The shop turned one of its automations on or off, or changed it (ADR-425). The aggregate is the
 * shop: a shop has one of each.
 */
export interface MarketingAutomationUpdatedPayload {
  kind: string;
  enabled: boolean;
  actorKind: 'app' | 'staff';
  actorId: string;
}
