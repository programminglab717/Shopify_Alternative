// The messaging module's public surface. Everything under src/internal is private to this module.
export {
  MessageCharges,
  chargedFor,
  messageCostOf,
  smsParts,
  type MessageCost,
} from '../internal/charges.js';
export { MESSAGING_CUSTOMER_DATA, MessagingCustomerData } from '../internal/customer-data.js';
export {
  MessagingEvents,
  type MessageRepliedPayload,
  type MessagingSettingsUpdatedPayload,
  type WhatsAppAccountConnectedPayload,
  type WhatsAppAccountDisconnectedPayload,
  type BroadcastChangedPayload,
  type MarketingAutomationUpdatedPayload,
  type WhatsAppTemplateChangedPayload,
  type WhatsAppTemplateStatusPayload,
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
  SES_EMAIL,
  WHATSAPP_CLOUD,
  WhatsAppCloudProvider,
  type MessageChannel,
  type MessageProvider,
  type OutgoingMessage,
  type PhoneChannel,
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
  RESCUE_ANSWERS,
  EMAILED_KINDS,
  MESSAGE_CATEGORIES,
  MESSAGE_KINDS,
  MESSAGE_LANGUAGES,
  PLATFORM_MESSAGE_KINDS,
  SECRET_KINDS,
  TEMPLATES,
  WHATSAPP_ONLY_KINDS,
  asksToStop,
  messageEmail,
  messageText,
  paidByShop,
  templateButtons,
  templateName,
  templateParameters,
  type AnyMessageKind,
  type ConfirmationAnswer,
  type RescueAnswer,
  type MessageCategory,
  type MessageEmail,
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
  type TemplateStatusUpdate,
  type WhatsAppWebhook,
} from '../internal/whatsapp-webhook.js';
export {
  WHATSAPP_SIGNUP,
  WhatsAppAccountsService,
  type WhatsAppAccountConnectInput,
  type WhatsAppAccountRecord,
  type WhatsAppSender,
  type WhatsAppSignupRecord,
} from '../internal/whatsapp-accounts.service.js';
export {
  WHATSAPP_QUALITIES,
  WhatsAppBusinessClient,
  qualityOf,
  templateComponents,
  type TemplateSubmission,
  type GraphResult,
  type WhatsAppNumber,
  type WhatsAppQuality,
  type WhatsAppSignupSettings,
} from '../internal/whatsapp-business.js';
export {
  WHATSAPP_TEMPLATE_LIMITS,
  WHATSAPP_TEMPLATE_STATUSES,
  WhatsAppTemplatesService,
  type WhatsAppTemplateInput,
  type WhatsAppTemplateRecord,
  type WhatsAppTemplateStatus,
} from '../internal/whatsapp-templates.service.js';
export {
  BROADCAST_AHEAD_DAYS,
  BROADCAST_STATUSES,
  BroadcastsService,
  audienceQuery,
  type BroadcastCounts,
  type BroadcastRound,
  type BroadcastInput,
  type BroadcastRecord,
  type BroadcastStatus,
} from '../internal/broadcasts.service.js';
export { MARKETING_HOURS, marketingHours } from '../internal/marketing-hours.js';
export {
  AUTOMATION_KINDS,
  AutomationsService,
  WIN_BACK_DAYS,
  WIN_BACK_GRACE_DAYS,
  type AutomationCustomer,
  type AutomationInput,
  type AutomationKind,
  type AutomationRecord,
} from '../internal/automations.service.js';
