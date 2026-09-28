import type { ProductStatusValue } from './schema.js';

/**
 * Events the catalog publishes. Payloads are thin: fetch current state through the API.
 *
 * A change to a product's options, variants or media is a `product.updated` with those names in
 * `changed`. Smart collection membership follows product changes, so it has no events of its own:
 * react to `product.*` as well as `collection.*`.
 */
export const CatalogEvents = {
  ProductCreated: 'product.created',
  ProductUpdated: 'product.updated',
  ProductDeleted: 'product.deleted',
  CollectionCreated: 'collection.created',
  CollectionUpdated: 'collection.updated',
  CollectionDeleted: 'collection.deleted',
} as const;

export interface ProductCreatedPayload {
  handle: string;
  status: ProductStatusValue;
  variantCount: number;
}

export interface ProductUpdatedPayload {
  /** Names of what changed: fields, or "options", "variants", "media". */
  changed: string[];
  version: number;
}

export interface ProductDeletedPayload {
  handle: string;
}

export interface CollectionCreatedPayload {
  handle: string;
  /** Whether rules decide the products. */
  smart: boolean;
}

export interface CollectionUpdatedPayload {
  /** Names of what changed: fields, or "rules", "products". */
  changed: string[];
  version: number;
}

export interface CollectionDeletedPayload {
  handle: string;
}
