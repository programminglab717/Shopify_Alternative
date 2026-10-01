// The logistics module's public surface. Everything under src/internal is private to this module.
export { LogisticsEvents, type CodRemittanceImportedPayload } from '../internal/events.js';
export { LogisticsModule } from '../internal/logistics.module.js';
export type { CodRemittanceLineRecord, CodRemittanceRecord } from '../internal/records.js';
export {
  CodRemittanceService,
  type RemittanceImport,
  type RemittanceImportInput,
} from '../internal/remittance.service.js';
export { REMITTANCE_OUTCOMES, type RemittanceOutcomeValue } from '../internal/schema.js';
export { STATEMENT_LIMITS, amountOf, headingKey } from '../internal/statement.js';
