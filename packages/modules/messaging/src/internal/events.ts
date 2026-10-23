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
  ConversationReplied: 'conversation.replied',
  ConversationAssigned: 'conversation.assigned',
  ContactMessageReceived: 'contact_message.received',
} as const;

/**
 * A customer wrote to the shop on WhatsApp, kept in its conversation with them (ADR-545). The
 * aggregate is the conversation.
 */
export interface ConversationMessageReceivedPayload {
  messageId: string;
  /** When they wrote, as WhatsApp says. */
  at: string;
  /**
   * Whether this message began their wait for an answer (ADR-761): the first since the shop last
   * answered. Absent from events before.
   */
  startedWaiting?: boolean;
  /** The account of the member of staff the conversation is given to, if anyone. */
  assigneeId?: string | null;
}

/**
 * The shop's staff answered a customer's conversation on WhatsApp, and WhatsApp took the reply
 * (ADR-546). The aggregate is the conversation.
 */
export interface ConversationRepliedPayload {
  messageId: string;
  at: string;
}

/**
 * A conversation was given to a member of staff to answer, or to no one (ADR-759, ADR-761). The
 * aggregate is the conversation.
 */
export interface ConversationAssignedPayload {
  /** The account it is given to; null for no one. */
  assigneeId: string | null;
  /** The account of the member of staff who gave it; null for an app. */
  assignedBy: string | null;
}

/**
 * A shopper wrote to the shop through its online store's contact form (ADR-589). The aggregate is
 * the message; it says neither who wrote nor what, which the Admin API gives.
 */
export interface ContactMessageReceivedPayload {
  /** The storefront's language the form was in. */
  language: 'en' | 'ur';
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
  /** The button's payload, or what the key pressed on a call answers (ADR-611): "confirm". */
  answer: string;
  channel: 'whatsapp' | 'voice';
  /** When they answered, as WhatsApp or the voice gateway says. */
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
