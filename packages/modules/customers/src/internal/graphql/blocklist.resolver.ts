import {
  CurrentTenant,
  Loaders,
  RequestLoaders,
  RequireScopes,
  UserError,
  pageSize,
  type TenantContext,
} from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { BlocklistService } from '../blocklist.service.js';
import { CustomerService } from '../customer.service.js';
import type { CustomerRecord } from '../records.js';
import {
  BlocklistAddInput,
  BlocklistAddPayload,
  BlocklistArgs,
  BlocklistEntry,
  BlocklistEntryConnection,
  BlocklistRemovePayload,
  Customer,
} from './customer.types.js';
import {
  cursorAfter,
  toBlockReasonValue,
  toBlocklistEntry,
  toBlocklistEntryConnection,
  toCustomer,
} from './mappers.js';

@Resolver(() => BlocklistEntry)
export class BlocklistResolver {
  constructor(
    private readonly service: BlocklistService,
    private readonly customers: CustomerService,
  ) {}

  @Query(() => BlocklistEntryConnection, {
    description: 'Blocked numbers, most recently blocked first.',
  })
  @RequireScopes('read_customers')
  async blocklist(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: BlocklistArgs,
  ): Promise<BlocklistEntryConnection> {
    const { items, hasNextPage } = await this.service.list(tenant, {
      first: pageSize(args.first),
      after: cursorAfter(args.after),
      query: args.query,
    });
    return toBlocklistEntryConnection(items, hasNextPage);
  }

  @ResolveField(() => Customer, {
    nullable: true,
    description: 'The customer with this number, if it has one.',
  })
  @RequireScopes('read_customers')
  async customer(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() entry: BlocklistEntry,
  ): Promise<Customer | null> {
    const loader = loaders.get<string, CustomerRecord>('customers.byPhone', (phones) =>
      this.customers.byPhones(tenant, phones),
    );
    const record = await loader.load(entry.phone);
    return record ? toCustomer(record) : null;
  }

  @Mutation(() => BlocklistAddPayload, {
    description:
      'Blocks a number: its new orders are held for review. Blocking a number again replaces ' +
      'its reason and note.',
  })
  @RequireScopes('write_customers')
  async blocklistAdd(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: BlocklistAddInput,
  ): Promise<BlocklistAddPayload> {
    const result = await this.service.add(tenant, {
      ...input,
      reason: toBlockReasonValue(input.reason),
    });
    return Object.assign(new BlocklistAddPayload(), {
      blocklistEntry: result.ok ? toBlocklistEntry(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => BlocklistRemovePayload, {
    description: 'Takes a number off the blocklist. Orders already held for review stay held.',
  })
  @RequireScopes('write_customers')
  async blocklistRemove(
    @CurrentTenant() tenant: TenantContext,
    @Args('phone', { description: 'A Pakistani mobile number, in any common format.' })
    phone: string,
  ): Promise<BlocklistRemovePayload> {
    const result = await this.service.remove(tenant, phone);
    return Object.assign(new BlocklistRemovePayload(), {
      deletedBlocklistEntryId: result.ok ? toPublicId('blocklistEntry', result.value.id) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
