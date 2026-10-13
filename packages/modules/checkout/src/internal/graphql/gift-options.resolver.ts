import {
  CurrentTenant,
  Money,
  RequireScopes,
  UserError,
  badUserInput,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { money, type CurrencyCode } from '@hatti/money';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { GiftOptionsService, type GiftWrap } from '../gift-options.service.js';
import {
  CheckoutGiftOptions,
  CheckoutGiftOptionsInput,
  CheckoutGiftOptionsUpdatePayload,
  CheckoutGiftWrap,
} from './gift-options.types.js';

@Resolver()
export class GiftOptionsResolver {
  constructor(private readonly service: GiftOptionsService) {}

  @Query(() => CheckoutGiftOptions, {
    description:
      "The gift wrap the checkout's page offers to add, and whether it asks for a gift message " +
      '(CHK-16, ADR-413): neither until the shop chooses.',
  })
  @RequireScopes('read_settings')
  async checkoutGiftOptions(@CurrentTenant() tenant: TenantContext): Promise<CheckoutGiftOptions> {
    return toGiftOptions(await this.service.get(tenant), tenant.currency);
  }

  @Mutation(() => CheckoutGiftOptionsUpdatePayload, {
    description:
      'Sets the variant sold as gift wrap, null for none, and whether checkout asks for a gift ' +
      'message.',
  })
  @RequireScopes('write_settings')
  async checkoutGiftOptionsUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: CheckoutGiftOptionsInput,
  ): Promise<CheckoutGiftOptionsUpdatePayload> {
    const wrapVariantId = input.wrapVariantId
      ? tryFromPublicId(input.wrapVariantId, 'variant')
      : null;
    if (input.wrapVariantId && !wrapVariantId) {
      throw badUserInput(`Invalid variant id: ${input.wrapVariantId.slice(0, 64)}`);
    }
    const result = await this.service.update(tenant, {
      wrapVariantId,
      messages: input.messages,
    });
    return Object.assign(new CheckoutGiftOptionsUpdatePayload(), {
      checkoutGiftOptions: result.ok ? toGiftOptions(result.value, tenant.currency) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function toGiftOptions(
  options: { wrap: GiftWrap | null; messages: boolean },
  currency: CurrencyCode,
): CheckoutGiftOptions {
  return Object.assign(new CheckoutGiftOptions(), {
    wrap:
      options.wrap &&
      Object.assign(new CheckoutGiftWrap(), {
        variantId: toPublicId('variant', options.wrap.variantId),
        productTitle: options.wrap.productTitle,
        variantTitle: options.wrap.variantTitle,
        price: Money.from(money(options.wrap.price, currency)),
        forSale: options.wrap.forSale,
      }),
    messages: options.messages,
  });
}
