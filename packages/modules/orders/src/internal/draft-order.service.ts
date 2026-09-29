import {
  InputChecker,
  PublicSite,
  actorColumnsOf,
  failOne,
  phoneAccess,
  shopProfile,
  type Actor,
  type FieldError,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { VariantService } from '@hatti/catalog/public';
import { secretToken, sha256 } from '@hatti/crypto';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { LocationService } from '@hatti/inventory/public';
import type { CurrencyCode } from '@hatti/money';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { checkAddress, type AddressInput } from './address.js';
import {
  OrderEvents,
  type DraftOrderCompletedPayload,
  type DraftOrderCreatedPayload,
  type DraftOrderDeletedPayload,
  type DraftOrderUpdatedPayload,
} from './events.js';
import { loadOrder, nextDraftNumber } from './order-store.js';
import { OrderService, type OrderLineInput, type Placement } from './order.service.js';
import type { DraftOrderRecord, OrderRecord, Page } from './records.js';
import { LIMITS, LINK_HOURS, draftName } from './rules.js';
import {
  DRAFT_ORDER_SOURCES,
  draftOrders,
  type AddressValue,
  type DraftLineValue,
  type DraftOrderRow,
  type DraftOrderSourceValue,
  type DraftOrderStatusValue,
  type PaymentMethodValue,
} from './schema.js';

/**
 * A draft's fields. Creating a draft needs its line items. Updating one changes only the fields
 * given: null clears the address, email, amounts, location, note or tags, and leaves the source
 * and payment method as they are. A draft always has line items.
 */
export interface DraftOrderInput {
  /** Replaces the lines, each at the price given or else the variant's price now. */
  lineItems?: OrderLineInput[] | null;
  /** In a chat, the address often comes after the items. */
  shippingAddress?: AddressInput | null;
  email?: string | null;
  /** Where the conversation happened: MANUAL for staff and API for apps unless given. */
  source?: DraftOrderSourceValue | null;
  /** Cash on delivery unless given. */
  paymentMethod?: PaymentMethodValue | null;
  /** Paid in advance on a cash-on-delivery order, such as the delivery charge. */
  advancePaid?: string | null;
  shippingPrice?: string | null;
  discount?: string | null;
  /** Where the order will ship from; the primary location when it is placed, if left out. */
  locationId?: string | null;
  note?: string | null;
  tags?: string[] | null;
}

export interface ListDraftOrdersOptions {
  first: number;
  after?: string | null;
  status?: DraftOrderStatusValue | null;
}

/** A new link for the customer to confirm a draft: shown once, since only its digest is kept. */
export interface DraftOrderLink {
  draftOrder: DraftOrderRecord;
  /** The page where the customer confirms the order. */
  url: string;
  /**
   * Opens WhatsApp with a message carrying the link: to the customer's number for callers who see
   * numbers whole, or to a chat the sender picks.
   */
  whatsappUrl: string;
  expiresAt: Date;
}

/** The shop, as a link's page names it. */
export interface LinkShop {
  name: string;
  /** For the time the link stops working. */
  timezone: string;
}

/** Why the customer's confirmation did not go through; the page shows the draft again. */
export type LinkProblem =
  /** The draft changed after the customer opened the page. */
  | { kind: 'changed' }
  /** Lines that cannot be sold now, by their place in the draft: sold out or taken off sale. */
  | { kind: 'unavailable'; lines: number[] }
  /** The shop cannot take the order now, such as when its location closed. */
  | { kind: 'refused' };

/** What a draft's link shows the customer. */
export type DraftLinkView =
  | { kind: 'not_found' }
  | { kind: 'expired'; shop: LinkShop }
  | { kind: 'open'; shop: LinkShop; draft: DraftOrderRecord; problem: LinkProblem | null }
  | { kind: 'completed'; shop: LinkShop; draft: DraftOrderRecord; order: OrderRecord };

/** Checked fields of a draft; those left out are undefined. */
interface CheckedDraft {
  lines?: { variantId: string; quantity: number; price: bigint | null }[];
  address?: AddressValue | null;
  email?: string | null;
  source?: DraftOrderSourceValue;
  paymentMethod?: PaymentMethodValue;
  advance?: bigint;
  shipping?: bigint;
  discount?: bigint;
  locationId?: string | null;
  note?: string;
  tags?: string[];
}

/** Where a link's page is: "/d/" and 128 random bits in base64url, short enough for an SMS. */
export const DRAFT_LINK_PATH = 'd';
const LINK_TOKEN_BYTES = 16;
const LINK_TOKEN = /^[A-Za-z0-9_-]{22}$/;
const HOUR_MS = 3_600_000;

/**
 * Draft orders: orders taken in a chat before they are placed, as on Instagram or WhatsApp. A
 * draft keeps its items at the prices agreed and, once the customer sends it, their address; it
 * holds no stock. Staff place it when the customer agrees, or send the customer a link, where
 * they see the order and confirm it themselves: the draft then becomes a confirmed order, unless
 * the number is blocked or the order risky, which waits for review as any order does.
 */
@Injectable()
export class DraftOrderService {
  constructor(
    private readonly db: Database,
    private readonly variants: VariantService,
    private readonly locations: LocationService,
    private readonly orders: OrderService,
    private readonly site: PublicSite,
  ) {}

  async create(
    tenant: TenantContext,
    input: DraftOrderInput,
  ): Promise<MutationResult<DraftOrderRecord>> {
    const checked = checkDraft(tenant, input, true);
    if (!checked.ok) return checked;
    return this.db.tenant(tenant.shopId, (tx) => this.#save(tx, tenant, null, checked.value));
  }

  /** Changes the fields given, while the draft is open. */
  async update(
    tenant: TenantContext,
    id: string,
    input: DraftOrderInput,
  ): Promise<MutationResult<DraftOrderRecord>> {
    const checked = checkDraft(tenant, input, false);
    if (!checked.ok) return checked;
    return this.db.tenant(tenant.shopId, async (tx) => {
      const draft = await lockDraft(tx, tenant.shopId, id);
      if (!draft) return failOne(['id'], 'NOT_FOUND', 'Draft order not found');
      if (draft.status === 'completed') {
        return failOne(['id'], 'INVALID', "A completed draft can't change; its order can");
      }
      return this.#save(tx, tenant, draft, checked.value);
    });
  }

  /** Deletes an open draft, and with it its link. A completed one stays, beside its order. */
  async delete(tenant: TenantContext, id: string): Promise<MutationResult<{ id: string }>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const draft = await lockDraft(tx, tenant.shopId, id);
      if (!draft) return failOne(['id'], 'NOT_FOUND', 'Draft order not found');
      if (draft.status === 'completed') {
        return failOne(
          ['id'],
          'INVALID',
          "A completed draft can't be deleted; it stays with its order",
        );
      }
      await tx
        .delete(draftOrders)
        .where(and(eq(draftOrders.shopId, tenant.shopId), eq(draftOrders.id, id)));
      await appendEvent<DraftOrderDeletedPayload>(tx, tenant.shopId, {
        type: OrderEvents.DraftOrderDeleted,
        aggregateType: 'draft_order',
        aggregateId: id,
        payload: { number: draft.number },
      });
      return { ok: true, value: { id } };
    });
  }

  get(tenant: TenantContext, id: string): Promise<DraftOrderRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [row] = await tx
        .select()
        .from(draftOrders)
        .where(and(eq(draftOrders.shopId, tenant.shopId), eq(draftOrders.id, id)));
      return row ? toDraftRecord(row) : null;
    });
  }

  /** Drafts, newest first. */
  async list(
    tenant: TenantContext,
    options: ListDraftOrdersOptions,
  ): Promise<Page<DraftOrderRecord>> {
    const conditions = [eq(draftOrders.shopId, tenant.shopId)];
    if (options.status) conditions.push(eq(draftOrders.status, options.status));
    if (options.after) conditions.push(lt(draftOrders.id, options.after));
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await tx
        .select()
        .from(draftOrders)
        .where(and(...conditions))
        .orderBy(desc(draftOrders.id))
        .limit(options.first + 1);
      return {
        items: rows.slice(0, options.first).map(toDraftRecord),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  /**
   * Places the draft as an order, as orderCreate would, at the prices agreed: for when the customer
   * agreed in the chat, or paid in advance. A cash-on-delivery order then waits for them to
   * confirm, as orders placed by staff do. Completing a completed draft changes nothing.
   */
  async complete(tenant: TenantContext, id: string): Promise<MutationResult<DraftOrderRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const draft = await lockDraft(tx, tenant.shopId, id);
      if (!draft) return failOne(['id'], 'NOT_FOUND', 'Draft order not found');
      if (draft.status === 'completed') return { ok: true, value: toDraftRecord(draft) };
      const by = tenant.actor.kind === 'staff' ? 'by staff' : 'through the API';
      const placed = await this.#place(tx, draft, {
        actor: tenant.actor,
        how: `${by} from draft ${draftName(draft.number)}`,
      });
      if (!placed.ok) return placed;
      return {
        ok: true,
        value: toDraftRecord(await this.#completed(tx, draft, placed.value, false)),
      };
    });
  }

  /**
   * A new link where the customer sees a cash-on-delivery draft and confirms it, working for
   * `expiresInHours` (72 unless given, at most 720). It replaces the draft's previous link, which
   * stops working. The link is returned once: only its digest is kept.
   */
  async createLink(
    tenant: TenantContext,
    id: string,
    options: { expiresInHours?: number | null } = {},
  ): Promise<MutationResult<DraftOrderLink>> {
    const check = new InputChecker();
    const hours = check.integer(['expiresInHours'], options.expiresInHours ?? LINK_HOURS.default, {
      min: 1,
      max: LINK_HOURS.max,
    });
    if (!check.ok || hours === null) return { ok: false, errors: check.errors };

    return this.db.tenant(tenant.shopId, async (tx) => {
      const draft = await lockDraft(tx, tenant.shopId, id);
      if (!draft) return failOne(['id'], 'NOT_FOUND', 'Draft order not found');
      const refusal = linkRefusal(draft);
      if (refusal) return failOne(['id'], 'INVALID', refusal);

      const token = secretToken('', LINK_TOKEN_BYTES);
      const expiresAt = new Date(Date.now() + hours * HOUR_MS);
      const [row] = await tx
        .update(draftOrders)
        .set({
          linkTokenHash: sha256(token),
          linkExpiresAt: expiresAt,
          version: sql`${draftOrders.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(draftOrders.shopId, tenant.shopId), eq(draftOrders.id, id)))
        .returning();
      await appendEvent<DraftOrderUpdatedPayload>(tx, tenant.shopId, {
        type: OrderEvents.DraftOrderUpdated,
        aggregateType: 'draft_order',
        aggregateId: id,
        payload: { changed: ['link'], status: row!.status, version: row!.version },
      });
      const shop = await shopProfile(tx, tenant.shopId);
      const url = this.site.url(`/${DRAFT_LINK_PATH}/${token}`);
      const to = phoneAccess(tenant) === 'full' ? draft.phone : null;
      return {
        ok: true,
        value: {
          draftOrder: toDraftRecord(row!),
          url,
          whatsappUrl: whatsappUrl(shop.name, url, to),
          expiresAt,
        },
      };
    });
  }

  /** What a link's page shows: its draft, or why there is none. */
  async viewLink(token: string): Promise<DraftLinkView> {
    const link = await this.#resolveLink(token);
    if (!link) return { kind: 'not_found' };
    return this.db.tenant(link.shopId, async (tx) => {
      const [draft] = await tx
        .select()
        .from(draftOrders)
        .where(and(eq(draftOrders.shopId, link.shopId), eq(draftOrders.id, link.draftId)));
      return this.#view(tx, link.shopId, link.hash, draft, null);
    });
  }

  /**
   * The customer confirms the draft behind a link, as they saw it at `version`: it becomes an
   * order, confirmed by them. Returns what the page shows next: the order, or the draft again
   * with why it did not go through, such as a change since they opened the page. Confirming twice
   * places one order.
   */
  async confirmLink(token: string, version: number): Promise<DraftLinkView> {
    const link = await this.#resolveLink(token);
    if (!link) return { kind: 'not_found' };
    return this.db.tenant(link.shopId, async (tx) => {
      const draft = await lockDraft(tx, link.shopId, link.draftId);
      const view = await this.#view(tx, link.shopId, link.hash, draft, null);
      if (view.kind !== 'open' || !draft) return view;
      if (draft.version !== version) return { ...view, problem: { kind: 'changed' } };

      const placed = await this.#place(tx, draft, {
        actor: 'system',
        how:
          `from draft ${draftName(draft.number)} when the customer confirmed it through ` +
          'its link',
        confirmedByCustomer: true,
      });
      if (!placed.ok) return { ...view, problem: problemOf(placed.errors) };
      const completed = await this.#completed(tx, draft, placed.value, true);
      return {
        kind: 'completed',
        shop: view.shop,
        draft: toDraftRecord(completed),
        order: placed.value,
      };
    });
  }

  /** The shop and draft a link's token belongs to, found without knowing the shop. */
  async #resolveLink(
    token: string,
  ): Promise<{ shopId: string; draftId: string; hash: Buffer } | null> {
    if (!LINK_TOKEN.test(token)) return null;
    const hash = sha256(token);
    const { rows } = await this.db.app.execute<{ shop_id: string; draft_order_id: string }>(
      sql`SELECT * FROM orders.resolve_draft_order_link(${hash})`,
    );
    const row = rows[0];
    return row ? { shopId: row.shop_id, draftId: row.draft_order_id, hash } : null;
  }

  /** What a link shows of `draft`, if the link is still the draft's. */
  async #view(
    tx: Tx,
    shopId: string,
    hash: Buffer,
    draft: DraftOrderRow | undefined,
    problem: LinkProblem | null,
  ): Promise<DraftLinkView> {
    // The link was replaced, or the draft deleted, since it was found.
    if (!draft?.linkTokenHash?.equals(hash) || !draft.linkExpiresAt) return { kind: 'not_found' };
    const profile = await shopProfile(tx, shopId);
    const shop = { name: profile.name, timezone: profile.timezone };
    // An expired link shows nothing of the order, which carries the customer's address.
    if (draft.linkExpiresAt <= new Date()) return { kind: 'expired', shop };
    if (draft.status === 'completed') {
      const order = await loadOrder(tx, shopId, draft.orderId!);
      return { kind: 'completed', shop, draft: toDraftRecord(draft), order: order! };
    }
    return { kind: 'open', shop, draft: toDraftRecord(draft), problem };
  }

  /** Places the draft as an order in `tx`, at its prices and with its source. */
  async #place(
    tx: Tx,
    draft: DraftOrderRow,
    placement: Pick<Placement, 'actor' | 'how' | 'confirmedByCustomer'>,
  ): Promise<MutationResult<OrderRecord>> {
    if (!draft.shippingAddress) {
      return failOne(['id'], 'INVALID', "Add the customer's address first");
    }
    return this.orders.placeIn(
      tx,
      {
        ...placement,
        shopId: draft.shopId,
        currency: draft.currency as CurrencyCode,
        source: draft.source,
      },
      {
        field: [],
        lines: draft.lines.map((line) => ({
          variantId: line.variantId,
          quantity: line.quantity,
          price: BigInt(line.unitPrice),
        })),
        address: draft.shippingAddress,
        email: draft.email,
        paymentMethod: draft.paymentMethod,
        shipping: draft.shipping,
        discount: draft.discount,
        advance: draft.advancePaid,
        locationId: draft.locationId,
        note: draft.note,
        tags: draft.tags,
      },
    );
  }

  /** Marks the draft completed by `order`. */
  async #completed(
    tx: Tx,
    draft: DraftOrderRow,
    order: OrderRecord,
    confirmedByCustomer: boolean,
  ): Promise<DraftOrderRow> {
    const [row] = await tx
      .update(draftOrders)
      .set({
        status: 'completed',
        orderId: order.id,
        completedAt: sql`now()`,
        version: sql`${draftOrders.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(draftOrders.shopId, draft.shopId), eq(draftOrders.id, draft.id)))
      .returning();
    await appendEvent<DraftOrderCompletedPayload>(tx, draft.shopId, {
      type: OrderEvents.DraftOrderCompleted,
      aggregateType: 'draft_order',
      aggregateId: draft.id,
      payload: {
        orderId: order.id,
        confirmedByCustomer,
        status: row!.status,
        version: row!.version,
      },
    });
    return row!;
  }

  /**
   * Writes a new draft (`current` null) or the changes to one. Lines given are priced now: at the
   * price given, or else the variant's.
   */
  async #save(
    tx: Tx,
    tenant: TenantContext,
    current: DraftOrderRow | null,
    checked: CheckedDraft,
  ): Promise<MutationResult<DraftOrderRecord>> {
    const shopId = tenant.shopId;
    const errors: FieldError[] = [];
    let lines: DraftLineValue[] | undefined;
    if (checked.lines) {
      const snapshots = await this.variants.snapshotsOf(
        tx,
        shopId,
        checked.lines.map((line) => line.variantId),
      );
      lines = [];
      for (const [index, line] of checked.lines.entries()) {
        const field = ['input', 'lineItems', String(index), 'variantId'];
        const snapshot = snapshots.get(line.variantId);
        if (!snapshot) {
          errors.push({ field, code: 'NOT_FOUND', message: 'Variant not found' });
        } else if (snapshot.productStatus === 'archived') {
          errors.push({
            field,
            code: 'INVALID',
            message: `"${snapshot.productTitle}" is archived, so it can't be sold`,
          });
        } else {
          lines.push({
            variantId: line.variantId,
            productId: snapshot.productId,
            title: snapshot.productTitle,
            variantTitle: snapshot.variantTitle,
            sku: snapshot.sku,
            quantity: line.quantity,
            unitPrice: (line.price ?? snapshot.price).toString(),
          });
        }
      }
    }
    if (checked.locationId) {
      const location = (await this.locations.locationsOf(tx, shopId, [checked.locationId])).get(
        checked.locationId,
      );
      const field = ['input', 'locationId'];
      if (!location) {
        errors.push({ field, code: 'NOT_FOUND', message: 'Location not found' });
      } else if (!location.isActive) {
        errors.push({ field, code: 'INVALID', message: 'The location is not active' });
      }
    }
    if (errors.length > 0) return { ok: false, errors };

    const next = {
      lines: lines ?? current!.lines,
      shippingAddress: pick(checked.address, current?.shippingAddress ?? null),
      email: pick(checked.email, current?.email ?? null),
      source: checked.source ?? current?.source ?? defaultSource(tenant.actor),
      paymentMethod: checked.paymentMethod ?? current?.paymentMethod ?? 'cash_on_delivery',
      advancePaid: checked.advance ?? current?.advancePaid ?? 0n,
      shipping: checked.shipping ?? current?.shipping ?? 0n,
      discount: checked.discount ?? current?.discount ?? 0n,
      locationId: pick(checked.locationId, current?.locationId ?? null),
      note: checked.note ?? current?.note ?? '',
      tags: checked.tags ?? current?.tags ?? [],
    };
    const subtotal = next.lines.reduce(
      (sum, line) => sum + BigInt(line.unitPrice) * BigInt(line.quantity),
      0n,
    );
    if (next.discount > subtotal) {
      return failOne(
        ['input', 'discount'],
        'INVALID',
        "The discount can't be more than the items cost",
      );
    }
    const total = subtotal - next.discount + next.shipping;
    if (next.paymentMethod === 'prepaid' && next.advancePaid > 0n) {
      return failOne(
        ['input', 'advancePaid'],
        'INVALID',
        'A prepaid order is paid in full; an advance is for cash-on-delivery orders',
      );
    }
    if (next.advancePaid > total) {
      return failOne(
        ['input', 'advancePaid'],
        'INVALID',
        "The advance can't be more than the total",
      );
    }
    const columns = {
      ...next,
      phone: next.shippingAddress?.phone ?? null,
      subtotal,
      total,
    };

    if (!current) {
      const id = newId();
      const number = await nextDraftNumber(tx, shopId);
      const { actorKind, actorId } = actorColumnsOf(tenant.actor);
      const [row] = await tx
        .insert(draftOrders)
        .values({ shopId, id, number, currency: tenant.currency, ...columns, actorKind, actorId })
        .returning();
      await appendEvent<DraftOrderCreatedPayload>(tx, shopId, {
        type: OrderEvents.DraftOrderCreated,
        aggregateType: 'draft_order',
        aggregateId: id,
        payload: {
          number,
          source: row!.source,
          paymentMethod: row!.paymentMethod,
          total: total.toString(),
          currency: row!.currency,
          status: row!.status,
          version: row!.version,
        },
      });
      return { ok: true, value: toDraftRecord(row!) };
    }

    const changed: string[] = CHANGES.filter(
      ([, column]) => canonicalJson(current[column]) !== canonicalJson(next[column]),
    ).map(([name]) => name);
    if (changed.length === 0) return { ok: true, value: toDraftRecord(current) };
    // A link confirms a cash-on-delivery order with an address; a draft that no longer is one
    // loses its link.
    const dropLink =
      current.linkTokenHash !== null &&
      (next.paymentMethod !== 'cash_on_delivery' || next.shippingAddress === null);
    if (dropLink) changed.push('link');
    const [row] = await tx
      .update(draftOrders)
      .set({
        ...columns,
        ...(dropLink ? { linkTokenHash: null, linkExpiresAt: null } : {}),
        version: sql`${draftOrders.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(draftOrders.shopId, shopId), eq(draftOrders.id, current.id)))
      .returning();
    await appendEvent<DraftOrderUpdatedPayload>(tx, shopId, {
      type: OrderEvents.DraftOrderUpdated,
      aggregateType: 'draft_order',
      aggregateId: current.id,
      payload: { changed, status: row!.status, version: row!.version },
    });
    return { ok: true, value: toDraftRecord(row!) };
  }
}

/** What a draft's changes are called in events, and the column each compares. */
const CHANGES = [
  ['lineItems', 'lines'],
  ['shippingAddress', 'shippingAddress'],
  ['email', 'email'],
  ['source', 'source'],
  ['paymentMethod', 'paymentMethod'],
  ['advancePaid', 'advancePaid'],
  ['shippingPrice', 'shipping'],
  ['discount', 'discount'],
  ['location', 'locationId'],
  ['note', 'note'],
  ['tags', 'tags'],
] as const;

/** Checks a draft's fields, without the database; a new draft needs line items. */
function checkDraft(
  tenant: TenantContext,
  input: DraftOrderInput,
  creating: boolean,
): MutationResult<CheckedDraft> {
  const check = new InputChecker();
  const checked: CheckedDraft = {};
  const { currency } = tenant;
  if (input.lineItems === null || (creating && input.lineItems === undefined)) {
    check.add(['input', 'lineItems'], 'BLANK', 'must include at least one');
  } else if (input.lineItems) {
    if (input.lineItems.length === 0) {
      check.add(['input', 'lineItems'], 'BLANK', 'must include at least one');
    }
    if (input.lineItems.length > LIMITS.lines) {
      check.add(['input', 'lineItems'], 'TOO_MANY', `can have at most ${LIMITS.lines}`);
    }
    checked.lines = input.lineItems.map((line, index) => {
      const field = ['input', 'lineItems', String(index)];
      const quantity = check.integer([...field, 'quantity'], line.quantity, {
        min: 1,
        max: LIMITS.quantity,
      });
      return {
        variantId: line.variantId,
        quantity: quantity ?? 1,
        price: check.price([...field, 'price'], line.price, currency),
      };
    });
  }
  if (input.shippingAddress !== undefined) {
    checked.address =
      input.shippingAddress === null
        ? null
        : checkAddress(check, ['input', 'shippingAddress'], input.shippingAddress);
  }
  if (input.email !== undefined) checked.email = check.email(['input', 'email'], input.email);
  if (input.source) {
    if ((DRAFT_ORDER_SOURCES as readonly string[]).includes(input.source)) {
      checked.source = input.source;
    } else {
      check.addMessage(
        ['input', 'source'],
        'INVALID',
        'A draft comes from a chat, a call or an app: WHATSAPP, INSTAGRAM, FACEBOOK, MANUAL or API',
      );
    }
  }
  if (input.paymentMethod) checked.paymentMethod = input.paymentMethod;
  const amount = (name: 'advancePaid' | 'shippingPrice' | 'discount') =>
    input[name] === undefined
      ? undefined
      : (check.price(['input', name], input[name], currency) ?? 0n);
  checked.advance = amount('advancePaid');
  checked.shipping = amount('shippingPrice');
  checked.discount = amount('discount');
  if (input.locationId !== undefined) checked.locationId = input.locationId || null;
  if (input.note !== undefined) {
    checked.note = check.text(['input', 'note'], input.note, { max: LIMITS.note }) ?? '';
  }
  if (input.tags !== undefined) checked.tags = check.tags(['input', 'tags'], input.tags);
  return check.ok ? { ok: true, value: checked } : { ok: false, errors: check.errors };
}

/** The value given, or the current one when left out; null is a value. */
function pick<T>(given: T | undefined, current: T): T {
  return given === undefined ? current : given;
}

/** Staff enter drafts by hand; apps send them. */
function defaultSource(actor: Actor): DraftOrderSourceValue {
  return actor.kind === 'staff' ? 'manual' : 'api';
}

/** Why the draft cannot get a link, or null if it can. */
function linkRefusal(draft: DraftOrderRow): string | null {
  if (draft.status === 'completed') return 'This draft is an order already';
  if (draft.paymentMethod !== 'cash_on_delivery') {
    return (
      'A link confirms a cash-on-delivery order. Complete a prepaid draft once the customer ' +
      'has paid'
    );
  }
  if (!draft.shippingAddress) {
    return "Add the customer's address first: the link shows it to them to confirm";
  }
  return null;
}

/** Why placing the draft failed, for the customer: items no longer for sale, or the shop. */
function problemOf(errors: readonly FieldError[]): LinkProblem {
  const lines = new Set<number>();
  for (const error of errors) {
    if (error.field[0] === 'lineItems' && error.field[1] !== undefined) {
      lines.add(Number(error.field[1]));
    }
  }
  return lines.size > 0 ? { kind: 'unavailable', lines: [...lines] } : { kind: 'refused' };
}

/**
 * wa.me with a message carrying the link, in English and Urdu: to `phone` (E.164), or to a chat
 * the sender picks.
 */
function whatsappUrl(shopName: string, url: string, phone: string | null): string {
  const message =
    `Please confirm your order from ${shopName}:\n${url}\n` +
    'اپنا آرڈر کنفرم کرنے کے لیے یہ لنک کھولیں۔';
  return `https://wa.me/${phone ? phone.slice(1) : ''}?text=${encodeURIComponent(message)}`;
}

/** Locks a draft for a change; changes to one draft happen one at a time. */
async function lockDraft(tx: Tx, shopId: string, id: string): Promise<DraftOrderRow | undefined> {
  const [row] = await tx
    .select()
    .from(draftOrders)
    .where(and(eq(draftOrders.shopId, shopId), eq(draftOrders.id, id)))
    .for('update');
  return row;
}

export function toDraftRecord(row: DraftOrderRow): DraftOrderRecord {
  const lines = row.lines.map((line) => {
    const unitPrice = BigInt(line.unitPrice);
    return {
      variantId: line.variantId,
      productId: line.productId,
      title: line.title,
      variantTitle: line.variantTitle,
      sku: line.sku,
      quantity: line.quantity,
      unitPrice,
      total: unitPrice * BigInt(line.quantity),
    };
  });
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    source: row.source,
    paymentMethod: row.paymentMethod,
    currency: row.currency as CurrencyCode,
    lines,
    subtotal: row.subtotal,
    discount: row.discount,
    shipping: row.shipping,
    total: row.total,
    advancePaid: row.advancePaid,
    codAmount: row.paymentMethod === 'cash_on_delivery' ? row.total - row.advancePaid : 0n,
    phone: row.phone,
    email: row.email,
    shippingAddress: row.shippingAddress,
    locationId: row.locationId,
    note: row.note,
    tags: row.tags,
    orderId: row.orderId,
    linkExpiresAt: row.linkExpiresAt,
    actorKind: row.actorKind,
    actorId: row.actorId,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

/**
 * JSON with object keys sorted, so that equal values compare equal: Postgres returns jsonb
 * objects with their keys reordered.
 */
function canonicalJson(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
