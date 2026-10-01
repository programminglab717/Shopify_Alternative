import type { FormFile } from '@hatti/api';
import Busboy from 'busboy';
import type { FastifyInstance } from 'fastify';

export interface FileFormOptions {
  /** The paths whose forms may carry a file, such as "/o/": no other takes one. */
  paths: readonly string[];
  /** The most a file may weigh; beyond it, the file comes cut off and marked so. */
  maxFileBytes: number;
}

/**
 * Reads forms that carry a file (multipart/form-data), on `paths` alone: customers' pages have no
 * scripts, so a receipt comes in a form rather than straight to storage. Each field becomes a
 * string and the file a {@link FormFile}, in memory, so one file a form, and a few fields.
 */
export function readFileForms(fastify: FastifyInstance, options: FileFormOptions): void {
  fastify.addContentTypeParser('multipart/form-data', (request, payload, done) => {
    if (!options.paths.some((path) => request.url.startsWith(path))) {
      done(Object.assign(new Error('This page takes no files'), { statusCode: 415 }), undefined);
      return;
    }
    let settled = false;
    const finish = (error: Error | null, body?: Record<string, string | FormFile>) => {
      if (settled) return;
      settled = true;
      done(error && Object.assign(error, { statusCode: 400 }), body);
    };
    let busboy: Busboy.Busboy;
    try {
      busboy = Busboy({
        headers: request.headers,
        limits: {
          fileSize: options.maxFileBytes,
          files: 1,
          fields: 10,
          fieldSize: 4096,
          parts: 11,
        },
      });
    } catch (error) {
      finish(error as Error);
      return;
    }
    const body: Record<string, string | FormFile> = {};
    busboy.on('field', (name, value) => {
      body[name] = value;
    });
    busboy.on('file', (name, stream, info) => {
      const chunks: Buffer[] = [];
      let truncated = false;
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      // Past the limit the rest is read and dropped, so the page can say the file is too large.
      stream.on('limit', () => {
        truncated = true;
      });
      stream.on('end', () => {
        body[name] = {
          filename: info.filename,
          mimeType: info.mimeType,
          data: Buffer.concat(chunks),
          truncated,
        };
      });
    });
    // Busboy finishes once every file has ended; it may close after an error, too.
    busboy.on('finish', () => finish(null, body));
    busboy.on('error', (error) => finish(error as Error));
    payload.on('error', (error) => finish(error));
    payload.pipe(busboy);
  });
}
