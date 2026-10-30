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

export enum ConfirmationCalls {
  OFF = 'OFF',
  HIGH_VALUE = 'HIGH_VALUE',
  ALL = 'ALL',
}

registerEnumType(ConfirmationCalls, {
  name: 'ConfirmationCalls',
  description:
    'Which cash-on-delivery orders get an automated call in Urdu, once, in calling hours, when ' +
    'their customer left the reminder to confirm unanswered for an hour: pressing 1 confirms the ' +
    'order, and 2 cancels it (COD-03, ADR-611). Each call is paid from the message credit.',
  valuesMap: {
    OFF: { description: 'None: the default.' },
    HIGH_VALUE: {
      description: "Those of high value, as the shop's risk settings count them.",
    },
    ALL: { description: 'All of them.' },
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

  @Field(() => Int, {
    nullable: true,
    description:
      'Hours instead of days, for a shop selling online alone (ADR-657): one or the other is ' +
      'set at most; null for never.',
  })
  cancelUnpaidAfterHours!: number | null;

  @Field(() => Int, {
    nullable: true,
    description:
      "The percentage off at which a cash-on-delivery order's page offers its customer a " +
      'product the shop pairs with what they bought, added with a tap and paid at the door, ' +
      'until it is packed (MKT-09, ADR-438); null for no offer, 0 for its price.',
  })
  upsellPercentOff!: number | null;

  @Field({
    description:
      'Whether the store credit that paid an order goes back to its customer once its every ' +
      'parcel came back unaccepted (ORD-09, ADR-610), as it does when the order is cancelled.',
  })
  creditBackOnReturn!: boolean;

  @Field({
    description:
      "Whether a customer's other cash-on-delivery orders confirmed and waiting to be packed or " +
      'booked are held for review once a parcel of theirs turns back, refused or not delivered ' +
      '(COD-07, ADR-674), for staff to call them before it ships.',
  })
  holdWhenRefused!: boolean;

  @Field(() => Int, {
    nullable: true,
    description:
      "Days after delivery a shopper may ask for a return from their order's page, staff " +
      'approving or declining it (ORD-08, ADR-675); null for none.',
  })
  returnWindowDays!: number | null;

  @Field(() => ConfirmationCalls)
  confirmationCalls!: ConfirmationCalls;

  @Field(() => Int, {
    nullable: true,
    description:
      "The most, as a percentage of what an order's items cost, a member of staff without the " +
      'GIVE_ANY_DISCOUNT capability takes off it with orderEditCharges (ORD-04, ADR-651); null ' +
      'for no limit. Owners, managers and apps take off any.',
  })
  staffDiscountPercent!: number | null;

  @Field({
    description:
      'Whether each order placed that needs a call is given to an agent on duty at the ' +
      'Confirmation Desk (confirmationDeskDutyStart), the one with the fewest waiting, then the ' +
      'one given one longest ago (ADR-654).',
  })
  shareNewOrders!: boolean;

  @Field(() => Int, {
    description:
      'The days between reminders of an order on payment terms still owed past its date ' +
      '(ADR-964): 7 unless the shop chose otherwise.',
  })
  termsReminderDays!: number;

  @Field(() => Int, {
    description:
      'How many reminders an order on payment terms still owed is sent past its date, 1 to 4 ' +
      '(ADR-964): 4 unless the shop chose otherwise.',
  })
  termsOverdueReminders!: number;

  @Field(() => Int, {
    description:
      'The days before an order on payment terms falls due that its customer is first reminded, ' +
      '0 for no reminder before it (ADR-965): 3 unless the shop chose otherwise.',
  })
  termsBeforeDays!: number;

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

  @Field(() => Int, { nullable: true, description: '1 to 30; null for never. Clears the hours.' })
  cancelUnpaidAfterDays?: number | null;

  @Field(() => Int, { nullable: true, description: '1 to 72; null for never. Clears the days.' })
  cancelUnpaidAfterHours?: number | null;

  @Field(() => Int, { nullable: true, description: '0 to 50; null for no offer.' })
  upsellPercentOff?: number | null;

  @Field(() => Boolean, { nullable: true })
  creditBackOnReturn?: boolean | null;

  @Field(() => Boolean, { nullable: true })
  holdWhenRefused?: boolean | null;

  @Field(() => Int, { nullable: true, description: '1 to 30; null for no returns asked online.' })
  returnWindowDays?: number | null;

  @Field(() => ConfirmationCalls, { nullable: true })
  confirmationCalls?: ConfirmationCalls | null;

  @Field(() => Int, { nullable: true, description: '0 to 100; null for no limit.' })
  staffDiscountPercent?: number | null;

  @Field(() => Boolean, { nullable: true })
  shareNewOrders?: boolean | null;

  @Field(() => Int, { nullable: true, description: '1 to 30.' })
  termsReminderDays?: number | null;

  @Field(() => Int, { nullable: true, description: '1 to 4.' })
  termsOverdueReminders?: number | null;

  @Field(() => Int, { nullable: true, description: '0 to 7; 0 for no reminder before the date.' })
  termsBeforeDays?: number | null;
}

@ObjectType()
export class OrderSettingsUpdatePayload {
  @Field(() => OrderSettings, { nullable: true })
  orderSettings!: OrderSettings | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
