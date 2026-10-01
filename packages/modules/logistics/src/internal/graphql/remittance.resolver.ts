import {
  CurrentTenant,
  Money,
  PageInfo,
  RequireScopes,
  UserError,
  accessDenied,
  badUserInput,
  decodeCursor,
  deniedToRole,
  encodeCursor,
  hasScope,
  pageSize,
  type StaffRole,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { money, type CurrencyCode } from '@hatti/money';
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import type { CodRemittanceLineRecord, CodRemittanceRecord } from '../records.js';
import { CodRemittanceService } from '../remittance.service.js';
import {
  CodRemittance,
  CodRemittanceConnection,
  CodRemittanceEdge,
  CodRemittanceImportPayload,
  CodRemittanceLine,
  CodRemittanceLinesArgs,
  CodRemittanceOutcome,
  CodRemittanceOutcomeCounts,
  CodRemittanceRowError,
  CodRemittancesArgs,
} from './remittance.types.js';

/**
 * Staff who reconcile couriers' cash: owners, managers and accountants. It marks orders paid, so
 * apps need write_orders to import, and read_orders to read.
 */
const RECONCILING_ROLES: readonly StaffRole[] = ['owner', 'manager', 'accountant'];

function mayReconcile(tenant: TenantContext, writing: boolean): void {
  if (tenant.actor.kind === 'staff') {
    if (!RECONCILING_ROLES.includes(tenant.actor.role)) {
      throw deniedToRole(
        "Access denied. Only owners, managers and accountants reconcile couriers' remittances.",
      );
    }
  } else if (writing && !hasScope(tenant, 'write_orders')) {
    throw accessDenied(['write_orders']);
  }
}

/** Couriers' remittance statements (COD-10, ADR-067). */
@Resolver(() => CodRemittance)
export class CodRemittanceResolver {
  constructor(private readonly service: CodRemittanceService) {}

  @Mutation(() => CodRemittanceImportPayload, {
    description:
      "Imports a courier's remittance statement, as the CSV the courier sends: a row per " +
      'parcel, found by its tracking number ("Tracking Number", "CN" and the like), with the ' +
      'cash collected ("COD Amount"), and the charges, tax withheld and net amount when it has ' +
      "them. Each parcel's cash is received on its order, at most what the order owes, all in " +
      'one go; lines that match no parcel, or one paid for before, receive nothing and are ' +
      'kept to look into. Staff need to be an owner, a manager or an accountant.',
  })
  @RequireScopes('read_orders')
  async codRemittanceImport(
    @CurrentTenant() tenant: TenantContext,
    @Args('courier', { description: 'The courier, as staff name it, such as "Leopards".' })
    courier: string,
    @Args('csv') csv: string,
    @Args('reference', {
      type: () => String,
      nullable: true,
      description:
        "The statement's number or the payment's reference: the same courier's again is refused.",
    })
    reference?: string | null,
    @Args('dryRun', {
      type: () => Boolean,
      nullable: true,
      description: 'Read the statement and say what would happen, writing nothing.',
    })
    dryRun?: boolean | null,
  ): Promise<CodRemittanceImportPayload> {
    mayReconcile(tenant, true);
    const result = await this.service.import(tenant, {
      courier,
      csv,
      reference,
      dryRun: dryRun ?? false,
    });
    const amount = (minor: bigint) => Money.from(money(minor, tenant.currency));
    if (!result.ok) {
      return Object.assign(new CodRemittanceImportPayload(), {
        remittance: null,
        rows: 0,
        outcomes: toOutcomeCounts({}),
        collected: amount(0n),
        charges: amount(0n),
        tax: amount(0n),
        paid: amount(0n),
        received: amount(0n),
        issues: [],
        rowErrorCount: 0,
        rowErrors: [],
        dryRun: dryRun ?? false,
        userErrors: UserError.list(result.errors),
      });
    }
    const imported = result.value;
    return Object.assign(new CodRemittanceImportPayload(), {
      remittance: imported.remittance && toRemittance(imported.remittance, tenant.currency),
      rows: imported.rows,
      outcomes: toOutcomeCounts(imported.outcomes),
      collected: amount(imported.collected),
      charges: amount(imported.charges),
      tax: amount(imported.tax),
      paid: amount(imported.paid),
      received: amount(imported.received),
      issues: imported.issues.map((line) => toLine(line, tenant.currency)),
      rowErrorCount: imported.rowErrorCount,
      rowErrors: imported.rowErrors.map((error) =>
        Object.assign(new CodRemittanceRowError(), error),
      ),
      dryRun: imported.dryRun,
      userErrors: [],
    });
  }

  @Query(() => CodRemittanceConnection, {
    description: "The shop's imported remittance statements, newest first.",
  })
  @RequireScopes('read_orders')
  async codRemittances(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: CodRemittancesArgs,
  ): Promise<CodRemittanceConnection> {
    mayReconcile(tenant, false);
    const after = args.after ? uuidOf(decodeCursor(args.after, ['id']).id) : null;
    const first = pageSize(args.first);
    const { items, hasNextPage } = await this.service.list(tenant, { first, after });
    const nodes = items.map((record) => toRemittance(record, tenant.currency));
    const edges = nodes.map((node) =>
      Object.assign(new CodRemittanceEdge(), { cursor: encodeCursor({ id: node.id }), node }),
    );
    return Object.assign(new CodRemittanceConnection(), {
      edges,
      nodes,
      pageInfo: Object.assign(new PageInfo(), {
        hasNextPage,
        endCursor: edges.at(-1)?.cursor ?? null,
      }),
    });
  }

  @Query(() => CodRemittance, { nullable: true })
  @RequireScopes('read_orders')
  async codRemittance(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<CodRemittance | null> {
    mayReconcile(tenant, false);
    const record = await this.service.get(tenant, uuidOf(id));
    return record ? toRemittance(record, tenant.currency) : null;
  }

  @ResolveField(() => [CodRemittanceLine], {
    description: "The statement's lines, in the file's order.",
  })
  async lines(
    @Parent() remittance: CodRemittance,
    @Args() args: CodRemittanceLinesArgs,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<CodRemittanceLine[]> {
    const lines = await this.service.lines(tenant, uuidOf(remittance.id), {
      first: pageSize(args.first),
      after: args.afterRow ?? null,
      issuesOnly: args.issuesOnly ?? false,
    });
    return lines.map((line) => toLine(line, tenant.currency));
  }
}

function uuidOf(id: string): string {
  const uuid = tryFromPublicId(id, 'codRemittance');
  if (!uuid) throw badUserInput(`Invalid codRemittance id: ${id.slice(0, 64)}`);
  return uuid;
}

function toRemittance(record: CodRemittanceRecord, currency: CurrencyCode): CodRemittance {
  const amount = (minor: bigint) => Money.from(money(minor, currency));
  return Object.assign(new CodRemittance(), {
    id: toPublicId('codRemittance', record.id),
    courier: record.courier,
    reference: record.reference,
    lineCount: record.lineCount,
    collected: amount(record.collected),
    charges: amount(record.charges),
    tax: amount(record.tax),
    paid: amount(record.paid),
    received: amount(record.received),
    issueCount: record.issueCount,
    createdAt: record.createdAt,
  });
}

function toLine(line: CodRemittanceLineRecord, currency: CurrencyCode): CodRemittanceLine {
  const amount = (minor: bigint) => Money.from(money(minor, currency));
  return Object.assign(new CodRemittanceLine(), {
    row: line.row,
    trackingNumber: line.trackingNumber,
    outcome: line.outcome.toUpperCase() as CodRemittanceOutcome,
    fulfillmentId: line.fulfillmentId && toPublicId('fulfillment', line.fulfillmentId),
    orderId: line.orderId && toPublicId('order', line.orderId),
    orderName: line.orderNumber === null ? null : `#${line.orderNumber}`,
    collected: amount(line.collected),
    charges: amount(line.charges),
    tax: amount(line.tax),
    owed: line.owed === null ? null : amount(line.owed),
    received: amount(line.received),
  });
}

function toOutcomeCounts(
  counts: Partial<Record<Lowercase<keyof typeof CodRemittanceOutcome>, number>>,
): CodRemittanceOutcomeCounts {
  return Object.assign(new CodRemittanceOutcomeCounts(), {
    received: counts.received ?? 0,
    short: counts.short ?? 0,
    over: counts.over ?? 0,
    unmatched: counts.unmatched ?? 0,
    repeated: counts.repeated ?? 0,
    notOwed: counts.not_owed ?? 0,
    charged: counts.charged ?? 0,
  });
}
