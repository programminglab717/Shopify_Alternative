import type { Database } from '@hatti/db';
import { shopLogoOf } from '@hatti/files/public';
import { isUuid } from '@hatti/ids';
import type { ObjectStorage } from '@hatti/storage';
import type { FastifyInstance, FastifyReply } from 'fastify';

/** Where the API serves each shop's logo (ADR-198): /logos/{shop}. */
export const LOGOS_PATH = 'logos';

/** A logo is the shop's to change: emails and browsers keep it an hour. */
const AN_HOUR = 'public, max-age=3600';

/**
 * Serves each shop's logo at /logos/{shop} (ADR-198), for the emails of its orders' news, which
 * are read long after a signed address of it would lapse: the logo the shop has now, read as the
 * shop. Its storage stays private: only its logo is served here, and nothing for a shop with none.
 */
export function serveLogos(
  fastify: FastifyInstance,
  database: Database,
  storage: ObjectStorage,
): void {
  fastify.get(`/${LOGOS_PATH}/:shop`, async (request, reply) => {
    const { shop } = request.params as { shop: string };
    const logo = isUuid(shop) ? await database.tenant(shop, (tx) => shopLogoOf(tx, shop)) : null;
    const file = logo ? await storage.read(logo.key) : null;
    if (!logo || !file) return notFound(reply);
    return reply
      .header('content-type', logo.contentType)
      .header('cache-control', AN_HOUR)
      .header('x-content-type-options', 'nosniff')
      .header('cross-origin-resource-policy', 'cross-origin')
      .send(file.body);
  });
}

/** No logo: asked again within a minute, the edge answers so itself. */
function notFound(reply: FastifyReply) {
  return reply.code(404).header('cache-control', 'public, max-age=60').send();
}
