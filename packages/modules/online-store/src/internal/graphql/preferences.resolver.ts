import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { PreferencesService } from '../preferences.service.js';
import type { PreferencesRecord } from '../records.js';
import {
  OnlineStorePreferences,
  OnlineStorePreferencesInput,
  OnlineStorePreferencesUpdatePayload,
} from './preferences.types.js';

@Resolver(() => OnlineStorePreferences)
export class PreferencesResolver {
  constructor(private readonly service: PreferencesService) {}

  @Query(() => OnlineStorePreferences, {
    description: 'What the shop sets for its storefront as a whole, such as its WhatsApp number.',
  })
  @RequireScopes('read_settings')
  async onlineStorePreferences(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<OnlineStorePreferences> {
    return toPreferences(await this.service.get(tenant));
  }

  @Mutation(() => OnlineStorePreferencesUpdatePayload, {
    description:
      'Changes what the shop sets for its storefront as a whole; the storefront shows it a ' +
      'moment later. Those not given stay as they are.',
  })
  @RequireScopes('write_settings')
  async onlineStorePreferencesUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: OnlineStorePreferencesInput,
  ): Promise<OnlineStorePreferencesUpdatePayload> {
    const result = await this.service.update(tenant, input);
    return Object.assign(new OnlineStorePreferencesUpdatePayload(), {
      preferences: result.ok ? toPreferences(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function toPreferences(record: PreferencesRecord): OnlineStorePreferences {
  return Object.assign(new OnlineStorePreferences(), { whatsappNumber: record.whatsappNumber });
}
