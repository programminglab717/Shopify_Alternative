// What Hatti reads of an app's function before running it (DEV-07, ADR-868): a WebAssembly
// module's sections, and its memory's limits, which it caps. A function's memory may grow to 10
// MiB at most: a module whose memory has no maximum, or a larger one, is given that maximum, so
// no function takes more of the core's memory than that however it grows.

/** A WebAssembly page: 64 KiB. */
const PAGE = 65_536;

export const WASM_LIMITS = {
  /** A module's size, as Shopify's functions are kept to. */
  bytes: 256 * 1024,
  /** The memory a function may grow to, in pages: 10 MiB. */
  memoryPages: (10 * 1024 * 1024) / PAGE,
} as const;

const MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const MEMORY_SECTION = 5;
const IMPORT_SECTION = 2;

export class WasmError extends Error {
  override readonly name = 'WasmError';
}

/** An unsigned LEB128 number at `at`: its value, and the offset after it. */
function readU32(bytes: Uint8Array, at: number): [number, number] {
  let value = 0;
  let shift = 0;
  for (let i = at; i < bytes.length && shift < 35; i += 1) {
    const byte = bytes[i]!;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [value, i + 1];
    shift += 7;
  }
  throw new WasmError('The module ends inside a number');
}

/** `value` as unsigned LEB128. */
export function u32(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  do {
    let byte = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    out.push(byte);
  } while (rest > 0);
  return out;
}

interface Section {
  id: number;
  body: Uint8Array;
}

function sectionsOf(bytes: Uint8Array): Section[] {
  if (bytes.length < 8 || MAGIC.some((byte, index) => bytes[index] !== byte)) {
    throw new WasmError('Not a WebAssembly module: it starts with neither its magic nor version 1');
  }
  const sections: Section[] = [];
  let at = 8;
  while (at < bytes.length) {
    const id = bytes[at]!;
    const [size, start] = readU32(bytes, at + 1);
    if (start + size > bytes.length) throw new WasmError('A section runs past the module’s end');
    sections.push({ id, body: bytes.subarray(start, start + size) });
    at = start + size;
  }
  return sections;
}

/** Limits as the binary writes them, the maximum at most `cap` pages. */
function cappedLimits(body: Uint8Array, at: number, cap: number): [number[], number] {
  const flag = body[at]!;
  const [min, afterMin] = readU32(body, at + 1);
  if (min > cap) {
    throw new WasmError(`Its memory starts at ${min} pages: functions get ${cap} at most (10 MiB)`);
  }
  if (flag === 0x00) return [[0x01, ...u32(min), ...u32(cap)], afterMin];
  if (flag === 0x01) {
    const [max, afterMax] = readU32(body, afterMin);
    return [[0x01, ...u32(min), ...u32(Math.min(max, cap))], afterMax];
  }
  throw new WasmError('Its memory is shared or 64-bit, which functions may not use');
}

/**
 * `bytes`, checked as a WebAssembly module of a function's size, its memory's maximum capped at
 * 10 MiB: what is kept and run. A module that imports its memory is refused; functions define
 * their own.
 */
export function capWasm(bytes: Uint8Array): Uint8Array {
  if (bytes.length > WASM_LIMITS.bytes) {
    throw new WasmError(`It is ${bytes.length} bytes: functions are 256 KiB at most`);
  }
  const out: number[] = [...MAGIC];
  for (const section of sectionsOf(bytes)) {
    if (section.id === IMPORT_SECTION) {
      // An imported memory is the host's to size: functions bring their own.
      let [count, at] = readU32(section.body, 0);
      for (; count > 0; count -= 1) {
        const [moduleLength, afterModule] = readU32(section.body, at);
        const [fieldLength, afterField] = readU32(section.body, afterModule + moduleLength);
        const kind = section.body[afterField + fieldLength]!;
        if (kind === 0x02) throw new WasmError('It imports its memory: a function defines its own');
        at = afterField + fieldLength + 1;
        // A function, table or global: skip what follows its kind.
        if (kind === 0x00) at = readU32(section.body, at)[1];
        else if (kind === 0x01) {
          const flag = section.body[at + 1]!;
          at = readU32(section.body, at + 2)[1];
          if (flag & 0x01) at = readU32(section.body, at)[1];
        } else if (kind === 0x03) at += 2;
      }
    }
    if (section.id !== MEMORY_SECTION) {
      out.push(section.id, ...u32(section.body.length), ...section.body);
      continue;
    }
    const [count, start] = readU32(section.body, 0);
    const body: number[] = [...u32(count)];
    let at = start;
    for (let i = 0; i < count; i += 1) {
      const [limits, next] = cappedLimits(section.body, at, WASM_LIMITS.memoryPages);
      body.push(...limits);
      at = next;
    }
    out.push(MEMORY_SECTION, ...u32(body.length), ...body);
  }
  return Uint8Array.from(out);
}
