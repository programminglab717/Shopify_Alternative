import type { PolicyType } from './policy-types.js';
import type { ThemeRoleValue } from './schema.js';

/**
 * Events the online store publishes. Payloads are thin: fetch current state through the API. The
 * storefront follows the main theme, its files changing or another theme taking its place, the
 * menus, the pages, the blogs and their articles, the domains, the URL redirects and the policies.
 */
export const OnlineStoreEvents = {
  ThemeCreated: 'theme.created',
  ThemeUpdated: 'theme.updated',
  ThemePublished: 'theme.published',
  ThemeDeleted: 'theme.deleted',
  MenuCreated: 'menu.created',
  MenuUpdated: 'menu.updated',
  MenuDeleted: 'menu.deleted',
  PageCreated: 'page.created',
  PageUpdated: 'page.updated',
  PageDeleted: 'page.deleted',
  BlogCreated: 'blog.created',
  BlogUpdated: 'blog.updated',
  BlogDeleted: 'blog.deleted',
  ArticleCreated: 'article.created',
  ArticleUpdated: 'article.updated',
  ArticleDeleted: 'article.deleted',
  CommentCreated: 'comment.created',
  CommentUpdated: 'comment.updated',
  CommentDeleted: 'comment.deleted',
  PreferencesUpdated: 'online_store_preferences.updated',
  DomainCreated: 'domain.created',
  DomainUpdated: 'domain.updated',
  DomainDeleted: 'domain.deleted',
  UrlRedirectCreated: 'url_redirect.created',
  UrlRedirectUpdated: 'url_redirect.updated',
  UrlRedirectDeleted: 'url_redirect.deleted',
  UrlRedirectsImported: 'url_redirects.imported',
  UrlRedirectsMoved: 'url_redirects.moved',
  PolicyUpdated: 'shop_policy.updated',
} as const;

export interface ThemeCreatedPayload {
  name: string;
  base: string;
}

export interface ThemeUpdatedPayload {
  /** The files saved or deleted, by filename, or "name". */
  changed: string[];
  role: ThemeRoleValue;
  version: number;
}

/** A theme became the main one. */
export interface ThemePublishedPayload {
  /** The theme that was main until then, now unpublished; null if there was none. */
  previousId: string | null;
  version: number;
}

export interface ThemeDeletedPayload {
  name: string;
}

/** A menu made, changed or deleted: the storefront publishes the shop's menus again. */
export interface MenuChangedPayload {
  handle: string;
}

/** A page made or deleted. */
export interface PageChangedPayload {
  handle: string;
  isPublished: boolean;
}

/** A page changed: the storefront shows it again, and menus follow a new handle. */
export interface PageUpdatedPayload extends PageChangedPayload {
  /** The fields that changed: "title", "handle", "body", "isPublished" or "templateSuffix". */
  changed: string[];
}

/** A blog made, or deleted with its articles. */
export interface BlogChangedPayload {
  handle: string;
}

/** A blog changed: the storefront shows it again, and its articles under a new handle. */
export interface BlogUpdatedPayload extends BlogChangedPayload {
  /** The fields that changed: "title", "handle", "templateSuffix" or "commentPolicy". */
  changed: string[];
}

/**
 * A comment posted, approved, taken for spam or not, or deleted (ADR-220): its article's page
 * shows its comments again where the storefront showed it before or does now.
 */
export interface CommentChangedPayload {
  articleId: string;
  /** "pending", "published" or "spam"; as it was, for one deleted. */
  status: string;
  /** Whether the storefront showed it, or shows it now. */
  shown: boolean;
}

/** An article made or deleted, in its blog. */
export interface ArticleChangedPayload {
  blogId: string;
  handle: string;
  isPublished: boolean;
}

/** An article changed: the storefront shows it again, and its blog lists it. */
export interface ArticleUpdatedPayload extends ArticleChangedPayload {
  /**
   * The fields that changed: "title", "handle", "body", "summary", "author", "tags",
   * "isPublished", "publishedAt", "templateSuffix", or "blogId" when it moved to another blog.
   */
  changed: string[];
  /** The blog it was in until then, when it moved; null otherwise. */
  previousBlogId: string | null;
}

/**
 * A domain connected, changed or let go: the storefront answers at the shop's verified domains,
 * and sends shoppers to its primary one.
 */
export interface DomainChangedPayload {
  host: string;
  isVerified: boolean;
  isPrimary: boolean;
}

/** A domain checked, or made primary or not. */
export interface DomainUpdatedPayload extends DomainChangedPayload {
  /** "isVerified" or "isPrimary". */
  changed: string[];
}

/** One of the shop's policies changed, or was taken away: the storefront shows them. */
export interface PolicyUpdatedPayload {
  type: PolicyType;
  removed: boolean;
}

/** A URL redirect made, changed or deleted: the storefront follows the shop's redirects. */
export interface UrlRedirectChangedPayload {
  path: string;
  target: string;
}

/** Redirects made from a file, all at once: the storefront's are written again. */
export interface UrlRedirectsImportedPayload {
  created: number;
}

/**
 * Redirects made, changed and deleted all at once as many pages moved, such as a blog's articles
 * with it (ADR-218): the storefront's are written again.
 */
export interface UrlRedirectsMovedPayload {
  created: number;
  updated: number;
  deleted: number;
}

/** The shop changed what it sets for its storefront as a whole. */
export interface PreferencesUpdatedPayload {
  /** The preferences that changed, such as "whatsappNumber". */
  changed: string[];
}
