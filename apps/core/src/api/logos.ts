import type { Database } from '@hatti/db';
import {
  fileVersionOf,
  shopLogoOf,
  type BrandImageValue,
  type ShopLogo,
} from '@hatti/files/public';
import { isUuid } from '@hatti/ids';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { FileImages } from './file-images.js';

/**
 * Where the API serves each shop's logo (ADR-198): /logos/{shop}; and its square logo
 * (ADR-205): /logos/{shop}/square.
 */
export const LOGOS_PATH = 'logos';

/** A logo is the shop's to change: emails and browsers keep it an hour. */
const AN_HOUR = 'public, max-age=3600';

/**
 * The path of the shop's logo or square logo, naming what its file holds, so that another, or the
 * file replaced (ADR-647), is fetched anew.
 */
export function logoPathOf(shopId: string, which: BrandImageValue, logo: ShopLogo): string {
  const square = which === 'squareLogo' ? '/square' : '';
  return `/${LOGOS_PATH}/${shopId}${square}?v=${fileVersionOf(logo.key)}`;
}

/**
 * Serves each shop's logo at /logos/{shop} (ADR-198), for the emails of its orders' news, which
 * are read long after a signed address of it would lapse, and its square logo at
 * /logos/{shop}/square, for its link page (ADR-205): the one the shop has now, read as the shop.
 * Its storage stays private: only its logos are served here, and nothing for a shop with none.
 * Each is sized and in the format the browser takes, as `?width=` and its Accept header ask
 * (ADR-538).
 */
export function serveLogos(fastify: FastifyInstance, database: Database, images: FileImages): void {
  const routes: [string, BrandImageValue][] = [
    [`/${LOGOS_PATH}/:shop`, 'logo'],
    [`/${LOGOS_PATH}/:shop/square`, 'squareLogo'],
  ];
  for (const [path, which] of routes) {
    fastify.get(path, async (request, reply) => {
      const { shop } = request.params as { shop: string };
      const logo = isUuid(shop)
        ? await database.tenant(shop, (tx) => shopLogoOf(tx, shop, which))
        : null;
      const { width } = request.query as { width?: string };
      const file = logo
        ? await images.shown(logo, width, request.headers.accept, request.log)
        : null;
      if (!file) return notFound(reply);
      return reply
        .header('content-type', file.contentType)
        .header('cache-control', AN_HOUR)
        .header('vary', 'Accept')
        .header('x-content-type-options', 'nosniff')
        .header('cross-origin-resource-policy', 'cross-origin')
        .send(file.body);
    });
  }
}

/** No logo: asked again within a minute, the edge answers so itself. */
function notFound(reply: FastifyReply) {
  return reply.code(404).header('cache-control', 'public, max-age=60').send();
}
