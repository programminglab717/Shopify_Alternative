import {
  InputChecker,
  actorColumnsOf,
  fail,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { VariantService } from '@hatti/catalog/public';
import { CustomerService } from '@hatti/customers/public';
import { Database, toDate, toDateOrNull, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService, StockService } from '@hatti/inventory/public';
import { orderTaxOf, taxSettingsIn } from '@hatti/tax/public';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { OrderEvents } from './events.js';

// The shop's tills (POS-01, POS-02, POS-05, POS-07, ADR-872). A register sells from one of the
// shop's locations, in cash sessions staff open with a float and close by counting the drawer;
// the Z report says what it should hold. A sale at the till is not an order: a walk-in gives no
// number or address, and nothing is delivered. Its units leave the location's shelf at once, it
// is paid in cash, by card on the shop's own terminal, by transfer or by wallet, and a customer's
// number links it to them. A till that sold while offline sends its sales later, each with its
// own ID, so that one sent twice is kept once.

export const POS_LIMITS = {
  /** Registers a shop keeps. */
  registers: 50,
  /** Lines a sale has. */
  lines: 200,
  /** Ways a sale is paid. */
  tenders: 5,
  /** Units of a line. */
  quantity: 10_000,
  note: 500,
  reference: 100,
  movementNote: 200,
  /** How long after it was sold an offline till may still send a sale. */
  offlineDays: 7,
  /** Variants the till keeps to sell from. */
  catalog: 5_000,
} as const;

/** A variant as the till sells it, with what its location has available; null untracked. */
export interface PosCatalogItem {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  barcode: string | null;
  price: bigint;
  available: number | null;
}

export const POS_TENDER_METHODS = ['cash', 'card', 'bank_transfer', 'wallet'] as const;
export type PosTenderMethod = (typeof POS_TENDER_METHODS)[number];

export interface PosRegisterRecord {
  id: string;
  name: string;
  locationId: string;
  /** Its session open now; null when none is. */
  openSessionId: string | null;
  createdAt: Date;
}

export interface PosSessionRecord {
  id: string;
  registerId: string;
  openedAt: Date;
  openedById: string;
  openingFloat: bigint;
  closedAt: Date | null;
  expectedCash: bigint | null;
  countedCash: bigint | null;
  closingNote: string | null;
}

/**
 * A session's Z report: what it sold, how it was paid, and what its drawer should hold, the
 * float with cash taken and put in, less change given, cash paid back and cash taken out.
 */
export interface PosSessionReport {
  session: PosSessionRecord;
  sales: number;
  gross: bigint;
  discounts: bigint;
  tax: bigint;
  returns: number;
  returned: bigint;
  /** Paid by each method, less what was paid back by it. */
  tenders: { method: PosTenderMethod; amount: bigint }[];
  cashIn: bigint;
  cashOut: bigint;
  /** What the drawer should hold now, or held as it closed. */
  expectedCash: bigint;
  /** Counted less expected: short below zero, over above; null while open. */
  difference: bigint | null;
}

export interface PosSaleLineRecord {
  id: string;
  variantId: string;
  productId: string;
  title: string;
  variantTitle: string;
  sku: string | null;
  quantity: number;
  unitPrice: bigint;
  discount: bigint;
  total: bigint;
  tax: bigint;
  returned: number;
}

export interface PosSaleRecord {
  id: string;
  number: number;
  clientId: string;
  registerId: string;
  sessionId: string;
  locationId: string;
  customerId: string | null;
  actorId: string;
  subtotal: bigint;
  discount: bigint;
  tax: bigint;
  total: bigint;
  changeGiven: bigint;
  returned: bigint;
  note: string;
  soldAt: Date;
  lines: PosSaleLineRecord[];
  tenders: { method: PosTenderMethod; amount: bigint; reference: string | null }[];
}

export interface PosSaleInput {
  /** The till's own ID for the sale, so that one sent twice is kept once. */
  clientId: string;
  sessionId: string;
  lines: { variantId: string; quantity: number; price?: string | null }[];
  /** Off the whole sale, in major units. */
  discount?: string | null;
  /** The customer's mobile number, to link the sale to them; none for a walk-in. */
  customerPhone?: string | null;
  customerName?: string | null;
  tenders: { method: PosTenderMethod; amount: string; reference?: string | null }[];
  note?: string | null;
  /** When the till sold it, for a sale sent later; now unless given. */
  soldAt?: Date | null;
}

export interface PosReturnInput {
  saleId: string;
  /** The session whose drawer pays it back. */
  sessionId: string;
  lines: { lineId: string; quantity: number }[];
  /** Back on the shelf, or written off as damaged. */
  restock: boolean;
  method: PosTenderMethod;
  reason?: string | null;
}

/** Pakistan's rupee is the till's: Hatti's shops sell in it (ADR-005). */
const CURRENCY = 'PKR' as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type SessionRow = {
  id: string;
  register_id: string;
  opened_at: string | Date;
  opened_by_id: string;
  opening_float: string;
  closed_at: string | Date | null;
  expected_cash: string | null;
  counted_cash: string | null;
  closing_note: string | null;
};

function toSession(row: SessionRow): PosSessionRecord {
  return {
    id: row.id,
    registerId: row.register_id,
    openedAt: toDate(row.opened_at),
    openedById: row.opened_by_id,
    openingFloat: BigInt(row.opening_float),
    closedAt: toDateOrNull(row.closed_at),
    expectedCash: row.expected_cash === null ? null : BigInt(row.expected_cash),
    countedCash: row.counted_cash === null ? null : BigInt(row.counted_cash),
    closingNote: row.closing_note,
  };
}

async function sessionIn(
  tx: Tx,
  shopId: string,
  id: string,
  options: { lock?: boolean } = {},
): Promise<PosSessionRecord | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await tx.execute<SessionRow>(sql`
    SELECT id, register_id, opened_at, opened_by_id, opening_float::text, closed_at,
           expected_cash::text, counted_cash::text, closing_note
      FROM orders.pos_sessions
     WHERE shop_id = ${shopId} AND id = ${id}
     ${options.lock ? sql`FOR UPDATE` : sql``}`);
  return rows[0] ? toSession(rows[0]) : null;
}

/** The register `id`, with its location; null for none, or one archived. */
async function registerIn(
  tx: Tx,
  shopId: string,
  id: string,
): Promise<{ id: string; locationId: string; name: string } | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await tx.execute<{ id: string; location_id: string; name: string }>(sql`
    SELECT id, location_id, name FROM orders.pos_registers
     WHERE shop_id = ${shopId} AND id = ${id} AND archived_at IS NULL`);
  return rows[0] ? { id: rows[0].id, locationId: rows[0].location_id, name: rows[0].name } : null;
}

/** What `session`'s drawer should hold now: its float, cash taken and put in, less what left. */
async function expectedCashIn(tx: Tx, shopId: string, session: PosSessionRecord): Promise<bigint> {
  const { rows } = await tx.execute<{ cash: string }>(sql`
    SELECT (${session.openingFloat}::bigint
      + coalesce((SELECT sum(t.amount) FROM orders.pos_tenders t
                    JOIN orders.pos_sales s ON s.shop_id = t.shop_id AND s.id = t.sale_id
                   WHERE t.shop_id = ${shopId} AND s.session_id = ${session.id}
                     AND t.method = 'cash'), 0)
      - coalesce((SELECT sum(change_given) FROM orders.pos_sales
                   WHERE shop_id = ${shopId} AND session_id = ${session.id}), 0)
      - coalesce((SELECT sum(amount) FROM orders.pos_returns
                   WHERE shop_id = ${shopId} AND session_id = ${session.id}
                     AND method = 'cash'), 0)
      + coalesce((SELECT sum(CASE kind WHEN 'in' THEN amount ELSE -amount END)
                    FROM orders.pos_cash_movements
                   WHERE shop_id = ${shopId} AND session_id = ${session.id}), 0))::text AS cash`);
  return BigInt(rows[0]!.cash);
}

/** The shop's next till receipt number, #P1 onwards: take it last, as order numbers are. */
async function nextPosNumber(tx: Tx, shopId: string): Promise<number> {
  const { rows } = await tx.execute<{ number: number }>(sql`
    INSERT INTO orders.counters (shop_id, next_number, next_pos_number)
    VALUES (${shopId}, 1001, 2)
        ON CONFLICT (shop_id) DO UPDATE
       SET next_pos_number = orders.counters.next_pos_number + 1
    RETURNING next_pos_number - 1 AS number`);
  return rows[0]!.number;
}

type SaleRow = {
  id: string;
  number: number;
  client_id: string;
  register_id: string;
  session_id: string;
  location_id: string;
  customer_id: string | null;
  actor_id: string;
  subtotal: string;
  discount: string;
  tax: string;
  total: string;
  change_given: string;
  returned: string;
  note: string;
  sold_at: string | Date;
};

async function salesIn(tx: Tx, shopId: string, rows: SaleRow[]): Promise<PosSaleRecord[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const lines = await tx.execute<{
    id: string;
    sale_id: string;
    variant_id: string;
    product_id: string;
    title: string;
    variant_title: string;
    sku: string | null;
    quantity: number;
    unit_price: string;
    discount: string;
    total: string;
    tax: string;
    returned: number;
  }>(sql`
    SELECT id, sale_id, variant_id, product_id, title, variant_title, sku, quantity,
           unit_price::text, discount::text, total::text, tax::text, returned
      FROM orders.pos_sale_lines
     WHERE shop_id = ${shopId} AND sale_id IN (${sql.join(
       ids.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
     ORDER BY position`);
  const tenders = await tx.execute<{
    sale_id: string;
    method: PosTenderMethod;
    amount: string;
    reference: string | null;
  }>(sql`
    SELECT sale_id, method, amount::text, reference FROM orders.pos_tenders
     WHERE shop_id = ${shopId} AND sale_id IN (${sql.join(
       ids.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
     ORDER BY id`);
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    clientId: row.client_id,
    registerId: row.register_id,
    sessionId: row.session_id,
    locationId: row.location_id,
    customerId: row.customer_id,
    actorId: row.actor_id,
    subtotal: BigInt(row.subtotal),
    discount: BigInt(row.discount),
    tax: BigInt(row.tax),
    total: BigInt(row.total),
    changeGiven: BigInt(row.change_given),
    returned: BigInt(row.returned),
    note: row.note,
    soldAt: toDate(row.sold_at),
    lines: lines.rows
      .filter((line) => line.sale_id === row.id)
      .map((line) => ({
        id: line.id,
        variantId: line.variant_id,
        productId: line.product_id,
        title: line.title,
        variantTitle: line.variant_title,
        sku: line.sku,
        quantity: line.quantity,
        unitPrice: BigInt(line.unit_price),
        discount: BigInt(line.discount),
        total: BigInt(line.total),
        tax: BigInt(line.tax),
        returned: line.returned,
      })),
    tenders: tenders.rows
      .filter((tender) => tender.sale_id === row.id)
      .map((tender) => ({
        method: tender.method,
        amount: BigInt(tender.amount),
        reference: tender.reference,
      })),
  }));
}

const SALE_COLUMNS = sql`
  id, number, client_id, register_id, session_id, location_id, customer_id, actor_id,
  subtotal::text, discount::text, tax::text, total::text, change_given::text, returned::text,
  note, sold_at`;

async function saleIn(tx: Tx, shopId: string, id: string): Promise<PosSaleRecord | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await tx.execute<SaleRow>(sql`
    SELECT ${SALE_COLUMNS} FROM orders.pos_sales WHERE shop_id = ${shopId} AND id = ${id}`);
  return (await salesIn(tx, shopId, rows))[0] ?? null;
}

/** `amount` shared out over `weights` in proportion, the remainder to the largest. */
function shares(weights: readonly bigint[], amount: bigint): bigint[] {
  const whole = weights.reduce((sum, weight) => sum + weight, 0n);
  if (whole === 0n || amount === 0n) return weights.map(() => 0n);
  const parts = weights.map((weight) => (amount * weight) / whole);
  const left = amount - parts.reduce((sum, part) => sum + part, 0n);
  const largest = weights.indexOf(weights.reduce((max, weight) => (weight > max ? weight : max)));
  parts[largest] = parts[largest]! + left;
  return parts;
}

@Injectable()
export class PosService {
  constructor(
    private readonly db: Database,
    private readonly variants: VariantService,
    private readonly locations: LocationService,
    private readonly stock: StockService,
    private readonly customers: CustomerService,
    private readonly inventory: InventoryService,
  ) {}

  /**
   * What the register sells: the shop's active products' variants, with what its location has
   * available, for the till to find by title, SKU or barcode, and to keep for when it is offline.
   * Null for no such register.
   */
  async catalog(tenant: TenantContext, registerId: string): Promise<PosCatalogItem[] | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const register = await registerIn(tx, tenant.shopId, registerId);
      if (!register) return null;
      const forSale = await this.variants.forSaleIn(tx, tenant.shopId, POS_LIMITS.catalog);
      const available = await this.inventory.availableAt(
        tx,
        tenant.shopId,
        register.locationId,
        forSale.map((variant) => variant.variantId),
      );
      return forSale.map((variant) => ({
        ...variant,
        available: available.get(variant.variantId) ?? null,
      }));
    });
  }

  /** The shop's registers, by name, each with its open session. */
  async registers(tenant: TenantContext): Promise<PosRegisterRecord[]> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{
        id: string;
        name: string;
        location_id: string;
        created_at: string | Date;
        open_session_id: string | null;
      }>(sql`
        SELECT r.id, r.name, r.location_id, r.created_at, s.id AS open_session_id
          FROM orders.pos_registers r
          LEFT JOIN orders.pos_sessions s
            ON s.shop_id = r.shop_id AND s.register_id = r.id AND s.closed_at IS NULL
         WHERE r.shop_id = ${tenant.shopId} AND r.archived_at IS NULL
         ORDER BY lower(r.name)`);
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        locationId: row.location_id,
        openSessionId: row.open_session_id,
        createdAt: toDate(row.created_at),
      }));
    });
  }

  /** A new register, or one renamed or moved to another location while no session is open. */
  async saveRegister(
    tenant: TenantContext,
    input: { id?: string | null; name: string; locationId: string },
  ): Promise<MutationResult<PosRegisterRecord>> {
    const check = new InputChecker();
    const name = check.text(['input', 'name'], input.name, { required: true, max: 60 });
    if (!check.ok || !name) return fail(check.errors);
    const saved = await this.db.tenant(tenant.shopId, async (tx) => {
      const found = UUID.test(input.locationId)
        ? (await this.locations.locationsOf(tx, tenant.shopId, [input.locationId])).get(
            input.locationId,
          )
        : undefined;
      if (!found?.isActive) {
        return failOne<string>(['input', 'locationId'], 'NOT_FOUND', 'No such active location');
      }
      const { rows: taken } = await tx.execute<{ id: string }>(sql`
        SELECT id FROM orders.pos_registers
         WHERE shop_id = ${tenant.shopId} AND archived_at IS NULL AND lower(name) = lower(${name})
           AND id IS DISTINCT FROM ${input.id ?? null}::uuid`);
      if (taken[0]) {
        return failOne<string>(['input', 'name'], 'TAKEN', 'Another register has this name');
      }
      if (input.id) {
        const register = await registerIn(tx, tenant.shopId, input.id);
        if (!register) return failOne<string>(['input', 'id'], 'NOT_FOUND', 'No such register');
        const { rows: open } = await tx.execute<{ id: string }>(sql`
          SELECT id FROM orders.pos_sessions
           WHERE shop_id = ${tenant.shopId} AND register_id = ${register.id}
             AND closed_at IS NULL`);
        if (open[0] && register.locationId !== input.locationId) {
          return failOne<string>(
            ['input', 'locationId'],
            'INVALID',
            'Close the register’s session before moving it to another location',
          );
        }
        await tx.execute(sql`
          UPDATE orders.pos_registers SET name = ${name}, location_id = ${input.locationId}
           WHERE shop_id = ${tenant.shopId} AND id = ${register.id}`);
        return { ok: true as const, value: register.id };
      }
      const { rows: count } = await tx.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM orders.pos_registers
         WHERE shop_id = ${tenant.shopId} AND archived_at IS NULL`);
      if (count[0]!.count >= POS_LIMITS.registers) {
        return failOne<string>(
          ['input'],
          'TOO_MANY',
          `A shop keeps ${POS_LIMITS.registers} registers at most`,
        );
      }
      const id = newId();
      await tx.execute(sql`
        INSERT INTO orders.pos_registers (shop_id, id, name, location_id)
        VALUES (${tenant.shopId}, ${id}, ${name}, ${input.locationId})`);
      return { ok: true as const, value: id };
    });
    if (!saved.ok) return saved;
    return { ok: true, value: (await this.registers(tenant)).find((r) => r.id === saved.value)! };
  }

  /** Takes a register away, once its session is closed; its sales stay. */
  async archiveRegister(
    tenant: TenantContext,
    id: string,
  ): Promise<MutationResult<{ id: string }>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const register = await registerIn(tx, tenant.shopId, id);
      if (!register) return failOne(['id'], 'NOT_FOUND', 'No such register');
      const { rows } = await tx.execute<{ id: string }>(sql`
        SELECT id FROM orders.pos_sessions
         WHERE shop_id = ${tenant.shopId} AND register_id = ${id} AND closed_at IS NULL`);
      if (rows[0]) return failOne(['id'], 'INVALID', 'Close the register’s session first');
      await tx.execute(sql`
        UPDATE orders.pos_registers SET archived_at = now()
         WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
      return { ok: true, value: { id } };
    });
  }

  /** Opens a session on the register, with `openingFloat` in its drawer. */
  async openSession(
    tenant: TenantContext,
    registerId: string,
    openingFloat: string,
  ): Promise<MutationResult<PosSessionRecord>> {
    const check = new InputChecker();
    const float = check.price(['openingFloat'], openingFloat, CURRENCY, { required: true });
    if (!check.ok || float === null) return fail(check.errors);
    const actor = actorColumnsOf(tenant.actor);
    return this.db.tenant(tenant.shopId, async (tx) => {
      const register = await registerIn(tx, tenant.shopId, registerId);
      if (!register) return failOne(['registerId'], 'NOT_FOUND', 'No such register');
      const id = newId();
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO orders.pos_sessions
               (shop_id, id, register_id, opened_by_kind, opened_by_id, opening_float)
        VALUES (${tenant.shopId}, ${id}, ${registerId}, ${actor.actorKind}, ${actor.actorId},
                ${float})
            ON CONFLICT (shop_id, register_id) WHERE closed_at IS NULL DO NOTHING
        RETURNING id`);
      if (!rows[0]) {
        return failOne(['registerId'], 'INVALID', 'The register has a session open already');
      }
      return { ok: true, value: (await sessionIn(tx, tenant.shopId, id))! };
    });
  }

  /** Cash put into the drawer, or taken out of it, while the session is open. */
  async moveCash(
    tenant: TenantContext,
    input: { sessionId: string; kind: 'in' | 'out'; amount: string; note: string },
  ): Promise<MutationResult<PosSessionReport>> {
    const check = new InputChecker();
    const amount = check.price(['input', 'amount'], input.amount, CURRENCY, { required: true });
    const note = check.text(['input', 'note'], input.note, {
      required: true,
      max: POS_LIMITS.movementNote,
    });
    if (amount === 0n) check.add(['input', 'amount'], 'INVALID', 'must be more than zero');
    if (!check.ok || amount === null || !note) return fail(check.errors);
    const actor = actorColumnsOf(tenant.actor);
    const moved = await this.db.tenant(tenant.shopId, async (tx) => {
      const session = await sessionIn(tx, tenant.shopId, input.sessionId, { lock: true });
      if (!session) return failOne<null>(['input', 'sessionId'], 'NOT_FOUND', 'No such session');
      if (session.closedAt) {
        return failOne<null>(['input', 'sessionId'], 'INVALID', 'The session is closed');
      }
      if (input.kind === 'out' && amount > (await expectedCashIn(tx, tenant.shopId, session))) {
        return failOne<null>(['input', 'amount'], 'INVALID', 'The drawer holds less than that');
      }
      await tx.execute(sql`
        INSERT INTO orders.pos_cash_movements
               (shop_id, id, session_id, kind, amount, note, actor_kind, actor_id)
        VALUES (${tenant.shopId}, ${newId()}, ${session.id}, ${input.kind}, ${amount}, ${note},
                ${actor.actorKind}, ${actor.actorId})`);
      return { ok: true as const, value: null };
    });
    if (!moved.ok) return moved;
    return { ok: true, value: (await this.report(tenant, input.sessionId))! };
  }

  /** Closes the session with the cash counted in its drawer: its Z report. */
  async closeSession(
    tenant: TenantContext,
    input: { sessionId: string; countedCash: string; note?: string | null },
  ): Promise<MutationResult<PosSessionReport>> {
    const check = new InputChecker();
    const counted = check.price(['input', 'countedCash'], input.countedCash, CURRENCY, {
      required: true,
    });
    const note = check.text(['input', 'note'], input.note, { max: POS_LIMITS.movementNote });
    if (!check.ok || counted === null) return fail(check.errors);
    const actor = actorColumnsOf(tenant.actor);
    const closed = await this.db.tenant(tenant.shopId, async (tx) => {
      const session = await sessionIn(tx, tenant.shopId, input.sessionId, { lock: true });
      if (!session) return failOne<null>(['input', 'sessionId'], 'NOT_FOUND', 'No such session');
      if (session.closedAt) {
        return failOne<null>(['input', 'sessionId'], 'INVALID', 'The session is closed already');
      }
      const expected = await expectedCashIn(tx, tenant.shopId, session);
      await tx.execute(sql`
        UPDATE orders.pos_sessions
           SET closed_at = now(), closed_by_kind = ${actor.actorKind},
               closed_by_id = ${actor.actorId}, expected_cash = ${expected},
               counted_cash = ${counted}, closing_note = ${note}
         WHERE shop_id = ${tenant.shopId} AND id = ${session.id}`);
      await appendEvent(tx, tenant.shopId, {
        type: OrderEvents.PosSessionClosed,
        aggregateType: 'pos_session',
        aggregateId: session.id,
        payload: { registerId: session.registerId },
      });
      return { ok: true as const, value: null };
    });
    if (!closed.ok) return closed;
    return { ok: true, value: (await this.report(tenant, input.sessionId))! };
  }

  /** The session's Z report: open, as it stands now; closed, as it closed. */
  async report(tenant: TenantContext, sessionId: string): Promise<PosSessionReport | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const session = await sessionIn(tx, tenant.shopId, sessionId);
      if (!session) return null;
      const { rows: totals } = await tx.execute<{
        sales: number;
        gross: string;
        discounts: string;
        tax: string;
      }>(sql`
        SELECT count(*)::int AS sales, coalesce(sum(subtotal), 0)::text AS gross,
               coalesce(sum(discount), 0)::text AS discounts, coalesce(sum(tax), 0)::text AS tax
          FROM orders.pos_sales WHERE shop_id = ${tenant.shopId} AND session_id = ${session.id}`);
      const { rows: returns } = await tx.execute<{ returns: number; returned: string }>(sql`
        SELECT count(*)::int AS returns, coalesce(sum(amount), 0)::text AS returned
          FROM orders.pos_returns WHERE shop_id = ${tenant.shopId} AND session_id = ${session.id}`);
      const { rows: tenders } = await tx.execute<{ method: PosTenderMethod; amount: string }>(sql`
        SELECT method, sum(amount)::text AS amount FROM (
          SELECT t.method, t.amount
            FROM orders.pos_tenders t
            JOIN orders.pos_sales s ON s.shop_id = t.shop_id AND s.id = t.sale_id
           WHERE t.shop_id = ${tenant.shopId} AND s.session_id = ${session.id}
          UNION ALL
          SELECT 'cash', -change_given FROM orders.pos_sales
           WHERE shop_id = ${tenant.shopId} AND session_id = ${session.id} AND change_given > 0
          UNION ALL
          SELECT method, -amount FROM orders.pos_returns
           WHERE shop_id = ${tenant.shopId} AND session_id = ${session.id}) paid
         GROUP BY method ORDER BY method`);
      const { rows: moves } = await tx.execute<{ cash_in: string; cash_out: string }>(sql`
        SELECT coalesce(sum(amount) FILTER (WHERE kind = 'in'), 0)::text AS cash_in,
               coalesce(sum(amount) FILTER (WHERE kind = 'out'), 0)::text AS cash_out
          FROM orders.pos_cash_movements
         WHERE shop_id = ${tenant.shopId} AND session_id = ${session.id}`);
      const expected = session.expectedCash ?? (await expectedCashIn(tx, tenant.shopId, session));
      return {
        session,
        sales: totals[0]!.sales,
        gross: BigInt(totals[0]!.gross),
        discounts: BigInt(totals[0]!.discounts),
        tax: BigInt(totals[0]!.tax),
        returns: returns[0]!.returns,
        returned: BigInt(returns[0]!.returned),
        tenders: tenders.map((row) => ({ method: row.method, amount: BigInt(row.amount) })),
        cashIn: BigInt(moves[0]!.cash_in),
        cashOut: BigInt(moves[0]!.cash_out),
        expectedCash: expected,
        difference: session.countedCash === null ? null : session.countedCash - expected,
      };
    });
  }

  /**
   * A sale at the till: its units off the register's shelf, paid as it was tendered, with change
   * from cash. A sale whose till ID was kept already is that sale, unchanged.
   */
  async sell(
    tenant: TenantContext,
    input: PosSaleInput,
    now: Date = new Date(),
  ): Promise<MutationResult<PosSaleRecord>> {
    const check = new InputChecker();
    if (!UUID.test(input.clientId)) check.add(['input', 'clientId'], 'INVALID', 'must be a UUID');
    if (input.lines.length === 0) check.add(['input', 'lines'], 'BLANK', "can't be empty");
    if (input.lines.length > POS_LIMITS.lines) {
      check.add(['input', 'lines'], 'TOO_MANY', `can have at most ${POS_LIMITS.lines}`);
    }
    if (input.tenders.length === 0) check.add(['input', 'tenders'], 'BLANK', "can't be empty");
    if (input.tenders.length > POS_LIMITS.tenders) {
      check.add(['input', 'tenders'], 'TOO_MANY', `can have at most ${POS_LIMITS.tenders}`);
    }
    const lines = input.lines.map((line, index) => ({
      variantId: line.variantId,
      quantity: check.integer(['input', 'lines', String(index), 'quantity'], line.quantity, {
        min: 1,
        max: POS_LIMITS.quantity,
      }),
      price: check.price(['input', 'lines', String(index), 'price'], line.price, CURRENCY),
    }));
    const discount = check.price(['input', 'discount'], input.discount, CURRENCY) ?? 0n;
    const phone = check.mobile(['input', 'customerPhone'], input.customerPhone);
    const name = check.text(['input', 'customerName'], input.customerName, { max: 255 });
    const note = check.text(['input', 'note'], input.note, { max: POS_LIMITS.note }) ?? '';
    const tenders = input.tenders.map((tender, index) => {
      const field = ['input', 'tenders', String(index)];
      if (!(POS_TENDER_METHODS as readonly string[]).includes(tender.method)) {
        check.add([...field, 'method'], 'INVALID', 'is not a way to pay');
      }
      const amount = check.price([...field, 'amount'], tender.amount, CURRENCY, { required: true });
      if (amount === 0n) check.add([...field, 'amount'], 'INVALID', 'must be more than zero');
      return {
        method: tender.method,
        amount: amount ?? 0n,
        reference: check.text([...field, 'reference'], tender.reference, {
          max: POS_LIMITS.reference,
        }),
      };
    });
    const soldAt = input.soldAt ?? now;
    if (
      soldAt.getTime() > now.getTime() + 5 * 60_000 ||
      soldAt.getTime() < now.getTime() - POS_LIMITS.offlineDays * 86_400_000
    ) {
      check.add(['input', 'soldAt'], 'INVALID', 'must be within the last week');
    }
    if (!check.ok) return fail(check.errors);

    const actor = actorColumnsOf(tenant.actor);
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows: kept } = await tx.execute<{ id: string }>(sql`
        SELECT id FROM orders.pos_sales
         WHERE shop_id = ${tenant.shopId} AND client_id = ${input.clientId}`);
      if (kept[0]) return { ok: true, value: (await saleIn(tx, tenant.shopId, kept[0].id))! };
      const session = await sessionIn(tx, tenant.shopId, input.sessionId, { lock: true });
      if (!session) return failOne(['input', 'sessionId'], 'NOT_FOUND', 'No such session');
      if (session.closedAt) {
        return failOne(['input', 'sessionId'], 'INVALID', 'The register’s session is closed');
      }
      const register = await registerIn(tx, tenant.shopId, session.registerId);
      if (!register) return failOne(['input', 'sessionId'], 'NOT_FOUND', 'No such register');

      const ids = lines.map((line) => line.variantId).filter((id) => UUID.test(id));
      const snapshots = await this.variants.snapshotsOf(tx, tenant.shopId, ids);
      const errors = lines.flatMap((line, index) => {
        const snapshot = snapshots.get(line.variantId);
        return snapshot && snapshot.productStatus !== 'archived'
          ? []
          : [
              {
                field: ['input', 'lines', String(index), 'variantId'],
                code: 'NOT_FOUND' as const,
                message: 'No such variant for sale',
              },
            ];
      });
      if (errors.length > 0) return fail(errors);
      const priced = lines.map((line) => {
        const snapshot = snapshots.get(line.variantId)!;
        const unitPrice = line.price ?? snapshot.price;
        return { ...line, quantity: line.quantity!, snapshot, unitPrice };
      });
      const totals = priced.map((line) => line.unitPrice * BigInt(line.quantity));
      const subtotal = totals.reduce((sum, total) => sum + total, 0n);
      if (discount > subtotal) {
        return failOne(['input', 'discount'], 'INVALID', 'is more than the items come to');
      }
      const total = subtotal - discount;
      const paid = tenders.reduce((sum, tender) => sum + tender.amount, 0n);
      const cash = tenders
        .filter((tender) => tender.method === 'cash')
        .reduce((sum, tender) => sum + tender.amount, 0n);
      if (paid < total) {
        return failOne(['input', 'tenders'], 'INVALID', 'What was paid is less than the total');
      }
      const changeGiven = paid - total;
      if (changeGiven > cash) {
        return failOne(['input', 'tenders'], 'INVALID', 'Change is given from cash alone');
      }
      const lineDiscounts = shares(totals, discount);
      const tax = orderTaxOf(await taxSettingsIn(tx, tenant.shopId), {
        lines: priced.map((line, index) => ({
          total: totals[index]!,
          taxable: line.snapshot.taxable,
          taxCode: line.snapshot.taxCode,
        })),
        discount,
        charges: 0n,
      });

      let customerId: string | null = null;
      if (phone) {
        customerId = await this.customers.findOrCreate(tx, tenant.shopId, {
          phone,
          name,
          email: null,
        });
      }

      const id = newId();
      const sold = await this.stock.sell(
        tx,
        { shopId: tenant.shopId, actor: tenant.actor },
        priced.map((line) => ({
          variantId: line.variantId,
          locationId: register.locationId,
          quantity: line.quantity,
        })),
        { referenceDocumentUri: `hatti://pos-sales/${id}` },
      );
      if (!sold.ok) throw new Error('Selling at the till is never short');
      const number = await nextPosNumber(tx, tenant.shopId);
      await tx.execute(sql`
        INSERT INTO orders.pos_sales
               (shop_id, id, number, client_id, register_id, session_id, location_id, customer_id,
                actor_kind, actor_id, currency, subtotal, discount, tax, total, change_given, note,
                sold_at)
        VALUES (${tenant.shopId}, ${id}, ${number}, ${input.clientId}, ${register.id},
                ${session.id}, ${register.locationId}, ${customerId}, ${actor.actorKind},
                ${actor.actorId}, ${CURRENCY}, ${subtotal}, ${discount}, ${tax.total}, ${total},
                ${changeGiven}, ${note}, ${soldAt.toISOString()})`);
      for (const [index, line] of priced.entries()) {
        await tx.execute(sql`
          INSERT INTO orders.pos_sale_lines
                 (shop_id, id, sale_id, position, variant_id, product_id, title, variant_title,
                  sku, quantity, unit_price, discount, total, tax)
          VALUES (${tenant.shopId}, ${newId()}, ${id}, ${index + 1}, ${line.variantId},
                  ${line.snapshot.productId}, ${line.snapshot.productTitle},
                  ${line.snapshot.variantTitle}, ${line.snapshot.sku}, ${line.quantity},
                  ${line.unitPrice}, ${lineDiscounts[index]!},
                  ${totals[index]! - lineDiscounts[index]!}, ${tax.lines[index]!.tax})`);
      }
      for (const tender of tenders) {
        await tx.execute(sql`
          INSERT INTO orders.pos_tenders (shop_id, id, sale_id, method, amount, reference)
          VALUES (${tenant.shopId}, ${newId()}, ${id}, ${tender.method}, ${tender.amount},
                  ${tender.reference})`);
      }
      await appendEvent(tx, tenant.shopId, {
        type: OrderEvents.PosSaleCompleted,
        aggregateType: 'pos_sale',
        aggregateId: id,
        payload: { number, total: total.toString(), customerId },
      });
      return { ok: true, value: (await saleIn(tx, tenant.shopId, id))! };
    });
  }

  /** The sale `id`; null for none. */
  async sale(tenant: TenantContext, id: string): Promise<PosSaleRecord | null> {
    return this.db.tenant(tenant.shopId, (tx) => saleIn(tx, tenant.shopId, id));
  }

  /** The shop's till sales, the latest first: a session's, or a customer's, a page at a time. */
  async sales(
    tenant: TenantContext,
    options: {
      sessionId?: string | null;
      customerId?: string | null;
      first: number;
      before?: string | null;
    },
  ): Promise<{ items: PosSaleRecord[]; hasNextPage: boolean }> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<SaleRow>(sql`
        SELECT ${SALE_COLUMNS} FROM orders.pos_sales
         WHERE shop_id = ${tenant.shopId}
           ${options.sessionId ? sql`AND session_id = ${options.sessionId}::uuid` : sql``}
           ${options.customerId ? sql`AND customer_id = ${options.customerId}::uuid` : sql``}
           ${
             options.before && UUID.test(options.before)
               ? sql`AND (sold_at, id) < (SELECT sold_at, id FROM orders.pos_sales
                                           WHERE shop_id = ${tenant.shopId}
                                             AND id = ${options.before})`
               : sql``
           }
         ORDER BY sold_at DESC, id DESC
         LIMIT ${options.first + 1}`);
      return {
        items: await salesIn(tx, tenant.shopId, rows.slice(0, options.first)),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  /**
   * Units of a sale brought back: paid back from the session's drawer, or as they were paid, in
   * proportion to what was paid for them, and back on the shelf unless written off.
   */
  async returnSale(
    tenant: TenantContext,
    input: PosReturnInput,
  ): Promise<MutationResult<PosSaleRecord>> {
    const check = new InputChecker();
    if (input.lines.length === 0) check.add(['input', 'lines'], 'BLANK', "can't be empty");
    if (!(POS_TENDER_METHODS as readonly string[]).includes(input.method)) {
      check.add(['input', 'method'], 'INVALID', 'is not a way to pay back');
    }
    const reason = check.text(['input', 'reason'], input.reason, { max: 200 });
    for (const [index, line] of input.lines.entries()) {
      check.integer(['input', 'lines', String(index), 'quantity'], line.quantity, {
        min: 1,
        max: POS_LIMITS.quantity,
      });
    }
    if (!check.ok) return fail(check.errors);
    const actor = actorColumnsOf(tenant.actor);
    return this.db.tenant(tenant.shopId, async (tx) => {
      const sale = await saleIn(tx, tenant.shopId, input.saleId);
      if (!sale) return failOne(['input', 'saleId'], 'NOT_FOUND', 'No such sale');
      const session = await sessionIn(tx, tenant.shopId, input.sessionId, { lock: true });
      if (!session) return failOne(['input', 'sessionId'], 'NOT_FOUND', 'No such session');
      if (session.closedAt) {
        return failOne(['input', 'sessionId'], 'INVALID', 'The register’s session is closed');
      }
      const register = await registerIn(tx, tenant.shopId, session.registerId);
      if (!register) return failOne(['input', 'sessionId'], 'NOT_FOUND', 'No such register');
      // Locked: two returns of one sale never give back more than it sold.
      await tx.execute(sql`
        SELECT id FROM orders.pos_sales
         WHERE shop_id = ${tenant.shopId} AND id = ${sale.id} FOR UPDATE`);
      const back: { line: PosSaleLineRecord; quantity: number; amount: bigint }[] = [];
      for (const [index, asked] of input.lines.entries()) {
        const line = sale.lines.find((each) => each.id === asked.lineId);
        const field = ['input', 'lines', String(index)];
        if (!line) return failOne([...field, 'lineId'], 'NOT_FOUND', 'No such line of the sale');
        if (asked.quantity > line.quantity - line.returned) {
          return failOne(
            [...field, 'quantity'],
            'INVALID',
            `Only ${line.quantity - line.returned} of it can still come back`,
          );
        }
        // What was paid for these units: the rest of the line's, for its last.
        const amount =
          asked.quantity === line.quantity - line.returned
            ? line.total - (line.total * BigInt(line.returned)) / BigInt(line.quantity)
            : (line.total * BigInt(asked.quantity)) / BigInt(line.quantity);
        back.push({ line, quantity: asked.quantity, amount });
      }
      const amount = back.reduce((sum, each) => sum + each.amount, 0n);
      if (input.method === 'cash' && amount > (await expectedCashIn(tx, tenant.shopId, session))) {
        return failOne(['input', 'method'], 'INVALID', 'The drawer holds less than that');
      }
      const returnId = newId();
      await tx.execute(sql`
        INSERT INTO orders.pos_returns
               (shop_id, id, sale_id, session_id, amount, method, restocked, reason, actor_kind,
                actor_id)
        VALUES (${tenant.shopId}, ${returnId}, ${sale.id}, ${session.id}, ${amount},
                ${input.method}, ${input.restock}, ${reason}, ${actor.actorKind},
                ${actor.actorId})`);
      for (const each of back) {
        await tx.execute(sql`
          INSERT INTO orders.pos_return_lines
                 (shop_id, id, return_id, sale_line_id, quantity, amount)
          VALUES (${tenant.shopId}, ${newId()}, ${returnId}, ${each.line.id}, ${each.quantity},
                  ${each.amount})`);
        await tx.execute(sql`
          UPDATE orders.pos_sale_lines SET returned = returned + ${each.quantity}
           WHERE shop_id = ${tenant.shopId} AND id = ${each.line.id}`);
      }
      await tx.execute(sql`
        UPDATE orders.pos_sales SET returned = returned + ${amount}
         WHERE shop_id = ${tenant.shopId} AND id = ${sale.id}`);
      if (input.restock) {
        await this.stock.restock(
          tx,
          { shopId: tenant.shopId, actor: tenant.actor },
          back.map((each) => ({
            variantId: each.line.variantId,
            // Back on the shelf of the till it came back to.
            locationId: register.locationId,
            quantity: each.quantity,
          })),
          { referenceDocumentUri: `hatti://pos-sales/${sale.id}` },
        );
      }
      await appendEvent(tx, tenant.shopId, {
        type: OrderEvents.PosSaleReturned,
        aggregateType: 'pos_sale',
        aggregateId: sale.id,
        payload: { amount: amount.toString(), restocked: input.restock },
      });
      return { ok: true, value: (await saleIn(tx, tenant.shopId, sale.id))! };
    });
  }
}
