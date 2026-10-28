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

/** A rights owner's complaint of a store's listings (ADR-474), and the owner's answer (ADR-476). */
export interface RightsComplaint {
  id: string;
  shop: ShopRef;
  kind: string;
  rightsOwner: string;
  registration: string | null;
  complainant: string;
  actingAs: string;
  email: string;
  phone: string | null;
  listings: { id: string; title: string; url: string }[];
  details: string;
  signature: string;
  language: 'en' | 'ur';
  status: 'open' | 'dismissed' | 'upheld';
  overdue: boolean;
  dueAt: string;
  createdAt: string;
  decidedBy: string | null;
  decision: string | null;
  counter: {
    words: string | null;
    signature: string | null;
    at: string;
    status: 'open' | 'refused' | 'upheld' | null;
    answer: string | null;
    answeredBy: string | null;
  } | null;
  releasedAt: string | null;
  releasedBy: string | null;
  releaseNote: string | null;
}

/** A sign of a scam store, found by the worker (ADR-842). */
export interface StoreSignal {
  shop: ShopRef;
  kind: 'prepaid_unshipped' | 'cloned_catalogue' | 'impersonation';
  detail: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
  clearedAt: string | null;
  clearedBy: string | null;
  note: string | null;
}

/** A shop's own SMS sender name (ADR-469). */
export interface SmsSender {
  id: string;
  shop: ShopRef;
  name: string;
  status: 'waiting' | 'approved' | 'refused' | 'revoked';
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  answer: string | null;
}

/** A transfer a shop's owner said they made into Hatti's account (ADR-254). */
export interface BillingTransfer {
  id: string;
  shop: { id: string; name: string };
  invoiceName: string;
  reference: string;
  /** As Hatti writes rupees: "Rs 2,999". */
  amount: string;
  reportedAt: string;
}

/** An incident or maintenance on Hatti's status page (ADR-498). */
export interface Incident {
  id: string;
  kind: 'incident' | 'maintenance';
  impact: 'degraded' | 'outage';
  components: string[];
  title: string;
  titleUr: string | null;
  status: string;
  startsAt: string;
  endsAt: string | null;
  resolvedAt: string | null;
  createdBy: string;
  updates: {
    status: string;
    body: string;
    bodyUr: string | null;
    postedBy: string;
    postedAt: string;
  }[];
}

/** A partner's public app (ADR-851). */
export interface PartnerApp {
  clientId: string;
  name: string;
  partner: string;
  appUrl: string;
  redirectUrls: string[];
  scopes: string[];
  listed: boolean;
  createdAt: string;
}

/** A designer's theme for the theme store (ADR-853). */
export interface PartnerTheme {
  id: string;
  name: string;
  description: string;
  designer: string;
  base: string;
  /** "Rs 5,000", or null for a free theme. */
  price: string | null;
  listed: boolean;
  preview: { shopId: string; themeId: string };
  updatedAt: string;
}

/** A partner's expert profile (ADR-855). */
export interface ExpertProfile {
  id: string;
  businessName: string;
  website: string | null;
  headline: string;
  about: string;
  services: string[];
  cities: string[];
  languages: string[];
  startingPrice: string | null;
  certified: boolean;
  listed: boolean;
  updatedAt: string;
}

/** A partner owed their share (ADR-505). */
export interface PartnerOwed {
  id: string;
  businessName: string;
  email: string;
  payout: { title: string; iban: string } | null;
  owed: string;
  entries: number;
}

/** A shop as the console finds it (ADR-881). */
export interface ShopFound {
  id: string;
  name: string;
  handle: string;
  status: 'active' | 'suspended' | 'closed';
  development: boolean;
  plan: string;
  createdAt: string;
}

/** A shop's standing at a glance. */
export interface ShopStanding {
  shop: ShopFound;
  owner: { name: string; email: string | null; phone: string | null } | null;
  verified: string[];
  openReports: number;
  openSupportRequests: number;
  standingSignals: number;
  downSince: string | null;
  supportAccess: { until: string; note: string | null } | null;
  actions: { email: string; action: string; subject: string | null; at: string }[];
}

/** Couriers' names for cities (ADR-260). */
export interface CourierCities {
  shops: {
    cityKey: string;
    city: string;
    names: { courierCity: string; shops: number }[];
    shared: string | null;
  }[];
  hatti: { city: string; courierCity: string }[];
}

/** A shop whose owner lets support look now (ADR-156, ADR-882). */
export interface SupportAccess {
  shop: { id: string; name: string; handle: string };
  note: string | null;
  grantedBy: string;
  since: string;
  until: string;
  /** Where to look at it in the admin; null where the admin's address isn't set. */
  adminUrl: string | null;
}

/** A credit of Hatti's bank statement (ADR-883). */
export interface StatementCredit {
  row: number;
  date: string | null;
  description: string;
  amount: string;
  /** What came, as confirming takes it: "2999.00". */
  received: string;
}

/** Hatti's bank statement, matched against the transfers waiting. */
export interface StatementMatched {
  credits: number;
  matches: {
    transfer: BillingTransfer;
    credit: StatementCredit;
    outcome: 'exact' | 'short' | 'over';
  }[];
  ambiguous: BillingTransfer[];
  unmatched: StatementCredit[];
  moreUnmatched: number;
}
