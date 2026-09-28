import {
  PageInfo,
  badUserInput,
  decodeCursor,
  encodeCursor,
  phoneAccess,
  shownPhone,
  type TenantContext,
} from '@hatti/api';
import { isUuid, toPublicId, tryFromPublicId, type IdKind } from '@hatti/ids';
import { maskPkMobile } from '@hatti/pk';
import type {
  BlocklistEntryRecord,
  ConsentEventRecord,
  CustomerRecord,
  MarketingConsentRecord,
} from '../records.js';
import { displayPhone } from '../rules.js';
import type { BlockReasonValue, ConsentSourceValue, MarketingStateValue } from '../schema.js';
import {
  BlocklistEntry,
  BlocklistEntryConnection,
  BlocklistEntryEdge,
  BlocklistReason,
  ConsentEvent,
  ConsentEventConnection,
  ConsentEventEdge,
  ConsentSource,
  Customer,
  CustomerConnection,
  CustomerEdge,
  CustomerMarketingConsent,
  MarketingChannel,
  MarketingState,
} from './customer.types.js';

/** The UUID behind a public ID of the given kind, or a BAD_USER_INPUT error. */
export function uuidOf(kind: IdKind, id: string): string {
  const uuid = tryFromPublicId(id, kind);
  if (!uuid) throw badUserInput(`Invalid ${kind} id: ${id.slice(0, 64)}`);
  return uuid;
}

/** The UUID a page cursor carries, or a BAD_USER_INPUT error. */
export function cursorAfter(after: string | null | undefined): string | null {
  if (!after) return null;
  const { id } = decodeCursor(after, ['id']);
  if (!isUuid(id)) throw badUserInput('Invalid cursor');
  return id;
}

export function toBlockReasonValue(reason: BlocklistReason): BlockReasonValue {
  return reason.toLowerCase() as BlockReasonValue;
}

export function toMarketingStateValue(state: MarketingState): MarketingStateValue {
  return state.toLowerCase() as MarketingStateValue;
}

export function toConsentSourceValue(source: ConsentSource): ConsentSourceValue {
  return source.toLowerCase() as ConsentSourceValue;
}

function toConsent(record: MarketingConsentRecord): CustomerMarketingConsent {
  return Object.assign(new CustomerMarketingConsent(), {
    marketingState: record.state.toUpperCase() as MarketingState,
    consentUpdatedAt: record.consentedAt,
  });
}

/**
 * A customer's number as the caller may see it, for reading: "0300 1234567", or masked for staff
 * who see numbers masked.
 */
function readablePhone(tenant: TenantContext, e164: string): string {
  return phoneAccess(tenant) === 'full' ? displayPhone(e164) : maskPkMobile(e164);
}

/** Numbers are masked for staff whose role sees them so (see {@link phoneAccess}). */
export function toCustomer(record: CustomerRecord, tenant: TenantContext): Customer {
  return Object.assign(new Customer(), {
    id: toPublicId('customer', record.id),
    phone: shownPhone(tenant, record.phone),
    name: record.name,
    displayName: record.name ?? readablePhone(tenant, record.phone),
    email: record.email,
    note: record.note,
    tags: record.tags,
    whatsappMarketingConsent: toConsent(record.consent.whatsapp),
    smsMarketingConsent: toConsent(record.consent.sms),
    emailMarketingConsent: toConsent(record.consent.email),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    uuid: record.id,
  });
}

export function toConsentEventConnection(
  records: ConsentEventRecord[],
  hasNextPage: boolean,
  tenant: TenantContext,
): ConsentEventConnection {
  const nodes = records.map((record) =>
    Object.assign(new ConsentEvent(), {
      id: toPublicId('consentEvent', record.id),
      channel: record.channel.toUpperCase() as MarketingChannel,
      marketingState: record.state.toUpperCase() as MarketingState,
      source: record.source.toUpperCase() as ConsentSource,
      wording: record.wording,
      contact: record.contact.startsWith('+') ? shownPhone(tenant, record.contact) : record.contact,
      collectedAt: record.collectedAt,
      recordedAt: record.createdAt,
    }),
  );
  const edges = nodes.map((node, index) =>
    Object.assign(new ConsentEventEdge(), {
      node,
      cursor: encodeCursor({ id: records[index]!.id }),
    }),
  );
  return Object.assign(new ConsentEventConnection(), {
    edges,
    nodes,
    pageInfo: pageInfo(edges, hasNextPage),
  });
}

export function toBlocklistEntry(
  record: BlocklistEntryRecord,
  tenant: TenantContext,
): BlocklistEntry {
  return Object.assign(new BlocklistEntry(), {
    id: toPublicId('blocklistEntry', record.id),
    phone: shownPhone(tenant, record.phone),
    reason: record.reason.toUpperCase() as BlocklistReason,
    note: record.note,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function pageInfo(edges: { cursor: string }[], hasNextPage: boolean): PageInfo {
  return Object.assign(new PageInfo(), { hasNextPage, endCursor: edges.at(-1)?.cursor ?? null });
}

export function toCustomerConnection(
  records: CustomerRecord[],
  hasNextPage: boolean,
  tenant: TenantContext,
): CustomerConnection {
  const nodes = records.map((record) => toCustomer(record, tenant));
  const edges = nodes.map((node, index) =>
    Object.assign(new CustomerEdge(), { node, cursor: encodeCursor({ id: records[index]!.id }) }),
  );
  return Object.assign(new CustomerConnection(), {
    edges,
    nodes,
    pageInfo: pageInfo(edges, hasNextPage),
  });
}

export function toBlocklistEntryConnection(
  records: BlocklistEntryRecord[],
  hasNextPage: boolean,
  tenant: TenantContext,
): BlocklistEntryConnection {
  const nodes = records.map((record) => toBlocklistEntry(record, tenant));
  const edges = nodes.map((node, index) =>
    Object.assign(new BlocklistEntryEdge(), {
      node,
      cursor: encodeCursor({ id: records[index]!.id }),
    }),
  );
  return Object.assign(new BlocklistEntryConnection(), {
    edges,
    nodes,
    pageInfo: pageInfo(edges, hasNextPage),
  });
}
