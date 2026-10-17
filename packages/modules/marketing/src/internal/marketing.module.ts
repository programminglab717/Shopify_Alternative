import { Module } from '@nestjs/common';
import { MarketingCalendarService } from './calendar.service.js';
import { ConversionsService } from './conversions.service.js';
import { MarketingResolver } from './graphql/marketing.resolver.js';
import { MetaConversionsService } from './meta-settings.service.js';

/** Needs {@link Database} and {@link SecretBox} providers from the host application. */
@Module({
  providers: [
    MetaConversionsService,
    ConversionsService,
    MarketingCalendarService,
    MarketingResolver,
  ],
  exports: [MetaConversionsService, ConversionsService],
})
export class MarketingModule {}
