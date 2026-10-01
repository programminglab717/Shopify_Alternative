import { UserError } from '@hatti/api';
import {
  ArgsType,
  Field,
  GraphQLISODateTime,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { Order } from './order.types.js';

export enum ConfirmationCallOutcome {
  NO_ANSWER = 'NO_ANSWER',
  CALL_BACK = 'CALL_BACK',
  WRONG_NUMBER = 'WRONG_NUMBER',
}

registerEnumType(ConfirmationCallOutcome, {
  name: 'ConfirmationCallOutcome',
  description: 'How a call to confirm an order went, short of confirming or cancelling it.',
  valuesMap: {
    NO_ANSWER: {
      description:
        'Not answered, busy or switched off: due again in two hours, or when the agent says. ' +
        'After three, the customer could not be reached (NO_RESPONSE).',
    },
    CALL_BACK: { description: 'The customer asked to be called back: due then.' },
    WRONG_NUMBER: {
      description: "Someone else's number: the order is held for the shop's review.",
    },
  },
});

@ObjectType({ description: 'A call made to confirm an order.' })
export class ConfirmationCall {
  @Field(() => ConfirmationCallOutcome)
  outcome!: ConfirmationCallOutcome;

  @Field(() => GraphQLISODateTime, { nullable: true })
  callBackAt!: Date | null;

  @Field({ description: "The agent's note, if any." })
  note!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

@ObjectType({ description: 'An order waiting for its customer to confirm it, in the queue.' })
export class ConfirmationQueueItem {
  @Field(() => Order)
  order!: Order;

  @Field(() => Int, { description: 'Calls the customer did not answer.' })
  unansweredCalls!: number;

  @Field(() => GraphQLISODateTime, {
    description: 'When it fell due: when it was placed, or when it was due again after a call.',
  })
  dueAt!: Date;

  @Field(() => ConfirmationCall, { nullable: true })
  lastCall!: ConfirmationCall | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'Taken by an agent until then, who is calling; null while no one has it.',
  })
  claimedUntil!: Date | null;

  @Field({ description: 'Whether you are the one who took it.' })
  claimedByYou!: boolean;
}

@ObjectType({
  description:
    "The Confirmation Desk's queue: orders waiting for their customers to confirm them, due " +
    'for a call now, the most urgent first.',
})
export class ConfirmationQueue {
  @Field(() => [ConfirmationQueueItem], {
    description:
      'Due now, the most urgent first: those of high value, as the risk policy sets it, then ' +
      'those due longest, then the riskier.',
  })
  nodes!: ConfirmationQueueItem[];

  @Field(() => Int, { description: 'Due now, taken or not.' })
  dueCount!: number;

  @Field(() => Int, { description: 'To be called again later.' })
  laterCount!: number;
}

@ArgsType()
export class ConfirmationQueueArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;
}

@ObjectType()
export class ConfirmationQueueNextPayload {
  @Field(() => ConfirmationQueueItem, {
    nullable: true,
    description: 'Yours for 15 minutes; null when none is due.',
  })
  item!: ConfirmationQueueItem | null;
}

@ObjectType()
export class OrderConfirmationCallPayload {
  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
