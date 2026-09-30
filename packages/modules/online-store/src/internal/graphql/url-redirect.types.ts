import { PageInfo, UserError } from '@hatti/api';
import {
  ArgsType,
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  ObjectType,
} from '@nestjs/graphql';

@ObjectType({
  description:
    "A redirect from an address the shop has no page at, such as its old store's " +
    '/products/old-lawn, to another: the storefront follows it only where it would otherwise ' +
    'answer 404, in both languages.',
})
export class UrlRedirect {
  @Field(() => ID)
  id!: string;

  @Field({
    description:
      'The path it sends shoppers from, as the storefront compares addresses: lowercase, ' +
      'without a query, a trailing slash or the /ur prefix.',
  })
  path!: string;

  @Field({ description: 'Where it sends them: a path on the shop, or an http(s) address.' })
  target!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType()
export class UrlRedirectEdge {
  @Field()
  cursor!: string;

  @Field(() => UrlRedirect)
  node!: UrlRedirect;
}

@ObjectType()
export class UrlRedirectConnection {
  @Field(() => [UrlRedirectEdge])
  edges!: UrlRedirectEdge[];

  @Field(() => [UrlRedirect])
  nodes!: UrlRedirect[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class UrlRedirectsArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'Only redirects whose path or target has this text.',
  })
  query?: string | null;
}

@InputType({ description: 'A redirect: what is given of it.' })
export class UrlRedirectInput {
  @Field(() => String, {
    nullable: true,
    description: 'A path on the shop, or an address of it pasted whole. Needed to make one.',
  })
  path?: string | null;

  @Field(() => String, { nullable: true, description: 'Needed to make one.' })
  target?: string | null;
}

@ObjectType()
export class UrlRedirectCreatePayload {
  @Field(() => UrlRedirect, { nullable: true })
  urlRedirect!: UrlRedirect | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class UrlRedirectUpdatePayload {
  @Field(() => UrlRedirect, { nullable: true })
  urlRedirect!: UrlRedirect | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class UrlRedirectDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedUrlRedirectId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
