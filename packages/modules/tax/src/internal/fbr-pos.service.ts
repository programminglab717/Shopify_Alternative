import {
  InputChecker,
  PlanAllowance,
  actorColumnsOf,
  failOne,
  planFeatureMessage,
  shopProfile,
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
import type { FbrDigitalInvoicingConnection } from './fbr-di-client.js';
import {
  DI_NO_CREDIT_NOTES,
  diInvoiceBody,
  diWithSeller,
  type DiInvoiceBody,
  type DiSeller,
} from './fbr-di.js';
import {
  FBR_ENVIRONMENTS,
  FBR_LIMITS,
  FBR_SYSTEMS,
  FISCAL_STATUSES,
  fbrInvoiceBody,
  pctCodeOf,
  type FbrEnvironment,
  type FbrInvoiceBody,
  type FbrSystem,
  type FiscalDocument,
  type FiscalKind,
  type FiscalStatus,
} from './fbr.js';
import { taxSettingsIn } from './tax-settings.service.js';
import type { TaxSettingsRecord } from './tax.js';

/** What the shop's connection is called where it says how it reports. */
const SYSTEM_NAMES: Record<FbrSystem, string> = {
  pos: "FBR's POS integration",
  digital_invoicing: "FBR's digital invoicing",
};

/** The shop's connection to FBR, as the Admin API shows it: never its token. */
export interface FbrPosRecord {
  /** A Tier-1 retailer's POS reporting to FBR's IMS, or digital invoicing (ADR-562). */
  system: FbrSystem;
  /** The POS ID FBR gave the POS; null for digital invoicing, which has none. */
  posId: number | null;
  /** The token's last four characters. */
  tokenHint: string;
  environment: FbrEnvironment;
  pctCode: string;
  updatedAt: Date;
}

/**
 * Fields left out stay as they are. Connecting needs them all, but a POS ID for digital
 * invoicing; switching how the shop reports needs a token for the other, and a POS ID for a POS.
 */
export interface FbrPosInput {
  /** FBR's POS integration unless given, connecting; given, how the shop reports from now on. */
  system?: FbrSystem | null;
  posId?: number | null;
  accessToken?: string | null;
  environment?: FbrEnvironment | null;
  pctCode?: string | null;
}

/** An invoice or credit note the shop issued while connected, and how reporting it went. */
export interface FiscalInvoiceRecord {
  id: string;
  /** What it was kept for, and is sent to. */
  system: FbrSystem;
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

/** One taken to report: what FBR is sent of it, in the shape of what it was kept for. */
export type ClaimedFiscalInvoice = {
  id: string;
  usin: string;
  attempts: number;
  createdAt: Date;
} & (
  { system: 'pos'; body: FbrInvoiceBody } | { system: 'digital_invoicing'; body: DiInvoiceBody }
);

/** The shop's connection as the worker reports through it, its token opened. */
export type FbrConnection =
  | ({ system: 'pos' } & FbrPosConnection)
  | ({ system: 'digital_invoicing' } & FbrDigitalInvoicingConnection);

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
  system: FbrSystem;
  pos_id: string | number | null;
  access_token: string;
  token_hint: string;
  environment: FbrEnvironment;
  pct_code: string;
  updated_at: string | Date;
};

type FiscalRow = {
  id: string;
  system: FbrSystem;
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
 * The shop's connection to FBR (POS-04, TAX-04, ADR-555, ADR-562): a Tier-1 retailer's POS as FBR
 * registered it, with the POS ID FBR gave it, reporting to FBR's IMS; or, for a seller registered
 * for sales tax, FBR's digital invoicing. Either way, the token FBR gave, kept sealed and never
 * shown again, FBR's sandbox or the real one, and the PCT code its items are reported under. While
 * connected, each invoice and credit note it issues is reported to FBR, through the one it
 * connected. Changes are audited, the token never. A plan without FBR's connectors connects
 * nothing.
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

  /**
   * Connects the shop to FBR, or changes what is given, for invoices reported from now on.
   * Digital invoicing is for a seller registered for sales tax: its tax settings name its NTN,
   * STRN and province. Switching how it reports leaves those still waiting for the other unsent.
   */
  async update(tenant: TenantContext, input: FbrPosInput): Promise<MutationResult<FbrPosRecord>> {
    const check = new InputChecker();
    const system = input.system ?? undefined;
    if (system !== undefined && !FBR_SYSTEMS.includes(system)) {
      check.add(
        ['input', 'system'],
        'INVALID',
        "must be FBR's POS integration or digital invoicing",
      );
    }
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
        const what = SYSTEM_NAMES[system ?? 'pos'];
        return failOne(['input'], 'INVALID', planFeatureMessage(plan, what));
      }
    }

    return this.db.tenant(tenant.shopId, async (tx) => {
      const current = await posIn(tx, tenant.shopId, { lock: true });
      const nextSystem = system ?? current?.system ?? 'pos';
      const switching = current !== null && current.system !== nextSystem;
      if (nextSystem === 'digital_invoicing' && posId !== undefined) {
        return failOne(
          ['input', 'posId'],
          'INVALID',
          "FBR's digital invoicing has no POS ID: leave it out",
        );
      }
      if (!current || switching) {
        const doing = current ? `Reporting through ${SYSTEM_NAMES[nextSystem]}` : 'Connecting FBR';
        const missing = (
          [
            ['posId', nextSystem === 'pos' ? posId : null, 'the POS ID FBR gave the POS'],
            [
              'accessToken',
              accessToken,
              nextSystem === 'pos'
                ? 'the access token FBR gave it'
                : 'the security token FBR issued the seller through IRIS',
            ],
            ['environment', environment ?? current?.environment, "FBR's sandbox or production"],
            ['pctCode', pctCode ?? current?.pct_code, 'the PCT code its items are reported under'],
          ] as const
        ).find(([, value]) => value === undefined);
        if (missing) {
          return failOne(['input', missing[0]], 'BLANK', `${doing} needs ${missing[2]}`);
        }
        if (nextSystem === 'digital_invoicing') {
          const unregistered = sellerGaps(await taxSettingsIn(tx, tenant.shopId));
          if (unregistered) {
            return failOne(
              ['input', 'system'],
              'INVALID',
              "FBR's digital invoicing is for sellers registered for sales tax: set the shop's " +
                `${unregistered} in its tax settings first`,
            );
          }
        }
      }
      const opened = current && this.box.decrypt(current.access_token, sealedFor(tenant.shopId));
      const next = {
        system: nextSystem,
        posId: nextSystem === 'pos' ? (posId ?? Number(current!.pos_id)) : null,
        environment: environment ?? current!.environment,
        pctCode: pctCode ?? current!.pct_code,
      };
      const before = current && toPosRecord(current);
      const changed = [
        ...(current === null || next.system !== current.system ? ['system'] : []),
        ...(next.posId !== (before?.posId ?? null) ? ['posId'] : []),
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
        INSERT INTO tax.fbr_pos (shop_id, system, pos_id, access_token, token_hint, environment,
                                 pct_code)
        VALUES (${tenant.shopId}, ${next.system}, ${next.posId}, ${sealed}, ${hint},
                ${next.environment}, ${next.pctCode})
            ON CONFLICT (shop_id) DO UPDATE
                   SET system = excluded.system, pos_id = excluded.pos_id,
                       access_token = excluded.access_token, token_hint = excluded.token_hint,
                       environment = excluded.environment, pct_code = excluded.pct_code,
                       version = tax.fbr_pos.version + 1, updated_at = now()`);
      // Those kept for the other are in its shape, and go to neither.
      if (switching) {
        await tx.execute(sql`
          UPDATE tax.fiscal_invoices
             SET status = 'skipped',
                 error = ${`Not reported: the shop now reports through ${SYSTEM_NAMES[nextSystem]}`}
           WHERE shop_id = ${tenant.shopId} AND status = 'pending' AND system <> ${nextSystem}`);
      }
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
        payload: {
          system: next.system,
          changed,
          actorKind: actor.actorKind,
          actorId: actor.actorId,
        },
      });
      await recordAudit(tx, tenant.shopId, {
        action: 'fbr_pos.updated',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actor,
        details: {
          changed,
          system: next.system,
          posId: next.posId,
          tokenHint: hint,
          environment: next.environment,
          pctCode: next.pctCode,
          before: before && {
            system: before.system,
            posId: before.posId,
            tokenHint: before.tokenHint,
            environment: before.environment,
            pctCode: before.pctCode,
          },
        },
      });
      return { ok: true, value: toPosRecord((await posIn(tx, tenant.shopId))!) };
    });
  }

  /**
   * Disconnects the shop from FBR: its token is forgotten, invoices issued from now on are not
   * reported, and those still waiting for FBR are not sent. How it reported and the POS ID it
   * had, or null when nothing was connected.
   */
  async delete(tenant: TenantContext): Promise<{ system: FbrSystem; posId: number | null } | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<Pick<PosRow, 'system' | 'pos_id'>>(sql`
        DELETE FROM tax.fbr_pos WHERE shop_id = ${tenant.shopId} RETURNING system, pos_id`);
      if (!rows[0]) return null;
      const deleted = {
        system: rows[0].system,
        posId: rows[0].pos_id === null ? null : Number(rows[0].pos_id),
      };
      await tx.execute(sql`
        UPDATE tax.fiscal_invoices
           SET status = 'skipped', error = 'Not reported: the shop disconnected FBR'
         WHERE shop_id = ${tenant.shopId} AND status = 'pending'`);
      const actor = actorColumnsOf(tenant.actor);
      await appendEvent<FbrPosDeletedPayload>(tx, tenant.shopId, {
        type: TaxEvents.FbrPosDeleted,
        aggregateType: 'fbr_pos',
        aggregateId: tenant.shopId,
        payload: { ...deleted, actorKind: actor.actorKind, actorId: actor.actorId },
      });
      await recordAudit(tx, tenant.shopId, {
        action: 'fbr_pos.deleted',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actor,
        details: deleted,
      });
      return deleted;
    });
  }

  /** How the worker reports the shop's invoices, its token opened; null if not connected. */
  async connectionOf(shopId: string): Promise<FbrConnection | null> {
    const row = await this.db.tenant(shopId, (tx) => posIn(tx, shopId));
    if (!row) return null;
    const connection = {
      accessToken: this.box.decrypt(row.access_token, sealedFor(shopId)).toString('utf8'),
      environment: row.environment,
      pctCode: row.pct_code,
    };
    return row.system === 'pos'
      ? { system: 'pos', posId: Number(row.pos_id), ...connection }
      : { system: 'digital_invoicing', ...connection };
  }
}

/**
 * The invoices and credit notes the shop issued while connected to FBR, as they are reported to
 * FBR (ADR-555, ADR-562): the worker takes those due, reports them, and settles each as FBR
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
   * while the shop reports through what it was kept for. One for digital invoicing names the
   * seller as its tax settings now have it, which may be what FBR refused.
   */
  async retry(tenant: TenantContext, id: string): Promise<MutationResult<FiscalInvoiceRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<
        FiscalRow & { payload: DiInvoiceBody; connected: FbrSystem | null }
      >(sql`
        SELECT ${FISCAL_COLUMNS}, payload,
               (SELECT system FROM tax.fbr_pos WHERE shop_id = ${tenant.shopId}) AS connected
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
        return failOne(['id'], 'INVALID', 'Connect FBR first: nothing is sent without it');
      }
      if (row.connected !== row.system) {
        return failOne(
          ['id'],
          'INVALID',
          `It was kept for ${SYSTEM_NAMES[row.system]}, and the shop now reports through ` +
            SYSTEM_NAMES[row.connected],
        );
      }
      let payload = sql`payload`;
      if (row.system === 'digital_invoicing') {
        if (row.kind === 'credit_note') {
          return failOne(['id'], 'INVALID', DI_NO_CREDIT_NOTES.replace('Not reported: ', ''));
        }
        const { seller, gaps } = await sellerIn(tx, tenant.shopId);
        if (gaps) {
          return failOne(
            ['id'],
            'INVALID',
            `Set the shop's ${gaps} in its tax settings first: FBR's digital invoicing names ` +
              'the seller by them',
          );
        }
        payload = sql`${JSON.stringify(diWithSeller(row.payload, seller))}::jsonb`;
      }
      const { rows: updated } = await tx.execute<FiscalRow>(sql`
        UPDATE tax.fiscal_invoices
           SET status = 'pending', next_attempt_at = now(), payload = ${payload}
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
        system: FbrSystem;
        usin: string;
        payload: FbrInvoiceBody | DiInvoiceBody;
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
        RETURNING f.id, f.system, f.usin, f.payload, f.attempts, f.created_at`);
      return rows
        .map(
          (row) =>
            ({
              id: row.id,
              system: row.system,
              usin: row.usin,
              body: row.payload,
              attempts: row.attempts,
              createdAt: toDate(row.created_at),
            }) as ClaimedFiscalInvoice,
        )
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
 * in the caller's transaction, so they are kept only if it commits: while it is connected, in the
 * shape of what it reports through, and none twice. Digital invoicing takes no credit notes, and
 * they are kept as not to be sent; nor goes an invoice whose seller its tax settings no longer
 * name, until the shop names it and has it sent again. How many were kept.
 */
export async function recordFiscalDocumentsIn(
  tx: Tx,
  shopId: string,
  documents: readonly FiscalDocument[],
  timeZone: string,
): Promise<number> {
  if (documents.length === 0) return 0;
  const { rows } = await tx.execute<{ system: FbrSystem }>(sql`
    SELECT system FROM tax.fbr_pos WHERE shop_id = ${shopId}`);
  const system = rows[0]?.system;
  if (!system) return 0;
  const seller = system === 'digital_invoicing' ? await sellerIn(tx, shopId) : null;
  let kept = 0;
  for (const document of documents) {
    const { payload, status, error } = !seller
      ? { payload: fbrInvoiceBody(document, timeZone), status: 'pending', error: null }
      : document.kind === 'credit_note'
        ? { payload: {}, status: 'skipped', error: DI_NO_CREDIT_NOTES }
        : {
            payload: diInvoiceBody(document, seller.seller, timeZone),
            status: seller.gaps ? 'failed' : 'pending',
            error:
              seller.gaps &&
              `Not reported: set the shop's ${seller.gaps} in its tax settings, which FBR's ` +
                'digital invoicing names the seller by, and send it again',
          };
    const { rowCount } = await tx.execute(sql`
      INSERT INTO tax.fiscal_invoices (shop_id, id, system, kind, usin, order_id, payload, status,
                                       error)
      VALUES (${shopId}, ${newId()}, ${system}, ${document.kind}, ${document.usin},
              ${document.orderId}, ${JSON.stringify(payload)}::jsonb, ${status}, ${error})
          ON CONFLICT (shop_id, usin) DO NOTHING`);
    kept += rowCount ?? 0;
  }
  return kept;
}

/**
 * The seller as digital invoicing names it, from the shop's tax settings and its name in the shop
 * directory; with what of a seller registered for sales tax its tax settings lack, if anything.
 */
async function sellerIn(
  tx: Tx,
  shopId: string,
): Promise<{ seller: DiSeller; gaps: string | null }> {
  const settings = await taxSettingsIn(tx, shopId);
  const { name } = await shopProfile(tx, shopId);
  return {
    seller: { ntn: settings.ntn, businessName: name, province: settings.province },
    gaps: sellerGaps(settings),
  };
}

/**
 * What a seller registered for sales tax names that the shop's tax settings `settings` do not:
 * "NTN, STRN and province"; null when they name it all.
 */
function sellerGaps(settings: Pick<TaxSettingsRecord, 'ntn' | 'strn' | 'province'>): string | null {
  const gaps = [
    ...(settings.ntn ? [] : ['NTN']),
    ...(settings.strn ? [] : ['STRN']),
    ...(settings.province ? [] : ['province']),
  ];
  if (gaps.length === 0) return null;
  return gaps.length === 1 ? gaps[0]! : `${gaps.slice(0, -1).join(', ')} and ${gaps.at(-1)}`;
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
  'id, system, kind, usin, order_id, status, fbr_invoice_number, attempts, error, reported_at, ' +
    'created_at',
);

async function posIn(
  tx: Tx,
  shopId: string,
  options: { lock?: boolean } = {},
): Promise<PosRow | null> {
  const { rows } = await tx.execute<PosRow>(sql`
    SELECT system, pos_id, access_token, token_hint, environment, pct_code, updated_at
      FROM tax.fbr_pos
     WHERE shop_id = ${shopId}
     ${options.lock ? sql`FOR UPDATE` : sql``}`);
  return rows[0] ?? null;
}

function toPosRecord(row: PosRow): FbrPosRecord {
  return {
    system: row.system,
    posId: row.pos_id === null ? null : Number(row.pos_id),
    tokenHint: row.token_hint,
    environment: row.environment,
    pctCode: row.pct_code,
    updatedAt: toDate(row.updated_at),
  };
}

function toFiscalRecord(row: FiscalRow): FiscalInvoiceRecord {
  return {
    id: row.id,
    system: row.system,
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
