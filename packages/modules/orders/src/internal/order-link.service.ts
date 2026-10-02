import {
  InputChecker,
  PublicSite,
  StorefrontSite,
  failOne,
  phoneAccess,
  shopProfile,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { ObjectStorage } from '@hatti/storage';
import { Injectable, Optional } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { checkAddress } from './address.js';
import { fulfillmentEventsIn } from './fulfillment-events.js';
import type { ParcelSteps } from './link-pages.js';
import { linkShopIn, linkTermsIn } from './link-shop.js';
import type { GatewayFormStart } from './online-payment-page.js';
import { OnlinePayments, type OnlineGateway } from './online-payments.js';
import { OrderEvents, type OrderUpdatedPayload } from './events.js';
import {
  ORDER_LINK_PATH,
  linkExpiry,
  linkHashOf,
  newLinkToken,
  whatsappUrl,
  type AddressForm,
  type LinkClient,
  type LinkProblem,
  type LinkShop,
} from './links.js';
import { orderSettingsIn } from './order-settings.service.js';
import { addTimelineEntry, loadOrder, lockOrder, updateOrder } from './order-store.js';
import { OrderService } from './order.service.js';
import type { OrderRecord } from './records.js';
import {
  LINK_DAYS_AFTER_END,
  addressChangeable,
  awaitsCustomer,
  cancellableByCustomer,
  orderLinkExpiry,
  orderName,
  transferOwed,
} from './rules.js';
import { orders, type OrderRow } from './schema.js';
import { shownDigest, shownOfOrder, type ShownTerm } from './shown-order.js';
import {
  TransferReceiptService,
  receiptCountIn,
  type ReceiptUpload,
} from './transfer-receipt.service.js';

/**
 * What the customer does through a link, to the order locked in `tx`, with what the page shows
 * now: why not, if it did not.
 */
type LinkAction = (
  tx: Tx,
  shopId: string,
  order: OrderRow,
  now: string,
  terms: readonly ShownTerm[],
) => Promise<LinkProblem | null>;

/** The shop and order of a link's secret, and its digest. */
interface ResolvedLink {
  shopId: string;
  orderId: string;
  hash: Buffer;
}

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
  /** Null for a link that lasts until 30 days after the order ends. */
  expiresAt: Date | null;
}

/** What an order's link shows the customer. */
export type OrderLinkView =
  | { kind: 'not_found' }
  | { kind: 'expired'; shop: LinkShop }
  | {
      kind: 'order';
      shop: LinkShop;
      order: OrderRecord;
      /**
       * The shop's policies confirming agrees to, while the order waits for a customer who has
       * agreed to nothing yet (ADR-115).
       */
      terms: ShownTerm[];
      /** A digest of what the page shows, for its forms; see shownDigest. */
      shown: string;
      /** Whether the customer may cancel it here, as the shop's settings allow. */
      cancellable: boolean;
      /** How many receipts for its transfer the customer sent (ADR-080). */
      receipts: number;
      /**
       * While it waits for money and the shop takes it online (ADR-151): through which gateway,
       * and how much, in minor units.
       */
      onlinePayment: { gateway: OnlineGateway; amount: bigint } | null;
      /** Its parcels' steps on their way (ADR-160), by parcel. */
      steps: ParcelSteps;
      problem: LinkProblem | null;
      /**
       * The form that takes the customer on to the shop's gateway, once they asked to pay online
       * and its page takes one, as JazzCash's does (ADR-163).
       */
      gatewayForm?: GatewayFormStart;
    };

/**
 * Links for orders' customers: a page where they see their order and, while a cash-on-delivery
 * order waits for them, confirm or cancel it; while a bank-transfer order waits for their money,
 * where to pay it, and where to send the receipt. After that it shows how the order is doing. Until
 * the order is packed, they may correct its delivery address. It is the tap-to-confirm link of the
 * confirmation sequence (COD-02), which staff send by hand until messaging does. Anything the
 * customer does goes on the order's timeline as done by them, through the system.
 */
@Injectable()
export class OrderLinkService {
  constructor(
    private readonly db: Database,
    private readonly orders: OrderService,
    private readonly site: PublicSite,
    /** Where the shop's policies are, which the page links while the order waits. */
    private readonly storefronts: StorefrontSite,
    /** Where customers' receipts go; without it, as for the seed, none are taken. */
    @Optional() private readonly receipts?: TransferReceiptService,
    /** For the shop's logo on the page; without it, the page shows the shop's name. */
    @Optional() private readonly storage?: ObjectStorage,
    /** Paying online through the shop's gateway (ADR-151); without it, transfers alone. */
    @Optional() private readonly payments?: OnlinePayments,
  ) {}

  /**
   * A new link for an open order's customer, working until 30 days after the order ends, or for
   * `expiresInHours` if given (at most 720). It replaces the order's previous link, which stops
   * working.
   */
  async createLink(
    tenant: TenantContext,
    id: string,
    options: { expiresInHours?: number | null } = {},
  ): Promise<MutationResult<OrderLink>> {
    let hours: number | null = null;
    let expiresAt: Date | null = null;
    if (options.expiresInHours !== undefined && options.expiresInHours !== null) {
      const expiry = linkExpiry(options.expiresInHours);
      if (!expiry.ok) return expiry;
      ({ hours, expiresAt } = expiry.value);
    }

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
        hours === null
          ? `Made a link for the customer, working until ${LINK_DAYS_AFTER_END} days after the order ends`
          : `Made a link for the customer, working for ${hours} ${hours === 1 ? 'hour' : 'hours'}`,
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
        : updated.stage === 'awaiting_payment' && order.paymentMethod === 'online'
          ? `Pay for your order ${name} from ${shop.name} online:\n${url}\n` +
            'آن لائن ادائیگی کے لیے یہ لنک کھولیں۔'
          : updated.stage === 'awaiting_payment'
            ? `Pay ${order.paymentMethod === 'bank_transfer' ? 'for' : 'the advance on'} your ` +
              `order ${name} from ${shop.name} by bank transfer:\n${url}\n` +
              'بینک ٹرانسفر کی تفصیل کے لیے یہ لنک کھولیں۔'
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
   * The customer confirms the order behind a link, as the page showed it (`shown`), from
   * `client`. An order that no longer waits for them is shown as it is; one that changed since
   * is shown again. One that keeps nothing they agreed to keeps it now (ADR-115): the versions of
   * the policies the page named, where they confirmed it from, and when.
   */
  async confirmLink(
    token: string,
    shown: string,
    client: LinkClient = { ip: null, userAgent: null },
  ): Promise<OrderLinkView> {
    return this.#act(token, async (tx, shopId, order, now, terms) => {
      if (!awaitsCustomer(order)) return null;
      if (now !== shown) return { kind: 'changed' };
      const done = await this.orders.confirmLocked(tx, shopId, order, {
        actor: 'system',
        message: 'Confirmed by the customer through their link',
        agreement: { ...client, policyVersions: terms.map((term) => term.versionId) },
      });
      return done.ok ? null : { kind: 'refused' };
    });
  }

  /**
   * The customer cancels the order behind a link, as the page showed it: the order is cancelled
   * because the customer asked, and its stock released. While the order waits for them, its
   * confirmation is recorded as declined; after they confirmed it, until it is packed if the
   * shop's settings allow, it stays confirmed, and the timeline says they changed their mind.
   * After that, cancelling is for the shop.
   */
  async cancelLink(token: string, shown: string): Promise<OrderLinkView> {
    return this.#act(token, async (tx, shopId, order, now) => {
      if (order.status === 'cancelled') return null;
      const settings = await orderSettingsIn(tx, shopId);
      if (!cancellableByCustomer(order, settings.customerCancellation)) {
        return { kind: 'too_late', action: 'cancel' };
      }
      if (now !== shown) return { kind: 'changed' };
      const declined = awaitsCustomer(order);
      const done = await this.orders.cancelLocked(tx, shopId, order, {
        actor: 'system',
        reason: 'customer',
        message: declined
          ? 'Cancelled by the customer through their link'
          : order.paymentMethod === 'bank_transfer' || order.paymentMethod === 'online'
            ? 'Cancelled by the customer through their link, before paying'
            : 'Cancelled by the customer through their link, after confirming it',
        declined,
      });
      return done.ok ? null : { kind: 'refused' };
    });
  }

  /**
   * The customer corrects the order's delivery address, from the order as the page showed it,
   * until the order is packed. Their number stays as it is: the page shows it masked, and a new
   * one is for the shop to take. An address that does not check out is shown again, with what is
   * wrong. A cash-on-delivery order is scored again for its new address, as when staff change it.
   */
  async changeAddress(token: string, shown: string, form: AddressForm): Promise<OrderLinkView> {
    return this.#act(token, (tx, shopId, order, now) =>
      changeAddressLocked(this.orders, tx, shopId, order, { now, shown, form }),
    );
  }

  /**
   * The customer sends the receipt of their transfer through the link, while the order waits for
   * it: a photo, a screenshot or a PDF, which the shop sees with the order (ADR-080).
   */
  async sendReceipt(token: string, upload: ReceiptUpload): Promise<OrderLinkView> {
    const receipts = this.receipts;
    if (!receipts) throw new Error('Receipts need storage, which this service was not given');
    const link = await this.#resolveLink(token);
    if (!link) return { kind: 'not_found' };
    // Storage takes the bytes first, so no transaction waits on it; the order takes them after.
    const stored = await receipts.store(link.shopId, link.orderId, upload);
    let view: OrderLinkView | undefined;
    try {
      view = await this.#actOn(link, (tx, shopId, order) =>
        receipts.receiveLocked(tx, shopId, order, stored),
      );
      return view;
    } finally {
      // Not taken, or the transaction failed: storage keeps nothing of it.
      if (view?.kind !== 'order' || view.problem) await receipts.discard(stored);
    }
  }

  /**
   * The customer asked to pay online what the order waits for (ADR-151): the shop's gateway's
   * page to send them to; the page with the form that takes them there, where the gateway's page
   * takes one (ADR-163); or the page again with why not. They come back to the link's `paid`
   * address, and to the link itself if they give up.
   */
  async payOnline(token: string): Promise<{ url: string } | OrderLinkView> {
    const link = await this.#resolveLink(token);
    if (!link) return { kind: 'not_found' };
    const view = await this.viewLink(token);
    if (view.kind !== 'order') return view;
    if (!view.onlinePayment || !this.payments) {
      return { ...view, problem: { kind: 'too_late', action: 'pay' } };
    }
    const page = this.site.url(`${ORDER_LINK_PATH}/${token}`);
    const started = await this.payments.start(link.shopId, link.orderId, {
      returnUrl: `${page}/paid`,
      cancelUrl: page,
    });
    if (!('url' in started))
      return { ...view, problem: { kind: 'payment', reason: 'unavailable' } };
    return started.form
      ? { ...view, gatewayForm: { url: started.url, form: started.form } }
      : started;
  }

  /**
   * The customer came back from the shop's gateway with `form`, as it sent them: the page, saying
   * the payment is in once the gateway says so, here or by its webhook.
   */
  async paidOnline(token: string, form: Readonly<Record<string, string>>): Promise<OrderLinkView> {
    const link = await this.#resolveLink(token);
    if (!link) return { kind: 'not_found' };
    const outcome = this.payments
      ? await this.payments.returned(link.shopId, link.orderId, form)
      : null;
    const view = await this.viewLink(token);
    if (view.kind !== 'order') return view;
    if (outcome === 'test') return { ...view, problem: { kind: 'payment', reason: 'test' } };
    if (outcome === 'paid') return view;
    // Its webhook may have said so already; or nothing has yet.
    const owed = view.order.status === 'open' ? transferOwed(view.order) : 0n;
    return owed > 0n ? { ...view, problem: { kind: 'payment', reason: 'pending' } } : view;
  }

  /**
   * Runs `action` on the link's order, locked, if the link still works. `action` gets a digest of
   * what the page shows now, to compare with what the customer saw where that matters. Returns
   * what the page shows next.
   */
  async #act(token: string, action: LinkAction): Promise<OrderLinkView> {
    const link = await this.#resolveLink(token);
    return link ? this.#actOn(link, action) : { kind: 'not_found' };
  }

  /** Runs `action` on the order of a link {@link #resolveLink} found, as {@link #act} does. */
  async #actOn(link: ResolvedLink, action: LinkAction): Promise<OrderLinkView> {
    return this.db.tenant(link.shopId, async (tx) => {
      const order = await lockOrder(tx, link.shopId, link.orderId);
      const view = await this.#view(tx, link.shopId, link.hash, order, null);
      if (view.kind !== 'order' || !order) return view;
      const problem = await action(tx, link.shopId, order, view.shown, view.terms);
      if (problem) return { ...view, problem };
      return this.#view(tx, link.shopId, link.hash, order, null);
    });
  }

  /** The shop and order a link's secret belongs to, found without knowing the shop. */
  async #resolveLink(token: string): Promise<ResolvedLink | null> {
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
    order:
      | Pick<
          OrderRow,
          'id' | 'status' | 'linkTokenHash' | 'linkExpiresAt' | 'closedAt' | 'cancelledAt'
        >
      | undefined,
    problem: LinkProblem | null,
  ): Promise<OrderLinkView> {
    // The link was replaced, or taken with the customer's details, since it was found.
    if (!order?.linkTokenHash?.equals(hash)) return { kind: 'not_found' };
    const shop = await linkShopIn(tx, shopId, this.storage);
    // An expired link shows nothing of the order, which carries the customer's address.
    const expiresAt = orderLinkExpiry(order);
    if (expiresAt && expiresAt <= new Date()) return { kind: 'expired', shop };
    const record = (await loadOrder(tx, shopId, order.id))!;
    const settings = await orderSettingsIn(tx, shopId);
    // What confirming agrees to, for a customer who has agreed to nothing yet.
    const terms =
      awaitsCustomer(record) && !record.agreement
        ? await linkTermsIn(tx, shopId, this.storefronts)
        : [];
    // What it waits for before it ships, which the shop's gateway may take online.
    const owed =
      record.status === 'open' && record.stage === 'awaiting_payment' ? transferOwed(record) : 0n;
    const gateway =
      owed > 0n && this.payments
        ? await this.payments.gatewayOf(tx, shopId, record.currency)
        : null;
    return {
      kind: 'order',
      shop,
      order: record,
      terms,
      shown: shownDigest(shownOfOrder(record, terms)),
      cancellable: cancellableByCustomer(record, settings.customerCancellation),
      // A transfer's, or a cash-on-delivery order's advance (ADR-083).
      receipts:
        record.paymentMethod === 'bank_transfer' || record.advanceDue > 0n
          ? await receiptCountIn(tx, shopId, order.id)
          : 0,
      onlinePayment: gateway ? { gateway, amount: owed } : null,
      steps: await fulfillmentEventsIn(
        tx,
        shopId,
        record.fulfillments.map((parcel) => parcel.id),
      ),
      problem,
    };
  }
}

/**
 * The customer changes the address of an order locked in `tx`, through a link to it or to the
 * draft it came from, as {@link OrderLinkService.changeAddress} describes: `now` is a digest of
 * what the page shows now, and `shown` of what it showed them. Returns why it did not happen, if
 * it did not.
 */
export async function changeAddressLocked(
  orders: OrderService,
  tx: Tx,
  shopId: string,
  order: OrderRow,
  change: { now: string; shown: string; form: AddressForm },
): Promise<LinkProblem | null> {
  const { now, shown, form } = change;
  if (!addressChangeable(order)) return { kind: 'too_late', action: 'address' };
  if (now !== shown) return { kind: 'changed' };
  const check = new InputChecker();
  const address = checkAddress(check, [], { ...form, phone: order.phone ?? '' });
  if (!address) return { kind: 'address', form, errors: check.errors };
  const done = await orders.updateLocked(
    tx,
    shopId,
    order,
    { address },
    {
      actor: 'system',
      message: (changed) => `The customer changed the ${changed} through their link`,
    },
  );
  return done.ok ? null : { kind: 'refused' };
}
