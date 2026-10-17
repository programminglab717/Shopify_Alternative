import { Module } from '@nestjs/common';
import { FbrPosService, FiscalInvoicesService } from './fbr-pos.service.js';
import { FbrPosResolver } from './graphql/fbr.resolver.js';
import { TaxSettingsResolver } from './graphql/tax.resolver.js';
import { TaxSettingsService } from './tax-settings.service.js';

/** Needs {@link Database} and {@link SecretBox} providers from the host application. */
@Module({
  providers: [
    TaxSettingsService,
    TaxSettingsResolver,
    FbrPosService,
    FiscalInvoicesService,
    FbrPosResolver,
  ],
  exports: [TaxSettingsService, FbrPosService, FiscalInvoicesService],
})
export class TaxModule {}
