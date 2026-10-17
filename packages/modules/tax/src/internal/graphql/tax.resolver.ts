import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { TaxSettingsService } from '../tax-settings.service.js';
import {
  taxGuidance,
  withholdingRates,
  type FilerStatus as FilerStatusValue,
  type TaxProvince as TaxProvinceValue,
  type TaxSettingsRecord,
} from '../tax.js';
import {
  FilerStatus,
  TaxCategory,
  TaxGuidanceCode,
  TaxGuidanceStatus,
  TaxProvince,
  TaxSettings,
  TaxSettingsUpdateInput,
  TaxSettingsUpdatePayload,
} from './tax.types.js';

@Resolver(() => TaxSettings)
export class TaxSettingsResolver {
  constructor(private readonly service: TaxSettingsService) {}

  @Query(() => TaxSettings, {
    description: 'The sales tax the shop charges, included in its prices.',
  })
  @RequireScopes('read_settings')
  async taxSettings(@CurrentTenant() tenant: TenantContext): Promise<TaxSettings> {
    return toTaxSettings(await this.service.get(tenant));
  }

  @Mutation(() => TaxSettingsUpdatePayload, {
    description:
      'Changes the sales tax the shop charges, for orders placed from now on: those placed ' +
      'keep theirs. Those not given stay as they are.',
  })
  @RequireScopes('write_settings')
  async taxSettingsUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: TaxSettingsUpdateInput,
  ): Promise<TaxSettingsUpdatePayload> {
    const result = await this.service.update(tenant, {
      ...input,
      province:
        input.province === undefined
          ? undefined
          : input.province && (input.province.toLowerCase() as TaxProvinceValue),
      filerStatus: input.filerStatus && (input.filerStatus.toLowerCase() as FilerStatusValue),
    });
    return Object.assign(new TaxSettingsUpdatePayload(), {
      taxSettings: result.ok ? toTaxSettings(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function toTaxSettings(record: TaxSettingsRecord): TaxSettings {
  return Object.assign(new TaxSettings(), {
    rate: record.rate === null ? null : record.rate / 100,
    taxDelivery: record.taxDelivery,
    categories: record.categories.map((category) =>
      Object.assign(new TaxCategory(), { ...category, rate: category.rate / 100 }),
    ),
    ntn: record.ntn,
    strn: record.strn,
    province: record.province && (record.province.toUpperCase() as TaxProvince),
    filerStatus: record.filerStatus.toUpperCase() as FilerStatus,
    tier1: record.tier1,
    withholding: (() => {
      const rates = withholdingRates(record.filerStatus);
      return { digitalPercent: rates.digital, cashOnDeliveryPercent: rates.cashOnDelivery };
    })(),
    guidance: taxGuidance(record).map((step) => ({
      code: step.code.toUpperCase() as TaxGuidanceCode,
      status: step.status.toUpperCase() as TaxGuidanceStatus,
    })),
    updatedAt: record.updatedAt,
  });
}
