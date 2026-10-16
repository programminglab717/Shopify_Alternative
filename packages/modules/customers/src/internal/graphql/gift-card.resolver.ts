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
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { isUuid, toPublicId } from '@hatti/ids';
import { money, type CurrencyCode } from '@hatti/money';
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { CustomerService } from '../customer.service.js';
import {
  GiftCardService,
  formatGiftCardCode,
  type GiftCardChange,
  type GiftCardRecord,
  type GiftCardTransactionRecord,
} from '../gift-cards.service.js';
import { Customer } from './customer.types.js';
import {
  GiftCard,
  GiftCardConnection,
  GiftCardCreateInput,
  GiftCardCreatePayload,
  GiftCardCreditInput,
  GiftCardDebitInput,
  GiftCardPageArgs,
  GiftCardPayload,
  GiftCardTransaction,
  GiftCardTransactionConnection,
  GiftCardTransactionKind,
  GiftCardTransactionPayload,
  GiftCardUpdateInput,
  GiftCardsArgs,
} from './gift-card.types.js';
import { toCustomer, uuidOf } from './mappers.js';

/**
 * Gift cards (CAT-12, PAY-13, ADR-448), as Shopify's Admin API has them: issued, changed,
 * deactivated, and credited or debited by hand, by owners, managers and apps given the scopes;
 * looked up by accountants and confirmation agents.
 */
@Resolver(() => GiftCard)
export class GiftCardResolver {
  constructor(
    private readonly cards: GiftCardService,
    private readonly customers: CustomerService,
  ) {}

  @Query(() => GiftCardConnection, {
    description: "The shop's gift cards, the newest first.",
  })
  @RequireScopes('read_gift_cards')
  async giftCards(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: GiftCardsArgs,
  ): Promise<GiftCardConnection> {
    const { items, hasNextPage } = await this.cards.list(tenant, {
      first: pageSize(args.first),
      after: timeCursorAfter(args.after),
      query: args.query ?? null,
    });
    const nodes = items.map(toGiftCard);
    const edges = nodes.map((node, index) => ({
      node,
      cursor: encodeCursor({ at: items[index]!.at, id: items[index]!.id }),
    }));
    return Object.assign(new GiftCardConnection(), {
      edges,
      nodes,
      pageInfo: { hasNextPage, endCursor: edges.at(-1)?.cursor ?? null },
    });
  }

  @Query(() => GiftCard, { nullable: true, description: 'A gift card by ID, or null.' })
  @RequireScopes('read_gift_cards')
  async giftCard(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<GiftCard | null> {
    const record = await this.cards.get(tenant, uuidOf('giftCard', id));
    return record ? toGiftCard(record) : null;
  }

  @ResolveField(() => Customer, { nullable: true, description: 'Who it was given to, if any.' })
  @RequireScopes('read_customers')
  async customer(
    @CurrentTenant() tenant: TenantContext,
    @Parent() card: GiftCard,
  ): Promise<Customer | null> {
    if (!card.customerUuid) return null;
    const record = await this.customers.get(tenant, card.customerUuid);
    return record ? toCustomer(record, tenant) : null;
  }

  @ResolveField(() => GiftCardTransactionConnection, {
    description: 'Its ledger, the newest first.',
  })
  async transactions(
    @CurrentTenant() tenant: TenantContext,
    @Parent() card: GiftCard,
    @Args() args: GiftCardPageArgs,
  ): Promise<GiftCardTransactionConnection> {
    const { items, hasNextPage } = await this.cards.transactions(tenant, card.uuid, {
      first: pageSize(args.first),
      after: timeCursorAfter(args.after),
    });
    const nodes = items.map((item) => toTransaction(item, card));
    const edges = nodes.map((node, index) => ({
      node,
      cursor: encodeCursor({ at: items[index]!.at, id: items[index]!.id }),
    }));
    return Object.assign(new GiftCardTransactionConnection(), {
      edges,
      nodes,
      pageInfo: { hasNextPage, endCursor: edges.at(-1)?.cursor ?? null },
    });
  }

  @Mutation(() => GiftCardCreatePayload, {
    description:
      "Issues a gift card, as Shopify's giftCardCreate: worth up to Rs 100,000, with the shop's " +
      'own code or one made for it, which the payload gives this once. Audited. Needs an ' +
      'Idempotency-Key header.',
  })
  @RequireScopes('write_gift_cards')
  @RequireIdempotencyKey()
  async giftCardCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: GiftCardCreateInput,
  ): Promise<GiftCardCreatePayload> {
    const result = await this.cards.create(tenant, {
      initialValue: input.initialValue,
      code: input.code ?? null,
      expiresOn: input.expiresOn ?? null,
      customerId: input.customerId ? uuidOf('customer', input.customerId) : null,
      note: input.note ?? null,
    });
    return Object.assign(new GiftCardCreatePayload(), {
      giftCard: result.ok ? toGiftCard(result.value.giftCard) : null,
      giftCardCode: result.ok ? formatGiftCardCode(result.value.code) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => GiftCardPayload, {
    description: "Changes a gift card's expiry, customer or note, as Shopify's giftCardUpdate.",
  })
  @RequireScopes('write_gift_cards')
  async giftCardUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: GiftCardUpdateInput,
  ): Promise<GiftCardPayload> {
    const result = await this.cards.update(tenant, uuidOf('giftCard', id), {
      ...(input.expiresOn !== undefined && { expiresOn: input.expiresOn }),
      ...(input.customerId !== undefined && {
        customerId: input.customerId ? uuidOf('customer', input.customerId) : null,
      }),
      ...(input.note !== undefined && { note: input.note }),
    });
    return payload(result);
  }

  @Mutation(() => GiftCardPayload, {
    description: "Deactivates a gift card for good, as Shopify's giftCardDeactivate.",
  })
  @RequireScopes('write_gift_cards')
  async giftCardDeactivate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<GiftCardPayload> {
    return payload(await this.cards.deactivate(tenant, uuidOf('giftCard', id)));
  }

  @Mutation(() => GiftCardTransactionPayload, {
    description:
      "Adds to a gift card's balance, as Shopify's giftCardCredit. Audited. Needs an " +
      'Idempotency-Key header.',
  })
  @RequireScopes('write_gift_cards')
  @RequireIdempotencyKey()
  async giftCardCredit(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('creditInput') input: GiftCardCreditInput,
  ): Promise<GiftCardTransactionPayload> {
    const result =
      input.creditAmount.currencyCode !== tenant.currency
        ? otherCurrency(['creditInput', 'creditAmount', 'currencyCode'], tenant)
        : await this.cards.credit(tenant, uuidOf('giftCard', id), {
            amount: input.creditAmount.amount,
            note: input.note ?? null,
          });
    return transactionPayload(result);
  }

  @Mutation(() => GiftCardTransactionPayload, {
    description:
      "Takes from a gift card's balance, as Shopify's giftCardDebit. Audited. Needs an " +
      'Idempotency-Key header.',
  })
  @RequireScopes('write_gift_cards')
  @RequireIdempotencyKey()
  async giftCardDebit(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('debitInput') input: GiftCardDebitInput,
  ): Promise<GiftCardTransactionPayload> {
    const result =
      input.debitAmount.currencyCode !== tenant.currency
        ? otherCurrency(['debitInput', 'debitAmount', 'currencyCode'], tenant)
        : await this.cards.debit(tenant, uuidOf('giftCard', id), {
            amount: input.debitAmount.amount,
            note: input.note ?? null,
          });
    return transactionPayload(result);
  }
}

function otherCurrency(field: string[], tenant: TenantContext): MutationResult<GiftCardChange> {
  return failOne(field, 'INVALID', `Gift cards are in the shop's currency, ${tenant.currency}`);
}

function payload(result: MutationResult<GiftCardRecord>): GiftCardPayload {
  return Object.assign(new GiftCardPayload(), {
    giftCard: result.ok ? toGiftCard(result.value) : null,
    userErrors: result.ok ? [] : UserError.list(result.errors),
  });
}

function transactionPayload(result: MutationResult<GiftCardChange>): GiftCardTransactionPayload {
  const card = result.ok ? toGiftCard(result.value.giftCard) : null;
  return Object.assign(new GiftCardTransactionPayload(), {
    giftCard: card,
    giftCardTransaction: result.ok ? toTransaction(result.value.transaction, card!) : null,
    userErrors: result.ok ? [] : UserError.list(result.errors),
  });
}

function timeCursorAfter(after: string | null | undefined): { at: string; id: string } | null {
  if (!after) return null;
  const cursor = decodeTimeCursor(after);
  if (!isUuid(cursor.id)) throw badUserInput('Invalid cursor');
  return cursor;
}

export function toGiftCard(record: GiftCardRecord): GiftCard {
  const amount = (value: bigint) => Money.from(money(value, record.currency));
  return Object.assign(new GiftCard(), {
    id: toPublicId('giftCard', record.id),
    lastCharacters: record.lastCharacters,
    maskedCode: `•••• •••• •••• ${record.lastCharacters}`,
    initialValue: amount(record.initialValue),
    balance: amount(record.balance),
    expiresOn: record.expiresOn,
    expired: record.expired,
    enabled: record.deactivatedAt === null,
    deactivatedAt: record.deactivatedAt,
    note: record.note,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    uuid: record.id,
    customerUuid: record.customerId,
  });
}

function toTransaction(record: GiftCardTransactionRecord, card: GiftCard): GiftCardTransaction {
  const currency = card.balance.currencyCode;
  const amount = (value: bigint) => Money.from(money(value, currency as CurrencyCode));
  return Object.assign(new GiftCardTransaction(), {
    id: toPublicId('giftCardTransaction', record.id),
    kind: record.kind.toUpperCase() as GiftCardTransactionKind,
    amount: amount(record.amount),
    balanceAfterTransaction: amount(record.balanceAfter),
    orderId: record.orderId ? toPublicId('order', record.orderId) : null,
    note: record.note,
    processedAt: record.createdAt,
  });
}
