import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';
import { TakedownsService } from './takedowns.service.js';

/**
 * Trust and safety (TNS-01): shoppers' reports of stores, sent on by storefronts and decided by
 * Hatti's people, and stores taken down. Needs a {@link Database} provider from the host application.
 */
@Module({
  controllers: [ReportsController],
  providers: [ReportsService, TakedownsService],
  exports: [ReportsService, TakedownsService],
})
export class TrustModule {}
