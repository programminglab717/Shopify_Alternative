import {
  InputChecker,
  PlanAllowance,
  actorColumnsOf,
  failOne,
  planFeatureMessage,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { Database, toDate, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { newId } from '@hatti/ids';
import { Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TaxEvents, type FbrPosDeletedPayload, type FbrPosUpdatedPayload } from './events.js';
import type { FbrPosConnection } from './fbr-client.js';
import {
  FBR_ENVIRONMENTS,
  FBR_LIMITS,
  FISCAL_STATUSES,
  fbrInvoiceBody,
  pctCodeOf,
  type FbrEnvironment,
  type FbrInvoiceBody,
  type FiscalDocument,
  type FiscalKind,
  type FiscalStatus,
} from './fbr.js';

/** The shop's POS as FBR registered it, as the Admin API shows it: never its token. */
export interface FbrPosRecord {
  posId: number;
  /** The token's last four characters. */
  tokenHint: string;
  environment: FbrEnvironment;
  pctCode: string;
  updatedAt: Date;
}

/** Fields left out stay as they are. Connecting needs them all. */
export interface FbrPosInput {
  posId?: number | null;
  accessToken?: string | null;
  environment?: FbrEnvironment | null;
  pctCode?: string | null;
}

/** An invoice or credit note the shop issued while connected, and how reporting it went. */
export interface FiscalInvoiceRecord {
  id: string;
  kind: FiscalKind;
  usin: string;
  orderId: string;
  status: FiscalStatus;
  /** The number FBR gave it, which its printed copy shows. */
  fbrInvoiceNumber: string | null;
  attempts: number;
  /** Why it is not reported yet, or was refused. */
  error: string | null;
  reportedAt: Date | null;
  createdAt: Date;
}

/** One taken to report: what FBR is sent of it. */
export interface ClaimedFiscalInvoice {
  id: string;
  usin: string;
  body: FbrInvoiceBody;
  attempts: number;
  createdAt: Date;
}

/** How reporting one went. */
export type FiscalOutcome =
  | { id: string; status: 'reported'; invoiceNumber: string }
  | { id: string; status: 'pending'; nextAttemptAt: Date; error: string }
  | { id: string; status: 'failed' | 'skipped'; error: string };

export interface FiscalInvoicesListOptions {
  status?: FiscalStatus | null;
  /** At most 100; 50 unless given. */
  first?: number | null;
}

type PosRow = {
  pos_id: string | number;
  access_token: string;
  token_hint: string;
  environment: FbrEnvironment;
  pct_code: string;
  updated_at: string | Date;
};

type FiscalRow = {
  id: string;
  kind: FiscalKind;
  usin: string;
  order_id: string;
  status: FiscalStatus;
  fbr_invoice_number: string | null;
  attempts: number;
  error: string | null;
  reported_at: string | Date | null;
  created_at: string | Date;
};

/** What the shop's sealed token is bound to: it opens for that shop alone. */
function sealedFor(shopId: string): string {
  return `fbr-pos:${shopId}`;
}

/**
 * The shop's POS as FBR registered it (POS-04, TAX-04, ADR-555): the POS ID FBR gave it, the
 * access token FBR gave with it, kept sealed and never shown again, FBR's sandbox or the real
 * one, and the PCT code its items are reported under. While connected, each invoice and credit
 * note it issues is reported to FBR. Changes are audited, the token never. A plan without FBR's
 * connectors connects nothing.
 */
@Injectable()
export class FbrPosService {
  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
    @Optional() private readonly allowance?: PlanAllowance,
  ) {}

  async get(tenant: TenantContext): Promise<FbrPosRecord | null> {
    const row = await this.db.tenant(tenant.shopId, (tx) => posIn(tx, tenant.shopId));
    return row && toPosRecord(row);
  }

  /** Connects the shop's POS, or changes what is given, for invoices reported from now on. */
  async update(tenant: TenantContext, input: FbrPosInput): Promise<MutationResult<FbrPosRecord>> {
    const check = new InputChecker();
    const posId = input.posId ?? undefined;
    if (posId !== undefined && (!Number.isInteger(posId) || posId <= 0 || posId >= 1e10)) {
      check.add(['input', 'posId'], 'INVALID', 'must be the POS ID FBR gave the POS');
    }
    const accessToken =
      input.accessToken === undefined || input.accessToken === null
        ? undefined
        : checkAccessToken(check, input.accessToken);
    const environment = input.environment ?? undefined;
    if (environment !== undefined && !FBR_ENVIRONMENTS.includes(environment)) {
      check.add(['input', 'environment'], 'INVALID', "must be FBR's sandbox or production");
    }
    const pctCode =
      input.pctCode === undefined || input.pctCode === null
        ? undefined
        : (pctCodeOf(input.pctCode) ?? undefined);
    if (input.pctCode && pctCode === undefined) {
      check.add(
        ['input', 'pctCode'],
        'INVALID',
        'must be a PCT code of 8 digits, as FBR\'s tariff writes it: "6204.4200"',
      );
    }
    if (!check.ok) return { ok: false, errors: check.errors };
    const existing = await this.get(tenant);
    if (!existing) {
      const plan = await this.allowance?.excludes(tenant.shopId, 'fiscalReporting');
      if (plan) {
        return failOne(['input'], 'INVALID', planFeatureMessage(plan, "FBR's POS integration"));
      }
    }

    return this.db.tenant(tenant.shopId, async (tx) => {
      const current = await posIn(tx, tenant.shopId, { lock: true });
      if (!current) {
        const missing = (
          [
            ['posId', posId, 'the POS ID FBR gave the POS'],
            ['accessToken', accessToken, 'the access token FBR gave it'],
            ['environment', environment, "FBR's sandbox or production"],
            ['pctCode', pctCode, 'the PCT code its items are reported under'],
          ] as const
        ).find(([, value]) => value === undefined);
        if (missing) {
          return failOne(['input', missing[0]], 'BLANK', `Connecting FBR needs ${missing[2]}`);
        }
      }
      const opened = current && this.box.decrypt(current.access_token, sealedFor(tenant.shopId));
      const next = {
        posId: posId ?? Number(current!.pos_id),
        environment: environment ?? current!.environment,
        pctCode: pctCode ?? current!.pct_code,
      };
      const changed = [
        ...(current === null || next.posId !== Number(current.pos_id) ? ['posId'] : []),
        ...(accessToken !== undefined && accessToken !== opened?.toString('utf8')
          ? ['accessToken']
          : []),
        ...(next.environment !== current?.environment ? ['environment'] : []),
        ...(next.pctCode !== current?.pct_code ? ['pctCode'] : []),
      ];
      if (current && changed.length === 0) return { ok: true, value: toPosRecord(current) };
      const sealed =
        accessToken === undefined
          ? current!.access_token
          : this.box.encrypt(accessToken, sealedFor(tenant.shopId));
      const hint = accessToken === undefined ? current!.token_hint : accessToken.slice(-4);
      await tx.execute(sql`
        INSERT INTO tax.fbr_pos (shop_id, pos_id, access_token, token_hint, environment, pct_code)
        VALUES (${tenant.shopId}, ${next.posId}, ${sealed}, ${hint}, ${next.environment},
                ${next.pctCode})
            ON CONFLICT (shop_id) DO UPDATE
                   SET pos_id = excluded.pos_id, access_token = excluded.access_token,
                       token_hint = excluded.token_hint, environment = excluded.environment,
                       pct_code = excluded.pct_code, version = tax.fbr_pos.version + 1,
                       updated_at = now()`);
      // A new token or POS may be what those waiting on FBR's refusal of the old one need.
      if (changed.some((field) => field !== 'pctCode')) {
        await tx.execute(sql`
          UPDATE tax.fiscal_invoices SET next_attempt_at = now()
           WHERE shop_id = ${tenant.shopId} AND status = 'pending'`);
      }
      const actor = actorColumnsOf(tenant.actor);
      await appendEvent<FbrPosUpdatedPayload>(tx, tenant.shopId, {
        type: TaxEvents.FbrPosUpdated,
        aggregateType: 'fbr_pos',
        aggregateId: tenant.shopId,
        payload: { changed, actorKind: actor.actorKind, actorId: actor.actorId },
      });
      await recordAudit(tx, tenant.shopId, {
        action: 'fbr_pos.updated',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actor,
        details: {
          changed,
          posId: next.posId,
          tokenHint: hint,
          environment: next.environment,
          pctCode: next.pctCode,
          before: current && {
            posId: Number(current.pos_id),
            tokenHint: current.token_hint,
            environment: current.environment,
            pctCode: current.pct_code,
          },
        },
      });
      return { ok: true, value: toPosRecord((await posIn(tx, tenant.shopId))!) };
    });
  }

  /**
   * Disconnects the shop's POS: its token is forgotten, invoices issued from now on are not
   * reported, and those still waiting for FBR are not sent. The POS ID it had, or null when none
   * was connected.
   */
  async delete(tenant: TenantContext): Promise<number | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{ pos_id: string | number }>(sql`
        DELETE FROM tax.fbr_pos WHERE shop_id = ${tenant.shopId} RETURNING pos_id`);
      if (!rows[0]) return null;
      const posId = Number(rows[0].pos_id);
      await tx.execute(sql`
        UPDATE tax.fiscal_invoices
           SET status = 'skipped', error = 'Not reported: the shop disconnected FBR'
         WHERE shop_id = ${tenant.shopId} AND status = 'pending'`);
      const actor = actorColumnsOf(tenant.actor);
      await appendEvent<FbrPosDeletedPayload>(tx, tenant.shopId, {
        type: TaxEvents.FbrPosDeleted,
        aggregateType: 'fbr_pos',
        aggregateId: tenant.shopId,
        payload: { posId, actorKind: actor.actorKind, actorId: actor.actorId },
      });
      await recordAudit(tx, tenant.shopId, {
        action: 'fbr_pos.deleted',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actor,
        details: { posId },
      });
      return posId;
    });
  }

  /** The POS the worker reports the shop's invoices from, its token opened; null if none. */
  async connectionOf(shopId: string): Promise<FbrPosConnection | null> {
    const row = await this.db.tenant(shopId, (tx) => posIn(tx, shopId));
    if (!row) return null;
    return {
      posId: Number(row.pos_id),
      accessToken: this.box.decrypt(row.access_token, sealedFor(shopId)).toString('utf8'),
      environment: row.environment,
      pctCode: row.pct_code,
    };
  }
}

/**
 * The invoices and credit notes the shop issued while its POS was connected, as they are
 * reported to FBR (ADR-555): the worker takes those due, reports them, and settles each as FBR
 * answered; the shop sees each one's state, and has one FBR refused sent again.
 */
@Injectable()
export class FiscalInvoicesService {
  constructor(private readonly db: Database) {}

  /** The shop's, the latest first: those of `status` alone, if given. */
  async list(
    tenant: TenantContext,
    options: FiscalInvoicesListOptions = {},
  ): Promise<FiscalInvoiceRecord[]> {
    const first = Math.min(Math.max(options.first ?? 50, 1), 100);
    const status =
      options.status && FISCAL_STATUSES.includes(options.status) ? options.status : null;
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<FiscalRow>(sql`
        SELECT ${FISCAL_COLUMNS} FROM tax.fiscal_invoices
         WHERE shop_id = ${tenant.shopId} ${status ? sql`AND status = ${status}` : sql``}
         ORDER BY created_at DESC, id DESC
         LIMIT ${first}`),
    );
    return rows.map(toFiscalRecord);
  }

  /**
   * Has one FBR refused, or one the shop's disconnecting left unsent, reported again from now,
   * while its POS is connected.
   */
  async retry(tenant: TenantContext, id: string): Promise<MutationResult<FiscalInvoiceRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<FiscalRow & { connected: boolean }>(sql`
        SELECT ${FISCAL_COLUMNS},
               EXISTS (SELECT 1 FROM tax.fbr_pos WHERE shop_id = ${tenant.shopId}) AS connected
          FROM tax.fiscal_invoices
         WHERE shop_id = ${tenant.shopId} AND id = ${id}
           FOR UPDATE`);
      const row = rows[0];
      if (!row) return failOne(['id'], 'NOT_FOUND', 'No such fiscal invoice');
      if (row.status !== 'failed' && row.status !== 'skipped') {
        return failOne(
          ['id'],
          'INVALID',
          `It is ${row.status}: only one not reported is sent again`,
        );
      }
      if (!row.connected) {
        return failOne(['id'], 'INVALID', "Connect FBR's POS first: nothing is sent without it");
      }
      const { rows: updated } = await tx.execute<FiscalRow>(sql`
        UPDATE tax.fiscal_invoices SET status = 'pending', next_attempt_at = now()
         WHERE shop_id = ${tenant.shopId} AND id = ${id}
        RETURNING ${FISCAL_COLUMNS}`);
      return { ok: true, value: toFiscalRecord(updated[0]!) };
    });
  }

  /** The shops with invoices due to go at `at`: found with the system role, which sees all. */
  async dueShops(at: Date, limit = 100): Promise<string[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string }>(sql`
        SELECT DISTINCT shop_id FROM tax.fiscal_invoices
         WHERE status = 'pending' AND next_attempt_at <= ${at.toISOString()}
         LIMIT ${limit}`),
    );
    return rows.map((row) => row.shop_id);
  }

  /**
   * Takes up to `limit` of the shop's invoices due at `at`, those issued first first, to report
   * them: each counts a try, and is not due again for `leaseMs` unless settled before. No two
   * reporters take the same, and one that stops before settling has them sent again after that.
   */
  async claim(
    shopId: string,
    at: Date,
    limit: number,
    leaseMs: number,
  ): Promise<ClaimedFiscalInvoice[]> {
    return this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<{
        id: string;
        usin: string;
        payload: FbrInvoiceBody;
        attempts: number;
        created_at: string | Date;
      }>(sql`
        WITH due AS MATERIALIZED (
          SELECT id FROM tax.fiscal_invoices
           WHERE shop_id = ${shopId} AND status = 'pending'
             AND next_attempt_at <= ${at.toISOString()}
           ORDER BY created_at, id
           LIMIT ${limit}
             FOR UPDATE SKIP LOCKED)
        UPDATE tax.fiscal_invoices f
           SET attempts = f.attempts + 1,
               next_attempt_at = ${new Date(at.getTime() + leaseMs).toISOString()}
          FROM due
         WHERE f.shop_id = ${shopId} AND f.id = due.id
        RETURNING f.id, f.usin, f.payload, f.attempts, f.created_at`);
      return rows
        .map((row) => ({
          id: row.id,
          usin: row.usin,
          body: row.payload,
          attempts: row.attempts,
          createdAt: toDate(row.created_at),
        }))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
    });
  }

  /** Settles those claimed as reporting them went, at `at`. */
  async settle(shopId: string, outcomes: readonly FiscalOutcome[], at: Date): Promise<void> {
    if (outcomes.length === 0) return;
    await this.db.tenant(shopId, async (tx) => {
      for (const outcome of outcomes) {
        const set =
          outcome.status === 'reported'
            ? sql`status = 'reported', fbr_invoice_number = ${outcome.invoiceNumber.slice(0, 100)},
                  reported_at = ${at.toISOString()}, error = NULL`
            : outcome.status === 'pending'
              ? sql`next_attempt_at = ${outcome.nextAttemptAt.toISOString()},
                    error = ${outcome.error.slice(0, 1_000)}`
              : sql`status = ${outcome.status}, error = ${outcome.error.slice(0, 1_000)}`;
        await tx.execute(sql`
          UPDATE tax.fiscal_invoices SET ${set}
           WHERE shop_id = ${shopId} AND id = ${outcome.id} AND status = 'pending'`);
      }
    });
  }
}

/**
 * Keeps `documents`, the invoices and credit notes the shop just issued, to be reported to FBR,
 * in the caller's transaction, so they are kept only if it commits: while its POS is connected,
 * and none twice. How many were kept.
 */
export async function recordFiscalDocumentsIn(
  tx: Tx,
  shopId: string,
  documents: readonly FiscalDocument[],
  timeZone: string,
): Promise<number> {
  if (documents.length === 0) return 0;
  const { rows } = await tx.execute<{ connected: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM tax.fbr_pos WHERE shop_id = ${shopId}) AS connected`);
  if (!rows[0]?.connected) return 0;
  let kept = 0;
  for (const document of documents) {
    const { rowCount } = await tx.execute(sql`
      INSERT INTO tax.fiscal_invoices (shop_id, id, kind, usin, order_id, payload)
      VALUES (${shopId}, ${newId()}, ${document.kind}, ${document.usin}, ${document.orderId},
              ${JSON.stringify(fbrInvoiceBody(document, timeZone))}::jsonb)
          ON CONFLICT (shop_id, usin) DO NOTHING`);
    kept += rowCount ?? 0;
  }
  return kept;
}

/** How the shop's invoices `usins` stand with FBR, by USIN: those never sent are left out. */
export async function fiscalInvoicesIn(
  tx: Tx,
  shopId: string,
  usins: readonly string[],
): Promise<Map<string, FiscalInvoiceRecord>> {
  if (usins.length === 0) return new Map();
  const { rows } = await tx.execute<FiscalRow>(sql`
    SELECT ${FISCAL_COLUMNS} FROM tax.fiscal_invoices
     WHERE shop_id = ${shopId} AND usin = ANY(${sql.param([...usins])}::text[])`);
  return new Map(rows.map((row) => [row.usin, toFiscalRecord(row)]));
}

const FISCAL_COLUMNS = sql.raw(
  'id, kind, usin, order_id, status, fbr_invoice_number, attempts, error, reported_at, created_at',
);

async function posIn(
  tx: Tx,
  shopId: string,
  options: { lock?: boolean } = {},
): Promise<PosRow | null> {
  const { rows } = await tx.execute<PosRow>(sql`
    SELECT pos_id, access_token, token_hint, environment, pct_code, updated_at
      FROM tax.fbr_pos
     WHERE shop_id = ${shopId}
     ${options.lock ? sql`FOR UPDATE` : sql``}`);
  return rows[0] ?? null;
}

function toPosRecord(row: PosRow): FbrPosRecord {
  return {
    posId: Number(row.pos_id),
    tokenHint: row.token_hint,
    environment: row.environment,
    pctCode: row.pct_code,
    updatedAt: toDate(row.updated_at),
  };
}

function toFiscalRecord(row: FiscalRow): FiscalInvoiceRecord {
  return {
    id: row.id,
    kind: row.kind,
    usin: row.usin,
    orderId: row.order_id,
    status: row.status,
    fbrInvoiceNumber: row.fbr_invoice_number,
    attempts: row.attempts,
    error: row.error,
    reportedAt: row.reported_at === null ? null : toDate(row.reported_at),
    createdAt: toDate(row.created_at),
  };
}

/** A token as FBR gives it: letters, digits and marks, without spaces. */
function checkAccessToken(check: InputChecker, value: string): string | undefined {
  const token = value.trim();
  if (token.length < 8 || token.length > FBR_LIMITS.accessToken || !/^[!-~]+$/.test(token)) {
    check.add(
      ['input', 'accessToken'],
      'INVALID',
      'must be the access token FBR gave, as it gave it',
    );
    return undefined;
  }
  return token;
}
