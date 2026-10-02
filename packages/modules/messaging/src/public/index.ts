// The messaging module's public surface. Everything under src/internal is private to this module.
export { MessageCharges, messageCostOf, smsParts, type MessageCost } from '../internal/charges.js';
export { MESSAGING_CUSTOMER_DATA, MessagingCustomerData } from '../internal/customer-data.js';
export {
  MessagingEvents,
  type MessageRepliedPayload,
  type MessagingSettingsUpdatedPayload,
} from '../internal/events.js';
export {
  MESSAGE_STATUSES,
  MessagesService,
  type ClaimedMessage,
  type MessageOutcome,
  type MessageRecord,
  type MessageStatus,
  type MessageToQueue,
  type StatusUpdate,
} from '../internal/messages.service.js';
export { MessageChannel as MessageChannelEnum } from '../internal/graphql/messaging.types.js';
export { MessagingModule } from '../internal/messaging.module.js';
export {
  LogProvider,
  MESSAGE_CHANNELS,
  SmsGatewayProvider,
  WHATSAPP_CLOUD,
  WhatsAppCloudProvider,
  type MessageChannel,
  type MessageProvider,
  type OutgoingMessage,
  type SendResult,
  type SmsGatewayOptions,
  type WhatsAppCloudOptions,
} from '../internal/providers.js';
export {
  MESSAGE_ROUTINGS,
  MessagingSettingsService,
  settingsIn,
  type MessageRouting,
  type MessagingSettingsInput,
  type MessagingSettingsRecord,
} from '../internal/settings.service.js';
export {
  ALWAYS_SENT,
  CONFIRMATION_ANSWERS,
  MESSAGE_CATEGORIES,
  MESSAGE_KINDS,
  MESSAGE_LANGUAGES,
  PLATFORM_MESSAGE_KINDS,
  SECRET_KINDS,
  TEMPLATES,
  asksToStop,
  messageText,
  paidByShop,
  templateButtons,
  templateParameters,
  type AnyMessageKind,
  type ConfirmationAnswer,
  type MessageCategory,
  type MessageKind,
  type MessageLanguage,
  type MessageVariables,
  type PlatformMessageKind,
} from '../internal/templates.js';
export {
  WHATSAPP_WEBHOOK,
  WhatsAppWebhookController,
  type WhatsAppWebhookSettings,
} from '../internal/webhooks.controller.js';
export {
  parseWhatsAppWebhook,
  signatureValid,
  type InboundMessage,
  type WhatsAppWebhook,
} from '../internal/whatsapp-webhook.js';
