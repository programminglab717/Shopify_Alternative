import { CurrentTenant, RequireScopes, SEO, UserError, type TenantContext } from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { PreferencesService, type PreferencesView } from '../preferences.service.js';
import { uuidOf } from './mappers.js';
import {
  LinkPage,
  LinkPageProduct,
  OnlineStorePreferences,
  OnlineStorePreferencesInput,
  OnlineStorePreferencesUpdatePayload,
  SharingImage,
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
    const { linkPage, sharingImage, ...rest } = input;
    const result = await this.service.update(tenant, {
      ...rest,
      ...(sharingImage !== undefined && {
        sharingImage: sharingImage && {
          fileId: uuidOf('file', sharingImage.fileId),
          altText: sharingImage.altText,
        },
      }),
      ...(linkPage && {
        linkPage: {
          ...linkPage,
          productIds: linkPage.productIds?.map((id) => uuidOf('product', id)),
          products: linkPage.products?.map((each) => ({
            productId: uuidOf('product', each.productId),
            variantId: each.variantId ? uuidOf('variant', each.variantId) : null,
          })),
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
      products: view.linkPage.productIds.map((id, index) => {
        const variantId = view.linkPage.variantIds[index] ?? null;
        return Object.assign(new LinkPageProduct(), {
          productId: toPublicId('product', id),
          variantId: variantId && toPublicId('variant', variantId),
        });
      }),
    }),
    seo: Object.assign(new SEO(), view.seo),
    sharingImage:
      view.sharingImage &&
      Object.assign(new SharingImage(), {
        fileId: toPublicId('file', view.sharingImage.fileId),
        altText: view.sharingImage.altText || null,
      }),
  });
}
