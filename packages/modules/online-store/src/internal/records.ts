import type { ThemeRoleValue } from './schema.js';

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

/** What a menu's item links to (ADR-040), pages too (ADR-045). */
export type MenuItemTypeValue =
  'frontpage' | 'catalog' | 'collection' | 'product' | 'page' | 'http';

/** A menu's item as kept: what it links to, and the items under it. */
export interface MenuItemValue {
  id: string;
  title: string;
  type: MenuItemTypeValue;
  /** The collection, product or page a collection, product or page link leads to. */
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
   * Whether the storefront shows what it leads to: a product that is not active, or a page not
   * published, does not show.
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

/** A shop's own page, such as About us or its returns policy (ADR-045). */
/** A domain of the shop's own (ADR-048). */
export interface DomainRecord {
  id: string;
  /** As DNS has it: www.zari.pk. */
  host: string;
  /** When DNS last pointed it at the platform; null until it has. */
  verifiedAt: Date | null;
  /** Where the storefront sends shoppers; one of the shop's verified domains at most. */
  isPrimary: boolean;
  createdAt: Date;
  updatedAt: Date;
}

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
  createdAt: Date;
  updatedAt: Date;
}

/** What a shop sets for its storefront as a whole (ADR-041). */
export interface PreferencesRecord {
  /** Where its "Order on WhatsApp" links go, in E.164; null until it sets one. */
  whatsappNumber: string | null;
}

export interface Page<T> {
  items: T[];
  hasNextPage: boolean;
}
