import {
  actorColumnsOf,
  failOne,
  shopProfile,
  type MutationResult,
  type TenantContext,
  type FieldError,
} from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { recordAudit } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  JOURNAL_ACCOUNTS,
  JOURNAL_LIMITS,
  journalFile,
  journalOf,
  ledgersOf,
  type JournalAccount,
  type JournalFile,
  type JournalFormat,
  type JournalLedger,
} from './accounting-journal.js';
import { SALES_REPORT_LIMITS, salesPeriodsIn } from './sales-report.service.js';

// The shop's sales as a journal for its books (ANL-10, ADR-885), and the accounts it posts to.

/** An account as the shop names it, or as Hatti does where it has not. */
export interface JournalAccountLedger extends JournalLedger {
  account: JournalAccount;
  /** Whether the shop named it; else Hatti's usual name and code. */
  named: boolean;
}

@Injectable()
export class AccountingJournalService {
  constructor(private readonly db: Database) {}

  /** Every account the journal posts to, as the shop's books know it. */
  async ledgers(tenant: TenantContext): Promise<JournalAccountLedger[]> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const named = await this.namedIn(tx, tenant.shopId);
      const ledgers = ledgersOf(named);
      const names = new Set(named.map((each) => each.account));
      return JOURNAL_ACCOUNTS.map((account) => ({
        account,
        ...ledgers[account],
        named: names.has(account),
      }));
    });
  }

  /**
   * Names and numbers accounts as the shop's books do; an account given with neither goes back to
   * Hatti's usual name. Each given once; codes and names each one account's.
   */
  async setLedgers(
    tenant: TenantContext,
    input: readonly { account: JournalAccount; code: string; name: string }[],
  ): Promise<MutationResult<JournalAccountLedger[]>> {
    const errors: FieldError[] = [];
    const seen = new Set<string>();
    const given = input.map((each, index) => {
      const code = each.code.trim();
      const name = each.name.replace(/\s+/g, ' ').trim();
      if (seen.has(each.account)) {
        errors.push({
          field: ['accounts', String(index)],
          code: 'TAKEN',
          message: 'Each account is given once',
        });
      }
      seen.add(each.account);
      if ((code === '') !== (name === '')) {
        errors.push({
          field: ['accounts', String(index), code === '' ? 'code' : 'name'],
          code: 'BLANK',
          message: 'An account needs its code and its name, or neither to go back to the usual',
        });
      }
      if (code.length > JOURNAL_LIMITS.code) {
        errors.push({
          field: ['accounts', String(index), 'code'],
          code: 'TOO_LONG',
          message: `A code is at most ${JOURNAL_LIMITS.code} characters`,
        });
      }
      if (name.length > JOURNAL_LIMITS.name) {
        errors.push({
          field: ['accounts', String(index), 'name'],
          code: 'TOO_LONG',
          message: `A name is at most ${JOURNAL_LIMITS.name} characters`,
        });
      }
      return { account: each.account, code, name };
    });
    if (errors.length > 0) return { ok: false, errors };
    return this.db.tenant(tenant.shopId, async (tx) => {
      const named = new Map(
        (await this.namedIn(tx, tenant.shopId)).map((each) => [each.account, each]),
      );
      for (const each of given) {
        if (each.code === '') named.delete(each.account);
        else named.set(each.account, each);
      }
      // Two accounts posted to as one would merge in the shop's books.
      const ledgers = ledgersOf([...named.values()]);
      for (const key of ['code', 'name'] as const) {
        const owners = new Map<string, JournalAccount>();
        for (const account of JOURNAL_ACCOUNTS) {
          const value = ledgers[account][key].toLowerCase();
          const other = owners.get(value);
          if (other) {
            const index = given.findIndex(
              (each) => each.account === account || each.account === other,
            );
            return failOne(
              ['accounts', String(Math.max(index, 0)), key],
              'TAKEN',
              `"${ledgers[account][key]}" is already another account's ${key}`,
            );
          }
          owners.set(value, account);
        }
      }
      for (const each of given) {
        if (each.code === '') {
          await tx.execute(sql`
            DELETE FROM orders.journal_accounts
             WHERE shop_id = ${tenant.shopId} AND account = ${each.account}`);
        } else {
          await tx.execute(sql`
            INSERT INTO orders.journal_accounts (shop_id, account, code, name)
            VALUES (${tenant.shopId}, ${each.account}, ${each.code}, ${each.name})
            ON CONFLICT (shop_id, account)
            DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, updated_at = now()`);
        }
      }
      await recordAudit(tx, tenant.shopId, {
        action: 'journal_accounts.updated',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actorColumnsOf(tenant.actor),
        details: { accounts: given.map((each) => each.account) },
      });
      return {
        ok: true,
        value: JOURNAL_ACCOUNTS.map((account) => ({
          account,
          ...ledgers[account],
          named: named.has(account),
        })),
      };
    });
  }

  /**
   * The journal of the orders placed in a period, an entry a day in the shop's time zone, as a
   * file in `format`; true profit's lines only where `trueProfit` says the plan has them. Each
   * export is recorded in the audit log.
   */
  async export(
    tenant: TenantContext,
    input: { placedFrom: Date; placedBefore: Date; format: JournalFormat },
    trueProfit: boolean,
  ): Promise<MutationResult<JournalFile>> {
    const span = input.placedBefore.getTime() - input.placedFrom.getTime();
    if (span <= 0) {
      return failOne(['placedBefore'], 'INVALID', 'Placed before must be later than placed from');
    }
    if (span > SALES_REPORT_LIMITS.days * 86_400_000) {
      return failOne(
        ['placedBefore'],
        'INVALID',
        `A journal covers at most ${SALES_REPORT_LIMITS.days} days at a time`,
      );
    }
    const { shopId } = tenant;
    return this.db.tenant(shopId, async (tx) => {
      const { timezone } = await shopProfile(tx, shopId);
      const periods = await salesPeriodsIn(tx, shopId, timezone, { ...input, interval: 'day' });
      const entries = journalOf(periods, timezone, trueProfit);
      const ledgers = ledgersOf(await this.namedIn(tx, shopId));
      const day = (at: Date) =>
        new Intl.DateTimeFormat('en-CA', {
          timeZone: timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(at);
      const file = journalFile(
        entries,
        input.format,
        { ledgers, currency: tenant.currency },
        {
          first: day(input.placedFrom),
          last: day(new Date(input.placedBefore.getTime() - 1)),
        },
      );
      await recordAudit(tx, shopId, {
        action: 'journal.exported',
        subjectType: 'shop',
        subjectId: shopId,
        ...actorColumnsOf(tenant.actor),
        details: {
          placedFrom: input.placedFrom.toISOString(),
          placedBefore: input.placedBefore.toISOString(),
          format: input.format.toUpperCase(),
          entries: entries.length,
        },
      });
      return { ok: true, value: file };
    });
  }

  private async namedIn(tx: Tx, shopId: string): Promise<({ account: string } & JournalLedger)[]> {
    const { rows } = await tx.execute<{ account: string; code: string; name: string }>(sql`
      SELECT account, code, name FROM orders.journal_accounts WHERE shop_id = ${shopId}`);
    return rows;
  }
}
