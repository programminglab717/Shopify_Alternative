import { SEO, SEOInput, UserError } from '@hatti/api';
import { Field, GraphQLISODateTime, ID, InputType, ObjectType } from '@nestjs/graphql';

@ObjectType({
  description:
    "The shop's social sharing image (ADR-243): one of its files, which link previews show of " +
    'its pages without an image of their own.',
})
export class SharingImage {
  @Field(() => ID, { description: 'The file, as `file` finds it.' })
  fileId!: string;

  @Field(() => String, {
    nullable: true,
    description: "What it shows, for those who cannot see it; null for its file's own.",
  })
  altText!: string | null;
}

@InputType({ description: "The shop's social sharing image: one of its files, an image." })
export class SharingImageInput {
  @Field(() => ID, { description: 'A JPEG, PNG, WebP or GIF the shop uploaded.' })
  fileId!: string;

  @Field(() => String, {
    nullable: true,
    description: "What it shows, for those who cannot see it; the file's own when blank.",
  })
  altText?: string | null;
}

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
  description: "One of the link page's products, and the variant chosen of it, if any.",
})
export class LinkPageProduct {
  @Field(() => ID)
  productId!: string;

  @Field(() => ID, {
    nullable: true,
    description:
      'One of its variants, chosen (ADR-206): the page shows its price and image, and "Buy now" ' +
      'goes straight to checkout with it. Null for the product as a whole.',
  })
  variantId!: string | null;
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

  @Field(() => [LinkPageProduct], {
    description: 'Its products as productIds has them, each with the variant chosen of it, if any.',
  })
  products!: LinkPageProduct[];
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

  @Field(() => SEO, {
    description:
      'What search engines and link previews are told of its home page in place of its name ' +
      "(ADR-243), as Shopify's homepage title and meta description.",
  })
  seo!: SEO;

  @Field(() => SharingImage, {
    nullable: true,
    description:
      'The image link previews show of its pages without one of their own (ADR-243), as ' +
      "Shopify's social sharing image; null for none.",
  })
  sharingImage!: SharingImage | null;

  @Field({
    description:
      'Whether the open storefront is paused for a while (ADR-252), as for a stock-take or the ' +
      'days couriers stop for Eid: shoppers see a page saying it is back soon, search engines ' +
      'are told to come back later, and checkout takes no orders. Orders placed before, their ' +
      "links and the tracking page carry on; the shop's staff see the storefront through a " +
      'preview. False again once maintenanceUntil comes.',
  })
  maintenanceEnabled!: boolean;

  @Field({
    description:
      "What the paused storefront's page tells shoppers; empty for the platform's words.",
  })
  maintenanceMessage!: string;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description:
      'When the paused storefront opens again by itself, which its page says; null for when ' +
      'its staff open it, and while it is open.',
  })
  maintenanceUntil!: Date | null;
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

@InputType()
export class LinkPageProductInput {
  @Field(() => ID)
  productId!: string;

  @Field(() => ID, {
    nullable: true,
    description: 'One of its variants, to show chosen and buy straight; null or absent for none.',
  })
  variantId?: string | null;
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

  @Field(() => [LinkPageProductInput], {
    nullable: true,
    description:
      "Up to 24 of the shop's products, in their order, each with one of its variants chosen or " +
      'none, replacing those it had; in place of productIds, not with it. A product may be twice ' +
      'with two of its variants.',
  })
  products?: LinkPageProductInput[] | null;
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

  @Field(() => SEOInput, {
    nullable: true,
    description:
      "Its home page's title and description for search engines and link previews; null " +
      'clears both, for its name.',
  })
  seo?: SEOInput | null;

  @Field(() => SharingImageInput, {
    nullable: true,
    description:
      'The image link previews show of its pages without one of their own, 1200 by 628 pixels ' +
      'at best; null for none. Left as it is if not given.',
  })
  sharingImage?: SharingImageInput | null;

  @Field(() => Boolean, {
    nullable: true,
    description:
      'Pauses the open storefront for a while, or opens it again. Left as it is if not given.',
  })
  maintenanceEnabled?: boolean | null;

  @Field(() => String, {
    nullable: true,
    description:
      "What the paused storefront's page tells shoppers, up to 1,000 characters; blank for the " +
      "platform's words, which say it is back soon.",
  })
  maintenanceMessage?: string | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description:
      'When the paused storefront opens again by itself, within 90 days; null for when its ' +
      'staff open it. Left as it is if not given; opening the storefront takes it away.',
  })
  maintenanceUntil?: Date | null;
}

@ObjectType()
export class OnlineStorePreferencesUpdatePayload {
  @Field(() => OnlineStorePreferences, { nullable: true })
  preferences!: OnlineStorePreferences | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
