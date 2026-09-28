import type { BlockReasonValue, BlockerKind } from './schema.js';

/**
 * A customer: whoever a mobile number belongs to, in one shop. What they have ordered is the
 * orders module's to tell.
 */
export interface CustomerRecord {
  id: string;
  /** Mobile number in E.164 form. */
  phone: string;
  name: string | null;
  email: string | null;
  note: string;
  tags: string[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A number on the blocklist: orders from it are held for staff to review. */
export interface BlocklistEntryRecord {
  id: string;
  /** Mobile number in E.164 form. */
  phone: string;
  reason: BlockReasonValue;
  note: string;
  /** Who blocked it, or last changed why: an access token or a staff member. */
  actorKind: BlockerKind;
  actorId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Page<T> {
  items: T[];
  hasNextPage: boolean;
}
