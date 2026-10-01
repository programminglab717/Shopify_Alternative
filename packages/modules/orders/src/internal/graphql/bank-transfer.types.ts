import { Money, UserError } from '@hatti/api';
import {
  Field,
  Float,
  GraphQLISODateTime,
  InputType,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';

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

  @Field(() => String, {
    nullable: true,
    description:
      'The mobile number its bank registered for Raast, in E.164: "+923001234567". Customers\' ' +
      'banking apps pay to it, as to the IBAN. Null for none.',
  })
  raastId!: string | null;
}

export enum TransferDiscountKind {
  PERCENTAGE = 'PERCENTAGE',
  FIXED_AMOUNT = 'FIXED_AMOUNT',
}

registerEnumType(TransferDiscountKind, {
  name: 'TransferDiscountKind',
  description: 'What paying by bank transfer takes off.',
  valuesMap: {
    PERCENTAGE: { description: "A percentage of the order's items, up to a cap if one is set." },
    FIXED_AMOUNT: { description: "An amount off the order's items." },
  },
});

@ObjectType({
  description:
    "What checkout takes off orders paid by bank transfer, as the shop's prepaid incentive " +
    "(CHK-08): off the order's items after any discount code. The order keeps it in " +
    'totalDiscounts, and apart as transferDiscount.',
})
export class TransferDiscount {
  @Field(() => TransferDiscountKind)
  kind!: TransferDiscountKind;

  @Field(() => Float, {
    nullable: true,
    description: "Percent off the order's items, for PERCENTAGE: 5 is 5%.",
  })
  percentage!: number | null;

  @Field(() => Money, {
    nullable: true,
    description: 'The most a PERCENTAGE takes off an order; null for no cap.',
  })
  cap!: Money | null;

  @Field(() => Money, {
    nullable: true,
    description: "Off the order's items, for FIXED_AMOUNT, never more than they come to.",
  })
  amount!: Money | null;
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

  @Field(() => TransferDiscount, {
    nullable: true,
    description:
      'What checkout takes off orders paid by bank transfer, while it offers bank transfer; ' +
      'null for nothing.',
  })
  discount!: TransferDiscount | null;

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

  @Field(() => String, {
    nullable: true,
    description:
      'The mobile number its bank registered for Raast, in any format: "0300 1234567". Blank or ' +
      'null for none.',
  })
  raastId?: string | null;
}

@InputType({
  description: 'A percentage off, with a cap or not, or an amount off: one of the two.',
})
export class TransferDiscountInput {
  @Field(() => Float, {
    nullable: true,
    description:
      "Percent off the order's items after any discount code, 0.01 to 50, with two decimals " +
      'at most.',
  })
  percentage?: number | null;

  @Field(() => String, {
    nullable: true,
    description:
      'The most a percentage takes off an order, in the shop currency: "500". Blank for no cap.',
  })
  cap?: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'An amount off the order\'s items after any discount code, in the shop currency: "150".',
  })
  amount?: string | null;
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

  @Field(() => TransferDiscountInput, {
    nullable: true,
    description:
      'Replaces what checkout takes off orders paid by bank transfer. null takes it away; ' +
      'orders placed before keep theirs.',
  })
  discount?: TransferDiscountInput | null;
}

@ObjectType()
export class BankTransferSettingsUpdatePayload {
  @Field(() => BankTransferSettings, { nullable: true })
  bankTransferSettings!: BankTransferSettings | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
