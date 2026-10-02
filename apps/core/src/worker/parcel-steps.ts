import type { DomainEvent } from '@hatti/events';
import {
  LogisticsEvents,
  type CourierParcelStatusValue,
  type ShipmentStatusChangedPayload,
} from '@hatti/logistics/public';
import type { Logger } from '@hatti/logger';
import type { FulfillmentEventStatusValue, FulfillmentService } from '@hatti/orders/public';

/** Each of a courier's statuses, as a step of the parcel's way (ADR-160). */
export const STEP_OF: Readonly<Record<CourierParcelStatusValue, FulfillmentEventStatusValue>> = {
  booked: 'confirmed',
  in_transit: 'in_transit',
  out_for_delivery: 'out_for_delivery',
  attempted: 'attempted_delivery',
  delivered: 'delivered',
  returning: 'returning',
  returned: 'returned',
  lost: 'failure',
  cancelled: 'failure',
};

/**
 * Records each change couriers say of the parcels booked with them as a step of the parcel's way
 * (SHP-05, ADR-160), which the customer's order page shows: once for each change, however often
 * its event comes, as of when the worker heard it.
 */
export class ParcelSteps {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [LogisticsEvents.ShipmentStatusChanged];

  constructor(
    private readonly fulfillments: FulfillmentService,
    private readonly logger?: Pick<Logger, 'info'>,
  ) {}

  async handle(event: DomainEvent): Promise<void> {
    const { fulfillmentId, to, courierStatus } =
      event.payload as Partial<ShipmentStatusChangedPayload>;
    if (!fulfillmentId || !to || !(to in STEP_OF)) return;
    const result = await this.fulfillments.recordEvent(
      { shopId: event.shopId, actor: 'system' },
      fulfillmentId,
      {
        status: STEP_OF[to],
        message: courierStatus || null,
        happenedAt: new Date(event.occurredAt),
        sourceKey: `${event.type}:${event.id}`,
      },
    );
    if (!result.ok) {
      // The parcel is gone, as with its order: nothing to show it on.
      this.logger?.info(
        { shopId: event.shopId, fulfillmentId, errors: result.errors },
        "parcel's step not recorded",
      );
    }
  }
}
