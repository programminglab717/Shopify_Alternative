import {
  CurrentTenant,
  Loaders,
  RequestLoaders,
  RequireScopes,
  type TenantContext,
} from '@hatti/api';
import { Customer } from '@hatti/customers/public';
import { hidesPhones, MailingAddress, toAddress } from '@hatti/orders/public';
import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import type { AccountAddressRecord } from '../account-addresses.js';
import { AccountService } from '../account.service.js';

/**
 * What the customers module's Customer type shows of the address book a shopper keeps with their
 * account (CUS-02, ADR-588): read when asked for, one query per page of customers, a phone hidden
 * from staff who may not see numbers as the orders' addresses are.
 */
@Resolver(() => Customer)
export class CustomerAddressesResolver {
  constructor(private readonly accounts: AccountService) {}

  async #book(
    tenant: TenantContext,
    loaders: RequestLoaders,
    customer: Customer,
  ): Promise<AccountAddressRecord[]> {
    const loader = loaders.get<string, AccountAddressRecord[]>('checkout.addressBooks', (ids) =>
      this.accounts.addressBooks(tenant.shopId, ids),
    );
    return (await loader.load(customer.uuid)) ?? [];
  }

  @ResolveField(() => [MailingAddress], {
    description:
      'The addresses they saved with their account on the storefront, the default first, then the latest changed.',
  })
  @RequireScopes('read_customers')
  async savedAddresses(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() customer: Customer,
  ): Promise<MailingAddress[]> {
    const book = await this.#book(tenant, loaders, customer);
    return book.map((record) => toAddress(record.address, hidesPhones(tenant)));
  }

  @ResolveField(() => MailingAddress, {
    nullable: true,
    description: 'The address they chose as their default on the storefront, if they saved any.',
  })
  @RequireScopes('read_customers')
  async defaultAddress(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() customer: Customer,
  ): Promise<MailingAddress | null> {
    const book = await this.#book(tenant, loaders, customer);
    const chosen = book.find((record) => record.isDefault);
    return chosen ? toAddress(chosen.address, hidesPhones(tenant)) : null;
  }
}
