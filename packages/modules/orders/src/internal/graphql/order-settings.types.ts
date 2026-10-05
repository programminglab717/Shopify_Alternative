import { UserError } from '@hatti/api';
import {
  Field,
  GraphQLISODateTime,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';

export enum CustomerCancellation {
  UNTIL_CONFIRMED = 'UNTIL_CONFIRMED',
  UNTIL_PACKED = 'UNTIL_PACKED',
}

registerEnumType(CustomerCancellation, {
  name: 'CustomerCancellation',
  description:
    'How long a cash-on-delivery customer may cancel their order through its link, while ' +
    'nothing has been paid or shipped.',
  valuesMap: {
    UNTIL_CONFIRMED: { description: 'While the order waits for them to confirm it.' },
    UNTIL_PACKED: {
      description:
        'Until the order is packed, though they confirmed it: then it costs the shop nothing, ' +
        'where a parcel refused at the door costs a return. The default.',
    },
  },
});

@ObjectType({
  description:
    "The hours in which the Confirmation Desk calls customers, in the shop's time zone, as " +
    'clocks: "10:00" to "21:00".',
})
export class CallingHours {
  @Field()
  opens!: string;

  @Field()
  closes!: string;
}

@ObjectType({ description: "The shop's policies for its orders, but for risk." })
export class OrderSettings {
  @Field(() => CustomerCancellation)
  customerCancellation!: CustomerCancellation;

  @Field(() => CallingHours, {
    nullable: true,
    description:
      'When the Confirmation Desk calls customers (COD-05): outside them it deals out no order, ' +
      'and an unanswered one falls due again when they next open. Null for any time.',
  })
  callingHours!: CallingHours | null;

  @Field(() => Int, {
    nullable: true,
    description:
      'How long an order may wait for its first call, in minutes of calling hours, before the ' +
      'queue says it is overdue; null for no target.',
  })
  firstCallMinutes!: number | null;

  @Field({
    description:
      'Whether the Confirmation Desk waits for WhatsApp (COD-01, ADR-203): an order paid on ' +
      'delivery, not of high value, is dealt for its first call an hour after its customer was ' +
      'asked again to confirm it, so that agents call those who did not answer. False unless the ' +
      'shop asks.',
  })
  deskWaitsForReminder!: boolean;

  @Field(() => Int, {
    nullable: true,
    description:
      'Days after an order was placed when, its customer unreachable (three calls unanswered), ' +
      'it is cancelled and its stock let go, by a sweep every few minutes; null for never.',
  })
  cancelUnreachableAfterDays!: number | null;

  @Field(() => Int, {
    nullable: true,
    description:
      'Days after an order was placed when, still waiting for its payment by transfer or online, ' +
      'or its advance, with no receipt of it to check, it is cancelled and its stock let go, by ' +
      'a sweep every few minutes (ADR-168); null for never.',
  })
  cancelUnpaidAfterDays!: number | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When the shop last changed them; none while it has the defaults.',
  })
  updatedAt!: Date | null;
}

@InputType({ description: 'The same day\'s clocks, an hour apart at least: "10:00", "21:00".' })
export class CallingHoursInput {
  @Field()
  opens!: string;

  @Field({ description: '"24:00" for midnight.' })
  closes!: string;
}

@InputType({ description: 'Those not given stay as they are.' })
export class OrderSettingsInput {
  @Field(() => CustomerCancellation, { nullable: true })
  customerCancellation?: CustomerCancellation | null;

  @Field(() => CallingHoursInput, { nullable: true, description: 'null for any time.' })
  callingHours?: CallingHoursInput | null;

  @Field(() => Int, { nullable: true, description: '5 to 1440; null for no target.' })
  firstCallMinutes?: number | null;

  @Field(() => Boolean, { nullable: true })
  deskWaitsForReminder?: boolean | null;

  @Field(() => Int, { nullable: true, description: '1 to 30; null for never.' })
  cancelUnreachableAfterDays?: number | null;

  @Field(() => Int, { nullable: true, description: '1 to 30; null for never.' })
  cancelUnpaidAfterDays?: number | null;
}

@ObjectType()
export class OrderSettingsUpdatePayload {
  @Field(() => OrderSettings, { nullable: true })
  orderSettings!: OrderSettings | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
