import { PageInfo, UserError } from '@hatti/api';
import {
  ArgsType,
  Field,
  GraphQLISODateTime,
  ID,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';

export enum ConversationStatus {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
}

registerEnumType(ConversationStatus, {
  name: 'ConversationStatus',
  description: 'Whether a conversation still wants the shop: the customer writing opens it again.',
  valuesMap: {
    OPEN: { description: 'Still to be seen to.' },
    CLOSED: { description: 'Seen to; it opens again when the customer writes.' },
  },
});

export enum ConversationMessageDirection {
  INBOUND = 'INBOUND',
  OUTBOUND = 'OUTBOUND',
}

registerEnumType(ConversationMessageDirection, {
  name: 'ConversationMessageDirection',
  valuesMap: {
    INBOUND: { description: 'The customer wrote it.' },
    OUTBOUND: { description: 'The shop wrote it.' },
  },
});

export enum ConversationReplyStatus {
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  READ = 'READ',
  FAILED = 'FAILED',
}

registerEnumType(ConversationReplyStatus, {
  name: 'ConversationReplyStatus',
  description: "How a reply went, as WhatsApp's webhook says (ADR-546).",
  valuesMap: {
    SENT: { description: 'WhatsApp took it.' },
    DELIVERED: { description: "On the customer's phone." },
    READ: { description: 'The customer opened it.' },
    FAILED: { description: 'WhatsApp could not deliver it.' },
  },
});

@ObjectType({ description: 'A message of a conversation with a customer (ADR-545).' })
export class ConversationMessage {
  @Field(() => ID)
  id!: string;

  @Field(() => ConversationMessageDirection)
  direction!: ConversationMessageDirection;

  @Field(() => String, {
    nullable: true,
    description: 'What was written, or the button pressed; null for anything else.',
  })
  body!: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'What else it held, as WhatsApp names it: "image", "audio", "location". It is not kept: ' +
      "the customer's phone shows it.",
  })
  mediaKind!: string | null;

  @Field(() => GraphQLISODateTime)
  at!: Date;

  @Field(() => ConversationReplyStatus, {
    nullable: true,
    description: "How the shop's reply went; null for what the customer wrote.",
  })
  status!: ConversationReplyStatus | null;

  @Field(() => String, {
    nullable: true,
    description: 'Why WhatsApp could not deliver the reply.',
  })
  error!: string | null;
}

@ObjectType()
export class ConversationMessageConnection {
  @Field(() => [ConversationMessage], { description: 'The latest first.' })
  nodes!: ConversationMessage[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ObjectType({
  description:
    "A conversation with a customer on WhatsApp (MSG-05, ADR-545): what they wrote to the shop's " +
    "own number, or to Hatti's shared one in answer to the shop.",
})
export class Conversation {
  @Field(() => ID)
  id!: string;

  @Field({ description: "The customer's number, masked as the caller may see it." })
  customerPhone!: string;

  @Field({ description: "Whether they last wrote to the shop's own number." })
  viaOwnNumber!: boolean;

  @Field(() => ConversationStatus)
  status!: ConversationStatus;

  @Field(() => Int, { description: "Messages the shop's staff have not read." })
  unread!: number;

  @Field(() => GraphQLISODateTime)
  lastMessageAt!: Date;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When the customer last wrote: WhatsApp lets the shop answer freely for a day.',
  })
  lastInboundAt!: Date | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description:
      'Until when the shop may answer in its own words: a day after the customer last wrote ' +
      '(ADR-546). Null if they never wrote.',
  })
  replyableUntil!: Date | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description:
      'Since when the customer has waited for an answer (ADR-760): their first message since ' +
      'the shop last answered. Null once answered or closed.',
  })
  waitingSince!: Date | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description:
      "When the shop means to have answered by: waitingSince plus the shop's " +
      'replyTargetMinutes. Null when not waiting or the shop sets no target; past, it is overdue.',
  })
  answerBy!: Date | null;

  @Field(() => ConversationMessage, { nullable: true })
  lastMessage!: ConversationMessage | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  /** The account of the member of staff it is given to, for the core's `assignee` (ADR-759). */
  assigneeId!: string | null;
}

@ObjectType()
export class ConversationEdge {
  @Field()
  cursor!: string;

  @Field(() => Conversation)
  node!: Conversation;
}

@ObjectType()
export class ConversationConnection {
  @Field(() => [ConversationEdge])
  edges!: ConversationEdge[];

  @Field(() => [Conversation])
  nodes!: Conversation[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class ConversationsArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;

  @Field(() => Boolean, { nullable: true, description: 'Those with messages unread alone.' })
  unread?: boolean | null;

  @Field(() => ConversationStatus, { nullable: true, description: 'Those of this status alone.' })
  status?: ConversationStatus | null;

  @Field(() => Boolean, {
    nullable: true,
    description: 'Those given to the member of staff asking alone (ADR-759).',
  })
  assignedToMe?: boolean | null;

  @Field(() => Boolean, { nullable: true, description: 'Those given to no one alone.' })
  unassigned?: boolean | null;

  @Field(() => Boolean, {
    nullable: true,
    description: "Those waiting for an answer past the shop's reply target alone (ADR-760).",
  })
  overdue?: boolean | null;
}

@ArgsType()
export class ConversationMessagesArgs {
  @Field(() => ID)
  conversationId!: string;

  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => ID, {
    nullable: true,
    description: 'The messages before this one: the last the page before showed.',
  })
  before?: string | null;
}

@ObjectType()
export class ConversationUpdatePayload {
  @Field(() => Conversation, { nullable: true })
  conversation!: Conversation | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class ConversationReplyPayload {
  @Field(() => Conversation, { nullable: true })
  conversation!: Conversation | null;

  @Field(() => ConversationMessage, {
    nullable: true,
    description: 'The reply, as WhatsApp took it.',
  })
  message!: ConversationMessage | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
