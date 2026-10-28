/**
 * Public IDs are what API clients see: a type prefix plus the 128-bit UUID encoded
 * in Crockford base32 (26 characters, lowercase), e.g. `prod_01j9zk3m8q5v7w2x4y6z8a0b1c`.
 *
 * - Self-describing: the prefix says what kind of object an ID refers to.
 * - Copy/paste safe: no ambiguous characters (i, l, o, u are excluded).
 * - Order preserving: fixed-length, big-endian encoding keeps UUIDv7 time order.
 */

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const BODY_LENGTH = 26;
const MAX_UUID = (1n << 128n) - 1n;

const DECODE_TABLE: ReadonlyMap<string, number> = (() => {
  const table = new Map<string, number>();
  for (let i = 0; i < ALPHABET.length; i++) {
    table.set(ALPHABET.charAt(i), i);
  }
  // Crockford aliases for characters people commonly mistype.
  table.set('i', 1);
  table.set('l', 1);
  table.set('o', 0);
  return table;
})();

export const ID_PREFIXES = {
  shop: 'shop',
  product: 'prod',
  productReview: 'rvw',
  sizeChart: 'szc',
  priceSale: 'sale',
  productOption: 'opt',
  productOptionValue: 'optv',
  media: 'med',
  file: 'file',
  variant: 'var',
  collection: 'col',
  theme: 'thm',
  menu: 'mnu',
  menuItem: 'mni',
  page: 'pg',
  blog: 'blog',
  article: 'art',
  comment: 'cmt',
  domain: 'dom',
  urlRedirect: 'rdr',
  shopPolicy: 'pol',
  shopPolicyVersion: 'plv',
  discountCode: 'dsc',
  automaticDiscount: 'dsa',
  location: 'loc',
  inventoryItem: 'invi',
  inventoryLevel: 'invl',
  inventoryAdjustment: 'adj',
  supplier: 'sup',
  purchaseOrder: 'po',
  purchaseOrderLine: 'poli',
  inventoryTransfer: 'invt',
  inventoryTransferLine: 'invtl',
  customer: 'cus',
  blocklistEntry: 'blk',
  segment: 'seg',
  consentEvent: 'cev',
  storeCreditAccount: 'sca',
  storeCreditTransaction: 'sct',
  giftCard: 'gc',
  giftCardTransaction: 'gct',
  order: 'ord',
  draftOrder: 'dft',
  savedSearch: 'svs',
  exportSchedule: 'exs',
  storeExport: 'sxp',
  verification: 'vrf',
  smsSender: 'snd',
  lineItem: 'li',
  orderEvent: 'oev',
  orderComment: 'ocm',
  fulfillment: 'ful',
  fulfillmentEvent: 'fev',
  payment: 'pay',
  refund: 'rfd',
  transferReceipt: 'rcpt',
  shipment: 'shp',
  courierAccount: 'cra',
  courierBooking: 'bkg',
  courierPickup: 'pkp',
  courierRule: 'crl',
  codRemittance: 'rmt',
  paymentGatewayAccount: 'pga',
  paymentSession: 'psn',
  paymentRefund: 'prf',
  paymentLink: 'plnk',
  abandonedCheckout: 'ack',
  billingInvoice: 'binv',
  billingWalletEntry: 'bwe',
  billingTransfer: 'btr',
  return: 'ret',
  returnRequest: 'retq',
  conversionEvent: 'cnv',
  message: 'msg',
  whatsAppTemplate: 'wtm',
  broadcast: 'bdc',
  accessToken: 'tok',
  webhookSubscription: 'whs',
  webhookDelivery: 'whd',
  event: 'evt',
  auditEntry: 'aud',
  user: 'usr',
  session: 'ses',
  passkey: 'psk',
  staffInvitation: 'sti',
  supportGrant: 'sgr',
  storeReport: 'rpt',
  storeAppeal: 'apl',
  rightsComplaint: 'ipc',
  accessRequest: 'acr',
  customRole: 'role',
  metafield: 'mtf',
  metafieldDefinition: 'mfd',
  paymentSettlement: 'pst',
  incident: 'inc',
  supportRequest: 'sreq',
  conversation: 'chat',
  conversationMessage: 'cmsg',
  fiscalInvoice: 'fbr',
  supportRequestMessage: 'smsg',
  // An address in a shopper's book, kept with their account (ADR-583).
  accountAddress: 'addr',
  // A message through the online store's contact form (ADR-589).
  contactMessage: 'cform',
  // What a storefront's search shows first, or leaves out, for a term (ADR-692).
  searchRule: 'srch',
  // What a shop's staff answer customers with in a tap (ADR-758).
  savedReply: 'srep',
  // Who sends a shop customers by a link or code of their own, and what they were paid (ADR-776).
  affiliate: 'afl',
  affiliatePayout: 'aflp',
  // A shop's wholesale prices for the customers with a tag (ADR-778).
  priceList: 'plst',
  // An order from the store a shop moved from, kept to look back on (ADR-786).
  pastOrder: 'pord',
  // Products shown as one listing, each a value of its option, as colours are (ADR-799).
  combinedListing: 'cmbl',
  // A file a digital product sells, and one of its licence keys (ADR-813).
  digitalFile: 'dfile',
  licenceKey: 'lkey',
  // A report a shop saves of its own (ADR-817).
  customReport: 'crep',
  // A drop of products on sale together at a time (ADR-820).
  drop: 'drop',
  // A shop's own rider, and an order handed to one (ADR-824).
  rider: 'ridr',
  riderDelivery: 'rdel',
  riderHandover: 'rhnd',
  // A push campaign a shop sends to shoppers' browsers (ADR-834).
  pushCampaign: 'pcmp',
  // A bulk operation's run of a list to a file (ADR-843).
  bulkOperation: 'bulk',
  // A token the Storefront API answers headless storefronts by (ADR-848).
  storefrontAccessToken: 'sfat',
  // An app a partner registered for shops to install (ADR-851).
  partnerApp: 'papp',
  // A script an app offers the shop's storefront, which the shop turns on (ADR-852).
  appEmbed: 'aemb',
  // An installed app's one-time charge of the shop (ADR-854).
  appCharge: 'achg',
  // A partner offering shops their services, by their account (ADR-855).
  expert: 'expt',
  // A theme of the theme store, offered by a designer (ADR-853).
  themeListing: 'thls',
  // A shop's workflow: a trigger, conditions and actions (ADR-861).
  workflow: 'wkfl',
  // One run of a workflow, for one event (ADR-861).
  workflowRun: 'wrun',
  // A trigger or an action an app offers the shop's workflows (ADR-861).
  flowExtension: 'fext',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

const KIND_BY_PREFIX: ReadonlyMap<string, IdKind> = new Map(
  (Object.entries(ID_PREFIXES) as [IdKind, string][]).map(([kind, prefix]) => [prefix, kind]),
);

export class PublicIdError extends Error {
  override readonly name = 'PublicIdError';
}

export function toPublicId(kind: IdKind, uuid: string): string {
  const hex = uuid.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new PublicIdError(`Not a UUID: ${uuid}`);
  }
  let value = BigInt(`0x${hex}`);
  let body = '';
  for (let i = 0; i < BODY_LENGTH; i++) {
    body = ALPHABET.charAt(Number(value & 31n)) + body;
    value >>= 5n;
  }
  return `${ID_PREFIXES[kind]}_${body}`;
}

export interface ParsedPublicId {
  kind: IdKind;
  uuid: string;
}

export function parsePublicId(publicId: string): ParsedPublicId {
  const separator = publicId.indexOf('_');
  if (separator <= 0) {
    throw new PublicIdError('Malformed ID: missing type prefix');
  }
  const prefix = publicId.slice(0, separator);
  const kind = KIND_BY_PREFIX.get(prefix);
  if (!kind) {
    throw new PublicIdError(`Unknown ID prefix: ${prefix}`);
  }
  const body = publicId.slice(separator + 1).toLowerCase();
  if (body.length !== BODY_LENGTH) {
    throw new PublicIdError('Malformed ID: wrong length');
  }
  let value = 0n;
  for (const char of body) {
    const digit = DECODE_TABLE.get(char);
    if (digit === undefined) {
      throw new PublicIdError(`Malformed ID: invalid character "${char}"`);
    }
    value = (value << 5n) | BigInt(digit);
  }
  if (value > MAX_UUID) {
    throw new PublicIdError('Malformed ID: value out of range');
  }
  const hex = value.toString(16).padStart(32, '0');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { kind, uuid };
}

/** Decodes a public ID and checks it refers to the expected kind of object. */
export function fromPublicId(publicId: string, expected: IdKind): string {
  const { kind, uuid } = parsePublicId(publicId);
  if (kind !== expected) {
    throw new PublicIdError(`Expected a ${expected} ID but received a ${kind} ID`);
  }
  return uuid;
}

/** Like fromPublicId, but returns null instead of throwing for malformed input. */
export function tryFromPublicId(publicId: string, expected: IdKind): string | null {
  try {
    return fromPublicId(publicId, expected);
  } catch (error) {
    if (error instanceof PublicIdError) return null;
    throw error;
  }
}
