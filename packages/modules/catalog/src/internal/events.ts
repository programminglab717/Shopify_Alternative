import type { ProductStatusValue } from './schema.js';

/** Events the catalog publishes. Payloads are thin: fetch current state through the API. */
export const CatalogEvents = {
  ProductCreated: 'product.created',
  ProductUpdated: 'product.updated',
} as const;

export interface ProductCreatedPayload {
  handle: string;
  status: ProductStatusValue;
  variantCount: number;
}

export interface ProductUpdatedPayload {
  /** Names of the fields that changed. */
  changed: string[];
  version: number;
}
