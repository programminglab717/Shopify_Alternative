import { CurrentTenant, Money, RequireScopes, badUserInput, type TenantContext } from '@hatti/api';
import { money, type CurrencyCode } from '@hatti/money';
import { Args, Query, Resolver } from '@nestjs/graphql';
import {
  CourierPerformanceService,
  type CourierPerformanceTally as Tally,
} from '../courier-performance.service.js';
import { share } from './cod-health.resolver.js';
import {
  CourierPerformance,
  CourierPerformanceArgs,
  CourierPerformanceCity,
} from './courier-performance.types.js';

@Resolver()
export class CourierPerformanceResolver {
  constructor(private readonly performance: CourierPerformanceService) {}

  @Query(() => [CourierPerformance], {
    description:
      "Couriers' performance (SHP-08, ADR-384): how each courier's parcels shipped in a period " +
      'went, everywhere and city by city, the most parcels first. Worked out when asked.',
  })
  @RequireScopes('read_orders')
  async courierPerformance(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: CourierPerformanceArgs,
  ): Promise<CourierPerformance[]> {
    const result = await this.performance.report(tenant, args);
    if (!result.ok) throw badUserInput(result.errors[0]!.message);
    return result.value.map((row) =>
      Object.assign(new CourierPerformance(), {
        ...tallyOf(row, tenant.currency),
        courier: row.courier,
        title: row.title,
        cities: row.cities.map((city) =>
          Object.assign(new CourierPerformanceCity(), {
            ...tallyOf(city, tenant.currency),
            city: city.city,
          }),
        ),
      }),
    );
  }
}

function tallyOf(tally: Tally, currency: CurrencyCode) {
  const amount = (value: bigint) => Money.from(money(value, currency));
  return {
    shipped: tally.shipped,
    delivered: tally.delivered,
    returned: tally.returned,
    lost: tally.lost,
    inTransit: tally.inTransit,
    deliveryRate: share(tally.delivered, tally.delivered + tally.returned + tally.lost),
    returnRate: share(tally.returned, tally.delivered + tally.returned),
    daysToDeliver: tally.daysToDeliver,
    charges: amount(tally.charges),
    chargePerParcel:
      tally.parcelsCosted === 0
        ? null
        : amount((tally.charges + BigInt(tally.parcelsCosted) / 2n) / BigInt(tally.parcelsCosted)),
    chargesEstimated: amount(tally.chargesEstimated),
  };
}
