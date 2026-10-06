// Comments shoppers post on a shop's articles (ADR-220): Shopify's new_comment form, which the
// storefront sends on to the core, which keeps the comment as the article's blog's policy says.

import { STOREFRONT_API_PREFIX } from './cart.js';

/**
 * POST a {@link CommentRequest}: a shopper's comment, answered with a {@link CommentResponse};
 * 422, with a {@link CommentErrorResponse}, says what was wrong with it.
 */
export function commentsPath(shopId: string): string {
  return `${STOREFRONT_API_PREFIX}shops/${shopId}/comments`;
}

/**
 * A comment, as Shopify's new_comment form names its fields under `comment[…]`, on the article
 * its address names.
 */
export interface CommentRequest {
  /** The article's blog's handle and its own, as in its address: news, eid-edit. */
  blog: string;
  article: string;
  /** The name it is signed with: `comment[author]`. */
  author: string;
  /** `comment[email]`, which the shop may answer at; the storefront never shows it. */
  email: string;
  /** `comment[body]`, plain text. */
  body: string;
  /** Where the shopper posted it from, as the storefront saw them. */
  ip?: string;
  userAgent?: string;
}

export interface CommentResponse {
  /** "published", shown at once; or "pending", waiting for the shop to approve it. */
  status: 'published' | 'pending';
}

/**
 * What was wrong with a comment, by field: "author", "email" or "body"; "article" where the
 * article takes no comments, or none is shown at that address.
 */
export interface CommentErrorResponse {
  errors: { field: string; message: string }[];
}
