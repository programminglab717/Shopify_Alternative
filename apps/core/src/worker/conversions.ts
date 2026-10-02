import { StorefrontSite, shopProfile } from '@hatti/api';
import { Database } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import type { Logger } from '@hatti/logger';
import {
  ConversionsService,
  META_EVENT_WINDOW_MS,
  MetaConversionsClient,
  MetaConversionsService,
  metaEvent,
  retryDelayMs,
  type ConversionOrder,
  type ConversionOutcome,
  type MetaServerEvent,
} from '@hatti/marketing/public';
import type { CurrencyCode } from '@hatti/money';
import { shopDomainsOf } from '@hatti/online-store/public';
import {
  OrderEvents,
  orderConversionFactsIn,
  type FulfillmentUpdatedPayload,
  type OrderConversionFacts,
  type OrderCreatedPayload,
} from '@hatti/orders/public';
import { repeat } from './repeat.js';

/** What the worker needs of the orders module for conversions. */
export interface ConversionOrders {
  factsOf(shopId: string, ids: readonly string[]): Promise<OrderConversionFacts[]>;
}

/** The orders' facts conversions tell, as the worker reads them. */
export function workerConversionOrders(database: Database): ConversionOrders {
  return {
    factsOf: (shopId, ids) =>
      database.tenant(shopId, (tx) => orderConversionFactsIn(tx, shopId, ids)),
  };
}

/**
 * Records the moments of orders placed through checkout that the ad platforms hear of (MKT-10,
 * ADR-143): placed, for the shop's connected platforms; then confirmed, by its customer or staff,
 * or, for an order paid ahead, as its money comes in; then delivered. A part split from an order
 * was placed once already, as that order. Each moment is recorded once, however often its event
 * comes.
 */
export class ConversionMoments {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [
    OrderEvents.OrderCreated,
    OrderEvents.OrderConfirmed,
    OrderEvents.OrderPaid,
    OrderEvents.FulfillmentUpdated,
  ];

  constructor(
    private readonly conversions: ConversionsService,
    private readonly orders: ConversionOrders,
  ) {}

  async handle(event: DomainEvent): Promise<void> {
    const at = new Date(event.occurredAt);
    switch (event.type) {
      case OrderEvents.OrderCreated: {
        const { source, splitFromId } = event.payload as Partial<OrderCreatedPayload>;
        if (source === 'online_store' && !splitFromId) {
          await this.conversions.recordPlaced(event.shopId, event.aggregateId, at);
        }
        return;
      }
      case OrderEvents.OrderConfirmed:
        await this.conversions.recordAfterPlaced(event.shopId, event.aggregateId, 'confirmed', at);
        return;
      case OrderEvents.OrderPaid: {
        // An order paid ahead needs no confirming: its money coming in is what confirms it.
        if (!(await this.conversions.placedRecorded(event.shopId, event.aggregateId))) return;
        const [order] = await this.orders.factsOf(event.shopId, [event.aggregateId]);
        if (order?.confirmationStatus === 'not_required') {
          await this.conversions.recordAfterPlaced(
            event.shopId,
            event.aggregateId,
            'confirmed',
            at,
          );
        }
        return;
      }
      case OrderEvents.FulfillmentUpdated: {
        const { orderId, status, changed } = event.payload as Partial<FulfillmentUpdatedPayload>;
        if (orderId && status === 'delivered' && changed?.includes('status')) {
          await this.conversions.recordAfterPlaced(event.shopId, orderId, 'delivered', at);
        }
        return;
      }
    }
  }
}

/** How many of a shop's moments go in one request. */
const BATCH = 100;

/** How long a moment taken to send waits before another sender may take it, if this one stops. */
const LEASE_MS = 5 * 60_000;

export interface ConversionsSenderOptions {
  conversions: ConversionsService;
  meta: MetaConversionsService;
  orders: ConversionOrders;
  client: MetaConversionsClient;
  /** Where the shops' storefronts answer: the address events name. */
  storefronts: StorefrontSite;
  database: Database;
  logger?: Logger;
}

/**
 * Sends the moments due to Meta's conversions API (ADR-143), a shop at a time, a hundred in a
 * request: each as a server event, its order as it is when sent. Those Meta cannot take yet are
 * tried again later, a minute after the first try and doubling to six hours, while they are new
 * enough to go; those it refuses for good are failed, with what it said.
 */
export class ConversionsSender {
  constructor(private readonly options: ConversionsSenderOptions) {}

  /** One round: every shop with moments due sends them. How many went. */
  async sweep(at: Date = new Date()): Promise<number> {
    const shops = await this.options.conversions.dueShops(at);
    let sent = 0;
    for (const shopId of shops) {
      try {
        sent += await this.send(shopId, at);
      } catch (error) {
        // One shop's failure is not the others': its moments are due again after their lease.
        this.options.logger?.warn({ err: error, shopId }, 'conversions not sent');
      }
    }
    return sent;
  }

  /** Sends the shop's moments due at `at`, up to a request's worth. How many went. */
  async send(shopId: string, at: Date): Promise<number> {
    const { conversions, meta, orders, client, logger } = this.options;
    const claimed = await conversions.claim(shopId, at, BATCH, LEASE_MS);
    if (claimed.length === 0) return 0;
    const dataset = await meta.datasetOf(shopId);
    const outcomes: ConversionOutcome[] = [];
    const live = claimed.filter((conversion) => {
      if (!dataset) {
        outcomes.push({
          id: conversion.id,
          status: 'skipped',
          error: 'Not sent: the shop disconnected Meta',
        });
        return false;
      }
      if (at.getTime() - conversion.occurredAt.getTime() > META_EVENT_WINDOW_MS) {
        outcomes.push({
          id: conversion.id,
          status: 'expired',
          error: 'Not sent: Meta takes events up to seven days after they happened',
        });
        return false;
      }
      return true;
    });

    if (dataset && live.length > 0) {
      const facts = new Map(
        (
          await orders.factsOf(
            shopId,
            live.map((conversion) => conversion.orderId),
          )
        ).map((order) => [order.id, order]),
      );
      const sourceUrl = `${await this.#storefrontOf(shopId)}/checkout`;
      const sending: { id: string; attempts: number; event: MetaServerEvent }[] = [];
      for (const conversion of live) {
        const order = facts.get(conversion.orderId);
        if (!order || order.erased) {
          outcomes.push({
            id: conversion.id,
            status: 'skipped',
            error: order
              ? "Not sent: the customer's data was erased"
              : 'Not sent: the order is gone',
          });
          continue;
        }
        sending.push({
          id: conversion.id,
          attempts: conversion.attempts,
          event: metaEvent(toConversionOrder(order), conversion, {
            purchaseAt: dataset.purchaseAt,
            sourceUrl,
          }),
        });
      }
      if (sending.length > 0) {
        const result = await client.send(
          dataset,
          sending.map((each) => each.event),
        );
        if (!result.ok) {
          logger?.warn(
            { shopId, events: sending.length, retry: result.retry, traceId: result.traceId },
            `Meta refused conversions: ${result.message}`,
          );
        }
        for (const { id, attempts, event } of sending) {
          outcomes.push(
            result.ok
              ? { id, status: 'sent', eventName: event.event_name, traceId: result.traceId }
              : result.retry
                ? {
                    id,
                    status: 'pending',
                    error: result.message,
                    traceId: result.traceId,
                    nextAttemptAt: new Date(at.getTime() + retryDelayMs(attempts)),
                  }
                : {
                    id,
                    status: 'failed',
                    eventName: event.event_name,
                    error: result.message,
                    traceId: result.traceId,
                  },
          );
        }
      }
    }
    await conversions.settle(shopId, outcomes, at);
    return outcomes.filter((outcome) => outcome.status === 'sent').length;
  }

  /** Sends now, then every `intervalMs`, a round never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.options.logger?.warn({ err: error }, 'conversions sweep failed'),
    );
  }

  /** The shop's storefront address: its primary domain, else its handle's subdomain. */
  async #storefrontOf(shopId: string): Promise<string> {
    const { database, storefronts } = this.options;
    return database.tenant(shopId, async (tx) => {
      const profile = await shopProfile(tx, shopId);
      const primary = (await shopDomainsOf(tx, shopId)).find((domain) => domain.isPrimary);
      return primary ? storefronts.urlAt(primary.host) : storefronts.url(profile.handle);
    });
  }
}

/** An order's facts as Meta hears of them: the visits that brought its customer, the last first. */
function toConversionOrder(order: OrderConversionFacts): ConversionOrder {
  const visits = order.attribution ? [order.attribution.last, order.attribution.first] : [];
  return {
    number: order.number,
    currency: order.currency as CurrencyCode,
    total: order.total,
    customerId: order.customerId,
    phone: order.phone,
    email: order.email,
    name: order.name,
    city: order.city,
    zip: order.zip,
    clientIp: order.clientIp,
    clientUserAgent: order.clientUserAgent,
    visits: visits.map((visit) => ({
      at: new Date(visit.at),
      landingPage: visit.landingPage ?? null,
    })),
    lines: order.lines,
  };
}
