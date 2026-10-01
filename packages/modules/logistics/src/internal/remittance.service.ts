import { InputChecker, fail, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { formatMoney, money } from '@hatti/money';
import { codOwedIn, parcelsByTrackingIn, receiveCodIn } from '@hatti/orders/public';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, gt, inArray, lt, notInArray, sql } from 'drizzle-orm';
import { LogisticsEvents, type CodRemittanceImportedPayload } from './events.js';
import { parcelFor, reconcile } from './reconcile.js';
import {
  SETTLED_OUTCOMES,
  type CodRemittanceLineRecord,
  type CodRemittanceRecord,
} from './records.js';
import {
  REMITTANCE_OUTCOMES,
  codRemittanceLines,
  codRemittances,
  type RemittanceOutcomeValue,
} from './schema.js';
import { STATEMENT_LIMITS, readStatement, type StatementRowError } from './statement.js';

export interface RemittanceImportInput {
  /** The courier, as staff name it. */
  courier: string;
  /** The statement, as the courier sent it, in CSV. */
  csv: string;
  /** The statement's number or the payment's reference; one imported before is refused. */
  reference?: string | null;
  /** Read the statement and say what would happen, writing nothing. */
  dryRun?: boolean;
}

/** What importing a statement did, or would do on a dry run. Amounts are in minor units. */
export interface RemittanceImport {
  /** Null on a dry run. */
  remittance: CodRemittanceRecord | null;
  /** Rows after the header. */
  rows: number;
  /** Lines with each outcome. */
  outcomes: Record<RemittanceOutcomeValue, number>;
  collected: bigint;
  charges: bigint;
  tax: bigint;
  paid: bigint;
  received: bigint;
  /** The first {@link STATEMENT_LIMITS.lines} lines to look into, in the file's order. */
  issues: CodRemittanceLineRecord[];
  rowErrors: StatementRowError[];
  rowErrorCount: number;
  dryRun: boolean;
}

/**
 * Couriers' remittance statements (COD-10): a statement imported whole, in one transaction, each
 * line matched to a parcel by its tracking number and its cash received on the parcel's order
 * through the orders module, which says what the order still owes. Lines that match no parcel,
 * or one whose cash was collected before, receive nothing and are kept to look into.
 */
@Injectable()
export class CodRemittanceService {
  constructor(private readonly db: Database) {}

  async import(
    tenant: TenantContext,
    input: RemittanceImportInput,
  ): Promise<MutationResult<RemittanceImport>> {
    const check = new InputChecker();
    const courier = check.text(['courier'], input.courier, { required: true, max: 100 });
    const reference = check.text(['reference'], input.reference, { max: 100 });
    if (!check.ok || courier === null) return fail(check.errors);
    const read = readStatement(input.csv, tenant.currency);
    if (!read.ok) return read;
    const statement = read.value;
    const dryRun = input.dryRun ?? false;
    return this.db.tenant(tenant.shopId, async (tx): Promise<MutationResult<RemittanceImport>> => {
      if (reference !== null && (await this.#imported(tx, tenant.shopId, courier, reference))) {
        return failOne(
          ['reference'],
          'TAKEN',
          `The statement ${reference} from ${courier} has been imported already`,
        );
      }
      const found = await parcelsByTrackingIn(
        tx,
        tenant.shopId,
        statement.lines.map((line) => line.key),
      );
      const parcels = statement.lines.map((line) => parcelFor(found.get(line.key) ?? [], courier));
      const matched = parcels.filter((parcel) => parcel !== null);
      // Locked, so that cash received at the same time by another statement waits for this one.
      const orders = await codOwedIn(
        tx,
        tenant.shopId,
        matched.map((parcel) => parcel.orderId),
        { lock: !dryRun },
      );
      const before = await this.#collectedBefore(
        tx,
        tenant.shopId,
        matched.map((parcel) => parcel.id),
      );
      const lines = reconcile(statement.lines, parcels, orders, before);
      const sum = (pick: (line: CodRemittanceLineRecord) => bigint) =>
        lines.reduce((total, line) => total + pick(line), 0n);
      const outcomes = Object.fromEntries(
        REMITTANCE_OUTCOMES.map((outcome) => [
          outcome,
          lines.filter((line) => line.outcome === outcome).length,
        ]),
      ) as Record<RemittanceOutcomeValue, number>;
      const totals = {
        collected: sum((line) => line.collected),
        charges: sum((line) => line.charges),
        tax: sum((line) => line.tax),
        paid: statement.lines.reduce(
          (total, line) => total + (line.net ?? line.collected - line.charges - line.tax),
          0n,
        ),
        received: sum((line) => line.received),
      };
      const issues = lines.filter((line) => !SETTLED_OUTCOMES.includes(line.outcome));
      const result = {
        rows: statement.rows,
        outcomes,
        ...totals,
        issues: issues.slice(0, STATEMENT_LIMITS.lines),
        rowErrors: statement.rowErrors,
        rowErrorCount: statement.rowErrorCount,
        dryRun,
      };
      if (dryRun || lines.length === 0) return { ok: true, value: { ...result, remittance: null } };

      const id = newId();
      const [row] = await tx
        .insert(codRemittances)
        .values({
          shopId: tenant.shopId,
          id,
          courier,
          reference,
          lineCount: lines.length,
          ...totals,
          ...(tenant.actor.kind === 'app'
            ? { actorKind: 'app' as const, actorId: tenant.actor.tokenId }
            : { actorKind: 'staff' as const, actorId: tenant.actor.userId }),
        })
        .returning();
      // A thousand at a time: thirteen columns a line stay under Postgres's limit of parameters.
      for (let at = 0; at < lines.length; at += 1_000) {
        await tx.insert(codRemittanceLines).values(
          lines.slice(at, at + 1_000).map(({ row: fileRow, ...line }) => ({
            shopId: tenant.shopId,
            remittanceId: id,
            fileRow,
            ...line,
          })),
        );
      }
      const byOrder = new Map<string, bigint>();
      for (const line of lines) {
        if (line.orderId && line.received > 0n) {
          byOrder.set(line.orderId, (byOrder.get(line.orderId) ?? 0n) + line.received);
        }
      }
      const statementName = reference ? `, statement ${reference}` : '';
      for (const [orderId, amount] of byOrder) {
        const cash = formatMoney(money(amount, tenant.currency));
        await receiveCodIn(tx, tenant.shopId, tenant.actor, {
          orderId,
          amount,
          message: `${cash} received from ${courier}${statementName}`,
        });
      }
      await appendEvent<CodRemittanceImportedPayload>(tx, tenant.shopId, {
        type: LogisticsEvents.CodRemittanceImported,
        aggregateType: 'cod_remittance',
        aggregateId: id,
        payload: {
          courier,
          reference,
          lineCount: lines.length,
          collected: totals.collected.toString(),
          received: totals.received.toString(),
        },
      });
      const remittance = { ...toRecord(row!), issueCount: issues.length };
      return { ok: true, value: { ...result, remittance } };
    });
  }

  /** The shop's statements, newest first, `first` at a time after the one `after` names. */
  async list(
    tenant: TenantContext,
    options: { first: number; after?: string | null },
  ): Promise<{ items: CodRemittanceRecord[]; hasNextPage: boolean }> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await tx
        .select({ ...REMITTANCE, issueCount: issueCountOf() })
        .from(codRemittances)
        .where(
          and(
            eq(codRemittances.shopId, tenant.shopId),
            options.after ? lt(codRemittances.id, options.after) : undefined,
          ),
        )
        .orderBy(desc(codRemittances.id))
        .limit(options.first + 1);
      return {
        items: rows
          .slice(0, options.first)
          .map((row) => ({ ...toRecord(row), issueCount: row.issueCount })),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  async get(tenant: TenantContext, id: string): Promise<CodRemittanceRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [row] = await tx
        .select({ ...REMITTANCE, issueCount: issueCountOf() })
        .from(codRemittances)
        .where(and(eq(codRemittances.shopId, tenant.shopId), eq(codRemittances.id, id)));
      return row ? { ...toRecord(row), issueCount: row.issueCount } : null;
    });
  }

  /**
   * A statement's lines in the file's order, `first` at a time after the row `after`; with
   * `issuesOnly`, those to look into.
   */
  async lines(
    tenant: TenantContext,
    remittanceId: string,
    options: { first: number; after?: number | null; issuesOnly?: boolean },
  ): Promise<CodRemittanceLineRecord[]> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await tx
        .select()
        .from(codRemittanceLines)
        .where(
          and(
            eq(codRemittanceLines.shopId, tenant.shopId),
            eq(codRemittanceLines.remittanceId, remittanceId),
            options.after ? gt(codRemittanceLines.fileRow, options.after) : undefined,
            options.issuesOnly
              ? notInArray(codRemittanceLines.outcome, [...SETTLED_OUTCOMES])
              : undefined,
          ),
        )
        .orderBy(codRemittanceLines.fileRow)
        .limit(options.first);
      return rows.map(({ shopId: _, remittanceId: __, fileRow, ...line }) => ({
        row: fileRow,
        ...line,
      }));
    });
  }

  /** Whether the courier's statement `reference` has been imported. */
  async #imported(tx: Tx, shopId: string, courier: string, reference: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: codRemittances.id })
      .from(codRemittances)
      .where(
        and(
          eq(codRemittances.shopId, shopId),
          sql`lower(${codRemittances.courier}) = lower(${courier})`,
          eq(codRemittances.reference, reference),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** The parcels of `fulfillmentIds` whose cash earlier statements collected. */
  async #collectedBefore(
    tx: Tx,
    shopId: string,
    fulfillmentIds: readonly string[],
  ): Promise<Set<string>> {
    if (fulfillmentIds.length === 0) return new Set();
    const rows = await tx
      .selectDistinct({ id: codRemittanceLines.fulfillmentId })
      .from(codRemittanceLines)
      .where(
        and(
          eq(codRemittanceLines.shopId, shopId),
          inArray(codRemittanceLines.fulfillmentId, [...new Set(fulfillmentIds)]),
          gt(codRemittanceLines.collected, 0n),
        ),
      );
    return new Set(rows.flatMap((row) => (row.id ? [row.id] : [])));
  }
}

const REMITTANCE = {
  id: codRemittances.id,
  courier: codRemittances.courier,
  reference: codRemittances.reference,
  lineCount: codRemittances.lineCount,
  collected: codRemittances.collected,
  charges: codRemittances.charges,
  tax: codRemittances.tax,
  paid: codRemittances.paid,
  received: codRemittances.received,
  createdAt: codRemittances.createdAt,
};

/** How many of a statement's lines are to look into. */
function issueCountOf() {
  const settled = sql.join(
    SETTLED_OUTCOMES.map((outcome) => sql`${outcome}`),
    sql`, `,
  );
  return sql<number>`(
    SELECT count(*)::int FROM logistics.cod_remittance_lines l
     WHERE l.shop_id = ${codRemittances.shopId} AND l.remittance_id = ${codRemittances.id}
       AND l.outcome NOT IN (${settled}))`.mapWith(Number);
}

function toRecord(row: {
  id: string;
  courier: string;
  reference: string | null;
  lineCount: number;
  collected: bigint;
  charges: bigint;
  tax: bigint;
  paid: bigint;
  received: bigint;
  createdAt: Date;
}): Omit<CodRemittanceRecord, 'issueCount'> {
  return {
    id: row.id,
    courier: row.courier,
    reference: row.reference,
    lineCount: row.lineCount,
    collected: row.collected,
    charges: row.charges,
    tax: row.tax,
    paid: row.paid,
    received: row.received,
    createdAt: row.createdAt,
  };
}
