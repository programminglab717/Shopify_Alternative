import type { InputChecker } from '@hatti/api';
import { newId } from '@hatti/ids';
import type { MenuItemTypeValue, MenuItemValue } from './records.js';

/** What a shop's menus may hold (ADR-040). */
export const MENU_LIMITS = {
  menus: 100,
  /** Items in a menu, at every level. */
  items: 250,
  /** A top-level item, the items under it, and theirs. */
  levels: 3,
  title: 255,
  handle: 100,
  url: 2048,
  /** The items as JSON, under the 256 KB the database keeps, which it counts with spaces. */
  bytes: 200 * 1024,
} as const;

/** The menus every shop has: they keep their handles, and are not deleted. */
export const DEFAULT_MENUS = [
  { handle: 'main-menu', title: 'Main menu' },
  { handle: 'footer', title: 'Footer menu' },
] as const;

/** A menu's handle, as in `linklists['main-menu']`. */
export const MENU_HANDLE = /^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$/;

/** How many collections the main menu is made with, before "All products". */
const MENU_COLLECTIONS = 5;

/** What an item may link to until search exists. */
const TYPES: ReadonlySet<string> = new Set<MenuItemTypeValue>([
  'frontpage',
  'catalog',
  'collection',
  'product',
  'page',
  'blog',
  'article',
  'http',
]);

/** The links that name what they lead to by ID. */
const RESOURCED: ReadonlySet<string> = new Set([
  'collection',
  'product',
  'page',
  'blog',
  'article',
]);

/**
 * An http link's address: a path on the storefront, or a web, mail or phone address, with nothing
 * that could end the attribute a theme prints it in.
 */
const LINK = /^(\/(?![/\\])|https?:\/\/|mailto:|tel:)[^\s"'<>\\`]*$/i;

/** A menu's item as given. On an update, `id` keeps an item's ID. */
export interface MenuItemInput {
  id?: string | null;
  title: string;
  /**
   * frontpage, catalog, collection, product, page, blog, article or http, or one of Shopify's
   * others, refused.
   */
  type: string;
  resourceId?: string | null;
  url?: string | null;
  tags?: readonly string[] | null;
  items?: readonly MenuItemInput[] | null;
}

/**
 * A menu's items as they are kept, each with an ID: the one given, if it is one of the menu's
 * items (`known`), else a new one. Whether the collections and products they link to exist is
 * checked in the transaction that saves them.
 */
export function checkMenuItems(
  check: InputChecker,
  items: readonly MenuItemInput[],
  known: ReadonlySet<string>,
): MenuItemValue[] {
  const ids = new Set<string>();
  let count = 0;
  const walk = (level: readonly MenuItemInput[], field: string[], depth: number): MenuItemValue[] =>
    level.map((item, index) => {
      const at = [...field, String(index)];
      count += 1;
      const title = check.text([...at, 'title'], item.title, {
        required: true,
        max: MENU_LIMITS.title,
      });
      const type = item.type.toLowerCase();
      if (!TYPES.has(type)) {
        check.addMessage(
          [...at, 'type'],
          'INVALID',
          `Menus can't link to ${type.replace(/_/g, ' ')} yet: use an http link to its address`,
        );
      }
      const resourced = RESOURCED.has(type);
      const resourceId = item.resourceId ?? null;
      if (resourced && !resourceId) {
        check.addMessage([...at, 'resourceId'], 'BLANK', `A ${type} link needs its ${type}`);
      }
      if (!resourced && resourceId) {
        check.addMessage(
          [...at, 'resourceId'],
          'INVALID',
          'Only collection, product, page, blog and article links take a resource ID',
        );
      }
      const url = type === 'http' ? (item.url?.trim() ?? '') : null;
      if (url === '') check.addMessage([...at, 'url'], 'BLANK', 'An http link needs a URL');
      else if (url !== null && url.length > MENU_LIMITS.url) {
        check.addMessage(
          [...at, 'url'],
          'TOO_LONG',
          `URL is too long (maximum is ${MENU_LIMITS.url} characters)`,
        );
      } else if (url !== null && !LINK.test(url)) {
        check.addMessage(
          [...at, 'url'],
          'INVALID',
          'URL must be a path on the storefront, such as /collections/eid, or a web, mail or ' +
            'phone address',
        );
      }
      if (item.tags?.length) {
        check.add([...at, 'tags'], 'INVALID', "on menu items aren't available yet");
      }
      let id = newId();
      if (item.id) {
        if (!known.has(item.id)) {
          check.addMessage([...at, 'id'], 'NOT_FOUND', 'This menu has no item with this ID');
        } else if (ids.has(item.id)) {
          check.addMessage([...at, 'id'], 'INVALID', 'This item ID is given twice');
        } else id = item.id;
      }
      ids.add(id);
      const children = item.items ?? [];
      if (children.length > 0 && depth >= MENU_LIMITS.levels) {
        check.addMessage(
          [...at, 'items'],
          'INVALID',
          `Menus go ${MENU_LIMITS.levels} levels deep at most`,
        );
      }
      return {
        id,
        title: title ?? '',
        type: type as MenuItemTypeValue,
        resourceId: resourced ? resourceId : null,
        url: url || null,
        items: depth < MENU_LIMITS.levels ? walk(children, [...at, 'items'], depth + 1) : [],
      };
    });
  const values = walk(items, ['items'], 1);
  if (count > MENU_LIMITS.items) {
    check.addMessage(['items'], 'TOO_MANY', `A menu holds ${MENU_LIMITS.items} items at most`);
  } else if (Buffer.byteLength(JSON.stringify(values)) > MENU_LIMITS.bytes) {
    check.addMessage(['items'], 'TOO_LONG', "A menu's items take 200 KB at most");
  }
  return values;
}

/** Every item of a tree, at every level. */
export function allItems<T extends { items: T[] }>(items: readonly T[]): T[] {
  return items.flatMap((item) => [item, ...allItems(item.items)]);
}

/**
 * The menus a shop has before it changes them, as its storefront showed them until then: the main
 * menu leads to its first collections with products, by title, and to all its products.
 */
export function defaultMenuItems(
  collections: readonly { id: string; title: string; productsCount: number }[],
): Record<(typeof DEFAULT_MENUS)[number]['handle'], MenuItemValue[]> {
  const item = (fields: Omit<MenuItemValue, 'id' | 'items'>): MenuItemValue => ({
    id: newId(),
    ...fields,
    items: [],
  });
  return {
    'main-menu': [
      ...collections
        .filter((collection) => collection.productsCount > 0)
        .slice(0, MENU_COLLECTIONS)
        .map((collection) =>
          item({
            title: collection.title,
            type: 'collection',
            resourceId: collection.id,
            url: null,
          }),
        ),
      item({ title: 'All products', type: 'catalog', resourceId: null, url: null }),
    ],
    footer: [],
  };
}
