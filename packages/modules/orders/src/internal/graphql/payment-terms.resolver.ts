import {
  CurrentTenant,
  Money,
  RequireScopes,
  UserError,
  badUserInput,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { money, type CurrencyCode } from '@hatti/money';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { PaymentTermsService, type CustomerCredit as Credit } from '../payment-terms.service.js';
import {
  CustomerCredit,
  CustomerCreditPayload,
  PaymentTermsCustomer,
  PaymentTermsOwed,
} from './payment-terms.types.js';

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

  @Query(() => CustomerCredit, {
    description:
      "A customer's credit limit on payment terms and what they owe on terms now (ADR-907).",
  })
  @RequireScopes('read_orders')
  async customerCredit(
    @CurrentTenant() tenant: TenantContext,
    @Args('customerId', { type: () => ID }) customerId: string,
  ): Promise<CustomerCredit> {
    return toCredit(await this.terms.credit(tenant, customerUuid(customerId)), tenant.currency);
  }

  @Mutation(() => CustomerCreditPayload, {
    description:
      'Sets what a customer may owe on payment terms at most, in major units, "200,000"; null ' +
      'or blank for no limit (ADR-907). Orders already placed stay as they are.',
  })
  @RequireScopes('write_orders')
  async customerCreditLimitSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('customerId', { type: () => ID }) customerId: string,
    @Args('creditLimit', { type: () => String, nullable: true }) creditLimit: string | null,
  ): Promise<CustomerCreditPayload> {
    const result = await this.terms.setCreditLimit(tenant, customerUuid(customerId), creditLimit);
    return Object.assign(new CustomerCreditPayload(), {
      credit: result.ok ? toCredit(result.value, tenant.currency) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

/** The UUID behind a customer's public ID, or a BAD_USER_INPUT error. */
function customerUuid(id: string): string {
  const uuid = tryFromPublicId(id, 'customer');
  if (!uuid) throw badUserInput(`Invalid customer id: ${id.slice(0, 64)}`);
  return uuid;
}

function toCredit(credit: Credit, currency: CurrencyCode): CustomerCredit {
  const amount = (minor: bigint) => Money.from(money(minor, currency));
  return Object.assign(new CustomerCredit(), {
    creditLimit: credit.creditLimit === null ? null : amount(credit.creditLimit),
    owed: amount(credit.owed),
    overdue: amount(credit.overdue),
  });
}
