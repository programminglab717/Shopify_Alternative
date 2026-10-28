import { CurrentTenant, RequireScopes, type TenantContext } from '@hatti/api';
import { Args, Field, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { VoiceOrderService } from '../voice-orders.service.js';

@ObjectType({
  description:
    "Voice-note orders (MSG-11, ADR-871): whether customers' WhatsApp voice notes are heard by " +
    "Hatti's own speech-to-text server, read by the AI into what they order, and answered with " +
    "the shop's checkout holding it. Each voice note read is one of the shop's AI credits; staff " +
    'read what was heard in the inbox.',
})
export class VoiceOrders {
  @Field({ description: 'Whether the shop turned it on.' })
  enabled!: boolean;

  @Field({ description: 'Whether Hatti hears voice notes here: false until it is set up.' })
  available!: boolean;

  @Field(() => Int, { description: 'Voice notes heard in the last day.' })
  usedToday!: number;

  @Field(() => Int, { description: 'Voice notes a shop has heard a day at most.' })
  limitPerDay!: number;
}

@Resolver(() => VoiceOrders)
export class VoiceOrderResolver {
  constructor(private readonly service: VoiceOrderService) {}

  @Query(() => VoiceOrders, { description: 'Whether the shop takes orders by voice note.' })
  @RequireScopes('read_settings')
  async voiceOrders(@CurrentTenant() tenant: TenantContext): Promise<VoiceOrders> {
    return Object.assign(new VoiceOrders(), await this.service.setting(tenant));
  }

  @Mutation(() => VoiceOrders, {
    description:
      'Turns hearing customers’ voice notes on or off. Each voice note read spends one of the ' +
      'shop’s AI credits.',
  })
  @RequireScopes('write_settings')
  async voiceOrdersSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('enabled') enabled: boolean,
  ): Promise<VoiceOrders> {
    return Object.assign(new VoiceOrders(), await this.service.set(tenant, enabled));
  }
}
