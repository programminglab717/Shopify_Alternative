import {
  CurrentTenant,
  PlanAllowance,
  RequireScopes,
  UserError,
  deniedToRole,
  hasCapability,
  type TenantContext,
} from '@hatti/api';
import { Optional } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import type {
  JournalAccount as JournalAccountValue,
  JournalFormat as JournalFormatValue,
} from '../accounting-journal.js';
import {
  AccountingJournalService,
  type JournalAccountLedger,
} from '../accounting-journal.service.js';
import {
  AccountingJournalExportArgs,
  AccountingJournalExportPayload,
  JournalAccount,
  JournalLedger,
  JournalLedgerInput,
  JournalLedgersSetPayload,
} from './accounting-journal.types.js';
import { OrderExportFile } from './export.types.js';

const ledgerOf = (each: JournalAccountLedger) =>
  Object.assign(new JournalLedger(), {
    account: each.account.toUpperCase() as JournalAccount,
    code: each.code,
    name: each.name,
    named: each.named,
  });

/** Staff who export orders: owners, managers and accountants. */
function exportsOrders(tenant: TenantContext, what: string): void {
  if (tenant.actor.kind === 'staff' && !hasCapability(tenant.actor, 'export_orders')) {
    throw deniedToRole(`Access denied. Only owners, managers and accountants ${what}.`);
  }
}

@Resolver()
export class AccountingJournalResolver {
  constructor(
    private readonly journal: AccountingJournalService,
    @Optional() private readonly allowance?: PlanAllowance,
  ) {}

  @Query(() => [JournalLedger], {
    description:
      "The accounts the shop's journal posts to (ANL-10, ADR-885), as its books know them: " +
      "those it named, the rest by Hatti's usual names and codes.",
  })
  @RequireScopes('read_orders')
  async journalLedgers(@CurrentTenant() tenant: TenantContext): Promise<JournalLedger[]> {
    return (await this.journal.ledgers(tenant)).map(ledgerOf);
  }

  @Mutation(() => JournalLedgersSetPayload, {
    description:
      "Names and numbers the journal's accounts as the shop's books do (ADR-885); an account " +
      "given with a blank code and name goes back to Hatti's usual. Staff need to be an owner, " +
      'a manager or an accountant.',
  })
  @RequireScopes('read_orders')
  async journalLedgersSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('accounts', { type: () => [JournalLedgerInput] }) accounts: JournalLedgerInput[],
  ): Promise<JournalLedgersSetPayload> {
    if (tenant.actor.kind !== 'staff') {
      throw deniedToRole("Access denied. Only the shop's staff name its accounts.");
    }
    exportsOrders(tenant, "name the journal's accounts");
    const result = await this.journal.setLedgers(
      tenant,
      accounts.map((each) => ({
        account: each.account.toLowerCase() as JournalAccountValue,
        code: each.code,
        name: each.name,
      })),
    );
    return Object.assign(new JournalLedgersSetPayload(), {
      journalLedgers: result.ok ? result.value.map(ledgerOf) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => AccountingJournalExportPayload, {
    description:
      "The shop's sales as a journal of debits and credits for its books (ANL-10, ADR-885): an " +
      "entry for each day of the period in the shop's time zone, posting what its orders came " +
      'to as salesReport has it, for Xero, QuickBooks or Tally to import, or as a CSV. True ' +
      "profit's lines on the plans that have them. Staff need to be an owner, a manager or an " +
      'accountant. Every export is recorded in the audit log.',
  })
  @RequireScopes('read_orders')
  async accountingJournalExport(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: AccountingJournalExportArgs,
  ): Promise<AccountingJournalExportPayload> {
    exportsOrders(tenant, 'export the journal');
    const trueProfit = !(await this.allowance?.excludes(tenant.shopId, 'trueProfit'));
    const result = await this.journal.export(
      tenant,
      {
        placedFrom: args.placedFrom,
        placedBefore: args.placedBefore,
        format: args.format.toLowerCase() as JournalFormatValue,
      },
      trueProfit,
    );
    return Object.assign(new AccountingJournalExportPayload(), {
      file: result.ok
        ? Object.assign(new OrderExportFile(), {
            filename: result.value.filename,
            contentType: result.value.contentType,
            content: result.value.content.toString('base64'),
          })
        : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
