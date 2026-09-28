import {
  CurrentTenant,
  Loaders,
  RequestLoaders,
  RequireScopes,
  UserError,
  pageSize,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { BlocklistService } from '../blocklist.service.js';
import { CustomerDataService } from '../customer-data.service.js';
import { CustomerService } from '../customer.service.js';
import type { BlocklistEntryRecord, CustomerRecord } from '../records.js';
import type { MarketingConsentInput as ConsentInput } from '../consent.js';
import {
  BlocklistEntry,
  ConsentEventConnection,
  ConsentHistoryArgs,
  Customer,
  CustomerConnection,
  CustomerCreateInput,
  CustomerCreatePayload,
  CustomerErasePayload,
  CustomerMarketingConsentUpdatePayload,
  CustomerMergePayload,
  CustomerUpdateInput,
  CustomerUpdatePayload,
  CustomersArgs,
  MarketingConsentInput,
} from './customer.types.js';
import {
  cursorAfter,
  toBlocklistEntry,
  toConsentEventConnection,
  toConsentSourceValue,
  toCustomer,
  toCustomerConnection,
  toMarketingStateValue,
  uuidOf,
} from './mappers.js';

function toConsentInputs(inputs: MarketingConsentInput[]): ConsentInput[] {
  return inputs.map((input) => ({
    channel: input.channel.toLowerCase() as ConsentInput['channel'],
    state: toMarketingStateValue(input.marketingState),
    wording: input.wording,
    source: input.source ? toConsentSourceValue(input.source) : null,
    collectedAt: input.collectedAt,
  }));
}

type Payload = { customer: Customer | null; userErrors: UserError[] };

function payload<T extends Payload>(type: new () => T, result: MutationResult<CustomerRecord>): T {
  return Object.assign(new type(), {
    customer: result.ok ? toCustomer(result.value) : null,
    userErrors: result.ok ? [] : UserError.list(result.errors),
  });
}

@Resolver(() => Customer)
export class CustomerResolver {
  constructor(
    private readonly service: CustomerService,
    private readonly blocklist: BlocklistService,
    private readonly data: CustomerDataService,
  ) {}

  /** Every number of the customer, the main one first. */
  #numbers(tenant: TenantContext, loaders: RequestLoaders, customer: Customer): Promise<string[]> {
    const loader = loaders.get<string, string[]>('customers.phones', (ids) =>
      this.service.phonesOf(tenant, ids),
    );
    return loader.load(customer.uuid).then((numbers) => numbers ?? [customer.phone]);
  }

  @Query(() => Customer, { nullable: true, description: 'A customer by ID, or null if not found.' })
  @RequireScopes('read_customers')
  async customer(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<Customer | null> {
    const record = await this.service.get(tenant, uuidOf('customer', id));
    return record ? toCustomer(record) : null;
  }

  @Query(() => CustomerConnection, { description: 'Customers, newest first.' })
  @RequireScopes('read_customers')
  async customers(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: CustomersArgs,
  ): Promise<CustomerConnection> {
    const { items, hasNextPage } = await this.service.list(tenant, {
      first: pageSize(args.first),
      after: cursorAfter(args.after),
      query: args.query,
    });
    return toCustomerConnection(items, hasNextPage);
  }

  @ResolveField(() => [String], {
    description:
      "Their other numbers, E.164, such as a merged duplicate's. Orders from any of them find " +
      'this customer; marketing goes only to their main number.',
  })
  async otherPhones(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() customer: Customer,
  ): Promise<string[]> {
    return (await this.#numbers(tenant, loaders, customer)).slice(1);
  }

  @ResolveField(() => BlocklistEntry, {
    nullable: true,
    description:
      'The blocklist entry of their main number, or else of another of theirs, if one is blocked.',
  })
  @RequireScopes('read_customers')
  async blocklistEntry(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() customer: Customer,
  ): Promise<BlocklistEntry | null> {
    const loader = loaders.get<string, BlocklistEntryRecord>(
      'customers.blocklistByPhone',
      (phones) => this.blocklist.entriesOf(tenant, phones),
    );
    const numbers = await this.#numbers(tenant, loaders, customer);
    const entries = await Promise.all(numbers.map((number) => loader.load(number)));
    const record = entries.find((entry) => entry !== undefined && entry !== null);
    return record ? toBlocklistEntry(record) : null;
  }

  @Mutation(() => CustomerCreatePayload, {
    description:
      'Adds a customer before they order. Orders add their customers themselves, by mobile number.',
  })
  @RequireScopes('write_customers')
  async customerCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: CustomerCreateInput,
  ): Promise<CustomerCreatePayload> {
    return payload(
      CustomerCreatePayload,
      await this.service.create(tenant, {
        ...input,
        marketingConsent: input.marketingConsent ? toConsentInputs(input.marketingConsent) : null,
      }),
    );
  }

  @Mutation(() => CustomerUpdatePayload, {
    description: "Changes a customer's number, name, email, note or tags.",
  })
  @RequireScopes('write_customers')
  async customerUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: CustomerUpdateInput,
  ): Promise<CustomerUpdatePayload> {
    return payload(
      CustomerUpdatePayload,
      await this.service.update(tenant, uuidOf('customer', id), input),
    );
  }

  @Mutation(() => CustomerMarketingConsentUpdatePayload, {
    description:
      'Records that a customer agreed to marketing on some channels, or withdrew, with what they ' +
      'agreed to, where and when. Each change goes into the consent ledger.',
  })
  @RequireScopes('write_customers')
  async customerMarketingConsentUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('marketingConsent', { type: () => [MarketingConsentInput] })
    marketingConsent: MarketingConsentInput[],
  ): Promise<CustomerMarketingConsentUpdatePayload> {
    return payload(
      CustomerMarketingConsentUpdatePayload,
      await this.service.updateMarketingConsent(
        tenant,
        uuidOf('customer', id),
        toConsentInputs(marketingConsent),
      ),
    );
  }

  @Mutation(() => CustomerMergePayload, {
    description:
      "Merges a duplicate into a customer: the duplicate's numbers, orders, tags, note and " +
      "consent history become the customer's, and the duplicate is deleted. Where both have a " +
      "name or an email, the customer's stays. Cannot be undone.",
  })
  @RequireScopes('write_customers')
  async customerMerge(
    @CurrentTenant() tenant: TenantContext,
    @Args('customerId', { type: () => ID, description: 'The customer to keep.' })
    customerId: string,
    @Args('duplicateId', { type: () => ID, description: 'The customer to merge in and delete.' })
    duplicateId: string,
  ): Promise<CustomerMergePayload> {
    return payload(
      CustomerMergePayload,
      await this.data.merge(
        tenant,
        uuidOf('customer', customerId),
        uuidOf('customer', duplicateId),
      ),
    );
  }

  @Mutation(() => CustomerErasePayload, {
    description:
      "Erases a customer's personal data at their request: their profile, numbers and consent " +
      "history are deleted, and their orders keep only what the shop's accounts need, without " +
      'their name, number, email or street. Their orders must be closed or cancelled first. ' +
      'Cannot be undone.',
  })
  @RequireScopes('write_customers')
  async customerErase(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<CustomerErasePayload> {
    const result = await this.data.erase(tenant, uuidOf('customer', id));
    return Object.assign(new CustomerErasePayload(), {
      erasedCustomerId: result.ok ? toPublicId('customer', result.value.id) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @ResolveField(() => ConsentEventConnection, {
    description: 'Every change of their marketing consent, newest first.',
  })
  @RequireScopes('read_customers')
  async consentHistory(
    @CurrentTenant() tenant: TenantContext,
    @Parent() customer: Customer,
    @Args() args: ConsentHistoryArgs,
  ): Promise<ConsentEventConnection> {
    const { items, hasNextPage } = await this.service.consentHistory(tenant, customer.uuid, {
      first: pageSize(args.first),
      after: cursorAfter(args.after),
    });
    return toConsentEventConnection(items, hasNextPage);
  }
}
