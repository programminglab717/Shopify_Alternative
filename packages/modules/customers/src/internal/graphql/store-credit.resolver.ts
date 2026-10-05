import {
  CurrentTenant,
  Money,
  RequireIdempotencyKey,
  RequireScopes,
  UserError,
  badUserInput,
  decodeTimeCursor,
  encodeCursor,
  failOne,
  pageSize,
  type TenantContext,
} from '@hatti/api';
import { isUuid, toPublicId, tryFromPublicId } from '@hatti/ids';
import { money, type CurrencyCode } from '@hatti/money';
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { CustomerService } from '../customer.service.js';
import {
  StoreCreditService,
  type StoreCreditAccountRecord,
  type StoreCreditChange,
  type StoreCreditOwner,
  type StoreCreditTransactionRecord,
} from '../store-credit.service.js';
import { Customer } from './customer.types.js';
import { cursorAfter, toCustomer, uuidOf } from './mappers.js';
import {
  StoreCreditAccount,
  StoreCreditAccountConnection,
  StoreCreditAccountCreditInput,
  StoreCreditAccountCreditPayload,
  StoreCreditAccountDebitInput,
  StoreCreditAccountDebitPayload,
  StoreCreditAccountTransaction,
  StoreCreditAccountTransactionConnection,
  StoreCreditAccountTransactionKind,
  StoreCreditPageArgs,
  StoreCreditSystemEvent,
} from './store-credit.types.js';

/**
 * Store credit (ORD-09, ADR-184), as Shopify's Admin API has it: accounts, their ledgers, and
 * credits and debits by hand, for owners, managers and apps given the scopes.
 */
@Resolver(() => StoreCreditAccount)
export class StoreCreditResolver {
  constructor(
    private readonly storeCredit: StoreCreditService,
    private readonly customers: CustomerService,
  ) {}

  @Query(() => StoreCreditAccount, {
    nullable: true,
    description: 'A store credit account by ID, or null if not found.',
  })
  @RequireScopes('read_store_credit_accounts')
  async storeCreditAccount(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<StoreCreditAccount | null> {
    const record = await this.storeCredit.account(tenant, uuidOf('storeCreditAccount', id));
    return record ? toStoreCreditAccount(record) : null;
  }

  @ResolveField(() => Customer, {
    nullable: true,
    description: 'The customer it belongs to.',
  })
  @RequireScopes('read_customers')
  async owner(
    @CurrentTenant() tenant: TenantContext,
    @Parent() account: StoreCreditAccount,
  ): Promise<Customer | null> {
    const record = await this.customers.get(tenant, account.customerUuid);
    return record ? toCustomer(record, tenant) : null;
  }

  @ResolveField(() => StoreCreditAccountTransactionConnection, {
    description: 'Its ledger, the newest first.',
  })
  @RequireScopes('read_store_credit_account_transactions')
  async transactions(
    @CurrentTenant() tenant: TenantContext,
    @Parent() account: StoreCreditAccount,
    @Args() args: StoreCreditPageArgs,
  ): Promise<StoreCreditAccountTransactionConnection> {
    const { items, hasNextPage } = await this.storeCredit.transactions(tenant, account.uuid, {
      first: pageSize(args.first),
      after: timeCursorAfter(args.after),
    });
    const nodes = items.map((item) => toTransaction(item, account));
    return Object.assign(new StoreCreditAccountTransactionConnection(), {
      edges: nodes.map((node, index) => ({
        node,
        cursor: encodeCursor({ at: items[index]!.at, id: items[index]!.id }),
      })),
      nodes,
      pageInfo: { hasNextPage, endCursor: lastCursor(items) },
    });
  }

  @Mutation(() => StoreCreditAccountCreditPayload, {
    description:
      "Credits a store credit account, as Shopify's storeCreditAccountCredit: `id` is the " +
      "account's, or a customer's, whose account in the shop's currency is opened if they have " +
      'none. An account holds at most Rs 1,000,000. Audited. Needs an Idempotency-Key header.',
  })
  @RequireScopes('write_store_credit_account_transactions')
  @RequireIdempotencyKey()
  async storeCreditAccountCredit(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('creditInput') input: StoreCreditAccountCreditInput,
  ): Promise<StoreCreditAccountCreditPayload> {
    const owner = ownerOf(id);
    const result = owner
      ? await this.storeCredit.credit(tenant, owner, {
          amount: input.creditAmount.amount,
          currencyCode: input.creditAmount.currencyCode,
          expiresAt: input.expiresAt ?? null,
          note: input.note ?? null,
        })
      : failOne<StoreCreditChange>(['id'], 'NOT_FOUND', 'Store credit account not found');
    return Object.assign(new StoreCreditAccountCreditPayload(), {
      storeCreditAccountTransaction: result.ok ? toChange(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => StoreCreditAccountDebitPayload, {
    description:
      "Debits a store credit account, as Shopify's storeCreditAccountDebit, such as when its " +
      'credit is given back another way: the credits that expire soonest first. `id` is the ' +
      "account's, or its customer's. Audited. Needs an Idempotency-Key header.",
  })
  @RequireScopes('write_store_credit_account_transactions')
  @RequireIdempotencyKey()
  async storeCreditAccountDebit(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('debitInput') input: StoreCreditAccountDebitInput,
  ): Promise<StoreCreditAccountDebitPayload> {
    const owner = ownerOf(id);
    const result = owner
      ? await this.storeCredit.debit(tenant, owner, {
          amount: input.debitAmount.amount,
          currencyCode: input.debitAmount.currencyCode,
          note: input.note ?? null,
        })
      : failOne<StoreCreditChange>(['id'], 'NOT_FOUND', 'Store credit account not found');
    return Object.assign(new StoreCreditAccountDebitPayload(), {
      storeCreditAccountTransaction: result.ok ? toChange(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

/** A customer's store credit accounts, on the customer. */
@Resolver(() => Customer)
export class CustomerStoreCreditResolver {
  constructor(private readonly storeCredit: StoreCreditService) {}

  @ResolveField(() => StoreCreditAccountConnection, {
    description: 'Their store credit, an account for each currency they have had it in (ADR-184).',
  })
  @RequireScopes('read_store_credit_accounts')
  async storeCreditAccounts(
    @CurrentTenant() tenant: TenantContext,
    @Parent() customer: Customer,
    @Args() args: StoreCreditPageArgs,
  ): Promise<StoreCreditAccountConnection> {
    // A customer has an account for each currency they had credit in: one, in a shop.
    const first = pageSize(args.first);
    const after = cursorAfter(args.after);
    const all = await this.storeCredit.accountsOf(tenant, customer.uuid);
    const start = after ? all.findIndex((account) => account.id === after) + 1 : 0;
    const page = all.slice(start, start + first);
    const nodes = page.map(toStoreCreditAccount);
    const edges = nodes.map((node, index) => ({
      node,
      cursor: encodeCursor({ id: page[index]!.id }),
    }));
    return Object.assign(new StoreCreditAccountConnection(), {
      edges,
      nodes,
      pageInfo: {
        hasNextPage: start + first < all.length,
        endCursor: edges.at(-1)?.cursor ?? null,
      },
    });
  }
}

/** An account's or a customer's ID; null for neither. */
function ownerOf(id: string): StoreCreditOwner | null {
  const accountId = tryFromPublicId(id, 'storeCreditAccount');
  if (accountId) return { accountId };
  const customerId = tryFromPublicId(id, 'customer');
  return customerId ? { customerId } : null;
}

function timeCursorAfter(after: string | null | undefined): { at: string; id: string } | null {
  if (!after) return null;
  const cursor = decodeTimeCursor(after);
  if (!isUuid(cursor.id)) throw badUserInput('Invalid cursor');
  return cursor;
}

function lastCursor(items: StoreCreditTransactionRecord[]): string | null {
  const last = items.at(-1);
  return last ? encodeCursor({ at: last.at, id: last.id }) : null;
}

export function toStoreCreditAccount(record: StoreCreditAccountRecord): StoreCreditAccount {
  return Object.assign(new StoreCreditAccount(), {
    id: toPublicId('storeCreditAccount', record.id),
    balance: Money.from(money(record.balance, record.currency)),
    createdAt: record.createdAt,
    uuid: record.id,
    customerUuid: record.customerId,
  });
}

function toChange(change: StoreCreditChange): StoreCreditAccountTransaction {
  return toTransaction(change.transaction, toStoreCreditAccount(change.account));
}

function toTransaction(
  record: StoreCreditTransactionRecord,
  account: StoreCreditAccount,
): StoreCreditAccountTransaction {
  const currency = account.balance.currencyCode as CurrencyCode;
  const amount = (value: bigint) => Money.from(money(value, currency));
  return Object.assign(new StoreCreditAccountTransaction(), {
    id: toPublicId('storeCreditTransaction', record.id),
    kind: record.kind.toUpperCase() as StoreCreditAccountTransactionKind,
    event: record.event ? (record.event.toUpperCase() as StoreCreditSystemEvent) : null,
    amount: amount(record.amount),
    balanceAfterTransaction: amount(record.balanceAfter),
    expiresAt: record.expiresAt,
    remainingAmount: record.remaining === null ? null : amount(record.remaining),
    orderId: record.orderId ? toPublicId('order', record.orderId) : null,
    refundId: record.refundId ? toPublicId('refund', record.refundId) : null,
    note: record.note,
    createdAt: record.createdAt,
    account,
  });
}
