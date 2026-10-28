import { Module } from '@nestjs/common';
import { AppChargeService } from './app-charges.service.js';
import { AppEmbedService } from './app-embeds.service.js';
import { AppFunctionService } from './app-functions.service.js';
import { AppInstallsService } from './app-installs.service.js';
import { CustomAppService } from './custom-apps.service.js';
import { AppEmbedResolver } from './graphql/app-embeds.resolver.js';
import { AppFunctionResolver } from './graphql/app-functions.resolver.js';
import { AppInstallsResolver } from './graphql/app-installs.resolver.js';
import { CustomAppResolver } from './graphql/apps.resolver.js';
import { WebhookResolver } from './graphql/webhooks.resolver.js';
import { WorkflowResolver } from './graphql/workflows.resolver.js';
import { WebhookService } from './webhooks.service.js';
import { WorkflowService } from './workflows.service.js';

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
    AppFunctionService,
    AppFunctionResolver,
    AppChargeService,
    WorkflowService,
    WorkflowResolver,
  ],
  exports: [
    CustomAppService,
    WebhookService,
    AppInstallsService,
    AppEmbedService,
    AppChargeService,
    WorkflowService,
  ],
})
export class AppsModule {}
