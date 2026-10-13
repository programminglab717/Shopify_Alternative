import { UserError } from '@hatti/api';
import { Field, GraphQLISODateTime, ID, InputType, ObjectType } from '@nestjs/graphql';

@ObjectType({
  description:
    "One of the shop's custom apps (DEV-04, ADR-395): an Admin API access token with a name " +
    'and the scopes it may use, and a secret its webhooks are signed with. Neither is shown ' +
    'again once made.',
})
export class CustomApp {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => [String], { description: 'Its access scopes, such as "write_orders".' })
  scopes!: string[];

  @Field({ description: "Its token's last four characters, to tell it apart." })
  tokenHint!: string;

  @Field(() => String, {
    nullable: true,
    description:
      "Its webhooks' secret's last four characters; null for an app made before apps had one, " +
      'until it is given one.',
  })
  secretHint!: string | null;

  @Field(() => ID, { nullable: true, description: 'The member of staff who made it, if one did.' })
  createdById!: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class CustomAppInput {
  @Field(() => String, { nullable: true, description: 'Up to 100 characters.' })
  name?: string | null;

  @Field(() => [String], {
    nullable: true,
    description: 'Its access scopes: at least one, none your role lacks.',
  })
  scopes?: string[] | null;
}

@ObjectType()
export class CustomAppCreatePayload {
  @Field(() => CustomApp, { nullable: true })
  customApp!: CustomApp | null;

  @Field(() => String, {
    nullable: true,
    description: 'Its Admin API access token: shown this once, never again.',
  })
  accessToken!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'The secret its webhooks are signed with: shown this once, never again.',
  })
  webhookSecret!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class CustomAppUpdatePayload {
  @Field(() => CustomApp, { nullable: true })
  customApp!: CustomApp | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class CustomAppTokenRotatePayload {
  @Field(() => CustomApp, { nullable: true })
  customApp!: CustomApp | null;

  @Field(() => String, {
    nullable: true,
    description: 'Its new token: shown this once. The one it had no longer works.',
  })
  accessToken!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class CustomAppSecretRotatePayload {
  @Field(() => CustomApp, { nullable: true })
  customApp!: CustomApp | null;

  @Field(() => String, {
    nullable: true,
    description: 'Its new secret: shown this once. Its webhooks are signed with it from now on.',
  })
  webhookSecret!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class CustomAppDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedCustomAppId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
