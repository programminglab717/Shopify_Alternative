// Products' videos as phones record them (ADR-258): MP4 or QuickTime files whose video is H.264
// and whose sound, if any, is AAC, which every browser plays as they are. Read box by box, never
// decoded, and kept as uploaded but for what a phone writes of where and with what it was taken,
// which becomes empty space of the same size, so that the rest stays where it was.

/** The most a video may weigh: 100 MiB, as an upload of one may. */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

/** The longest a video may last: ten minutes. */
export const MAX_VIDEO_DURATION_MS = 10 * 60_000;

/** Why a video cannot be shown, in Shopify's `MediaErrorCode`'s words. */
export type VideoProblemCode =
  | 'VIDEO_INVALID_FILETYPE_ERROR'
  | 'VIDEO_METADATA_READ_ERROR'
  | 'VIDEO_MAX_DURATION_ERROR'
  | 'GENERIC_FILE_INVALID_SIZE';

export interface VideoProblem {
  code: VideoProblemCode;
  /** For the merchant: what is wrong with it, and what to do. */
  message: string;
}

/** A video as Hatti keeps it. */
export interface CleanVideo {
  /** The file as uploaded, but for its metadata. */
  body: Buffer;
  /** In pixels, as shown: a phone held upright gives a tall video. */
  width: number;
  height: number;
  durationMs: number;
}

export type CleanVideoResult =
  { ok: true; video: CleanVideo } | { ok: false; problem: VideoProblem };

/** H.264's sample entries: what every browser plays. */
const H264 = new Set(['avc1', 'avc3']);
/** HEVC's, which an iPhone records by default and many browsers cannot play. */
const HEVC = new Set(['hvc1', 'hev1']);

/** Boxes that hold what was written about a video rather than the video: where, with what. */
const ABOUT = new Set(['udta', 'meta', 'uuid']);

interface Box {
  type: string;
  start: number;
  headerSize: number;
  end: number;
}

/**
 * The clean copy of a video (ADR-258): an MP4 or QuickTime file, its first box `ftyp`, whole and
 * not in fragments, with H.264 video, AAC sound or none, lasting at most ten minutes; its size as
 * shown, turned as the phone was held, and its length. What it says about itself, a phone's
 * location among it, and tracks of anything but its video and sound become empty space.
 * `bytes` is changed in place.
 */
export function cleanVideo(bytes: Buffer): CleanVideoResult {
  if (bytes.length > MAX_VIDEO_BYTES) {
    const megabytes = (bytes.length / 1024 / 1024).toFixed(1);
    return problem(
      'GENERIC_FILE_INVALID_SIZE',
      `The video is ${megabytes} MB; it may be 100 MB at most`,
    );
  }
  if (bytes.length < 12 || bytes.toString('latin1', 4, 8) !== 'ftyp') {
    return problem('VIDEO_INVALID_FILETYPE_ERROR', 'It is not an MP4 or QuickTime video');
  }
  const top = boxesIn(bytes, 0, bytes.length);
  if (!top) {
    return problem(
      'VIDEO_METADATA_READ_ERROR',
      'It ends before its last part does, as when an upload is cut short: add it again',
    );
  }
  if (top.some((box) => box.type === 'moof')) {
    return problem(
      'VIDEO_INVALID_FILETYPE_ERROR',
      'It is a video in fragments, as streams keep them: export it again as one MP4 file',
    );
  }
  const moov = top.find((box) => box.type === 'moov');
  const movie = moov && childrenOf(bytes, moov);
  if (!movie) {
    return problem(
      'VIDEO_METADATA_READ_ERROR',
      'Its index could not be read, as when an upload is cut short: add it again',
    );
  }
  const durationMs = durationOf(
    bytes,
    movie.find((box) => box.type === 'mvhd'),
  );
  if (durationMs === null) {
    return problem('VIDEO_METADATA_READ_ERROR', 'Its length could not be read');
  }
  if (durationMs > MAX_VIDEO_DURATION_MS) {
    const minutes = Math.ceil(durationMs / 60_000);
    return problem(
      'VIDEO_MAX_DURATION_ERROR',
      `The video lasts ${minutes} minutes; it may last 10 minutes at most`,
    );
  }
  let shown: { width: number; height: number } | null = null;
  for (const trak of movie.filter((box) => box.type === 'trak')) {
    const track = trackOf(bytes, trak);
    if (!track) return problem('VIDEO_METADATA_READ_ERROR', 'Its tracks could not be read');
    if (track.handler === 'vide') {
      if (HEVC.has(track.codec)) {
        return problem(
          'VIDEO_INVALID_FILETYPE_ERROR',
          'It is HEVC video, which many browsers cannot play: record or export it as H.264, ' +
            '"Most Compatible" in an iPhone\'s camera formats, and add it again',
        );
      }
      if (!H264.has(track.codec)) {
        return problem(
          'VIDEO_INVALID_FILETYPE_ERROR',
          `Its video is ${printable(track.codec)}, not H.264: export it again as MP4 with H.264`,
        );
      }
      shown ??= track.size;
      blankAbout(bytes, track.children);
    } else if (track.handler === 'soun') {
      if (track.codec !== 'mp4a') {
        return problem(
          'VIDEO_INVALID_FILETYPE_ERROR',
          `Its sound is ${printable(track.codec)}, not AAC: export it again as MP4 with AAC sound`,
        );
      }
      blankAbout(bytes, track.children);
    } else {
      // A phone's timed metadata, a timecode: none of what is shown.
      blank(bytes, trak);
    }
  }
  if (!shown) return problem('VIDEO_INVALID_FILETYPE_ERROR', 'It has no video in it');
  if (!(shown.width > 0 && shown.height > 0)) {
    return problem('VIDEO_METADATA_READ_ERROR', 'Its size could not be read');
  }
  blankAbout(bytes, top);
  blankAbout(bytes, movie);
  return { ok: true, video: { body: bytes, ...shown, durationMs } };
}

/** The boxes from `start` to `end`; null where one runs past them. */
function boxesIn(bytes: Buffer, start: number, end: number): Box[] | null {
  const boxes: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = bytes.readUInt32BE(at);
    let headerSize = 8;
    if (size === 1) {
      if (at + 16 > end) return null;
      const large = bytes.readBigUInt64BE(at + 8);
      if (large > BigInt(end - at)) return null;
      size = Number(large);
      headerSize = 16;
    } else if (size === 0) {
      // The last box, to the end.
      size = end - at;
    }
    if (size < headerSize || at + size > end) return null;
    boxes.push({
      type: bytes.toString('latin1', at + 4, at + 8),
      start: at,
      headerSize,
      end: at + size,
    });
    at += size;
  }
  return boxes;
}

function childrenOf(bytes: Buffer, box: Box): Box[] | null {
  return boxesIn(bytes, box.start + box.headerSize, box.end);
}

function child(bytes: Buffer, boxes: Box[] | null | undefined, type: string): Box[] | null {
  const found = boxes?.find((box) => box.type === type);
  return found ? childrenOf(bytes, found) : null;
}

/** The movie's length from its header, in milliseconds; null where it is not there or none. */
function durationOf(bytes: Buffer, mvhd: Box | undefined): number | null {
  if (!mvhd) return null;
  const at = mvhd.start + mvhd.headerSize;
  const version = bytes[at];
  const [timescale, duration] =
    version === 1
      ? at + 32 <= mvhd.end
        ? [bytes.readUInt32BE(at + 20), Number(bytes.readBigUInt64BE(at + 24))]
        : [0, 0]
      : at + 20 <= mvhd.end
        ? [bytes.readUInt32BE(at + 12), bytes.readUInt32BE(at + 16)]
        : [0, 0];
  if (!(timescale > 0 && duration > 0)) return null;
  return Math.round((duration * 1000) / timescale);
}

interface Track {
  /** What it holds: "vide", "soun", or anything else. */
  handler: string;
  /** Its first sample entry's type: "avc1", "mp4a". */
  codec: string;
  /** For a video, as shown. */
  size: { width: number; height: number };
  children: Box[];
}

/** A track's kind, codec and size as shown; null where they cannot be read. */
function trackOf(bytes: Buffer, trak: Box): Track | null {
  const children = childrenOf(bytes, trak);
  const tkhd = children?.find((box) => box.type === 'tkhd');
  const mdia = child(bytes, children, 'mdia');
  const hdlr = mdia?.find((box) => box.type === 'hdlr');
  if (!children || !tkhd || !hdlr) return null;
  // The handler's version and flags, a field unused, then what the track holds.
  const handlerAt = hdlr.start + hdlr.headerSize + 8;
  if (handlerAt + 4 > hdlr.end) return null;
  const handler = bytes.toString('latin1', handlerAt, handlerAt + 4);
  if (handler !== 'vide' && handler !== 'soun') {
    return { handler, codec: '', size: { width: 0, height: 0 }, children };
  }
  // Its sample descriptions: their version and flags, how many, then the first's size and type.
  const stsd = child(bytes, child(bytes, mdia, 'minf'), 'stbl')?.find((box) => box.type === 'stsd');
  if (!stsd) return null;
  const entryAt = stsd.start + stsd.headerSize + 8;
  if (entryAt + 8 > stsd.end) return null;
  const codec = bytes.toString('latin1', entryAt + 4, entryAt + 8);
  return { handler, codec, size: shownSizeOf(bytes, tkhd, entryAt, stsd.end), children };
}

/**
 * A video track's size as shown: its header's width and height, turned a quarter where its matrix
 * turns it, as a phone held upright writes it; else its sample entry's.
 */
function shownSizeOf(
  bytes: Buffer,
  tkhd: Box,
  entryAt: number,
  stsdEnd: number,
): { width: number; height: number } {
  const at = tkhd.start + tkhd.headerSize;
  const matrixAt = at + (bytes[at] === 1 ? 52 : 40);
  let width = 0;
  let height = 0;
  let turned = false;
  if (matrixAt + 44 <= tkhd.end) {
    const [a, , , , d] = [0, 4, 8, 12, 16].map((offset) => bytes.readInt32BE(matrixAt + offset));
    turned = a === 0 && d === 0;
    width = Math.round(bytes.readUInt32BE(matrixAt + 36) / 65536);
    height = Math.round(bytes.readUInt32BE(matrixAt + 40) / 65536);
  }
  // A visual sample entry: its header, then 24 bytes before its width and height.
  if (!(width > 0 && height > 0) && entryAt + 36 <= stsdEnd) {
    width = bytes.readUInt16BE(entryAt + 32);
    height = bytes.readUInt16BE(entryAt + 34);
  }
  return turned ? { width: height, height: width } : { width, height };
}

/** Makes what `boxes` say about the video, where and with what it was taken, empty space. */
function blankAbout(bytes: Buffer, boxes: readonly Box[]): void {
  for (const box of boxes) if (ABOUT.has(box.type)) blank(bytes, box);
}

/** Makes `box` a `free` box of the same size, nothing in it. */
function blank(bytes: Buffer, box: Box): void {
  bytes.write('free', box.start + 4, 'latin1');
  bytes.fill(0, box.start + box.headerSize, box.end);
}

/** A sample entry's type as the merchant may read it. */
function printable(codec: string): string {
  return /^[ -~]{4}$/.test(codec) ? codec.trim() : 'of a kind not known';
}

function problem(code: VideoProblemCode, message: string): CleanVideoResult {
  return { ok: false, problem: { code, message } };
}
