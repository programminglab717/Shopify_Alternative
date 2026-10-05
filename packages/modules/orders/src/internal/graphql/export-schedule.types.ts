import { UserError } from '@hatti/api';
import {
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { OrderExportFormat, OrderExportLayout } from './export.types.js';

export enum OrderExportFrequency {
  DAILY = 'DAILY',
  WEEKLY = 'WEEKLY',
  MONTHLY = 'MONTHLY',
}

registerEnumType(OrderExportFrequency, {
  name: 'OrderExportFrequency',
  description: 'How often a scheduled export goes, with the orders of the period that ended.',
  valuesMap: {
    DAILY: { description: "Every day: the day before's orders." },
    WEEKLY: { description: "Every Monday: the week before's, Monday to Sunday." },
    MONTHLY: { description: "On the first of each month: the month before's." },
  },
});

@ObjectType({
  description:
    "An export of the shop's orders a member of staff scheduled (ORD-11, ADR-183): every day, " +
    'week or month, the orders placed in the one that ended, filtered as the order list is, ' +
    'emailed to them as an attachment at the hour they chose, in the shop time zone.',
})
export class OrderExportSchedule {
  @Field(() => ID)
  id!: string;

  @Field(() => ID, {
    description:
      'The member of staff it goes to, at their proved email, while they work in the shop in a ' +
      'role that exports orders: usr_….',
  })
  staffMemberId!: string;

  @Field(() => OrderExportFrequency)
  frequency!: OrderExportFrequency;

  @Field(() => Int, { description: 'The hour of the day it goes, 0 to 23, in the shop time zone.' })
  hour!: number;

  @Field(() => OrderExportLayout)
  layout!: OrderExportLayout;

  @Field(() => OrderExportFormat)
  format!: OrderExportFormat;

  @Field({ description: 'As `orders(query:)` takes it; empty for every order.' })
  query!: string;

  @Field(() => GraphQLISODateTime, { description: 'When it next goes.' })
  nextSendAt!: Date;

  @Field({ description: 'The first day of the period it sends next, "2026-10-04".' })
  nextPeriodFirstDay!: string;

  @Field({ description: 'The last day of the period it sends next, in the shop time zone.' })
  nextPeriodLastDay!: string;

  @Field(() => GraphQLISODateTime, { nullable: true })
  lastSentAt!: Date | null;

  @Field(() => String, {
    nullable: true,
    description: 'Why the last period went unsent, or its last try failed.',
  })
  lastError!: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

@InputType()
export class OrderExportScheduleInput {
  @Field(() => OrderExportFrequency)
  frequency!: OrderExportFrequency;

  @Field(() => Int, {
    nullable: true,
    description: 'The hour of the day it goes, 0 to 23, in the shop time zone; 8 unless given.',
  })
  hour?: number | null;

  @Field(() => OrderExportLayout, { defaultValue: OrderExportLayout.ORDERS })
  layout!: OrderExportLayout;

  @Field(() => OrderExportFormat, {
    defaultValue: OrderExportFormat.XLSX,
    description: 'An Excel workbook unless said.',
  })
  format!: OrderExportFormat;

  @Field(() => String, {
    nullable: true,
    description: 'As `orders(query:)` takes it, such as "stage:delivered"; none for every order.',
  })
  query?: string | null;
}

@ObjectType()
export class OrderExportScheduleCreatePayload {
  @Field(() => OrderExportSchedule, { nullable: true })
  exportSchedule!: OrderExportSchedule | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class OrderExportScheduleDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedExportScheduleId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
