import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { clockOf } from '../calling-hours.js';
import {
  OrderSettingsService,
  type ConfirmationCallsValue,
  type OrderSettingsRecord,
} from '../order-settings.service.js';
import type { CustomerCancellationValue } from '../schema.js';
import {
  CallingHours,
  ConfirmationCalls,
  CustomerCancellation,
  OrderSettings,
  OrderSettingsInput,
  OrderSettingsUpdatePayload,
} from './order-settings.types.js';

@Resolver()
export class OrderSettingsResolver {
  constructor(private readonly settings: OrderSettingsService) {}

  @Query(() => OrderSettings, {
    description:
      "The shop's policies for its orders, but for risk: how long customers may cancel, the " +
      "Confirmation Desk's calling hours and first-call target, and when it gives up on " +
      "customers who can't be reached.",
  })
  @RequireScopes('read_settings')
  async orderSettings(@CurrentTenant() tenant: TenantContext): Promise<OrderSettings> {
    return toOrderSettings(await this.settings.get(tenant));
  }

  @Mutation(() => OrderSettingsUpdatePayload, {
    description: "Changes the shop's order settings, for what customers do from now on.",
  })
  @RequireScopes('write_settings')
  async orderSettingsUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: OrderSettingsInput,
  ): Promise<OrderSettingsUpdatePayload> {
    const result = await this.settings.update(tenant, {
      ...(input.customerCancellation && {
        customerCancellation: input.customerCancellation.toLowerCase() as CustomerCancellationValue,
      }),
      ...(input.callingHours !== undefined && { callingHours: input.callingHours }),
      ...(input.firstCallMinutes !== undefined && { firstCallMinutes: input.firstCallMinutes }),
      ...(typeof input.deskWaitsForReminder === 'boolean' && {
        deskWaitsForReminder: input.deskWaitsForReminder,
      }),
      ...(input.cancelUnreachableAfterDays !== undefined && {
        cancelUnreachableAfterDays: input.cancelUnreachableAfterDays,
      }),
      ...(input.cancelUnpaidAfterDays !== undefined && {
        cancelUnpaidAfterDays: input.cancelUnpaidAfterDays,
      }),
      ...(input.cancelUnpaidAfterHours !== undefined && {
        cancelUnpaidAfterHours: input.cancelUnpaidAfterHours,
      }),
      ...(input.upsellPercentOff !== undefined && { upsellPercentOff: input.upsellPercentOff }),
      ...(input.creditBackOnReturn !== undefined &&
        input.creditBackOnReturn !== null && { creditBackOnReturn: input.creditBackOnReturn }),
      ...(input.confirmationCalls && {
        confirmationCalls: input.confirmationCalls.toLowerCase() as ConfirmationCallsValue,
      }),
      ...(input.staffDiscountPercent !== undefined && {
        staffDiscountPercent: input.staffDiscountPercent,
      }),
      ...(typeof input.shareNewOrders === 'boolean' && { shareNewOrders: input.shareNewOrders }),
    });
    return Object.assign(new OrderSettingsUpdatePayload(), {
      orderSettings: result.ok ? toOrderSettings(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function toOrderSettings(record: OrderSettingsRecord): OrderSettings {
  return Object.assign(new OrderSettings(), {
    customerCancellation: record.customerCancellation.toUpperCase() as CustomerCancellation,
    callingHours: record.callingHours
      ? Object.assign(new CallingHours(), {
          opens: clockOf(record.callingHours.opens),
          closes: clockOf(record.callingHours.closes),
        })
      : null,
    firstCallMinutes: record.firstCallMinutes,
    deskWaitsForReminder: record.deskWaitsForReminder,
    cancelUnreachableAfterDays: record.cancelUnreachableAfterDays,
    cancelUnpaidAfterDays: record.cancelUnpaidAfterDays,
    cancelUnpaidAfterHours: record.cancelUnpaidAfterHours,
    upsellPercentOff: record.upsellPercentOff,
    creditBackOnReturn: record.creditBackOnReturn,
    confirmationCalls: record.confirmationCalls.toUpperCase() as ConfirmationCalls,
    staffDiscountPercent: record.staffDiscountPercent,
    shareNewOrders: record.shareNewOrders,
    updatedAt: record.updatedAt,
  });
}
