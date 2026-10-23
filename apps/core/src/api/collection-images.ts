import { collectionImageOf } from '@hatti/catalog/public';
import type { Database } from '@hatti/db';
import { fileVersionOf, readyImagesIn } from '@hatti/files/public';
import { isUuid } from '@hatti/ids';
import type { FastifyInstance } from 'fastify';
import type { FileImages } from './file-images.js';

/** Where the API serves each collection's image (ADR-785): /collection-images/{shop}/{collection}. */
export const COLLECTION_IMAGES_PATH = 'collection-images';

/** A collection's image is the shop's to change: browsers and the edge keep it an hour. */
const AN_HOUR = 'public, max-age=3600';

/**
 * The path of a collection's image, naming what its file holds, kept at `key`, so that another,
 * or the file replaced (ADR-647), is fetched anew.
 */
export function collectionImagePathOf(shopId: string, collectionId: string, key: string): string {
  return `/${COLLECTION_IMAGES_PATH}/${shopId}/${collectionId}?v=${fileVersionOf(key)}`;
}

/**
 * Serves each collection's image at /collection-images/{shop}/{collection} (ADR-785), for its
 * storefront's pages, as articles' are served (ADR-213): the one the collection has now, read as
 * the shop, sized and in the format the browser takes (ADR-538). Storage stays private: only
 * collections' images are served here, and nothing for one without.
 */
export function serveCollectionImages(
  fastify: FastifyInstance,
  database: Database,
  images: FileImages,
): void {
  fastify.get(`/${COLLECTION_IMAGES_PATH}/:shop/:collection`, async (request, reply) => {
    const { shop, collection } = request.params as { shop: string; collection: string };
    const image =
      isUuid(shop) && isUuid(collection)
        ? await database.tenant(shop, async (tx) => {
            const chosen = await collectionImageOf(tx, shop, collection);
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
