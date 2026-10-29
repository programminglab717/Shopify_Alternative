import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { FunctionRunner } from './function-runner.js';
import { answering, echoing, growing, spinning } from './testing/wasm-modules.js';
import { WasmError, capWasm } from './wasm.js';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe("Running apps' functions (DEV-07, ADR-868)", () => {
  const runner = new FunctionRunner();
  afterAll(() => runner.close());

  const run = (wasm: Uint8Array, input: unknown) => {
    const capped = capWasm(wasm);
    return runner.run(digest(capped), capped, input);
  };

  it('gives a function its input as JSON and takes its answer, compiled once', async () => {
    const input = { cart: { subtotal: 250_000, lines: [{ quantity: 2 }] }, configuration: {} };
    expect(await run(echoing(), input)).toMatchObject({ ok: true, output: input });
    const hide = { operations: [{ hide: { paymentMethod: 'cash_on_delivery' } }] };
    expect(await run(answering(hide), input)).toMatchObject({ ok: true, output: hide });
    expect(await run(answering(hide), {})).toMatchObject({ ok: true, output: hide });
  });

  it('stops one past its time, and runs the next in a new worker', async () => {
    const stopped = await run(spinning(), {});
    expect(stopped).toMatchObject({ ok: false, error: 'timeout' });
    expect(await run(answering({ fine: true }), {})).toMatchObject({
      ok: true,
      output: { fine: true },
    });
  });

  it('caps its memory at 10 MiB, and refuses what is not a function', async () => {
    expect(await run(growing(100), {})).toMatchObject({ ok: true, output: { capped: false } });
    expect(await run(growing(1_000), {})).toMatchObject({ ok: true, output: { capped: true } });
    expect(() => capWasm(Uint8Array.from([1, 2, 3]))).toThrow(WasmError);
    expect(() => capWasm(new Uint8Array(300 * 1024))).toThrow('256 KiB at most');
    // A module the shim can't run says so, as a failure, not a crash.
    const bad = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    expect(await runner.run(digest(bad), bad, {})).toMatchObject({ ok: false, error: 'failed' });
  });
});
