import {
  InputChecker,
  actorColumnsOf,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { Database, toDate, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { newId } from '@hatti/ids';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Couriers, type CourierCredentials, type CourierInfo } from './couriers.js';
import { LogisticsEvents, type CourierAccountChangedPayload } from './events.js';

/** The couriers shops can book with here (ADR-149): the host application's. */
export const COURIERS = Symbol('COURIERS');

/** How long what the shop gives may be, and how many accounts it keeps. */
export const COURIER_ACCOUNT_LIMITS = {
  name: 100,
  credential: 1_000,
  pickupCode: 100,
  /** Accounts not archived. */
  accounts: 20,
} as const;

/** An account with a courier, as the Admin API shows it: never its credentials. */
export interface CourierAccountRecord {
  id: string;
  courier: string;
  /** "PostEx". */
  courierName: string;
  /** As staff named it, such as "PostEx Lahore". */
  name: string;
  /** The last four characters of its first credential, to tell accounts apart. */
  credentialsHint: string;
  pickupCode: string | null;
  isDefault: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A credential, by the courier's {@link CourierCredentialField.key}. */
export interface CourierCredentialInput {
  key: string;
  value: string;
}

export interface CourierAccountInput {
  /** The courier, such as "postex"; connecting only. */
  courier?: string | null;
  /** The courier's name unless given. */
  name?: string | null;
  /** All the courier asks for, all at once: replacing them replaces every one. */
  credentials?: readonly CourierCredentialInput[] | null;
  /** Blank takes it away. */
  pickupCode?: string | null;
  /** Bookings that name no account are made with the default one; the first is it. */
  isDefault?: boolean | null;
}

/** An account the worker books with, its credentials opened. */
export interface OpenedCourierAccount {
  id: string;
  courier: string;
  credentials: CourierCredentials;
  pickupCode: string | null;
  archived: boolean;
}

type AccountRow = {
  id: string;
  courier: string;
  name: string;
  credentials: string;
  credentials_hint: string;
  pickup_code: string | null;
  is_default: boolean;
  archived_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
};

/**
 * What an account's sealed credentials are bound to: they open for that shop's account alone, so
 * that none can be copied onto another.
 */
function sealedFor(shopId: string, accountId: string): string {
  return `courier-account:${shopId}:${accountId}`;
}

/**
 * The shop's accounts with couriers (SHP-01, ADR-149): the shop's own, its credentials kept
 * sealed and never shown again, as the courier remits cash on delivery to the shop directly. One
 * is the default its bookings use. An account is archived, never deleted, as its parcels are
 * still followed with it. Changes are audited, credentials never.
 */
@Injectable()
export class CourierAccountService {
  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
    @Inject(COURIERS) private readonly couriers: Couriers,
  ) {}

  /** The shop's accounts, the default first, then by name; archived ones only if asked. */
  async list(
    tenant: TenantContext,
    options: { archived?: boolean } = {},
  ): Promise<CourierAccountRecord[]> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<AccountRow>(sql`
        SELECT id, courier, name, credentials, credentials_hint, pickup_code, is_default,
               archived_at, created_at, updated_at
          FROM logistics.courier_accounts
         WHERE shop_id = ${tenant.shopId}
           ${options.archived ? sql`` : sql`AND archived_at IS NULL`}
         ORDER BY is_default DESC, archived_at IS NOT NULL, lower(name), id`);
      return rows.map((row) => this.#toRecord(row));
    });
  }

  async get(tenant: TenantContext, id: string): Promise<CourierAccountRecord | null> {
    const row = await this.db.tenant(tenant.shopId, (tx) => accountIn(tx, tenant.shopId, id));
    return row && this.#toRecord(row);
  }

  /** Connects an account with a courier: the shop's first is its default. */
  async connect(
    tenant: TenantContext,
    input: CourierAccountInput,
  ): Promise<MutationResult<CourierAccountRecord>> {
    const check = new InputChecker();
    const courier = input.courier ? this.couriers.of(input.courier.trim().toLowerCase()) : null;
    if (!courier) {
      check.add(
        ['input', 'courier'],
        input.courier ? 'INVALID' : 'BLANK',
        `must be one of the couriers shops book with: ${this.couriers.list
          .map((each) => each.courier)
          .join(', ')}`,
      );
    }
    const name = check.text(['input', 'name'], input.name, { max: COURIER_ACCOUNT_LIMITS.name });
    const pickupCode = check.text(['input', 'pickupCode'], input.pickupCode, {
      max: COURIER_ACCOUNT_LIMITS.pickupCode,
    });
    const credentials = courier
      ? this.#checkCredentials(check, courier.info, input.credentials)
      : null;
    if (!check.ok || !courier || !credentials) return { ok: false, errors: check.errors };

    return this.db.tenant(tenant.shopId, async (tx) => {
      await lockAccounts(tx, tenant.shopId);
      const { rows: counts } = await tx.execute<{ open: number; defaults: number }>(sql`
        SELECT count(*)::int AS open, count(*) FILTER (WHERE is_default)::int AS defaults
          FROM logistics.courier_accounts
         WHERE shop_id = ${tenant.shopId} AND archived_at IS NULL`);
      const { open, defaults } = counts[0]!;
      if (open >= COURIER_ACCOUNT_LIMITS.accounts) {
        return failOne(
          ['input'],
          'TOO_MANY',
          `A shop keeps ${COURIER_ACCOUNT_LIMITS.accounts} courier accounts at most: archive one first`,
        );
      }
      const isDefault = defaults === 0 || input.isDefault === true;
      if (isDefault) await clearDefault(tx, tenant.shopId);
      const id = newId();
      await tx.execute(sql`
        INSERT INTO logistics.courier_accounts (shop_id, id, courier, name, credentials,
                                                credentials_hint, pickup_code, is_default)
        VALUES (${tenant.shopId}, ${id}, ${courier.info.courier}, ${name ?? courier.info.name},
                ${this.#seal(tenant.shopId, id, credentials)}, ${hintOf(credentials)},
                ${pickupCode}, ${isDefault})`);
      await this.#record(tx, tenant, id, LogisticsEvents.CourierAccountConnected, {
        courier: courier.info.courier,
      });
      return { ok: true, value: this.#toRecord((await accountIn(tx, tenant.shopId, id))!) };
    });
  }

  /** Changes what is given; fields left out stay as they are. */
  async update(
    tenant: TenantContext,
    id: string,
    input: CourierAccountInput,
  ): Promise<MutationResult<CourierAccountRecord>> {
    const check = new InputChecker();
    if (input.courier !== undefined && input.courier !== null) {
      check.add(['input', 'courier'], 'INVALID', "can't change: connect another account instead");
    }
    const name =
      input.name === undefined || input.name === null
        ? undefined
        : check.text(['input', 'name'], input.name, {
            required: true,
            max: COURIER_ACCOUNT_LIMITS.name,
          });
    const pickupCode =
      input.pickupCode === undefined
        ? undefined
        : check.text(['input', 'pickupCode'], input.pickupCode, {
            max: COURIER_ACCOUNT_LIMITS.pickupCode,
          });
    if (!check.ok) return { ok: false, errors: check.errors };

    return this.db.tenant(tenant.shopId, async (tx) => {
      await lockAccounts(tx, tenant.shopId);
      const current = await accountIn(tx, tenant.shopId, id);
      if (!current) return failOne(['id'], 'NOT_FOUND', 'Courier account not found');
      if (current.archived_at !== null) {
        return failOne(['id'], 'INVALID', 'The account is archived: connect it again instead');
      }
      const courier = this.couriers.of(current.courier);
      let credentials: CourierCredentials | null = null;
      if (input.credentials !== undefined && input.credentials !== null) {
        if (!courier) {
          return failOne(
            ['input', 'credentials'],
            'INVALID',
            'Shops no longer book with this courier here',
          );
        }
        credentials = this.#checkCredentials(check, courier.info, input.credentials);
        if (!check.ok || !credentials) return { ok: false, errors: check.errors };
      }
      const opened = credentials && this.#open(tenant.shopId, current);
      const changed = [
        ...(name !== undefined && name !== current.name ? ['name'] : []),
        ...(credentials && !sameCredentials(credentials, opened) ? ['credentials'] : []),
        ...(pickupCode !== undefined && pickupCode !== current.pickup_code ? ['pickupCode'] : []),
        ...(input.isDefault === true && !current.is_default ? ['isDefault'] : []),
        ...(input.isDefault === false && current.is_default ? ['isDefault'] : []),
      ];
      if (changed.length === 0) return { ok: true, value: this.#toRecord(current) };
      if (input.isDefault === false && current.is_default) {
        return failOne(
          ['input', 'isDefault'],
          'INVALID',
          'Make another account the default instead: bookings need one',
        );
      }
      if (input.isDefault === true && !current.is_default) await clearDefault(tx, tenant.shopId);
      await tx.execute(sql`
        UPDATE logistics.courier_accounts
           SET name = ${name ?? current.name},
               credentials = ${credentials ? this.#seal(tenant.shopId, id, credentials) : current.credentials},
               credentials_hint = ${credentials ? hintOf(credentials) : current.credentials_hint},
               pickup_code = ${pickupCode === undefined ? current.pickup_code : pickupCode},
               is_default = ${input.isDefault === true || current.is_default},
               version = version + 1, updated_at = now()
         WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
      await this.#record(tx, tenant, id, LogisticsEvents.CourierAccountUpdated, {
        courier: current.courier,
        changed,
      });
      return { ok: true, value: this.#toRecord((await accountIn(tx, tenant.shopId, id))!) };
    });
  }

  /**
   * Archives the account: no more bookings with it, and those waiting are cancelled; its parcels
   * are still followed. The default passes to the oldest account left.
   */
  async archive(tenant: TenantContext, id: string): Promise<MutationResult<CourierAccountRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      await lockAccounts(tx, tenant.shopId);
      const current = await accountIn(tx, tenant.shopId, id);
      if (!current) return failOne(['id'], 'NOT_FOUND', 'Courier account not found');
      if (current.archived_at !== null) return { ok: true, value: this.#toRecord(current) };
      await tx.execute(sql`
        UPDATE logistics.courier_accounts
           SET archived_at = now(), is_default = false, version = version + 1, updated_at = now()
         WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
      if (current.is_default) {
        await tx.execute(sql`
          UPDATE logistics.courier_accounts SET is_default = true, updated_at = now()
           WHERE shop_id = ${tenant.shopId}
             AND id = (SELECT id FROM logistics.courier_accounts
                        WHERE shop_id = ${tenant.shopId} AND archived_at IS NULL
                        ORDER BY created_at, id
                        LIMIT 1)`);
      }
      const { rows: cancelled } = await tx.execute<{ id: string; order_id: string }>(sql`
        UPDATE logistics.bookings
           SET status = 'cancelled', error = 'Its courier account was archived',
               updated_at = now()
         WHERE shop_id = ${tenant.shopId} AND account_id = ${id} AND status = 'pending'
        RETURNING id, order_id`);
      for (const booking of cancelled) {
        await appendEvent(tx, tenant.shopId, {
          type: LogisticsEvents.CourierBookingCancelled,
          aggregateType: 'courier_booking',
          aggregateId: booking.id,
          payload: {
            orderId: booking.order_id,
            accountId: id,
            courier: current.courier,
            error: 'Its courier account was archived',
          },
        });
      }
      await this.#record(tx, tenant, id, LogisticsEvents.CourierAccountArchived, {
        courier: current.courier,
      });
      return { ok: true, value: this.#toRecord((await accountIn(tx, tenant.shopId, id))!) };
    });
  }

  /** The account the worker books with, its credentials opened; null if it is gone. */
  async openedOf(shopId: string, id: string): Promise<OpenedCourierAccount | null> {
    const row = await this.db.tenant(shopId, (tx) => accountIn(tx, shopId, id));
    if (!row) return null;
    return {
      id: row.id,
      courier: row.courier,
      credentials: this.#open(shopId, row),
      pickupCode: row.pickup_code,
      archived: row.archived_at !== null,
    };
  }

  /** What the courier asks for, all of it, each once, as it was typed but trimmed. */
  #checkCredentials(
    check: InputChecker,
    courier: CourierInfo,
    given: readonly CourierCredentialInput[] | null | undefined,
  ): CourierCredentials | null {
    const field = ['input', 'credentials'];
    const values = new Map<string, string>();
    for (const [index, credential] of (given ?? []).entries()) {
      const known = courier.credentials.some((each) => each.key === credential.key);
      if (!known || values.has(credential.key)) {
        check.add(
          [...field, String(index), 'key'],
          'INVALID',
          known
            ? 'is given twice'
            : `must be one of ${courier.credentials.map((each) => each.key).join(', ')}`,
        );
        continue;
      }
      const value = credential.value.trim();
      if (
        value === '' ||
        value.length > COURIER_ACCOUNT_LIMITS.credential ||
        !/^[!-~]+$/.test(value)
      ) {
        check.add(
          [...field, String(index), 'value'],
          'INVALID',
          'must be as the courier gave it: letters, digits and marks, without spaces',
        );
        continue;
      }
      values.set(credential.key, value);
    }
    const missing = courier.credentials.filter((each) => !values.has(each.key));
    if (missing.length > 0) {
      check.addMessage(
        field,
        'BLANK',
        `${courier.name} needs its ${missing.map((each) => each.label).join(' and ')}`,
      );
    }
    // In the order the courier asks for them: the first gives the hint.
    return check.ok
      ? Object.fromEntries(courier.credentials.map((each) => [each.key, values.get(each.key)!]))
      : null;
  }

  #seal(shopId: string, id: string, credentials: CourierCredentials): string {
    return this.box.encrypt(JSON.stringify(credentials), sealedFor(shopId, id));
  }

  #open(shopId: string, row: AccountRow): CourierCredentials {
    return JSON.parse(
      this.box.decrypt(row.credentials, sealedFor(shopId, row.id)).toString('utf8'),
    ) as CourierCredentials;
  }

  async #record(
    tx: Tx,
    tenant: TenantContext,
    id: string,
    type: string,
    payload: Omit<CourierAccountChangedPayload, 'actorKind' | 'actorId'>,
  ): Promise<void> {
    const actor = actorColumnsOf(tenant.actor);
    await appendEvent<CourierAccountChangedPayload>(tx, tenant.shopId, {
      type,
      aggregateType: 'courier_account',
      aggregateId: id,
      payload: { ...payload, actorKind: actor.actorKind, actorId: actor.actorId },
    });
    const row = (await accountIn(tx, tenant.shopId, id))!;
    await recordAudit(tx, tenant.shopId, {
      action: type,
      subjectType: 'courierAccount',
      subjectId: id,
      ...actor,
      details: {
        ...payload,
        name: row.name,
        credentialsHint: row.credentials_hint,
        pickupCode: row.pickup_code,
        isDefault: row.is_default,
      },
    });
  }

  #toRecord(row: AccountRow): CourierAccountRecord {
    return {
      id: row.id,
      courier: row.courier,
      courierName: this.couriers.of(row.courier)?.info.name ?? row.courier,
      name: row.name,
      credentialsHint: row.credentials_hint,
      pickupCode: row.pickup_code,
      isDefault: row.is_default,
      archivedAt: row.archived_at === null ? null : toDate(row.archived_at),
      createdAt: toDate(row.created_at),
      updatedAt: toDate(row.updated_at),
    };
  }
}

/** One change to the shop's accounts at a time: its default stays one. */
async function lockAccounts(tx: Tx, shopId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`courier_accounts:${shopId}`}, 0))`,
  );
}

async function clearDefault(tx: Tx, shopId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE logistics.courier_accounts SET is_default = false, updated_at = now()
     WHERE shop_id = ${shopId} AND is_default`);
}

async function accountIn(tx: Tx, shopId: string, id: string): Promise<AccountRow | null> {
  const { rows } = await tx.execute<AccountRow>(sql`
    SELECT id, courier, name, credentials, credentials_hint, pickup_code, is_default, archived_at,
           created_at, updated_at
      FROM logistics.courier_accounts
     WHERE shop_id = ${shopId} AND id = ${id}`);
  return rows[0] ?? null;
}

/** The last four characters of the first credential the courier asks for. */
function hintOf(credentials: CourierCredentials): string {
  return (Object.values(credentials)[0] ?? '').slice(-4);
}

function sameCredentials(a: CourierCredentials, b: CourierCredentials | null): boolean {
  if (!b) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}
