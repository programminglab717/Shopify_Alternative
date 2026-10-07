// Videos as phones record them, made box by box for tests (ADR-258). Not part of the build.

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
