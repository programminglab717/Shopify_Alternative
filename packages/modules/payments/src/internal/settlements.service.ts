import { fail, failOne, InputChecker, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, toDate, type Tx } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  SETTLEMENT_LIMITS,
  readSettlement,
  readSettlementWorkbook,
  type SettlementRowError,
  type SettlementSource,
  type SettlementStatementLine,
} from './settlement-statement.js';

// Gateways' settlements (PAY-07, ADR-491): a statement of what a gateway paid over, imported
// whole, each line matched to a payment the shop took through the account by the gateway's
// reference for it, its fees and the tax withheld kept beside it, to say what selling online cost
// and what tax the shop can claim back.

export const SETTLEMENT_OUTCOMES = [
  'matched',
  'differs',
  'unmatched',
  'repeated',
  'refund',
] as const;
export type SettlementOutcome = (typeof SETTLEMENT_OUTCOMES)[number];

/** Lines that need no one to look into them. */
const SETTLED: readonly SettlementOutcome[] = ['matched', 'refund'];

/** A settlement's lines to look into, counted from its lines' primary key. */
const ISSUE_COUNT = sql.raw(`(SELECT count(*)::int FROM payments.settlement_lines l
   WHERE l.shop_id = s.shop_id AND l.settlement_id = s.id
     AND l.outcome NOT IN ('matched', 'refund')) AS issue_count`);

export interface SettlementRecord {
  id: string;
  accountId: string;
  /** The account's gateway, such as safepay. */
  gateway: string;
  reference: string | null;
  lineCount: number;
  /** Its lines to look into: those neither matched nor refunds. */
  issueCount: number;
  /** In minor units, as are the rest. */
  gross: bigint;
  fees: bigint;
  tax: bigint;
  net: bigint;
  createdAt: Date;
}

export interface SettlementLineRecord {
  row: number;
  transactionRef: string;
  sessionId: string | null;
  orderId: string | null;
  outcome: SettlementOutcome;
  gross: bigint;
  fees: bigint;
  tax: bigint;
  /** What the payment it matched was for. */
  paid: bigint | null;
}

export interface SettlementImportInput {
  accountId: string;
  csv?: string | null;
  xlsx?: string | null;
  /** The settlement's number or the payout's reference: the same account's again is refused. */
  reference?: string | null;
  /** Read the statement and say what would happen, writing nothing. */
  dryRun?: boolean;
}

export interface SettlementImport {
  /** Null on a dry run. */
  settlement: SettlementRecord | null;
  rows: number;
  outcomes: Record<SettlementOutcome, number>;
  gross: bigint;
  fees: bigint;
  tax: bigint;
  net: bigint;
  /** The first lines to look into, in the file's order. */
  issues: SettlementLineRecord[];
  rowErrors: SettlementRowError[];
  rowErrorCount: number;
  dryRun: boolean;
}

type SessionRow = {
  id: string;
  order_id: string;
  paid_amount: string | number;
  gateway_ref: string | null;
  reference: string | null;
};

type SettlementRow = {
  id: string;
  account_id: string;
  gateway: string;
  reference: string | null;
  line_count: number;
  issue_count: number;
  gross: string | number;
  fees: string | number;
  tax: string | number;
  net: string | number;
  created_at: string | Date;
};

function toSettlement(row: SettlementRow): SettlementRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    gateway: row.gateway,
    reference: row.reference,
    lineCount: row.line_count,
    issueCount: row.issue_count,
    gross: BigInt(row.gross),
    fees: BigInt(row.fees),
    tax: BigInt(row.tax),
    net: BigInt(row.net),
    createdAt: toDate(row.created_at),
  };
}

/**
 * Each line matched to the account's payment the gateway names by its reference, its own or the
 * one it gave when the payment was made, without regard to case: matched where the gateway
 * settled what was paid, differs where not; a payment settled before, or twice in the file, is
 * repeated; a line taking money back is a refund.
 */
export function matchSettlement(
  lines: readonly SettlementStatementLine[],
  sessions: readonly SessionRow[],
  settledBefore: ReadonlySet<string>,
): SettlementLineRecord[] {
  const byRef = new Map<string, SessionRow>();
  for (const session of sessions) {
    for (const ref of [session.gateway_ref, session.reference]) {
      if (ref) byRef.set(ref.trim().toLowerCase(), session);
    }
  }
  const settled = new Set(settledBefore);
  return lines.map((line) => {
    const session = byRef.get(line.reference.trim().toLowerCase()) ?? null;
    const paid = session ? BigInt(session.paid_amount) : null;
    const outcome: SettlementOutcome =
      line.gross < 0n
        ? 'refund'
        : !session
          ? 'unmatched'
          : settled.has(session.id)
            ? 'repeated'
            : line.gross === paid
              ? 'matched'
              : 'differs';
    if (session && (outcome === 'matched' || outcome === 'differs')) settled.add(session.id);
    return {
      row: line.row,
      transactionRef: line.reference,
      sessionId: session?.id ?? null,
      orderId: session?.order_id ?? null,
      outcome,
      gross: line.gross,
      fees: line.fees,
      tax: line.tax,
      paid,
    };
  });
}

/** Gateways' settlement statements (PAY-07, ADR-491), imported one at a time, each once. */
@Injectable()
export class PaymentSettlementService {
  constructor(private readonly db: Database) {}

  async import(
    tenant: TenantContext,
    input: SettlementImportInput,
  ): Promise<MutationResult<SettlementImport>> {
    const check = new InputChecker();
    const reference = check.text(['reference'], input.reference, { max: 100 });
    if (!check.ok) return fail(check.errors);
    const workbook = input.xlsx ?? null;
    if (workbook !== null && (input.csv ?? null) !== null) {
      return failOne(['xlsx'], 'INVALID', 'Give the statement as csv or as xlsx, not both');
    }
    const source: SettlementSource = workbook === null ? 'csv' : 'xlsx';
    const read =
      workbook === null
        ? readSettlement(input.csv ?? '', tenant.currency)
        : readSettlementWorkbook(workbook, tenant.currency);
    if (!read.ok) return read;
    const statement = read.value;
    if (statement.lines.length === 0) {
      return failOne([source], 'INVALID', 'No row of the file could be read');
    }
    const dryRun = input.dryRun ?? false;
    const shopId = tenant.shopId;
    return this.db.tenant(shopId, async (tx): Promise<MutationResult<SettlementImport>> => {
      const { rows: accounts } = await tx.execute<{ gateway: string }>(sql`
        SELECT gateway FROM payments.gateway_accounts WHERE shop_id = ${shopId}
           AND id = ${input.accountId}`);
      if (!accounts[0]) {
        return failOne(['accountId'], 'NOT_FOUND', 'No gateway account of the shop has this ID');
      }
      if (!dryRun) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`settlements:${shopId}`}, 0))`,
        );
      }
      if (reference !== null) {
        const { rows: taken } = await tx.execute<{ id: string }>(sql`
          SELECT id FROM payments.settlements
           WHERE shop_id = ${shopId} AND account_id = ${input.accountId}
             AND reference = ${reference}`);
        if (taken[0]) {
          return failOne(
            ['reference'],
            'TAKEN',
            `The settlement ${reference} has been imported already`,
          );
        }
      }
      const refs = [...new Set(statement.lines.map((line) => line.reference.trim().toLowerCase()))];
      const { rows: sessions } = await tx.execute<SessionRow>(sql`
        SELECT id, order_id, paid_amount, gateway_ref, reference FROM payments.sessions
         WHERE shop_id = ${shopId} AND account_id = ${input.accountId} AND status = 'paid'
           AND (lower(gateway_ref) = ANY(${sql.param(refs)}::text[])
                OR lower(reference) = ANY(${sql.param(refs)}::text[]))`);
      const { rows: before } = await tx.execute<{ session_id: string }>(sql`
        SELECT session_id FROM payments.settlement_lines
         WHERE shop_id = ${shopId} AND outcome IN ('matched', 'differs')
           AND session_id = ANY(${sql.param(sessions.map((session) => session.id))}::uuid[])`);
      const lines = matchSettlement(
        statement.lines,
        sessions,
        new Set(before.map((row) => row.session_id)),
      );
      const sum = (pick: (line: SettlementLineRecord) => bigint) =>
        lines.reduce((total, line) => total + pick(line), 0n);
      const totals = {
        gross: sum((line) => line.gross),
        fees: sum((line) => line.fees),
        tax: sum((line) => line.tax),
        net: statement.lines.reduce(
          (total, line) => total + (line.net ?? line.gross - line.fees - line.tax),
          0n,
        ),
      };
      const outcomes = Object.fromEntries(
        SETTLEMENT_OUTCOMES.map((outcome) => [
          outcome,
          lines.filter((line) => line.outcome === outcome).length,
        ]),
      ) as Record<SettlementOutcome, number>;
      const issues = lines
        .filter((line) => !SETTLED.includes(line.outcome))
        .slice(0, SETTLEMENT_LIMITS.lines);
      const result = {
        rows: statement.rows,
        outcomes,
        ...totals,
        issues,
        rowErrors: statement.rowErrors,
        rowErrorCount: statement.rowErrorCount,
        dryRun,
      };
      if (dryRun) return { ok: true, value: { settlement: null, ...result } };

      const actor =
        tenant.actor.kind === 'app'
          ? { kind: 'app', id: tenant.actor.tokenId }
          : { kind: 'staff', id: tenant.actor.kind === 'staff' ? tenant.actor.userId : null };
      const { rows: made } = await tx.execute<{ id: string }>(sql`
        INSERT INTO payments.settlements (shop_id, account_id, reference, line_count, gross, fees,
                                          tax, net, actor_kind, actor_id)
        VALUES (${shopId}, ${input.accountId}, ${reference}, ${lines.length},
                ${totals.gross.toString()}::bigint, ${totals.fees.toString()}::bigint,
                ${totals.tax.toString()}::bigint, ${totals.net.toString()}::bigint,
                ${actor.kind}, ${actor.id})
        RETURNING id`);
      const settlementId = made[0]!.id;
      for (const line of lines) {
        await tx.execute(sql`
          INSERT INTO payments.settlement_lines (shop_id, settlement_id, file_row, transaction_ref,
                                                 session_id, order_id, outcome, gross, fees, tax,
                                                 paid)
          VALUES (${shopId}, ${settlementId}, ${line.row}, ${line.transactionRef},
                  ${line.sessionId}, ${line.orderId}, ${line.outcome},
                  ${line.gross.toString()}::bigint, ${line.fees.toString()}::bigint,
                  ${line.tax.toString()}::bigint,
                  ${line.paid === null ? null : line.paid.toString()}::bigint)`);
      }
      return {
        ok: true,
        value: { settlement: (await this.load(tx, shopId, settlementId))!, ...result },
      };
    });
  }

  /** The shop's settlements, the newest first. */
  async list(tenant: TenantContext, first = 50): Promise<SettlementRecord[]> {
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<SettlementRow>(sql`
        SELECT s.id, s.account_id, a.gateway, s.reference, s.line_count, ${ISSUE_COUNT},
               s.gross, s.fees, s.tax, s.net, s.created_at
          FROM payments.settlements s
          JOIN payments.gateway_accounts a ON a.shop_id = s.shop_id AND a.id = s.account_id
         WHERE s.shop_id = ${tenant.shopId}
         ORDER BY s.created_at DESC, s.id DESC
         LIMIT ${Math.min(Math.max(first, 1), 250)}`),
    );
    return rows.map(toSettlement);
  }

  /**
   * The shop's settlements imported at or after `from` and before `before`, the oldest first,
   * `limit` at most: what gateways paid over in a period, for the payouts report (ANL-09, TAX-03).
   */
  async importedBetween(
    tenant: TenantContext,
    period: { from: Date; before: Date; limit: number },
  ): Promise<SettlementRecord[]> {
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<SettlementRow>(sql`
        SELECT s.id, s.account_id, a.gateway, s.reference, s.line_count, ${ISSUE_COUNT},
               s.gross, s.fees, s.tax, s.net, s.created_at
          FROM payments.settlements s
          JOIN payments.gateway_accounts a ON a.shop_id = s.shop_id AND a.id = s.account_id
         WHERE s.shop_id = ${tenant.shopId}
           AND s.created_at >= ${period.from.toISOString()}::timestamptz
           AND s.created_at < ${period.before.toISOString()}::timestamptz
         ORDER BY s.created_at, s.id
         LIMIT ${period.limit}`),
    );
    return rows.map(toSettlement);
  }

  async get(tenant: TenantContext, id: string): Promise<SettlementRecord | null> {
    return this.db.tenant(tenant.shopId, (tx) => this.load(tx, tenant.shopId, id));
  }

  /** A settlement's lines in the file's order; those of one outcome, if given. */
  async lines(
    tenant: TenantContext,
    settlementId: string,
    outcome: SettlementOutcome | null = null,
  ): Promise<SettlementLineRecord[]> {
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<{
        file_row: number;
        transaction_ref: string;
        session_id: string | null;
        order_id: string | null;
        outcome: SettlementOutcome;
        gross: string | number;
        fees: string | number;
        tax: string | number;
        paid: string | number | null;
      }>(sql`
        SELECT file_row, transaction_ref, session_id, order_id, outcome, gross, fees, tax, paid
          FROM payments.settlement_lines
         WHERE shop_id = ${tenant.shopId} AND settlement_id = ${settlementId}
           ${outcome === null ? sql`` : sql`AND outcome = ${outcome}`}
         ORDER BY file_row
         LIMIT ${SETTLEMENT_LIMITS.rows}`),
    );
    return rows.map((row) => ({
      row: row.file_row,
      transactionRef: row.transaction_ref,
      sessionId: row.session_id,
      orderId: row.order_id,
      outcome: row.outcome,
      gross: BigInt(row.gross),
      fees: BigInt(row.fees),
      tax: BigInt(row.tax),
      paid: row.paid === null ? null : BigInt(row.paid),
    }));
  }

  private async load(tx: Tx, shopId: string, id: string): Promise<SettlementRecord | null> {
    const { rows } = await tx.execute<SettlementRow>(sql`
      SELECT s.id, s.account_id, a.gateway, s.reference, s.line_count, ${ISSUE_COUNT},
             s.gross, s.fees, s.tax, s.net, s.created_at
        FROM payments.settlements s
        JOIN payments.gateway_accounts a ON a.shop_id = s.shop_id AND a.id = s.account_id
       WHERE s.shop_id = ${shopId} AND s.id = ${id}`);
    return rows[0] ? toSettlement(rows[0]) : null;
  }
}
