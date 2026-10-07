import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32, deflateSync } from 'node:zlib';
import sharp, { type Sharp } from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_IMAGE_SIDE, cleanImage, cropImage } from './clean.js';
import { ImageFetcher, isPublicAddress } from './fetch.js';
import { sniffImage } from './formats.js';
import { IMAGE_WIDTHS, formatFor, imageVariant, widthFor } from './variants.js';
import { MAX_VIDEO_BYTES, cleanVideo } from './videos.js';

/** A photo-like image: `width` × `height`, red to blue, opaque unless `alpha` says. */
async function photo(
  width: number,
  height: number,
  format: 'jpeg' | 'png' | 'webp' | 'gif' | 'avif' = 'jpeg',
  alpha?: number,
): Promise<Sharp> {
  const channels = alpha === undefined ? 3 : 4;
  const raw = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * channels;
      raw[at] = Math.round((255 * x) / width);
      raw[at + 1] = 90;
      raw[at + 2] = Math.round((255 * y) / height);
      if (alpha !== undefined) raw[at + 3] = alpha;
    }
  }
  return sharp(raw, { raw: { width, height, channels } }).toFormat(format);
}

const bytes = (...values: (number | string)[]) =>
  Buffer.concat(values.map((value) => Buffer.from(typeof value === 'string' ? value : [value])));

describe('image kinds', () => {
  it('are told by their first bytes', async () => {
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg');
    expect(sniffImage(bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a))).toBe('png');
    expect(sniffImage(bytes('GIF89a'))).toBe('gif');
    expect(sniffImage(bytes('RIFF', 0x24, 0, 0, 0, 'WEBPVP8 '))).toBe('webp');
    expect(sniffImage(await (await photo(8, 8, 'avif')).toBuffer())).toBe('avif');
    // An iPhone's photo: HEIF, its brand "heic", compatible with "mif1".
    expect(sniffImage(bytes(0, 0, 0, 24, 'ftypheic', 0, 0, 0, 0, 'mif1heic'))).toBe('heic');
    for (const start of [
      bytes('%PDF-1.7'),
      bytes('RIFF', 0x24, 0, 0, 0, 'WAVE'),
      bytes(0, 0, 0, 20, 'ftypisom', 0, 0, 0, 0, 'mp41'),
      bytes('<svg'),
      Buffer.alloc(0),
    ]) {
      expect(sniffImage(start)).toBeNull();
    }
  });
});

describe('clean copies', () => {
  it('are turned as the camera was held, without metadata, in JPEG at their own size', async () => {
    // A phone's photo, held upright: 300 × 200 as stored, turned 90° to be shown, and where it
    // was taken in its metadata.
    const taken = await (
      await photo(300, 200)
    )
      .withMetadata({ orientation: 6 })
      .withExifMerge({
        IFD0: { Make: 'Phone' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '24/1 51/1 36/1' },
      })
      .toBuffer();
    expect(await sharp(taken).metadata()).toMatchObject({
      orientation: 6,
      exif: expect.any(Buffer),
    });
    const result = await cleanImage(taken);
    expect(result).toMatchObject({ ok: true, image: { format: 'jpeg', width: 200, height: 300 } });
    const clean = result.ok ? result.image.body : Buffer.alloc(0);
    const metadata = await sharp(clean).metadata();
    expect([metadata.format, metadata.exif, metadata.orientation, metadata.icc]).toEqual([
      'jpeg',
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('are made at most 4,096 pixels a side, and never larger than they were', async () => {
    const large = await cleanImage(await (await photo(5000, 2500)).toBuffer());
    expect(large).toMatchObject({
      ok: true,
      image: { width: MAX_IMAGE_SIDE, height: MAX_IMAGE_SIDE / 2 },
    });
    const small = await cleanImage(await (await photo(64, 48, 'webp')).toBuffer());
    expect(small).toMatchObject({ ok: true, image: { format: 'jpeg', width: 64, height: 48 } });
  });

  it('keep what is see-through as PNG, and make the rest of PNGs and GIFs JPEG', async () => {
    const clear = await cleanImage(await (await photo(40, 30, 'png', 128)).toBuffer());
    expect(clear).toMatchObject({ ok: true, image: { format: 'png', width: 40, height: 30 } });
    expect((await sharp(clear.ok ? clear.image.body : Buffer.alloc(0)).metadata()).hasAlpha).toBe(
      true,
    );
    const solid = await cleanImage(await (await photo(40, 30, 'png', 255)).toBuffer());
    expect(solid).toMatchObject({ ok: true, image: { format: 'jpeg' } });
    const gif = await cleanImage(await (await photo(40, 30, 'gif')).toBuffer());
    expect(gif).toMatchObject({ ok: true, image: { format: 'jpeg', width: 40, height: 30 } });
  });

  it('refuse what is not an image, or not one to show, saying why', async () => {
    const problemOf = async (input: Buffer) => {
      const result = await cleanImage(input);
      return result.ok ? null : result.problem;
    };
    expect(await problemOf(Buffer.from('%PDF-1.7 a receipt'))).toEqual({
      code: 'UNSUPPORTED_IMAGE_FILE_TYPE',
      message: 'It is not a JPEG, PNG, WebP, GIF or AVIF image',
    });
    expect(await problemOf(bytes(0, 0, 0, 24, 'ftypheic', 0, 0, 0, 0, 'mif1heic'))).toEqual({
      code: 'UNSUPPORTED_IMAGE_FILE_TYPE',
      message: 'HEIC photos cannot be shown on the web: save it as a JPEG and add it again',
    });
    expect((await problemOf(Buffer.alloc(21 * 1024 * 1024)))?.code).toBe('INVALID_IMAGE_FILE_SIZE');
    // Its header says 10,000 × 6,000: refused before anything is decoded.
    expect(await problemOf(pngOf(10_000, 6_000))).toEqual({
      code: 'INVALID_IMAGE_RESOLUTION',
      message: 'The image is 10000 × 6000 pixels; it may have 50 megapixels at most',
    });
    expect(await problemOf(await (await photo(2100, 100)).toBuffer())).toEqual({
      code: 'INVALID_IMAGE_ASPECT_RATIO',
      message: 'The image is 2100 × 100 pixels; one side may be at most 20 times the other',
    });
    // A JPEG cut short.
    const whole = await (await photo(400, 300)).toBuffer();
    expect((await problemOf(whole.subarray(0, 600)))?.code).toBe('IMAGE_PROCESSING_FAILURE');
  });
});

describe('variants', () => {
  it('are made at the next of a few widths, in the format the browser takes', async () => {
    expect([1, 96, 97, 165, 533, 1100, 2048, 5000].map(widthFor)).toEqual([
      96, 96, 192, 192, 540, 1200, 2048, 2048,
    ]);
    expect(IMAGE_WIDTHS.every((width, index) => index === 0 || width > IMAGE_WIDTHS[index - 1]!));
    const chrome = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
    const safari = 'image/webp,image/avif,video/*;q=0.8,image/png,image/svg+xml,image/*;q=0.8';
    expect(formatFor(chrome, 'jpeg')).toBe('avif');
    expect(formatFor(safari, 'png')).toBe('avif');
    expect(formatFor('image/webp,*/*', 'jpeg')).toBe('webp');
    expect(formatFor('image/avif;q=0, image/webp', 'jpeg')).toBe('webp');
    // A crawler fetching a link's preview: the clean copy's own format.
    expect(formatFor('*/*', 'jpeg')).toBe('jpeg');
    expect(formatFor(undefined, 'png')).toBe('png');

    const clean = await (await photo(800, 600)).toBuffer();
    for (const [width, format, size] of [
      [360, 'avif', [360, 270]],
      [540, 'webp', [540, 405]],
      [1200, 'jpeg', [800, 600]],
      [null, 'png', [800, 600]],
    ] as const) {
      const variant = await imageVariant(clean, width, format);
      const metadata = await sharp(variant).metadata();
      expect([metadata.format, metadata.width, metadata.height]).toEqual([
        format === 'avif' ? 'heif' : format,
        ...size,
      ]);
    }
  });
});

describe('crops', () => {
  it("keep the part asked for, in the clean copy's format (ADR-257)", async () => {
    // Red grows across and blue down: a part's first pixel says where it was taken from.
    const clean = await (await photo(800, 600)).jpeg({ quality: 100 }).toBuffer();
    const part = await cropImage(clean, { left: 400, top: 300, width: 200, height: 100 }, 'jpeg');
    expect((await sharp(part).metadata()).format).toBe('jpeg');
    const { data, info } = await sharp(part).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([200, 100]);
    // Half way across and half way down the whole.
    expect(Math.abs(data[0]! - 128)).toBeLessThan(8);
    expect(Math.abs(data[2]! - 128)).toBeLessThan(8);
    // What is see-through stays so.
    const seeThrough = await (await photo(100, 100, 'png', 128)).toBuffer();
    const kept = await cropImage(seeThrough, { left: 50, top: 0, width: 50, height: 40 }, 'png');
    const metadata = await sharp(kept).metadata();
    expect([metadata.format, metadata.width, metadata.height, metadata.hasAlpha]).toEqual([
      'png',
      50,
      40,
      true,
    ]);
  });
});

describe('videos', () => {
  /** A box of `type` holding `parts`. */
  const box = (type: string, ...parts: Buffer[]) => {
    const body = Buffer.concat(parts);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + body.length);
    header.write(type, 4, 'latin1');
    return Buffer.concat([header, body]);
  };
  const u32 = (...values: number[]) =>
    Buffer.concat(
      values.map((value) => {
        const bytes = Buffer.alloc(4);
        bytes.writeInt32BE(value | 0);
        return bytes;
      }),
    );
  // QuickTime's own boxes of what a video says of itself start with the copyright sign.
  const QUICKTIME = String.fromCharCode(0xa9);
  const IDENTITY = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
  // A phone held upright: the frame turned a quarter.
  const UPRIGHT = [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000];
  const track = (handler: string, codec: string, width = 0, height = 0, matrix = IDENTITY) =>
    box(
      'trak',
      box(
        'tkhd',
        u32(0, 0, 0, 1, 0, 0),
        Buffer.alloc(16),
        u32(...matrix),
        u32(width << 16, height << 16),
      ),
      box(
        'mdia',
        box('mdhd', Buffer.alloc(24)),
        box('hdlr', u32(0, 0), Buffer.from(handler, 'latin1'), Buffer.alloc(12)),
        box('minf', box('stbl', box('stsd', u32(0, 1), box(codec, Buffer.alloc(78))))),
      ),
      box('udta', box(`${QUICKTIME}nam`, Buffer.from('Camera'))),
    );
  /** A phone's video: where it was taken in its movie's metadata, and a track of timed metadata. */
  const phoneVideo = (
    options: {
      brand?: string;
      video?: string;
      sound?: string;
      seconds?: number;
      matrix?: number[];
    } = {},
  ) =>
    Buffer.concat([
      box(
        'ftyp',
        Buffer.from(options.brand ?? 'qt  ', 'latin1'),
        u32(0),
        Buffer.from('qt  ', 'latin1'),
      ),
      box('wide'),
      box('mdat', Buffer.from('frames and sound')),
      box(
        'moov',
        box('mvhd', u32(0, 0, 0, 600, 600 * (options.seconds ?? 12)), Buffer.alloc(80)),
        track('vide', options.video ?? 'avc1', 1920, 1080, options.matrix ?? UPRIGHT),
        track('soun', options.sound ?? 'mp4a'),
        track('meta', 'mebx'),
        box(
          'meta',
          box('keys', Buffer.from('com.apple.quicktime.location.ISO6709')),
          box('ilst', Buffer.from('+24.8607+067.0011/')),
        ),
        box('udta', box(`${QUICKTIME}xyz`, Buffer.from('+24.8607+067.0011/'))),
      ),
    ]);

  it("keeps phones' H.264 videos as they are but for where they were taken (ADR-258)", () => {
    const uploaded = phoneVideo();
    const length = uploaded.length;
    const kept = cleanVideo(Buffer.from(uploaded));
    if (!kept.ok) throw new Error(kept.problem.message);
    // As held: tall. Twelve seconds.
    expect([kept.video.width, kept.video.height, kept.video.durationMs]).toEqual([
      1080, 1920, 12_000,
    ]);
    expect(kept.video.body.length).toBe(length);
    const latin = kept.video.body.toString('latin1');
    expect(latin).not.toContain('+24.8607');
    expect(latin).not.toContain('com.apple.quicktime.location');
    expect(latin).not.toContain('mebx');
    // The frames, the video's and sound's own tracks, where they were.
    expect(latin.indexOf('frames and sound')).toBe(
      uploaded.toString('latin1').indexOf('frames and sound'),
    );
    expect(latin).toContain('avc1');
    expect(latin).toContain('mp4a');
    // Held level, as made: wide.
    const level = cleanVideo(phoneVideo({ brand: 'isom', matrix: IDENTITY }));
    expect(level.ok && [level.video.width, level.video.height]).toEqual([1920, 1080]);
  });

  it('refuses what browsers cannot play as it is, or what is not a whole video, saying why', () => {
    const refused = (bytes: Buffer) => {
      const result = cleanVideo(bytes);
      return result.ok ? null : result.problem;
    };
    expect(refused(phoneVideo({ video: 'hvc1' }))).toEqual({
      code: 'VIDEO_INVALID_FILETYPE_ERROR',
      message:
        'It is HEVC video, which many browsers cannot play: record or export it as H.264, ' +
        '"Most Compatible" in an iPhone\'s camera formats, and add it again',
    });
    expect(refused(phoneVideo({ sound: 'ac-3' }))?.message).toBe(
      'Its sound is ac-3, not AAC: export it again as MP4 with AAC sound',
    );
    expect(refused(phoneVideo({ seconds: 11 * 60 }))).toEqual({
      code: 'VIDEO_MAX_DURATION_ERROR',
      message: 'The video lasts 11 minutes; it may last 10 minutes at most',
    });
    // Cut short before its index; a photo; nothing like a video.
    const whole = phoneVideo();
    expect(refused(whole.subarray(0, whole.indexOf(Buffer.from('moov', 'latin1')) - 4))?.code).toBe(
      'VIDEO_METADATA_READ_ERROR',
    );
    expect(refused(whole.subarray(0, whole.length - 10))?.code).toBe('VIDEO_METADATA_READ_ERROR');
    expect(refused(Buffer.from('<html>not a video</html>'))?.code).toBe(
      'VIDEO_INVALID_FILETYPE_ERROR',
    );
    expect(refused(Buffer.alloc(MAX_VIDEO_BYTES + 1))?.code).toBe('GENERIC_FILE_INVALID_SIZE');
  });
});

describe('fetching images', () => {
  it('reaches public addresses alone', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.10',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:a9fe:a9fe',
      '::127.0.0.1',
      '64:ff9b::a00:1',
      '2002:a00:1::',
      'not-an-address',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it('refuses private hosts, plain http and passwords before it connects', async () => {
    const fetcher = new ImageFetcher({
      resolve: async () => [{ address: '10.0.0.7', family: 4 }],
    });
    const PRIVATE = 'Its address is on a private network, which Hatti does not fetch from';
    for (const [url, message] of [
      ['https://169.254.169.254/latest/meta-data/', PRIVATE],
      ['https://[::ffff:127.0.0.1]/a.jpg', PRIVATE],
      ['https://2130706433/a.jpg', PRIVATE],
      // A name that resolves to a private address.
      ['https://images.example.pk/a.jpg', PRIVATE],
      ['http://images.example.pk/a.jpg', 'Only https addresses are fetched'],
      ['https://user:secret@images.example.pk/a.jpg', 'An address with a password is not fetched'],
      ['not a url', 'It is not a URL'],
    ]) {
      expect(await fetcher.fetch(url!), url).toEqual({
        ok: false,
        transient: false,
        code: 'IMAGE_DOWNLOAD_FAILURE',
        message,
      });
    }
  });

  describe('from a server', () => {
    let server: Server;
    let port: number;
    const image = Buffer.from('the image');

    beforeAll(async () => {
      server = createServer((request, response) => {
        const path = request.url ?? '/';
        if (path === '/image.jpg') {
          response.writeHead(200, { 'content-type': 'image/jpeg' }).end(image);
        } else if (path === '/moved') {
          response.writeHead(302, { location: '/image.jpg' }).end();
        } else if (path === '/elsewhere') {
          response.writeHead(301, { location: `http://127.0.0.2:${port}/image.jpg` }).end();
        } else if (path === '/loop') {
          response.writeHead(302, { location: '/loop' }).end();
        } else if (path === '/large') {
          response.writeHead(200, { 'content-length': '5000' }).end(Buffer.alloc(5000));
        } else if (path === '/streamed') {
          response.writeHead(200);
          for (let chunk = 0; chunk < 10; chunk++) response.write(Buffer.alloc(200));
          response.end();
        } else if (path === '/busy') {
          response.writeHead(503).end();
        } else if (path === '/slow') {
          // Never answers.
        } else {
          response.writeHead(404).end();
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });

    /** A fetcher that may reach the test's server at 127.0.0.1, named "shop.test". */
    const fetcher = (options: { maxBytes?: number; timeoutMs?: number } = {}) =>
      new ImageFetcher({
        ...options,
        protocols: ['http:'],
        allowAddress: (address) => address === '127.0.0.1',
        resolve: async (host) =>
          host === 'shop.test' ? [{ address: '127.0.0.1', family: 4 }] : [],
      });
    const at = (path: string) => `http://shop.test:${port}${path}`;

    it('fetches an image, following redirects it checks again', async () => {
      expect(await fetcher().fetch(at('/image.jpg'))).toEqual({ ok: true, body: image });
      expect(await fetcher().fetch(at('/moved'))).toEqual({ ok: true, body: image });
      expect(await fetcher().fetch(at('/elsewhere'))).toMatchObject({
        ok: false,
        transient: false,
        message: 'Its address is on a private network, which Hatti does not fetch from',
      });
      expect(await fetcher().fetch(at('/loop'))).toMatchObject({
        ok: false,
        message: 'It redirected more than 3 times',
      });
    });

    it('says which failures may pass, and refuses what weighs too much', async () => {
      expect(await fetcher().fetch(at('/missing'))).toEqual({
        ok: false,
        transient: false,
        code: 'IMAGE_DOWNLOAD_FAILURE',
        message: 'Its server answered 404 Not Found',
      });
      expect(await fetcher().fetch(at('/busy'))).toMatchObject({
        ok: false,
        transient: true,
        message: 'Its server answered 503 Service Unavailable',
      });
      for (const path of ['/large', '/streamed']) {
        expect(await fetcher({ maxBytes: 1000 }).fetch(at(path))).toEqual({
          ok: false,
          transient: false,
          code: 'INVALID_IMAGE_FILE_SIZE',
          message: 'The image is over 20 MB',
        });
      }
      expect(await fetcher({ timeoutMs: 200 }).fetch(at('/slow'))).toEqual({
        ok: false,
        transient: true,
        code: 'IMAGE_DOWNLOAD_FAILURE',
        message: 'Its server took too long to answer',
      });
    });
  });
});

/** A PNG whose header says it is `width` × `height`, with a few bytes of it after. */
function pngOf(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(100))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
