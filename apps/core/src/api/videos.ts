import { VIDEOS_PATH, parseVideoPath, videoKeyOf } from '@hatti/catalog/public';
import type { ByteRange, ObjectStorage } from '@hatti/storage';
import { imageTag } from '@hatti/storefront-data';
import type { FastifyInstance, FastifyReply } from 'fastify';

/** A video's address never shows another: browsers and the edge keep it a year. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * Serves the videos shops uploaded for their products (ADR-258) at
 * /videos/{shop}/{media}/{name}.mp4: the clean copy the worker kept, whole, or the range of it a
 * browser asks for as it plays, read from storage as it is sent and never held whole. Kept a year
 * by browsers and the edge, tagged with the media as its images are, so its removal forgets it.
 * Nothing else of storage is served here.
 */
export function serveVideos(fastify: FastifyInstance, storage: ObjectStorage): void {
  fastify.get(`${VIDEOS_PATH}/*`, async (request, reply) => {
    const [path = ''] = request.url.split('?', 1);
    const video = parseVideoPath(path);
    if (!video) return notFound(reply);
    const key = videoKeyOf(video.shopId, video.mediaId);
    const stored = await storage.head(key);
    if (!stored || stored.size === 0) return notFound(reply);
    const range = rangeOf(request.headers.range, stored.size);
    if (range === 'unsatisfiable') {
      return reply
        .code(416)
        .header('content-range', `bytes */${stored.size}`)
        .header('cache-control', 'public, max-age=60')
        .send();
    }
    const body = await storage.stream(key, range ?? undefined);
    if (!body) return notFound(reply);
    reply
      .header('content-type', 'video/mp4')
      .header('accept-ranges', 'bytes')
      .header('cache-control', IMMUTABLE)
      .header('cache-tag', imageTag(video.shopId, video.mediaId))
      .header('x-content-type-options', 'nosniff')
      .header('cross-origin-resource-policy', 'cross-origin');
    if (range) {
      reply
        .code(206)
        .header('content-range', `bytes ${range.start}-${range.end}/${stored.size}`)
        .header('content-length', String(range.end - range.start + 1));
    } else {
      reply.header('content-length', String(stored.size));
    }
    return reply.send(body);
  });
}

/**
 * The bytes a Range header asks of a file of `size`: one range, as browsers' players ask, its end
 * kept to the file's; null for the whole, as for no header or one Hatti does not read, such as
 * several ranges at once; unsatisfiable where it starts past the end.
 */
export function rangeOf(
  header: string | undefined,
  size: number,
): ByteRange | null | 'unsatisfiable' {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (match[1] === '') {
    // The last so many bytes.
    const length = Number(match[2]);
    if (length === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size) return 'unsatisfiable';
  if (end < start) return null;
  return { start, end };
}

/** No such video: asked again within a minute, the edge answers so itself. */
function notFound(reply: FastifyReply) {
  return reply.code(404).header('cache-control', 'public, max-age=60').send();
}
