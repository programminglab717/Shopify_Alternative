import { Module } from '@nestjs/common';
import { AppealController } from './appeal.controller.js';
import { AppealsService } from './appeals.service.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';
import { RightsComplaintsController } from './rights.controller.js';
import { RightsLinkController } from './rights-link.controller.js';
import { RightsComplaintsService } from './rights.service.js';
import { TakedownsService } from './takedowns.service.js';
import { VerificationResolver } from './graphql/verification.resolver.js';
import { VerificationsService } from './verifications.service.js';

/**
 * Trust and safety (TNS-01): shoppers' reports of stores, sent on by storefronts and decided by
 * Hatti's people, and stores taken down; rights owners' complaints of listings (TNS-04); shops
 * verified by Hatti (ONB-11). Needs {@link Database} and {@link ObjectStorage} providers from the
 * host application.
 */
@Module({
  controllers: [
    ReportsController,
    RightsComplaintsController,
    AppealController,
    RightsLinkController,
  ],
  providers: [
    ReportsService,
    RightsComplaintsService,
    TakedownsService,
    AppealsService,
    VerificationsService,
    VerificationResolver,
  ],
  exports: [
    ReportsService,
    RightsComplaintsService,
    TakedownsService,
    AppealsService,
    VerificationsService,
  ],
})
export class TrustModule {}
