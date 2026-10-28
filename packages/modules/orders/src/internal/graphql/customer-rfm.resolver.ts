import { CurrentTenant, Money, RequireScopes, badUserInput, type TenantContext } from '@hatti/api';
import { money } from '@hatti/money';
import { Args, Int, Query, Resolver } from '@nestjs/graphql';
import { CustomerRfmService } from '../customer-rfm.service.js';
import {
  CustomerRfm,
  RfmFrequency,
  RfmGroup,
  RfmGroupName,
  RfmRecency,
} from './customer-rfm.types.js';

@Resolver()
export class CustomerRfmResolver {
  constructor(private readonly rfm: CustomerRfmService) {}

  @Query(() => CustomerRfm, {
    description:
      'Customers by how recently and how often they buy (ANL-04, ADR-887): each group with ' +
      'how many, what they spent, and the segment query that finds them.',
  })
  @RequireScopes('read_orders')
  async customerRfm(
    @CurrentTenant() tenant: TenantContext,
    @Args('recentDays', {
      type: () => Int,
      nullable: true,
      description: 'Recent: last ordered within this many days, 1 to 730; 30 when left out.',
    })
    recentDays?: number | null,
    @Args('lapsedDays', {
      type: () => Int,
      nullable: true,
      description: 'Lapsed: last ordered this many days ago or more, past recentDays; 90.',
    })
    lapsedDays?: number | null,
  ): Promise<CustomerRfm> {
    const result = await this.rfm.report(tenant, {
      recentDays: recentDays ?? 30,
      lapsedDays: lapsedDays ?? 90,
    });
    if (!result.ok) throw badUserInput(result.errors[0]!.message);
    const report = result.value;
    return Object.assign(new CustomerRfm(), {
      ...report,
      groups: report.groups.map((group) =>
        Object.assign(new RfmGroup(), {
          ...group,
          name: group.name.toUpperCase() as RfmGroupName,
          recency: group.recency.toUpperCase() as RfmRecency,
          frequency: group.frequency.toUpperCase() as RfmFrequency,
          amountSpent: Money.from(money(group.amountSpent, tenant.currency)),
        }),
      ),
    });
  }
}
