import type { Database } from '@hatti/db';
import { fileVersionOf, readyImagesIn } from '@hatti/files/public';
import { isUuid } from '@hatti/ids';
import { shopPreferencesOf } from '@hatti/online-store/public';
import type { FastifyInstance } from 'fastify';
import type { FileImages } from './file-images.js';

/** Where the API serves each shop's social sharing image (ADR-243): /sharing-images/{shop}. */
export const SHARING_IMAGES_PATH = 'sharing-images';

/** The image is the shop's to change: browsers and the edge keep it an hour. */
const AN_HOUR = 'public, max-age=3600';

/**
 * The path of the shop's social sharing image, naming what its file holds, kept at `key`, so that
 * another, or the file replaced (ADR-647), is fetched anew.
 */
export function sharingImagePathOf(shopId: string, key: string): string {
  return `/${SHARING_IMAGES_PATH}/${shopId}?v=${fileVersionOf(key)}`;
}

/**
 * Serves each shop's social sharing image at /sharing-images/{shop} (ADR-243), for the link
 * previews of its pages, which apps such as WhatsApp fetch and keep long after a signed address
 * would lapse: the one the shop has now, read as the shop. Storage stays private: only the image
 * the shop chose is served here, and nothing for a shop with none.
 * Each is sized and in the format the browser takes, as `?width=` and its Accept header ask
 * (ADR-538).
 */
export function serveSharingImages(
  fastify: FastifyInstance,
  database: Database,
  images: FileImages,
): void {
  fastify.get(`/${SHARING_IMAGES_PATH}/:shop`, async (request, reply) => {
    const { shop } = request.params as { shop: string };
    const image = isUuid(shop)
      ? await database.tenant(shop, async (tx) => {
          const chosen = (await shopPreferencesOf(tx, shop)).sharingImage;
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
