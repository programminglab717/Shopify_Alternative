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

  @Field(() => Int, {
    nullable: true,
    description:
      'Days after an order was placed when, its customer unreachable (three calls unanswered), ' +
      'it is cancelled and its stock let go, by a sweep every few minutes; null for never.',
  })
  cancelUnreachableAfterDays!: number | null;

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

  @Field(() => Int, { nullable: true, description: '1 to 30; null for never.' })
  cancelUnreachableAfterDays?: number | null;
}

@ObjectType()
export class OrderSettingsUpdatePayload {
  @Field(() => OrderSettings, { nullable: true })
  orderSettings!: OrderSettings | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
