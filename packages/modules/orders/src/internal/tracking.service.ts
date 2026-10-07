import { Database } from '@hatti/db';
import { parsePkMobile } from '@hatti/pk';
import { ObjectStorage } from '@hatti/storage';
import { Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { fulfillmentEventsIn } from './fulfillment-events.js';
import type { ParcelSteps } from './link-pages.js';
import { linkShopIn } from './link-shop.js';
import type { LinkShop } from './links.js';
import { loadOrder } from './order-store.js';
import type { OrderRecord } from './records.js';

/** What a customer typed to find their order on the shop's tracking page (SHP-05, ADR-251). */
export interface TrackingForm {
  /** The order's number, "#1001" or "1001", or a tracking number of one of its parcels. */
  reference: string;
  /** The mobile number the order was placed with, however it is written. */
  phone: string;
}

export const EMPTY_TRACKING_FORM: TrackingForm = { reference: '', phone: '' };

/** What the shop's tracking page shows: the form, or the order found by it. */
export type TrackingView =
  | {
      kind: 'form';
      shop: LinkShop;
      form: TrackingForm;
      /**
       * Why nothing is shown: a field left blank, or no order of the shop's has both, which is
       * all a wrong number is told too.
       */
      problem: 'blank' | 'not_found' | null;
    }
  | { kind: 'order'; shop: LinkShop; form: TrackingForm; order: OrderRecord; steps: ParcelSteps };

const ORDER_NUMBER = /^#?\s*(\d{1,9})$/;

/**
 * The shop's tracking page (SHP-05, ADR-251): a customer finds their order by its number, or a
 * tracking number the courier's message gave them, with the mobile number they ordered with, and
 * sees how it is doing and each parcel's steps (ADR-160), as their order's own page shows them,
 * but nothing of its address or items. A number that is not the order's finds nothing, as an
 * order the shop lacks does. The storefront limits how often an address asks.
 */
@Injectable()
export class OrderTrackingService {
  constructor(
    private readonly db: Database,
    /** Where the shop's logo is; without it, as for the seed, the page shows the shop's name. */
    @Optional() private readonly storage?: ObjectStorage,
  ) {}

  /** The page with its form, empty. */
  async page(shopId: string): Promise<TrackingView> {
    return this.db.tenant(shopId, async (tx) => ({
      kind: 'form',
      shop: await linkShopIn(tx, shopId, this.storage),
      form: EMPTY_TRACKING_FORM,
      problem: null,
    }));
  }

  /** The order `form` finds, or the form again saying why not. */
  async find(shopId: string, form: TrackingForm): Promise<TrackingView> {
    const typed = {
      reference: form.reference.trim().slice(0, 100),
      phone: form.phone.trim().slice(0, 30),
    };
    return this.db.tenant(shopId, async (tx): Promise<TrackingView> => {
      const shop = await linkShopIn(tx, shopId, this.storage);
      if (typed.reference === '' || typed.phone === '') {
        return { kind: 'form', shop, form: typed, problem: 'blank' };
      }
      const notFound: TrackingView = { kind: 'form', shop, form: typed, problem: 'not_found' };
      const phone = parsePkMobile(typed.phone)?.e164;
      if (!phone) return notFound;
      const number = ORDER_NUMBER.exec(typed.reference)?.[1];
      // By its number, or a parcel's tracking number, as couriers write them in any case; an
      // order whose customer's details were erased has no number to match.
      const { rows } = await tx.execute<{ id: string }>(sql`
        SELECT o.id FROM orders.orders o
         WHERE o.shop_id = ${shopId} AND o.phone = ${phone}
           AND (${number === undefined ? sql`false` : sql`o.number = ${Number(number)}`}
                OR EXISTS (SELECT 1 FROM orders.fulfillments f
                            WHERE f.shop_id = o.shop_id AND f.order_id = o.id
                              AND upper(f.tracking_number) = upper(${typed.reference})))
         ORDER BY o.created_at DESC
         LIMIT 1`);
      const id = rows[0]?.id;
      const order = id ? await loadOrder(tx, shopId, id) : null;
      if (!order) return notFound;
      return {
        kind: 'order',
        shop,
        form: typed,
        order,
        steps: await fulfillmentEventsIn(
          tx,
          shopId,
          order.fulfillments.map((parcel) => parcel.id),
        ),
      };
    });
  }
}
