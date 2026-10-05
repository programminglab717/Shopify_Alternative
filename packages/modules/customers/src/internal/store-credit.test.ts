import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { Database, pgError } from '@hatti/db';
import { testDatabaseServer } from '@hatti/db/testing';
import { listAudit } from '@hatti/events';
import { newId, toPublicId } from '@hatti/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  STORE_CREDIT_LIMITS,
  StoreCreditService,
  type StoreCreditChange,
} from './store-credit.service.js';
import { customersFixture, errorsOf, unwrap, type CustomersFixture } from './test-support.js';

const server = testDatabaseServer();

const DAY = 86_400_000;
const T0 = new Date('2027-03-01T09:00:00Z');
const after = (days: number) => new Date(T0.getTime() + days * DAY);
const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });

describe.skipIf(!server)('Store credit (ORD-09, ADR-184)', () => {
  let f: CustomersFixture;
  let system: Database;
  let credit: StoreCreditService;

  beforeAll(async () => {
    f = await customersFixture(server!);
    // The expiry sweep looks across shops with the system role.
    system = new Database({
      appUrl: f.testDb.appUrl,
      systemUrl: f.testDb.systemUrl,
      applicationName: 'store-credit-test',
    });
    credit = new StoreCreditService(system);
  });

  afterAll(async () => {
    await system?.close();
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  async function customer(tenant: TenantContext, phone: string, name: string): Promise<string> {
    return unwrap(await f.customers.create(tenant, { phone, name })).id;
  }

  /** A customer's account's ledger, the newest first: kind, signed amount and balance after. */
  async function ledger(tenant: TenantContext, accountId: string) {
    const page = await credit.transactions(tenant, accountId, { first: 50 });
    return page.items.map((item) => [item.kind, item.amount, item.balanceAfter]);
  }

  it('credits a customer by hand, opening their account, and debits what expires soonest first', async () => {
    const ayesha = await customer(f.staff, '0300 1234567', 'Ayesha Khan');
    const first = unwrap(
      await credit.credit(
        f.staff,
        { customerId: ayesha },
        { ...rupees('1000'), expiresAt: after(30), note: 'Late delivery' },
        T0,
      ),
    );
    const accountId = first.account.id;
    expect(first.account).toMatchObject({ customerId: ayesha, currency: 'PKR', balance: 100_000n });
    expect(first.transaction).toMatchObject({
      kind: 'credit',
      event: 'adjustment',
      amount: 100_000n,
      balanceAfter: 100_000n,
      remaining: 100_000n,
      expiresAt: after(30),
      note: 'Late delivery',
    });
    // The account's ID or the customer's: the same account.
    unwrap(await credit.credit(f.staff, { accountId }, rupees('500'), T0));
    const soonest = unwrap(
      await credit.credit(
        f.staff,
        { customerId: ayesha },
        { ...rupees('300'), expiresAt: after(10) },
        T0,
      ),
    );
    expect(soonest.account).toMatchObject({ id: accountId, balance: 180_000n });

    const debit = unwrap(
      await credit.debit(
        f.staff,
        { customerId: ayesha },
        { ...rupees('400'), note: 'Paid in cash' },
        T0,
      ),
    );
    expect(debit.account.balance).toBe(140_000n);
    expect(debit.transaction).toMatchObject({
      kind: 'debit',
      amount: -40_000n,
      balanceAfter: 140_000n,
      remaining: null,
    });
    // Rs 300 that expires in 10 days went first, then 100 of the Rs 1,000 that expires in 30;
    // the Rs 500 that never expires is untouched.
    const remaining = await f.admin.query<{ amount: string; remaining: string }>(
      `SELECT amount, remaining FROM customers.store_credit_transactions
        WHERE kind = 'credit' ORDER BY created_at`,
    );
    expect(remaining.rows).toEqual([
      { amount: '100000', remaining: '90000' },
      { amount: '50000', remaining: '50000' },
      { amount: '30000', remaining: '0' },
    ]);
    expect(await ledger(f.staff, accountId)).toEqual([
      ['debit', -40_000n, 140_000n],
      ['credit', 30_000n, 180_000n],
      ['credit', 50_000n, 150_000n],
      ['credit', 100_000n, 100_000n],
    ]);
    // Pages, the newest first.
    const page = await credit.transactions(f.staff, accountId, { first: 2 });
    expect(page.hasNextPage).toBe(true);
    const next = await credit.transactions(f.staff, accountId, {
      first: 2,
      after: { at: page.items[1]!.at, id: page.items[1]!.id },
    });
    expect(next.items.map((item) => item.amount)).toEqual([50_000n, 100_000n]);
    expect(next.hasNextPage).toBe(false);

    expect(await credit.accountsOf(f.staff, ayesha, T0)).toEqual([debit.account]);
    expect(await credit.account(f.staff, accountId, T0)).toEqual(debit.account);
    // Another shop sees none of it.
    expect(await credit.account(f.b, accountId, T0)).toBeNull();
    expect(await credit.accountsOf(f.b, ayesha, T0)).toEqual([]);

    const audit = await f.db.tenant(f.a.shopId, (tx) =>
      listAudit(tx, f.a.shopId, { first: 10, subjectId: ayesha }),
    );
    expect(audit.items.map((entry) => [entry.action, entry.actorRole, entry.details])).toEqual([
      [
        'customer.store_credit_debited',
        'manager',
        {
          account: toPublicId('storeCreditAccount', accountId),
          transaction: toPublicId('storeCreditTransaction', debit.transaction.id),
          amount: '400.00',
        },
      ],
      [
        'customer.store_credit_credited',
        'manager',
        {
          account: toPublicId('storeCreditAccount', accountId),
          transaction: toPublicId('storeCreditTransaction', soonest.transaction.id),
          amount: '300.00',
          expiresAt: after(10).toISOString(),
        },
      ],
      ['customer.store_credit_credited', 'manager', expect.objectContaining({ amount: '500.00' })],
      ['customer.store_credit_credited', 'manager', expect.objectContaining({ amount: '1000.00' })],
    ]);
  });

  it('refuses another currency, nothing, the past, too much and what is not there', async () => {
    const ayesha = await customer(f.a, '0300 1234567', 'Ayesha Khan');
    const owner = { customerId: ayesha };
    expect(
      errorsOf(
        await credit.credit(
          f.a,
          owner,
          { amount: '0', currencyCode: 'USD', expiresAt: T0, note: 'x'.repeat(501) },
          T0,
        ),
      ),
    ).toEqual([
      ['creditInput.creditAmount.currencyCode', 'INVALID'],
      ['creditInput.creditAmount.amount', 'INVALID'],
      ['creditInput.expiresAt', 'INVALID'],
      ['creditInput.note', 'TOO_LONG'],
    ]);
    expect(errorsOf(await credit.credit(f.a, owner, rupees('-5'), T0))).toEqual([
      ['creditInput.creditAmount.amount', 'INVALID'],
    ]);
    expect(errorsOf(await credit.credit(f.a, { customerId: newId() }, rupees('5'), T0))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);
    expect(errorsOf(await credit.credit(f.a, { accountId: newId() }, rupees('5'), T0))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);
    // No account yet: nothing to debit, and none opened.
    expect(await credit.debit(f.a, owner, rupees('5'), T0)).toEqual({
      ok: false,
      errors: [
        {
          field: ['debitInput', 'debitAmount', 'amount'],
          code: 'INSUFFICIENT_FUNDS',
          message: 'This customer has no store credit',
        },
      ],
    });
    expect(await credit.accountsOf(f.a, ayesha, T0)).toEqual([]);

    const { account } = unwrap(await credit.credit(f.a, owner, rupees('500'), T0));
    expect(await credit.debit(f.a, { accountId: account.id }, rupees('500.01'), T0)).toEqual({
      ok: false,
      errors: [
        {
          field: ['debitInput', 'debitAmount', 'amount'],
          code: 'INSUFFICIENT_FUNDS',
          message: 'This customer has Rs 500 of store credit',
        },
      ],
    });
    // An account holds Rs 1,000,000 at most.
    unwrap(await credit.credit(f.a, owner, rupees(String(STORE_CREDIT_LIMITS.balance - 500)), T0));
    expect(await credit.credit(f.a, owner, rupees('0.01'), T0)).toEqual({
      ok: false,
      errors: [
        {
          field: ['creditInput', 'creditAmount', 'amount'],
          code: 'CREDIT_LIMIT_EXCEEDED',
          message:
            'An account holds at most Rs 1,000,000 of store credit, and this one has ' +
            'Rs 1,000,000',
        },
      ],
    });
    // Another shop's customer is not this shop's.
    expect(errorsOf(await credit.credit(f.b, owner, rupees('5'), T0))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);
  });

  it('spends no credit twice when two debits come at once', async () => {
    const ayesha = await customer(f.a, '0300 1234567', 'Ayesha Khan');
    unwrap(await credit.credit(f.a, { customerId: ayesha }, rupees('1000'), T0));
    const results = await Promise.all([
      credit.debit(f.a, { customerId: ayesha }, rupees('600'), T0),
      credit.debit(f.a, { customerId: ayesha }, rupees('600'), T0),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results.flatMap((result) => (result.ok ? [] : result.errors.map((e) => e.code))),
    ).toEqual(['INSUFFICIENT_FUNDS']);
    const [account] = await credit.accountsOf(f.a, ayesha, T0);
    expect(account!.balance).toBe(40_000n);
  });

  it('leaves out an expired credit at once, and records its end when the sweep comes', async () => {
    const ayesha = await customer(f.a, '0300 1234567', 'Ayesha Khan');
    const bilal = await customer(f.b, '0333 1234567', 'Bilal Ahmed');
    const { account } = unwrap(
      await credit.credit(
        f.a,
        { customerId: ayesha },
        { ...rupees('1000'), expiresAt: after(1) },
        T0,
      ),
    );
    unwrap(await credit.credit(f.a, { customerId: ayesha }, rupees('50'), T0));
    unwrap(await credit.debit(f.a, { customerId: ayesha }, rupees('400'), T0));
    unwrap(
      await credit.credit(f.b, { customerId: bilal }, { ...rupees('70'), expiresAt: after(1) }, T0),
    );

    // Expired, its Rs 600 left is no longer the customer's, before any sweep.
    expect((await credit.accountsOf(f.a, ayesha, after(2)))[0]!.balance).toBe(5_000n);

    // Nothing has expired yet a minute before; then both shops' credits do.
    expect(await credit.expireDue(new Date(after(1).getTime() - 60_000))).toBe(0);
    expect(await credit.expireDue(after(2))).toBe(2);
    expect(await credit.expireDue(after(2))).toBe(0);
    expect(
      errorsOf(await credit.debit(f.a, { customerId: ayesha }, rupees('51'), after(2))),
    ).toEqual([['debitInput.debitAmount.amount', 'INSUFFICIENT_FUNDS']]);
    expect(await ledger(f.a, account.id)).toEqual([
      ['expiration', -60_000n, 5_000n],
      ['debit', -40_000n, 65_000n],
      ['credit', 5_000n, 105_000n],
      ['credit', 100_000n, 100_000n],
    ]);
    const [expiration] = (await credit.transactions(f.a, account.id, { first: 1 })).items;
    expect(expiration).toMatchObject({ event: null, remaining: null, note: '' });
    const [bilals] = await credit.accountsOf(f.b, bilal, after(2));
    expect(await ledger(f.b, bilals!.id)).toEqual([
      ['expiration', -7_000n, 0n],
      ['credit', 7_000n, 7_000n],
    ]);
  });

  it("moves a merged duplicate's credit, and keeps a customer owed credit from being erased", async () => {
    const ayesha = await customer(f.staff, '0300 1234567', 'Ayesha Khan');
    const duplicate = await customer(f.staff, '0311 1234567', 'Ayesha K');
    const chand = await customer(f.staff, '0345 1234567', 'Chand Bibi');
    const daud = await customer(f.staff, '0321 1234567', 'Daud Ali');
    const kept = unwrap(await credit.credit(f.staff, { customerId: ayesha }, rupees('1000'), T0));
    unwrap(
      await credit.credit(
        f.staff,
        { customerId: duplicate },
        { ...rupees('200'), expiresAt: after(5) },
        T0,
      ),
    );
    unwrap(await credit.debit(f.staff, { customerId: duplicate }, rupees('50'), T0));
    unwrap(await credit.credit(f.staff, { customerId: ayesha }, rupees('25'), T0));

    unwrap(await f.data.merge(f.staff, ayesha, duplicate));
    // One account, its ledger the two as they happened.
    const accounts = await credit.accountsOf(f.staff, ayesha, T0);
    expect(accounts.map((account) => [account.id, account.balance])).toEqual([
      [kept.account.id, 117_500n],
    ]);
    expect(await ledger(f.staff, kept.account.id)).toEqual([
      ['credit', 2_500n, 117_500n],
      ['debit', -5_000n, 115_000n],
      ['credit', 20_000n, 120_000n],
      ['credit', 100_000n, 100_000n],
    ]);
    const counted = await f.admin.query<{ accounts: number }>(
      'SELECT count(*)::int AS accounts FROM customers.store_credit_accounts',
    );
    expect(counted.rows[0]!.accounts).toBe(1);

    // A duplicate's account becomes the customer's when they have none.
    const daudsCredit = unwrap(
      await credit.credit(f.staff, { customerId: daud }, rupees('10'), T0),
    );
    unwrap(await f.data.merge(f.staff, chand, daud));
    expect((await credit.accountsOf(f.staff, chand, T0)).map((account) => account.id)).toEqual([
      daudsCredit.account.id,
    ]);

    // Their own file has it, and erasing them waits until it is spent or given back.
    const file = JSON.parse(unwrap(await f.data.export(f.staff, ayesha)).json) as {
      storeCredit: { balance: string; transactions: { kind: string; amount: string }[] }[];
    };
    expect(file.storeCredit).toEqual([
      expect.objectContaining({
        id: toPublicId('storeCreditAccount', kept.account.id),
        currency: 'PKR',
        balance: '1175.00',
      }),
    ]);
    expect(file.storeCredit[0]!.transactions.map((entry) => [entry.kind, entry.amount])).toEqual([
      ['credit', '1000.00'],
      ['credit', '200.00'],
      ['debit', '-50.00'],
      ['credit', '25.00'],
    ]);
    expect(await f.data.erase(f.staff, ayesha)).toEqual({
      ok: false,
      errors: [
        {
          field: ['id'],
          code: 'IN_USE',
          message:
            'They have Rs 1,175 of store credit left: debit it, once it is given to them another ' +
            'way, before erasing them',
        },
      ],
    });
    unwrap(await credit.debit(f.staff, { customerId: ayesha }, rupees('1175'), T0));
    unwrap(await f.data.erase(f.staff, ayesha));
    const left = await f.admin.query<{ accounts: number; transactions: number }>(
      `SELECT (SELECT count(*)::int FROM customers.store_credit_accounts
                WHERE customer_id = $1) AS accounts,
              (SELECT count(*)::int FROM customers.store_credit_transactions
                WHERE account_id = $2) AS transactions`,
      [ayesha, kept.account.id],
    );
    expect(left.rows[0]).toEqual({ accounts: 0, transactions: 0 });
  });

  it('keeps its ledger as it was: request code changes no amount and deletes nothing', async () => {
    const ayesha = await customer(f.a, '0300 1234567', 'Ayesha Khan');
    const { transaction }: StoreCreditChange = unwrap(
      await credit.credit(f.a, { customerId: ayesha }, rupees('100'), T0),
    );
    for (const statement of [
      sql`UPDATE customers.store_credit_transactions SET amount = 1 WHERE id = ${transaction.id}`,
      sql`UPDATE customers.store_credit_transactions SET kind = 'debit'`,
      sql`DELETE FROM customers.store_credit_transactions`,
      sql`DELETE FROM customers.store_credit_allocations`,
    ]) {
      const error = await f.db
        .tenant(f.a.shopId, (tx) => tx.execute(statement))
        .catch((caught: unknown) => caught);
      expect(pgError(error)?.code).toBe('42501');
    }
  });
});
