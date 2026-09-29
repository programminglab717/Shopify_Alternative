import {
  PublicSite,
  failOne,
  phoneAccess,
  shopProfile,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { OrderEvents, type OrderUpdatedPayload } from './events.js';
import {
  ORDER_LINK_PATH,
  linkExpiry,
  linkHashOf,
  newLinkToken,
  whatsappUrl,
  type LinkProblem,
  type LinkShop,
} from './links.js';
import { addTimelineEntry, loadOrder, lockOrder, updateOrder } from './order-store.js';
import { OrderService } from './order.service.js';
import type { OrderRecord } from './records.js';
import { awaitsCustomer, orderName } from './rules.js';
import { orders, type OrderRow } from './schema.js';
import { shownDigest, shownOfOrder } from './shown-order.js';

/** A new link for an order's customer: shown once, since only its digest is kept. */
export interface OrderLink {
  order: OrderRecord;
  /** The customer's page. */
  url: string;
  /**
   * Opens WhatsApp with a message carrying the link: to the customer's number for callers who see
   * numbers whole, or to a chat the sender picks.
   */
  whatsappUrl: string;
  expiresAt: Date;
}

/** What an order's link shows the customer. */
export type OrderLinkView =
  | { kind: 'not_found' }
  | { kind: 'expired'; shop: LinkShop }
  | {
      kind: 'order';
      shop: LinkShop;
      order: OrderRecord;
      /** A digest of what the page shows, for its forms; see shownDigest. */
      shown: string;
      problem: LinkProblem | null;
    };

/**
 * Links for orders' customers: a page where they see their order and, while a cash-on-delivery
 * order waits for them, confirm or cancel it. After that it shows how the order is doing. It is
 * the tap-to-confirm link of the confirmation sequence (COD-02), which staff send by hand until
 * messaging does. Anything the customer does goes on the order's timeline as done by them, through
 * the system.
 */
@Injectable()
export class OrderLinkService {
  constructor(
    private readonly db: Database,
    private readonly orders: OrderService,
    private readonly site: PublicSite,
  ) {}

  /**
   * A new link for an open order's customer, working for `expiresInHours` (72 unless given, at
   * most 720). It replaces the order's previous link, which stops working.
   */
  async createLink(
    tenant: TenantContext,
    id: string,
    options: { expiresInHours?: number | null } = {},
  ): Promise<MutationResult<OrderLink>> {
    const expiry = linkExpiry(options.expiresInHours);
    if (!expiry.ok) return expiry;
    const { hours, expiresAt } = expiry.value;

    return this.db.tenant(tenant.shopId, async (tx) => {
      const order = await lockOrder(tx, tenant.shopId, id);
      if (!order) return failOne(['id'], 'NOT_FOUND', 'Order not found');
      if (order.status !== 'open') {
        return failOne(['id'], 'INVALID', `A ${order.status} order can't get a link`);
      }
      if (order.phone === null) {
        return failOne(
          ['id'],
          'INVALID',
          "The customer's details on this order were erased at their request",
        );
      }
      const { token, hash } = newLinkToken();
      const updated = await updateOrder(tx, tenant.shopId, order, {
        linkTokenHash: hash,
        linkExpiresAt: expiresAt,
      });
      await addTimelineEntry(
        tx,
        tenant.shopId,
        order.id,
        tenant.actor,
        'link',
        `Made a link for the customer, working for ${hours} ${hours === 1 ? 'hour' : 'hours'}`,
      );
      await appendEvent<OrderUpdatedPayload>(tx, tenant.shopId, {
        type: OrderEvents.OrderUpdated,
        aggregateType: 'order',
        aggregateId: order.id,
        payload: { changed: ['link'], stage: updated.stage, version: updated.version },
      });

      const shop = await shopProfile(tx, tenant.shopId);
      const url = this.site.url(`/${ORDER_LINK_PATH}/${token}`);
      const name = orderName(order.number);
      const message = awaitsCustomer(order)
        ? `Please confirm your order ${name} from ${shop.name}:\n${url}\n` +
          'اپنا آرڈر کنفرم کرنے کے لیے یہ لنک کھولیں۔'
        : `Your order ${name} from ${shop.name}:\n${url}\n` +
          'اپنے آرڈر کی تفصیل کے لیے یہ لنک کھولیں۔';
      return {
        ok: true,
        value: {
          order: (await loadOrder(tx, tenant.shopId, order.id))!,
          url,
          whatsappUrl: whatsappUrl(message, phoneAccess(tenant) === 'full' ? order.phone : null),
          expiresAt,
        },
      };
    });
  }

  /** What a link's page shows: its order, or why there is none. */
  async viewLink(token: string): Promise<OrderLinkView> {
    const link = await this.#resolveLink(token);
    if (!link) return { kind: 'not_found' };
    return this.db.tenant(link.shopId, async (tx) => {
      const [row] = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.shopId, link.shopId), eq(orders.id, link.orderId)));
      return this.#view(tx, link.shopId, link.hash, row, null);
    });
  }

  /**
   * The customer confirms the order behind a link, as the page showed it (`shown`). An order that
   * no longer waits for them is shown as it is; one that changed since is shown again.
   */
  async confirmLink(token: string, shown: string): Promise<OrderLinkView> {
    return this.#act(token, shown, async (tx, shopId, order) => {
      if (!awaitsCustomer(order)) return null;
      const done = await this.orders.confirmLocked(tx, shopId, order, {
        actor: 'system',
        message: 'Confirmed by the customer through their link',
      });
      return done.ok ? null : { kind: 'refused' };
    });
  }

  /**
   * The customer cancels the order behind a link, as the page showed it: the order is cancelled
   * because the customer asked, its stock released, and its confirmation recorded as declined.
   * Only while the order waits for them; after that, it is for the shop.
   */
  async cancelLink(token: string, shown: string): Promise<OrderLinkView> {
    return this.#act(token, shown, async (tx, shopId, order) => {
      if (order.status === 'cancelled') return null;
      if (!awaitsCustomer(order)) return { kind: 'too_late' };
      const done = await this.orders.cancelLocked(tx, shopId, order, {
        actor: 'system',
        reason: 'customer',
        message: 'Cancelled by the customer through their link',
        declined: true,
      });
      return done.ok ? null : { kind: 'refused' };
    });
  }

  /**
   * Runs `action` on the link's order, locked, if the link still works and what the page showed
   * has not changed. Returns what the page shows next.
   */
  async #act(
    token: string,
    shown: string,
    action: (tx: Tx, shopId: string, order: OrderRow) => Promise<LinkProblem | null>,
  ): Promise<OrderLinkView> {
    const link = await this.#resolveLink(token);
    if (!link) return { kind: 'not_found' };
    return this.db.tenant(link.shopId, async (tx) => {
      const order = await lockOrder(tx, link.shopId, link.orderId);
      const view = await this.#view(tx, link.shopId, link.hash, order, null);
      if (view.kind !== 'order' || !order) return view;
      // Only while the order waits for the customer does what they saw matter.
      if (awaitsCustomer(order) && view.shown !== shown) {
        return { ...view, problem: { kind: 'changed' } };
      }
      const problem = await action(tx, link.shopId, order);
      if (problem) return { ...view, problem };
      return this.#view(tx, link.shopId, link.hash, order, null);
    });
  }

  /** The shop and order a link's secret belongs to, found without knowing the shop. */
  async #resolveLink(
    token: string,
  ): Promise<{ shopId: string; orderId: string; hash: Buffer } | null> {
    const hash = linkHashOf(token);
    if (!hash) return null;
    const { rows } = await this.db.app.execute<{ shop_id: string; order_id: string }>(
      sql`SELECT * FROM orders.resolve_order_link(${hash})`,
    );
    const row = rows[0];
    return row ? { shopId: row.shop_id, orderId: row.order_id, hash } : null;
  }

  /** What a link shows of the order, as it is now, if the link is still the order's. */
  async #view(
    tx: Tx,
    shopId: string,
    hash: Buffer,
    order: Pick<OrderRow, 'id' | 'linkTokenHash' | 'linkExpiresAt'> | undefined,
    problem: LinkProblem | null,
  ): Promise<OrderLinkView> {
    // The link was replaced, or taken with the customer's details, since it was found.
    if (!order?.linkTokenHash?.equals(hash) || !order.linkExpiresAt) return { kind: 'not_found' };
    const profile = await shopProfile(tx, shopId);
    const shop = { name: profile.name, timezone: profile.timezone };
    // An expired link shows nothing of the order, which carries the customer's address.
    if (order.linkExpiresAt <= new Date()) return { kind: 'expired', shop };
    const record = (await loadOrder(tx, shopId, order.id))!;
    return {
      kind: 'order',
      shop,
      order: record,
      shown: shownDigest(shownOfOrder(record)),
      problem,
    };
  }
}
