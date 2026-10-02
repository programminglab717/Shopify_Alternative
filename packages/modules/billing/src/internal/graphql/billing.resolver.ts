import {
  CurrentTenant,
  Money,
  RequireRecentAuthentication,
  RequireScopes,
  UserError,
  badUserInput,
  deniedToRole,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { money } from '@hatti/money';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { BillingService, type InvoiceRecord, type SubscriptionRecord } from '../billing.service.js';
import { BILLING_CURRENCY, type Plan } from '../plans.js';
import {
  BillingInterval,
  BillingInvoice,
  BillingInvoicePayPayload,
  BillingInvoiceReason,
  BillingInvoiceStatus,
  BillingPlan,
  BillingPlanChangeInput,
  BillingPlanChangePayload,
  BillingPlanCode,
  BillingSubscription,
} from './billing.types.js';

/**
 * What the shop pays Hatti (BIL-01, ADR-154): the plans, its plan and its invoices, which owners
 * and managers see and apps with read_settings; the owner alone chooses a plan and pays, having
 * signed in lately, as it spends the shop's money.
 */
@Resolver()
export class BillingResolver {
  constructor(private readonly billing: BillingService) {}

  @Query(() => [BillingPlan], { description: 'The plans shops choose from, the smallest first.' })
  @RequireScopes('read_settings')
  billingPlans(): BillingPlan[] {
    return this.billing.plans().map(toPlan);
  }

  @Query(() => BillingSubscription, {
    description: 'The plan the shop pays Hatti for. Staff need to be the owner or a manager.',
  })
  @RequireScopes('read_settings')
  async billingSubscription(@CurrentTenant() tenant: TenantContext): Promise<BillingSubscription> {
    managing(tenant);
    return toSubscription(await this.billing.subscriptionOf(tenant.shopId));
  }

  @Query(() => [BillingInvoice], {
    description: "The shop's invoices from Hatti, the newest first, 50 at most.",
  })
  @RequireScopes('read_settings')
  async billingInvoices(
    @CurrentTenant() tenant: TenantContext,
    @Args('first', { type: () => Int, defaultValue: 20 }) first: number,
  ): Promise<BillingInvoice[]> {
    managing(tenant);
    return (await this.billing.invoicesOf(tenant.shopId, first)).map(toInvoice);
  }

  @Mutation(() => BillingPlanChangePayload, {
    description:
      "Chooses the shop's plan. A bigger one, or any from Free, is invoiced now, less what is " +
      'left of the current period, and begins once paid with billingInvoicePay; a smaller one, ' +
      'or Free, begins when the period ends. The current plan again drops a change chosen for ' +
      'later. The owner alone, having signed in lately.',
  })
  @RequireScopes('write_settings')
  @RequireRecentAuthentication()
  async billingPlanChange(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: BillingPlanChangeInput,
  ): Promise<BillingPlanChangePayload> {
    owner(tenant);
    const result = await this.billing.changePlan(tenant, {
      plan: input.plan.toLowerCase(),
      interval: input.interval ? input.interval.toLowerCase() : null,
    });
    return Object.assign(new BillingPlanChangePayload(), {
      subscription: result.ok ? toSubscription(result.value.subscription) : null,
      invoice: result.ok && result.value.invoice ? toInvoice(result.value.invoice) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => BillingInvoicePayPayload, {
    description:
      "Pays an open invoice through Hatti's own payment gateway: its page to send the owner to. " +
      'The owner alone, having signed in lately.',
  })
  @RequireScopes('write_settings')
  @RequireRecentAuthentication()
  async billingInvoicePay(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<BillingInvoicePayPayload> {
    owner(tenant);
    const uuid = tryFromPublicId(id, 'billingInvoice');
    if (!uuid) throw badUserInput(`Invalid billingInvoice id: ${id.slice(0, 64)}`);
    const result = await this.billing.pay(tenant, uuid);
    return Object.assign(new BillingInvoicePayPayload(), {
      checkoutUrl: result.ok ? result.value.url : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

/** Owners and managers see what the shop pays; apps with read_settings too. */
function managing(tenant: TenantContext): void {
  if (tenant.actor.kind === 'staff' && !['owner', 'manager'].includes(tenant.actor.role)) {
    throw deniedToRole('Access denied. Only owners and managers see what the shop pays Hatti.');
  }
}

/** The owner alone chooses the plan and pays for it: never other staff, nor apps. */
function owner(tenant: TenantContext): void {
  if (tenant.actor.kind !== 'staff' || tenant.actor.role !== 'owner') {
    throw deniedToRole("Access denied. Only the shop's owner chooses its plan and pays Hatti.");
  }
}

function rupees(amount: bigint): Money {
  return Money.from(money(amount, BILLING_CURRENCY));
}

function toPlan(plan: Plan): BillingPlan {
  return Object.assign(new BillingPlan(), {
    code: plan.code.toUpperCase() as BillingPlanCode,
    name: plan.name,
    monthlyPrice: rupees(plan.prices.monthly),
    yearlyPrice: rupees(plan.prices.yearly),
    staffLimit: plan.staff,
    locationLimit: plan.locations,
    orderLimit: plan.ordersPerMonth,
  });
}

function toInvoice(record: InvoiceRecord): BillingInvoice {
  return Object.assign(new BillingInvoice(), {
    id: toPublicId('billingInvoice', record.id),
    name: record.name,
    reason: record.reason.toUpperCase() as BillingInvoiceReason,
    plan: toPlan(record.plan),
    interval: record.interval.toUpperCase() as BillingInterval,
    price: rupees(record.price),
    credit: rupees(record.credit),
    amount: rupees(record.amount),
    status: record.status.toUpperCase() as BillingInvoiceStatus,
    reference: record.reference,
    paidAt: record.paidAt,
    createdAt: record.createdAt,
  });
}

function toSubscription(record: SubscriptionRecord): BillingSubscription {
  return Object.assign(new BillingSubscription(), {
    plan: toPlan(record.plan),
    interval: record.interval && (record.interval.toUpperCase() as BillingInterval),
    periodStart: record.periodStart,
    periodEnd: record.periodEnd,
    pastDue: record.pastDue,
    nextPlan: record.nextPlan && toPlan(record.nextPlan),
    nextInterval: record.nextInterval && (record.nextInterval.toUpperCase() as BillingInterval),
    openInvoice: record.openInvoice && toInvoice(record.openInvoice),
  });
}
