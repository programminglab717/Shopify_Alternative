import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { HattiAdminClient } from '@hatti/admin-client';

// An app's functions from the command line (DEV-07, ADR-922): built with the tool the developer
// chose, Javy, TinyGo or Rust's wasm32-wasi, and deployed to the shop through the Admin API's
// `appFunctionSet` (ADR-868), as Shopify's CLI deploys its functions. A function's directory says
// what it is in `hatti.function.json`.

export const FUNCTION_CONFIG = 'hatti.function.json';

/** As the Admin API takes them (ADR-868). */
export const FUNCTION_LIMITS = { moduleBytes: 256 * 1024 } as const;

const TARGETS = ['payment_customization', 'cart_validation'] as const;
const HANDLE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** WebAssembly's magic number and version 1. */
const WASM_HEADER = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

/** What `hatti.function.json` says of the function in its directory. */
export interface FunctionConfig {
  /** The app's own name for it, the same each deploy: "cod-above-limit". */
  handle: string;
  title: string;
  target: (typeof TARGETS)[number];
  /** The module, relative to the directory: "dist/function.wasm". */
  module: string;
  /** The command that builds it, run in the directory: "javy build src/index.js -o dist/function.wasm". */
  build?: string;
}

export interface FunctionSummary {
  id: string;
  handle: string;
  title: string;
  target: string;
  enabled: boolean;
  bytes: number;
  lastError: string | null;
}

export class FunctionError extends Error {}

const FUNCTIONS = /* GraphQL */ `
  query AppFunctions {
    appFunctions {
      id
      handle
      title
      target
      enabled
      bytes
      lastError
    }
  }
`;

const SET = /* GraphQL */ `
  mutation AppFunctionSet($input: AppFunctionInput!) {
    appFunctionSet(input: $input) {
      appFunction {
        id
        handle
        title
        target
        enabled
        bytes
        lastError
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/** The function `dir` holds, as its `hatti.function.json` says; refused where it says too little. */
export async function functionConfigIn(dir: string): Promise<FunctionConfig> {
  const text = await readFile(join(dir, FUNCTION_CONFIG), 'utf8').catch(() => null);
  if (text === null) {
    throw new FunctionError(
      `No ${FUNCTION_CONFIG} in ${dir}: say the function's handle, title, target and module there`,
    );
  }
  let config: Partial<FunctionConfig>;
  try {
    config = JSON.parse(text) as Partial<FunctionConfig>;
  } catch {
    throw new FunctionError(`${FUNCTION_CONFIG} is not JSON`);
  }
  if (typeof config.handle !== 'string' || !HANDLE.test(config.handle)) {
    throw new FunctionError('Give the function a handle of lowercase letters, digits and hyphens');
  }
  if (typeof config.title !== 'string' || config.title.trim() === '') {
    throw new FunctionError('Give the function a title');
  }
  if (!TARGETS.includes(config.target as FunctionConfig['target'])) {
    throw new FunctionError(`Its target is one of ${TARGETS.join(' and ')}`);
  }
  if (typeof config.module !== 'string' || !insideOf(dir, config.module)) {
    throw new FunctionError('Name its module, a .wasm file within the directory');
  }
  if (config.build !== undefined && typeof config.build !== 'string') {
    throw new FunctionError('Its build is a command, as a string');
  }
  return {
    handle: config.handle,
    title: config.title.trim(),
    target: config.target as FunctionConfig['target'],
    module: config.module,
    ...(config.build && { build: config.build }),
  };
}

/** Whether `path`, relative to `dir`, stays within it. */
function insideOf(dir: string, path: string): boolean {
  const inside = relative(dir, resolve(dir, path));
  return inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`);
}

/**
 * Builds the function in `dir`, with its build command where it has one, its output to `out`:
 * its module, checked as the Admin API checks it before sending, a WebAssembly module of 256 KiB
 * at most.
 */
export async function buildFunction(
  dir: string,
  config: FunctionConfig,
  out: { log: (line: string) => void; error: (line: string) => void },
): Promise<Buffer> {
  if (config.build) {
    out.log(`Building: ${config.build}`);
    const code = await runCommand(config.build, dir, out);
    if (code !== 0) throw new FunctionError(`The build failed, with code ${code}`);
  }
  const module = await readFile(join(dir, config.module)).catch(() => null);
  if (!module) throw new FunctionError(`No module at ${config.module}: build it first`);
  if (module.length < WASM_HEADER.length || !module.subarray(0, 8).equals(WASM_HEADER)) {
    throw new FunctionError(`${config.module} is not a WebAssembly module`);
  }
  if (module.length > FUNCTION_LIMITS.moduleBytes) {
    throw new FunctionError(
      `${config.module} is ${Math.ceil(module.length / 1024)} KiB: functions are 256 KiB at most`,
    );
  }
  return module;
}

/** Runs `command` in a shell in `dir`, its output line by line to `out`: its exit code. */
function runCommand(
  command: string,
  dir: string,
  out: { log: (line: string) => void; error: (line: string) => void },
): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn(command, { cwd: dir, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = (write: (line: string) => void) => {
      let rest = '';
      return {
        add: (chunk: Buffer) => {
          const text = rest + chunk.toString('utf8');
          const parts = text.split('\n');
          rest = parts.pop() ?? '';
          for (const line of parts) write(line);
        },
        end: () => rest && write(rest),
      };
    };
    const stdout = lines(out.log);
    const stderr = lines(out.error);
    child.stdout.on('data', stdout.add);
    child.stderr.on('data', stderr.add);
    child.on('error', fail);
    child.on('close', (code) => {
      stdout.end();
      stderr.end();
      done(code ?? 1);
    });
  });
}

/**
 * Deploys the function: `module` as its new version, by its handle, which runs as the last did,
 * on or off as the shop left it (ADR-868).
 */
export async function deployFunction(
  client: HattiAdminClient,
  config: FunctionConfig,
  module: Buffer,
): Promise<FunctionSummary> {
  const { data } = await client.request<{
    appFunctionSet: {
      appFunction: FunctionSummary | null;
      userErrors: { field: string[] | null; message: string }[];
    };
  }>(SET, {
    input: {
      handle: config.handle,
      title: config.title,
      target: config.target,
      wasm: module.toString('base64'),
    },
  });
  const { appFunction, userErrors } = data.appFunctionSet;
  if (userErrors.length > 0 || !appFunction) {
    throw new FunctionError(userErrors.map((error) => error.message).join('; ') || 'Not deployed');
  }
  return appFunction;
}

/** The calling app's functions in the shop. */
export async function listFunctions(client: HattiAdminClient): Promise<FunctionSummary[]> {
  const { data } = await client.request<{ appFunctions: FunctionSummary[] }>(FUNCTIONS, {});
  return data.appFunctions;
}
