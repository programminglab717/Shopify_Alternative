/** Events the files module publishes. Payloads are thin: fetch current state through the API. */
export const FileEvents = {
  FileCreated: 'file.created',
  FileDeleted: 'file.deleted',
  ShopBrandUpdated: 'shop_brand.updated',
  StoreExportRequested: 'store_export.requested',
  StoreExportReady: 'store_export.ready',
  StoreExportFailed: 'store_export.failed',
} as const;

export interface FileCreatedPayload {
  contentType: string;
  /** Bytes. */
  size: number;
}

export type FileDeletedPayload = Record<string, never>;

export interface ShopBrandUpdatePayload {
  /** What changed: "logo", "squareLogo". */
  changed: string[];
}

/** A whole store's export (ADR-415): asked for, ready with its ZIP's bytes, or failed and why. */
export interface StoreExportPayload {
  size?: number;
  error?: string;
}
