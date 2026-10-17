import {
  ConversationsService,
  WHATSAPP_REPLIES,
  type WhatsAppReplySettings,
} from './conversations.service.js';
import { ConversationResolver } from './graphql/conversation.resolver.js';
import { CustomersModule } from '@hatti/customers/public';
import { Module, type DynamicModule } from '@nestjs/common';
import { AutomationsService } from './automations.service.js';
import { StockWatchService } from './stock-watches.service.js';
import { BroadcastsService } from './broadcasts.service.js';
import { MessagingCustomerData } from './customer-data.js';
import { AutomationResolver } from './graphql/automation.resolver.js';
import { BroadcastResolver } from './graphql/broadcast.resolver.js';
import { MessagingResolver } from './graphql/messaging.resolver.js';
import { PushResolver } from './graphql/push.resolver.js';
import { MessagesService } from './messages.service.js';
import { PUSH_SENDER, PushService } from './push.service.js';
import { SmsSenderResolver } from './graphql/sms-sender.resolver.js';
import { SmsSendersService } from './sms-senders.service.js';
import { StopLinkController } from './stop.controller.js';
import { MessagingSettingsService } from './settings.service.js';
import { WhatsAppAccountResolver } from './graphql/whatsapp-account.resolver.js';
import { WhatsAppTemplateResolver } from './graphql/whatsapp-template.resolver.js';
import { WHATSAPP_SIGNUP, WhatsAppAccountsService } from './whatsapp-accounts.service.js';
import type { WhatsAppSignupSettings } from './whatsapp-business.js';
import { WhatsAppTemplatesService } from './whatsapp-templates.service.js';
import {
  WHATSAPP_WEBHOOK,
  WhatsAppWebhookController,
  type WhatsAppWebhookSettings,
} from './webhooks.controller.js';
import { WebPushSender, type VapidKeys } from './web-push.js';

/**
 * Needs {@link Database} and {@link SecretBox} providers from the host application, which keeps
 * each webhook request's raw body as `rawBody`. Without WhatsApp's settings, its webhook answers
 * 404; without Embedded Signup's, shops cannot connect numbers of their own (ADR-419); without
 * VAPID keys, nothing is pushed to staff's browsers (ADR-506); without Meta's Graph API for
 * replies, the inbox cannot answer customers (ADR-546).
 */
@Module({})
export class MessagingModule {
  static forRoot(options: {
    whatsapp: WhatsAppWebhookSettings | null;
    signup?: WhatsAppSignupSettings | null;
    push?: VapidKeys | null;
    replies?: WhatsAppReplySettings | null;
  }): DynamicModule {
    return {
      module: MessagingModule,
      imports: [CustomersModule],
      controllers: [WhatsAppWebhookController, StopLinkController],
      providers: [
        { provide: WHATSAPP_WEBHOOK, useValue: options.whatsapp },
        { provide: WHATSAPP_SIGNUP, useValue: options.signup ?? null },
        { provide: WHATSAPP_REPLIES, useValue: options.replies ?? null },
        {
          provide: PUSH_SENDER,
          useValue: options.push ? new WebPushSender(options.push) : null,
        },
        MessagesService,
        MessagingSettingsService,
        MessagingResolver,
        ConversationsService,
        ConversationResolver,
        MessagingCustomerData,
        WhatsAppAccountsService,
        WhatsAppAccountResolver,
        WhatsAppTemplatesService,
        WhatsAppTemplateResolver,
        BroadcastsService,
        BroadcastResolver,
        AutomationsService,
        StockWatchService,
        AutomationResolver,
        SmsSendersService,
        SmsSenderResolver,
        PushService,
        PushResolver,
      ],
      exports: [
        MessagesService,
        ConversationsService,
        MessagingSettingsService,
        WhatsAppAccountsService,
        WhatsAppTemplatesService,
        BroadcastsService,
        AutomationsService,
        StockWatchService,
        PushService,
      ],
    };
  }
}
