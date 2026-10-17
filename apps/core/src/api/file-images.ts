import {
  CONTENT_TYPES,
  EXTENSIONS,
  formatFor,
  imageVariant,
  widthFor,
  type CleanFormat,
} from '@hatti/images';
import { shownFilePrefixOf } from '@hatti/files/public';
import type { ObjectStorage } from '@hatti/storage';
import type { FastifyBaseLogger } from 'fastify';
import { Turns } from './images.js';

/** Images made at once from shops' files; more wait their turn. */
const MAKING_AT_ONCE = 2;

/**
 * The format a browser that takes neither AVIF nor WebP is given each kind of image in: its own,
 * and PNG for WebP. A GIF, which may move, is given as it is.
 */
const OWN_FORMATS: Readonly<Partial<Record<string, CleanFormat>>> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'png',
};

/** One of a shop's files that is an image, as the routes serving it found it. */
export interface FileImage {
  key: string;
  contentType: string;
}

/**
 * Shops' own images, their logos, articles' and theme pictures and sharing images, as the API
 * serves them (ADR-538): for `?width=`, or a browser that takes AVIF or WebP, made at the next of
 * the widths products' images are made at (ADR-158), in the best format the browser takes, made
 * the first time it is asked for and kept beside the file; else the file as it was uploaded. A
 * GIF is always the file itself, and an image that cannot be read is too.
 */
export class FileImages {
  readonly #making = new Turns(MAKING_AT_ONCE);

  constructor(private readonly storage: ObjectStorage) {}

  /** What to send for `image`, asked for at `width` by a browser sending `accept`; null if none. */
  async shown(
    image: FileImage,
    width: string | null | undefined,
    accept: string | undefined,
    log?: Pick<FastifyBaseLogger, 'warn'>,
  ): Promise<{ body: Buffer; contentType: string } | null> {
    const own = OWN_FORMATS[image.contentType];
    const asked = Number(width);
    const size = own && Number.isInteger(asked) && asked > 0 ? widthFor(asked) : null;
    const format = own ? formatFor(accept, own) : null;
    if (!format || (size === null && CONTENT_TYPES[format] === image.contentType)) {
      return this.#original(image);
    }
    const key = `${shownFilePrefixOf(image.key)}${size ?? 'full'}.${EXTENSIONS[format]}`;
    const kept = await this.storage.read(key);
    if (kept) return { body: kept.body, contentType: CONTENT_TYPES[format] };
    const source = await this.storage.read(image.key);
    if (!source) return null;
    let body: Buffer;
    try {
      body = await this.#making.take(() => imageVariant(source.body, size, format));
    } catch (error) {
      // An image its decoder cannot read is shown as it was uploaded, as before.
      log?.warn({ err: error, key: image.key }, 'file image not resized');
      return { body: source.body, contentType: image.contentType };
    }
    // Kept for the next who asks; made again if it could not be.
    await this.storage.put(key, body, CONTENT_TYPES[format]).catch((error: unknown) => {
      log?.warn({ err: error, key }, 'file image variant not kept');
    });
    return { body, contentType: CONTENT_TYPES[format] };
  }

  async #original(image: FileImage): Promise<{ body: Buffer; contentType: string } | null> {
    const file = await this.storage.read(image.key);
    return file && { body: file.body, contentType: image.contentType };
  }
}
