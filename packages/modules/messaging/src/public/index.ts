// The messaging module's public surface. Everything under src/internal is private to this module.
export {
  MessageCharges,
  chargedFor,
  messageCostOf,
  smsParts,
  type MessageCost,
} from '../internal/charges.js';
export {
  CONVERSATION_WINDOW_MS,
  claimCartIn,
  claimVoiceNoteIn,
  keepTranscriptIn,
  ConversationsService,
  type ClaimedVoiceNote,
  OVERDUE_SWEEP_LIMIT,
  overdueConversationsIn,
  shopsWithReplyTargetIn,
  type OverdueConversation,
  REPLY_MAX_LENGTH,
  WHATSAPP_REPLIES,
  type WhatsAppReplySettings,
  type ConversationMessageRecord,
  type ConversationRecord,
} from '../internal/conversations.service.js';
export { MESSAGING_CUSTOMER_DATA, MessagingCustomerData } from '../internal/customer-data.js';
export { Conversation } from '../internal/graphql/conversation.types.js';
export { toConversation } from '../internal/graphql/conversation.resolver.js';
export {
  MessagingEvents,
  type ConversationMessageReceivedPayload,
  type ConversationRepliedPayload,
  type ConversationAssignedPayload,
  type MessageRepliedPayload,
  type MessagingSettingsUpdatedPayload,
  type WhatsAppAccountConnectedPayload,
  type WhatsAppAccountDisconnectedPayload,
  type BroadcastChangedPayload,
  type MarketingAutomationUpdatedPayload,
  type WebChatUpdatedPayload,
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
  VOICE_GATEWAY,
  VoiceGatewayProvider,
  WHATSAPP_CLOUD,
  WhatsAppCloudProvider,
  type MessageChannel,
  type MediaResult,
  type MessageProvider,
  type OutgoingMessage,
  type PhoneChannel,
  type PricedChannel,
  type SendResult,
  type SmsGatewayOptions,
  type VoiceGatewayOptions,
  type WhatsAppCloudOptions,
} from '../internal/providers.js';
export {
  MESSAGE_CONTENT_KEPT,
  MessageRetention,
  RETENTION_BATCH,
  type PurgedCounts,
} from '../internal/retention.js';
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
  MARKETING_KINDS,
  TO_THE_SHOP_KINDS,
  WHATSAPP_ONLY_KINDS,
  CALL_KINDS,
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
  SUPPORT_INBOX,
  SUPPORT_LINE,
  type SupportInbox,
  type SupportLineSettings,
} from '../internal/support-inbox.js';
export {
  VoiceWebhookController,
  WHATSAPP_WEBHOOK,
  WhatsAppWebhookController,
  type WhatsAppWebhookSettings,
} from '../internal/webhooks.controller.js';
export {
  VOICE_WEBHOOK,
  parseCallResult,
  voiceSignatureValid,
  type CallResult,
  type VoiceWebhookSettings,
} from '../internal/voice-webhook.js';
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
  type MetaTemplate,
  type PreparedTemplate,
  type TemplateSubmission,
  type GraphResult,
  type WhatsAppGraphSettings,
  type WhatsAppNumber,
  type WhatsAppQuality,
  type WhatsAppSignupSettings,
} from '../internal/whatsapp-business.js';
export {
  WHATSAPP_TEMPLATE_LIMITS,
  WHATSAPP_TEMPLATE_STATUSES,
  WhatsAppTemplatesService,
  type LibrarySent,
  type WhatsAppLibraryRecord,
  type WhatsAppTemplateInput,
  type WhatsAppTemplateRecord,
  type WhatsAppTemplateStatus,
} from '../internal/whatsapp-templates.service.js';
export {
  LIBRARY_KINDS,
  LIBRARY_LANGUAGES,
  LIBRARY_LIMITS,
  libraryKey,
  libraryParameters,
  libraryTemplate,
  libraryVariables,
} from '../internal/template-library.js';
export {
  BROADCAST_AHEAD_DAYS,
  BROADCAST_CHANNELS,
  BROADCAST_STATUSES,
  BroadcastsService,
  SMS_BROADCAST_MAX,
  audienceQuery,
  type BroadcastChannel,
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
  automationOnIn,
  CASHBACK,
  type CashbackTier,
  cashbackIn,
  codPrepaidCreditIn,
  COD_PREPAID_CREDIT,
  WIN_BACK_DAYS,
  WIN_BACK_GRACE_DAYS,
  type AutomationCustomer,
  type AutomationInput,
  type AutomationKind,
  type AutomationRecord,
} from '../internal/automations.service.js';
export {
  WebChatService,
  webChatIn,
  type WebChatMessageRecord,
  type WebChatSettingsInput,
  type WebChatSettingsRecord,
} from '../internal/web-chat.service.js';
export {
  REFERRALS,
  REFERRAL_REFUSALS,
  ReferralProgramService,
  recordReferralIn,
  referralCodeIn,
  referralProgramIn,
  referralRecordedIn,
  referralsRewardedIn,
  referrerOfIn,
  type ReferralProgramInput,
  type ReferralProgramRecord,
  type ReferralRecord,
  type ReferralRefusal,
} from '../internal/referrals.service.js';
export {
  STOCK_WATCH_DAYS,
  STOCK_WATCHES_PER_PHONE,
  StockWatchService,
  type StockWatchInput,
  type StockWatchOutcome,
  type StockWatchRecord,
} from '../internal/stock-watches.service.js';
export {
  STOP_LINK_PATH,
  messageIdOf,
  stopLinkPage,
  stopToken,
  type StopLinkView,
} from '../internal/stop-links.js';
export { StopLinkController } from '../internal/stop.controller.js';
export { BroadcastChannel as BroadcastChannelEnum } from '../internal/graphql/broadcast.types.js';
export { MessageLanguage as MessageLanguageEnum } from '../internal/graphql/messaging.types.js';
export {
  SMS_SENDER_LIMITS,
  SmsSendersService,
  smsSenderName,
  type ShopSmsSenderRecord,
  type SmsSenderDecisionProblem,
  type SmsSenderRecord,
  type SmsSenderReview,
  type SmsSenderStatus,
} from '../internal/sms-senders.service.js';
export {
  PUSH_KINDS,
  PUSH_LIMITS,
  PUSH_NEEDS,
  PUSH_ROLES,
  PUSH_SENDER,
  PushService,
  pushedTo,
  type PushKind,
  type PushMessage,
  type PushRecipient,
  type PushSubscriptionRecord,
} from '../internal/push.service.js';
// Pushes to shoppers from the online store, and the shop's campaigns (OS-14, ADR-833, ADR-834).
export {
  SHOPPER_PUSH_LIMITS,
  ShopperPushService,
  isPushServiceEndpoint,
  type PushCampaignInput,
  type PushCampaignRecord,
  type PushCampaignRound,
} from '../internal/shopper-push.service.js';
export {
  WEB_PUSH,
  WebPushSender,
  encryptPayload,
  generateVapidKeys,
  vapidAuthorization,
  type PushOutcome,
  type PushSubscriptionKeys,
  type VapidKeys,
} from '../internal/web-push.js';
export {
  SUPPORT_AGENT_DAILY,
  SUPPORT_AGENT_QUIET_MS,
  SUPPORT_FAQ_LIMITS,
  type SupportFaq,
  SupportAgentService,
  type SupportAgentOutcome,
  type SupportAgentTask,
} from '../internal/support-agent.service.js';
export {
  VOICE_ORDER_DAY,
  VoiceOrderService,
  recordVoiceOrderIn,
  voiceOrdersOnIn,
  voiceOrdersSinceIn,
  type VoiceOrderOutcome,
  type VoiceOrderSetting,
} from '../internal/voice-orders.service.js';
