import { PageInfo, badUserInput, encodeCursor } from '@hatti/api';
import { toPublicId, tryFromPublicId, type IdKind } from '@hatti/ids';
import type { ThemeFileRecord, ThemeRecord } from '../records.js';
import type { ThemeRoleValue } from '../schema.js';
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
