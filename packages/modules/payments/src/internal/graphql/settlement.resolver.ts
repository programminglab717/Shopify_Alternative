import {
  CurrentTenant,
  Money,
  RequireScopes,
  UserError,
  accessDenied,
  deniedToRole,
  hasCapability,
  hasScope,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { money, type CurrencyCode } from '@hatti/money';
import { Inject } from '@nestjs/common';
import { Args, ID, Int, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { GatewayAccountService, PAYMENT_GATEWAYS } from '../gateway-accounts.service.js';
import type { PaymentGateways } from '../gateways.js';
import {
  PaymentSettlementService,
  type SettlementLineRecord,
  type SettlementRecord,
} from '../settlements.service.js';
import {
  PaymentSettlement,
  PaymentSettlementAccount,
  PaymentSettlementImportPayload,
  PaymentSettlementLine,
  PaymentSettlementOutcome,
  PaymentSettlementOutcomeCounts,
  PaymentSettlementRowError,
} from './settlement.types.js';

/**
 * Staff who reconcile what the shop is paid: owners, managers and accountants, as for couriers'
 * remittances (ADR-067), and custom roles of theirs that keep it (ADR-578). Apps need
 * write_orders to import, and read_orders to read.
 */
function mayReconcile(tenant: TenantContext, writing: boolean): void {
  if (tenant.actor.kind === 'staff') {
    if (!hasCapability(tenant.actor, 'reconcile_payments')) {
      throw deniedToRole(
        "Access denied. Only owners, managers and accountants reconcile gateways' settlements.",
      );
    }
  } else if (writing && !hasScope(tenant, 'write_orders')) {
    throw accessDenied(['write_orders']);
  }
}

function amount(minor: bigint, currency: CurrencyCode): Money {
  return Money.from(money(minor, currency));
}

function toSettlement(record: SettlementRecord, currency: CurrencyCode): PaymentSettlement {
  return Object.assign(new PaymentSettlement(), {
    id: toPublicId('paymentSettlement', record.id),
    accountId: toPublicId('paymentGatewayAccount', record.accountId),
    gateway: record.gateway,
    reference: record.reference,
    lineCount: record.lineCount,
    issueCount: record.issueCount,
    gross: amount(record.gross, currency),
    fees: amount(record.fees, currency),
    tax: amount(record.tax, currency),
    net: amount(record.net, currency),
    createdAt: record.createdAt,
  });
}

function toLine(line: SettlementLineRecord, currency: CurrencyCode): PaymentSettlementLine {
  return Object.assign(new PaymentSettlementLine(), {
    row: line.row,
    transactionRef: line.transactionRef,
    orderId: line.orderId && toPublicId('order', line.orderId),
    outcome: line.outcome as PaymentSettlementOutcome,
    gross: amount(line.gross, currency),
    fees: amount(line.fees, currency),
    tax: amount(line.tax, currency),
    paid: line.paid === null ? null : amount(line.paid, currency),
  });
}

/** Gateways' settlement statements (PAY-07, ADR-491). */
@Resolver(() => PaymentSettlement)
export class PaymentSettlementResolver {
  constructor(
    private readonly service: PaymentSettlementService,
    private readonly accounts: GatewayAccountService,
    @Inject(PAYMENT_GATEWAYS) private readonly catalog: PaymentGateways,
  ) {}

  @Query(() => [PaymentSettlementAccount], {
    description:
      "The shop's live gateway accounts, whose settlements it imports, for those who reconcile " +
      'them; paymentGatewayAccounts is for those who see the settings.',
  })
  @RequireScopes('read_orders')
  async paymentSettlementAccounts(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<PaymentSettlementAccount[]> {
    mayReconcile(tenant, false);
    return (await this.accounts.list(tenant)).map((account) =>
      Object.assign(new PaymentSettlementAccount(), {
        id: toPublicId('paymentGatewayAccount', account.id),
        gateway: account.gateway,
        gatewayName: account.gatewayName,
        sandbox: account.environment !== 'production',
      }),
    );
  }

  @Mutation(() => PaymentSettlementImportPayload, {
    description:
      "Imports a gateway's settlement statement, as the CSV or Excel workbook the gateway " +
      'sends: a row per payment, found by its reference ("Transaction ID", "Txn Ref", ' +
      '"Tracker" and the like), with what the customer paid ("Amount"), and the fees, tax ' +
      'withheld and net amount when it has them, under a header row title rows may come above. ' +
      "Each line is matched to the account's payment by the gateway's reference for it, and " +
      'its fees and tax kept beside it; lines that match none, or a payment settled before, or ' +
      'for another amount, are kept to look into. A statement with the same reference from the ' +
      'account again is refused. Staff need to be an owner, a manager or an accountant.',
  })
  @RequireScopes('read_orders')
  async paymentSettlementImport(
    @CurrentTenant() tenant: TenantContext,
    @Args('accountId', { type: () => ID }) accountId: string,
    @Args('csv', { type: () => String, nullable: true }) csv?: string | null,
    @Args('xlsx', {
      type: () => String,
      nullable: true,
      description: 'The statement as an Excel workbook (.xlsx), in base64; or csv.',
    })
    xlsx?: string | null,
    @Args('reference', {
      type: () => String,
      nullable: true,
      description: "The settlement's number or the payout's reference.",
    })
    reference?: string | null,
    @Args('dryRun', { type: () => Boolean, nullable: true }) dryRun?: boolean | null,
  ): Promise<PaymentSettlementImportPayload> {
    mayReconcile(tenant, true);
    const account = tryFromPublicId(accountId, 'paymentGatewayAccount');
    const result = account
      ? await this.service.import(tenant, {
          accountId: account,
          csv,
          xlsx,
          reference,
          dryRun: dryRun ?? false,
        })
      : {
          ok: false as const,
          errors: [
            {
              field: ['accountId'],
              code: 'NOT_FOUND' as const,
              message: 'No gateway account of the shop has this ID',
            },
          ],
        };
    const currency = tenant.currency;
    const counts = (outcomes: Partial<Record<string, number>>) =>
      Object.assign(new PaymentSettlementOutcomeCounts(), {
        matched: outcomes.matched ?? 0,
        differs: outcomes.differs ?? 0,
        unmatched: outcomes.unmatched ?? 0,
        repeated: outcomes.repeated ?? 0,
        refund: outcomes.refund ?? 0,
      });
    if (!result.ok) {
      return Object.assign(new PaymentSettlementImportPayload(), {
        settlement: null,
        rows: 0,
        outcomes: counts({}),
        gross: amount(0n, currency),
        fees: amount(0n, currency),
        tax: amount(0n, currency),
        net: amount(0n, currency),
        issues: [],
        rowErrors: [],
        rowErrorCount: 0,
        dryRun: dryRun ?? false,
        userErrors: UserError.list(result.errors),
      });
    }
    const value = result.value;
    return Object.assign(new PaymentSettlementImportPayload(), {
      settlement: value.settlement && toSettlement(value.settlement, currency),
      rows: value.rows,
      outcomes: counts(value.outcomes),
      gross: amount(value.gross, currency),
      fees: amount(value.fees, currency),
      tax: amount(value.tax, currency),
      net: amount(value.net, currency),
      issues: value.issues.map((line) => toLine(line, currency)),
      rowErrors: value.rowErrors.map((error) =>
        Object.assign(new PaymentSettlementRowError(), error),
      ),
      rowErrorCount: value.rowErrorCount,
      dryRun: value.dryRun,
      userErrors: [],
    });
  }

  @Query(() => [PaymentSettlement], {
    description: "The gateways' settlements the shop imported, the newest first.",
  })
  @RequireScopes('read_orders')
  async paymentSettlements(
    @CurrentTenant() tenant: TenantContext,
    @Args('first', { type: () => Int, nullable: true, defaultValue: 50 }) first: number,
  ): Promise<PaymentSettlement[]> {
    mayReconcile(tenant, false);
    return (await this.service.list(tenant, first)).map((record) =>
      toSettlement(record, tenant.currency),
    );
  }

  @Query(() => PaymentSettlement, { nullable: true })
  @RequireScopes('read_orders')
  async paymentSettlement(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<PaymentSettlement | null> {
    mayReconcile(tenant, false);
    const settlementId = tryFromPublicId(id, 'paymentSettlement');
    const record = settlementId ? await this.service.get(tenant, settlementId) : null;
    return record && toSettlement(record, tenant.currency);
  }

  @ResolveField(() => String, { description: 'Such as "Safepay".' })
  gatewayName(@Parent() settlement: PaymentSettlement): string {
    return this.catalog.of(settlement.gateway)?.info.name ?? settlement.gateway;
  }

  @ResolveField(() => [PaymentSettlementLine], {
    description: "Its lines in the file's order; those of one outcome, if given.",
  })
  @RequireScopes('read_orders')
  async lines(
    @CurrentTenant() tenant: TenantContext,
    @Parent() settlement: PaymentSettlement,
    @Args('outcome', { type: () => PaymentSettlementOutcome, nullable: true })
    outcome?: PaymentSettlementOutcome | null,
  ): Promise<PaymentSettlementLine[]> {
    const id = tryFromPublicId(settlement.id, 'paymentSettlement')!;
    return (await this.service.lines(tenant, id, outcome ?? null)).map((line) =>
      toLine(line, tenant.currency),
    );
  }
}
