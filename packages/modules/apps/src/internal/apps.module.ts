import { AppInstallsService } from './app-installs.service.js';
import { AppInstallsResolver } from './graphql/app-installs.resolver.js';
import { Module } from '@nestjs/common';
import { CustomAppService } from './custom-apps.service.js';
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
  ],
  exports: [CustomAppService, WebhookService, AppInstallsService],
})
export class AppsModule {}
