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

/** What a menu's item links to (ADR-040). */
export type MenuItemTypeValue = 'frontpage' | 'catalog' | 'collection' | 'product' | 'http';

/** A menu's item as kept: what it links to, and the items under it. */
export interface MenuItemValue {
  id: string;
  title: string;
  type: MenuItemTypeValue;
  /** The collection or product a collection or product link leads to. */
  resourceId: string | null;
  /** An http link's address. */
  url: string | null;
  items: MenuItemValue[];
}

/** A menu's item, with where it leads now. */
export interface MenuItemRecord extends Omit<MenuItemValue, 'items'> {
  /** Its address on the storefront, or the http link's; null if what it linked to is gone. */
  url: string | null;
  /** Whether the storefront shows what it leads to: a product that is not active does not show. */
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

export interface Page<T> {
  items: T[];
  hasNextPage: boolean;
}
