import {
  CurrentTenant,
  RequireRecentAuthentication,
  RequireScopes,
  UserError,
  deniedToRole,
  failOne,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  EXPORT_SCHEDULE_LIMITS,
  ExportScheduleService,
  type ExportFrequencyValue,
  type ExportScheduleRecord,
} from '../export-schedule.service.js';
import {
  EXPORT_ROLES,
  type ExportFormatValue,
  type ExportLayoutValue,
} from '../order-export.service.js';
import {
  OrderExportFrequency,
  OrderExportSchedule,
  OrderExportScheduleCreatePayload,
  OrderExportScheduleDeletePayload,
  OrderExportScheduleInput,
} from './export-schedule.types.js';
import { OrderExportFormat, OrderExportLayout } from './export.types.js';

/** Staff who may not export orders may not schedule exports either, nor see who does. */
function exportingOnly(tenant: TenantContext): void {
  if (tenant.actor.kind === 'staff' && !EXPORT_ROLES.includes(tenant.actor.role)) {
    throw deniedToRole('Access denied. Only owners, managers and accountants export orders.');
  }
}

/**
 * Exports of the shop's orders its staff schedule (ORD-11, ADR-183), each emailed to the member of
 * staff who scheduled it every day, week or month: listed, made and deleted by those who may
 * export orders.
 */
@Resolver()
export class ExportScheduleResolver {
  constructor(private readonly schedules: ExportScheduleService) {}

  @Query(() => [OrderExportSchedule], {
    description:
      "The shop's scheduled exports of its orders, the newest first (ORD-11). Staff need to be " +
      'an owner, a manager or an accountant.',
  })
  @RequireScopes('read_orders')
  async orderExportSchedules(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<OrderExportSchedule[]> {
    exportingOnly(tenant);
    return (await this.schedules.list(tenant)).map(toSchedule);
  }

  @Mutation(() => OrderExportScheduleCreatePayload, {
    description:
      "Schedules an export of the shop's orders for the member of staff asking (ORD-11, " +
      'ADR-183): every day, week or month, the orders placed in the one that ended, filtered as ' +
      'the order list is, emailed to their proved email as an attachment at the hour given, in ' +
      'the shop time zone, while they work in the shop as an owner, a manager or an accountant. ' +
      `A shop keeps up to ${EXPORT_SCHEDULE_LIMITS.perShop}. Every export it sends is recorded ` +
      'in the audit log, as theirs. Staff confirm who they are first when they signed in over ' +
      '15 minutes ago.',
  })
  @RequireScopes('read_orders')
  @RequireRecentAuthentication()
  async orderExportScheduleCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: OrderExportScheduleInput,
  ): Promise<OrderExportScheduleCreatePayload> {
    exportingOnly(tenant);
    const result = await this.schedules.create(tenant, {
      frequency: input.frequency.toLowerCase() as ExportFrequencyValue,
      hour: input.hour,
      layout: input.layout.toLowerCase() as ExportLayoutValue,
      format: input.format.toLowerCase() as ExportFormatValue,
      query: input.query,
    });
    return Object.assign(new OrderExportScheduleCreatePayload(), {
      exportSchedule: result.ok ? toSchedule(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => OrderExportScheduleDeletePayload, {
    description:
      'Deletes a scheduled export: a member of staff their own, owners, managers and apps any.',
  })
  @RequireScopes('read_orders')
  async orderExportScheduleDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<OrderExportScheduleDeletePayload> {
    exportingOnly(tenant);
    const uuid = tryFromPublicId(id, 'exportSchedule');
    const result = uuid
      ? await this.schedules.delete(tenant, uuid)
      : failOne<string>(['id'], 'NOT_FOUND', 'Scheduled export not found');
    return Object.assign(new OrderExportScheduleDeletePayload(), {
      deletedExportScheduleId: result.ok ? toPublicId('exportSchedule', result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function toSchedule(record: ExportScheduleRecord): OrderExportSchedule {
  return Object.assign(new OrderExportSchedule(), {
    id: toPublicId('exportSchedule', record.id),
    staffMemberId: toPublicId('user', record.userId),
    frequency: record.frequency.toUpperCase() as OrderExportFrequency,
    hour: record.hour,
    layout: record.layout.toUpperCase() as OrderExportLayout,
    format: record.format.toUpperCase() as OrderExportFormat,
    query: record.query,
    nextSendAt: record.nextRunAt,
    nextPeriodFirstDay: record.nextPeriod.firstDay,
    nextPeriodLastDay: record.nextPeriod.lastDay,
    lastSentAt: record.lastSentAt,
    lastError: record.lastError,
    createdAt: record.createdAt,
  });
}
