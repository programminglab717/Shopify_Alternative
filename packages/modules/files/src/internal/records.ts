import type { FileTypeValue } from './file-types.js';

/** A file a shop uploaded, once it is in and checked. */
export interface FileRecord {
  id: string;
  /** As the shop named it: "Lawn collection.jpg". */
  filename: string;
  contentType: FileTypeValue;
  /** Bytes. */
  size: number;
  /** What it shows, for those who can't see it. */
  alt: string;
  /** Where storage keeps it. */
  key: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Where an upload goes: the request that sends it, and what names it once it is there. */
export interface StagedUpload {
  url: string;
  method: 'PUT';
  /** To send with it, as given. */
  headers: Record<string, string>;
  /** What `fileCreate` takes, once the upload is in. */
  resourceUrl: string;
}

export interface Page<T> {
  items: T[];
  hasNextPage: boolean;
}
