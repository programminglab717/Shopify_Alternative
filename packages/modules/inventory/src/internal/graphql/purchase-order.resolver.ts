import {
  CurrentTenant,
  Loaders,
  Money,
  PageInfo,
  RequestLoaders,
  RequireIdempotencyKey,
  RequireScopes,
  UserError,
  badUserInput,
  decodeCursor,
  encodeCursor,
  pageSize,
  type TenantContext,
} from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { money } from '@hatti/money';
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { InventoryService } from '../inventory.service.js';
import {
  PurchaseOrderService,
  type PurchaseOrderRecord,
  type SupplierRecord,
} from '../purchase-order.service.js';
import type { PurchaseOrderStatusValue } from '../schema.js';
import { InventoryItem } from './inventory.types.js';
import { loadItem } from './inventory.resolver.js';
import { toInventoryItem, toLocation, uuidOf } from './mappers.js';
import {
  PurchaseOrder,
  PurchaseOrderConnection,
  PurchaseOrderCreateInput,
  PurchaseOrderEdge,
  PurchaseOrderLine,
  PurchaseOrderPayload,
  PurchaseOrderReceiveInput,
  PurchaseOrderStatus,
  PurchaseOrderUpdateInput,
  PurchaseOrdersArgs,
  Supplier,
  SupplierInput,
  SupplierPayload,
} from './purchase-order.types.js';

function toSupplier(record: SupplierRecord): Supplier {
  return Object.assign(new Supplier(), {
    id: toPublicId('supplier', record.id),
    name: record.name,
    phone: record.phone,
    note: record.note,
    createdAt: record.createdAt,
  });
}

function toPurchaseOrder(record: PurchaseOrderRecord, tenant: TenantContext): PurchaseOrder {
  const costed = record.lines.filter((line) => line.unitCost !== null);
  const amount = (minor: bigint) => Money.from(money(minor, tenant.currency));
  return Object.assign(new PurchaseOrder(), {
    id: toPublicId('purchaseOrder', record.id),
    name: `PO-${record.number}`,
    number: record.number,
    status: record.status.toUpperCase() as PurchaseOrderStatus,
    supplier: toSupplier(record.supplier),
    location: toLocation(record.location),
    reference: record.reference,
    note: record.note,
    expectedOn: record.expectedOn,
    lines: record.lines.map((line) =>
      Object.assign(new PurchaseOrderLine(), {
        id: toPublicId('purchaseOrderLine', line.id),
        productTitle: line.productTitle,
        variantTitle: line.variantTitle,
        sku: line.sku,
        quantity: line.quantity,
        received: line.received,
        unitCost: line.unitCost === null ? null : amount(line.unitCost),
        variantId: line.variantId,
      }),
    ),
    totalQuantity: record.lines.reduce((sum, line) => sum + line.quantity, 0),
    receivedQuantity: record.lines.reduce((sum, line) => sum + line.received, 0),
    totalCost:
      costed.length === 0
        ? null
        : amount(costed.reduce((sum, line) => sum + line.unitCost! * BigInt(line.quantity), 0n)),
    closedAt: record.closedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function payload(
  result: Awaited<ReturnType<PurchaseOrderService['create']>>,
  tenant: TenantContext,
) {
  return Object.assign(new PurchaseOrderPayload(), {
    purchaseOrder: result.ok ? toPurchaseOrder(result.value, tenant) : null,
    userErrors: result.ok ? [] : UserError.list(result.errors),
  });
}

/** The number a page's cursor names: the last purchase order of the page before. */
function afterNumber(after: string | null | undefined): number | null {
  if (!after) return null;
  const number = Number(decodeCursor(after, ['number']).number);
  if (!Number.isInteger(number) || number < 1) throw badUserInput('Invalid cursor');
  return number;
}

@Resolver(() => PurchaseOrder)
export class PurchaseOrderResolver {
  constructor(private readonly service: PurchaseOrderService) {}

  @Query(() => [Supplier], { description: "The shop's suppliers, by name; at most 250." })
  @RequireScopes('read_inventory')
  async suppliers(@CurrentTenant() tenant: TenantContext): Promise<Supplier[]> {
    return (await this.service.suppliers(tenant)).map(toSupplier);
  }

  @Query(() => PurchaseOrder, { nullable: true, description: 'A purchase order by ID.' })
  @RequireScopes('read_inventory')
  async purchaseOrder(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<PurchaseOrder | null> {
    const record = await this.service.get(tenant, uuidOf('purchaseOrder', id));
    return record ? toPurchaseOrder(record, tenant) : null;
  }

  @Query(() => PurchaseOrderConnection, { description: 'Purchase orders, the newest first.' })
  @RequireScopes('read_inventory')
  async purchaseOrders(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: PurchaseOrdersArgs,
  ): Promise<PurchaseOrderConnection> {
    const { items, hasNextPage } = await this.service.list(tenant, {
      first: pageSize(args.first),
      afterNumber: afterNumber(args.after),
      status: args.status ? (args.status.toLowerCase() as PurchaseOrderStatusValue) : null,
      supplierId: args.supplierId ? uuidOf('supplier', args.supplierId) : null,
    });
    const nodes = items.map((item) => toPurchaseOrder(item, tenant));
    const edges = nodes.map((node) =>
      Object.assign(new PurchaseOrderEdge(), {
        node,
        cursor: encodeCursor({ number: String(node.number) }),
      }),
    );
    return Object.assign(new PurchaseOrderConnection(), {
      edges,
      nodes,
      pageInfo: Object.assign(new PageInfo(), {
        hasNextPage,
        endCursor: edges.at(-1)?.cursor ?? null,
      }),
    });
  }

  @Mutation(() => SupplierPayload, { description: 'Adds a supplier, named uniquely in the shop.' })
  @RequireScopes('write_inventory')
  async supplierCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: SupplierInput,
  ): Promise<SupplierPayload> {
    const result = await this.service.createSupplier(tenant, input);
    return Object.assign(new SupplierPayload(), {
      supplier: result.ok ? toSupplier(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => SupplierPayload, { description: "Changes a supplier's name, number or note." })
  @RequireScopes('write_inventory')
  async supplierUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: SupplierInput,
  ): Promise<SupplierPayload> {
    const result = await this.service.updateSupplier(tenant, uuidOf('supplier', id), input);
    return Object.assign(new SupplierPayload(), {
      supplier: result.ok ? toSupplier(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => PurchaseOrderPayload, {
    description:
      'Orders goods from a supplier for a location, numbered PO-1 onwards. Nothing is in stock ' +
      'until it is received.',
  })
  @RequireScopes('write_inventory')
  async purchaseOrderCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: PurchaseOrderCreateInput,
  ): Promise<PurchaseOrderPayload> {
    const result = await this.service.create(tenant, {
      ...input,
      supplierId: uuidOf('supplier', input.supplierId),
      locationId: uuidOf('location', input.locationId),
      lines: input.lines.map((line) => ({
        ...line,
        inventoryItemId: uuidOf('inventoryItem', line.inventoryItemId),
      })),
    });
    return payload(result, tenant);
  }

  @Mutation(() => PurchaseOrderPayload, {
    description:
      "Changes an open order: the supplier's number, note and day expected; lines added, their " +
      'quantities or costs changed, never below what came already, and lines none of which came ' +
      'removed. An order whose every line has come in full after it is RECEIVED.',
  })
  @RequireScopes('write_inventory')
  async purchaseOrderUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: PurchaseOrderUpdateInput,
  ): Promise<PurchaseOrderPayload> {
    const result = await this.service.update(tenant, uuidOf('purchaseOrder', id), {
      reference: input.reference,
      note: input.note,
      expectedOn: input.expectedOn,
      linesToAdd: input.linesToAdd?.map((line) => ({
        ...line,
        inventoryItemId: uuidOf('inventoryItem', line.inventoryItemId),
      })),
      linesToUpdate: input.linesToUpdate?.map((line) => ({
        ...line,
        lineId: uuidOf('purchaseOrderLine', line.lineId),
      })),
      lineIdsToRemove: input.lineIdsToRemove?.map((lineId) => uuidOf('purchaseOrderLine', lineId)),
    });
    return payload(result, tenant);
  }

  @Mutation(() => PurchaseOrderPayload, {
    description:
      "Goods that came: each line's quantity added to on hand at the order's location, in one " +
      'adjustment with the reason "received" naming the order, never more than is still to ' +
      'come. Received in full, the order is RECEIVED. Needs an Idempotency-Key header.',
  })
  @RequireScopes('write_inventory')
  @RequireIdempotencyKey()
  async purchaseOrderReceive(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: PurchaseOrderReceiveInput,
  ): Promise<PurchaseOrderPayload> {
    const result = await this.service.receive(tenant, uuidOf('purchaseOrder', id), {
      lines: input.lines.map((line) => ({
        lineId: uuidOf('purchaseOrderLine', line.lineId),
        quantity: line.quantity,
      })),
    });
    return payload(result, tenant);
  }

  @Mutation(() => PurchaseOrderPayload, {
    description: 'Closes an open order with what came; the rest is no longer expected.',
  })
  @RequireScopes('write_inventory')
  async purchaseOrderClose(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<PurchaseOrderPayload> {
    return payload(await this.service.close(tenant, uuidOf('purchaseOrder', id)), tenant);
  }
}

@Resolver(() => PurchaseOrderLine)
export class PurchaseOrderLineResolver {
  constructor(private readonly inventory: InventoryService) {}

  @ResolveField(() => InventoryItem, { description: "The variant's item, as it is now." })
  async inventoryItem(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() line: PurchaseOrderLine,
  ): Promise<InventoryItem> {
    return toInventoryItem(await loadItem(loaders, this.inventory, tenant, line.variantId));
  }
}
