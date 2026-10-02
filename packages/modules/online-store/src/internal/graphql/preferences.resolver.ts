import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { PreferencesService, type PreferencesView } from '../preferences.service.js';
import { uuidOf } from './mappers.js';
import {
  LinkPage,
  OnlineStorePreferences,
  OnlineStorePreferencesInput,
  OnlineStorePreferencesUpdatePayload,
} from './preferences.types.js';

@Resolver(() => OnlineStorePreferences)
export class PreferencesResolver {
  constructor(private readonly service: PreferencesService) {}

  @Query(() => OnlineStorePreferences, {
    description:
      'What the shop sets for its storefront as a whole, such as its WhatsApp number and ' +
      'password.',
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
    const { linkPage, ...rest } = input;
    const result = await this.service.update(tenant, {
      ...rest,
      ...(linkPage && {
        linkPage: {
          ...linkPage,
          productIds: linkPage.productIds?.map((id) => uuidOf('product', id)),
        },
      }),
    });
    return Object.assign(new OnlineStorePreferencesUpdatePayload(), {
      preferences: result.ok ? toPreferences(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function toPreferences(view: PreferencesView): OnlineStorePreferences {
  return Object.assign(new OnlineStorePreferences(), {
    whatsappNumber: view.whatsappNumber,
    passwordEnabled: view.passwordEnabled,
    password: view.password,
    passwordMessage: view.passwordMessage,
    robotsTxtRules: view.robotsTxtRules,
    linkPage: Object.assign(new LinkPage(), {
      bio: view.linkPage.bio,
      links: view.linkPage.links,
      productIds: view.linkPage.productIds.map((id) => toPublicId('product', id)),
    }),
  });
}
