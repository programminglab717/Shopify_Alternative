import { CurrentTenant, Money, RequireScopes, type TenantContext } from '@hatti/api';
import { money } from '@hatti/money';
import { Args, Int, Query, Resolver } from '@nestjs/graphql';
import {
  CodReceivablesService,
  DISPUTE_DAYS,
  type CodCash as CodCashRecord,
  type ReceivableAge,
} from '../cod-receivables.service.js';
import {
  CodCash,
  CodReceivableAge,
  CodReceivables,
  CourierReceivables,
} from './cod-receivables.types.js';
import { OrderExportFile } from './export.types.js';

@Resolver()
export class CodReceivablesResolver {
  constructor(private readonly receivables: CodReceivablesService) {}

  @Query(() => CodReceivables, {
    description:
      'The cash on delivery couriers hold for the shop (COD-10): what they owe on delivered ' +
      'orders not yet paid, by courier and by days since delivery, and what is on its way.',
  })
  @RequireScopes('read_orders')
  async codReceivables(@CurrentTenant() tenant: TenantContext): Promise<CodReceivables> {
    const report = await this.receivables.report(tenant);
    const currency = tenant.currency;
    const cash = (value: CodCashRecord) =>
      Object.assign(new CodCash(), {
        count: value.count,
        amount: Money.from(money(value.amount, currency)),
      });
    const ages = (values: readonly ReceivableAge[]) =>
      values.map((age) =>
        Object.assign(new CodReceivableAge(), {
          fromDays: age.fromDays,
          toDays: age.toDays,
          count: age.count,
          amount: Money.from(money(age.amount, currency)),
        }),
      );
    return Object.assign(new CodReceivables(), {
      owed: cash(report.owed),
      ages: ages(report.ages),
      onTheWay: cash(report.onTheWay),
      couriers: report.couriers.map((courier) =>
        Object.assign(new CourierReceivables(), {
          courier: courier.courier,
          owed: cash(courier.owed),
          ages: ages(courier.ages),
          oldestDeliveredAt: courier.oldestDeliveredAt,
        }),
      ),
    });
  }

  @Query(() => OrderExportFile, {
    description:
      "A courier's dispute sheet (COD-10, ADR-605): the parcels it delivered olderThanDays days " +
      'ago or more whose cash the shop has not had in full, as an Excel workbook to send it, ' +
      'the oldest first: each by tracking number, with its order, when it was delivered, its ' +
      'city, the cash it was to collect, what came of it and what is still owed. The courier is ' +
      'as codReceivables names it, in any letter case; none for parcels shipped without one.',
  })
  @RequireScopes('read_orders')
  async codDisputeSheet(
    @CurrentTenant() tenant: TenantContext,
    @Args('courier', { type: () => String, nullable: true }) courier: string | null,
    @Args('olderThanDays', {
      type: () => Int,
      defaultValue: DISPUTE_DAYS.default,
      description: `Days since delivery, 0 to ${DISPUTE_DAYS.max}; a week unless said.`,
    })
    olderThanDays: number,
  ): Promise<OrderExportFile> {
    const sheet = await this.receivables.disputeSheet(tenant, courier ?? null, olderThanDays);
    return Object.assign(new OrderExportFile(), {
      filename: sheet.filename,
      contentType: sheet.contentType,
      content: sheet.content.toString('base64'),
    });
  }
}
