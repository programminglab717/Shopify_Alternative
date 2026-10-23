import { CurrentTenant, RequireScopes, badUserInput, type TenantContext } from '@hatti/api';
import { Args, Int, Query, Resolver } from '@nestjs/graphql';
import { CustomerCohortsService } from '../customer-cohorts.service.js';
import { CustomerCohort } from './customer-cohorts.types.js';

@Resolver()
export class CustomerCohortsResolver {
  constructor(private readonly cohorts: CustomerCohortsService) {}

  @Query(() => [CustomerCohort], {
    description:
      'Customers in cohorts by the month of their first order, and how many came back each ' +
      "month after (ANL-04): the last `months` months in the shop's time zone, this month the " +
      'last, worked out from the orders when asked.',
  })
  @RequireScopes('read_orders')
  async customerCohorts(
    @CurrentTenant() tenant: TenantContext,
    @Args('months', {
      type: () => Int,
      nullable: true,
      description: 'How many months, 1 to 24; 12 when left out.',
    })
    months?: number | null,
  ): Promise<CustomerCohort[]> {
    const result = await this.cohorts.cohorts(tenant, { months: months ?? 12 });
    if (!result.ok) throw badUserInput(result.errors[0]!.message);
    return result.value.map((cohort) => Object.assign(new CustomerCohort(), cohort));
  }
}
