// Store credit (ORD-09, ADR-184): what a shop owes a customer to spend with it, in place of money
// given back. A customer has an account in each currency they hold credit in, as Shopify's
// StoreCreditAccount, whose ledger keeps every credit, debit, debit given back and expiry in the
// order they were made, each written holding the account's lock. A debit spends the credits that
// expire soonest first and keeps which it took from, so that one given back returns to them. The
// balance is what the credits have left that has not expired, worked out when asked.

import {
  InputChecker,
  actorColumnsOf,
  failOne,
  type Actor,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, exactTime, toDate, toDateOrNull, type Tx } from '@hatti/db';
import { recordAudit } from '@hatti/events';
import { newId, toPublicId } from '@hatti/ids';
import { formatMoney, fromMajor, money, toMajorString, type CurrencyCode } from '@hatti/money';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Page } from './records.js';

export const STORE_CREDIT_KINDS = ['credit', 'debit', 'debit_revert', 'expiration'] as const;
export type StoreCreditKindValue = (typeof STORE_CREDIT_KINDS)[number];

/** Why a transaction was made, as Shopify's StoreCreditSystemEvent. */
export const STORE_CREDIT_EVENTS = [
  'adjustment',
  'order_refund',
  'order_payment',
  'order_cancellation',
] as const;
export type StoreCreditEventValue = (typeof STORE_CREDIT_EVENTS)[number];

export const STORE_CREDIT_LIMITS = {
  /** The most an account holds, in its currency's major units: Rs 1,000,000. */
  balance: 1_000_000,
  note: 500,
  /** Accounts' credits the worker expires in one sweep. */
  sweep: 100,
} as const;

export interface StoreCreditAccountRecord {
  id: string;
  customerId: string;
  currency: CurrencyCode;
  /** Minor units: what its credits have left that has not expired. */
  balance: bigint;
  createdAt: Date;
}

export interface StoreCreditTransactionRecord {
  id: string;
  accountId: string;
  kind: StoreCreditKindValue;
  /** Null for an expiration, which its kind says. */
  event: StoreCreditEventValue | null;
  /** Minor units, signed: what it added to the balance, or took from it. */
  amount: bigint;
  /** The account's balance once it was made, as the ledger counts it. */
  balanceAfter: bigint;
  /** A credit's: when it expires; null when it never does. */
  expiresAt: Date | null;
  /** A credit's: what is left of it to spend; null for the other kinds. */
  remaining: bigint | null;
  orderId: string | null;
  refundId: string | null;
  note: string;
  createdAt: Date;
  /** Where it sorts, to the microsecond, for the page after it. */
  at: string;
}

/** An account and the transaction that just changed it. */
export interface StoreCreditChange {
  account: StoreCreditAccountRecord;
  transaction: StoreCreditTransactionRecord;
}

/** Whose credit: an account, or a customer, whose account in the currency is used or opened. */
export type StoreCreditOwner = { accountId: string } | { customerId: string };

/** Credit or debit by hand, as storeCreditAccountCredit and storeCreditAccountDebit take it. */
export interface StoreCreditInput {
  /** In major units, like "2500" or "2499.50". */
  amount: string;
  currencyCode: string;
  /** A credit's expiry; never, unless given. */
  expiresAt?: Date | null;
  note?: string | null;
}

/**
 * Credit another module gives in its own transaction, such as a refund given as store credit.
 * The customer must exist.
 */
export interface StoreCreditGrant {
  customerId: string;
  currency: CurrencyCode;
  amount: bigint;
  event: StoreCreditEventValue;
  expiresAt?: Date | null;
  orderId?: string | null;
  refundId?: string | null;
  note?: string;
  /** The transaction's ID, when the caller names it first, as a refund does in its reference. */
  id?: string;
}

type AccountRow = {
  id: string;
  customer_id: string;
  currency: CurrencyCode;
  created_at: string | Date;
};

type TransactionRow = {
  id: string;
  account_id: string;
  kind: StoreCreditKindValue;
  event: StoreCreditEventValue | null;
  amount: string;
  balance_after: string;
  expires_at: string | Date | null;
  remaining: string | null;
  order_id: string | null;
  refund_id: string | null;
  note: string;
  created_at: string | Date;
  at_exactly: string;
};

/** What a transaction does to the balance: credits and debits given back add to it. */
const SIGNED = sql.raw("CASE WHEN kind IN ('credit', 'debit_revert') THEN amount ELSE -amount END");

@Injectable()
export class StoreCreditService {
  constructor(private readonly db: Database) {}

  /** A customer's accounts, the oldest first: one for each currency they have had credit in. */
  async accountsOf(
    tenant: TenantContext,
    customerId: string,
    at: Date = new Date(),
  ): Promise<StoreCreditAccountRecord[]> {
    return this.db.tenant(tenant.shopId, (tx) => accountsIn(tx, tenant.shopId, { customerId }, at));
  }

  async account(
    tenant: TenantContext,
    id: string,
    at: Date = new Date(),
  ): Promise<StoreCreditAccountRecord | null> {
    const [account] = await this.db.tenant(tenant.shopId, (tx) =>
      accountsIn(tx, tenant.shopId, { ids: [id] }, at),
    );
    return account ?? null;
  }

  /** An account's ledger, the newest first, each with the balance it left. */
  async transactions(
    tenant: TenantContext,
    accountId: string,
    options: { first: number; after?: { at: string; id: string } | null },
  ): Promise<Page<StoreCreditTransactionRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await ledgerIn(tx, tenant.shopId, accountId, {
        before: options.after ?? null,
        limit: options.first + 1,
      });
      return {
        items: rows.slice(0, options.first).map(toTransaction),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  /**
   * Credits an account by hand, as Shopify's storeCreditAccountCredit: `owner` is an account, or
   * a customer, whose account in the shop's currency is opened if they have none. Audited.
   */
  async credit(
    tenant: TenantContext,
    owner: StoreCreditOwner,
    input: StoreCreditInput,
    at: Date = new Date(),
  ): Promise<MutationResult<StoreCreditChange>> {
    const field = ['creditInput'];
    const checked = checkInput(tenant, field, 'creditAmount', input, at);
    if (!checked.ok) return checked;
    const { amount, note } = checked.value;
    const expiresAt = input.expiresAt ?? null;
    const { shopId } = tenant;
    return this.db.tenant(shopId, async (tx) => {
      const account =
        'accountId' in owner
          ? await lockAccount(tx, shopId, owner.accountId)
          : await openAccount(tx, shopId, owner.customerId, tenant.currency);
      if (!account) return notFound(owner);
      if (account.currency !== tenant.currency) return otherCurrency(account);
      const credited = await creditIn(tx, shopId, tenant.actor, account, {
        amount,
        event: 'adjustment',
        expiresAt,
        note,
        field: [...field, 'creditAmount', 'amount'],
        at,
      });
      if (!credited.ok) return credited;
      await recordAudit(tx, shopId, {
        action: 'customer.store_credit_credited',
        subjectType: 'customer',
        subjectId: account.customer_id,
        ...actorColumnsOf(tenant.actor),
        details: {
          account: toPublicId('storeCreditAccount', account.id),
          transaction: toPublicId('storeCreditTransaction', credited.value),
          amount: toMajorString(money(amount, account.currency)),
          expiresAt: expiresAt?.toISOString() ?? null,
        },
      });
      return { ok: true, value: await changeIn(tx, shopId, account.id, credited.value, at) };
    });
  }

  /**
   * Debits an account by hand, as Shopify's storeCreditAccountDebit, such as when its credit is
   * given back in cash: the credits that expire soonest first. Audited.
   */
  async debit(
    tenant: TenantContext,
    owner: StoreCreditOwner,
    input: StoreCreditInput,
    at: Date = new Date(),
  ): Promise<MutationResult<StoreCreditChange>> {
    const field = ['debitInput'];
    const checked = checkInput(tenant, field, 'debitAmount', input, at);
    if (!checked.ok) return checked;
    const { amount, note } = checked.value;
    const { shopId } = tenant;
    return this.db.tenant(shopId, async (tx) => {
      const account =
        'accountId' in owner
          ? await lockAccount(tx, shopId, owner.accountId)
          : await lockAccountOf(tx, shopId, owner.customerId, tenant.currency);
      if (!account) {
        return 'accountId' in owner
          ? notFound(owner)
          : failOne<StoreCreditChange>(
              [...field, 'debitAmount', 'amount'],
              'INSUFFICIENT_FUNDS',
              'This customer has no store credit',
            );
      }
      if (account.currency !== tenant.currency) return otherCurrency(account);
      const debited = await debitIn(tx, shopId, tenant.actor, account, {
        amount,
        event: 'adjustment',
        orderId: null,
        note,
        field: [...field, 'debitAmount', 'amount'],
        at,
      });
      if (!debited.ok) return debited;
      await recordAudit(tx, shopId, {
        action: 'customer.store_credit_debited',
        subjectType: 'customer',
        subjectId: account.customer_id,
        ...actorColumnsOf(tenant.actor),
        details: {
          account: toPublicId('storeCreditAccount', account.id),
          transaction: toPublicId('storeCreditTransaction', debited.value),
          amount: toMajorString(money(amount, account.currency)),
        },
      });
      return { ok: true, value: await changeIn(tx, shopId, account.id, debited.value, at) };
    });
  }

  /**
   * Credits a customer in the caller's transaction, as a refund given as store credit does: their
   * account in the currency opened if they have none. The transaction's ID, or why it can't be:
   * more than an account holds, under `field`.
   */
  async creditIn(
    tx: Tx,
    tenant: { shopId: string; actor: Actor },
    grant: StoreCreditGrant,
    field: string[],
    at: Date = new Date(),
  ): Promise<MutationResult<string>> {
    const account = await openAccount(tx, tenant.shopId, grant.customerId, grant.currency);
    if (!account) return failOne(field, 'NOT_FOUND', 'The customer has no account to credit');
    return creditIn(tx, tenant.shopId, tenant.actor, account, {
      id: grant.id,
      amount: grant.amount,
      event: grant.event,
      expiresAt: grant.expiresAt ?? null,
      orderId: grant.orderId ?? null,
      refundId: grant.refundId ?? null,
      note: grant.note ?? '',
      field,
      at,
    });
  }

  /**
   * Records the expiry of every credit that has expired by `at` with something left, across
   * shops, up to {@link STORE_CREDIT_LIMITS.sweep} accounts at a time: the worker's sweep. Found
   * with the system role; each account's in its shop's own transaction. How many it expired.
   */
  async expireDue(at: Date = new Date()): Promise<number> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string; account_id: string }>(sql`
        SELECT DISTINCT shop_id, account_id FROM customers.store_credit_transactions
         WHERE kind = 'credit' AND remaining > 0 AND expires_at IS NOT NULL
           AND expires_at <= ${at.toISOString()}
         LIMIT ${STORE_CREDIT_LIMITS.sweep}`),
    );
    let expired = 0;
    for (const row of rows) {
      expired += await this.db.tenant(row.shop_id, async (tx) => {
        const account = await lockAccount(tx, row.shop_id, row.account_id);
        return account ? expireIn(tx, row.shop_id, account.id, at) : 0;
      });
    }
    return expired;
  }
}

/**
 * What a customer has of store credit in each currency they have an account in, in the caller's
 * transaction: what erasing them would take, and what their own file says.
 */
export async function storeCreditAccountsIn(
  tx: Tx,
  shopId: string,
  customerId: string,
  at: Date = new Date(),
): Promise<StoreCreditAccountRecord[]> {
  return accountsIn(tx, shopId, { customerId }, at);
}

/**
 * Moves a merged duplicate's store credit to the customer they were merged into, in the merge's
 * transaction: an account in a currency the customer has none in becomes theirs, and the
 * transactions of one in a currency they have are moved into theirs, keeping their times, so
 * that the ledger reads as one.
 */
export async function mergeStoreCreditIn(
  tx: Tx,
  shopId: string,
  fromId: string,
  intoId: string,
): Promise<void> {
  // Both customers' accounts locked, as every change of them is made.
  await tx.execute(sql`
    SELECT id FROM customers.store_credit_accounts
     WHERE shop_id = ${shopId} AND customer_id IN (${fromId}, ${intoId})
     ORDER BY id
       FOR UPDATE`);
  await tx.execute(sql`
    UPDATE customers.store_credit_transactions t
       SET account_id = k.id
      FROM customers.store_credit_accounts d
      JOIN customers.store_credit_accounts k
        ON k.shop_id = d.shop_id AND k.customer_id = ${intoId} AND k.currency = d.currency
     WHERE d.shop_id = ${shopId} AND d.customer_id = ${fromId}
       AND t.shop_id = d.shop_id AND t.account_id = d.id`);
  await tx.execute(sql`
    DELETE FROM customers.store_credit_accounts d
     WHERE d.shop_id = ${shopId} AND d.customer_id = ${fromId}
       AND EXISTS (SELECT 1 FROM customers.store_credit_accounts k
                    WHERE k.shop_id = d.shop_id AND k.customer_id = ${intoId}
                      AND k.currency = d.currency)`);
  await tx.execute(sql`
    UPDATE customers.store_credit_accounts
       SET customer_id = ${intoId}
     WHERE shop_id = ${shopId} AND customer_id = ${fromId}`);
}

/**
 * A customer's store credit as their own file gives it (CUS-05): each account, with its balance
 * and its ledger, the oldest first, amounts in major units.
 */
export async function storeCreditFileIn(
  tx: Tx,
  shopId: string,
  customerId: string,
  at: Date = new Date(),
): Promise<Record<string, unknown>[]> {
  const file: Record<string, unknown>[] = [];
  for (const account of await accountsIn(tx, shopId, { customerId }, at)) {
    const major = (value: bigint) => toMajorString(money(value, account.currency));
    const ledger = (await ledgerIn(tx, shopId, account.id, { limit: 100_000 }))
      .reverse()
      .map(toTransaction);
    file.push({
      id: toPublicId('storeCreditAccount', account.id),
      currency: account.currency,
      balance: major(account.balance),
      transactions: ledger.map((entry) => ({
        kind: entry.kind,
        event: entry.event,
        amount: major(entry.amount),
        balanceAfter: major(entry.balanceAfter),
        expiresAt: entry.expiresAt,
        remaining: entry.remaining === null ? null : major(entry.remaining),
        order: entry.orderId ? toPublicId('order', entry.orderId) : null,
        note: entry.note,
        at: entry.createdAt,
      })),
    });
  }
  return file;
}

/** The amount and note of a credit or debit by hand, checked. */
function checkInput(
  tenant: TenantContext,
  field: string[],
  amountField: string,
  input: StoreCreditInput,
  at: Date,
): MutationResult<{ amount: bigint; note: string }> {
  const check = new InputChecker();
  const currency = tenant.currency;
  if (input.currencyCode !== currency) {
    check.addMessage(
      [...field, amountField, 'currencyCode'],
      'INVALID',
      `Store credit is in the shop's currency, ${currency}`,
    );
  }
  const amount = check.price([...field, amountField, 'amount'], input.amount, currency, {
    required: true,
  });
  if (amount === 0n) {
    check.addMessage([...field, amountField, 'amount'], 'INVALID', 'It must be more than 0');
  }
  if (input.expiresAt && input.expiresAt.getTime() <= at.getTime()) {
    check.addMessage([...field, 'expiresAt'], 'INVALID', 'It must expire in the future');
  }
  const note = check.text([...field, 'note'], input.note, { max: STORE_CREDIT_LIMITS.note }) ?? '';
  if (!check.ok || amount === null) return { ok: false, errors: check.errors };
  return { ok: true, value: { amount, note } };
}

function otherCurrency<T>(account: AccountRow): MutationResult<T> {
  return failOne(
    ['id'],
    'INVALID',
    `This account is in ${account.currency}, not the shop's currency`,
  );
}

function notFound<T>(owner: StoreCreditOwner): MutationResult<T> {
  return 'accountId' in owner
    ? failOne(['id'], 'NOT_FOUND', 'Store credit account not found')
    : failOne(['id'], 'NOT_FOUND', 'Customer not found');
}

/** Account `id`, locked for a change of its ledger; null if there is none. */
async function lockAccount(tx: Tx, shopId: string, id: string): Promise<AccountRow | null> {
  const { rows } = await tx.execute<AccountRow>(sql`
    SELECT id, customer_id, currency, created_at FROM customers.store_credit_accounts
     WHERE shop_id = ${shopId} AND id = ${id}
       FOR UPDATE`);
  return rows[0] ?? null;
}

/** A customer's account in `currency`, locked; null if they have none. */
async function lockAccountOf(
  tx: Tx,
  shopId: string,
  customerId: string,
  currency: string,
): Promise<AccountRow | null> {
  const { rows } = await tx.execute<AccountRow>(sql`
    SELECT id, customer_id, currency, created_at FROM customers.store_credit_accounts
     WHERE shop_id = ${shopId} AND customer_id = ${customerId} AND currency = ${currency}
       FOR UPDATE`);
  return rows[0] ?? null;
}

/** A customer's account in `currency`, opened if they have none, locked; null for no customer. */
async function openAccount(
  tx: Tx,
  shopId: string,
  customerId: string,
  currency: string,
): Promise<AccountRow | null> {
  const existing = await lockAccountOf(tx, shopId, customerId, currency);
  if (existing) return existing;
  await tx.execute(sql`
    INSERT INTO customers.store_credit_accounts (shop_id, id, customer_id, currency)
    SELECT shop_id, ${newId()}, id, ${currency} FROM customers.customers
     WHERE shop_id = ${shopId} AND id = ${customerId}
    ON CONFLICT (shop_id, customer_id, currency) DO NOTHING`);
  return lockAccountOf(tx, shopId, customerId, currency);
}

/**
 * Records the expiry of the account's credits expired by `at` with something left, the account
 * locked: each ends with an expiration of what it had left. How many expired.
 */
async function expireIn(tx: Tx, shopId: string, accountId: string, at: Date): Promise<number> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    WITH due AS (
      SELECT id, remaining FROM customers.store_credit_transactions
       WHERE shop_id = ${shopId} AND account_id = ${accountId} AND kind = 'credit'
         AND remaining > 0 AND expires_at <= ${at.toISOString()}
    ), spent AS (
      UPDATE customers.store_credit_transactions t SET remaining = 0
        FROM due WHERE t.shop_id = ${shopId} AND t.id = due.id
    )
    INSERT INTO customers.store_credit_transactions
           (shop_id, id, account_id, kind, amount, source_id, actor_kind)
    SELECT ${shopId}, platform.uuidv7(), ${accountId}, 'expiration', due.remaining, due.id,
           'system'
      FROM due
    RETURNING id`);
  return rows.length;
}

/** What the account's credits have left that has not expired by `at`. */
async function balanceIn(tx: Tx, shopId: string, accountId: string, at: Date): Promise<bigint> {
  const { rows } = await tx.execute<{ balance: string }>(sql`
    SELECT coalesce(sum(remaining), 0)::text AS balance FROM customers.store_credit_transactions
     WHERE shop_id = ${shopId} AND account_id = ${accountId} AND kind = 'credit'
       AND remaining > 0 AND (expires_at IS NULL OR expires_at > ${at.toISOString()})`);
  return BigInt(rows[0]!.balance);
}

/**
 * Credits the locked `account`, once its expired credits are recorded: no more than an account
 * holds. The credit's ID.
 */
async function creditIn(
  tx: Tx,
  shopId: string,
  actor: Actor | 'system',
  account: AccountRow,
  credit: {
    id?: string | undefined;
    amount: bigint;
    event: StoreCreditEventValue;
    expiresAt: Date | null;
    orderId?: string | null;
    refundId?: string | null;
    note: string;
    field: string[];
    at: Date;
  },
): Promise<MutationResult<string>> {
  await expireIn(tx, shopId, account.id, credit.at);
  const balance = await balanceIn(tx, shopId, account.id, credit.at);
  const limit = fromMajor(STORE_CREDIT_LIMITS.balance, account.currency).amount;
  if (balance + credit.amount > limit) {
    const format = (value: bigint) => formatMoney(money(value, account.currency));
    return failOne(
      credit.field,
      'CREDIT_LIMIT_EXCEEDED',
      `An account holds at most ${format(limit)} of store credit, and this one has ` +
        `${format(balance)}`,
    );
  }
  const id = credit.id ?? newId();
  const { actorKind, actorId } = actorOf(actor);
  await tx.execute(sql`
    INSERT INTO customers.store_credit_transactions
           (shop_id, id, account_id, kind, event, amount, expires_at, remaining, order_id,
            refund_id, note, actor_kind, actor_id)
    VALUES (${shopId}, ${id}, ${account.id}, 'credit', ${credit.event}, ${credit.amount},
            ${credit.expiresAt?.toISOString() ?? null}, ${credit.amount},
            ${credit.orderId ?? null}, ${credit.refundId ?? null}, ${credit.note}, ${actorKind},
            ${actorId})`);
  return { ok: true, value: id };
}

/**
 * Debits the locked `account`, once its expired credits are recorded: from the credits that
 * expire soonest, those that never do last, keeping what it took from each. The debit's ID, or
 * INSUFFICIENT_FUNDS under `field`.
 */
async function debitIn(
  tx: Tx,
  shopId: string,
  actor: Actor | 'system',
  account: AccountRow,
  debit: {
    amount: bigint;
    event: StoreCreditEventValue;
    orderId: string | null;
    note: string;
    field: string[];
    at: Date;
  },
): Promise<MutationResult<string>> {
  await expireIn(tx, shopId, account.id, debit.at);
  const { rows: credits } = await tx.execute<{ id: string; remaining: string }>(sql`
    SELECT id, remaining FROM customers.store_credit_transactions
     WHERE shop_id = ${shopId} AND account_id = ${account.id} AND kind = 'credit'
       AND remaining > 0 AND (expires_at IS NULL OR expires_at > ${debit.at.toISOString()})
     ORDER BY expires_at NULLS LAST, created_at, id`);
  const available = credits.reduce((sum, credit) => sum + BigInt(credit.remaining), 0n);
  if (available < debit.amount) {
    const format = (value: bigint) => formatMoney(money(value, account.currency));
    return failOne(
      debit.field,
      'INSUFFICIENT_FUNDS',
      available === 0n
        ? 'This customer has no store credit'
        : `This customer has ${format(available)} of store credit`,
    );
  }
  const id = newId();
  const { actorKind, actorId } = actorOf(actor);
  await tx.execute(sql`
    INSERT INTO customers.store_credit_transactions
           (shop_id, id, account_id, kind, event, amount, order_id, note, actor_kind, actor_id)
    VALUES (${shopId}, ${id}, ${account.id}, 'debit', ${debit.event}, ${debit.amount},
            ${debit.orderId}, ${debit.note}, ${actorKind}, ${actorId})`);
  let left = debit.amount;
  for (const credit of credits) {
    if (left === 0n) break;
    const remaining = BigInt(credit.remaining);
    const taken = remaining < left ? remaining : left;
    left -= taken;
    await tx.execute(sql`
      UPDATE customers.store_credit_transactions SET remaining = remaining - ${taken}
       WHERE shop_id = ${shopId} AND id = ${credit.id}`);
    await tx.execute(sql`
      INSERT INTO customers.store_credit_allocations (shop_id, debit_id, credit_id, amount)
      VALUES (${shopId}, ${id}, ${credit.id}, ${taken})`);
  }
  return { ok: true, value: id };
}

function actorOf(actor: Actor | 'system'): {
  actorKind: 'app' | 'staff' | 'system';
  actorId: string | null;
} {
  if (actor === 'system') return { actorKind: 'system', actorId: null };
  const { actorKind, actorId } = actorColumnsOf(actor);
  return { actorKind, actorId };
}

/** The account as it is now, and transaction `id` of it. */
async function changeIn(
  tx: Tx,
  shopId: string,
  accountId: string,
  id: string,
  at: Date,
): Promise<StoreCreditChange> {
  const [account] = await accountsIn(tx, shopId, { ids: [accountId] }, at);
  const [row] = await ledgerIn(tx, shopId, accountId, { only: id, limit: 1 });
  return { account: account!, transaction: toTransaction(row!) };
}

/** Accounts with their balances at `at`, the oldest first. */
async function accountsIn(
  tx: Tx,
  shopId: string,
  which: { customerId: string } | { ids: string[] },
  at: Date,
): Promise<StoreCreditAccountRecord[]> {
  const { rows } = await tx.execute<AccountRow & { balance: string }>(sql`
    SELECT a.id, a.customer_id, a.currency, a.created_at,
           (SELECT coalesce(sum(t.remaining), 0)
              FROM customers.store_credit_transactions t
             WHERE t.shop_id = a.shop_id AND t.account_id = a.id AND t.kind = 'credit'
               AND t.remaining > 0
               AND (t.expires_at IS NULL OR t.expires_at > ${at.toISOString()}))::text AS balance
      FROM customers.store_credit_accounts a
     WHERE a.shop_id = ${shopId}
       AND ${
         'customerId' in which
           ? sql`a.customer_id = ${which.customerId}`
           : sql`a.id = ANY(${sql.param(which.ids)}::uuid[])`
       }
     ORDER BY a.created_at, a.id`);
  return rows.map((row) => ({
    id: row.id,
    customerId: row.customer_id,
    currency: row.currency,
    balance: BigInt(row.balance),
    createdAt: toDate(row.created_at),
  }));
}

/**
 * An account's ledger, the newest first, each transaction with the balance it left as the ledger
 * counts it: those before `before` only, or transaction `only`.
 */
async function ledgerIn(
  tx: Tx,
  shopId: string,
  accountId: string,
  options: { before?: { at: string; id: string } | null; only?: string; limit: number },
): Promise<TransactionRow[]> {
  const { before, only } = options;
  const { rows } = await tx.execute<TransactionRow>(sql`
    SELECT * FROM (
      SELECT id, account_id, kind, event, amount::text AS amount, expires_at,
             remaining::text AS remaining, order_id, refund_id, note, created_at,
             ${exactTime(sql.raw('created_at'))} AS at_exactly,
             (sum(${SIGNED}) OVER (ORDER BY created_at, id))::text AS balance_after
        FROM customers.store_credit_transactions
       WHERE shop_id = ${shopId} AND account_id = ${accountId}
    ) ledger
     WHERE ${only ? sql`id = ${only}` : sql`true`}
       AND ${
         before
           ? sql`(created_at, id) < (${before.at}::timestamptz, ${before.id}::uuid)`
           : sql`true`
       }
     ORDER BY created_at DESC, id DESC
     LIMIT ${options.limit}`);
  return rows;
}

function toTransaction(row: TransactionRow): StoreCreditTransactionRecord {
  const amount = BigInt(row.amount);
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    event: row.event,
    amount: row.kind === 'credit' || row.kind === 'debit_revert' ? amount : -amount,
    balanceAfter: BigInt(row.balance_after),
    expiresAt: toDateOrNull(row.expires_at),
    remaining: row.remaining === null ? null : BigInt(row.remaining),
    orderId: row.order_id,
    refundId: row.refund_id,
    note: row.note,
    createdAt: toDate(row.created_at),
    at: row.at_exactly,
  };
}
