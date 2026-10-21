import { Module, type DynamicModule } from '@nestjs/common';
import { AdSpendService } from './ad-spend.service.js';
import { MarketingCalendarService } from './calendar.service.js';
import { ConversionsService } from './conversions.service.js';
import { GoogleAdsAccountService } from './google-ads-account.service.js';
import { GoogleAdsClient, type GoogleAdsOptions } from './google-ads-spend.js';
import { GoogleAnalyticsService } from './google-settings.service.js';
import { MarketingResolver } from './graphql/marketing.resolver.js';
import { MetaAdAccountService } from './meta-ad-account.service.js';
import { MetaAdsClient } from './meta-ad-spend.js';
import type { MetaGraphOptions } from './meta-client.js';
import { MetaConversionsService } from './meta-settings.service.js';
import { TikTokAdAccountService } from './tiktok-ad-account.service.js';
import { TikTokAdsClient } from './tiktok-ad-spend.js';
import type { TikTokApiOptions } from './tiktok-client.js';
import { TikTokEventsService } from './tiktok-settings.service.js';

/** Needs {@link Database} and {@link SecretBox} providers from the host application. */
@Module({})
export class MarketingModule {
  /**
   * `metaGraph`: Meta's Graph API, which shops' ad accounts' spend is read from (ADR-564);
   * `tiktokApi`: TikTok's Business API, which their advertiser accounts' is (ADR-566);
   * `googleAds`: the Google Ads API and Google's OAuth, which their Google Ads accounts' is
   * (ADR-678).
   */
  static forRoot(options: {
    metaGraph: MetaGraphOptions;
    tiktokApi: TikTokApiOptions;
    googleAds: GoogleAdsOptions;
  }): DynamicModule {
    return {
      module: MarketingModule,
      providers: [
        { provide: MetaAdsClient, useValue: new MetaAdsClient(options.metaGraph) },
        { provide: TikTokAdsClient, useValue: new TikTokAdsClient(options.tiktokApi) },
        { provide: GoogleAdsClient, useValue: new GoogleAdsClient(options.googleAds) },
        MetaConversionsService,
        TikTokEventsService,
        GoogleAnalyticsService,
        ConversionsService,
        MarketingCalendarService,
        AdSpendService,
        MetaAdAccountService,
        TikTokAdAccountService,
        GoogleAdsAccountService,
        MarketingResolver,
      ],
      exports: [
        MetaConversionsService,
        TikTokEventsService,
        GoogleAnalyticsService,
        ConversionsService,
        AdSpendService,
        MetaAdAccountService,
        TikTokAdAccountService,
        GoogleAdsAccountService,
      ],
    };
  }
}
