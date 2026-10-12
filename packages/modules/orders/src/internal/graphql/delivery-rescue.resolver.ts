import { CurrentTenant, RequireScopes, type TenantContext } from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { Args, Int, Query, Resolver } from '@nestjs/graphql';
import { DeliveryRescueService } from '../delivery-rescue.service.js';
import { orderName } from '../rules.js';
import {
  DeliveriesToRescue,
  DeliveryRescueAnswer,
  DeliveryToRescue,
} from './delivery-rescue.types.js';
import { TrackingInfo } from './order.types.js';

@Resolver()
export class DeliveryRescueResolver {
  constructor(private readonly rescue: DeliveryRescueService) {}

  @Query(() => DeliveriesToRescue, {
    description:
      'Parcels on their way whose last step is a failed delivery (COD-08, ADR-388), with what ' +
      'their customers answered on WhatsApp since: whether to deliver again or call them first.',
  })
  @RequireScopes('read_orders')
  async deliveriesToRescue(
    @CurrentTenant() tenant: TenantContext,
    @Args('first', {
      type: () => Int,
      defaultValue: 50,
      description: 'Parcels listed at most: up to 100.',
    })
    first: number,
  ): Promise<DeliveriesToRescue> {
    const { count, parcels } = await this.rescue.list(tenant, first);
    return Object.assign(new DeliveriesToRescue(), {
      count,
      parcels: parcels.map((parcel) =>
        Object.assign(new DeliveryToRescue(), {
          id: toPublicId('fulfillment', parcel.id),
          orderId: toPublicId('order', parcel.orderId),
          orderName: orderName(parcel.orderNumber),
          customerName: parcel.customerName,
          city: parcel.city,
          trackingInfo: Object.assign(new TrackingInfo(), {
            company: parcel.trackingCompany,
            number: parcel.trackingNumber,
            url: parcel.trackingUrl,
          }),
          attemptedAt: parcel.attemptedAt,
          reason: parcel.reason,
          attempts: parcel.attempts,
          answer:
            parcel.answer === 'retry'
              ? DeliveryRescueAnswer.RETRY
              : parcel.answer === 'call'
                ? DeliveryRescueAnswer.CALL
                : null,
          answeredAt: parcel.answeredAt,
        }),
      ),
    });
  }
}
