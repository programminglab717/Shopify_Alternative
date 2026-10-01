import {
  InputChecker,
  actorColumnsOf,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, toDateOrNull, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { isValidIban, normalizeDigits } from '@hatti/pk';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { OrderEvents, type BankTransferSettingsUpdatedPayload } from './events.js';
import type { BankAccountValue } from './schema.js';

/** How long an account's details may be, in characters. */
export const BANK_TRANSFER_LIMITS = { title: 100, bankName: 100, instructions: 500 } as const;

/** How a shop's customers pay by bank transfer (ADR-074). */
export interface BankTransferSettingsRecord {
  /** Whether checkout offers bank transfer beside cash on delivery. */
  enabled: boolean;
  /** The account customers pay into, with what they are told besides; null until given. */
  account: BankAccountValue | null;
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
}

/** Fields left out stay as they are. */
export interface BankTransferSettingsInput {
  enabled?: boolean;
  /** Replaces the account; null takes it away, which only a shop not offering transfers may. */
  account?: BankAccountInput | null;
}

const NONE: BankTransferSettingsRecord = { enabled: false, account: null, updatedAt: null };

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
    updated_at: string;
  }>(sql`
    SELECT enabled, account_title, bank_name, iban, instructions, updated_at
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
          }
        : null,
    updatedAt: toDateOrNull(row.updated_at),
  };
}

/**
 * The account checkout offers customers to pay into, in the caller's transaction `tx`: the shop's,
 * while bank transfer is on; null while it is off.
 */
export async function offeredBankAccountIn(
  tx: Tx,
  shopId: string,
): Promise<BankAccountValue | null> {
  const settings = await bankTransferSettingsIn(tx, shopId);
  return settings.enabled ? settings.account : null;
}

/**
 * A shop's bank account for transfers (ADR-074): checkout offers bank transfer while it is on, and
 * every bank-transfer order keeps the account its customer was told to pay into. A change is
 * audited with the account before and after, as diverting customers' money to another account is
 * what a stolen staff login would do.
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
    if (!check.ok) return { ok: false, errors: check.errors };

    return this.db.tenant(tenant.shopId, async (tx) => {
      const current = await bankTransferSettingsIn(tx, tenant.shopId, { lock: true });
      const next = {
        enabled: input.enabled ?? current.enabled,
        account: account === undefined ? current.account : account,
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
      await tx.execute(sql`
        INSERT INTO orders.bank_transfer_settings
               (shop_id, enabled, account_title, bank_name, iban, instructions)
        VALUES (${tenant.shopId}, ${next.enabled}, ${a?.title ?? null}, ${a?.bankName ?? null},
                ${a?.iban ?? null}, ${a?.instructions ?? ''})
            ON CONFLICT (shop_id) DO UPDATE
                   SET enabled = excluded.enabled, account_title = excluded.account_title,
                       bank_name = excluded.bank_name, iban = excluded.iban,
                       instructions = excluded.instructions,
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
          before: { enabled: current.enabled, account: auditedAccount(current.account) },
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
  if (check.errors.length > errorsBefore || !title || !bankName || !iban) return null;
  return { title, bankName, iban, instructions };
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

/** What changed, by name: "enabled", "account" and "instructions". */
function changesOf(
  current: Pick<BankTransferSettingsRecord, 'enabled' | 'account'>,
  next: Pick<BankTransferSettingsRecord, 'enabled' | 'account'>,
): string[] {
  const before = current.account;
  const after = next.account;
  const changed: string[] = [];
  if (current.enabled !== next.enabled) changed.push('enabled');
  if (
    before?.title !== after?.title ||
    before?.bankName !== after?.bankName ||
    before?.iban !== after?.iban
  ) {
    changed.push('account');
  }
  if ((before?.instructions ?? '') !== (after?.instructions ?? '')) changed.push('instructions');
  return changed;
}

/** An account as the audit log keeps it: whose, at which bank, and its IBAN. */
function auditedAccount(account: BankAccountValue | null) {
  return account && { title: account.title, bankName: account.bankName, iban: account.iban };
}
