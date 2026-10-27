import { Money, UserError } from '@hatti/api';
import {
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { RIDER_LIMITS } from '../riders.js';

export enum RiderDeliveryStatus {
  OUT = 'OUT',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
}

registerEnumType(RiderDeliveryStatus, {
  name: 'RiderDeliveryStatus',
  description: "Where a delivery the shop's own rider carries stands (ADR-824).",
  valuesMap: {
    OUT: { description: 'With the rider.' },
    DELIVERED: { description: 'Delivered, as the rider said.' },
    FAILED: { description: 'Not delivered: the rider brings it back.' },
  },
});

@ObjectType({
  description:
    "One of the shop's own riders (SHP-10, ADR-824), with a page of their own opened from a " +
    'link, with no account.',
})
export class Rider {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field({ description: 'Their mobile, as +923001234567.' })
  phone!: string;

  @Field({ description: 'Whether they ride for the shop now: only they are handed orders.' })
  active!: boolean;

  @Field(() => Int, { description: 'Deliveries they carry now.' })
  out!: number;

  @Field(() => Money, { description: 'What they collected and have not handed over.' })
  cashHeld!: Money;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

@ObjectType({
  description: "An order handed to the shop's own rider, its parcel theirs to deliver.",
})
export class RiderDelivery {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  riderId!: string;

  @Field(() => ID)
  orderId!: string;

  @Field(() => ID, { description: 'Its parcel.' })
  fulfillmentId!: string;

  @Field(() => RiderDeliveryStatus)
  status!: RiderDeliveryStatus;

  @Field(() => Money, { description: 'What the order owed in cash when it went out.' })
  cashDue!: Money;

  @Field(() => Money)
  cashCollected!: Money;

  @Field({ description: 'Whether its customer was sent a code to give the rider at the door.' })
  codeSent!: boolean;

  @Field({ description: "Whether the rider gave the customer's code on delivering it." })
  codeGiven!: boolean;

  @Field(() => String, { nullable: true })
  failedReason!: string | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  deliveredAt!: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  failedAt!: Date | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

@InputType()
export class RiderInput {
  @Field({ description: `1 to ${RIDER_LIMITS.name} characters.` })
  name!: string;

  @Field({ description: 'A Pakistani mobile, such as 0300 1234567.' })
  phone!: string;

  @Field(() => Boolean, {
    nullable: true,
    description: 'Whether they ride for the shop now; true unless said.',
  })
  active?: boolean | null;
}

@ObjectType()
export class RiderPayload {
  @Field(() => Rider, { nullable: true })
  rider!: Rider | null;

  @Field(() => String, {
    nullable: true,
    description:
      "Their page's address, carrying its secret: given once, when made or made anew, to send " +
      'the rider. Null otherwise.',
  })
  link!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType({ description: 'An order handed to a rider, or why not.' })
export class RiderHandOutResult {
  @Field(() => ID)
  orderId!: string;

  @Field(() => RiderDelivery, { nullable: true })
  delivery!: RiderDelivery | null;

  @Field(() => String, { nullable: true })
  problem!: string | null;
}

@ObjectType()
export class RiderHandOutPayload {
  @Field(() => [RiderHandOutResult])
  results!: RiderHandOutResult[];

  @Field(() => [UserError])
  userErrors!: UserError[];
}
