import {
  CurrentTenant,
  Loaders,
  Money,
  RequestLoaders,
  RequireRecentAuthentication,
  RequireScopes,
  UserError,
  badUserInput,
  deniedToRole,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import type { MessageChannelEnum } from '@hatti/messaging/public';
import { money } from '@hatti/money';
import { Args, ID, Int, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import {
  BillingService,
  type HattiBankAccount,
  type InvoiceRecord,
  type InvoiceTransferRecord,
  type MessagePriceRecord,
  type SubscriptionRecord,
  type WalletRecord,
} from '../billing.service.js';
import type { WalletEntryRecord } from '../credits.js';
import { BILLING_CURRENCY, type Plan } from '../plans.js';
import {
  BillingBankAccount,
  BillingCreditsBuyInput,
  BillingCreditsBuyPayload,
  BillingInterval,
  BillingInvoice,
  BillingInvoicePayPayload,
  BillingInvoiceReason,
  BillingInvoiceStatus,
  BillingInvoiceTransfer,
  BillingInvoiceTransferReportPayload,
  BillingMessagePrice,
  BillingPlan,
  BillingPlanChangeInput,
  BillingPlanChangePayload,
  BillingPlanCode,
  BillingSubscription,
  BillingTransferStatus,
  BillingWallet,
  BillingWalletEntry,
  BillingWalletEntryKind,
  MessageCategory,
} from './billing.types.js';

/**
 * What the shop pays Hatti (BIL-01, BIL-03, ADR-154, ADR-155): the plans, its plan, its invoices
 * and the credit its messages are paid from, which owners and managers see and apps with
 * read_settings; the owner alone chooses a plan or credit and pays, having signed in lately, as
 * it spends the shop's money. The owner says, too, what they paid by transfer into Hatti's account
 * (ADR-254), which Hatti's people then find.
 */
@Resolver(() => BillingInvoice)
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

  @Query(() => BillingBankAccount, {
    nullable: true,
    description:
      "Hatti's own bank account, which invoices are paid into by transfer or Raast, writing the " +
      "invoice's name as the transfer's purpose; null where none is set up. Staff need to be " +
      'the owner or a manager.',
  })
  @RequireScopes('read_settings')
  billingBankAccount(@CurrentTenant() tenant: TenantContext): BillingBankAccount | null {
    managing(tenant);
    const account = this.billing.bankAccount();
    return account && toBankAccount(account);
  }

  @Query(() => BillingWallet, {
    description:
      "The credit the shop's messages are paid from. Staff need to be the owner or a manager.",
  })
  @RequireScopes('read_settings')
  async billingWallet(@CurrentTenant() tenant: TenantContext): Promise<BillingWallet> {
    managing(tenant);
    return toWallet(await this.billing.walletOf(tenant.shopId));
  }

  @Query(() => [BillingWalletEntry], {
    description: "What changed the shop's message credit, the newest first, 100 at most.",
  })
  @RequireScopes('read_settings')
  async billingWalletEntries(
    @CurrentTenant() tenant: TenantContext,
    @Args('first', { type: () => Int, defaultValue: 20 }) first: number,
  ): Promise<BillingWalletEntry[]> {
    managing(tenant);
    return (await this.billing.walletEntriesOf(tenant.shopId, first)).map(toWalletEntry);
  }

  @Query(() => [BillingMessagePrice], {
    description: 'What each message costs the shop, from its credit, by channel and category.',
  })
  @RequireScopes('read_settings')
  billingMessagePrices(): BillingMessagePrice[] {
    return this.billing.messagePrices().map(toMessagePrice);
  }

  @Mutation(() => BillingCreditsBuyPayload, {
    description:
      "Chooses credit to buy for the shop's messages: an invoice, paid with billingInvoicePay, " +
      "whose credit is the shop's once paid. Credit chosen before and not paid for gives way to " +
      'it. The owner alone, having signed in lately.',
  })
  @RequireScopes('write_settings')
  @RequireRecentAuthentication()
  async billingCreditsBuy(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: BillingCreditsBuyInput,
  ): Promise<BillingCreditsBuyPayload> {
    owner(tenant);
    const result = await this.billing.buyCredits(tenant, { amount: input.amount });
    return Object.assign(new BillingCreditsBuyPayload(), {
      invoice: result.ok ? toInvoice(result.value.invoice) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
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

  @Mutation(() => BillingInvoiceTransferReportPayload, {
    description:
      "Says an open invoice was paid by transfer or Raast into Hatti's account (billingBankAccount), " +
      "with the reference the bank or Raast gave the transfer: Hatti's people find it there, and " +
      'confirm it, which pays the invoice, or refuse it, saying why. An invoice waits on one ' +
      'transfer at a time, and a reference is given once. The owner alone.',
  })
  @RequireScopes('write_settings')
  async billingInvoiceTransferReport(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('reference', {
      description:
        'As the bank or Raast wrote it: 4 to 64 letters, numbers, spaces, dots, ' +
        'slashes and dashes.',
    })
    reference: string,
  ): Promise<BillingInvoiceTransferReportPayload> {
    owner(tenant);
    const uuid = tryFromPublicId(id, 'billingInvoice');
    if (!uuid) throw badUserInput(`Invalid billingInvoice id: ${id.slice(0, 64)}`);
    const result = await this.billing.reportTransfer(tenant, uuid, { reference });
    return Object.assign(new BillingInvoiceTransferReportPayload(), {
      transfer: result.ok ? toTransfer(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @ResolveField(() => [BillingInvoiceTransfer], {
    description:
      "The transfers the owner said they made for it, into Hatti's account, the latest first.",
  })
  async transfers(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() invoice: BillingInvoice,
  ): Promise<BillingInvoiceTransfer[]> {
    const loader = loaders.get<string, InvoiceTransferRecord[]>('billing.transfers', (ids) =>
      this.billing.transfersOf(tenant.shopId, ids),
    );
    return ((await loader.load(invoice.uuid)) ?? []).map(toTransfer);
  }
}

/** Owners and managers see what the shop pays; apps with read_settings too. */
function managing(tenant: TenantContext): void {
  if (tenant.actor.kind === 'staff' && !['owner', 'manager'].includes(tenant.actor.role)) {
    throw deniedToRole('Access denied. Only owners and managers see what the shop pays Hatti.');
  }
}

/** The owner alone chooses the plan or credit and pays for it: never other staff, nor apps. */
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
    plan: record.plan && toPlan(record.plan),
    interval: record.interval && (record.interval.toUpperCase() as BillingInterval),
    price: rupees(record.price),
    credit: rupees(record.credit),
    amount: rupees(record.amount),
    status: record.status.toUpperCase() as BillingInvoiceStatus,
    reference: record.reference,
    paidAt: record.paidAt,
    createdAt: record.createdAt,
    uuid: record.id,
  });
}

function toBankAccount(account: HattiBankAccount): BillingBankAccount {
  return Object.assign(new BillingBankAccount(), {
    title: account.title,
    bankName: account.bankName,
    iban: account.iban,
    raastId: account.raastId,
  });
}

function toTransfer(record: InvoiceTransferRecord): BillingInvoiceTransfer {
  return Object.assign(new BillingInvoiceTransfer(), {
    id: toPublicId('billingTransfer', record.id),
    reference: record.reference,
    amount: rupees(record.amount),
    status: record.status.toUpperCase() as BillingTransferStatus,
    received: record.received === null ? null : rupees(record.received),
    refusal: record.refusal,
    reportedAt: record.reportedAt,
    checkedAt: record.checkedAt,
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

function toWallet(record: WalletRecord): BillingWallet {
  return Object.assign(new BillingWallet(), {
    balance: rupees(record.balance),
    openInvoice: record.openInvoice && toInvoice(record.openInvoice),
  });
}

function toWalletEntry(record: WalletEntryRecord): BillingWalletEntry {
  return Object.assign(new BillingWalletEntry(), {
    id: toPublicId('billingWalletEntry', record.id),
    kind: record.kind.toUpperCase() as BillingWalletEntryKind,
    amount: rupees(record.amount),
    balance: rupees(record.balance),
    invoiceId: record.invoiceId && toPublicId('billingInvoice', record.invoiceId),
    messageId: record.messageId && toPublicId('message', record.messageId),
    channel: record.cost && (record.cost.channel.toUpperCase() as MessageChannelEnum),
    category: record.cost && (record.cost.category.toUpperCase() as MessageCategory),
    parts: record.cost?.parts ?? null,
    note: record.note,
    createdAt: record.createdAt,
  });
}

function toMessagePrice(record: MessagePriceRecord): BillingMessagePrice {
  return Object.assign(new BillingMessagePrice(), {
    channel: record.channel.toUpperCase() as MessageChannelEnum,
    category: record.category.toUpperCase() as MessageCategory,
    price: rupees(record.price),
  });
}
