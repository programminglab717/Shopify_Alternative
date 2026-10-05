import {
  CurrentTenant,
  RequireRecentAuthentication,
  RequireScopes,
  UserError,
  deniedToRole,
  type TenantContext,
} from '@hatti/api';
import { Args, Mutation, Resolver } from '@nestjs/graphql';
import {
  EXPORT_LIMITS,
  EXPORT_ROLES,
  OrderExportService,
  type ExportFormatValue,
  type ExportLayoutValue,
} from '../order-export.service.js';
import { OrderExportFile, OrdersExportArgs, OrdersExportPayload } from './export.types.js';
import { toRiskLevelValue, toStageValue } from './mappers.js';

@Resolver()
export class OrderExportResolver {
  constructor(private readonly exports: OrderExportService) {}

  @Mutation(() => OrdersExportPayload, {
    description:
      'Orders as CSV or an Excel workbook, oldest first, filtered as the order list is: up to ' +
      `${EXPORT_LIMITS.orders.toLocaleString('en')} orders, a row each or a row per line ` +
      "item. Customers' numbers show as the caller sees them elsewhere, masked for most staff. " +
      'Staff need to be an owner, a manager or an accountant. Every export is recorded in the ' +
      'audit log. Staff confirm who they are first when they signed in over 15 minutes ago.',
  })
  @RequireScopes('read_orders')
  @RequireRecentAuthentication()
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
      format: args.format.toLowerCase() as ExportFormatValue,
    });
    return Object.assign(new OrdersExportPayload(), {
      csv: result.ok ? result.value.csv : null,
      file: result.ok
        ? Object.assign(new OrderExportFile(), {
            filename: result.value.file.filename,
            contentType: result.value.file.contentType,
            content: result.value.file.content.toString('base64'),
          })
        : null,
      rowCount: result.ok ? result.value.rowCount : 0,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
