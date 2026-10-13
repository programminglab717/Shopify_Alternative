import { CurrentTenant, Money, RequireScopes, badUserInput, type TenantContext } from '@hatti/api';
import { tryFromPublicId } from '@hatti/ids';
import { BroadcastsService, MessageCharges } from '@hatti/messaging/public';
import { money } from '@hatti/money';
import { Args, Field, ID, Int, ObjectType, Query, Resolver } from '@nestjs/graphql';

@ObjectType({
  description:
    'What a broadcast would reach and cost now (MKT-01, ADR-421): "This broadcast to 4,200 ' +
    'customers will cost about Rs 61,000", from the shop\'s message credit as each is sent.',
})
export class BroadcastEstimate {
  @Field(() => Int, { description: 'The customers who agreed to hear from the shop on WhatsApp.' })
  recipients!: number;

  @Field(() => Money, { description: "A marketing message's price, Hatti's fee in it." })
  pricePerMessage!: Money;

  @Field(() => Money)
  cost!: Money;
}

/**
 * A broadcast's estimate, before it is scheduled: the segment's customers who agreed to hear from
 * the shop on WhatsApp, from messaging, and what a marketing message costs from the shop's
 * credit, from billing (ADR-155). Those who asked the shop to stop are not sent to and not
 * charged, so the estimate is at most what is spent.
 */
@Resolver()
export class BroadcastEstimateResolver {
  constructor(
    private readonly broadcasts: BroadcastsService,
    private readonly charges: MessageCharges,
  ) {}

  @Query(() => BroadcastEstimate, {
    description:
      "What a broadcast to the segment's customers who agreed to hear on WhatsApp, or to all " +
      'who did, would reach and cost now.',
  })
  @RequireScopes('read_marketing_events')
  async broadcastEstimate(
    @CurrentTenant() tenant: TenantContext,
    @Args('segmentId', { type: () => ID, nullable: true }) segmentId?: string | null,
  ): Promise<BroadcastEstimate> {
    let uuid: string | null = null;
    if (segmentId) {
      uuid = tryFromPublicId(segmentId, 'segment');
      if (!uuid) throw badUserInput(`Invalid segment id: ${segmentId.slice(0, 64)}`);
    }
    const recipients = await this.broadcasts.recipientsOf(tenant, uuid);
    if (!recipients.ok) throw badUserInput(recipients.errors[0]!.message);
    const price = this.charges.priceOf({ channel: 'whatsapp', category: 'marketing', parts: 1 });
    return Object.assign(new BroadcastEstimate(), {
      recipients: recipients.value,
      pricePerMessage: Money.from(money(price, tenant.currency)),
      cost: Money.from(money(price * BigInt(recipients.value), tenant.currency)),
    });
  }
}
