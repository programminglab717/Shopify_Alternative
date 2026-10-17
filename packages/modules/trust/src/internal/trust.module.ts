import { Module } from '@nestjs/common';
import { AppealController } from './appeal.controller.js';
import { AppealsService } from './appeals.service.js';
import { IncidentsService } from './incidents.service.js';
import { StatusResolver } from './graphql/status.resolver.js';
import { StatusController } from './status.controller.js';
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
 * verified by Hatti (ONB-11); Hatti's status page, its incidents posted by Hatti's people
 * (BIL-06). Needs {@link Database} and {@link ObjectStorage} providers from the host
 * application.
 */
@Module({
  controllers: [
    ReportsController,
    RightsComplaintsController,
    AppealController,
    RightsLinkController,
    StatusController,
  ],
  providers: [
    ReportsService,
    RightsComplaintsService,
    TakedownsService,
    AppealsService,
    VerificationsService,
    VerificationResolver,
    IncidentsService,
    StatusResolver,
  ],
  exports: [
    ReportsService,
    RightsComplaintsService,
    TakedownsService,
    AppealsService,
    VerificationsService,
    IncidentsService,
  ],
})
export class TrustModule {}
