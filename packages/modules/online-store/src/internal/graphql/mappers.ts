import { PageInfo, SEO, badUserInput, encodeCursor } from '@hatti/api';
import { toPublicId, tryFromPublicId, type IdKind } from '@hatti/ids';
import type {
  ArticleRecord,
  BlogRecord,
  CommentRecord,
  MenuItemRecord,
  MenuRecord,
  PageRecord,
  ThemeEditorRecord,
  ThemeFileRecord,
  PolicyRecord,
  PolicyVersionRecord,
  ThemeRecord,
  UrlRedirectRecord,
} from '../records.js';
import { commentHtml } from '../comment.service.js';
import { policyHandle } from '../policy-types.js';
import type { ThemeRoleValue } from '../schema.js';
import {
  ArticleAuthor,
  ArticleImage,
  ArticleConnection,
  ArticleEdge,
  BlogConnection,
  BlogEdge,
  CommentPolicy,
  OnlineStoreArticle,
  OnlineStoreBlog,
} from './blog.types.js';
import {
  CommentAuthor,
  CommentConnection,
  CommentEdge,
  CommentStatus,
  OnlineStoreComment,
} from './comment.types.js';
import { Menu, MenuConnection, MenuEdge, MenuItem, MenuItemType } from './menu.types.js';
import { OnlineStorePage, PageConnection, PageEdge } from './page.types.js';
import {
  OnlineStoreTheme,
  OnlineStoreThemeConnection,
  OnlineStoreThemeEdge,
  OnlineStoreThemeEditor,
  OnlineStoreThemeEditorFile,
  OnlineStoreThemeFile,
  OnlineStoreThemeSection,
  ThemeRole,
} from './theme.types.js';
import { ShopPolicy, ShopPolicyVersion, type ShopPolicyType } from './policy.types.js';
import { UrlRedirect, UrlRedirectConnection, UrlRedirectEdge } from './url-redirect.types.js';

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

export function toThemeEditor(record: ThemeEditorRecord): OnlineStoreThemeEditor {
  return Object.assign(new OnlineStoreThemeEditor(), {
    settingsSchema: JSON.stringify(record.settingsSchema),
    sections: record.sections.map((section) =>
      Object.assign(new OnlineStoreThemeSection(), {
        type: section.type,
        name: section.schema.name ?? section.type,
        schema: JSON.stringify(section.schema),
      }),
    ),
    files: record.files.map((file) => Object.assign(new OnlineStoreThemeEditorFile(), file)),
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
  const kind = (
    {
      collection: 'collection',
      product: 'product',
      page: 'page',
      blog: 'blog',
      article: 'article',
    } as const
  )[record.type as 'collection' | 'product' | 'page' | 'blog' | 'article'];
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
    seo: Object.assign(new SEO(), record.seo),
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

export function toUrlRedirect(record: UrlRedirectRecord): UrlRedirect {
  return Object.assign(new UrlRedirect(), {
    id: toPublicId('urlRedirect', record.id),
    path: record.path,
    target: record.target,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function toUrlRedirectConnection(
  records: UrlRedirectRecord[],
  hasNextPage: boolean,
): UrlRedirectConnection {
  const nodes = records.map(toUrlRedirect);
  const edges = nodes.map((node) =>
    Object.assign(new UrlRedirectEdge(), { node, cursor: encodeCursor({ id: node.id }) }),
  );
  return Object.assign(new UrlRedirectConnection(), {
    edges,
    nodes,
    pageInfo: Object.assign(new PageInfo(), {
      hasNextPage,
      endCursor: edges.at(-1)?.cursor ?? null,
    }),
  });
}

/** A policy, at the storefront whose address is `storefrontUrl`. */
export function toShopPolicy(record: PolicyRecord, storefrontUrl: string): ShopPolicy {
  return Object.assign(new ShopPolicy(), {
    id: toPublicId('shopPolicy', record.id),
    type: record.type as ShopPolicyType,
    title: record.title,
    body: record.body,
    url: `${storefrontUrl}/policies/${policyHandle(record.type)}`,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

/** A body a policy had (ADR-057). */
export function toShopPolicyVersion(record: PolicyVersionRecord): ShopPolicyVersion {
  return Object.assign(new ShopPolicyVersion(), {
    id: toPublicId('shopPolicyVersion', record.id),
    type: record.type as ShopPolicyType,
    title: record.title,
    body: record.body,
    createdAt: record.createdAt,
  });
}

export function toBlog(record: BlogRecord): OnlineStoreBlog {
  return Object.assign(new OnlineStoreBlog(), {
    id: toPublicId('blog', record.id),
    title: record.title,
    handle: record.handle,
    templateSuffix: record.templateSuffix,
    // The enum's values are the online store's own.
    commentPolicy: record.commentPolicy as CommentPolicy,
    seo: Object.assign(new SEO(), record.seo),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function toBlogConnection(records: BlogRecord[], hasNextPage: boolean): BlogConnection {
  const nodes = records.map(toBlog);
  const edges = nodes.map((node) =>
    Object.assign(new BlogEdge(), { node, cursor: encodeCursor({ id: node.id }) }),
  );
  return Object.assign(new BlogConnection(), {
    edges,
    nodes,
    pageInfo: Object.assign(new PageInfo(), {
      hasNextPage,
      endCursor: edges.at(-1)?.cursor ?? null,
    }),
  });
}

export function toArticle(record: ArticleRecord): OnlineStoreArticle {
  return Object.assign(new OnlineStoreArticle(), {
    id: toPublicId('article', record.id),
    title: record.title,
    handle: record.handle,
    body: record.body,
    summary: record.summary === '' ? null : record.summary,
    author:
      record.author === '' ? null : Object.assign(new ArticleAuthor(), { name: record.author }),
    tags: record.tags,
    isPublished: record.isPublished,
    publishedAt: record.publishedAt,
    templateSuffix: record.templateSuffix,
    image:
      record.image &&
      Object.assign(new ArticleImage(), {
        fileId: toPublicId('file', record.image.fileId),
        altText: record.image.altText === '' ? null : record.image.altText,
      }),
    seo: Object.assign(new SEO(), record.seo),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    blogId: record.blogId,
  });
}

export function toArticleConnection(
  records: ArticleRecord[],
  hasNextPage: boolean,
): ArticleConnection {
  const nodes = records.map(toArticle);
  const edges = nodes.map((node) =>
    Object.assign(new ArticleEdge(), { node, cursor: encodeCursor({ id: node.id }) }),
  );
  return Object.assign(new ArticleConnection(), {
    edges,
    nodes,
    pageInfo: Object.assign(new PageInfo(), {
      hasNextPage,
      endCursor: edges.at(-1)?.cursor ?? null,
    }),
  });
}

export function toComment(record: CommentRecord): OnlineStoreComment {
  return Object.assign(new OnlineStoreComment(), {
    id: toPublicId('comment', record.id),
    author: Object.assign(new CommentAuthor(), { name: record.author, email: record.email }),
    body: record.body,
    bodyHtml: commentHtml(record.body),
    // The enum's values are the online store's own.
    status: record.status as CommentStatus,
    isPublished: record.status === 'published',
    publishedAt: record.publishedAt,
    ip: record.ip,
    userAgent: record.userAgent,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    articleId: record.articleId,
  });
}

export function toCommentConnection(
  records: CommentRecord[],
  hasNextPage: boolean,
): CommentConnection {
  const nodes = records.map(toComment);
  const edges = nodes.map((node) =>
    Object.assign(new CommentEdge(), { node, cursor: encodeCursor({ id: node.id }) }),
  );
  return Object.assign(new CommentConnection(), {
    edges,
    nodes,
    pageInfo: Object.assign(new PageInfo(), {
      hasNextPage,
      endCursor: edges.at(-1)?.cursor ?? null,
    }),
  });
}
