import { createHash } from 'node:crypto';
import {
  actorColumnsOf,
  deniedToRole,
  failOne,
  hasCapability,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, toDate, type Tx } from '@hatti/db';
import { recordAudit } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { WasmError, takeWasm } from '@hatti/functions';

// Apps' functions (DEV-07, CHK-20, ADR-868): WebAssembly modules an app, custom or public, gives
// the shop for checkout to run on what it is about to offer, as Shopify's functions are. A
// payment customisation hides ways to pay; a cart validation refuses an order, saying why. The
// app names each, by a handle of its own, and sends new versions as it changes; the shop's owner
// or a manager turns each on and gives it its settings. Checkout reads them, runs them through
// the function runner, and takes their answers as this module reads them here.

export const FUNCTION_TARGETS = ['payment_customization', 'cart_validation'] as const;

export type FunctionTarget = (typeof FUNCTION_TARGETS)[number];

export const APP_FUNCTION_LIMITS = {
  perApp: 10,
  title: 100,
  handle: 50,
  configurationBytes: 10_000,
  /** A validation's messages a function may give, and their length. */
  errors: 3,
  message: 200,
} as const;

/** The ways to pay a payment customisation may hide. */
export const PAYMENT_METHODS = ['cash_on_delivery', 'bank_transfer', 'online'] as const;

export type PaymentMethodName = (typeof PAYMENT_METHODS)[number];

export interface AppFunctionRecord {
  id: string;
  /** The app giving it: its access token's ID. */
  appId: string;
  appName: string;
  handle: string;
  title: string;
  target: FunctionTarget;
  /** The module's size as it runs. */
  bytes: number;
  enabled: boolean;
  configuration: Record<string, unknown>;
  lastError: string | null;
  failedAt: Date | null;
  updatedAt: Date;
}

export interface AppFunctionInput {
  handle: string;
  title: string;
  target: string;
  /** The module, base64. */
  wasm: string;
}

/** A function as checkout runs it. */
export interface RunnableFunction {
  id: string;
  digest: string;
  wasm: Uint8Array;
  configuration: Record<string, unknown>;
}

type FunctionRow = {
  id: string;
  token_id: string;
  app_name: string;
  handle: string;
  title: string;
  target: FunctionTarget;
  bytes: number;
  enabled: boolean;
  configuration: Record<string, unknown>;
  last_error: string | null;
  failed_at: Date | string | null;
  updated_at: Date | string;
};

const toRecord = (row: FunctionRow): AppFunctionRecord => ({
  id: row.id,
  appId: row.token_id,
  appName: row.app_name,
  handle: row.handle,
  title: row.title,
  target: row.target,
  bytes: row.bytes,
  enabled: row.enabled,
  configuration: row.configuration,
  lastError: row.last_error,
  failedAt: row.failed_at === null ? null : toDate(row.failed_at),
  updatedAt: toDate(row.updated_at),
});

const HANDLE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Of the shop's apps' functions, those an app still installed gives. */
const LIVE = sql`JOIN apps.access_tokens t ON t.shop_id = f.shop_id AND t.id = f.token_id
                  AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())`;

const COLUMNS = sql`f.id, f.token_id, t.name AS app_name, f.handle, f.title, f.target,
                    octet_length(f.wasm) AS bytes, f.enabled, f.configuration, f.last_error,
                    f.failed_at, f.updated_at`;

function callingApp(tenant: TenantContext): string {
  if (tenant.actor.kind !== 'app') {
    throw deniedToRole('Access denied. Apps give their own functions.');
  }
  return tenant.actor.tokenId;
}

function managing(tenant: TenantContext): void {
  if (tenant.actor.kind !== 'staff' || !hasCapability(tenant.actor, 'manage_apps')) {
    throw deniedToRole("Access denied. The owner and managers turn apps' functions on.");
  }
}

/** The functions turned on for `target`, of apps the shop still has, in the order given. */
export async function enabledFunctionsIn(
  tx: Tx,
  shopId: string,
  target: FunctionTarget,
): Promise<RunnableFunction[]> {
  const { rows } = await tx.execute<{
    id: string;
    wasm: Buffer;
    wasm_digest: Buffer;
    configuration: Record<string, unknown>;
  }>(sql`
    SELECT f.id, f.wasm, f.wasm_digest, f.configuration FROM apps.app_functions f ${LIVE}
     WHERE f.shop_id = ${shopId} AND f.target = ${target} AND f.enabled
     ORDER BY f.created_at, f.id`);
  return rows.map((row) => ({
    id: row.id,
    digest: row.wasm_digest.toString('hex'),
    wasm: new Uint8Array(row.wasm),
    configuration: row.configuration,
  }));
}

/** Keeps a function's failure, for the shop and the app to see. */
export async function recordFunctionFailureIn(
  tx: Tx,
  shopId: string,
  id: string,
  detail: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE apps.app_functions SET last_error = ${detail.slice(0, 500)}, failed_at = now()
     WHERE shop_id = ${shopId} AND id = ${id}`);
}

/**
 * The ways to pay a payment customisation's answer hides: `{ "operations": [{ "hide":
 * { "paymentMethod": "cash_on_delivery" } }] }`; null for an answer of another shape.
 */
export function hiddenPaymentMethodsOf(output: unknown): PaymentMethodName[] | null {
  const operations = (output as { operations?: unknown } | null)?.operations;
  if (!Array.isArray(operations)) return null;
  const hidden: PaymentMethodName[] = [];
  for (const operation of operations) {
    const method = (operation as { hide?: { paymentMethod?: unknown } } | null)?.hide
      ?.paymentMethod;
    if (!(PAYMENT_METHODS as readonly unknown[]).includes(method)) return null;
    hidden.push(method as PaymentMethodName);
  }
  return hidden;
}

/**
 * What a cart validation's answer says is wrong: `{ "errors": [{ "message": "..." }] }`, three at
 * most, each cut to 200 characters; null for an answer of another shape.
 */
export function validationErrorsOf(output: unknown): string[] | null {
  const errors = (output as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) return null;
  const messages: string[] = [];
  for (const error of errors) {
    const message = (error as { message?: unknown } | null)?.message;
    if (typeof message !== 'string' || !message.trim()) return null;
    messages.push(message.trim().slice(0, APP_FUNCTION_LIMITS.message));
  }
  return messages.slice(0, APP_FUNCTION_LIMITS.errors);
}

@Injectable()
export class AppFunctionService {
  constructor(private readonly db: Database) {}

  /** An app's own functions; for staff, every app's the shop still has. */
  async list(tenant: TenantContext): Promise<AppFunctionRecord[]> {
    const own = tenant.actor.kind === 'app' ? tenant.actor.tokenId : null;
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<FunctionRow>(sql`
        SELECT ${COLUMNS} FROM apps.app_functions f ${LIVE}
         WHERE f.shop_id = ${tenant.shopId} ${own ? sql`AND f.token_id = ${own}` : sql``}
         ORDER BY t.name, f.created_at, f.id`),
    );
    return rows.map(toRecord);
  }

  /**
   * Gives the calling app's function `handle`, or a new version of it: off until the shop turns
   * it on, and as it was, on or off, with its settings, for a new version.
   */
  async set(
    tenant: TenantContext,
    input: AppFunctionInput,
  ): Promise<MutationResult<AppFunctionRecord>> {
    const tokenId = callingApp(tenant);
    const handle = input.handle.trim();
    const title = input.title.trim();
    if (!HANDLE.test(handle) || handle.length > APP_FUNCTION_LIMITS.handle) {
      return failOne(['input', 'handle'], 'INVALID', 'Use lowercase letters, digits and dashes');
    }
    if (!title || title.length > APP_FUNCTION_LIMITS.title) {
      return failOne(
        ['input', 'title'],
        'INVALID',
        `Title it in ${APP_FUNCTION_LIMITS.title} characters at most`,
      );
    }
    if (!(FUNCTION_TARGETS as readonly string[]).includes(input.target)) {
      return failOne(['input', 'target'], 'INVALID', `Use ${FUNCTION_TARGETS.join(' or ')}`);
    }
    let wasm: Uint8Array;
    try {
      wasm = await takeWasm(Buffer.from(input.wasm, 'base64'));
    } catch (error) {
      if (!(error instanceof WasmError)) throw error;
      return failOne(['input', 'wasm'], 'INVALID', error.message);
    }
    const digest = createHash('sha256').update(wasm).digest();
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows: counted } = await tx.execute<{ count: number; mine: boolean }>(sql`
        SELECT count(*)::int AS count, bool_or(handle = ${handle}) AS mine FROM apps.app_functions
         WHERE shop_id = ${tenant.shopId} AND token_id = ${tokenId}`);
      if (!counted[0]?.mine && (counted[0]?.count ?? 0) >= APP_FUNCTION_LIMITS.perApp) {
        return failOne<AppFunctionRecord>(
          ['input', 'handle'],
          'TOO_MANY',
          `An app gives ${APP_FUNCTION_LIMITS.perApp} functions at most`,
        );
      }
      await tx.execute(sql`
        INSERT INTO apps.app_functions (shop_id, token_id, handle, title, target, wasm, wasm_digest)
        VALUES (${tenant.shopId}, ${tokenId}, ${handle}, ${title}, ${input.target},
                ${Buffer.from(wasm)}, ${digest})
        ON CONFLICT (shop_id, token_id, handle) DO UPDATE
           SET title = EXCLUDED.title, target = EXCLUDED.target, wasm = EXCLUDED.wasm,
               wasm_digest = EXCLUDED.wasm_digest, last_error = NULL, failed_at = NULL,
               updated_at = now()`);
      return {
        ok: true,
        value: (await this.#one(
          tx,
          tenant.shopId,
          sql`f.token_id = ${tokenId} AND f.handle = ${handle}`,
        ))!,
      };
    });
  }

  /** Takes back the calling app's function `handle`. */
  async remove(tenant: TenantContext, handle: string): Promise<MutationResult<string>> {
    const tokenId = callingApp(tenant);
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<{ id: string }>(sql`
        DELETE FROM apps.app_functions
         WHERE shop_id = ${tenant.shopId} AND token_id = ${tokenId} AND handle = ${handle}
        RETURNING id`),
    );
    if (!rows[0]) return failOne(['handle'], 'NOT_FOUND', 'The app gives no such function');
    return { ok: true, value: rows[0].id };
  }

  /**
   * Turns a function on or off, and gives it its settings where `configuration` is given, JSON
   * of an object: the owner's and managers' to do.
   */
  async enable(
    tenant: TenantContext,
    id: string,
    enabled: boolean,
    configuration?: string | null,
  ): Promise<MutationResult<AppFunctionRecord>> {
    managing(tenant);
    let settings: Record<string, unknown> | null = null;
    if (configuration !== undefined && configuration !== null) {
      try {
        const parsed: unknown = JSON.parse(configuration);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw parsed;
        settings = parsed as Record<string, unknown>;
      } catch {
        return failOne(['configuration'], 'INVALID', 'Give its settings as a JSON object');
      }
      if (configuration.length > APP_FUNCTION_LIMITS.configurationBytes) {
        return failOne(['configuration'], 'TOO_LONG', 'Its settings are 10,000 characters at most');
      }
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      const found = await this.#one(tx, tenant.shopId, sql`f.id = ${id}`);
      if (!found)
        return failOne<AppFunctionRecord>(['id'], 'NOT_FOUND', 'No app gives this function');
      await tx.execute(sql`
        UPDATE apps.app_functions
           SET enabled = ${enabled}, updated_at = now()
               ${settings ? sql`, configuration = ${JSON.stringify(settings)}::jsonb` : sql``}
         WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
      await recordAudit(tx, tenant.shopId, {
        action: enabled ? 'app_function.enabled' : 'app_function.disabled',
        subjectType: 'appFunction',
        subjectId: found.id,
        ...actorColumnsOf(tenant.actor),
        details: { function: found.handle, title: found.title },
      });
      return {
        ok: true,
        value: { ...found, enabled, configuration: settings ?? found.configuration },
      };
    });
  }

  async #one(
    tx: Tx,
    shopId: string,
    where: ReturnType<typeof sql>,
  ): Promise<AppFunctionRecord | null> {
    const { rows } = await tx.execute<FunctionRow>(sql`
      SELECT ${COLUMNS} FROM apps.app_functions f ${LIVE}
       WHERE f.shop_id = ${shopId} AND ${where}`);
    return rows[0] ? toRecord(rows[0]) : null;
  }
}
