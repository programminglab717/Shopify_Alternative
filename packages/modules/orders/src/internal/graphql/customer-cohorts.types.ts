import { Field, Int, ObjectType } from '@nestjs/graphql';

@ObjectType({
  description:
    'The customers whose first order the shop took in one month, in its time zone (ANL-04), ' +
    'and how many of them ordered again in each month after.',
})
export class CustomerCohort {
  @Field({ description: 'The month, "2026-10".' })
  month!: string;

  @Field(() => Int, {
    description: 'Customers whose first order, cancelled ones aside, was placed in the month.',
  })
  customers!: number;

  @Field(() => [Int], {
    description:
      'How many of them ordered in each month after, the next first, up to this month: a ' +
      'customer counts once a month however many orders they placed in it.',
  })
  returned!: number[];

  @Field(() => Int, {
    description: 'How many of them have placed more than one order, at any time since.',
  })
  orderedAgain!: number;
}
