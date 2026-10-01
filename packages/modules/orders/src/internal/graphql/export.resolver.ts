import {
  CurrentTenant,
  RequireScopes,
  UserError,
  deniedToRole,
  type StaffRole,
  type TenantContext,
} from '@hatti/api';
import { Args, Mutation, Resolver } from '@nestjs/graphql';
import {
  EXPORT_LIMITS,
  OrderExportService,
  type ExportLayoutValue,
} from '../order-export.service.js';
import { OrdersExportArgs, OrdersExportPayload } from './export.types.js';
import { toRiskLevelValue, toStageValue } from './mappers.js';

/**
 * Staff who may export orders: owners and managers, and accountants, who reconcile them. Exports
 * by other roles, such as marketers, need an approval flow that does not exist yet
 * (docs/architecture/11-security-and-compliance.md §2.1). Apps need only read_orders.
 */
const EXPORT_ROLES: readonly StaffRole[] = ['owner', 'manager', 'accountant'];

@Resolver()
export class OrderExportResolver {
  constructor(private readonly exports: OrderExportService) {}

  @Mutation(() => OrdersExportPayload, {
    description:
      'Orders as CSV, oldest first, filtered as the order list is: up to ' +
      `${EXPORT_LIMITS.orders.toLocaleString('en')} orders, a row each or a row per line ` +
      "item. Customers' numbers show as the caller sees them elsewhere, masked for most staff. " +
      'Staff need to be an owner, a manager or an accountant. Every export is recorded in the ' +
      'audit log.',
  })
  @RequireScopes('read_orders')
  async ordersExport(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: OrdersExportArgs,
  ): Promise<OrdersExportPayload> {
    if (tenant.actor.kind === 'staff' && !EXPORT_ROLES.includes(tenant.actor.role)) {
      throw deniedToRole('Access denied. Only owners, managers and accountants export orders.');
    }
    const result = await this.exports.export(tenant, {
      query: args.query,
      stage: args.stage ? toStageValue(args.stage) : null,
      riskLevel: args.riskLevel ? toRiskLevelValue(args.riskLevel) : null,
      placedFrom: args.placedFrom,
      placedBefore: args.placedBefore,
      transferReceipt: args.hasTransferReceipt,
      layout: args.layout.toLowerCase() as ExportLayoutValue,
    });
    return Object.assign(new OrdersExportPayload(), {
      csv: result.ok ? result.value.csv : null,
      rowCount: result.ok ? result.value.rowCount : 0,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
