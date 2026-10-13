// The apps module's public surface. Everything under src/internal is private to this module.
export {
  APP_LIMITS,
  WEBHOOK_SECRET_PREFIX,
  generateWebhookSecret,
  type GeneratedSecret,
} from '../internal/apps.js';
export { AppsModule } from '../internal/apps.module.js';
export {
  CustomAppService,
  type CustomAppCreated,
  type CustomAppInput,
  type CustomAppRecord,
} from '../internal/custom-apps.service.js';
export { AppEvents, type AppChangedPayload } from '../internal/events.js';
export { CustomApp } from '../internal/graphql/apps.types.js';
