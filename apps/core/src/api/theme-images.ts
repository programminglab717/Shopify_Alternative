import type { Database } from '@hatti/db';
import { readyImagesIn } from '@hatti/files/public';
import { isUuid, tryFromPublicId } from '@hatti/ids';
import { themesName } from '@hatti/online-store/public';
import { STOREFRONT_API_PREFIX } from '@hatti/storefront-api';
import type { FastifyInstance } from 'fastify';
import type { FileImages } from './file-images.js';

/**
 * Gives storefronts the pictures shops chose for their themes (ADR-326), at
 * `/storefront/shops/{shop}/theme-images/{file}`, for each storefront to serve on the shop's own
 * address: one of the shop's images that one of its themes, published or not, names; with
 * `?preview=1`, for a page in a preview, any of its images, so the theme editor's choice shows
 * before it is saved, sized and in the format the storefront passes on from its browser (ADR-538).
 * Storage stays private: nothing else is given, and the storefront key, which the host
 * application checks first, is needed for this.
 */
export function serveThemeImages(
  fastify: FastifyInstance,
  database: Database,
  images: FileImages,
): void {
  fastify.get(`${STOREFRONT_API_PREFIX}shops/:shop/theme-images/:file`, async (request, reply) => {
    const { shop, file } = request.params as { shop: string; file: string };
    const preview = (request.query as Record<string, unknown>).preview === '1';
    const fileId = tryFromPublicId(file, 'file');
    const image =
      isUuid(shop) && fileId
        ? await database.tenant(shop, async (tx) => {
            const found = (await readyImagesIn(tx, shop, [fileId])).get(fileId);
            return found && (preview || (await themesName(tx, shop, file))) ? found : null;
          })
        : null;
    const width = (request.query as Record<string, unknown>).width;
    const stored = image
      ? await images.shown(
          image,
          typeof width === 'string' ? width : null,
          request.headers.accept,
          request.log,
        )
      : null;
    reply.header('cache-control', 'no-store');
    if (!stored) return reply.code(404).send();
    return reply
      .header('content-type', stored.contentType)
      .header('x-content-type-options', 'nosniff')
      .send(stored.body);
  });
}
