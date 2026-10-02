import { Module } from '@nestjs/common';
import { ConversionsService } from './conversions.service.js';
import { MarketingResolver } from './graphql/marketing.resolver.js';
import { MetaConversionsService } from './meta-settings.service.js';

/** Needs {@link Database} and {@link SecretBox} providers from the host application. */
@Module({
  providers: [MetaConversionsService, ConversionsService, MarketingResolver],
  exports: [MetaConversionsService, ConversionsService],
})
export class MarketingModule {}
