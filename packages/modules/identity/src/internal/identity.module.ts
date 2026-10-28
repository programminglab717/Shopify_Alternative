import { Module, type DynamicModule } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { EmailFeedbackController } from './email-feedback.controller.js';
import { EmailFeedbackService } from './email-feedback.js';
import { IdentityService, type IdentityServiceOptions } from './identity.service.js';
import { PartnerAppsService } from './partner-apps.service.js';
import { PartnerThemesService } from './partner-themes.service.js';
import { CertificationService } from './certification.service.js';
import { ExpertsService } from './experts.service.js';
import { PartnersService } from './partners.service.js';
import { ShopSsoService } from './sso.js';
import { StaffService } from './staff.service.js';
import { SupportAccessService } from './support-access.service.js';

/**
 * Serves /auth/*, and SES's bounces and complaints at /webhooks/ses. The host application supplies
 * the identity database and secrets.
 */
@Module({})
export class IdentityModule {
  static forRoot(options: IdentityServiceOptions): DynamicModule {
    return {
      module: IdentityModule,
      controllers: [AuthController, EmailFeedbackController],
      providers: [
        { provide: IdentityService, useValue: new IdentityService(options) },
        {
          provide: EmailFeedbackService,
          useValue: new EmailFeedbackService({
            db: options.db,
            feedback: options.emails?.feedback ?? null,
            ...(options.now ? { now: options.now } : {}),
          }),
        },
        { provide: StaffService, useValue: new StaffService(options) },
        { provide: PartnersService, useValue: new PartnersService(options) },
        { provide: PartnerAppsService, useValue: new PartnerAppsService(options) },
        { provide: PartnerThemesService, useValue: new PartnerThemesService(options) },
        { provide: ExpertsService, useValue: new ExpertsService(options) },
        { provide: CertificationService, useValue: new CertificationService(options) },
        { provide: SupportAccessService, useValue: new SupportAccessService(options) },
        { provide: ShopSsoService, useValue: new ShopSsoService(options) },
      ],
      exports: [
        IdentityService,
        StaffService,
        SupportAccessService,
        PartnersService,
        PartnerAppsService,
        PartnerThemesService,
        ExpertsService,
        CertificationService,
        ShopSsoService,
      ],
    };
  }
}
