import { Module } from '@nestjs/common';
import { TaxSettingsResolver } from './graphql/tax.resolver.js';
import { TaxSettingsService } from './tax-settings.service.js';

/** Needs a {@link Database} provider from the host application. */
@Module({
  providers: [TaxSettingsService, TaxSettingsResolver],
  exports: [TaxSettingsService],
})
export class TaxModule {}
