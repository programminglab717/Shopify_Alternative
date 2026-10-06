import type { Database } from '@hatti/db';
import { readyImagesIn } from '@hatti/files/public';
import { isUuid } from '@hatti/ids';
import { shopPreferencesOf } from '@hatti/online-store/public';
import type { ObjectStorage } from '@hatti/storage';
import type { FastifyInstance } from 'fastify';

/** Where the API serves each shop's social sharing image (ADR-243): /sharing-images/{shop}. */
export const SHARING_IMAGES_PATH = 'sharing-images';

/** The image is the shop's to change: browsers and the edge keep it an hour. */
const AN_HOUR = 'public, max-age=3600';

/** The path of the shop's social sharing image, naming its file, so that another is fetched anew. */
export function sharingImagePathOf(shopId: string, fileId: string): string {
  return `/${SHARING_IMAGES_PATH}/${shopId}?v=${fileId.slice(0, 8)}`;
}

/**
 * Serves each shop's social sharing image at /sharing-images/{shop} (ADR-243), for the link
 * previews of its pages, which apps such as WhatsApp fetch and keep long after a signed address
 * would lapse: the one the shop has now, read as the shop. Storage stays private: only the image
 * the shop chose is served here, and nothing for a shop with none.
 */
export function serveSharingImages(
  fastify: FastifyInstance,
  database: Database,
  storage: ObjectStorage,
): void {
  fastify.get(`/${SHARING_IMAGES_PATH}/:shop`, async (request, reply) => {
    const { shop } = request.params as { shop: string };
    const image = isUuid(shop)
      ? await database.tenant(shop, async (tx) => {
          const chosen = (await shopPreferencesOf(tx, shop)).sharingImage;
          return chosen && (await readyImagesIn(tx, shop, [chosen.fileId])).get(chosen.fileId);
        })
      : null;
    const file = image ? await storage.read(image.key) : null;
    if (!image || !file) {
      return reply.code(404).header('cache-control', 'public, max-age=60').send();
    }
    return reply
      .header('content-type', image.contentType)
      .header('cache-control', AN_HOUR)
      .header('x-content-type-options', 'nosniff')
      .header('cross-origin-resource-policy', 'cross-origin')
      .send(file.body);
  });
}
