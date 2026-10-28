import { CurrentTenant, Money, RequireScopes, type TenantContext } from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { money } from '@hatti/money';
import { Args, Int, Query, Resolver } from '@nestjs/graphql';
import { PaymentTermsService } from '../payment-terms.service.js';
import { PaymentTermsCustomer, PaymentTermsOwed } from './payment-terms.types.js';

@Resolver()
export class PaymentTermsResolver {
  constructor(private readonly terms: PaymentTermsService) {}

  @Query(() => PaymentTermsOwed, {
    description:
      'What wholesale customers owe on orders on payment terms (CUS-06, ADR-888), the most ' +
      "overdue first: each customer's orders owed, what they come to and what is past due.",
  })
  @RequireScopes('read_orders')
  async paymentTermsOwed(
    @CurrentTenant() tenant: TenantContext,
    @Args('first', {
      type: () => Int,
      nullable: true,
      description: 'Customers at most, 1 to 100; 50 when left out.',
    })
    first?: number | null,
  ): Promise<PaymentTermsOwed> {
    const owed = await this.terms.owed(tenant, { first: first ?? 50 });
    const amount = (minor: bigint) => Money.from(money(minor, tenant.currency));
    return Object.assign(new PaymentTermsOwed(), {
      owed: amount(owed.owed),
      overdue: amount(owed.overdue),
      customers: owed.customers.map((each) =>
        Object.assign(new PaymentTermsCustomer(), {
          ...each,
          customerId: toPublicId('customer', each.customerId),
          owed: amount(each.owed),
          overdue: amount(each.overdue),
        }),
      ),
    });
  }
}
