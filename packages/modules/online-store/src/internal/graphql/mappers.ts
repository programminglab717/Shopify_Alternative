import { PageInfo, badUserInput, encodeCursor } from '@hatti/api';
import { toPublicId, tryFromPublicId, type IdKind } from '@hatti/ids';
import type {
  MenuItemRecord,
  MenuRecord,
  PageRecord,
  ThemeFileRecord,
  ThemeRecord,
} from '../records.js';
import type { ThemeRoleValue } from '../schema.js';
import { Menu, MenuConnection, MenuEdge, MenuItem, MenuItemType } from './menu.types.js';
import { OnlineStorePage, PageConnection, PageEdge } from './page.types.js';
import {
  OnlineStoreTheme,
  OnlineStoreThemeConnection,
  OnlineStoreThemeEdge,
  OnlineStoreThemeFile,
  ThemeRole,
} from './theme.types.js';

/** The UUID behind a public ID of the given kind, or a BAD_USER_INPUT error. */
export function uuidOf(kind: IdKind, id: string): string {
  const uuid = tryFromPublicId(id, kind);
  if (!uuid) throw badUserInput(`Invalid ${kind} id: ${id.slice(0, 64)}`);
  return uuid;
}

export function toRoleValue(role: ThemeRole): ThemeRoleValue {
  return role === ThemeRole.MAIN ? 'main' : 'unpublished';
}

export function toTheme(record: ThemeRecord): OnlineStoreTheme {
  return Object.assign(new OnlineStoreTheme(), {
    id: toPublicId('theme', record.id),
    name: record.name,
    role: record.role === 'main' ? ThemeRole.MAIN : ThemeRole.UNPUBLISHED,
    base: record.base,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function toThemeFile(record: ThemeFileRecord): OnlineStoreThemeFile {
  return Object.assign(new OnlineStoreThemeFile(), {
    filename: record.filename,
    body: record.body,
    size: Buffer.byteLength(record.body),
    updatedAt: record.updatedAt,
  });
}

export function toThemeConnection(
  records: ThemeRecord[],
  hasNextPage: boolean,
): OnlineStoreThemeConnection {
  const nodes = records.map(toTheme);
  const edges = nodes.map((node) =>
    Object.assign(new OnlineStoreThemeEdge(), { node, cursor: encodeCursor({ id: node.id }) }),
  );
  return Object.assign(new OnlineStoreThemeConnection(), {
    edges,
    nodes,
    pageInfo: Object.assign(new PageInfo(), {
      hasNextPage,
      endCursor: edges.at(-1)?.cursor ?? null,
    }),
  });
}

export function toMenu(record: MenuRecord): Menu {
  return Object.assign(new Menu(), {
    id: toPublicId('menu', record.id),
    handle: record.handle,
    title: record.title,
    isDefault: record.isDefault,
    items: record.items.map(toMenuItem),
  });
}

function toMenuItem(record: MenuItemRecord): MenuItem {
  const kind = ({ collection: 'collection', product: 'product', page: 'page' } as const)[
    record.type as 'collection' | 'product' | 'page'
  ];
  return Object.assign(new MenuItem(), {
    id: toPublicId('menuItem', record.id),
    title: record.title,
    type: record.type.toUpperCase() as MenuItemType,
    resourceId: record.resourceId ? toPublicId(kind, record.resourceId) : null,
    url: record.url,
    tags: [],
    items: record.items.map(toMenuItem),
  });
}

export function toMenuConnection(records: MenuRecord[], hasNextPage: boolean): MenuConnection {
  const nodes = records.map(toMenu);
  const edges = nodes.map((node) =>
    Object.assign(new MenuEdge(), { node, cursor: encodeCursor({ id: node.id }) }),
  );
  return Object.assign(new MenuConnection(), {
    edges,
    nodes,
    pageInfo: Object.assign(new PageInfo(), {
      hasNextPage,
      endCursor: edges.at(-1)?.cursor ?? null,
    }),
  });
}

export function toPage(record: PageRecord): OnlineStorePage {
  return Object.assign(new OnlineStorePage(), {
    id: toPublicId('page', record.id),
    title: record.title,
    handle: record.handle,
    body: record.body,
    isPublished: record.isPublished,
    publishedAt: record.publishedAt,
    templateSuffix: record.templateSuffix,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function toPageConnection(records: PageRecord[], hasNextPage: boolean): PageConnection {
  const nodes = records.map(toPage);
  const edges = nodes.map((node) =>
    Object.assign(new PageEdge(), { node, cursor: encodeCursor({ id: node.id }) }),
  );
  return Object.assign(new PageConnection(), {
    edges,
    nodes,
    pageInfo: Object.assign(new PageInfo(), {
      hasNextPage,
      endCursor: edges.at(-1)?.cursor ?? null,
    }),
  });
}
