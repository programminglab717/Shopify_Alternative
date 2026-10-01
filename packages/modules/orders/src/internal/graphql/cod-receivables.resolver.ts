import { CurrentTenant, Money, RequireScopes, type TenantContext } from '@hatti/api';
import { money } from '@hatti/money';
import { Query, Resolver } from '@nestjs/graphql';
import {
  CodReceivablesService,
  type CodCash as CodCashRecord,
  type ReceivableAge,
} from '../cod-receivables.service.js';
import {
  CodCash,
  CodReceivableAge,
  CodReceivables,
  CourierReceivables,
} from './cod-receivables.types.js';

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
}
