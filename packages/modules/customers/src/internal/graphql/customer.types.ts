import { PageInfo, UserError } from '@hatti/api';
import {
  ArgsType,
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';

@ObjectType({
  description:
    'A customer: whoever a mobile number belongs to. Orders find or create their customer by ' +
    'number.',
})
export class Customer {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'Mobile number in E.164 form, e.g. "+923001234567": who they are.' })
  phone!: string;

  @Field(() => String, { nullable: true })
  name!: string | null;

  @Field({ description: 'The name, or the number when there is none: "0300 1234567".' })
  displayName!: string;

  @Field(() => String, { nullable: true })
  email!: string | null;

  @Field({ description: 'For staff.' })
  note!: string;

  @Field(() => [String])
  tags!: string[];

  @Field(() => Int, { description: 'Starts at 1 and increases with every change.' })
  version!: number;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;

  /** For field resolvers. */
  uuid!: string;
}

@ObjectType()
export class CustomerEdge {
  @Field()
  cursor!: string;

  @Field(() => Customer)
  node!: Customer;
}

@ObjectType()
export class CustomerConnection {
  @Field(() => [CustomerEdge])
  edges!: CustomerEdge[];

  @Field(() => [Customer])
  nodes!: Customer[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class CustomersArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'A mobile number in any format, four or more of its digits, or words of the name or email.',
  })
  query?: string | null;
}

@InputType()
export class CustomerCreateInput {
  @Field({ description: 'A Pakistani mobile number, in any common format.' })
  phone!: string;

  @Field(() => String, { nullable: true })
  name?: string | null;

  @Field(() => String, { nullable: true })
  email?: string | null;

  @Field(() => String, { nullable: true })
  note?: string | null;

  @Field(() => [String], { nullable: true })
  tags?: string[] | null;
}

@InputType({ description: 'Fields left out stay as they are.' })
export class CustomerUpdateInput {
  @Field(() => String, {
    nullable: true,
    description:
      "Must not be another customer's. Their orders keep the numbers they were placed with.",
  })
  phone?: string | null;

  @Field(() => String, { nullable: true, description: 'null clears it.' })
  name?: string | null;

  @Field(() => String, { nullable: true, description: 'null clears it.' })
  email?: string | null;

  @Field(() => String, { nullable: true })
  note?: string | null;

  @Field(() => [String], { nullable: true })
  tags?: string[] | null;
}

@ObjectType()
export class CustomerCreatePayload {
  @Field(() => Customer, { nullable: true })
  customer!: Customer | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class CustomerUpdatePayload {
  @Field(() => Customer, { nullable: true })
  customer!: Customer | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

export enum BlocklistReason {
  FAKE_ORDERS = 'FAKE_ORDERS',
  REFUSED_DELIVERIES = 'REFUSED_DELIVERIES',
  ABUSE = 'ABUSE',
  FRAUD = 'FRAUD',
  OTHER = 'OTHER',
}

registerEnumType(BlocklistReason, {
  name: 'BlocklistReason',
  description: 'Why a number is on the blocklist.',
  valuesMap: {
    FAKE_ORDERS: { description: 'Placed fake or prank orders.' },
    REFUSED_DELIVERIES: { description: 'Refused parcels at the door.' },
    ABUSE: { description: 'Abusive to staff or couriers.' },
    FRAUD: { description: 'Fraud, such as a fake payment receipt.' },
    OTHER: {},
  },
});

@ObjectType({
  description: 'A number on the blocklist. Orders from it are held for staff to review.',
})
export class BlocklistEntry {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'Mobile number in E.164 form.' })
  phone!: string;

  @Field(() => BlocklistReason)
  reason!: BlocklistReason;

  @Field({ description: 'What happened, for staff.' })
  note!: string;

  @Field(() => Int, { description: 'Starts at 1 and increases with every change.' })
  version!: number;

  @Field(() => GraphQLISODateTime, { description: 'When the number was blocked.' })
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType()
export class BlocklistEntryEdge {
  @Field()
  cursor!: string;

  @Field(() => BlocklistEntry)
  node!: BlocklistEntry;
}

@ObjectType()
export class BlocklistEntryConnection {
  @Field(() => [BlocklistEntryEdge])
  edges!: BlocklistEntryEdge[];

  @Field(() => [BlocklistEntry])
  nodes!: BlocklistEntry[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class BlocklistArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'A mobile number in any format, or four or more of its digits.',
  })
  query?: string | null;
}

@InputType()
export class BlocklistAddInput {
  @Field({ description: 'A Pakistani mobile number, in any common format.' })
  phone!: string;

  @Field(() => BlocklistReason)
  reason!: BlocklistReason;

  @Field(() => String, { nullable: true, description: 'What happened, for staff.' })
  note?: string | null;
}

@ObjectType()
export class BlocklistAddPayload {
  @Field(() => BlocklistEntry, { nullable: true })
  blocklistEntry!: BlocklistEntry | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class BlocklistRemovePayload {
  @Field(() => ID, { nullable: true })
  deletedBlocklistEntryId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
