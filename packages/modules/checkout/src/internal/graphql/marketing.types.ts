import { UserError } from '@hatti/api';
import { MarketingChannelEnum } from '@hatti/customers/public';
import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class CheckoutMarketingChannelsUpdatePayload {
  @Field(() => [MarketingChannelEnum], { nullable: true })
  checkoutMarketingChannels!: MarketingChannelEnum[] | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
