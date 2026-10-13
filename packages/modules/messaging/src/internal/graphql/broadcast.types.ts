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
import { MessageLanguage } from './messaging.types.js';

export enum BroadcastStatus {
  SCHEDULED = 'SCHEDULED',
  SENDING = 'SENDING',
  SENT = 'SENT',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
}

registerEnumType(BroadcastStatus, {
  name: 'BroadcastStatus',
  description: 'Where a broadcast is (ADR-421).',
  valuesMap: {
    SCHEDULED: { description: 'Waiting for its time, or for the hours marketing may go.' },
    SENDING: { description: 'Its messages are being queued.' },
    SENT: { description: 'Every message is queued: counts says how they went.' },
    CANCELLED: { description: 'Stopped by the shop; its messages not sent were not.' },
    FAILED: { description: 'Not sent: error says why.' },
  },
});

@ObjectType({ description: "How a broadcast's messages went." })
export class BroadcastCounts {
  @Field(() => Int, { description: "Queued and waiting: for their turn, or the shop's credit." })
  pending!: number;

  @Field(() => Int, { description: 'Taken by WhatsApp, the delivered and read among them.' })
  sent!: number;

  @Field(() => Int)
  delivered!: number;

  @Field(() => Int)
  read!: number;

  @Field(() => Int)
  failed!: number;

  @Field(() => Int, {
    description: 'Not sent: the customer had asked the shop to stop, or it was cancelled.',
  })
  skipped!: number;
}

@ObjectType({
  description:
    "A WhatsApp broadcast (MKT-01, ADR-421): one of the shop's approved templates to the " +
    'customers of a segment who agreed to hear from it on WhatsApp, from its own number.',
})
export class Broadcast {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => ID, { description: 'The template chosen; deleted since, the broadcast fails.' })
  templateId!: string;

  @Field()
  templateName!: string;

  @Field(() => MessageLanguage)
  templateLanguage!: MessageLanguage;

  @Field({ description: "What it says; {{1}} is each customer's first name." })
  templateBody!: string;

  @Field(() => ID, {
    nullable: true,
    description: 'The segment it goes to; null for every customer who agreed to hear.',
  })
  segmentId!: string | null;

  @Field(() => String, { nullable: true, description: "The segment's name as it was chosen." })
  segmentName!: string | null;

  @Field(() => GraphQLISODateTime, {
    description: 'When it goes: in the hours marketing may go, 10 am to 9 pm in the shop.',
  })
  sendAt!: Date;

  @Field(() => BroadcastStatus)
  status!: BroadcastStatus;

  @Field(() => String, { nullable: true })
  error!: string | null;

  @Field(() => Int, { description: 'The customers queued so far.' })
  recipients!: number;

  @Field(() => BroadcastCounts)
  counts!: BroadcastCounts;

  @Field(() => GraphQLISODateTime, { nullable: true })
  startedAt!: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  finishedAt!: Date | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

@ObjectType()
export class BroadcastEdge {
  @Field(() => Broadcast)
  node!: Broadcast;

  @Field()
  cursor!: string;
}

@ObjectType()
export class BroadcastConnection {
  @Field(() => [BroadcastEdge])
  edges!: BroadcastEdge[];

  @Field(() => [Broadcast])
  nodes!: Broadcast[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class BroadcastsArgs {
  @Field(() => Int, { nullable: true })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;
}

@InputType()
export class BroadcastInput {
  @Field()
  name!: string;

  @Field(() => ID, { description: "One of the shop's approved templates." })
  templateId!: string;

  @Field(() => ID, {
    nullable: true,
    description: 'The segment it goes to; none for every customer who agreed to hear.',
  })
  segmentId?: string | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When it goes, up to 30 days ahead; now if not given.',
  })
  sendAt?: Date | null;
}

@ObjectType()
export class BroadcastPayload {
  @Field(() => Broadcast, { nullable: true })
  broadcast!: Broadcast | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
