import { Worker } from 'node:worker_threads';

// Runs apps' functions (DEV-07, ADR-868): WebAssembly modules that read their input as JSON on
// standard input and write their answer as JSON on standard output, as WASI programs do, the
// way Shopify's functions run. Each runs in a worker thread with nothing but its input and its
// output: no files, network, clock or environment, a fixed seed for its randomness. One that runs
// past its time has the worker stopped and another started; one that writes more than its output
// may hold, or fails, gives no answer. A module is compiled once, by its digest, in each worker.

export const RUN_LIMITS = {
  /** How long a function may run, from its start: compiling it and the worker's start aside. */
  timeMs: 50,
  /** How long a worker may take to start and compile a module before its run. */
  startupMs: 5_000,
  /** How much JSON it may write. */
  outputBytes: 64 * 1024,
  /** How many compiled modules a worker keeps. */
  modules: 64,
} as const;

export type RunResult =
  | { ok: true; output: unknown; ms: number }
  | { ok: false; error: 'timeout' | 'failed' | 'invalid_output'; detail: string; ms: number };

/** The worker's own code: a WASI shim of standard input and output alone, and a loop of runs. */
const WORKER = `
const { parentPort } = require('node:worker_threads');
const modules = new Map();
const ENOSYS = 52;
class Exit { constructor(code) { this.code = code; } }
parentPort.on('message', ({ id, digest, wasm, input, outputBytes, keep }) => {
  const started = performance.now();
  try {
    let module = modules.get(digest);
    if (!module) {
      module = new WebAssembly.Module(wasm);
      modules.set(digest, module);
      if (modules.size > keep) modules.delete(modules.keys().next().value);
    }
    const stdin = Buffer.from(input, 'utf8');
    let read = 0;
    const out = [];
    let written = 0;
    let memory;
    const view = () => new DataView(memory.buffer);
    const bytes = () => new Uint8Array(memory.buffer);
    const wasi = {
      fd_write(fd, iovs, count, nwritten) {
        let total = 0;
        for (let i = 0; i < count; i += 1) {
          const ptr = view().getUint32(iovs + i * 8, true);
          const len = view().getUint32(iovs + i * 8 + 4, true);
          if (fd === 1) {
            written += len;
            if (written > outputBytes) throw new Error('output_too_large');
            out.push(Buffer.from(bytes().slice(ptr, ptr + len)));
          }
          total += len;
        }
        view().setUint32(nwritten, total, true);
        return 0;
      },
      fd_read(fd, iovs, count, nread) {
        let total = 0;
        if (fd === 0) {
          for (let i = 0; i < count && read < stdin.length; i += 1) {
            const ptr = view().getUint32(iovs + i * 8, true);
            const len = view().getUint32(iovs + i * 8 + 4, true);
            const chunk = stdin.subarray(read, read + len);
            bytes().set(chunk, ptr);
            read += chunk.length;
            total += chunk.length;
          }
        }
        view().setUint32(nread, total, true);
        return 0;
      },
      fd_fdstat_get(fd, buf) {
        for (let i = 0; i < 24; i += 1) view().setUint8(buf + i, 0);
        view().setUint8(buf, 2);
        return 0;
      },
      fd_close() { return 0; },
      fd_seek() { return 70; },
      environ_sizes_get(count, size) { view().setUint32(count, 0, true); view().setUint32(size, 0, true); return 0; },
      environ_get() { return 0; },
      args_sizes_get(count, size) { view().setUint32(count, 0, true); view().setUint32(size, 0, true); return 0; },
      args_get() { return 0; },
      random_get(buf, len) { for (let i = 0; i < len; i += 1) view().setUint8(buf + i, (i * 131 + 7) & 255); return 0; },
      clock_time_get(id, precision, time) { view().setBigUint64(time, 0n, true); return 0; },
      sched_yield() { return 0; },
      proc_exit(code) { throw new Exit(code); },
    };
    const imports = { wasi_snapshot_preview1: {} };
    for (const each of WebAssembly.Module.imports(module)) {
      if (each.module !== 'wasi_snapshot_preview1' || each.kind !== 'function') {
        throw new Error('A function imports ' + each.module + '.' + each.name + ', which Hatti does not give it');
      }
      imports.wasi_snapshot_preview1[each.name] = wasi[each.name] ?? (() => ENOSYS);
    }
    const instance = new WebAssembly.Instance(module, imports);
    // Its time is counted from here: the worker's start and compiling it are Hatti's.
    parentPort.postMessage({ id, started: true });
    memory = instance.exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) throw new Error('A function exports its memory as memory');
    const start = instance.exports._start;
    if (typeof start !== 'function') throw new Error('A function exports _start, as a WASI command does');
    try {
      start();
    } catch (error) {
      if (!(error instanceof Exit)) throw error;
      if (error.code !== 0) throw new Error('It exited with ' + error.code);
    }
    parentPort.postMessage({ id, ok: true, output: Buffer.concat(out).toString('utf8'), ms: performance.now() - started });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, detail: String(error && error.message || error), ms: performance.now() - started });
  }
});
`;

interface Pending {
  resolve: (result: RunResult) => void;
  timer: NodeJS.Timeout;
  /** Stops the worker past the function's time, once it has started. */
  stopAfter: (ms: number, detail: string) => NodeJS.Timeout;
}

/**
 * The worker functions run in, one at a time: a function past its time stops the worker, and the
 * next run starts another.
 */
export class FunctionRunner {
  #worker: Worker | null = null;
  #pending = new Map<number, Pending>();
  #next = 0;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly limits: { timeMs?: number } = {}) {}

  /** Runs `wasm`, kept by `digest`, on `input`: its answer as JSON, or why there is none. */
  run(digest: string, wasm: Uint8Array, input: unknown): Promise<RunResult> {
    const run = this.#queue.then(() => this.#run(digest, wasm, input));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Stops the worker: for the process's end, and tests'. */
  async close(): Promise<void> {
    const worker = this.#worker;
    this.#worker = null;
    if (worker) await worker.terminate();
  }

  #run(digest: string, wasm: Uint8Array, input: unknown): Promise<RunResult> {
    const worker = this.#ensure();
    const id = (this.#next += 1);
    return new Promise<RunResult>((resolve) => {
      const posted = performance.now();
      const stopAfter = (ms: number, detail: string) =>
        setTimeout(() => {
          this.#pending.delete(id);
          // Past its time: the worker is stopped mid-run, and the next run starts another.
          if (this.#worker === worker) this.#worker = null;
          void worker.terminate();
          resolve({ ok: false, error: 'timeout', detail, ms: performance.now() - posted });
        }, ms);
      const timer = stopAfter(RUN_LIMITS.startupMs, 'It took too long to start');
      this.#pending.set(id, { resolve, timer, stopAfter });
      worker.postMessage({
        id,
        digest,
        wasm,
        input: JSON.stringify(input),
        outputBytes: RUN_LIMITS.outputBytes,
        keep: RUN_LIMITS.modules,
      });
    });
  }

  #ensure(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(WORKER, { eval: true });
    worker.unref();
    worker.on(
      'message',
      (message: {
        id: number;
        started?: true;
        ok: boolean;
        output?: string;
        detail?: string;
        ms: number;
      }) => {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        if (message.started) {
          // Started: its own time is counted now, with a little for the message to come back.
          clearTimeout(pending.timer);
          const timeMs = this.limits.timeMs ?? RUN_LIMITS.timeMs;
          pending.timer = pending.stopAfter(timeMs + 10, `It ran past ${timeMs} ms`);
          return;
        }
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (!message.ok) {
          pending.resolve({
            ok: false,
            error: 'failed',
            detail: message.detail ?? '',
            ms: message.ms,
          });
          return;
        }
        try {
          pending.resolve({ ok: true, output: JSON.parse(message.output ?? ''), ms: message.ms });
        } catch {
          pending.resolve({
            ok: false,
            error: 'invalid_output',
            detail: 'It wrote something other than JSON',
            ms: message.ms,
          });
        }
      },
    );
    worker.on('error', () => {
      if (this.#worker === worker) this.#worker = null;
    });
    this.#worker = worker;
    return worker;
  }
}
