import { PageInfo, UserError } from '@hatti/api';
import { ArgsType, Field, GraphQLISODateTime, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType({ description: "A field of the contact form's own, by its name (ADR-589)." })
export class ContactMessageField {
  @Field({ description: 'As the theme named it under contact[…]: "Order number".' })
  name!: string;

  @Field()
  value!: string;
}

@ObjectType({
  description:
    "What a shopper wrote to the shop through its online store's contact form (OS-08, ADR-589).",
})
export class ContactMessage {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  name!: string | null;

  @Field(() => String, { nullable: true, description: 'Lower case.' })
  email!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'A mobile number in E.164 form; masked like Customer.phone.',
  })
  phone!: string | null;

  @Field({ description: 'What they wrote.' })
  body!: string;

  @Field(() => [ContactMessageField], { description: "The form's other fields." })
  fields!: ContactMessageField[];

  @Field(() => String, { nullable: true, description: "The storefront's path the form was on." })
  page!: string | null;

  @Field({ description: 'The language of the storefront\'s page: "en" or "ur".' })
  language!: string;

  @Field(() => GraphQLISODateTime)
  receivedAt!: Date;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: "When the shop's staff read it; null while unread.",
  })
  readAt!: Date | null;
}

@ObjectType()
export class ContactMessageConnection {
  @Field(() => [ContactMessage])
  nodes!: ContactMessage[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class ContactMessagesArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;

  @Field(() => Boolean, { nullable: true, description: 'Those unread alone.' })
  unread?: boolean | null;
}

@ObjectType()
export class ContactMessageUpdatePayload {
  @Field(() => ContactMessage, { nullable: true })
  contactMessage!: ContactMessage | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class ContactMessageDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedContactMessageId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
