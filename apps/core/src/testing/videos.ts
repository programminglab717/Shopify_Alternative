// Videos as phones record them, made box by box for tests (ADR-258), or by ffmpeg where a test
// plays them (ADR-791). Not part of the build.

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A box of `type` holding `parts`, as MP4 files are made of. */
function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}

function u32(...values: number[]): Buffer {
  return Buffer.concat(
    values.map((value) => {
      const bytes = Buffer.alloc(4);
      bytes.writeInt32BE(value | 0);
      return bytes;
    }),
  );
}

/**
 * A phone's twelve-second video, held upright, its video `codec`, AAC sound, and where it was
 * taken in its metadata.
 */
export function phoneVideo(codec: string): Buffer {
  const upright = [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000];
  const track = (handler: string, entry: string) =>
    box(
      'trak',
      box(
        'tkhd',
        u32(0, 0, 0, 1, 0, 0),
        Buffer.alloc(16),
        u32(...upright),
        u32(1920 << 16, 1080 << 16),
      ),
      box(
        'mdia',
        box('hdlr', u32(0, 0), Buffer.from(handler, 'latin1'), Buffer.alloc(12)),
        box('minf', box('stbl', box('stsd', u32(0, 1), box(entry, Buffer.alloc(78))))),
      ),
    );
  return Buffer.concat([
    box('ftyp', Buffer.from('qt  ', 'latin1'), u32(0)),
    box('mdat', Buffer.from('frames and sound')),
    box(
      'moov',
      box('mvhd', u32(0, 0, 0, 600, 7200), Buffer.alloc(80)),
      track('vide', codec),
      track('soun', 'mp4a'),
      box('udta', box('xyz ', Buffer.from('+24.8607+067.0011/'))),
    ),
  ]);
}

/** Whether this machine has ffmpeg with H.264's encoder, as CI and the worker's image do. */
export const HAS_FFMPEG = /\blibx264\b/.test(
  spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '',
);

/**
 * A second of real video, `width` by `height`, H.264, or HEVC as an iPhone records it with
 * `libx265`, with AAC sound, recorded by ffmpeg.
 */
export async function recordedVideo(
  width: number,
  height: number,
  codec: 'libx264' | 'libx265' = 'libx264',
): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), 'hatti-recorded-'));
  try {
    const file = join(directory, 'phone.mp4');
    const made = spawnSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=${width}x${height}:rate=24:duration=1`,
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-c:v',
      codec,
      ...(codec === 'libx265' ? ['-tag:v', 'hvc1'] : []),
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      file,
    ]);
    if (made.status !== 0) throw new Error(made.stderr.toString());
    return await readFile(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
