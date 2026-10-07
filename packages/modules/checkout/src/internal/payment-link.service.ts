import {
  InputChecker,
  StorefrontSite,
  failOne,
  shopProfile,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { VariantService } from '@hatti/catalog/public';
import { secretToken } from '@hatti/crypto';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { discountCodeIn } from '@hatti/pricing/public';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { CartService } from './cart.service.js';
import { CheckoutService, itemName } from './checkout.service.js';
import { CheckoutEvents, type PaymentLinkChangedPayload } from './events.js';
import {
  PAYMENT_LINK_LIMITS,
  PAYMENT_LINK_PATH,
  checkLinkItems,
  linkIsOpen,
  paymentLinkIn,
  type PaymentLinkInput,
  type PaymentLinkItemValue,
  type PaymentLinkRecord,
} from './payment-links.js';
import { paymentLinks, type PaymentLinkRow } from './schema.js';

/** 128 random bits in base64url, as checkouts' secrets. */
const TOKEN_BYTES = 16;
const TOKEN = /^[A-Za-z0-9_-]{22}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What opening a link came to: a checkout's secret, or why there is none. */
export type PaymentLinkOpening =
  | { kind: 'checkout'; secret: string }
  /** No link of the shop's has the token. */
  | { kind: 'not_found' }
  /** Closed by staff, past its time, or used up. */
  | { kind: 'closed' }
  /** None of its items can be ordered now: sold out, off sale, or gone. */
  | { kind: 'unavailable' };

/**
 * Payment links (PAY-04, ADR-248): staff make a link with items, a discount code and the ways to
 * pay it allows, and share it once; each customer who opens it gets a checkout of their own and
 * places an order of their own, until the link closes.
 */
@Injectable()
export class PaymentLinkService {
  constructor(
    private readonly db: Database,
    private readonly variants: VariantService,
    private readonly carts: CartService,
    private readonly checkouts: CheckoutService,
    private readonly storefronts: StorefrontSite,
  ) {}

  /** The shop's links, newest first: `first` of them, after the link `after` names. */
  async list(
    tenant: TenantContext,
    options: { first?: number; after?: string | null } = {},
  ): Promise<PaymentLinkRecord[]> {
    const first = Math.min(Math.max(options.first ?? PAYMENT_LINK_LIMITS.page, 1), 250);
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { shopId } = tenant;
      const after = options.after ? await this.#row(tx, shopId, options.after) : null;
      if (options.after && !after) return [];
      const rows = await tx
        .select()
        .from(paymentLinks)
        .where(
          and(
            eq(paymentLinks.shopId, shopId),
            after
              ? sql`(${paymentLinks.createdAt}, ${paymentLinks.id}) <
                    (${after.createdAt.toISOString()}::timestamptz, ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(paymentLinks.createdAt), desc(paymentLinks.id))
        .limit(first);
      return this.#records(tx, shopId, rows);
    });
  }

  /** The shop's link with `id`; null when it has none. */
  async get(tenant: TenantContext, id: string): Promise<PaymentLinkRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const row = await this.#row(tx, tenant.shopId, id);
      return row ? ((await this.#records(tx, tenant.shopId, [row]))[0] ?? null) : null;
    });
  }

  /**
   * A new link, open at once, with its own address: items of the shop's variants, at least one,
   * and a title for staff; the rest as given. Records `payment_link.created`.
   */
  async create(
    tenant: TenantContext,
    input: PaymentLinkInput,
  ): Promise<MutationResult<PaymentLinkRecord>> {
    const check = new InputChecker();
    const title = check.text(['input', 'title'], input.title, {
      required: true,
      max: PAYMENT_LINK_LIMITS.title,
    });
    const items = checkLinkItems(check, ['input', 'items'], input.items ?? []);
    const rest = checkRest(check, input);
    if (!check.ok || !title || !items) return { ok: false, errors: check.errors };
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { shopId } = tenant;
      const refused = await this.#refusal(tx, shopId, items, rest.discountCode);
      if (refused) return refused;
      const [row] = await tx
        .insert(paymentLinks)
        .values({
          shopId,
          id: newId(),
          token: secretToken('', TOKEN_BYTES),
          title,
          items,
          discountCode: rest.discountCode ?? null,
          prepaidOnly: rest.prepaidOnly ?? false,
          usageLimit: rest.usageLimit ?? null,
          expiresAt: rest.expiresAt ?? null,
          active: rest.active ?? true,
        })
        .returning();
      await this.#changed(tx, shopId, CheckoutEvents.PaymentLinkCreated, row!.id, []);
      return { ok: true, value: (await this.#records(tx, shopId, [row!]))[0]! };
    });
  }

  /**
   * Changes the link with `id` as `input` says, its address and its orders as they are: closing
   * it (`active: false`) stops new checkouts and orders through it, the checkouts it opened
   * included. Records `payment_link.updated` with what changed, if anything did.
   */
  async update(
    tenant: TenantContext,
    id: string,
    input: PaymentLinkInput,
  ): Promise<MutationResult<PaymentLinkRecord>> {
    const check = new InputChecker();
    const title =
      input.title === undefined
        ? undefined
        : check.text(['input', 'title'], input.title, {
            required: true,
            max: PAYMENT_LINK_LIMITS.title,
          });
    const items =
      input.items === undefined || input.items === null
        ? undefined
        : checkLinkItems(check, ['input', 'items'], input.items);
    const rest = checkRest(check, input);
    if (!check.ok || title === null || items === null) return { ok: false, errors: check.errors };
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { shopId } = tenant;
      const before = await this.#row(tx, shopId, id, true);
      if (!before) return failOne(['id'], 'NOT_FOUND', 'Payment link not found');
      const refused = await this.#refusal(
        tx,
        shopId,
        items ?? [],
        rest.discountCode !== before.discountCode ? rest.discountCode : undefined,
      );
      if (refused) return refused;
      const set = {
        ...(title !== undefined && { title }),
        ...(items !== undefined && { items }),
        ...rest,
      };
      const changed = Object.entries(set)
        .filter(([key, value]) => !same(before[key as keyof PaymentLinkRow], value))
        .map(([key]) => key);
      if (changed.length === 0) {
        return { ok: true, value: (await this.#records(tx, shopId, [before]))[0]! };
      }
      const [row] = await tx
        .update(paymentLinks)
        .set({ ...set, updatedAt: sql`now()` })
        .where(and(eq(paymentLinks.shopId, shopId), eq(paymentLinks.id, id)))
        .returning();
      await this.#changed(tx, shopId, CheckoutEvents.PaymentLinkUpdated, id, changed);
      return { ok: true, value: (await this.#records(tx, shopId, [row!]))[0]! };
    });
  }

  /**
   * A customer opened the shop's link `token`: a checkout of their own, with a cart of its items
   * and its discount code, kept apart from any cart they have, for the page to send them to.
   * `visits` are those the storefront knew of that brought them (ADR-139). A link that is closed
   * opens nothing; items that cannot be ordered now are left out, as a cart leaves them.
   */
  async open(shopId: string, token: string, visits?: unknown): Promise<PaymentLinkOpening> {
    if (!TOKEN.test(token)) return { kind: 'not_found' };
    const link = await this.db.tenant(shopId, async (tx) => {
      const [row] = await tx
        .select()
        .from(paymentLinks)
        .where(and(eq(paymentLinks.shopId, shopId), eq(paymentLinks.token, token)));
      return row ?? null;
    });
    if (!link) return { kind: 'not_found' };
    if (!linkIsOpen(link, new Date())) return { kind: 'closed' };
    // Each item on its own, so that one sold out leaves the rest to order.
    let cart: string | null = null;
    for (const item of link.items) {
      const added = await this.carts.act(shopId, cart, {
        kind: 'add',
        items: [{ variantId: item.variantId, quantity: item.quantity, properties: {} }],
      });
      if (added.ok) cart = added.token;
    }
    if (cart === null) return { kind: 'unavailable' };
    if (link.discountCode) {
      await this.carts.act(shopId, cart, {
        kind: 'update',
        updates: [],
        note: null,
        attributes: null,
        discountCodes: [link.discountCode],
      });
    }
    const secret = await this.checkouts.start(shopId, cart, visits, link.id);
    return secret ? { kind: 'checkout', secret } : { kind: 'unavailable' };
  }

  async #row(tx: Tx, shopId: string, id: string, lock = false): Promise<PaymentLinkRow | null> {
    return UUID.test(id) ? paymentLinkIn(tx, shopId, id, lock) : null;
  }

  /** Why a link of `items` with `discountCode` can't be kept: a variant or a code not the shop's. */
  async #refusal(
    tx: Tx,
    shopId: string,
    items: readonly PaymentLinkItemValue[],
    discountCode: string | null | undefined,
  ): Promise<MutationResult<never> | null> {
    const found = await this.variants.snapshotsOf(
      tx,
      shopId,
      items.map((item) => item.variantId),
    );
    const missing = items.findIndex((item) => !found.has(item.variantId));
    if (missing >= 0) {
      return failOne(
        ['input', 'items', String(missing), 'variantId'],
        'NOT_FOUND',
        'Variant not found',
      );
    }
    if (discountCode && !(await discountCodeIn(tx, shopId, discountCode))) {
      return failOne(['input', 'discountCode'], 'NOT_FOUND', 'Discount code not found');
    }
    return null;
  }

  async #records(
    tx: Tx,
    shopId: string,
    rows: readonly PaymentLinkRow[],
  ): Promise<PaymentLinkRecord[]> {
    if (rows.length === 0) return [];
    const storefront = this.storefronts.url((await shopProfile(tx, shopId)).handle);
    const snapshots = await this.variants.snapshotsOf(
      tx,
      shopId,
      rows.flatMap((row) => row.items.map((item) => item.variantId)),
    );
    const now = new Date();
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      url: `${storefront}/${PAYMENT_LINK_PATH}/${row.token}`,
      items: row.items.map((item) => {
        const snapshot = snapshots.get(item.variantId);
        return {
          ...item,
          title: snapshot ? itemName(snapshot.productTitle, snapshot.variantTitle) : null,
        };
      }),
      discountCode: row.discountCode,
      prepaidOnly: row.prepaidOnly,
      usageLimit: row.usageLimit,
      ordersPlaced: row.ordersPlaced,
      lastOrderAt: row.lastOrderAt,
      expiresAt: row.expiresAt,
      active: row.active,
      open: linkIsOpen(row, now),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async #changed(
    tx: Tx,
    shopId: string,
    type: string,
    id: string,
    changed: string[],
  ): Promise<void> {
    await appendEvent<PaymentLinkChangedPayload>(tx, shopId, {
      type,
      aggregateType: 'payment_link',
      aggregateId: id,
      payload: { changed },
    });
  }
}

/** The fields of `input` besides its title and items, checked: those given, null clearing one. */
function checkRest(
  check: InputChecker,
  input: PaymentLinkInput,
): {
  discountCode?: string | null;
  prepaidOnly?: boolean;
  usageLimit?: number | null;
  expiresAt?: Date | null;
  active?: boolean;
} {
  const rest: ReturnType<typeof checkRest> = {};
  if (input.discountCode !== undefined) {
    rest.discountCode = check.text(['input', 'discountCode'], input.discountCode, { max: 255 });
  }
  if (input.prepaidOnly !== undefined && input.prepaidOnly !== null) {
    rest.prepaidOnly = input.prepaidOnly;
  }
  if (input.usageLimit !== undefined) {
    rest.usageLimit =
      input.usageLimit === null
        ? null
        : check.integer(['input', 'usageLimit'], input.usageLimit, {
            min: 1,
            max: PAYMENT_LINK_LIMITS.usageLimit,
          });
  }
  if (input.expiresAt !== undefined) rest.expiresAt = input.expiresAt;
  if (input.active !== undefined && input.active !== null) rest.active = input.active;
  return rest;
}

/** Whether a stored field and its new value are the same. */
function same(stored: unknown, value: unknown): boolean {
  if (stored instanceof Date || value instanceof Date) {
    return stored instanceof Date && value instanceof Date && stored.getTime() === value.getTime();
  }
  return JSON.stringify(stored) === JSON.stringify(value);
}
