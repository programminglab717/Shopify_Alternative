import { CurrentTenant, Money, RequireScopes, badUserInput, type TenantContext } from '@hatti/api';
import { tryFromPublicId } from '@hatti/ids';
import {
  BroadcastChannelEnum,
  BroadcastsService,
  MessageCharges,
  MessageLanguageEnum,
} from '@hatti/messaging/public';
import { money } from '@hatti/money';
import { Args, Field, ID, Int, ObjectType, Query, Resolver } from '@nestjs/graphql';

@ObjectType({
  description:
    'What a broadcast would reach and cost now (MKT-01, ADR-421): "This broadcast to 4,200 ' +
    'customers will cost about Rs 61,000", from the shop\'s message credit as each is sent.',
})
export class BroadcastEstimate {
  @Field(() => Int, {
    description: 'The customers who agreed to hear from the shop on WhatsApp, or by SMS.',
  })
  recipients!: number;

  @Field(() => Int, {
    description:
      "The parts each SMS goes in, as its words, the shop's name and the link to stop need; " +
      'one on WhatsApp.',
  })
  partsPerMessage!: number;

  @Field(() => Money, { description: "A marketing message's price, Hatti's fee in it." })
  pricePerMessage!: Money;

  @Field(() => Money)
  cost!: Money;
}

/**
 * A broadcast's estimate, before it is scheduled: the segment's customers who agreed to hear from
 * the shop on WhatsApp, or by SMS, from messaging, and what a marketing message costs from the
 * shop's credit, from billing (ADR-155): an SMS by its parts (ADR-458). Those who asked the shop to stop are not sent to and not
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
      'who did, would reach and cost now; or an SMS campaign of these words, to those who agreed ' +
      'to hear by SMS (ADR-458).',
  })
  @RequireScopes('read_marketing_events')
  async broadcastEstimate(
    @CurrentTenant() tenant: TenantContext,
    @Args('segmentId', { type: () => ID, nullable: true }) segmentId?: string | null,
    @Args('channel', { type: () => BroadcastChannelEnum, nullable: true })
    channel?: BroadcastChannelEnum | null,
    @Args('text', { type: () => String, nullable: true }) text?: string | null,
    @Args('language', { type: () => MessageLanguageEnum, nullable: true })
    language?: MessageLanguageEnum | null,
  ): Promise<BroadcastEstimate> {
    let uuid: string | null = null;
    if (segmentId) {
      uuid = tryFromPublicId(segmentId, 'segment');
      if (!uuid) throw badUserInput(`Invalid segment id: ${segmentId.slice(0, 64)}`);
    }
    const sms = channel === BroadcastChannelEnum.SMS;
    const recipients = await this.broadcasts.recipientsOf(tenant, uuid, sms ? 'sms' : 'whatsapp');
    if (!recipients.ok) throw badUserInput(recipients.errors[0]!.message);
    const parts =
      sms && text?.trim()
        ? await this.broadcasts.smsPartsOf(
            tenant,
            text,
            language === MessageLanguageEnum.UR ? 'ur' : 'en',
          )
        : 1;
    const price = this.charges.priceOf({
      channel: sms ? 'sms' : 'whatsapp',
      category: 'marketing',
      parts,
    });
    return Object.assign(new BroadcastEstimate(), {
      recipients: recipients.value,
      partsPerMessage: parts,
      pricePerMessage: Money.from(money(price, tenant.currency)),
      cost: Money.from(money(price * BigInt(recipients.value), tenant.currency)),
    });
  }
}
