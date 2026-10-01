import { CurrentTenant, Money, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { money, type CurrencyCode } from '@hatti/money';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { BankTransferService, type BankTransferSettingsRecord } from '../bank-transfer.service.js';
import type { TransferDiscountValue } from '../transfer-discount.js';
import {
  BankTransferSettings,
  BankTransferSettingsInput,
  BankTransferSettingsUpdatePayload,
  TransferDiscount,
  TransferDiscountKind,
} from './bank-transfer.types.js';
import { toBankAccount } from './mappers.js';

@Resolver()
export class BankTransferResolver {
  constructor(private readonly settings: BankTransferService) {}

  @Query(() => BankTransferSettings, {
    description:
      "The shop's bank account for transfers, whether checkout offers them, and what paying so " +
      'takes off.',
  })
  @RequireScopes('read_settings')
  async bankTransferSettings(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<BankTransferSettings> {
    return toBankTransferSettings(await this.settings.get(tenant), tenant.currency);
  }

  @Mutation(() => BankTransferSettingsUpdatePayload, {
    description:
      "Changes the shop's bank account for transfers, turns bank transfer on or off, or " +
      'changes what paying so takes off, for orders placed from now on: orders placed before ' +
      'keep the account they were given, and what was taken off them. Audited with the account ' +
      'and the discount before and after.',
  })
  @RequireScopes('write_settings')
  async bankTransferSettingsUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: BankTransferSettingsInput,
  ): Promise<BankTransferSettingsUpdatePayload> {
    const result = await this.settings.update(tenant, {
      ...(input.enabled !== undefined && input.enabled !== null && { enabled: input.enabled }),
      ...(input.account !== undefined && { account: input.account }),
      ...(input.discount !== undefined && { discount: input.discount }),
    });
    return Object.assign(new BankTransferSettingsUpdatePayload(), {
      bankTransferSettings: result.ok
        ? toBankTransferSettings(result.value, tenant.currency)
        : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function toBankTransferSettings(
  record: BankTransferSettingsRecord,
  currency: CurrencyCode,
): BankTransferSettings {
  return Object.assign(new BankTransferSettings(), {
    enabled: record.enabled,
    account: record.account && toBankAccount(record.account),
    discount: record.discount && toTransferDiscount(record.discount, currency),
    updatedAt: record.updatedAt,
  });
}

function toTransferDiscount(
  discount: TransferDiscountValue,
  currency: CurrencyCode,
): TransferDiscount {
  const amount = (value: bigint) => Money.from(money(value, currency));
  return Object.assign(
    new TransferDiscount(),
    discount.kind === 'percentage'
      ? {
          kind: TransferDiscountKind.PERCENTAGE,
          percentage: discount.percentageBps / 100,
          cap: discount.cap === null ? null : amount(discount.cap),
          amount: null,
        }
      : {
          kind: TransferDiscountKind.FIXED_AMOUNT,
          percentage: null,
          cap: null,
          amount: amount(discount.amount),
        },
  );
}
