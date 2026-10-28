/** A shop's request waiting for Hatti's people (ADR-508), as the console's server lists it. */
export interface SupportRequest {
  id: string;
  shop: { id: string; name: string; plan: string };
  channel: 'admin' | 'whatsapp';
  topic: string;
  language: 'en' | 'ur';
  priority: number;
  message: string;
  callBack: string | null;
  createdAt: string;
  dueAt: string;
  late: boolean;
  lastInbound: { text: string; at: string } | null;
}

export interface AnsweredSupportRequest {
  request: SupportRequest;
  whatsapp: 'sent' | 'window_closed' | 'unavailable' | 'failed' | 'none';
  whatsappError?: string;
}

/** Something done in the console, as its log keeps it. */
export interface ConsoleAction {
  id: string;
  email: string;
  action: string;
  subject: string | null;
  details: Record<string, unknown>;
  at: string;
}

export interface ShopRef {
  id: string;
  name: string;
  handle: string;
}

/** A shopper's report of a store (ADR-460). */
export interface StoreReport {
  id: string;
  shop: ShopRef;
  openOfShop: number;
  reason: string;
  details: string;
  phone: string | null;
  orderName: string | null;
  pageUrl: string | null;
  language: 'en' | 'ur';
  status: 'open' | 'dismissed' | 'upheld';
  overdue: boolean;
  dueAt: string;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decision: string | null;
}

/** A store taken down (ADR-461). */
export interface Takedown {
  shop: ShopRef;
  reason: string;
  note: string;
  takenBy: string;
  createdAt: string;
  restoredAt: string | null;
  restoredBy: string | null;
  restoreNote: string | null;
}

/** A store owner's appeal of its takedown (ADR-462). */
export interface StoreAppeal {
  id: string;
  shop: ShopRef;
  reason: string;
  takedownNote: string;
  words: string;
  status: 'open' | 'refused' | 'upheld';
  createdAt: string;
  answeredAt: string | null;
  answeredBy: string | null;
  answer: string | null;
}

/** A shop's request to be verified (ADR-465). */
export interface Verification {
  id: string;
  shop: ShopRef;
  level: 'identity' | 'business';
  name: string;
  cnic: string | null;
  cnicLast4: string | null;
  ntn: string | null;
  status: 'waiting' | 'approved' | 'refused' | 'revoked';
  documents: number;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  answer: string | null;
}
