import { Money, UserError } from '@hatti/api';
import { Field, GraphQLISODateTime, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType({ description: 'A wholesale customer who owes on payment terms (ADR-888).' })
export class PaymentTermsCustomer {
  @Field(() => ID)
  customerId!: string;

  @Field({ description: 'As their latest order owed names them.' })
  name!: string;

  @Field(() => Int, { description: 'Their orders on terms still owed.' })
  orders!: number;

  @Field(() => Money)
  owed!: Money;

  @Field(() => Money, { description: 'Of what they owe, what is past its due date.' })
  overdue!: Money;

  @Field(() => GraphQLISODateTime, { description: 'The earliest due date of their orders owed.' })
  oldestDueAt!: Date;
}

@ObjectType({
  description:
    'What wholesale customers owe on orders on payment terms (CUS-06, ADR-888): the most ' +
    'overdue first.',
})
export class PaymentTermsOwed {
  @Field(() => Money)
  owed!: Money;

  @Field(() => Money)
  overdue!: Money;

  @Field(() => [PaymentTermsCustomer])
  customers!: PaymentTermsCustomer[];
}

@ObjectType({
  description:
    "A customer's credit on payment terms (CUS-06, ADR-907): what they may owe at most, and what " +
    'they owe now. An order on terms that would take what they owe past the limit is refused.',
})
export class CustomerCredit {
  @Field(() => Money, { nullable: true, description: 'Null for no limit.' })
  creditLimit!: Money | null;

  @Field(() => Money)
  owed!: Money;

  @Field(() => Money)
  overdue!: Money;
}

@ObjectType()
export class CustomerCreditPayload {
  @Field(() => CustomerCredit, { nullable: true })
  credit!: CustomerCredit | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
