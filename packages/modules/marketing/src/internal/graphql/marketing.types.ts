import { PageInfo, UserError } from '@hatti/api';
import {
  ArgsType,
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';

export enum ConversionMoment {
  PLACED = 'PLACED',
  CONFIRMED = 'CONFIRMED',
  DELIVERED = 'DELIVERED',
}

registerEnumType(ConversionMoment, {
  name: 'ConversionMoment',
  description: 'A moment of an order placed through checkout that the ad platforms hear of.',
  valuesMap: {
    PLACED: { description: 'It was placed.' },
    CONFIRMED: {
      description: 'Its customer or staff confirmed it; or, paid ahead, its payment came in.',
    },
    DELIVERED: { description: 'Its parcel was delivered.' },
  },
});

export enum ConversionStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED',
  SKIPPED = 'SKIPPED',
}

registerEnumType(ConversionStatus, {
  name: 'ConversionStatus',
  description: 'How sending a moment to an ad platform went.',
  valuesMap: {
    PENDING: { description: 'Waiting to go, or to be tried again.' },
    SENT: { description: 'The platform took it.' },
    FAILED: { description: 'The platform refused it, for good: `error` says why.' },
    EXPIRED: {
      description: 'Too old for the platform by the time it could go: Meta takes seven days.',
    },
    SKIPPED: {
      description:
        "Not sent: the shop disconnected the platform, or the customer's data was erased.",
    },
  },
});

export enum ConversionPlatform {
  META = 'META',
}

registerEnumType(ConversionPlatform, {
  name: 'ConversionPlatform',
  description: 'An ad platform orders go to.',
  valuesMap: {
    META: { description: "Meta's conversions API, for Facebook's and Instagram's ads." },
  },
});

@ObjectType({
  description:
    "The shop's Meta dataset, which its orders placed through checkout go to through Meta's " +
    'conversions API as they are placed, confirmed and delivered (MKT-10, ADR-143).',
})
export class MetaConversions {
  @Field({ description: "The dataset's ID: its Meta pixel's, as Events Manager shows it." })
  pixelId!: string;

  @Field({ description: 'The last four characters of its access token, never shown again.' })
  accessTokenHint!: string;

  @Field(() => String, {
    nullable: true,
    description:
      "Events Manager's code for test events: while it is set, Events Manager shows the " +
      "shop's events among them as they come.",
  })
  testEventCode!: string | null;

  @Field(() => ConversionMoment, {
    description:
      "Which moment of an order is Meta's Purchase; the others go as OrderPlaced, " +
      'OrderConfirmed and OrderDelivered. DELIVERED counts only the sales that turned out.',
  })
  purchaseAt!: ConversionMoment;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class MetaConversionsInput {
  @Field(() => String, {
    nullable: true,
    description: "The dataset's ID, from Events Manager: needed to connect.",
  })
  pixelId?: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'An access token Events Manager made for the conversions API, needed to connect: kept ' +
      'sealed, and never shown again.',
  })
  accessToken?: string | null;

  @Field(() => String, {
    nullable: true,
    description: "Events Manager's code for test events; blank or null takes it away.",
  })
  testEventCode?: string | null;

  @Field(() => ConversionMoment, { nullable: true, description: 'PLACED unless set.' })
  purchaseAt?: ConversionMoment | null;
}

@ObjectType()
export class MetaConversionsUpdatePayload {
  @Field(() => MetaConversions, { nullable: true })
  metaConversions!: MetaConversions | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class MetaConversionsDeletePayload {
  @Field(() => String, {
    nullable: true,
    description: "The dataset's ID that was connected; null when none was.",
  })
  deletedPixelId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType({
  description:
    'A moment of an order placed through checkout, sent or to be sent to an ad platform, and ' +
    'how sending it went.',
})
export class ConversionEvent {
  @Field(() => ID)
  id!: string;

  @Field(() => ConversionPlatform)
  platform!: ConversionPlatform;

  @Field(() => ID)
  orderId!: string;

  @Field(() => ConversionMoment)
  moment!: ConversionMoment;

  @Field(() => GraphQLISODateTime, {
    description: 'When it happened: the time the platform hears.',
  })
  occurredAt!: Date;

  @Field(() => ConversionStatus)
  status!: ConversionStatus;

  @Field(() => String, {
    nullable: true,
    description:
      'The name it went by once sent: Purchase, or its moment\'s own, as "OrderDelivered".',
  })
  eventName!: string | null;

  @Field(() => Int, { description: 'Tries to send it so far.' })
  attempts!: number;

  @Field(() => GraphQLISODateTime, { nullable: true })
  sentAt!: Date | null;

  @Field(() => String, {
    nullable: true,
    description: 'What the platform said last, when it did not take it: why.',
  })
  error!: string | null;

  @Field(() => String, {
    nullable: true,
    description: "The trace of the platform's answer, to ask it about: Meta's fbtrace_id.",
  })
  traceId!: string | null;

  @Field(() => GraphQLISODateTime, { description: 'When it was recorded.' })
  createdAt!: Date;
}

@ObjectType()
export class ConversionEventEdge {
  @Field()
  cursor!: string;

  @Field(() => ConversionEvent)
  node!: ConversionEvent;
}

@ObjectType()
export class ConversionEventConnection {
  @Field(() => [ConversionEventEdge])
  edges!: ConversionEventEdge[];

  @Field(() => [ConversionEvent])
  nodes!: ConversionEvent[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class ConversionEventsArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;

  @Field(() => ConversionStatus, { nullable: true, description: 'Those of this status alone.' })
  status?: ConversionStatus | null;

  @Field(() => ID, { nullable: true, description: "This order's alone." })
  orderId?: string | null;
}
