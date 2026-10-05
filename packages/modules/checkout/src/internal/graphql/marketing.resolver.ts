import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { MarketingChannelEnum, type MarketingChannelValue } from '@hatti/customers/public';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { CheckoutMarketingService } from '../marketing.service.js';
import { CheckoutMarketingChannelsUpdatePayload } from './marketing.types.js';

const CHANNELS = {
  whatsapp: MarketingChannelEnum.WHATSAPP,
  sms: MarketingChannelEnum.SMS,
  email: MarketingChannelEnum.EMAIL,
} satisfies Record<MarketingChannelValue, MarketingChannelEnum>;

const CHANNEL_VALUES = Object.fromEntries(
  Object.entries(CHANNELS).map(([value, channel]) => [channel, value]),
) as Record<MarketingChannelEnum, MarketingChannelValue>;

@Resolver()
export class CheckoutMarketingResolver {
  constructor(private readonly service: CheckoutMarketingService) {}

  @Query(() => [MarketingChannelEnum], {
    description:
      "The channels the checkout's page offers a box for the shop's news and offers on, each " +
      'unticked until the shopper ticks it (ADR-187): WHATSAPP until the shop chooses.',
  })
  @RequireScopes('read_settings')
  async checkoutMarketingChannels(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<MarketingChannelEnum[]> {
    return (await this.service.get(tenant)).map((channel) => CHANNELS[channel]);
  }

  @Mutation(() => CheckoutMarketingChannelsUpdatePayload, {
    description:
      "Sets the channels the checkout's page offers a box for the shop's news and offers on, " +
      "each once; none for no boxes. A box ticked records the customer's consent on its " +
      'channel as the order is placed, from CHECKOUT.',
  })
  @RequireScopes('write_settings')
  async checkoutMarketingChannelsUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('channels', { type: () => [MarketingChannelEnum] }) channels: MarketingChannelEnum[],
  ): Promise<CheckoutMarketingChannelsUpdatePayload> {
    const result = await this.service.update(
      tenant,
      channels.map((channel) => CHANNEL_VALUES[channel]),
    );
    return Object.assign(new CheckoutMarketingChannelsUpdatePayload(), {
      checkoutMarketingChannels: result.ok
        ? result.value.map((channel) => CHANNELS[channel])
        : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
