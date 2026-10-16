// Reports of a store (TNS-01, ADR-460): a shopper who thinks a store is not dealing honestly
// reports it from the link in its footer, which the storefront sends on to the core, for Hatti's
// people to decide on.

import { STOREFRONT_API_PREFIX } from './cart.js';

/**
 * POST a {@link ReportRequest}: a shopper's report, answered with a {@link ReportResponse}; 422,
 * with a {@link ReportErrorResponse}, says what was wrong with it.
 */
export function reportsPath(shopId: string): string {
  return `${STOREFRONT_API_PREFIX}shops/${shopId}/reports`;
}

/** What is wrong with a store, as a report says it. */
export const REPORT_REASON_VALUES = [
  'never_delivered',
  'not_as_described',
  'counterfeit',
  'prohibited',
  'scam',
  'impersonation',
  'other',
] as const;

export interface ReportRequest {
  /** One of {@link REPORT_REASON_VALUES}. */
  reason: string;
  /** What happened, in the shopper's words. */
  details: string;
  /** A mobile number to reach them on, if they gave one. */
  phone?: string;
  /** Their order's number, if it is about one. */
  orderName?: string;
  /** The store's page they came from. */
  pageUrl?: string;
  /** Their address, which the core keeps only as a hash with the shop's. */
  client?: string;
  language: 'en' | 'ur';
}

export interface ReportResponse {
  /** The report's number, rpt_…, to quote to Hatti. */
  id: string;
}

/** What was wrong with a report, by field: "reason", "details", "phone", "orderName", "base". */
export interface ReportErrorResponse {
  errors: { field: string; message: string }[];
}
