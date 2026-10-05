import { Database, toDate, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import {
  MessageCharges,
  type MessageCategory,
  type MessageChannel,
  type MessageCost,
  type PhoneChannel,
} from '@hatti/messaging/public';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { BillingEvents, type CreditLowPayload } from './events.js';

// What a shop's messages cost it (BIL-03, MSG-04, ADR-155), as
// docs/product/03-pricing-and-business-model.md proposes it: what each costs Hatti, WhatsApp's by
// Meta's category of its template and an SMS's by its part, in rupees, with Hatti's fee on top,
// paid from credit the shop buys from Hatti. Meta changes its rates at the start of a quarter, and
// the SMS gateway's contract sets its own: a change here prices what is sent after it.

/**
 * Paisa: what a message costs Hatti, as researched (docs/research/03-local-ecosystem.md §4):
 * WhatsApp's per message, at Rs 280 to the dollar, and an SMS's per part. An email is not charged
 * for (ADR-181).
 */
export const MESSAGE_RATES: Readonly<
  Record<PhoneChannel, Readonly<Record<MessageCategory, bigint>>>
> = {
  whatsapp: { utility: 4_20n, authentication: 4_20n, marketing: 13_25n },
  sms: { utility: 1_50n, authentication: 1_50n, marketing: 1_50n },
};

/** Hatti's fee on what a message costs it, in percent. */
export const MESSAGE_FEES: Readonly<Record<PhoneChannel, bigint>> = { whatsapp: 10n, sms: 15n };

export const CREDIT_LIMITS = {
  /** Paisa: credit bought at a time, at least and at most, in whole rupees. */
  least: 500_00n,
  most: 100_000_00n,
  /** Entries a list shows at most. */
  entries: 100,
  /**
   * Paisa: credit below which the shop is told it runs low (ADR-169), once each time a message
   * takes it there: about twenty WhatsApp messages.
   */
  low: 100_00n,
} as const;

/**
 * Paisa: what a message, or an SMS's part, costs the shop: what it costs Hatti and Hatti's fee,
 * rounded up to the paisa.
 */
export function messagePriceOf(channel: PhoneChannel, category: MessageCategory): bigint {
  return (MESSAGE_RATES[channel][category] * (100n + MESSAGE_FEES[channel]) + 99n) / 100n;
}

export const WALLET_ENTRY_KINDS = ['top_up', 'grant', 'message', 'message_refund'] as const;
export type WalletEntryKind = (typeof WALLET_ENTRY_KINDS)[number];

/** A change to the shop's credit, as the Admin API shows it. */
export interface WalletEntryRecord {
  id: string;
  /** Credit bought, credit Hatti gave, a message paid for, or what one was charged given back. */
  kind: WalletEntryKind;
  /** Paisa: added, or taken for a message, below nothing. */
  amount: bigint;
  /** Paisa: what the wallet held after it. */
  balance: bigint;
  /** The invoice whose payment bought it. */
  invoiceId: string | null;
  /** The message paid for, and how it was priced. */
  messageId: string | null;
  cost: MessageCost | null;
  /** Why Hatti gave it. */
  note: string | null;
  createdAt: Date;
}

/** An entry to add to the shop's credit. */
export interface WalletEntry {
  kind: WalletEntryKind;
  amount: bigint;
  invoiceId?: string | null;
  messageId?: string | null;
  cost?: MessageCost | null;
  note?: string | null;
}

type WalletEntryRow = {
  id: string;
  kind: WalletEntryKind;
  amount: string;
  balance: string;
  invoice_id: string | null;
  message_id: string | null;
  channel: MessageChannel | null;
  category: MessageCategory | null;
  parts: number | null;
  note: string | null;
  created_at: string | Date;
};

/** Paisa: the shop's credit, nothing before its first entry. */
export async function balanceIn(tx: Tx, shopId: string): Promise<bigint> {
  const { rows } = await tx.execute<{ balance: string }>(sql`
    SELECT balance::text FROM billing.wallets WHERE shop_id = ${shopId}`);
  return BigInt(rows[0]?.balance ?? 0);
}

/**
 * Adds `entry` to the shop's credit in `tx`, once for its message or invoice: the wallet, made at
 * its first entry, locked for it, so that each entry says what the wallet held after it. An entry
 * that takes the credit below {@link CREDIT_LIMITS.low} tells of it (ADR-169). What the wallet
 * holds after; null for an entry made before.
 */
export async function walletEntryIn(
  tx: Tx,
  shopId: string,
  entry: WalletEntry,
): Promise<bigint | null> {
  const lock = () =>
    tx.execute<{ balance: string }>(sql`
      SELECT balance::text FROM billing.wallets WHERE shop_id = ${shopId} FOR UPDATE`);
  let { rows } = await lock();
  if (!rows[0]) {
    await tx.execute(sql`
      INSERT INTO billing.wallets (shop_id) VALUES (${shopId}) ON CONFLICT DO NOTHING`);
    ({ rows } = await lock());
  }
  const before = BigInt(rows[0]!.balance);
  const balance = before + entry.amount;
  // Timed by the clock, not the transaction: entries made in one keep their order.
  const { rows: made } = await tx.execute<{ id: string }>(sql`
    INSERT INTO billing.wallet_entries
           (shop_id, kind, amount, balance, invoice_id, message_id, channel, category, parts, note,
            created_at)
    VALUES (${shopId}, ${entry.kind}, ${entry.amount}, ${balance}, ${entry.invoiceId ?? null},
            ${entry.messageId ?? null}, ${entry.cost?.channel ?? null},
            ${entry.cost?.category ?? null}, ${entry.cost?.parts ?? null}, ${entry.note ?? null},
            clock_timestamp())
        ON CONFLICT DO NOTHING
    RETURNING id`);
  if (made.length === 0) return null;
  await tx.execute(sql`
    UPDATE billing.wallets SET balance = ${balance}, version = version + 1, updated_at = now()
     WHERE shop_id = ${shopId}`);
  if (before >= CREDIT_LIMITS.low && balance < CREDIT_LIMITS.low) {
    await appendEvent<CreditLowPayload>(tx, shopId, {
      type: BillingEvents.CreditLow,
      aggregateType: 'shop',
      aggregateId: shopId,
      payload: { balance: String(balance) },
    });
  }
  return balance;
}

/** The shop's entries, the newest first. */
export async function walletEntriesIn(
  tx: Tx,
  shopId: string,
  first: number,
): Promise<WalletEntryRecord[]> {
  const limit = Math.max(1, Math.min(first, CREDIT_LIMITS.entries));
  const { rows } = await tx.execute<WalletEntryRow>(sql`
    SELECT id, kind, amount::text, balance::text, invoice_id, message_id, channel, category, parts,
           note, created_at
      FROM billing.wallet_entries
     WHERE shop_id = ${shopId}
     ORDER BY created_at DESC, id DESC
     LIMIT ${limit}`);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    amount: BigInt(row.amount),
    balance: BigInt(row.balance),
    invoiceId: row.invoice_id,
    messageId: row.message_id,
    cost:
      row.channel && row.category && row.parts !== null
        ? { channel: row.channel, category: row.category, parts: row.parts }
        : null,
    note: row.note,
    createdAt: toDate(row.created_at),
  }));
}

/**
 * The shop's message credit (ADR-155), which the messaging module pays its messages from through
 * {@link MessageCharges}: each at its price as it is sent, and given back when WhatsApp says it
 * could not deliver it.
 */
@Injectable()
export class MessageWallet extends MessageCharges {
  constructor(private readonly db: Database) {
    super();
  }

  priceOf(cost: MessageCost): bigint {
    // Never charged for (ADR-181): nothing, should one be priced.
    if (cost.channel === 'email') return 0n;
    return messagePriceOf(cost.channel, cost.category) * BigInt(cost.parts);
  }

  async balanceOf(shopId: string): Promise<bigint> {
    return this.db.tenant(shopId, (tx) => balanceIn(tx, shopId));
  }

  async chargeIn(tx: Tx, shopId: string, id: string, cost: MessageCost): Promise<void> {
    await walletEntryIn(tx, shopId, {
      kind: 'message',
      amount: -this.priceOf(cost),
      messageId: id,
      cost,
    });
  }

  async refundIn(tx: Tx, shopId: string, id: string): Promise<void> {
    const { rows } = await tx.execute<{
      amount: string;
      channel: MessageChannel;
      category: MessageCategory;
      parts: number;
    }>(sql`
      SELECT amount::text, channel, category, parts FROM billing.wallet_entries
       WHERE shop_id = ${shopId} AND message_id = ${id} AND kind = 'message'`);
    const charged = rows[0];
    if (!charged) return;
    await walletEntryIn(tx, shopId, {
      kind: 'message_refund',
      amount: -BigInt(charged.amount),
      messageId: id,
      cost: { channel: charged.channel, category: charged.category, parts: charged.parts },
    });
  }
}
