import { PageInfo, badUserInput, decodeCursor, encodeCursor } from '@hatti/api';
import { isUuid, toPublicId, tryFromPublicId, type IdKind } from '@hatti/ids';
import { PK_PROVINCES } from '@hatti/pk';
import type {
  AdjustmentGroupRecord,
  InventoryChangeRecord,
  InventoryItemRecord,
  InventoryLevelRecord,
  LocationRecord,
} from '../records.js';
import type { InventoryPolicyValue } from '../schema.js';
import {
  InventoryAdjustmentGroup,
  InventoryChange,
  InventoryChangeConnection,
  InventoryChangeEdge,
  InventoryItem,
  InventoryLevel,
  InventoryPolicy,
} from './inventory.types.js';
import { Location, LocationAddress, LocationConnection, LocationEdge } from './location.types.js';

/** The UUID behind a public ID of the given kind, or a BAD_USER_INPUT error. */
export function uuidOf(kind: IdKind, id: string): string {
  const uuid = tryFromPublicId(id, kind);
  if (!uuid) throw badUserInput(`Invalid ${kind} id: ${id.slice(0, 64)}`);
  return uuid;
}

/** A history page cursor: the last change's ledger entry. */
export function changeCursorAfter(after: string | null | undefined): string | null {
  if (!after) return null;
  const { id } = decodeCursor(after, ['id']);
  if (!isUuid(id)) throw badUserInput('Invalid cursor');
  return id;
}

export function toPolicyValue(policy: InventoryPolicy): InventoryPolicyValue {
  return policy.toLowerCase() as InventoryPolicyValue;
}

export function toLocation(record: LocationRecord): Location {
  const { address } = record;
  const province = address.provinceCode ? PK_PROVINCES[address.provinceCode].name : null;
  const cityLine = [address.city, address.zip].filter(Boolean).join(' ');
  return Object.assign(new Location(), {
    id: toPublicId('location', record.id),
    name: record.name,
    address: Object.assign(new LocationAddress(), {
      ...address,
      province,
      formatted: [address.address1, address.address2, cityLine, province].filter(
        (line): line is string => Boolean(line),
      ),
    }),
    isActive: record.isActive,
    isPrimary: record.isPrimary,
    fulfillsOnlineOrders: record.fulfillsOnlineOrders,
    deactivatedAt: record.deactivatedAt,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function toLocationConnection(
  records: LocationRecord[],
  hasNextPage: boolean,
): LocationConnection {
  const nodes = records.map(toLocation);
  const edges = nodes.map((node) =>
    Object.assign(new LocationEdge(), { node, cursor: encodeCursor({ id: node.id }) }),
  );
  return Object.assign(new LocationConnection(), {
    edges,
    nodes,
    pageInfo: Object.assign(new PageInfo(), {
      hasNextPage,
      endCursor: edges.at(-1)?.cursor ?? null,
    }),
  });
}

export function toInventoryLevel(record: InventoryLevelRecord): InventoryLevel {
  return Object.assign(new InventoryLevel(), {
    id: toPublicId('inventoryLevel', record.id),
    location: toLocation(record.location),
    available: record.available,
    onHand: record.onHand,
    committed: record.committed,
    reserved: record.reserved,
    safetyStock: record.safetyStock,
    updatedAt: record.updatedAt,
  });
}

export function toInventoryItem(record: InventoryItemRecord): InventoryItem {
  return Object.assign(new InventoryItem(), {
    id: toPublicId('inventoryItem', record.variantId),
    tracked: record.tracked,
    inventoryPolicy: record.inventoryPolicy.toUpperCase() as InventoryPolicy,
    inventoryLevels: record.levels.map(toInventoryLevel),
    variantId: record.variantId,
  });
}

export function toInventoryChange(record: InventoryChangeRecord): InventoryChange {
  return Object.assign(new InventoryChange(), {
    name: record.name,
    delta: record.delta,
    quantityAfterChange: record.quantityAfter,
    availableAfterChange: record.availableAfter,
    location: toLocation(record.location),
    reason: record.reason,
    referenceDocumentUri: record.referenceDocumentUri,
    createdAt: record.createdAt,
    variantId: record.variantId,
  });
}

export function toAdjustmentGroup(record: AdjustmentGroupRecord): InventoryAdjustmentGroup {
  return Object.assign(new InventoryAdjustmentGroup(), {
    id: toPublicId('inventoryAdjustment', record.id),
    reason: record.reason,
    referenceDocumentUri: record.referenceDocumentUri,
    createdAt: record.createdAt,
    changes: record.changes.map(toInventoryChange),
  });
}

export function toChangeConnection(
  records: InventoryChangeRecord[],
  hasNextPage: boolean,
): InventoryChangeConnection {
  const nodes = records.map(toInventoryChange);
  const edges = nodes.map((node, index) =>
    Object.assign(new InventoryChangeEdge(), {
      node,
      cursor: encodeCursor({ id: records[index]!.id }),
    }),
  );
  return Object.assign(new InventoryChangeConnection(), {
    edges,
    nodes,
    pageInfo: Object.assign(new PageInfo(), {
      hasNextPage,
      endCursor: edges.at(-1)?.cursor ?? null,
    }),
  });
}
