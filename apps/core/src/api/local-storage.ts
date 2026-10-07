import { LocalStorage, MAX_VIDEO_UPLOAD_BYTES, inlineDisposition } from '@hatti/storage';
import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * Serves local storage at `prefix`, as R2 serves its bucket (ADR-079): a file is uploaded and
 * read only through a URL the storage signed, an upload only of the size and type it was signed
 * for. For development and tests; production's files are R2's to serve.
 */
export async function serveLocalStorage(
  fastify: FastifyInstance,
  storage: LocalStorage,
  prefix: string,
): Promise<void> {
  await fastify.register(async (scope) => {
    // Uploads are the bytes themselves, of whatever type and size were signed for: a video's the
    // largest.
    scope.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: MAX_VIDEO_UPLOAD_BYTES },
      (_request, body, done) => done(null, body),
    );

    scope.put(`${prefix}/*`, { bodyLimit: MAX_VIDEO_UPLOAD_BYTES }, async (request, reply) => {
      const target = targetOf(request.url, prefix);
      const grant = target && storage.verify('PUT', target.key, target.query);
      if (!target || grant?.method !== 'PUT') return denied(reply);
      const body = request.body;
      if (
        request.headers['content-type'] !== grant.contentType ||
        !Buffer.isBuffer(body) ||
        body.length !== grant.contentLength
      ) {
        return denied(reply);
      }
      await storage.put(target.key, body, grant.contentType);
      return reply.code(200).send();
    });

    scope.get(`${prefix}/*`, async (request, reply) => {
      const target = targetOf(request.url, prefix);
      const grant = target && storage.verify('GET', target.key, target.query);
      if (!target || grant?.method !== 'GET') return denied(reply);
      const file = await storage.read(target.key);
      if (!file) return reply.code(404).send();
      return reply
        .header('content-type', file.contentType ?? 'application/octet-stream')
        .header(
          'content-disposition',
          inlineDisposition(grant.filename ?? target.key.split('/').at(-1)!),
        )
        .header('cache-control', 'private, max-age=3600')
        .header('x-content-type-options', 'nosniff')
        .send(file.body);
    });
  });
}

/**
 * The key and query of a storage URL, as it was signed; null when its path isn't a key, or a
 * field of its query comes twice.
 */
function targetOf(
  url: string,
  prefix: string,
): { key: string; query: Record<string, string> } | null {
  const [path = '', search = ''] = url.split('?', 2);
  if (!path.startsWith(`${prefix}/`)) return null;
  let key: string;
  try {
    key = decodeURIComponent(path.slice(prefix.length + 1));
  } catch {
    return null;
  }
  const query: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(search)) {
    if (Object.hasOwn(query, name)) return null;
    query[name] = value;
  }
  return { key, query };
}

function denied(reply: FastifyReply) {
  return reply.code(403).send({ error: 'This URL is not signed for that, or it expired' });
}
