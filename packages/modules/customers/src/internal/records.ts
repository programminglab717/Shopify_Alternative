import type {
  BlockReasonValue,
  BlockerKind,
  ConsentActorKind,
  ConsentSourceValue,
  MarketingChannelValue,
  MarketingStateValue,
} from './schema.js';

/** Whether a customer agreed to marketing on a channel. */
export interface MarketingConsentRecord {
  state: MarketingStateValue;
  /** When the customer gave or withdrew it; null if they never have. */
  consentedAt: Date | null;
}

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
  /** Marketing consent per channel. */
  consent: Record<MarketingChannelValue, MarketingConsentRecord>;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A change of a customer's marketing consent, as the consent ledger keeps it. */
export interface ConsentEventRecord {
  id: string;
  customerId: string;
  channel: MarketingChannelValue;
  state: MarketingStateValue;
  source: ConsentSourceValue;
  /** What the customer agreed to. Always there for a subscription. */
  wording: string | null;
  /** The number (E.164) or email address it was for. */
  contact: string;
  actorKind: ConsentActorKind;
  actorId: string | null;
  /** When the customer said so. */
  collectedAt: Date;
  /** When it was recorded. */
  createdAt: Date;
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

/** A saved customer filter. Its members are found when asked for. */
export interface SegmentRecord {
  id: string;
  name: string;
  /** In the segment query language. */
  query: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Page<T> {
  items: T[];
  hasNextPage: boolean;
}
