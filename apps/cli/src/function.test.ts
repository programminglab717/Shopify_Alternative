import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HattiAdminClient } from '@hatti/admin-client';
import { answering, echoing, spinning } from '@hatti/functions/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FUNCTION_CONFIG,
  FunctionError,
  buildFunction,
  functionConfigIn,
  type FunctionConfig,
} from './function.js';
import { run } from './main.js';

type Asked = { query: string; variables: Record<string, unknown> };

/** A function that answers with its input, as Hatti's tests build one. */
const wasm = () => Buffer.from(echoing());
/** WebAssembly's header, then `size` bytes in all: no module that compiles. */
const header = (size: number) =>
  Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    Buffer.alloc(size - 8),
  ]);

const CONFIG: FunctionConfig = {
  handle: 'cod-above-limit',
  title: 'No cash on delivery above Rs 10,000',
  target: 'payment_customization',
  module: 'dist/function.wasm',
};

const DEPLOYED = {
  id: 'afn_1',
  handle: 'cod-above-limit',
  title: CONFIG.title,
  target: 'payment_customization',
  enabled: false,
  bytes: wasm().length,
  lastError: null,
};

/** A fake Admin API taking the app's functions, each request kept. */
function api(userErrors: { field: string[]; message: string }[] = []) {
  const asked: Asked[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Asked;
    asked.push(body);
    const data = body.query.includes('query AppFunctions')
      ? { appFunctions: [{ ...DEPLOYED, enabled: true, lastError: 'past its time' }] }
      : {
          appFunctionSet: {
            appFunction: userErrors.length > 0 ? null : DEPLOYED,
            userErrors,
          },
        };
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new HattiAdminClient({ apiUrl: 'https://api.hatti.test', accessToken: 'hat_x', fetch }),
    asked,
  };
}

describe('Functions from the command line (DEV-07, ADR-922)', () => {
  let dir: string;
  const lines: string[] = [];
  const out = {
    log: (line: string) => lines.push(line),
    error: (line: string) => lines.push(`! ${line}`),
  };
  const configure = (config: object) =>
    writeFile(join(dir, FUNCTION_CONFIG), JSON.stringify(config));
  /** A build command writing `bytes` as the module, saying so first. */
  const builds = (bytes: Buffer) =>
    `node -e "console.log('compiling'); require('fs').mkdirSync('dist', { recursive: true }); ` +
    `require('fs').writeFileSync('dist/function.wasm', Buffer.from('${bytes.toString('base64')}', 'base64'))"`;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatti-function-'));
    lines.length = 0;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads what the function is from its directory, refusing what Hatti would', async () => {
    await expect(functionConfigIn(dir)).rejects.toThrow(`No ${FUNCTION_CONFIG} in ${dir}`);
    await configure(CONFIG);
    expect(await functionConfigIn(dir)).toEqual(CONFIG);
    for (const [wrong, message] of [
      [{ handle: 'COD limit' }, 'handle'],
      [{ title: ' ' }, 'title'],
      [{ target: 'discount' }, 'payment_customization and cart_validation'],
      [{ module: '../elsewhere.wasm' }, 'within the directory'],
      [{ build: ['javy'] }, 'a command'],
    ] as const) {
      await configure({ ...CONFIG, ...wrong });
      await expect(functionConfigIn(dir)).rejects.toThrow(message);
    }
  });

  it('builds it with its own command, then checks the module as the API will', async () => {
    const config = { ...CONFIG, build: builds(wasm()) };
    expect((await buildFunction(dir, config, out)).equals(wasm())).toBe(true);
    expect(lines).toEqual([`Building: ${config.build}`, 'compiling']);
    // Not WebAssembly, too large, or a build that fails: refused before anything is sent.
    await expect(
      buildFunction(dir, { ...CONFIG, build: builds(Buffer.from('not wasm at all')) }, out),
    ).rejects.toThrow(
      'dist/function.wasm: Not a WebAssembly module: it starts with neither its magic nor version 1',
    );
    // Written by hand, with no build.
    await writeFile(join(dir, 'dist', 'function.wasm'), header(300 * 1024));
    await expect(buildFunction(dir, CONFIG, out)).rejects.toThrow(
      'dist/function.wasm: It is 307200 bytes: functions are 256 KiB at most',
    );
    await expect(buildFunction(dir, { ...CONFIG, build: 'exit 3' }, out)).rejects.toThrow(
      new FunctionError('The build failed, with code 3'),
    );
  });

  it('runs as `hatti function …`: built without a token, deployed and listed with one', async () => {
    await configure({ ...CONFIG, build: builds(wasm()) });
    expect(await run(['function', 'build', '--dir', dir], {}, out)).toBe(0);
    expect(lines.at(-1)).toBe(`Built cod-above-limit: dist/function.wasm, ${wasm().length} bytes`);
    expect(await run(['function', 'deploy', '--dir', dir], {}, out)).toBe(1);
    expect(lines.at(-1)).toMatch(/^! Set HATTI_ACCESS_TOKEN .* with write_settings\.$/);

    const { client, asked } = api();
    expect(await run(['function', 'deploy', '--dir', dir], {}, out, client)).toBe(0);
    expect(asked.at(-1)!.variables).toEqual({
      input: {
        handle: 'cod-above-limit',
        title: CONFIG.title,
        target: 'payment_customization',
        wasm: wasm().toString('base64'),
      },
    });
    expect(lines.slice(-2)).toEqual([
      `Deployed cod-above-limit, ${wasm().length} bytes as it runs`,
      'It is off until the shop turns it on in Settings › Apps.',
    ]);
    // Without its build, the module as it is.
    lines.length = 0;
    expect(await run(['function', 'deploy', '--no-build', '--dir', dir], {}, out, client)).toBe(0);
    expect(lines.some((line) => line.startsWith('Building'))).toBe(false);

    expect(await run(['function', 'list'], {}, out, client)).toBe(0);
    expect(lines.slice(-2)).toEqual([
      `cod-above-limit  [on]  ${CONFIG.title} (payment_customization)`,
      '  last failed: past its time',
    ]);
    // What the API refuses, it says.
    const refusing = api([{ field: ['input', 'wasm'], message: 'Its module imports env.fetch' }]);
    expect(await run(['function', 'deploy', '--dir', dir], {}, out, refusing.client)).toBe(1);
    expect(lines.at(-1)).toBe('! Its module imports env.fetch');
  });

  it('runs it on an input as checkout runs it, saying how long it took (ADR-927)', async () => {
    const input = { cart: { subtotal: 1_250_000, lines: [] }, configuration: {} };
    await writeFile(join(dir, 'input.json'), JSON.stringify(input));
    const runs = async (module: Uint8Array) => {
      await configure({ ...CONFIG, build: builds(Buffer.from(module)) });
      lines.length = 0;
      return run(['function', 'run', '--dir', dir, '--input', join(dir, 'input.json')], {}, out);
    };
    // Its answer, without a token: it runs on this machine alone.
    expect(await runs(echoing())).toBe(0);
    expect(JSON.parse(lines.at(-2)!)).toEqual(input);
    expect(lines.at(-1)).toMatch(/^Ran in \d+\.\d ms of the 50 ms Hatti allows$/);
    const hide = { operations: [{ hide: { paymentMethod: 'cash_on_delivery' } }] };
    expect(await runs(answering(hide))).toBe(0);
    expect(JSON.parse(lines.at(-2)!)).toEqual(hide);
    // One that runs past its time is stopped, as checkout stops it.
    expect(await runs(spinning())).toBe(1);
    expect(lines.at(-2)).toBe('! It gave no answer (timeout): It ran past 50 ms');
    // It needs an input, of JSON.
    expect(await run(['function', 'run', '--dir', dir], {}, out)).toBe(1);
    expect(lines.at(-1)).toBe('! Say what it runs on: --input <file.json>');
    await writeFile(join(dir, 'input.json'), '{');
    expect(
      await run(['function', 'run', '--dir', dir, '--input', join(dir, 'input.json')], {}, out),
    ).toBe(1);
    expect(lines.at(-1)).toBe(`! ${join(dir, 'input.json')} is not JSON`);
  });
});
