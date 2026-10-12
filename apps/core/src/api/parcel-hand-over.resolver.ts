import { CurrentTenant, Loaders, RequestLoaders, type TenantContext } from '@hatti/api';
import { fromPublicId, toPublicId } from '@hatti/ids';
import {
  CourierPickupService,
  ParcelHandOver,
  type ParcelHandOverRecord,
} from '@hatti/logistics/public';
import { Fulfillment } from '@hatti/orders/public';
import { Parent, ResolveField, Resolver } from '@nestjs/graphql';

/**
 * A parcel's last hand-over to its courier's rider on the order's page (SHP-02, SHP-04,
 * ADR-381): the orders module keeps the parcel, logistics its booking and the pickups it went in,
 * and the core puts the two together, one query for all of a page's parcels.
 */
@Resolver(() => Fulfillment)
export class ParcelHandOverResolver {
  constructor(private readonly pickups: CourierPickupService) {}

  @ResolveField(() => ParcelHandOver, {
    nullable: true,
    description:
      "Its last hand-over to its courier's rider, checked off in a pickup, and what the " +
      "courier's tracking has said of it since; null for a parcel not booked through Hatti, or " +
      'not checked off yet.',
  })
  async handOver(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() fulfillment: Fulfillment,
  ): Promise<ParcelHandOver | null> {
    const loader = loaders.get<string, ParcelHandOverRecord>('logistics.parcelHandOvers', (ids) =>
      this.pickups.handOversOf(tenant, ids),
    );
    const record = await loader.load(fromPublicId(fulfillment.id, 'fulfillment'));
    if (!record) return null;
    return Object.assign(new ParcelHandOver(), {
      handedOverAt: record.handedOverAt,
      pickupId: toPublicId('courierPickup', record.pickupId),
      byHand: record.byHand,
      riderName: record.rider.name,
      riderCode: record.rider.code,
      seen: record.seen,
      unseen: record.unseen,
    });
  }
}
