import { Module, type DynamicModule } from '@nestjs/common';
import { AdSpendService } from './ad-spend.service.js';
import { MarketingCalendarService } from './calendar.service.js';
import { ConversionsService } from './conversions.service.js';
import { GoogleAnalyticsService } from './google-settings.service.js';
import { MarketingResolver } from './graphql/marketing.resolver.js';
import { MetaAdAccountService } from './meta-ad-account.service.js';
import { MetaAdsClient } from './meta-ad-spend.js';
import type { MetaGraphOptions } from './meta-client.js';
import { MetaConversionsService } from './meta-settings.service.js';
import { TikTokEventsService } from './tiktok-settings.service.js';

/** Needs {@link Database} and {@link SecretBox} providers from the host application. */
@Module({})
export class MarketingModule {
  /** `metaGraph`: Meta's Graph API, which shops' ad accounts' spend is read from (ADR-564). */
  static forRoot(options: { metaGraph: MetaGraphOptions }): DynamicModule {
    return {
      module: MarketingModule,
      providers: [
        { provide: MetaAdsClient, useValue: new MetaAdsClient(options.metaGraph) },
        MetaConversionsService,
        TikTokEventsService,
        GoogleAnalyticsService,
        ConversionsService,
        MarketingCalendarService,
        AdSpendService,
        MetaAdAccountService,
        MarketingResolver,
      ],
      exports: [
        MetaConversionsService,
        TikTokEventsService,
        GoogleAnalyticsService,
        ConversionsService,
        AdSpendService,
        MetaAdAccountService,
      ],
    };
  }
}
