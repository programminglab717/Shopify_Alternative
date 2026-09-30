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

@ObjectType('Page', {
  description:
    "A shop's own page, such as About us or its returns policy, which its storefront shows at " +
    '/pages/{handle} once published, and its menus link to.',
})
export class OnlineStorePage {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;

  @Field({ description: 'Names it in its address, /pages/{handle}.' })
  handle!: string;

  @Field({
    description:
      'HTML, as it was cleaned when saved: text and its formatting, links, images and tables. ' +
      'Scripts, style sheets, frames, forms and event handlers are taken out.',
  })
  body!: string;

  @Field({ description: 'Whether the storefront shows it.' })
  isPublished!: boolean;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When it was published; null while it is not.',
  })
  publishedAt!: Date | null;

  @Field(() => String, {
    nullable: true,
    description:
      "Another of the theme's page templates, `contact` for page.contact.json; null for " +
      'page.json.',
  })
  templateSuffix!: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType()
export class PageEdge {
  @Field()
  cursor!: string;

  @Field(() => OnlineStorePage)
  node!: OnlineStorePage;
}

@ObjectType()
export class PageConnection {
  @Field(() => [PageEdge])
  edges!: PageEdge[];

  @Field(() => [OnlineStorePage])
  nodes!: OnlineStorePage[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class PagesArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;
}

@InputType({ description: 'A new page.' })
export class PageCreateInput {
  @Field()
  title!: string;

  @Field(() => String, {
    nullable: true,
    description: 'Made from the title when not given: "About us" gives about-us.',
  })
  handle?: string | null;

  @Field(() => String, { nullable: true, description: 'HTML, cleaned before it is kept.' })
  body?: string | null;

  @Field(() => Boolean, { nullable: true, description: 'Published unless false.' })
  isPublished?: boolean | null;

  @Field(() => String, { nullable: true })
  templateSuffix?: string | null;
}

@InputType({ description: 'Changes to a page: fields left out stay as they are.' })
export class PageUpdateInput {
  @Field(() => String, { nullable: true })
  title?: string | null;

  @Field(() => String, { nullable: true })
  handle?: string | null;

  @Field(() => String, { nullable: true, description: 'HTML, cleaned before it is kept.' })
  body?: string | null;

  @Field(() => Boolean, { nullable: true })
  isPublished?: boolean | null;

  @Field(() => String, { nullable: true, description: 'Blank for page.json.' })
  templateSuffix?: string | null;

  @Field(() => Boolean, {
    nullable: true,
    description:
      "With a new handle, whether the page's old address sends shoppers to its new one: a URL " +
      'redirect is made, as on Shopify. False unless given.',
  })
  redirectNewHandle?: boolean | null;
}

@ObjectType()
export class PageCreatePayload {
  @Field(() => OnlineStorePage, { nullable: true })
  page!: OnlineStorePage | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class PageUpdatePayload {
  @Field(() => OnlineStorePage, { nullable: true })
  page!: OnlineStorePage | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class PageDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedPageId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
