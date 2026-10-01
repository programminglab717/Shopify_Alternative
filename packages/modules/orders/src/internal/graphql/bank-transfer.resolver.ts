import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { BankTransferService, type BankTransferSettingsRecord } from '../bank-transfer.service.js';
import {
  BankTransferSettings,
  BankTransferSettingsInput,
  BankTransferSettingsUpdatePayload,
} from './bank-transfer.types.js';
import { toBankAccount } from './mappers.js';

@Resolver()
export class BankTransferResolver {
  constructor(private readonly settings: BankTransferService) {}

  @Query(() => BankTransferSettings, {
    description: "The shop's bank account for transfers, and whether checkout offers them.",
  })
  @RequireScopes('read_settings')
  async bankTransferSettings(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<BankTransferSettings> {
    return toBankTransferSettings(await this.settings.get(tenant));
  }

  @Mutation(() => BankTransferSettingsUpdatePayload, {
    description:
      "Changes the shop's bank account for transfers, or turns bank transfer on or off, for " +
      'orders placed from now on: orders placed before keep the account they were given. ' +
      'Audited with the account before and after.',
  })
  @RequireScopes('write_settings')
  async bankTransferSettingsUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: BankTransferSettingsInput,
  ): Promise<BankTransferSettingsUpdatePayload> {
    const result = await this.settings.update(tenant, {
      ...(input.enabled !== undefined && input.enabled !== null && { enabled: input.enabled }),
      ...(input.account !== undefined && { account: input.account }),
    });
    return Object.assign(new BankTransferSettingsUpdatePayload(), {
      bankTransferSettings: result.ok ? toBankTransferSettings(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function toBankTransferSettings(record: BankTransferSettingsRecord): BankTransferSettings {
  return Object.assign(new BankTransferSettings(), {
    enabled: record.enabled,
    account: record.account && toBankAccount(record.account),
    updatedAt: record.updatedAt,
  });
}
