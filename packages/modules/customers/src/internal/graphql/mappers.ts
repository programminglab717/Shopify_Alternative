import { PageInfo, badUserInput, decodeCursor, encodeCursor } from '@hatti/api';
import { isUuid, toPublicId, tryFromPublicId, type IdKind } from '@hatti/ids';
import type { BlocklistEntryRecord, CustomerRecord } from '../records.js';
import { displayPhone } from '../rules.js';
import type { BlockReasonValue } from '../schema.js';
import {
  BlocklistEntry,
  BlocklistEntryConnection,
  BlocklistEntryEdge,
  BlocklistReason,
  Customer,
  CustomerConnection,
  CustomerEdge,
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

export function toCustomer(record: CustomerRecord): Customer {
  return Object.assign(new Customer(), {
    id: toPublicId('customer', record.id),
    phone: record.phone,
    name: record.name,
    displayName: record.name ?? displayPhone(record.phone),
    email: record.email,
    note: record.note,
    tags: record.tags,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    uuid: record.id,
  });
}

export function toBlocklistEntry(record: BlocklistEntryRecord): BlocklistEntry {
  return Object.assign(new BlocklistEntry(), {
    id: toPublicId('blocklistEntry', record.id),
    phone: record.phone,
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
): CustomerConnection {
  const nodes = records.map(toCustomer);
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
): BlocklistEntryConnection {
  const nodes = records.map(toBlocklistEntry);
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
