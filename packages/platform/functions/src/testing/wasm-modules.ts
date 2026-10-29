import { u32 } from '../wasm.js';

// WebAssembly functions for tests (ADR-868), assembled byte by byte: one that answers a fixed
// JSON, one that answers its input, one that never ends, and one that grows its memory, each a
// WASI command reading standard input and writing standard output as apps' functions do.

const sleb = (value: number): number[] => {
  const out: number[] = [];
  let rest = value;
  for (;;) {
    const byte = rest & 0x7f;
    rest >>= 7;
    const done = (rest === 0 && (byte & 0x40) === 0) || (rest === -1 && (byte & 0x40) !== 0);
    out.push(done ? byte : byte | 0x80);
    if (done) return out;
  }
};

const name = (text: string) => [...u32(text.length), ...Buffer.from(text, 'utf8')];
const section = (id: number, body: number[]) => [id, ...u32(body.length), ...body];
const vector = (items: number[][]) => [...u32(items.length), ...items.flat()];
const i32 = (value: number) => [0x41, ...sleb(value)];

/** A call of fd_write(1, iov, 1, written): its four arguments, the call, and its result dropped. */
const write = (iov: number) => [...i32(1), ...i32(iov), ...i32(1), ...i32(8), 0x10, 0x00, 0x1a];

/** An iovec at `at`: a pointer and a length, little-endian. */
const iovec = (pointer: number, length: number) => [
  ...Buffer.from(Uint32Array.of(pointer, length).buffer),
];

function module(code: number[], data: { at: number; bytes: number[] }[]): Uint8Array {
  const types = vector([
    // fd_write and fd_read: (i32, i32, i32, i32) -> i32
    [0x60, ...vector([[0x7f], [0x7f], [0x7f], [0x7f]]), 0x01, 0x7f],
    // _start: () -> ()
    [0x60, 0x00, 0x00],
  ]);
  const imports = vector([
    [...name('wasi_snapshot_preview1'), ...name('fd_write'), 0x00, 0x00],
    [...name('wasi_snapshot_preview1'), ...name('fd_read'), 0x00, 0x00],
  ]);
  const body = [0x00, ...code, 0x0b];
  return Uint8Array.from([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...section(1, types),
    ...section(2, imports),
    ...section(3, vector([[0x01]])),
    // One page, and no maximum: Hatti gives it one.
    ...section(5, vector([[0x00, 0x01]])),
    ...section(
      7,
      vector([
        [...name('memory'), 0x02, 0x00],
        [...name('_start'), 0x00, 0x02],
      ]),
    ),
    ...section(10, vector([[...u32(body.length), ...body]])),
    ...section(
      11,
      vector(data.map(({ at, bytes }) => [0x00, ...i32(at), 0x0b, ...u32(bytes.length), ...bytes])),
    ),
  ]);
}

/** A function answering `output`, whatever its input. */
export function answering(output: unknown): Uint8Array {
  const json = [...Buffer.from(JSON.stringify(output), 'utf8')];
  return module(write(16), [
    { at: 16, bytes: iovec(64, json.length) },
    { at: 64, bytes: json },
  ]);
}

/** A function answering its input as it was given. */
export function echoing(): Uint8Array {
  const read = [...i32(0), ...i32(16), ...i32(1), ...i32(8), 0x10, 0x01, 0x1a];
  // The second iovec's length is what was read.
  const length = [...i32(36), ...i32(8), 0x28, 0x02, 0x00, 0x36, 0x02, 0x00];
  return module(
    [...read, ...length, ...write(32)],
    [
      { at: 16, bytes: iovec(1024, 60_000) },
      { at: 32, bytes: iovec(1024, 0) },
    ],
  );
}

/** A function that never ends. */
export function spinning(): Uint8Array {
  return module([0x03, 0x40, 0x0c, 0x00, 0x0b], []);
}

/** A function growing its memory by `pages`, answering whether it was refused. */
export function growing(pages: number): Uint8Array {
  const capped = [...Buffer.from('{"capped":true}')];
  const grew = [...Buffer.from('{"capped":false}')];
  return module(
    [
      ...i32(pages),
      0x40,
      0x00,
      ...i32(-1),
      0x46,
      0x04,
      0x40,
      ...write(16),
      0x05,
      ...write(24),
      0x0b,
    ],
    [
      { at: 16, bytes: iovec(64, capped.length) },
      { at: 24, bytes: iovec(128, grew.length) },
      { at: 64, bytes: capped },
      { at: 128, bytes: grew },
    ],
  );
}
