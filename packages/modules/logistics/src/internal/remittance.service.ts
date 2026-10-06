import { InputChecker, fail, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { formatMoney, money } from '@hatti/money';
import {
  chargeParcelsIn,
  codOwedIn,
  parcelStatesIn,
  parcelsByTrackingIn,
  payClaimsIn,
  receiveCodIn,
} from '@hatti/orders/public';
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
import {
  STATEMENT_LIMITS,
  digestOf,
  readStatement,
  readStatementWorkbook,
  type StatementRowError,
  type StatementSource,
} from './statement.js';

export interface RemittanceImportInput {
  /** The courier, as staff name it. */
  courier: string;
  /** The statement, as the courier sent it, in CSV; or `xlsx`. */
  csv?: string | null;
  /** The statement as the Excel workbook the courier sent, in base64 (ADR-246); or `csv`. */
  xlsx?: string | null;
  /**
   * The statement's number or the payment's reference. One imported before is refused, as is one
   * with the same lines, unless both have references and they differ, for charges alone.
   */
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
  /** What of the cash paid, or would pay, claims for parcels the courier lost (ADR-093). */
  compensated: bigint;
  /** The first {@link STATEMENT_LIMITS.lines} lines to look into, in the file's order. */
  issues: CodRemittanceLineRecord[];
  rowErrors: StatementRowError[];
  rowErrorCount: number;
  dryRun: boolean;
}

/**
 * Couriers' remittance statements (COD-10), as CSV or as the Excel workbooks couriers send
 * (ADR-246): a statement imported whole, in one transaction, each line matched to a parcel by
 * its tracking number and its cash received on the parcel's order through the orders module,
 * which says what the order still owes, and its charges kept on the parcel (ADR-088); cash for
 * a parcel the courier lost pays the parcel's claim (ADR-093). Lines that match no parcel, or
 * one whose cash came before, receive nothing and are kept to look into, but for other cash on a
 * parcel whose order the courier paid short. A shop's statements are imported one at a time, and
 * each once.
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
    const workbook = input.xlsx ?? null;
    if (workbook !== null && (input.csv ?? null) !== null) {
      return failOne(['xlsx'], 'INVALID', 'Give the statement as csv or as xlsx, not both');
    }
    const source: StatementSource = workbook === null ? 'csv' : 'xlsx';
    const read =
      workbook === null
        ? readStatement(input.csv ?? '', tenant.currency)
        : readStatementWorkbook(workbook, tenant.currency);
    if (!read.ok) return read;
    const statement = read.value;
    const dryRun = input.dryRun ?? false;
    const digest = digestOf(statement.lines);
    const cash = statement.lines.some((line) => line.collected > 0n);
    return this.db.tenant(tenant.shopId, async (tx): Promise<MutationResult<RemittanceImport>> => {
      if (!dryRun) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`cod_remittances:${tenant.shopId}`}, 0))`,
        );
      }
      if (reference !== null && (await this.#imported(tx, tenant.shopId, courier, reference))) {
        return failOne(
          ['reference'],
          'TAKEN',
          `The statement ${reference} from ${courier} has been imported already`,
        );
      }
      // A parcel's cash is collected once, so the same lines with cash are the same statement.
      // Charges alone can come twice alike, a parcel charged out and back on statements of its
      // own, which their references tell apart.
      const same = await this.#sameLines(tx, tenant.shopId, digest);
      const taken = same.find(
        (earlier) =>
          cash ||
          earlier.reference === null ||
          reference === null ||
          earlier.reference === reference,
      );
      if (taken) {
        const named = taken.reference
          ? `the statement ${taken.reference} from ${taken.courier}`
          : `one from ${taken.courier}`;
        const another = !cash && reference === null && same.every((each) => each.reference);
        return failOne(
          [source],
          'TAKEN',
          `This statement has the same lines as ${named}, imported already` +
            (another ? '; if it is another statement, give its reference' : ''),
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
      // As they are now their orders are locked: lost meanwhile, or their claims settled.
      const states = await parcelStatesIn(
        tx,
        tenant.shopId,
        matched.map((parcel) => parcel.id),
      );
      const current = parcels.map((parcel) => parcel && { ...parcel, ...states.get(parcel.id) });
      const before = await this.#collectedBefore(
        tx,
        tenant.shopId,
        matched.map((parcel) => parcel.id),
      );
      const lines = reconcile(statement.lines, current, orders, before);
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
        compensated: sum((line) => (line.outcome === 'compensated' ? line.collected : 0n)),
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
          digest,
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
        const received = formatMoney(money(amount, tenant.currency));
        await receiveCodIn(tx, tenant.shopId, tenant.actor, {
          orderId,
          amount,
          message: `${received} received from ${courier}${statementName}`,
        });
      }
      // What the courier charged for each parcel, kept on it: all but on lines for cash collected
      // before, whose charges came with it.
      const charged = new Map<string, bigint>();
      for (const line of lines) {
        if (line.fulfillmentId === null || line.charges === 0n) continue;
        if (line.outcome === 'repeated' && line.collected > 0n) continue;
        charged.set(line.fulfillmentId, (charged.get(line.fulfillmentId) ?? 0n) + line.charges);
      }
      await chargeParcelsIn(tx, tenant.shopId, tenant.actor, {
        charges: charged,
        message: (amount, trackingNumber) =>
          `${courier} charged ${formatMoney(money(amount, tenant.currency))} for the parcel` +
          `${trackingNumber ? ` ${trackingNumber}` : ''}${statementName}`,
      });
      // What the courier paid for the parcels it lost pays their claims, filed or not.
      const compensation = new Map<string, bigint>();
      for (const line of lines) {
        if (line.outcome === 'compensated' && line.fulfillmentId !== null) {
          compensation.set(line.fulfillmentId, line.collected);
        }
      }
      await payClaimsIn(tx, tenant.shopId, tenant.actor, {
        payments: compensation,
        message: (amount, trackingNumber) =>
          `${courier} paid ${formatMoney(money(amount, tenant.currency))} on the claim for the ` +
          `lost parcel${trackingNumber ? ` ${trackingNumber}` : ''}${statementName}`,
      });
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

  /** The statements imported before with lines whose digest is `digest`, oldest first. */
  async #sameLines(
    tx: Tx,
    shopId: string,
    digest: Buffer,
  ): Promise<{ courier: string; reference: string | null }[]> {
    return tx
      .select({ courier: codRemittances.courier, reference: codRemittances.reference })
      .from(codRemittances)
      .where(and(eq(codRemittances.shopId, shopId), eq(codRemittances.digest, digest)))
      .orderBy(codRemittances.createdAt, codRemittances.id);
  }

  /** The cash earlier statements collected on each parcel of `fulfillmentIds` with any. */
  async #collectedBefore(
    tx: Tx,
    shopId: string,
    fulfillmentIds: readonly string[],
  ): Promise<Map<string, bigint[]>> {
    const before = new Map<string, bigint[]>();
    if (fulfillmentIds.length === 0) return before;
    const rows = await tx
      .select({ id: codRemittanceLines.fulfillmentId, collected: codRemittanceLines.collected })
      .from(codRemittanceLines)
      .where(
        and(
          eq(codRemittanceLines.shopId, shopId),
          inArray(codRemittanceLines.fulfillmentId, [...new Set(fulfillmentIds)]),
          gt(codRemittanceLines.collected, 0n),
        ),
      );
    for (const { id, collected } of rows) {
      if (id) before.set(id, [...(before.get(id) ?? []), collected]);
    }
    return before;
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
  compensated: codRemittances.compensated,
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
  compensated: bigint;
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
    compensated: row.compensated,
    createdAt: row.createdAt,
  };
}
