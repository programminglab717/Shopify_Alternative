import {
  CurrentTenant,
  RequireScopes,
  badUserInput,
  pageSize,
  type TenantContext,
} from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { Args, Query, Resolver } from '@nestjs/graphql';
import {
  CodHealthService,
  type CodConfirmationTally,
  type CodDeliveryTally,
  type CodHealthDimension as CodHealthDimensionValue,
  type CodHealthRow as CodHealthRowRecord,
} from '../cod-health.service.js';
import {
  CodConfirmation,
  CodDelivery,
  CodHealth,
  CodHealthArgs,
  CodHealthRow,
} from './cod-health.types.js';

@Resolver()
export class CodHealthResolver {
  constructor(private readonly health: CodHealthService) {}

  @Query(() => CodHealth, {
    description:
      "COD health (COD-12): how a period's cash-on-delivery orders turned out, confirmed of " +
      'those placed, and delivered and returned of their parcels, for the shop and by city, ' +
      'product, source or courier. Worked out from the orders when asked.',
  })
  @RequireScopes('read_orders')
  async codHealth(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: CodHealthArgs,
  ): Promise<CodHealth> {
    const by = args.by ? (args.by.toLowerCase() as CodHealthDimensionValue) : null;
    const result = await this.health.report(tenant, {
      placedFrom: args.placedFrom,
      placedBefore: args.placedBefore,
      by,
      first: pageSize(args.first),
    });
    if (!result.ok) throw badUserInput(result.errors[0]!.message);
    const report = result.value;
    return Object.assign(new CodHealth(), {
      confirmation: toConfirmation(report.confirmation),
      delivery: toDelivery(report.delivery),
      rows: report.rows.map((row) => toRow(row, by)),
    });
  }
}

/** A share from 0 to 1, to four places; null when there is nothing to share out. */
function share(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part / whole) * 10_000) / 10_000;
}

function toConfirmation(tally: CodConfirmationTally): CodConfirmation {
  return Object.assign(new CodConfirmation(), {
    ...tally,
    rate: share(tally.confirmed, tally.confirmed + tally.cancelled),
  });
}

function toDelivery(tally: CodDeliveryTally): CodDelivery {
  const arrived = tally.delivered + tally.returned;
  return Object.assign(new CodDelivery(), {
    ...tally,
    successRate: share(tally.delivered, arrived),
    returnRate: share(tally.returned, arrived),
  });
}

function toRow(row: CodHealthRowRecord, by: CodHealthDimensionValue | null): CodHealthRow {
  const key =
    row.key === null
      ? null
      : by === 'product'
        ? toPublicId('product', row.key)
        : by === 'source'
          ? row.key.toUpperCase()
          : row.key;
  return Object.assign(new CodHealthRow(), {
    key,
    title: row.title,
    confirmation: row.confirmation ? toConfirmation(row.confirmation) : null,
    delivery: toDelivery(row.delivery),
  });
}
