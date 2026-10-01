import { UserError } from '@hatti/api';
import { Field, GraphQLISODateTime, InputType, ObjectType } from '@nestjs/graphql';

@ObjectType({
  description:
    "A bank account customers pay into by transfer, with what they're told besides (ADR-074).",
})
export class BankAccount {
  @Field({ description: "The account's title, as its bank has it: whose account it is." })
  title!: string;

  @Field({ description: 'The bank, as customers pick it in their banking apps: "Meezan Bank".' })
  bankName!: string;

  @Field({ description: 'Its Pakistani IBAN, unspaced: "PK36SCBL0000001123456702".' })
  iban!: string;

  @Field({
    description:
      'What customers are told besides, such as where to send the receipt; empty for nothing.',
  })
  instructions!: string;
}

@ObjectType({ description: "How the shop's customers pay by bank transfer (PAY-02)." })
export class BankTransferSettings {
  @Field({
    description:
      'Whether checkout offers bank transfer beside cash on delivery, and alone above what cash ' +
      'on delivery may collect.',
  })
  enabled!: boolean;

  @Field(() => BankAccount, {
    nullable: true,
    description:
      'The account customers pay into; null until the shop gives one. Staff may place ' +
      'bank-transfer orders while checkout does not offer it.',
  })
  account!: BankAccount | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When the shop last changed them; none while it never has.',
  })
  updatedAt!: Date | null;
}

@InputType()
export class BankAccountInput {
  @Field({ description: 'Up to 100 characters.' })
  title!: string;

  @Field({ description: 'Up to 100 characters.' })
  bankName!: string;

  @Field({
    description:
      'A Pakistani IBAN, spaced or not, in either case: "PK36 SCBL 0000 0011 2345 6702". Its ' +
      'check digits are checked.',
  })
  iban!: string;

  @Field(() => String, { nullable: true, description: 'Up to 500 characters.' })
  instructions?: string | null;
}

@InputType()
export class BankTransferSettingsInput {
  @Field(() => Boolean, { nullable: true })
  enabled?: boolean | null;

  @Field(() => BankAccountInput, {
    nullable: true,
    description:
      'Replaces the account. null takes it away, which only a shop not offering bank transfer ' +
      'may do.',
  })
  account?: BankAccountInput | null;
}

@ObjectType()
export class BankTransferSettingsUpdatePayload {
  @Field(() => BankTransferSettings, { nullable: true })
  bankTransferSettings!: BankTransferSettings | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
