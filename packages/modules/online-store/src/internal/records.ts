import type { SeoValue } from '@hatti/api';
import type { PolicyType } from './policy-types.js';
import type { CommentPolicyValue, CommentStatusValue, ThemeRoleValue } from './schema.js';

/** The online store's view of its data, independent of GraphQL. */

export interface ThemeRecord {
  id: string;
  name: string;
  /** The platform theme it is built on, such as hatti-base. */
  base: string;
  /** The main theme is the one the storefront shows. */
  role: ThemeRoleValue;
  /** Goes up with every change to the theme. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** One of the shop's own files in a theme, over the platform theme's file of that name. */
export interface ThemeFileRecord {
  filename: string;
  /** JSON, as the shop saved it. */
  body: string;
  updatedAt: Date;
}

/** What a menu's item links to (ADR-040), pages (ADR-045), blogs and articles (ADR-178) too. */
export type MenuItemTypeValue =
  'frontpage' | 'catalog' | 'collection' | 'product' | 'page' | 'blog' | 'article' | 'http';

/** A menu's item as kept: what it links to, and the items under it. */
export interface MenuItemValue {
  id: string;
  title: string;
  type: MenuItemTypeValue;
  /** The collection, product, page, blog or article a link of that type leads to. */
  resourceId: string | null;
  /** An http link's address. */
  url: string | null;
  items: MenuItemValue[];
}

/** A menu's item, with where it leads now. */
export interface MenuItemRecord extends Omit<MenuItemValue, 'items'> {
  /** Its address on the storefront, or the http link's; null if what it linked to is gone. */
  url: string | null;
  /**
   * Whether the storefront shows what it leads to: a product that is not active, or a page or
   * an article not published, does not show.
   */
  shown: boolean;
  items: MenuItemRecord[];
}

export interface MenuRecord {
  id: string;
  handle: string;
  title: string;
  /** The main menu and the footer menu, which every shop has. */
  isDefault: boolean;
  items: MenuItemRecord[];
  createdAt: Date;
  updatedAt: Date;
}

/** A domain of the shop's own (ADR-048). */
export interface DomainRecord {
  id: string;
  /** As DNS has it: www.zari.pk. */
  host: string;
  /** When DNS last pointed it at the platform; null until it has. */
  verifiedAt: Date | null;
  /** Where the storefront sends shoppers; one of the shop's verified domains at most. */
  isPrimary: boolean;
  /**
   * Since when DNS has pointed it elsewhere, as the worker found checking it again (ADR-262);
   * null while it points at the platform.
   */
  unpointedSince: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A redirect from an address the shop has no page at to another (ADR-052). */
export interface UrlRedirectRecord {
  id: string;
  /** A path on the storefront, as `redirectPath` keeps it: /products/old-lawn. */
  path: string;
  /** Where it sends shoppers: a path on the storefront, or an http(s) address elsewhere. */
  target: string;
  createdAt: Date;
  updatedAt: Date;
}

/** One of a shop's policies, as Shopify keeps them (ADR-056). */
export interface PolicyRecord {
  id: string;
  type: PolicyType;
  /** In English, as Shopify titles it: "Refund policy". */
  title: string;
  /** HTML, cleaned when it was saved. */
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A body a policy had, as it was saved then (ADR-057). */
export interface PolicyVersionRecord {
  id: string;
  type: PolicyType;
  /** In English: "Refund policy". */
  title: string;
  body: string;
  /** When it was saved, and so when it took the place of the one before. */
  createdAt: Date;
}

/** A shop's own page, such as About us or its returns policy (ADR-045). */
export interface PageRecord {
  id: string;
  handle: string;
  title: string;
  /** HTML, as it was cleaned when saved: safe to show as it is. */
  body: string;
  /** Whether the storefront shows it. */
  isPublished: boolean;
  /** When it was last published; null while it is not. */
  publishedAt: Date | null;
  /** Another of the theme's page templates, "contact" for page.contact.json; null for page.json. */
  templateSuffix: string | null;
  /** What search engines are told in place of its title and body (ADR-231). */
  seo: SeoValue;
  createdAt: Date;
  updatedAt: Date;
}

/** A shop's blog, such as News, at /blogs/{handle} (ADR-176). */
export interface BlogRecord {
  id: string;
  handle: string;
  title: string;
  /** Another of the theme's blog templates, "news" for blog.news.json; null for blog.json. */
  templateSuffix: string | null;
  /** Whether its articles take comments, held for approval or shown at once (ADR-220). */
  commentPolicy: CommentPolicyValue;
  /** What search engines are told in place of its title (ADR-244). */
  seo: SeoValue;
  createdAt: Date;
  updatedAt: Date;
}

/** A comment a shopper posted on one of a blog's articles (ADR-220). */
export interface CommentRecord {
  id: string;
  articleId: string;
  /** The name it is signed with. */
  author: string;
  /** Where the shop may answer; the storefront never shows it. */
  email: string;
  /** Plain text, as typed. */
  body: string;
  status: CommentStatusValue;
  /** Where it was posted from, as the storefront saw the shopper; null when not known. */
  ip: string | null;
  userAgent: string | null;
  /** When the storefront began showing it; null while it is not. */
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** One of a blog's articles, at /blogs/{blog}/{handle} (ADR-176). */
export interface ArticleRecord {
  id: string;
  blogId: string;
  handle: string;
  title: string;
  /** HTML, as it was cleaned when saved: safe to show as it is. */
  body: string;
  /** HTML, cleaned as the body is, that the blog's page shows of it; empty for none. */
  summary: string;
  /** The name it is signed with; empty for none. */
  author: string;
  tags: string[];
  /** Whether the storefront shows it. */
  isPublished: boolean;
  /** When it was published, as its page says; null while it is not. */
  publishedAt: Date | null;
  /** Another of the theme's article templates, "recipe" for article.recipe.json; null for none. */
  templateSuffix: string | null;
  /** One of the shop's files, shown as its image (ADR-213); null for none. */
  image: ArticleImageRecord | null;
  /** What search engines are told in place of its title and summary or body (ADR-231). */
  seo: SeoValue;
  createdAt: Date;
  updatedAt: Date;
}

/** An article's image: one of the shop's files, and what it shows (ADR-213). */
export interface ArticleImageRecord {
  fileId: string;
  /** For those who cannot see it; empty for its file's own. */
  altText: string;
}

/** What a shop sets for its storefront as a whole (ADR-041). */
export interface PreferencesRecord {
  /** Where its "Order on WhatsApp" links go, in E.164; null until it sets one. */
  whatsappNumber: string | null;
  /** Whether its storefront is closed behind a password (ADR-054). */
  passwordEnabled: boolean;
  /** What the storefront checks shoppers' passwords against; null until one is set. */
  passwordVerifier: string | null;
  /** What the password page tells shoppers, as typed; empty for nothing. */
  passwordMessage: string;
  /** Rules it adds to its storefront's robots.txt, one a line (ADR-055); empty for none. */
  robotsTxtRules: string;
  /** Its link-in-bio page, at /links on its storefront (ADR-161). */
  linkPage: LinkPageRecord;
  /**
   * What search engines and link previews are told of its home page in place of its name
   * (ADR-243), as Shopify's homepage title and meta description: null for its own.
   */
  seo: SeoValue;
  /**
   * The image link previews show of its pages without one of their own (ADR-243), as Shopify's
   * social sharing image: one of its files; null for none.
   */
  sharingImage: SharingImageRecord | null;
  /** Its storefront paused for a while, or not (ADR-252). */
  maintenance: MaintenanceRecord;
}

/**
 * A shop's storefront paused for a while (ADR-252), as for a stock-take or the days its couriers
 * stop for Eid: shoppers see a page saying it is back soon, and checkout takes no orders.
 */
export interface MaintenanceRecord {
  /** Whether it is paused now: from when its staff pause it until they open it, or `until`. */
  enabled: boolean;
  /** What the page tells shoppers, as typed; empty for the platform's words. */
  message: string;
  /** When it opens again by itself, while it is paused; null for when its staff open it. */
  until: Date | null;
}

/** A shop's social sharing image (ADR-243): one of its files, and what it shows. */
export interface SharingImageRecord {
  fileId: string;
  /** For those who cannot see it; empty for the file's own. */
  altText: string;
}

/** A shop's link-in-bio page (CH-07, ADR-161). */
export interface LinkPageRecord {
  /** A line or two about the shop; empty for none. */
  bio: string;
  /** Its own links, in their order: a path on its storefront, or an https address. */
  links: { title: string; url: string }[];
  /** The products it shows, in their order; those deleted or not on sale are left out. */
  productIds: string[];
  /**
   * The variant chosen of each of `productIds`, by its place (ADR-206): its price and image on
   * the page, a tap from checkout; null where none is, as for a variant deleted since.
   */
  variantIds: (string | null)[];
}

export interface Page<T> {
  items: T[];
  hasNextPage: boolean;
}
