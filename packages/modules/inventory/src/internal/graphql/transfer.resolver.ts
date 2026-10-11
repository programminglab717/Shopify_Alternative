import {
  CurrentTenant,
  Loaders,
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
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { InventoryService } from '../inventory.service.js';
import type { TransferStatusValue } from '../schema.js';
import { TransferService, type TransferRecord } from '../transfer.service.js';
import { loadItem } from './inventory.resolver.js';
import { InventoryItem } from './inventory.types.js';
import { toInventoryItem, toLocation, uuidOf } from './mappers.js';
import {
  InventoryTransfer,
  InventoryTransferConnection,
  InventoryTransferCreateInput,
  InventoryTransferEdge,
  InventoryTransferLine,
  InventoryTransferPayload,
  InventoryTransferReceiveInput,
  InventoryTransferStatus,
  InventoryTransfersArgs,
} from './transfer.types.js';

function toTransfer(record: TransferRecord): InventoryTransfer {
  return Object.assign(new InventoryTransfer(), {
    id: toPublicId('inventoryTransfer', record.id),
    name: `T-${record.number}`,
    number: record.number,
    status: record.status.toUpperCase() as InventoryTransferStatus,
    origin: toLocation(record.origin),
    destination: toLocation(record.destination),
    reference: record.reference,
    note: record.note,
    lines: record.lines.map((line) =>
      Object.assign(new InventoryTransferLine(), {
        id: toPublicId('inventoryTransferLine', line.id),
        productTitle: line.productTitle,
        variantTitle: line.variantTitle,
        sku: line.sku,
        quantity: line.quantity,
        received: line.received,
        variantId: line.variantId,
      }),
    ),
    totalQuantity: record.lines.reduce((sum, line) => sum + line.quantity, 0),
    receivedQuantity: record.lines.reduce((sum, line) => sum + line.received, 0),
    closedAt: record.closedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function payload(result: Awaited<ReturnType<TransferService['create']>>) {
  return Object.assign(new InventoryTransferPayload(), {
    inventoryTransfer: result.ok ? toTransfer(result.value) : null,
    userErrors: result.ok ? [] : UserError.list(result.errors),
  });
}

/** The number a page's cursor names: the last transfer of the page before. */
function afterNumber(after: string | null | undefined): number | null {
  if (!after) return null;
  const number = Number(decodeCursor(after, ['number']).number);
  if (!Number.isInteger(number) || number < 1) throw badUserInput('Invalid cursor');
  return number;
}

@Resolver(() => InventoryTransfer)
export class TransferResolver {
  constructor(private readonly service: TransferService) {}

  @Query(() => InventoryTransfer, { nullable: true, description: 'A transfer by ID.' })
  @RequireScopes('read_inventory')
  async inventoryTransfer(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<InventoryTransfer | null> {
    const record = await this.service.get(tenant, uuidOf('inventoryTransfer', id));
    return record ? toTransfer(record) : null;
  }

  @Query(() => InventoryTransferConnection, {
    description: "Transfers between the shop's locations, the newest first.",
  })
  @RequireScopes('read_inventory')
  async inventoryTransfers(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: InventoryTransfersArgs,
  ): Promise<InventoryTransferConnection> {
    const { items, hasNextPage } = await this.service.list(tenant, {
      first: pageSize(args.first),
      afterNumber: afterNumber(args.after),
      status: args.status ? (args.status.toLowerCase() as TransferStatusValue) : null,
      locationId: args.locationId ? uuidOf('location', args.locationId) : null,
    });
    const nodes = items.map(toTransfer);
    const edges = nodes.map((node) =>
      Object.assign(new InventoryTransferEdge(), {
        node,
        cursor: encodeCursor({ number: String(node.number) }),
      }),
    );
    return Object.assign(new InventoryTransferConnection(), {
      edges,
      nodes,
      pageInfo: Object.assign(new PageInfo(), {
        hasNextPage,
        endCursor: edges.at(-1)?.cursor ?? null,
      }),
    });
  }

  @Mutation(() => InventoryTransferPayload, {
    description:
      'Sends stock from one active location to another, numbered T-1 onwards: each line taken ' +
      'off on hand where it leaves, no more than is available there, in one adjustment with the ' +
      'reason "movement_created" naming the transfer. It is IN_TRANSIT until received. Needs an ' +
      'Idempotency-Key header.',
  })
  @RequireScopes('write_inventory')
  @RequireIdempotencyKey()
  async inventoryTransferCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: InventoryTransferCreateInput,
  ): Promise<InventoryTransferPayload> {
    const result = await this.service.create(tenant, {
      ...input,
      originId: uuidOf('location', input.originId),
      destinationId: uuidOf('location', input.destinationId),
      lines: input.lines.map((line) => ({
        ...line,
        inventoryItemId: uuidOf('inventoryItem', line.inventoryItemId),
      })),
    });
    return payload(result);
  }

  @Mutation(() => InventoryTransferPayload, {
    description:
      "Stock that arrived: each line's quantity added to on hand at the destination, in one " +
      'adjustment with the reason "movement_received" naming the transfer, never more than is ' +
      'still on the way. Received in full, the transfer is RECEIVED. Needs an Idempotency-Key ' +
      'header.',
  })
  @RequireScopes('write_inventory')
  @RequireIdempotencyKey()
  async inventoryTransferReceive(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: InventoryTransferReceiveInput,
  ): Promise<InventoryTransferPayload> {
    const result = await this.service.receive(tenant, uuidOf('inventoryTransfer', id), {
      lines: input.lines.map((line) => ({
        lineId: uuidOf('inventoryTransferLine', line.lineId),
        quantity: line.quantity,
      })),
    });
    return payload(result);
  }

  @Mutation(() => InventoryTransferPayload, {
    description:
      'Cancels what has not arrived: it goes back on hand where it left, in one adjustment with ' +
      'the reason "movement_canceled", and the transfer is CANCELLED. What arrived stays.',
  })
  @RequireScopes('write_inventory')
  async inventoryTransferCancel(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<InventoryTransferPayload> {
    return payload(await this.service.cancel(tenant, uuidOf('inventoryTransfer', id)));
  }
}

@Resolver(() => InventoryTransferLine)
export class TransferLineResolver {
  constructor(private readonly inventory: InventoryService) {}

  @ResolveField(() => InventoryItem, { description: "The variant's item, as it is now." })
  async inventoryItem(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() line: InventoryTransferLine,
  ): Promise<InventoryItem> {
    return toInventoryItem(await loadItem(loaders, this.inventory, tenant, line.variantId));
  }
}
