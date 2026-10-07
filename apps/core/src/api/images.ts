import {
  IMAGES_PATH,
  cleanImageKey,
  parseImagePath,
  shownImagesPrefixOf,
} from '@hatti/catalog/public';
import { CONTENT_TYPES, EXTENSIONS, formatFor, imageVariant, widthFor } from '@hatti/images';
import type { ObjectStorage } from '@hatti/storage';
import { imageTag } from '@hatti/storefront-data';
import type { FastifyInstance, FastifyReply } from 'fastify';

/** An image's address never shows another: browsers and the edge keep it a year. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Images made at once; more wait their turn, so a page of new ones never starves the API. */
const MAKING_AT_ONCE = 2;

/**
 * Serves products' images (ADR-158) at /images/{shop}/{media}/{name}.jpg: the clean copy the
 * worker kept, or, for `?width=` or a browser that takes AVIF or WebP, that copy made at the next
 * of the widths images are made at, in the best format the browser's Accept header names. Each
 * size and format is made the first time it is asked for and kept beside the clean copy, so it is
 * made once; the edge keeps every answer a year, varying by Accept, tagged with the image so its
 * removal forgets it. A crop (ADR-257), at /images/{shop}/{media}/{crop}/{name}.jpg, is served
 * the same way from its own clean copy, which only cropping the image makes: no other crop is
 * made here. The storage's own files stay private: only images' clean copies, and what is made of
 * them, are served here.
 */
export function serveImages(fastify: FastifyInstance, storage: ObjectStorage): void {
  const making = new Turns(MAKING_AT_ONCE);
  fastify.get(`${IMAGES_PATH}/*`, async (request, reply) => {
    const [path = '', search = ''] = request.url.split('?', 2);
    const image = parseImagePath(path);
    if (!image) return notFound(reply);
    const asked = Number(new URLSearchParams(search).get('width'));
    const width = Number.isInteger(asked) && asked > 0 ? widthFor(asked) : null;
    const format = formatFor(request.headers.accept, image.format);
    const clean = cleanImageKey(image.shopId, image.mediaId, image.format, image.crop);
    const key =
      width === null && format === image.format
        ? clean
        : `${shownImagesPrefixOf(image.shopId, image.mediaId, image.crop)}${width ?? 'full'}.${EXTENSIONS[format]}`;
    let body = (await storage.read(key))?.body ?? null;
    if (!body && key !== clean) {
      const source = await storage.read(clean);
      if (!source) return notFound(reply);
      body = await making.take(() => imageVariant(source.body, width, format));
      // Kept for the next who asks; made again if it could not be.
      await storage.put(key, body, CONTENT_TYPES[format]).catch((error: unknown) => {
        request.log.warn({ err: error, key }, 'image variant not kept');
      });
    }
    if (!body) return notFound(reply);
    return reply
      .header('content-type', CONTENT_TYPES[format])
      .header('cache-control', IMMUTABLE)
      .header('vary', 'Accept')
      .header('cache-tag', imageTag(image.shopId, image.mediaId))
      .header('x-content-type-options', 'nosniff')
      .header('cross-origin-resource-policy', 'cross-origin')
      .send(body);
  });
}

/** No such image: asked again within a minute, the edge answers so itself. */
function notFound(reply: FastifyReply) {
  return reply.code(404).header('cache-control', 'public, max-age=60').send();
}

/** Lets `size` tasks run at once; the rest wait, first come, first served. */
class Turns {
  #running = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(private readonly size: number) {}

  async take<T>(task: () => Promise<T>): Promise<T> {
    if (this.#running < this.size) this.#running += 1;
    // A turn ending hands its place to the first waiting.
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#running -= 1;
    }
  }
}
