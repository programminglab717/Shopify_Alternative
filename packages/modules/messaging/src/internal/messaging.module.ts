import { CustomersModule } from '@hatti/customers/public';
import { Module, type DynamicModule } from '@nestjs/common';
import { MessagingCustomerData } from './customer-data.js';
import { MessagingResolver } from './graphql/messaging.resolver.js';
import { MessagesService } from './messages.service.js';
import { MessagingSettingsService } from './settings.service.js';
import {
  WHATSAPP_WEBHOOK,
  WhatsAppWebhookController,
  type WhatsAppWebhookSettings,
} from './webhooks.controller.js';

/**
 * Needs a {@link Database} provider from the host application, which keeps each webhook
 * request's raw body as `rawBody`. Without WhatsApp's settings, its webhook answers 404.
 */
@Module({})
export class MessagingModule {
  static forRoot(options: { whatsapp: WhatsAppWebhookSettings | null }): DynamicModule {
    return {
      module: MessagingModule,
      imports: [CustomersModule],
      controllers: [WhatsAppWebhookController],
      providers: [
        { provide: WHATSAPP_WEBHOOK, useValue: options.whatsapp },
        MessagesService,
        MessagingSettingsService,
        MessagingResolver,
        MessagingCustomerData,
      ],
      exports: [MessagesService, MessagingSettingsService],
    };
  }
}
