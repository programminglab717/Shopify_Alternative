/** Events the files module publishes. Payloads are thin: fetch current state through the API. */
export const FileEvents = {
  FileCreated: 'file.created',
  FileDeleted: 'file.deleted',
  ShopBrandUpdated: 'shop_brand.updated',
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
