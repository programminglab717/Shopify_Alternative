import {
  InputChecker,
  actorColumnsOf,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, toDateOrNull, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { isValidIban, normalizeDigits, parsePkMobile } from '@hatti/pk';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { OrderEvents, type BankTransferSettingsUpdatedPayload } from './events.js';
import type { BankAccountValue } from './schema.js';
import {
  auditedTransferDiscount,
  checkTransferDiscount,
  sameTransferDiscount,
  type TransferDiscountInput,
  type TransferDiscountValue,
} from './transfer-discount.js';

/** How long an account's details may be, in characters. */
export const BANK_TRANSFER_LIMITS = { title: 100, bankName: 100, instructions: 500 } as const;

/** How a shop's customers pay by bank transfer (ADR-074). */
export interface BankTransferSettingsRecord {
  /** Whether checkout offers bank transfer beside cash on delivery. */
  enabled: boolean;
  /** The account customers pay into, with what they are told besides; null until given. */
  account: BankAccountValue | null;
  /** What checkout takes off orders paid by transfer (CHK-08, ADR-077); null for nothing. */
  discount: TransferDiscountValue | null;
  /** Null while the shop has never set them. */
  updatedAt: Date | null;
}

/** An account as staff type it. */
export interface BankAccountInput {
  title: string;
  bankName: string;
  /** Spaced or not, in either case: "PK36 SCBL 0000 0011 2345 6702". */
  iban: string;
  instructions?: string | null;
  /** The mobile number its bank registered for Raast, in any format; blank or null for none. */
  raastId?: string | null;
}

/** Fields left out stay as they are. */
export interface BankTransferSettingsInput {
  enabled?: boolean;
  /** Replaces the account; null takes it away, which only a shop not offering transfers may. */
  account?: BankAccountInput | null;
  /** Replaces what checkout takes off orders paid by transfer; null takes it away. */
  discount?: TransferDiscountInput | null;
}

/** Bank transfer as checkout offers it: the account to pay into, and what paying so takes off. */
export interface OfferedBankTransfer {
  account: BankAccountValue;
  discount: TransferDiscountValue | null;
}

const NONE: BankTransferSettingsRecord = {
  enabled: false,
  account: null,
  discount: null,
  updatedAt: null,
};

/** The shop's bank transfer settings, in the caller's transaction `tx`. */
export async function bankTransferSettingsIn(
  tx: Tx,
  shopId: string,
  options: { lock?: boolean } = {},
): Promise<BankTransferSettingsRecord> {
  const { rows } = await tx.execute<{
    enabled: boolean;
    account_title: string | null;
    bank_name: string | null;
    iban: string | null;
    instructions: string;
    raast_id: string | null;
    discount_bps: number | null;
    discount_cap: string | null;
    discount_amount: string | null;
    updated_at: string;
  }>(sql`
    SELECT enabled, account_title, bank_name, iban, instructions, raast_id, discount_bps,
           discount_cap, discount_amount, updated_at
      FROM orders.bank_transfer_settings
     WHERE shop_id = ${shopId}
     ${options.lock ? sql`FOR UPDATE` : sql``}`);
  const row = rows[0];
  if (!row) return NONE;
  return {
    enabled: row.enabled,
    account:
      row.account_title !== null && row.bank_name !== null && row.iban !== null
        ? {
            title: row.account_title,
            bankName: row.bank_name,
            iban: row.iban,
            instructions: row.instructions,
            raastId: row.raast_id,
          }
        : null,
    discount:
      row.discount_bps !== null
        ? {
            kind: 'percentage',
            percentageBps: row.discount_bps,
            cap: row.discount_cap === null ? null : BigInt(row.discount_cap),
          }
        : row.discount_amount !== null
          ? { kind: 'fixed_amount', amount: BigInt(row.discount_amount) }
          : null,
    updatedAt: toDateOrNull(row.updated_at),
  };
}

/**
 * Bank transfer as checkout offers it, in the caller's transaction `tx`: the shop's account, with
 * what paying by transfer takes off, while bank transfer is on; null while it is off.
 */
export async function offeredBankTransferIn(
  tx: Tx,
  shopId: string,
): Promise<OfferedBankTransfer | null> {
  const settings = await bankTransferSettingsIn(tx, shopId);
  if (!settings.enabled || !settings.account) return null;
  return { account: settings.account, discount: settings.discount };
}

/**
 * A shop's bank account for transfers (ADR-074): checkout offers bank transfer while it is on, and
 * every bank-transfer order keeps the account its customer was told to pay into; with what paying
 * by transfer takes off (CHK-08, ADR-077). A change is audited with the account and the discount
 * before and after, as diverting customers' money to another account is what a stolen staff login
 * would do.
 */
@Injectable()
export class BankTransferService {
  constructor(private readonly db: Database) {}

  get(tenant: TenantContext): Promise<BankTransferSettingsRecord> {
    return this.db.tenant(tenant.shopId, (tx) => bankTransferSettingsIn(tx, tenant.shopId));
  }

  /** Changes the settings, for orders placed from now on. */
  async update(
    tenant: TenantContext,
    input: BankTransferSettingsInput,
  ): Promise<MutationResult<BankTransferSettingsRecord>> {
    const check = new InputChecker();
    const account =
      input.account === undefined || input.account === null
        ? input.account
        : checkAccount(check, ['input', 'account'], input.account);
    const discount =
      input.discount === undefined || input.discount === null
        ? input.discount
        : checkTransferDiscount(check, ['input', 'discount'], input.discount, tenant.currency);
    if (!check.ok) return { ok: false, errors: check.errors };

    return this.db.tenant(tenant.shopId, async (tx) => {
      const current = await bankTransferSettingsIn(tx, tenant.shopId, { lock: true });
      const next = {
        enabled: input.enabled ?? current.enabled,
        account: account === undefined ? current.account : account,
        discount: discount === undefined ? current.discount : discount,
      };
      if (next.enabled && !next.account) {
        return failOne(
          input.account === null ? ['input', 'account'] : ['input', 'enabled'],
          'INVALID',
          'Bank transfer needs the account customers pay into',
        );
      }
      const changed = changesOf(current, next);
      if (changed.length === 0) return { ok: true, value: current };
      const a = next.account;
      const d = next.discount;
      const percentage = d?.kind === 'percentage' ? d : null;
      await tx.execute(sql`
        INSERT INTO orders.bank_transfer_settings
               (shop_id, enabled, account_title, bank_name, iban, instructions, raast_id,
                discount_bps, discount_cap, discount_amount)
        VALUES (${tenant.shopId}, ${next.enabled}, ${a?.title ?? null}, ${a?.bankName ?? null},
                ${a?.iban ?? null}, ${a?.instructions ?? ''}, ${a?.raastId ?? null},
                ${percentage?.percentageBps ?? null}, ${percentage?.cap ?? null},
                ${d?.kind === 'fixed_amount' ? d.amount : null})
            ON CONFLICT (shop_id) DO UPDATE
                   SET enabled = excluded.enabled, account_title = excluded.account_title,
                       bank_name = excluded.bank_name, iban = excluded.iban,
                       instructions = excluded.instructions, raast_id = excluded.raast_id,
                       discount_bps = excluded.discount_bps,
                       discount_cap = excluded.discount_cap,
                       discount_amount = excluded.discount_amount,
                       version = orders.bank_transfer_settings.version + 1, updated_at = now()`);
      const actor = actorColumnsOf(tenant.actor);
      await appendEvent<BankTransferSettingsUpdatedPayload>(tx, tenant.shopId, {
        type: OrderEvents.BankTransferSettingsUpdated,
        aggregateType: 'bank_transfer_settings',
        aggregateId: tenant.shopId,
        payload: {
          enabled: next.enabled,
          changed,
          actorKind: actor.actorKind,
          actorId: actor.actorId,
        },
      });
      await recordAudit(tx, tenant.shopId, {
        action: 'bank_transfer_settings.updated',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actor,
        details: {
          enabled: next.enabled,
          account: auditedAccount(next.account),
          discount: auditedTransferDiscount(next.discount, tenant.currency),
          before: {
            enabled: current.enabled,
            account: auditedAccount(current.account),
            discount: auditedTransferDiscount(current.discount, tenant.currency),
          },
        },
      });
      return { ok: true, value: await bankTransferSettingsIn(tx, tenant.shopId) };
    });
  }
}

/** Checks an account as typed; returns it cleaned up, or null after adding errors. */
function checkAccount(
  check: InputChecker,
  field: string[],
  input: BankAccountInput,
): BankAccountValue | null {
  const errorsBefore = check.errors.length;
  const title = check.text([...field, 'title'], input.title, {
    required: true,
    max: BANK_TRANSFER_LIMITS.title,
  });
  const bankName = check.text([...field, 'bankName'], input.bankName, {
    required: true,
    max: BANK_TRANSFER_LIMITS.bankName,
  });
  const iban = checkIban(check, [...field, 'iban'], input.iban);
  const instructions =
    check.text([...field, 'instructions'], input.instructions, {
      max: BANK_TRANSFER_LIMITS.instructions,
    }) ?? '';
  const raastText = input.raastId?.trim() ?? '';
  const raast = raastText === '' ? null : parsePkMobile(raastText);
  if (raastText !== '' && !raast) {
    check.addMessage(
      [...field, 'raastId'],
      'INVALID',
      'Give the mobile number your bank registered for Raast, like 0300 1234567',
    );
  }
  if (check.errors.length > errorsBefore || !title || !bankName || !iban) return null;
  return { title, bankName, iban, instructions, raastId: raast?.e164 ?? null };
}

/**
 * A Pakistani IBAN as banks print it, spaced or not, in either case: PK, two check digits, the
 * bank's four letters, then the 16-digit account number. Returns it unspaced, or null after
 * adding an error: a mistyped character fails its check digits.
 */
function checkIban(check: InputChecker, field: string[], input: string): string | null {
  const iban = normalizeDigits(input).replace(/[\s-]/g, '').toUpperCase();
  if (iban === '') {
    check.addMessage(field, 'BLANK', "The IBAN can't be blank");
    return null;
  }
  if (!/^PK[0-9]{2}[A-Z]{4}[0-9]{16}$/.test(iban)) {
    check.addMessage(
      field,
      'INVALID',
      'Give a Pakistani IBAN: PK, then 22 letters and digits, like PK36 SCBL 0000 0011 2345 6702',
    );
    return null;
  }
  if (!isValidIban(iban)) {
    check.addMessage(
      field,
      'INVALID',
      "The IBAN's check digits don't match it: check it for a mistyped character",
    );
    return null;
  }
  return iban;
}

/**
 * What changed, by name: "enabled", "account" (where the money goes: its title, bank, IBAN or
 * Raast ID), "instructions" and "discount".
 */
function changesOf(
  current: Pick<BankTransferSettingsRecord, 'enabled' | 'account' | 'discount'>,
  next: Pick<BankTransferSettingsRecord, 'enabled' | 'account' | 'discount'>,
): string[] {
  const before = current.account;
  const after = next.account;
  const changed: string[] = [];
  if (current.enabled !== next.enabled) changed.push('enabled');
  if (
    before?.title !== after?.title ||
    before?.bankName !== after?.bankName ||
    before?.iban !== after?.iban ||
    (before?.raastId ?? null) !== (after?.raastId ?? null)
  ) {
    changed.push('account');
  }
  if ((before?.instructions ?? '') !== (after?.instructions ?? '')) changed.push('instructions');
  if (!sameTransferDiscount(current.discount, next.discount)) changed.push('discount');
  return changed;
}

/** An account as the audit log keeps it: whose, at which bank, its IBAN and its Raast ID. */
function auditedAccount(account: BankAccountValue | null) {
  return (
    account && {
      title: account.title,
      bankName: account.bankName,
      iban: account.iban,
      raastId: account.raastId,
    }
  );
}
