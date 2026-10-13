import { Module } from '@nestjs/common';
import { CustomAppService } from './custom-apps.service.js';
import { CustomAppResolver } from './graphql/apps.resolver.js';

/** Needs {@link Database} and {@link SecretBox} providers from the host application. */
@Module({
  providers: [CustomAppService, CustomAppResolver],
  exports: [CustomAppService],
})
export class AppsModule {}
