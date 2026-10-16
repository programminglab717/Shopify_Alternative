// The trust module's public surface. Everything under src/internal is private to this module.
export {
  REPORT_LIMITS,
  REPORT_REASONS,
  REPORT_STATUSES,
  ReportsService,
  type ReportDecided,
  type ReportInput,
  type ReportReason,
  type ReportRecord,
  type ReportStatus,
} from '../internal/reports.service.js';
export {
  TAKEDOWN_LIMITS,
  TakedownsService,
  TrustEvents,
  type TakedownPayload,
  type TakedownRecord,
  type TakedownResult,
  type TakedownShop,
} from '../internal/takedowns.service.js';
export { ReportsController } from '../internal/reports.controller.js';
export { TrustModule } from '../internal/trust.module.js';
