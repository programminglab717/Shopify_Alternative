import { UserError } from '@hatti/api';
import { Field, ID, InputType, ObjectType } from '@nestjs/graphql';

@ObjectType({ description: "One of a link page's own links." })
export class LinkPageLink {
  @Field()
  title!: string;

  @Field({
    description: 'A path on the storefront, such as /collections/sale, or an https address.',
  })
  url!: string;
}

@ObjectType({
  description:
    "The shop's link-in-bio page, at /links on its storefront, for its Instagram and TikTok bios " +
    'and its chats (ADR-161): what it says of itself, its own links, and products to buy at once.',
})
export class LinkPage {
  @Field({ description: 'A line or two about the shop; empty for none.' })
  bio!: string;

  @Field(() => [LinkPageLink])
  links!: LinkPageLink[];

  @Field(() => [ID], {
    description:
      'The products it shows, in their order. Those deleted are gone from it; the page leaves ' +
      'off those not active while they are not. One with a single variant goes straight to ' +
      'checkout, the others to their page.',
  })
  productIds!: string[];
}

@ObjectType({ description: 'What the shop sets for its storefront as a whole.' })
export class OnlineStorePreferences {
  @Field(() => String, {
    nullable: true,
    description:
      'Where its "Order on WhatsApp" links and WhatsApp section go, in E.164, such as ' +
      '+923001234567. Null until the shop sets one.',
  })
  whatsappNumber!: string | null;

  @Field({
    description:
      'Whether the storefront is closed behind its password: shoppers see only its password ' +
      'page until they give it, as while a new shop gets ready to open.',
  })
  passwordEnabled!: boolean;

  @Field(() => String, {
    nullable: true,
    description: "The storefront's password, to give those who may see it. Null until one is set.",
  })
  password!: string | null;

  @Field({ description: 'What the password page tells shoppers; empty for nothing.' })
  passwordMessage!: string;

  @Field({
    description:
      "Rules the shop adds to its storefront's robots.txt, one a line, as crawlers read them; " +
      'empty for none.',
  })
  robotsTxtRules!: string;

  @Field(() => LinkPage, { description: 'Its link-in-bio page, at /links on its storefront.' })
  linkPage!: LinkPage;
}

@InputType()
export class LinkPageLinkInput {
  @Field({ description: 'Up to 60 characters.' })
  title!: string;

  @Field({
    description: 'A path on the storefront, such as /collections/sale, or an https address.',
  })
  url!: string;
}

@InputType({ description: "The link page's parts to change; those not given stay as they are." })
export class LinkPageInput {
  @Field(() => String, { nullable: true, description: 'Up to 300 characters; blank for none.' })
  bio?: string | null;

  @Field(() => [LinkPageLinkInput], {
    nullable: true,
    description: 'Up to 10, in their order, replacing those it had.',
  })
  links?: LinkPageLinkInput[] | null;

  @Field(() => [ID], {
    nullable: true,
    description: "Up to 24 of the shop's products, in their order, replacing those it had.",
  })
  productIds?: string[] | null;
}

@InputType()
export class OnlineStorePreferencesInput {
  @Field(() => String, {
    nullable: true,
    description:
      'A Pakistani mobile number, such as 0300 1234567; blank or null for none. Left as it is ' +
      'if not given.',
  })
  whatsappNumber?: string | null;

  @Field(() => Boolean, {
    nullable: true,
    description:
      'Closes the storefront behind its password, which must be set, or opens it. Left as it ' +
      'is if not given.',
  })
  passwordEnabled?: boolean | null;

  @Field(() => String, {
    nullable: true,
    description:
      "The storefront's password, 4 to 100 characters. Changed, never taken away: shoppers who " +
      'gave the old one are asked for the new.',
  })
  password?: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'What the password page tells shoppers, up to 1,000 characters; blank for nothing.',
  })
  passwordMessage?: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      "Rules for the storefront's robots.txt, replacing those it had: `User-agent`, `Allow`, " +
      '`Disallow`, `Crawl-delay` and `Sitemap` lines, and comments. Rules before any ' +
      '`User-agent` are for every crawler. Blank for none.',
  })
  robotsTxtRules?: string | null;

  @Field(() => LinkPageInput, { nullable: true, description: 'Its link-in-bio page.' })
  linkPage?: LinkPageInput | null;
}

@ObjectType()
export class OnlineStorePreferencesUpdatePayload {
  @Field(() => OnlineStorePreferences, { nullable: true })
  preferences!: OnlineStorePreferences | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
