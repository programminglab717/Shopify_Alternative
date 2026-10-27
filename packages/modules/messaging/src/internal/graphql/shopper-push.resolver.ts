import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import {
  Args,
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  Mutation,
  ObjectType,
  Query,
  Resolver,
  registerEnumType,
} from '@nestjs/graphql';
import {
  SHOPPER_PUSH_LIMITS,
  ShopperPushService,
  type PushCampaignRecord,
} from '../shopper-push.service.js';

export enum PushCampaignStatus {
  SENDING = 'SENDING',
  SENT = 'SENT',
}

registerEnumType(PushCampaignStatus, {
  name: 'PushCampaignStatus',
  description:
    'SENDING while the worker pushes it, in marketing hours; SENT once every browser was tried.',
});

@ObjectType({
  description: "A push the shop sent to shoppers' browsers with notifications on (OS-14, ADR-834).",
})
export class PushCampaign {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;

  @Field()
  body!: string;

  @Field({ description: 'The page of the shop it opens: "/collections/eid".' })
  path!: string;

  @Field(() => PushCampaignStatus)
  status!: PushCampaignStatus;

  @Field(() => Int, { description: 'Browsers whose push service took it.' })
  sent!: number;

  @Field(() => Int, { description: 'Browsers it failed to reach, tried again next time.' })
  failed!: number;

  @Field(() => Int, { description: 'Browsers whose notifications were off, forgotten.' })
  gone!: number;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  sentAt!: Date | null;
}

@ObjectType({ description: "The shop's pushes to shoppers (OS-14, ADR-833, ADR-834)." })
export class ShopperPushes {
  @Field({ description: 'Whether Hatti pushes at all: false until it has its VAPID keys.' })
  available!: boolean;

  @Field(() => Int, { description: 'Browsers with notifications on for the shop.' })
  subscribers!: number;

  @Field(() => Int, { description: 'Campaigns a shop may send in a day.' })
  perDay!: number;

  @Field(() => [PushCampaign], { description: 'The latest campaigns, the newest first.' })
  campaigns!: PushCampaign[];
}

@InputType()
export class PushCampaignInput {
  @Field({ description: `Up to ${SHOPPER_PUSH_LIMITS.title} characters.` })
  title!: string;

  @Field({ description: `Up to ${SHOPPER_PUSH_LIMITS.body} characters.` })
  body!: string;

  @Field(() => String, {
    nullable: true,
    description:
      'A page of the shop, from its root: "/collections/eid"; its home page if left out.',
  })
  path?: string | null;
}

@ObjectType()
export class PushCampaignSendPayload {
  @Field(() => PushCampaign, { nullable: true })
  campaign!: PushCampaign | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

const toCampaign = (record: PushCampaignRecord): PushCampaign =>
  Object.assign(new PushCampaign(), {
    ...record,
    id: toPublicId('pushCampaign', record.id),
    status: record.status === 'sent' ? PushCampaignStatus.SENT : PushCampaignStatus.SENDING,
  });

@Resolver()
export class ShopperPushResolver {
  constructor(private readonly service: ShopperPushService) {}

  @Query(() => ShopperPushes, {
    description: "The shop's pushes to shoppers: how many have them on, and its campaigns.",
  })
  @RequireScopes('read_marketing_events')
  async shopperPushes(
    @CurrentTenant() tenant: TenantContext,
    @Args('first', { type: () => Int, defaultValue: 20 }) first: number,
  ): Promise<ShopperPushes> {
    return Object.assign(new ShopperPushes(), {
      available: this.service.on,
      subscribers: await this.service.subscriberCount(tenant),
      perDay: SHOPPER_PUSH_LIMITS.perDay,
      campaigns: (await this.service.campaigns(tenant, first)).map(toCampaign),
    });
  }

  @Mutation(() => PushCampaignSendPayload, {
    description:
      "Sends a push to every shopper's browser with notifications on for the shop: its title, " +
      'its words and the page it opens. The worker pushes it in marketing hours, 10 am to 9 pm ' +
      `in the shop's time zone; at most ${SHOPPER_PUSH_LIMITS.perDay} a day.`,
  })
  @RequireScopes('write_marketing_events')
  async pushCampaignSend(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: PushCampaignInput,
  ): Promise<PushCampaignSendPayload> {
    const result = await this.service.send(tenant, input);
    return Object.assign(new PushCampaignSendPayload(), {
      campaign: result.ok ? toCampaign(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
