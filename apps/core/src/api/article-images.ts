import type { Database } from '@hatti/db';
import { fileVersionOf, readyImagesIn } from '@hatti/files/public';
import { isUuid } from '@hatti/ids';
import { publishedArticleImageOf } from '@hatti/online-store/public';
import type { FastifyInstance } from 'fastify';
import type { FileImages } from './file-images.js';

/** Where the API serves each published article's image (ADR-213): /article-images/{shop}/{article}. */
export const ARTICLE_IMAGES_PATH = 'article-images';

/** An article's image is the shop's to change: browsers and the edge keep it an hour. */
const AN_HOUR = 'public, max-age=3600';

/**
 * The path of an article's image, naming what its file holds, kept at `key`, so that another, or
 * the file replaced (ADR-647), is fetched anew.
 */
export function articleImagePathOf(shopId: string, articleId: string, key: string): string {
  return `/${ARTICLE_IMAGES_PATH}/${shopId}/${articleId}?v=${fileVersionOf(key)}`;
}

/**
 * Serves each published article's image at /article-images/{shop}/{article} (ADR-213), for its
 * storefront's pages, which the edge keeps long after a signed address would lapse: the one the
 * article has now, read as the shop. Storage stays private: only articles' images are served
 * here, while their articles are published, and nothing for one without.
 * Each is sized and in the format the browser takes, as `?width=` and its Accept header ask
 * (ADR-538).
 */
export function serveArticleImages(
  fastify: FastifyInstance,
  database: Database,
  images: FileImages,
): void {
  fastify.get(`/${ARTICLE_IMAGES_PATH}/:shop/:article`, async (request, reply) => {
    const { shop, article } = request.params as { shop: string; article: string };
    const image =
      isUuid(shop) && isUuid(article)
        ? await database.tenant(shop, async (tx) => {
            const chosen = await publishedArticleImageOf(tx, shop, article);
            return chosen && (await readyImagesIn(tx, shop, [chosen.fileId])).get(chosen.fileId);
          })
        : null;
    const { width } = request.query as { width?: string };
    const file = image
      ? await images.shown(image, width, request.headers.accept, request.log)
      : null;
    if (!file) {
      return reply.code(404).header('cache-control', 'public, max-age=60').send();
    }
    return reply
      .header('content-type', file.contentType)
      .header('cache-control', AN_HOUR)
      .header('vary', 'Accept')
      .header('x-content-type-options', 'nosniff')
      .header('cross-origin-resource-policy', 'cross-origin')
      .send(file.body);
  });
}
