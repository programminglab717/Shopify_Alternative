// Gift cards (CAT-12, PAY-13, ADR-448): a code worth an amount at the shop, as Shopify's GiftCard.
// Whoever has the code spends it until its balance is used up, it expires, or the shop
// deactivates it. The shop keeps a digest of the code alone, shown whole once, when it is issued,
// and its last four characters to tell it by. Its balance is kept on it, changed only holding its
// lock, and its ledger keeps every change in the order it was made.

import { createHash, randomInt } from 'node:crypto';
import {
  InputChecker,
  actorColumnsOf,
  failOne,
  shopProfile,
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

export const GIFT_CARD_KINDS = ['issue', 'credit', 'debit', 'debit_revert'] as const;
export type GiftCardKindValue = (typeof GIFT_CARD_KINDS)[number];

export const GIFT_CARD_LIMITS = {
  /** The most a card holds, in its currency's major units: Rs 100,000. */
  value: 100_000,
  note: 500,
  /** A code the shop chooses: letters and digits, as Shopify's. */
  codeMin: 8,
  codeMax: 20,
} as const;

/** The letters and digits codes are made of: none that reads as another, as O and 0 do. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Characters of a code the shop leaves to Hatti: 80 random bits. */
const CODE_LENGTH = 16;

/** A new code: 16 letters and digits, which no one guesses. */
export function newGiftCardCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** A code as it is kept and compared: without spaces or dashes, in capitals. */
export function normalizeGiftCardCode(typed: string): string {
  return typed.replace(/[\s-]/g, '').toUpperCase();
}

/** The digest a code is kept as. */
export function giftCardDigest(code: string): Buffer {
  return createHash('sha256').update(normalizeGiftCardCode(code)).digest();
}

/** A code in groups of four, as it is printed and read out: "ABCD EFGH JKLM NPQR". */
export function formatGiftCardCode(code: string): string {
  return normalizeGiftCardCode(code).replace(/(.{4})(?=.)/g, '$1 ');
}

/** How a card that can't be spent tells why. */
export type GiftCardRefusal = 'expired' | 'deactivated' | 'empty';

export interface GiftCardRecord {
  id: string;
  /** The code's last four characters, to tell it by. */
  lastCharacters: string;
  currency: CurrencyCode;
  /** Minor units. */
  initialValue: bigint;
  balance: bigint;
  /** The last day it can be spent, YYYY-MM-DD in the shop's time zone; null for never. */
  expiresOn: string | null;
  customerId: string | null;
  note: string;
  deactivatedAt: Date | null;
  /** Past its last day, in the shop's time zone, when it was read. */
  expired: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface GiftCardTransactionRecord {
  id: string;
  giftCardId: string;
  kind: GiftCardKindValue;
  /** Minor units, signed: what it added to the balance, or took from it. */
  amount: bigint;
  balanceAfter: bigint;
  orderId: string | null;
  note: string;
  createdAt: Date;
  /** Where it sorts, to the microsecond, for the page after it. */
  at: string;
}

/** A card just issued, with its code, which is never shown again. */
export interface GiftCardIssued {
  giftCard: GiftCardRecord;
  code: string;
}

/** A card and the transaction that just changed it. */
export interface GiftCardChange {
  giftCard: GiftCardRecord;
  transaction: GiftCardTransactionRecord;
}

/** A card to issue, as giftCardCreate takes it. */
export interface GiftCardCreateInput {
  /** In major units, like "5000". */
  initialValue: string;
  /** The shop's own code: 8 to 20 letters and digits; one is made when left out. */
  code?: string | null;
  /** YYYY-MM-DD: the last day it can be spent; never, unless given. */
  expiresOn?: string | null;
  customerId?: string | null;
  note?: string | null;
}

/** What giftCardUpdate changes: each left out stays as it is; null takes it away. */
export interface GiftCardUpdateInput {
  expiresOn?: string | null;
  customerId?: string | null;
  note?: string | null;
}

/** A credit or debit by hand. */
export interface GiftCardAdjustInput {
  /** In major units. */
  amount: string;
  note?: string | null;
}

type CardRow = {
  id: string;
  last_characters: string;
  currency: CurrencyCode;
  initial_value: string;
  balance: string;
  expires_on: string | null;
  customer_id: string | null;
  note: string;
  deactivated_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
  at_exactly: string;
};

type TransactionRow = {
  id: string;
  gift_card_id: string;
  kind: GiftCardKindValue;
  amount: string;
  balance_after: string;
  order_id: string | null;
  note: string;
  created_at: string | Date;
  at_exactly: string;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The day it is at `at` in `timeZone`: YYYY-MM-DD. */
export function dayIn(timeZone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

@Injectable()
export class GiftCardService {
  constructor(private readonly db: Database) {}

  /**
   * The shop's cards, the newest first; with `query`, those whose code ends with it, as staff
   * read the last characters off a card.
   */
  async list(
    tenant: TenantContext,
    options: { first: number; after?: { at: string; id: string } | null; query?: string | null },
    at: Date = new Date(),
  ): Promise<Page<GiftCardRecord & { at: string }>> {
    const { shopId } = tenant;
    const ending = normalizeGiftCardCode(options.query ?? '').slice(-4);
    return this.db.tenant(shopId, async (tx) => {
      const today = dayIn((await shopProfile(tx, shopId)).timezone, at);
      const { rows } = await tx.execute<CardRow>(sql`
        SELECT ${CARD_COLUMNS} FROM customers.gift_cards
         WHERE shop_id = ${shopId}
           AND ${ending ? sql`last_characters LIKE ${'%' + ending}` : sql`true`}
           AND ${
             options.after
               ? sql`(created_at, id) < (${options.after.at}::timestamptz, ${options.after.id}::uuid)`
               : sql`true`
           }
         ORDER BY created_at DESC, id DESC
         LIMIT ${options.first + 1}`);
      return {
        items: rows
          .slice(0, options.first)
          .map((row) => ({ ...toCard(row, today), at: row.at_exactly })),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  async get(
    tenant: TenantContext,
    id: string,
    at: Date = new Date(),
  ): Promise<GiftCardRecord | null> {
    return this.db.tenant(tenant.shopId, (tx) => giftCardIn(tx, tenant.shopId, id, at));
  }

  /** A card's ledger, the newest first. */
  async transactions(
    tenant: TenantContext,
    giftCardId: string,
    options: { first: number; after?: { at: string; id: string } | null },
  ): Promise<Page<GiftCardTransactionRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await ledgerIn(tx, tenant.shopId, giftCardId, {
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
   * Issues a card, as Shopify's giftCardCreate: worth `initialValue` in the shop's currency, with
   * the shop's own code or one made for it, which is given back this once. Audited.
   */
  async create(
    tenant: TenantContext,
    input: GiftCardCreateInput,
    at: Date = new Date(),
  ): Promise<MutationResult<GiftCardIssued>> {
    const { shopId, currency } = tenant;
    const check = new InputChecker();
    const value = checkAmount(check, ['input', 'initialValue'], input.initialValue, currency);
    const typed = input.code?.trim() ? normalizeGiftCardCode(input.code) : null;
    if (
      typed !== null &&
      (!/^[A-Z0-9]+$/.test(typed) ||
        typed.length < GIFT_CARD_LIMITS.codeMin ||
        typed.length > GIFT_CARD_LIMITS.codeMax)
    ) {
      check.addMessage(
        ['input', 'code'],
        'INVALID',
        `A code is ${GIFT_CARD_LIMITS.codeMin} to ${GIFT_CARD_LIMITS.codeMax} letters and digits`,
      );
    }
    const note = check.text(['input', 'note'], input.note, { max: GIFT_CARD_LIMITS.note }) ?? '';
    const expiresOn = input.expiresOn?.trim() || null;
    if (expiresOn !== null && !isDay(expiresOn)) {
      check.addMessage(['input', 'expiresOn'], 'INVALID', 'Give a day, like 2026-12-31');
    }
    if (!check.ok || value === null) return { ok: false, errors: check.errors };
    const code = typed ?? newGiftCardCode();
    return this.db.tenant(shopId, async (tx) => {
      const today = dayIn((await shopProfile(tx, shopId)).timezone, at);
      if (expiresOn !== null && expiresOn < today) {
        return failOne(['input', 'expiresOn'], 'INVALID', 'It must expire today or later');
      }
      const customerId = input.customerId ?? null;
      if (customerId && !(await customerExists(tx, shopId, customerId))) {
        return failOne(['input', 'customerId'], 'NOT_FOUND', 'Customer not found');
      }
      const id = newId();
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO customers.gift_cards
               (shop_id, id, code_hash, last_characters, currency, initial_value, balance,
                expires_on, customer_id, note)
        VALUES (${shopId}, ${id}, ${giftCardDigest(code)}, ${code.slice(-4)}, ${currency},
                ${value}, ${value}, ${expiresOn}::date, ${customerId}, ${note})
        ON CONFLICT (shop_id, code_hash) DO NOTHING
        RETURNING id`);
      if (rows.length === 0) {
        return failOne(['input', 'code'], 'TAKEN', 'Another gift card has this code');
      }
      await addTransaction(tx, shopId, tenant.actor, {
        giftCardId: id,
        kind: 'issue',
        amount: value,
        balanceAfter: value,
        orderId: null,
        sourceId: null,
        note: '',
      });
      await recordAudit(tx, shopId, {
        action: 'gift_card.created',
        subjectType: 'giftCard',
        subjectId: id,
        ...actorColumnsOf(tenant.actor),
        details: {
          lastCharacters: code.slice(-4),
          initialValue: toMajorString(money(value, currency)),
          expiresOn,
        },
      });
      const giftCard = (await giftCardIn(tx, shopId, id, at))!;
      return { ok: true, value: { giftCard, code } };
    });
  }

  /** Changes a card's expiry, who it was given to, or its note, as Shopify's giftCardUpdate. */
  async update(
    tenant: TenantContext,
    id: string,
    input: GiftCardUpdateInput,
    at: Date = new Date(),
  ): Promise<MutationResult<GiftCardRecord>> {
    const { shopId } = tenant;
    const check = new InputChecker();
    const note =
      input.note === undefined
        ? undefined
        : (check.text(['input', 'note'], input.note, { max: GIFT_CARD_LIMITS.note }) ?? '');
    const expiresOn = input.expiresOn === undefined ? undefined : input.expiresOn?.trim() || null;
    if (expiresOn && !isDay(expiresOn)) {
      check.addMessage(['input', 'expiresOn'], 'INVALID', 'Give a day, like 2026-12-31');
    }
    if (!check.ok) return { ok: false, errors: check.errors };
    return this.db.tenant(shopId, async (tx) => {
      const card = await lockCard(tx, shopId, id);
      if (!card) return failOne(['id'], 'NOT_FOUND', 'Gift card not found');
      if (card.deactivated_at) {
        return failOne(['id'], 'INVALID', 'A deactivated gift card can’t be changed');
      }
      const today = dayIn((await shopProfile(tx, shopId)).timezone, at);
      if (expiresOn && expiresOn < today) {
        return failOne(['input', 'expiresOn'], 'INVALID', 'It must expire today or later');
      }
      const customerId = input.customerId;
      if (customerId && !(await customerExists(tx, shopId, customerId))) {
        return failOne(['input', 'customerId'], 'NOT_FOUND', 'Customer not found');
      }
      await tx.execute(sql`
        UPDATE customers.gift_cards
           SET expires_on = ${expiresOn === undefined ? sql`expires_on` : sql`${expiresOn}::date`},
               customer_id = ${customerId === undefined ? sql`customer_id` : sql`${customerId}::uuid`},
               note = ${note === undefined ? sql`note` : note},
               updated_at = now()
         WHERE shop_id = ${shopId} AND id = ${id}`);
      await recordAudit(tx, shopId, {
        action: 'gift_card.updated',
        subjectType: 'giftCard',
        subjectId: id,
        ...actorColumnsOf(tenant.actor),
        details: {
          lastCharacters: card.last_characters,
          ...(expiresOn !== undefined && { expiresOn }),
          ...(customerId !== undefined && {
            customer: customerId ? toPublicId('customer', customerId) : null,
          }),
        },
      });
      return { ok: true, value: (await giftCardIn(tx, shopId, id, at))! };
    });
  }

  /** Deactivates a card for good, as Shopify's giftCardDeactivate: it is spent no more. */
  async deactivate(
    tenant: TenantContext,
    id: string,
    at: Date = new Date(),
  ): Promise<MutationResult<GiftCardRecord>> {
    const { shopId } = tenant;
    return this.db.tenant(shopId, async (tx) => {
      const card = await lockCard(tx, shopId, id);
      if (!card) return failOne(['id'], 'NOT_FOUND', 'Gift card not found');
      if (!card.deactivated_at) {
        await tx.execute(sql`
          UPDATE customers.gift_cards SET deactivated_at = now(), updated_at = now()
           WHERE shop_id = ${shopId} AND id = ${id}`);
        await recordAudit(tx, shopId, {
          action: 'gift_card.deactivated',
          subjectType: 'giftCard',
          subjectId: id,
          ...actorColumnsOf(tenant.actor),
          details: {
            lastCharacters: card.last_characters,
            balance: toMajorString(money(BigInt(card.balance), card.currency)),
          },
        });
      }
      return { ok: true, value: (await giftCardIn(tx, shopId, id, at))! };
    });
  }

  /** Adds to a card's balance by hand, as Shopify's giftCardCredit. Audited. */
  async credit(
    tenant: TenantContext,
    id: string,
    input: GiftCardAdjustInput,
    at: Date = new Date(),
  ): Promise<MutationResult<GiftCardChange>> {
    return this.#adjust(tenant, id, input, 'credit', at);
  }

  /** Takes from a card's balance by hand, as Shopify's giftCardDebit. Audited. */
  async debit(
    tenant: TenantContext,
    id: string,
    input: GiftCardAdjustInput,
    at: Date = new Date(),
  ): Promise<MutationResult<GiftCardChange>> {
    return this.#adjust(tenant, id, input, 'debit', at);
  }

  async #adjust(
    tenant: TenantContext,
    id: string,
    input: GiftCardAdjustInput,
    kind: 'credit' | 'debit',
    at: Date,
  ): Promise<MutationResult<GiftCardChange>> {
    const { shopId } = tenant;
    const field = [`${kind}Input`];
    const check = new InputChecker();
    const amount = checkAmount(check, [...field, 'amount'], input.amount, tenant.currency);
    const note = check.text([...field, 'note'], input.note, { max: GIFT_CARD_LIMITS.note }) ?? '';
    if (!check.ok || amount === null) return { ok: false, errors: check.errors };
    return this.db.tenant(shopId, async (tx) => {
      const card = await lockCard(tx, shopId, id);
      if (!card) return failOne(['id'], 'NOT_FOUND', 'Gift card not found');
      if (card.deactivated_at) {
        return failOne(['id'], 'INVALID', 'A deactivated gift card can’t be changed');
      }
      const balance = BigInt(card.balance);
      const format = (value: bigint) => formatMoney(money(value, card.currency));
      const limit = fromMajor(GIFT_CARD_LIMITS.value, card.currency).amount;
      if (kind === 'credit' && balance + amount > limit) {
        return failOne(
          [...field, 'amount'],
          'CREDIT_LIMIT_EXCEEDED',
          `A gift card holds at most ${format(limit)}, and this one has ${format(balance)}`,
        );
      }
      if (kind === 'debit' && amount > balance) {
        return failOne(
          [...field, 'amount'],
          'INSUFFICIENT_FUNDS',
          balance === 0n
            ? 'This gift card has nothing left'
            : `This gift card has ${format(balance)}`,
        );
      }
      const after = kind === 'credit' ? balance + amount : balance - amount;
      const transactionId = await changeBalance(tx, shopId, tenant.actor, card, {
        kind,
        amount,
        balanceAfter: after,
        orderId: null,
        sourceId: null,
        note,
      });
      await recordAudit(tx, shopId, {
        action: `gift_card.${kind === 'credit' ? 'credited' : 'debited'}`,
        subjectType: 'giftCard',
        subjectId: id,
        ...actorColumnsOf(tenant.actor),
        details: {
          lastCharacters: card.last_characters,
          amount: toMajorString(money(amount, card.currency)),
        },
      });
      const [row] = await ledgerIn(tx, shopId, id, { only: transactionId, limit: 1 });
      return {
        ok: true,
        value: {
          giftCard: (await giftCardIn(tx, shopId, id, at))!,
          transaction: toTransaction(row!),
        },
      };
    });
  }
}

/** Why a card can't be spent at `at`: deactivated, past its last day, or empty; null if it can. */
export function giftCardRefusalOf(card: GiftCardRecord): GiftCardRefusal | null {
  if (card.deactivatedAt) return 'deactivated';
  if (card.expired) return 'expired';
  if (card.balance === 0n) return 'empty';
  return null;
}

/** The shop's card whose code is `typed`, as a shopper types it; null for none. */
export async function giftCardByCodeIn(
  tx: Tx,
  shopId: string,
  typed: string,
  at: Date = new Date(),
): Promise<GiftCardRecord | null> {
  const code = normalizeGiftCardCode(typed);
  if (code.length < GIFT_CARD_LIMITS.codeMin || code.length > GIFT_CARD_LIMITS.codeMax) return null;
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM customers.gift_cards
     WHERE shop_id = ${shopId} AND code_hash = ${giftCardDigest(code)}`);
  return rows[0] ? giftCardIn(tx, shopId, rows[0].id, at) : null;
}

/** Card `id` as it is at `at`, in the caller's transaction; null if there is none. */
export async function giftCardOfIn(
  tx: Tx,
  shopId: string,
  id: string,
  at: Date = new Date(),
): Promise<GiftCardRecord | null> {
  return giftCardIn(tx, shopId, id, at);
}

/**
 * Spends up to `most` of card `giftCardId` on order `orderId`, in the caller's transaction,
 * holding the card's lock (ADR-449): what it has, or `most` if it has more. What it spent, or why
 * it can spend nothing.
 */
export async function spendGiftCardIn(
  tx: Tx,
  shopId: string,
  spend: { giftCardId: string; most: bigint; orderId: string },
  at: Date = new Date(),
): Promise<{ ok: true; spent: bigint } | { ok: false; refusal: GiftCardRefusal | 'unknown' }> {
  const row = await lockCard(tx, shopId, spend.giftCardId);
  if (!row) return { ok: false, refusal: 'unknown' };
  const card = toCard(row, dayIn((await shopProfile(tx, shopId)).timezone, at));
  const refusal = giftCardRefusalOf(card);
  if (refusal) return { ok: false, refusal };
  if (spend.most <= 0n) return { ok: true, spent: 0n };
  const spent = card.balance < spend.most ? card.balance : spend.most;
  await changeBalance(tx, shopId, 'system', row, {
    kind: 'debit',
    amount: spent,
    balanceAfter: card.balance - spent,
    orderId: spend.orderId,
    sourceId: null,
    note: '',
  });
  return { ok: true, spent };
}

/** What gift cards paid of order `orderId` and was not given back. */
export async function giftCardsPaidIn(tx: Tx, shopId: string, orderId: string): Promise<bigint> {
  const { rows } = await tx.execute<{ paid: string }>(sql`
    SELECT coalesce(sum(d.amount), 0)::text AS paid FROM customers.gift_card_transactions d
     WHERE d.shop_id = ${shopId} AND d.order_id = ${orderId} AND d.kind = 'debit'
       AND NOT EXISTS (SELECT 1 FROM customers.gift_card_transactions r
                        WHERE r.shop_id = d.shop_id AND r.kind = 'debit_revert'
                          AND r.source_id = d.id)`);
  return BigInt(rows[0]!.paid);
}

/** The cards that paid order `orderId`, by their last characters, and what each paid. */
export async function giftCardPaymentsIn(
  tx: Tx,
  shopId: string,
  orderId: string,
): Promise<{ giftCardId: string; lastCharacters: string; amount: bigint }[]> {
  const { rows } = await tx.execute<{ id: string; last_characters: string; amount: string }>(sql`
    SELECT c.id, c.last_characters, sum(d.amount)::text AS amount
      FROM customers.gift_card_transactions d
      JOIN customers.gift_cards c ON c.shop_id = d.shop_id AND c.id = d.gift_card_id
     WHERE d.shop_id = ${shopId} AND d.order_id = ${orderId} AND d.kind = 'debit'
       AND NOT EXISTS (SELECT 1 FROM customers.gift_card_transactions r
                        WHERE r.shop_id = d.shop_id AND r.kind = 'debit_revert'
                          AND r.source_id = d.id)
     GROUP BY c.id, c.last_characters
     ORDER BY min(d.created_at), c.id`);
  return rows.map((row) => ({
    giftCardId: row.id,
    lastCharacters: row.last_characters,
    amount: BigInt(row.amount),
  }));
}

/**
 * Gives back to their cards every debit that paid order `orderId` and was not given back yet, in
 * the caller's transaction, as when the order is cancelled (ADR-449): to cards deactivated or
 * past their day too, as Shopify does. What it gave back.
 */
export async function revertOrderGiftCardsIn(
  tx: Tx,
  shopId: string,
  actor: Actor | 'system',
  orderId: string,
): Promise<bigint> {
  const { rows: debits } = await tx.execute<{ id: string; gift_card_id: string; amount: string }>(
    sql`
      SELECT d.id, d.gift_card_id, d.amount::text AS amount
        FROM customers.gift_card_transactions d
       WHERE d.shop_id = ${shopId} AND d.order_id = ${orderId} AND d.kind = 'debit'
         AND NOT EXISTS (SELECT 1 FROM customers.gift_card_transactions r
                          WHERE r.shop_id = d.shop_id AND r.kind = 'debit_revert'
                            AND r.source_id = d.id)
       ORDER BY d.created_at, d.id`,
  );
  let given = 0n;
  for (const debit of debits) {
    const card = await lockCard(tx, shopId, debit.gift_card_id);
    if (!card) continue;
    const amount = BigInt(debit.amount);
    await changeBalance(tx, shopId, actor, card, {
      kind: 'debit_revert',
      amount,
      balanceAfter: BigInt(card.balance) + amount,
      orderId,
      sourceId: debit.id,
      note: '',
    });
    given += amount;
  }
  return given;
}

/** A card issued for a unit of a gift card product sold (CAT-12, ADR-451), its code this once. */
export interface SoldGiftCard {
  id: string;
  code: string;
  /** Which unit of its order line it is, from 1. */
  unit: number;
}

/**
 * Issues the cards an order line of a gift card product sold (CAT-12, ADR-451), in the caller's
 * transaction: one for each of its `units`, worth `value`, given to the order's customer, as the
 * system. A unit with its card issued already is passed over, so the line's cards are issued
 * once however often this is asked; those issued now are given back with their codes, the only
 * time anyone sees them. Its ledger keeps who: the system, for the order.
 */
export async function issueSoldGiftCardsIn(
  tx: Tx,
  shopId: string,
  sale: {
    orderId: string;
    lineItemId: string;
    units: number;
    value: bigint;
    currency: string;
    customerId: string | null;
    note: string;
  },
): Promise<SoldGiftCard[]> {
  const issued: SoldGiftCard[] = [];
  for (let unit = 1; unit <= sale.units; unit += 1) {
    // A code that happens to be taken is made again; a unit issued already is left.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = newId();
      const code = newGiftCardCode();
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO customers.gift_cards
               (shop_id, id, code_hash, last_characters, currency, initial_value, balance,
                customer_id, note, order_id, line_item_id, line_unit)
        VALUES (${shopId}, ${id}, ${giftCardDigest(code)}, ${code.slice(-4)}, ${sale.currency},
                ${sale.value}, ${sale.value}, ${sale.customerId}, ${sale.note}, ${sale.orderId},
                ${sale.lineItemId}, ${unit})
        ON CONFLICT DO NOTHING
        RETURNING id`);
      if (rows.length > 0) {
        await addTransaction(tx, shopId, 'system', {
          giftCardId: id,
          kind: 'issue',
          amount: sale.value,
          balanceAfter: sale.value,
          orderId: sale.orderId,
          sourceId: null,
          note: '',
        });
        issued.push({ id, code, unit });
        break;
      }
      const { rows: had } = await tx.execute(sql`
        SELECT 1 FROM customers.gift_cards
         WHERE shop_id = ${shopId} AND line_item_id = ${sale.lineItemId} AND line_unit = ${unit}`);
      if (had.length > 0) break;
    }
  }
  return issued;
}

/**
 * The cards given to a customer, in the caller's transaction: what their own file says
 * (ADR-448). The code is not in it: the shop keeps none.
 */
export async function giftCardsOfCustomerIn(
  tx: Tx,
  shopId: string,
  customerId: string,
  at: Date = new Date(),
): Promise<GiftCardRecord[]> {
  const today = dayIn((await shopProfile(tx, shopId)).timezone, at);
  const { rows } = await tx.execute<CardRow>(sql`
    SELECT ${CARD_COLUMNS} FROM customers.gift_cards
     WHERE shop_id = ${shopId} AND customer_id = ${customerId}
     ORDER BY created_at, id`);
  return rows.map((row) => toCard(row, today));
}

/** Moves the cards given to a merged duplicate to the customer they were merged into. */
export async function mergeGiftCardsIn(
  tx: Tx,
  shopId: string,
  fromId: string,
  intoId: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE customers.gift_cards SET customer_id = ${intoId}, updated_at = now()
     WHERE shop_id = ${shopId} AND customer_id = ${fromId}`);
}

const CARD_COLUMNS = sql`id, last_characters, currency, initial_value::text AS initial_value,
  balance::text AS balance, to_char(expires_on, 'YYYY-MM-DD') AS expires_on, customer_id, note,
  deactivated_at, created_at, updated_at, ${exactTime(sql.raw('created_at'))} AS at_exactly`;

function isDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function checkAmount(
  check: InputChecker,
  field: string[],
  value: string,
  currency: CurrencyCode,
): bigint | null {
  const amount = check.price(field, value, currency, { required: true });
  if (amount === null) return null;
  const limit = fromMajor(GIFT_CARD_LIMITS.value, currency).amount;
  if (amount === 0n) check.addMessage(field, 'INVALID', 'It must be more than 0');
  else if (amount > limit) {
    check.addMessage(
      field,
      'INVALID',
      `A gift card holds at most ${formatMoney(money(limit, currency))}`,
    );
  }
  return amount;
}

async function customerExists(tx: Tx, shopId: string, customerId: string): Promise<boolean> {
  const { rows } = await tx.execute(sql`
    SELECT 1 FROM customers.customers WHERE shop_id = ${shopId} AND id = ${customerId}`);
  return rows.length > 0;
}

/** Card `id` as it is at `at`; null if there is none. */
async function giftCardIn(
  tx: Tx,
  shopId: string,
  id: string,
  at: Date,
): Promise<GiftCardRecord | null> {
  const { rows } = await tx.execute<CardRow>(sql`
    SELECT ${CARD_COLUMNS} FROM customers.gift_cards WHERE shop_id = ${shopId} AND id = ${id}`);
  const row = rows[0];
  if (!row) return null;
  return toCard(row, dayIn((await shopProfile(tx, shopId)).timezone, at));
}

/** Card `id`, locked for a change of its balance; null if there is none. */
async function lockCard(tx: Tx, shopId: string, id: string): Promise<CardRow | null> {
  const { rows } = await tx.execute<CardRow>(sql`
    SELECT ${CARD_COLUMNS} FROM customers.gift_cards
     WHERE shop_id = ${shopId} AND id = ${id}
       FOR UPDATE`);
  return rows[0] ?? null;
}

/** Sets the locked card's balance, with the transaction that changed it. The transaction's ID. */
async function changeBalance(
  tx: Tx,
  shopId: string,
  actor: Actor | 'system',
  card: CardRow,
  change: Omit<Parameters<typeof addTransaction>[3], 'giftCardId'>,
): Promise<string> {
  await tx.execute(sql`
    UPDATE customers.gift_cards SET balance = ${change.balanceAfter}, updated_at = now()
     WHERE shop_id = ${shopId} AND id = ${card.id}`);
  return addTransaction(tx, shopId, actor, { ...change, giftCardId: card.id });
}

async function addTransaction(
  tx: Tx,
  shopId: string,
  actor: Actor | 'system',
  change: {
    giftCardId: string;
    kind: GiftCardKindValue;
    amount: bigint;
    balanceAfter: bigint;
    orderId: string | null;
    sourceId: string | null;
    note: string;
  },
): Promise<string> {
  const id = newId();
  const { actorKind, actorId } =
    actor === 'system' ? { actorKind: 'system' as const, actorId: null } : actorColumnsOf(actor);
  await tx.execute(sql`
    INSERT INTO customers.gift_card_transactions
           (shop_id, id, gift_card_id, kind, amount, balance_after, order_id, source_id, note,
            actor_kind, actor_id)
    VALUES (${shopId}, ${id}, ${change.giftCardId}, ${change.kind}, ${change.amount},
            ${change.balanceAfter}, ${change.orderId}, ${change.sourceId}, ${change.note},
            ${actorKind}, ${actorId})`);
  return id;
}

/** A card's ledger, the newest first: those before `before` only, or transaction `only`. */
async function ledgerIn(
  tx: Tx,
  shopId: string,
  giftCardId: string,
  options: { before?: { at: string; id: string } | null; only?: string; limit: number },
): Promise<TransactionRow[]> {
  const { before, only } = options;
  const { rows } = await tx.execute<TransactionRow>(sql`
    SELECT id, gift_card_id, kind, amount::text AS amount, balance_after::text AS balance_after,
           order_id, note, created_at, ${exactTime(sql.raw('created_at'))} AS at_exactly
      FROM customers.gift_card_transactions
     WHERE shop_id = ${shopId} AND gift_card_id = ${giftCardId}
       AND ${only ? sql`id = ${only}` : sql`true`}
       AND ${
         before
           ? sql`(created_at, id) < (${before.at}::timestamptz, ${before.id}::uuid)`
           : sql`true`
       }
     ORDER BY created_at DESC, id DESC
     LIMIT ${options.limit}`);
  return rows;
}

function toCard(row: CardRow, today: string): GiftCardRecord {
  return {
    id: row.id,
    lastCharacters: row.last_characters,
    currency: row.currency,
    initialValue: BigInt(row.initial_value),
    balance: BigInt(row.balance),
    expiresOn: row.expires_on,
    customerId: row.customer_id,
    note: row.note,
    deactivatedAt: toDateOrNull(row.deactivated_at),
    expired: row.expires_on !== null && row.expires_on < today,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function toTransaction(row: TransactionRow): GiftCardTransactionRecord {
  const amount = BigInt(row.amount);
  return {
    id: row.id,
    giftCardId: row.gift_card_id,
    kind: row.kind,
    amount: row.kind === 'debit' ? -amount : amount,
    balanceAfter: BigInt(row.balance_after),
    orderId: row.order_id,
    note: row.note,
    createdAt: toDate(row.created_at),
    at: row.at_exactly,
  };
}
