import {
  ArgsType,
  Field,
  Float,
  GraphQLISODateTime,
  ID,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { CodDelivery } from './cod-health.types.js';

export enum ConfirmationAgentKind {
  STAFF = 'STAFF',
  APP = 'APP',
}

registerEnumType(ConfirmationAgentKind, {
  name: 'ConfirmationAgentKind',
  description: 'Who did the work: a staff member, or an app by its access token.',
});

@ObjectType({ description: "An agent's calls that settled nothing, by how they went." })
export class ConfirmationAgentCalls {
  @Field(() => Int, { description: 'Not answered, busy or switched off.' })
  noAnswer!: number;

  @Field(() => Int, { description: 'The customer asked to be called back.' })
  callBack!: number;

  @Field(() => Int, { description: "Someone else's number." })
  wrongNumber!: number;
}

@ObjectType({
  description:
    'How one agent of the Confirmation Desk did over a period (COD-11): the orders they settled, ' +
    'their calls that settled nothing, their hours on the desk, and how the orders they ' +
    'confirmed turned out.',
})
export class ConfirmationAgent {
  @Field(() => ConfirmationAgentKind)
  kind!: ConfirmationAgentKind;

  @Field(() => ID, { description: 'The staff member (usr_…) or the access token (tok_…).' })
  id!: string;

  @Field(() => Int, { description: 'Orders they confirmed.' })
  confirmed!: number;

  @Field(() => Int, {
    description:
      'Orders they cancelled while those waited to be confirmed, as when the customer declined.',
  })
  cancelled!: number;

  @Field(() => Float, {
    nullable: true,
    description: 'Confirmed of the orders they confirmed or cancelled, from 0 to 1.',
  })
  confirmationRate!: number | null;

  @Field(() => ConfirmationAgentCalls)
  calls!: ConfirmationAgentCalls;

  @Field(() => Int, {
    description:
      "The hours of the shop's day in which they confirmed, cancelled or called: their hours on " +
      'the desk, as their work shows them.',
  })
  activeHours!: number;

  @Field(() => Float, {
    nullable: true,
    description: 'Orders confirmed an active hour, to two places; null without active hours.',
  })
  confirmationsPerHour!: number | null;

  @Field(() => CodDelivery, {
    description:
      'How the parcels of the orders they confirmed went, as they stand now: its returnRate is ' +
      'the RTO rate of the orders they confirmed.',
  })
  delivery!: CodDelivery;
}

@ArgsType()
export class ConfirmationAgentsArgs {
  @Field(() => GraphQLISODateTime, { description: 'Work done at or after this.' })
  from!: Date;

  @Field(() => GraphQLISODateTime, {
    description: 'Work done before this; at most 366 days after from.',
  })
  before!: Date;

  @Field(() => Int, { nullable: true, description: 'Agents at most, 1 to 250; default 50.' })
  first?: number | null;
}
