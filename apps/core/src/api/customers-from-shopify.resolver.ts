import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { AccountService } from '@hatti/checkout/public';
import { CustomerTransferService, TRANSFER_LIMITS } from '@hatti/customers/public';
import { parsePkMobile } from '@hatti/pk';
import { readStoreCustomers, storeCustomersCsv, type StoreCustomer } from '@hatti/shopify-admin';
import type { AccountAddressRequest } from '@hatti/storefront-api';
import { Args, Field, Int, Mutation, ObjectType, Resolver } from '@nestjs/graphql';
import { ShopifyStores, storeGiven, storeRefusalOf } from './shopify-stores.js';

/** Customers a file holds at first: well within the customer import's rows. */
const CHUNK = 2_000;

@ObjectType({ description: "A store's customer that did not go in, and why." })
export class StoreCustomerImportError {
  @Field({ description: "The customer's name at the store, or its email or number." })
  customer!: string;

  @Field()
  message!: string;
}

@ObjectType()
export class CustomersImportFromShopifyPayload {
  @Field(() => Int, { description: 'Customers the store has with a phone number.' })
  customers!: number;

  @Field(() => Int, {
    description:
      'Customers the store has with no phone number, left out: the shop finds its customers ' +
      'by their mobile numbers.',
  })
  withoutPhone!: number;

  @Field(() => Int, { description: 'Customers made, or that would be in a dry run.' })
  created!: number;

  @Field(() => Int, { description: 'Customers already here, left as they were.' })
  skipped!: number;

  @Field(() => Int, { description: 'Customers that could not go in; the first are named.' })
  customerErrorCount!: number;

  @Field(() => [StoreCustomerImportError])
  customerErrors!: StoreCustomerImportError[];

  @Field(() => Int, {
    description:
      "Customers' addresses in Pakistan kept in their address books (ADR-784); none in a dry run.",
  })
  addresses!: number;

  @Field(() => [StoreCustomerImportError], {
    description: 'Addresses that could not be kept, and why; the first are named.',
  })
  addressErrors!: StoreCustomerImportError[];

  @Field()
  dryRun!: boolean;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

/**
 * A Shopify store's customers through its Admin API (ONB-05, ADR-755): written as Shopify's own
 * customer export, which the customer import takes as it takes the file, a few thousand at a
 * time; each problem named by the customer's name.
 */
@Resolver()
export class CustomersFromShopifyResolver {
  constructor(
    private readonly transfers: CustomerTransferService,
    private readonly accounts: AccountService,
    private readonly shopify: ShopifyStores,
  ) {}

  @Mutation(() => CustomersImportFromShopifyPayload, {
    description:
      "Imports a Shopify store's customers through its Admin API (ONB-05, ADR-755) as " +
      "customersImport takes Shopify's customer export: each by its mobile number, with its " +
      'name, email, note, tags, and email and SMS marketing consent as the store had them. ' +
      'Customers with no phone number are counted and left out; customers already here are ' +
      "left as they are. Each customer's addresses in Pakistan go into their address book, " +
      'the default as it was, where the book has none yet (ADR-784). Give the store and its app as productsImportFromShopify takes them; ' +
      "the app needs the read_customers access scope and Shopify's leave to read customers' " +
      'names, emails, phones and addresses. Nothing given is kept. dryRun reads the store and ' +
      'counts, changing nothing.',
  })
  @RequireScopes('write_customers')
  async customersImportFromShopify(
    @CurrentTenant() tenant: TenantContext,
    @Args('store', {
      description:
        "The store's address at Shopify, as zari.myshopify.com, its name, or a link to its admin.",
    })
    store: string,
    @Args('accessToken', { nullable: true }) accessToken?: string,
    @Args('clientId', { nullable: true }) clientId?: string,
    @Args('clientSecret', { nullable: true }) clientSecret?: string,
    @Args('dryRun', { nullable: true }) dryRun?: boolean,
  ): Promise<CustomersImportFromShopifyPayload> {
    const dry = dryRun ?? false;
    const payload = (values: Partial<CustomersImportFromShopifyPayload>) =>
      Object.assign(new CustomersImportFromShopifyPayload(), {
        customers: 0,
        withoutPhone: 0,
        created: 0,
        skipped: 0,
        customerErrorCount: 0,
        customerErrors: [],
        addresses: 0,
        addressErrors: [],
        dryRun: dry,
        userErrors: [],
        ...values,
      });
    const refused = (refusal: { field: string[] | null; code: string; message: string }) =>
      payload({ userErrors: [UserError.of(refusal.field, refusal.code, refusal.message)] });

    const given = storeGiven(store, accessToken, clientId, clientSecret);
    if (!given.ok) return refused(given);
    const read = await readStoreCustomers(
      this.shopify.connect(given.shop, given.credentials),
      this.shopify.bulk,
    );
    if (!read.ok) return refused(storeRefusalOf(read));
    const { storeName, customers, withoutPhone } = read.value;
    if (customers.length === 0) {
      return refused({
        field: ['store'],
        code: 'BLANK',
        message:
          withoutPhone > 0
            ? `${storeName}'s customers have no phone numbers, which the shop finds them by`
            : `${storeName} has no customers`,
      });
    }

    const totals = { created: 0, skipped: 0, customerErrorCount: 0 };
    const customerErrors: StoreCustomerImportError[] = [];
    for (const chunk of chunksOf(customers)) {
      const { csv, rowNames } = storeCustomersCsv(chunk);
      const result = await this.transfers.import(tenant, csv, { dryRun: dry, overwrite: false });
      if (!result.ok) {
        const error = result.errors[0];
        return refused({
          field: ['store'],
          code: error?.code ?? 'INVALID',
          message: error?.message ?? `${storeName}'s customers could not be read`,
        });
      }
      totals.created += result.value.created;
      totals.skipped += result.value.skipped;
      totals.customerErrorCount += result.value.rowErrorCount;
      for (const error of result.value.rowErrors) {
        if (customerErrors.length >= TRANSFER_LIMITS.rowErrors) break;
        customerErrors.push(
          Object.assign(new StoreCustomerImportError(), {
            customer: rowNames[error.row - 2] ?? `row ${error.row}`,
            message: error.message,
          }),
        );
      }
    }
    if (dry)
      return payload({ customers: customers.length, withoutPhone, ...totals, customerErrors });
    const brought = await this.accounts.bringAddresses(tenant.shopId, customers.map(bookOf));
    const addressErrors = brought.problems
      .slice(0, TRANSFER_LIMITS.rowErrors)
      .map(({ book, message }) =>
        Object.assign(new StoreCustomerImportError(), {
          customer: nameOf(customers[book]!),
          message: `An address was not kept: ${message}`,
        }),
      );
    return payload({
      customers: customers.length,
      withoutPhone,
      ...totals,
      customerErrors,
      addresses: brought.added,
      addressErrors,
    });
  }
}

/** The customer's name at the store, or their email or number. */
function nameOf(customer: StoreCustomer): string {
  return (
    [customer.firstName, customer.lastName].filter(Boolean).join(' ') ||
    customer.email ||
    customer.phone
  );
}

/**
 * The customer's addresses in Pakistan as their address book takes them (ADR-784): each named
 * and reached as its own says, else as the customer is.
 */
function bookOf(customer: StoreCustomer): {
  phone: string;
  addresses: AccountAddressRequest[];
} {
  return {
    phone: customer.phone,
    addresses: customer.addresses
      .filter((address) => (address.countryCode ?? 'PK') === 'PK')
      .map((address) => ({
        name: address.name ?? nameOf(customer),
        phone: address.phone && parsePkMobile(address.phone) ? address.phone : customer.phone,
        address1: address.address1 ?? '',
        address2: address.address2,
        city: address.city ?? '',
        province: address.province,
        zip: address.zip,
        default: address.isDefault,
      })),
  };
}

/** The customers in files the customer import takes: fewer rows where one would be too long. */
function* chunksOf(customers: readonly StoreCustomer[]): Generator<StoreCustomer[]> {
  for (let at = 0; at < customers.length;) {
    let size = Math.min(CHUNK, customers.length - at);
    while (
      size > 1 &&
      storeCustomersCsv(customers.slice(at, at + size)).csv.length > TRANSFER_LIMITS.csv
    ) {
      size = Math.ceil(size / 2);
    }
    yield customers.slice(at, at + size);
    at += size;
  }
}
