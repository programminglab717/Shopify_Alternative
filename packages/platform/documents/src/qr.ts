import { escapeHtml, trusted, type Html } from './html.js';

// QR codes as ISO/IEC 18004 makes them, for what invoices print (ADR-556): byte mode, error
// correction level M, versions 1 to 10, which hold up to 213 bytes. Each module is drawn as one
// unit of an SVG, so the code scales to any size without blurring.

/** Error correction codewords per block, and the blocks' data codewords, by version, at level M. */
const BLOCKS_M: readonly { ec: number; data: readonly number[] }[] = [
  { ec: 10, data: [16] },
  { ec: 16, data: [28] },
  { ec: 26, data: [44] },
  { ec: 18, data: [32, 32] },
  { ec: 24, data: [43, 43] },
  { ec: 16, data: [27, 27, 27, 27] },
  { ec: 18, data: [31, 31, 31, 31] },
  { ec: 22, data: [38, 38, 39, 39] },
  { ec: 22, data: [36, 36, 36, 37, 37] },
  { ec: 26, data: [43, 43, 43, 43, 44] },
];

/** Where alignment patterns centre, by version: every pairing of these, but the finders'. */
const ALIGNMENT: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/** The largest version made. */
export const QR_MAX_VERSION = BLOCKS_M.length;

/** A QR code's modules, `size` by `size`, row by row: true is dark. */
export interface QrMatrix {
  version: number;
  mask: number;
  size: number;
  modules: boolean[][];
}

// GF(256) with the polynomial x^8 + x^4 + x^3 + x^2 + 1, as QR codes' Reed–Solomon takes it.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let value = 1;
  for (let power = 0; power < 255; power++) {
    EXP[power] = value;
    LOG[value] = power;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let power = 255; power < 512; power++) EXP[power] = EXP[power - 255]!;
}

function multiply(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!;
}

/** The generator polynomial of `degree`, highest power first, its leading 1 left out. */
function generator(degree: number): number[] {
  let poly = [1];
  for (let root = 0; root < degree; root++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    poly.forEach((coefficient, index) => {
      next[index]! ^= coefficient;
      next[index + 1]! ^= multiply(coefficient, EXP[root]!);
    });
    poly = next;
  }
  return poly.slice(1);
}

/** The `degree` error correction codewords of `data`. */
function reedSolomon(data: readonly number[], degree: number): number[] {
  const gen = generator(degree);
  const remainder = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder.shift()!;
    remainder.push(0);
    gen.forEach((coefficient, index) => {
      remainder[index]! ^= multiply(coefficient, factor);
    });
  }
  return remainder;
}

/** The data codewords a version holds at level M. */
function capacity(version: number): number {
  return BLOCKS_M[version - 1]!.data.reduce((sum, count) => sum + count, 0);
}

/** `bytes` in byte mode, with its count, terminator and padding, as codewords. */
function dataCodewords(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let bit = length - 1; bit >= 0; bit--) bits.push((value >>> bit) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) put(byte, 8);
  const total = capacity(version) * 8;
  put(0, Math.min(4, total - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    codewords.push(bits.slice(index, index + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  }
  for (let pad = 0; codewords.length < capacity(version); pad++) {
    codewords.push(pad % 2 === 0 ? 0xec : 0x11);
  }
  return codewords;
}

/** The codewords in the order they are placed: blocks' data interleaved, then their correction. */
function interleaved(data: readonly number[], version: number): number[] {
  const { ec, data: sizes } = BLOCKS_M[version - 1]!;
  const blocks: number[][] = [];
  let offset = 0;
  for (const size of sizes) {
    blocks.push(data.slice(offset, offset + size));
    offset += size;
  }
  const corrections = blocks.map((block) => reedSolomon(block, ec));
  const out: number[] = [];
  for (let index = 0; index < Math.max(...sizes); index++) {
    for (const block of blocks) if (index < block.length) out.push(block[index]!);
  }
  for (let index = 0; index < ec; index++) {
    for (const correction of corrections) out.push(correction[index]!);
  }
  return out;
}

/** Whether module (row, column) of mask pattern `mask` is flipped. */
function masked(mask: number, row: number, column: number): boolean {
  switch (mask) {
    case 0:
      return (row + column) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return column % 3 === 0;
    case 3:
      return (row + column) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
    case 5:
      return ((row * column) % 2) + ((row * column) % 3) === 0;
    case 6:
      return (((row * column) % 2) + ((row * column) % 3)) % 2 === 0;
    default:
      return (((row + column) % 2) + ((row * column) % 3)) % 2 === 0;
  }
}

/** `value` of `length` bits with its BCH remainder by `poly`, of `degree` bits, appended. */
function bch(value: number, length: number, poly: number, degree: number): number {
  let remainder = value << degree;
  for (let bit = length + degree - 1; bit >= degree; bit--) {
    if ((remainder >>> bit) & 1) remainder ^= poly << (bit - degree);
  }
  return (value << degree) | remainder;
}

/** The modules of `codewords` at `version` under `mask`. */
function build(version: number, codewords: readonly number[], mask: number): boolean[][] {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (row: number, column: number, dark: boolean) => {
    modules[row]![column] = dark;
    fixed[row]![column] = true;
  };

  // Finders, with their separators.
  for (const [top, left] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ] as const) {
    for (let row = -1; row <= 7; row++) {
      for (let column = -1; column <= 7; column++) {
        const r = top + row;
        const c = left + column;
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        const ring = Math.max(Math.abs(row - 3), Math.abs(column - 3));
        set(r, c, ring !== 2 && ring !== 4);
      }
    }
  }
  // Timing.
  for (let index = 8; index < size - 8; index++) {
    set(6, index, index % 2 === 0);
    set(index, 6, index % 2 === 0);
  }
  // Alignment.
  const centres = ALIGNMENT[version - 1]!;
  const last = centres.length - 1;
  centres.forEach((row, i) => {
    centres.forEach((column, j) => {
      // Not over the finders; over the timing lines, they stand.
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(row + dr, column + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    });
  });
  // Format information: level M is 00.
  const format = bch(mask, 5, 0x537, 10) ^ 0x5412;
  const bit = (index: number) => ((format >>> index) & 1) === 1;
  for (let index = 0; index <= 5; index++) set(index, 8, bit(index));
  set(7, 8, bit(6));
  set(8, 8, bit(7));
  set(8, 7, bit(8));
  for (let index = 9; index < 15; index++) set(8, 14 - index, bit(index));
  for (let index = 0; index < 8; index++) set(8, size - 1 - index, bit(index));
  for (let index = 8; index < 15; index++) set(size - 15 + index, 8, bit(index));
  set(size - 8, 8, true);
  // Version information, from version 7.
  if (version >= 7) {
    const info = bch(version, 6, 0x1f25, 12);
    for (let index = 0; index < 18; index++) {
      const dark = ((info >>> index) & 1) === 1;
      const a = size - 11 + (index % 3);
      const b = Math.floor(index / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  // The data, two columns at a time from the right, up then down, skipping the timing column.
  let index = 0;
  const bits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      for (let j = 0; j < 2; j++) {
        const column = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - step : step;
        if (fixed[row]![column]) continue;
        let dark = false;
        if (index < bits) {
          dark = ((codewords[index >>> 3]! >>> (7 - (index & 7))) & 1) === 1;
          index++;
        }
        modules[row]![column] = dark !== masked(mask, row, column);
      }
    }
  }
  return modules;
}

/** How bad `modules` is to read, by the standard's four rules: the lowest is chosen. */
function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;
  const lines = (vertical: boolean) =>
    Array.from({ length: size }, (_, a) =>
      Array.from({ length: size }, (_, b) => (vertical ? modules[b]![a]! : modules[a]![b]!)),
    );
  for (const vertical of [false, true]) {
    for (const line of lines(vertical)) {
      // Runs of five or more alike.
      let run = 1;
      for (let index = 1; index <= size; index++) {
        if (index < size && line[index] === line[index - 1]) {
          run++;
        } else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      // What looks like a finder: 1:1:3:1:1 with four light modules on a side.
      const text = line.map((dark) => (dark ? '1' : '0')).join('');
      for (const pattern of ['10111010000', '00001011101']) {
        for (let at = text.indexOf(pattern); at !== -1; at = text.indexOf(pattern, at + 1)) {
          score += 40;
        }
      }
    }
  }
  // Blocks of 2 by 2 alike.
  for (let row = 0; row < size - 1; row++) {
    for (let column = 0; column < size - 1; column++) {
      const dark = modules[row]![column];
      if (
        dark === modules[row]![column + 1] &&
        dark === modules[row + 1]![column] &&
        dark === modules[row + 1]![column + 1]
      ) {
        score += 3;
      }
    }
  }
  // Dark far from half.
  const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  score += Math.floor(Math.abs((dark * 20) / (size * size) - 10)) * 10;
  return score;
}

/**
 * The QR code of `value`, as UTF-8 bytes, at the smallest version that holds it, at level M, with
 * the mask `mask` if given, else the one easiest to read; null when it is too long for version 10.
 */
export function qrMatrix(value: string, mask?: number): QrMatrix | null {
  const bytes = new TextEncoder().encode(value);
  let version = 1;
  // The mode and count take 2 or 3 bytes besides.
  while (version <= QR_MAX_VERSION && bytes.length + (version < 10 ? 2 : 3) > capacity(version)) {
    version++;
  }
  if (version > QR_MAX_VERSION) return null;
  const codewords = interleaved(dataCodewords(bytes, version), version);
  if (mask !== undefined) {
    return { version, mask, size: version * 4 + 17, modules: build(version, codewords, mask) };
  }
  let best: QrMatrix | null = null;
  let bestScore = Infinity;
  for (let each = 0; each < 8; each++) {
    const modules = build(version, codewords, each);
    const score = penalty(modules);
    if (score < bestScore) {
      bestScore = score;
      best = { version, mask: each, size: modules.length, modules };
    }
  }
  return best;
}

/** The quiet zone around a code, in modules. */
const QUIET = 4;

/**
 * `value` as a QR code in SVG, each module a unit and its quiet zone around it, or nothing when it
 * is too long to be one; `label` is what a screen reader says of it.
 */
export function qrCode(value: string, label: string = value): Html {
  const matrix = qrMatrix(value);
  if (!matrix) return trusted('');
  const paths: string[] = [];
  matrix.modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) paths.push(`M${x + QUIET} ${y + QUIET}h1v1h-1z`);
    });
  });
  const side = matrix.size + QUIET * 2;
  return trusted(
    `<svg class="qr" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges" role="img" ` +
      `aria-label="${escapeHtml(label)}"><path d="${paths.join('')}"/></svg>`,
  );
}
