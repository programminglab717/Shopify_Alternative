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
export {
  APPEAL_LIMITS,
  APPEAL_LINK_PATH,
  AppealsService,
  appealToken,
  type AppealEntry,
  type AppealProblem,
  type AppealRecord,
  type AppealResult,
  type AppealStatus,
  type AppealView,
} from '../internal/appeals.service.js';
export {
  VERIFICATION_DOCUMENT_TYPES,
  VERIFICATION_LIMITS,
  VERIFICATION_URL_SECONDS,
  VerificationsService,
  cnicDigits,
  ntnOf,
  verifiedLevelIn,
  type ShopVerificationRecord,
  type VerificationChangedPayload,
  type VerificationDecisionProblem,
  type VerificationDocument,
  type VerificationInput,
  type VerificationLevel,
  type VerificationRecord,
  type VerificationReview,
  type VerificationStatus,
} from '../internal/verifications.service.js';
export {
  RIGHTS_ACTING_AS,
  RIGHTS_KINDS,
  RIGHTS_LIMITS,
  RIGHTS_LINK_PATH,
  RIGHTS_STATUSES,
  RightsComplaintsService,
  rightsLinkToken,
  type RightsActingAs,
  type RightsAnswered,
  type RightsComplaintInput,
  type RightsComplaintRecord,
  type RightsCounterProblem,
  type RightsCounterResult,
  type RightsCounterStatus,
  type RightsDecided,
  type RightsView,
  type RightsKind,
  type RightsListing,
  type RightsStatus,
} from '../internal/rights.service.js';
// Signs of a scam store, for Hatti's people (TNS-02, ADR-842).
export {
  SIGNAL_KINDS,
  SIGNAL_LIMITS,
  SIGNAL_RULES,
  StoreSignalsService,
  nameKey,
  withinEdits,
  type SignalKind,
  type StoreSignalRecord,
} from '../internal/signals.service.js';
export { appealPage } from '../internal/appeal-page.js';
export { AppealController } from '../internal/appeal.controller.js';
export { ReportsController } from '../internal/reports.controller.js';
export { RightsComplaintsController } from '../internal/rights.controller.js';
export { RightsLinkController } from '../internal/rights-link.controller.js';
export { rightsPage } from '../internal/rights-page.js';
export { TrustModule } from '../internal/trust.module.js';
export {
  INCIDENT_IMPACTS,
  INCIDENT_KINDS,
  INCIDENT_LIMITS,
  INCIDENT_STATUSES,
  IncidentsService,
  STATUS_COMPONENTS,
  historyOf,
  type ComponentDay,
  type ComponentHistory,
  type ComponentState,
  type IncidentImpact,
  type IncidentInput,
  type IncidentKind,
  type IncidentRecord,
  type IncidentResult,
  type IncidentStatus,
  type IncidentUpdateInput,
  type StatusComponent,
  type StatusSnapshot,
} from '../internal/incidents.service.js';
export {
  STATUS_SUBSCRIPTION_LIMITS,
  STATUS_SUBSCRIPTION_PATH,
  StatusSubscriptionsService,
  subscriberEmail,
  type StatusRecipient,
  type StatusSubscriptionView,
  type StatusShopNotice,
  type StatusUpdateToMail,
} from '../internal/status-subscriptions.service.js';
export { COMPONENT_WORDS, STATUS_WORDS } from '../internal/status-page.js';
