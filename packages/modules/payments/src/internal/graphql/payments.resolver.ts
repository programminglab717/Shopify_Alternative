import {
  CurrentTenant,
  Money,
  RequireRecentAuthentication,
  RequireScopes,
  UserError,
  badUserInput,
  deniedToRole,
  type MutationResult,
  type StaffRole,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId, type IdKind } from '@hatti/ids';
import { money } from '@hatti/money';
import { Inject } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  GatewayAccountService,
  PAYMENT_GATEWAYS,
  type GatewayAccountInput,
  type GatewayAccountRecord,
} from '../gateway-accounts.service.js';
import type { GatewayEnvironmentValue, PaymentGateways } from '../gateways.js';
import {
  OnlinePaymentService,
  type PaymentRefundRecord,
  type PaymentSessionRecord,
} from '../online-payment.service.js';
import {
  PaymentConfirmation,
  PaymentGateway,
  PaymentGatewayAccount,
  PaymentGatewayAccountInput,
  PaymentGatewayAccountPayload,
  PaymentGatewayAccountsReorderPayload,
  PaymentGatewayEnvironment,
  PaymentGatewayRefunds,
  PaymentRefund,
  PaymentRefundSettleInput,
  PaymentRefundSettlePayload,
  PaymentRefundStatus,
  PaymentSession,
  PaymentSessionStatus,
} from './payments.types.js';

/** Staff who settle refunds: those who refund orders, owners and managers. */
const REFUND_ROLES: readonly StaffRole[] = ['owner', 'manager'];

/**
 * Payment gateways, the shop's accounts with them, and its orders' payments online (PAY-01,
 * PAY-04, ADR-151). Accounts are shop settings, and change where customers' money goes: owners
 * and managers connect them, having signed in lately, and apps with write_settings.
 */
@Resolver(() => PaymentGatewayAccount)
export class PaymentsResolver {
  constructor(
    private readonly accounts: GatewayAccountService,
    private readonly payments: OnlinePaymentService,
    @Inject(PAYMENT_GATEWAYS) private readonly catalog: PaymentGateways,
  ) {}

  @Query(() => [PaymentGateway], {
    description: 'The payment gateways shops take payments online through here.',
  })
  @RequireScopes('read_settings')
  paymentGateways(): PaymentGateway[] {
    return this.catalog.list.map((info) =>
      Object.assign(new PaymentGateway(), {
        gateway: info.gateway,
        name: info.name,
        credentials: info.credentials.map((field) => ({ key: field.key, label: field.label })),
        currencies: [...info.currencies],
        test: info.test,
        refunds: info.refunds.toUpperCase() as PaymentGatewayRefunds,
      }),
    );
  }

  @Query(() => [PaymentGatewayAccount], {
    description:
      "The shop's payment gateway accounts, in the order its customers are offered them, as " +
      "paymentGatewayAccountsReorder puts them; archived ones after them, if asked. Orders' " +
      'pages and checkout offer each live one, for customers to choose among (ADR-219).',
  })
  @RequireScopes('read_settings')
  async paymentGatewayAccounts(
    @CurrentTenant() tenant: TenantContext,
    @Args('archived', { type: () => Boolean, nullable: true }) archived?: boolean | null,
  ): Promise<PaymentGatewayAccount[]> {
    const records = await this.accounts.list(tenant, { archived: archived ?? false });
    return records.map(toAccount);
  }

  @Mutation(() => PaymentGatewayAccountPayload, {
    description:
      "Connects the shop's own account with a payment gateway, with the credentials its " +
      'dashboard gives, kept sealed and never shown again: orders waiting for their money ' +
      "offer to take it online through it, on their pages. Add the account's webhookUrl in the " +
      "gateway's dashboard. One live account a gateway.",
  })
  @RequireScopes('write_settings')
  @RequireRecentAuthentication()
  async paymentGatewayAccountConnect(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: PaymentGatewayAccountInput,
  ): Promise<PaymentGatewayAccountPayload> {
    return accountPayload(await this.accounts.connect(tenant, toInput(input)));
  }

  @Mutation(() => PaymentGatewayAccountPayload, {
    description:
      'Changes a payment gateway account: its credentials, or its environment with new ones.',
  })
  @RequireScopes('write_settings')
  @RequireRecentAuthentication()
  async paymentGatewayAccountUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: PaymentGatewayAccountInput,
  ): Promise<PaymentGatewayAccountPayload> {
    return accountPayload(
      await this.accounts.update(tenant, uuidOf('paymentGatewayAccount', id), toInput(input)),
    );
  }

  @Mutation(() => PaymentGatewayAccountPayload, {
    description:
      'Archives a payment gateway account: no new payments through it. Payments customers ' +
      'started through it still count once the gateway says they are made.',
  })
  @RequireScopes('write_settings')
  async paymentGatewayAccountArchive(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<PaymentGatewayAccountPayload> {
    return accountPayload(await this.accounts.archive(tenant, uuidOf('paymentGatewayAccount', id)));
  }

  @Mutation(() => PaymentGatewayAccountsReorderPayload, {
    description:
      "Puts the shop's live payment gateway accounts in the order its customers are offered " +
      "them, on orders' pages and checkout's thank-you page (PAY-05, ADR-221): ids lists each " +
      'of them once, the first offered first. An account connected later goes last.',
  })
  @RequireScopes('write_settings')
  async paymentGatewayAccountsReorder(
    @CurrentTenant() tenant: TenantContext,
    @Args('ids', { type: () => [ID] }) ids: string[],
  ): Promise<PaymentGatewayAccountsReorderPayload> {
    const result = await this.accounts.reorder(
      tenant,
      ids.map((id) => uuidOf('paymentGatewayAccount', id)),
    );
    return Object.assign(new PaymentGatewayAccountsReorderPayload(), {
      paymentGatewayAccounts: result.ok ? result.value.map(toAccount) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Query(() => [PaymentSession], {
    description:
      "The payments an order's customer started online from its page, the latest first: " +
      'which are paid, how Hatti heard, and what of each was paid on the order.',
  })
  @RequireScopes('read_orders')
  async paymentSessions(
    @CurrentTenant() tenant: TenantContext,
    @Args('orderId', { type: () => ID }) orderId: string,
  ): Promise<PaymentSession[]> {
    const records = await this.payments.sessionsOf(tenant.shopId, uuidOf('order', orderId));
    return records.map(toSession);
  }

  @Mutation(() => PaymentRefundSettlePayload, {
    description:
      'Settles a refund through the gateway whose answer never came (UNKNOWN, or PENDING past ' +
      "a few minutes), as the gateway's dashboard shows it: given back, which records the " +
      "order's refund, or not, which frees what it held. Staff need to be an owner or a manager.",
  })
  @RequireScopes('write_orders')
  async paymentRefundSettle(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: PaymentRefundSettleInput,
  ): Promise<PaymentRefundSettlePayload> {
    if (tenant.actor.kind === 'staff' && !REFUND_ROLES.includes(tenant.actor.role)) {
      throw deniedToRole('Access denied. Only owners and managers refund orders.');
    }
    const result = await this.payments.settleRefund(tenant, uuidOf('paymentRefund', id), input);
    return Object.assign(new PaymentRefundSettlePayload(), {
      paymentRefund: result.ok ? toRefund(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function uuidOf(kind: IdKind, id: string): string {
  const uuid = tryFromPublicId(id, kind);
  if (!uuid) throw badUserInput(`Invalid ${kind} id: ${id.slice(0, 64)}`);
  return uuid;
}

function toInput(input: PaymentGatewayAccountInput): GatewayAccountInput {
  return {
    gateway: input.gateway,
    environment: input.environment
      ? (input.environment.toLowerCase() as GatewayEnvironmentValue)
      : input.environment,
    credentials: input.credentials,
  };
}

function accountPayload(
  result: MutationResult<GatewayAccountRecord>,
): PaymentGatewayAccountPayload {
  return Object.assign(new PaymentGatewayAccountPayload(), {
    paymentGatewayAccount: result.ok ? toAccount(result.value) : null,
    userErrors: result.ok ? [] : UserError.list(result.errors),
  });
}

function toAccount(record: GatewayAccountRecord): PaymentGatewayAccount {
  return Object.assign(new PaymentGatewayAccount(), {
    ...record,
    id: toPublicId('paymentGatewayAccount', record.id),
    environment: record.environment.toUpperCase() as PaymentGatewayEnvironment,
  });
}

function toSession(record: PaymentSessionRecord): PaymentSession {
  const amount = (value: bigint | null) =>
    value === null ? null : Money.from(money(value, record.currency));
  return Object.assign(new PaymentSession(), {
    id: toPublicId('paymentSession', record.id),
    orderId: toPublicId('order', record.orderId),
    accountId: toPublicId('paymentGatewayAccount', record.accountId),
    gatewayName: record.gatewayName,
    environment: record.environment.toUpperCase() as PaymentGatewayEnvironment,
    amount: amount(record.amount)!,
    status: record.status.toUpperCase() as PaymentSessionStatus,
    gatewayRef: record.gatewayRef,
    paidAmount: amount(record.paidAmount),
    applied: amount(record.applied),
    reference: record.reference,
    paidThrough: record.paidThrough && (record.paidThrough.toUpperCase() as PaymentConfirmation),
    paidAt: record.paidAt,
    error: record.error,
    refunds: record.refunds.map(toRefund),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function toRefund(record: PaymentRefundRecord): PaymentRefund {
  return Object.assign(new PaymentRefund(), {
    id: toPublicId('paymentRefund', record.id),
    amount: Money.from(money(record.amount, record.currency)),
    status: record.status.toUpperCase() as PaymentRefundStatus,
    reference: record.reference,
    refundId: record.refundId && toPublicId('refund', record.refundId),
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}
