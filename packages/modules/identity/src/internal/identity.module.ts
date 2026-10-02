import { Module, type DynamicModule } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { IdentityService, type IdentityServiceOptions } from './identity.service.js';
import { StaffService } from './staff.service.js';
import { SupportAccessService } from './support-access.service.js';

/** Serves /auth/*. The host application supplies the identity database and secrets. */
@Module({})
export class IdentityModule {
  static forRoot(options: IdentityServiceOptions): DynamicModule {
    return {
      module: IdentityModule,
      controllers: [AuthController],
      providers: [
        { provide: IdentityService, useValue: new IdentityService(options) },
        { provide: StaffService, useValue: new StaffService(options) },
        { provide: SupportAccessService, useValue: new SupportAccessService(options) },
      ],
      exports: [IdentityService, StaffService, SupportAccessService],
    };
  }
}
