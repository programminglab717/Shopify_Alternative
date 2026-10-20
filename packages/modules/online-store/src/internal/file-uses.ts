import type { Tx } from '@hatti/db';
import { and, asc, eq, exists, sql } from 'drizzle-orm';
import { articles, preferences, themeFiles, themes } from './schema.js';

/** Where the online store uses one of the shop's files (ADR-639). */
export type OnlineStoreFileUse =
  | { kind: 'sharing_image' }
  | { kind: 'article_image'; id: string; blogId: string; title: string }
  | { kind: 'theme'; id: string; title: string };

/**
 * Where the online store uses the shop's file `fileId`, whose public ID is `publicId` (ADR-639):
 * as the sharing image of its pages, as articles' images, and in themes whose settings name its
 * theme-images address (ADR-326), as `themesName` finds them; articles and themes by title.
 */
export async function onlineStoreUsesOf(
  tx: Tx,
  shopId: string,
  fileId: string,
  publicId: string,
): Promise<OnlineStoreFileUse[]> {
  const [shared] = await tx
    .select({ shopId: preferences.shopId })
    .from(preferences)
    .where(and(eq(preferences.shopId, shopId), eq(preferences.sharingImageId, fileId)));
  const pictured = await tx
    .select({ id: articles.id, blogId: articles.blogId, title: articles.title })
    .from(articles)
    .where(and(eq(articles.shopId, shopId), eq(articles.imageFileId, fileId)))
    .orderBy(asc(articles.title), asc(articles.id));
  const naming = await tx
    .select({ id: themes.id, title: themes.name })
    .from(themes)
    .where(
      and(
        eq(themes.shopId, shopId),
        exists(
          tx
            .select({ one: sql`1` })
            .from(themeFiles)
            .where(
              and(
                eq(themeFiles.shopId, themes.shopId),
                eq(themeFiles.themeId, themes.id),
                sql`strpos(${themeFiles.body}, ${publicId}) > 0`,
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(themes.name), asc(themes.id));
  return [
    ...(shared ? [{ kind: 'sharing_image' as const }] : []),
    ...pictured.map((article) => ({ kind: 'article_image' as const, ...article })),
    ...naming.map((theme) => ({ kind: 'theme' as const, ...theme })),
  ];
}
