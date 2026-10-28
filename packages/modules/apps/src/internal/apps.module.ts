import { Module } from '@nestjs/common';
import { AppChargeService } from './app-charges.service.js';
import { AppEmbedService } from './app-embeds.service.js';
import { AppInstallsService } from './app-installs.service.js';
import { CustomAppService } from './custom-apps.service.js';
import { AppEmbedResolver } from './graphql/app-embeds.resolver.js';
import { AppInstallsResolver } from './graphql/app-installs.resolver.js';
import { CustomAppResolver } from './graphql/apps.resolver.js';
import { WebhookResolver } from './graphql/webhooks.resolver.js';
import { WebhookService } from './webhooks.service.js';

/** Needs {@link Database} and {@link SecretBox} providers from the host application. */
@Module({
  providers: [
    CustomAppService,
    CustomAppResolver,
    WebhookService,
    WebhookResolver,
    AppInstallsService,
    AppInstallsResolver,
    AppEmbedService,
    AppEmbedResolver,
    AppChargeService,
  ],
  exports: [
    CustomAppService,
    WebhookService,
    AppInstallsService,
    AppEmbedService,
    AppChargeService,
  ],
})
export class AppsModule {}
