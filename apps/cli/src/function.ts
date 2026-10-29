import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { HattiAdminClient } from '@hatti/admin-client';
import { FunctionRunner, RUN_LIMITS, WasmError, takeWasm, type RunResult } from '@hatti/functions';

// An app's functions from the command line (DEV-07, ADR-922): built with the tool the developer
// chose, Javy, TinyGo or Rust's wasm32-wasi, and deployed to the shop through the Admin API's
// `appFunctionSet` (ADR-868), as Shopify's CLI deploys its functions. A function's directory says
// what it is in `hatti.function.json`. Its module is checked, and run on a sample input, with
// Hatti's own code, as checkout runs it (ADR-927). A new one is begun from a starter of its target
// (ADR-935), in JavaScript or Rust (ADR-942).

export const FUNCTION_CONFIG = 'hatti.function.json';

export const TARGETS = ['payment_customization', 'cart_validation'] as const;
/** The languages a function is begun in: JavaScript built with Javy, or Rust (ADR-942). */
export const LANGUAGES = ['javascript', 'rust'] as const;
const HANDLE = /^[a-z0-9][a-z0-9-]{0,62}$/;

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

/** Javy's own way to read standard input and write standard output, as JSON. */
const JAVY_IO = `function readInput() {
  const chunks = [];
  for (;;) {
    const buffer = new Uint8Array(1024);
    const read = Javy.IO.readSync(0, buffer);
    if (read === 0) break;
    chunks.push(buffer.subarray(0, read));
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function writeOutput(output) {
  Javy.IO.writeSync(1, new TextEncoder().encode(JSON.stringify(output)));
}
`;

/** Each target's starter: its code, and a cart to run it on. */
const STARTERS: Record<FunctionConfig['target'], { code: string; title: string }> = {
  payment_customization: {
    title: 'No cash on delivery above a limit',
    code: `// A payment customisation (ADR-868): it reads the cart and the ways to pay checkout would
// offer, and hides some. Here, cash on delivery above the shop's limit, Rs 10,000 unless the
// function's configuration says another, in paisa: { "limit": 1500000 }.
${JAVY_IO}
const input = readInput();
const limit = Number(input.configuration?.limit ?? 1000000);
const operations = [];
if (input.cart.subtotal > limit && input.paymentMethods.includes('cash_on_delivery')) {
  operations.push({ hide: { paymentMethod: 'cash_on_delivery' } });
}
writeOutput({ operations });
`,
  },
  cart_validation: {
    title: 'At most a few of each item',
    code: `// A cart validation (ADR-868): it reads the cart, and says what is wrong, which refuses the
// order, three messages at most. Here, more of an item than the shop sells to one shopper, 5
// unless the function's configuration says another: { "maxQuantity": 3 }.
${JAVY_IO}
const input = readInput();
const most = Number(input.configuration?.maxQuantity ?? 5);
const errors = input.cart.lines
  .filter((line) => line.quantity > most)
  .slice(0, 3)
  .map((line) => ({ message: \`\${line.title}: \${most} at most for each order\` }));
writeOutput({ errors });
`,
  },
};

/** The crate a Rust starter is, its module as small as Rust makes it: 256 KiB is the most. */
const CARGO_TOML = `[package]
name = "hatti-function"
version = "0.1.0"
edition = "2021"

[dependencies]
serde_json = "1"

[profile.release]
opt-level = "z"
lto = true
codegen-units = 1
panic = "abort"
strip = true
`;

/** Standard input read as JSON, and the answer written to standard output, as WASI gives them. */
const RUST_IO = `use serde_json::{json, Value};
use std::io::{self, Read, Write};

fn read_input() -> Value {
    let mut text = String::new();
    io::stdin().read_to_string(&mut text).expect("its input");
    serde_json::from_str(&text).expect("its input, as JSON")
}

fn write_output(output: Value) {
    io::stdout()
        .write_all(output.to_string().as_bytes())
        .expect("its answer");
}
`;

/** Each target's starter in Rust (ADR-942), as its JavaScript one does. */
const RUST_STARTERS: Record<FunctionConfig['target'], string> = {
  payment_customization: `// A payment customisation (ADR-868): it reads the cart and the ways to pay checkout would
// offer, and hides some. Here, cash on delivery above the shop's limit, Rs 10,000 unless the
// function's configuration says another, in paisa: { "limit": 1500000 }.
${RUST_IO}
fn main() {
    let input = read_input();
    let limit = input["configuration"]["limit"].as_i64().unwrap_or(1_000_000);
    let subtotal = input["cart"]["subtotal"].as_i64().unwrap_or(0);
    let offered = input["paymentMethods"]
        .as_array()
        .is_some_and(|methods| methods.iter().any(|method| method == "cash_on_delivery"));
    let mut operations = Vec::new();
    if subtotal > limit && offered {
        operations.push(json!({ "hide": { "paymentMethod": "cash_on_delivery" } }));
    }
    write_output(json!({ "operations": operations }));
}
`,
  cart_validation: `// A cart validation (ADR-868): it reads the cart, and says what is wrong, which refuses the
// order, three messages at most. Here, more of an item than the shop sells to one shopper, 5
// unless the function's configuration says another: { "maxQuantity": 3 }.
${RUST_IO}
fn main() {
    let input = read_input();
    let most = input["configuration"]["maxQuantity"].as_i64().unwrap_or(5);
    let errors: Vec<Value> = input["cart"]["lines"]
        .as_array()
        .map(|lines| lines.as_slice())
        .unwrap_or_default()
        .iter()
        .filter(|line| line["quantity"].as_i64().unwrap_or(0) > most)
        .take(3)
        .map(|line| {
            let title = line["title"].as_str().unwrap_or("An item");
            json!({ "message": format!("{title}: {most} at most for each order") })
        })
        .collect();
    write_output(json!({ "errors": errors }));
}
`,
};

/** How a Rust starter is built: for WASI, its module copied to where Hatti reads it. */
const RUST_BUILD =
  'cargo build --release --target wasm32-wasip1 && mkdir -p dist && ' +
  'cp target/wasm32-wasip1/release/hatti-function.wasm dist/function.wasm';

/** A cart as checkout gives a function (ADR-868), to run a starter on. */
const SAMPLE_INPUT = {
  cart: {
    subtotal: 1250000,
    currency: 'PKR',
    lines: [
      {
        variantId: 'var_1',
        productId: 'prod_1',
        title: 'Lawn suit',
        variantTitle: 'Medium',
        sku: 'LAWN-M',
        quantity: 6,
        price: 250000,
      },
    ],
  },
  deliveryAddress: { city: 'Lahore', province: 'Punjab' },
  paymentMethods: ['cash_on_delivery', 'bank_transfer'],
  configuration: {},
};

/**
 * Begins a function of `target` in `dir` (ADR-935), as Shopify's CLI generates an extension: its
 * `hatti.function.json`, a starter in JavaScript built with Javy, or in Rust built with Cargo for
 * WASI (ADR-942), and a sample cart to run it on with `hatti function run --input input.json`.
 * Refused where `dir` holds a function already. The files it wrote.
 */
export async function initFunction(
  dir: string,
  options: { handle: string; target: string; title?: string; language?: string },
): Promise<string[]> {
  if (!HANDLE.test(options.handle)) {
    throw new FunctionError('Give the function a handle of lowercase letters, digits and hyphens');
  }
  if (!TARGETS.includes(options.target as FunctionConfig['target'])) {
    throw new FunctionError(`Its target is one of ${TARGETS.join(' and ')}`);
  }
  const language = options.language ?? 'javascript';
  if (!LANGUAGES.includes(language as (typeof LANGUAGES)[number])) {
    throw new FunctionError(`Its language is one of ${LANGUAGES.join(' and ')}`);
  }
  const target = options.target as FunctionConfig['target'];
  const rust = language === 'rust';
  const exists = await readFile(join(dir, FUNCTION_CONFIG), 'utf8').then(
    () => true,
    () => false,
  );
  if (exists) throw new FunctionError(`${dir} has a ${FUNCTION_CONFIG} already`);
  const config: FunctionConfig = {
    handle: options.handle,
    title: options.title?.trim() || STARTERS[target].title,
    target,
    build: rust ? RUST_BUILD : 'javy build src/index.js -o dist/function.wasm',
    module: 'dist/function.wasm',
  };
  await mkdir(join(dir, 'src'), { recursive: true });
  const files: [string, string][] = [
    [FUNCTION_CONFIG, `${JSON.stringify(config, null, 2)}\n`],
    ...(rust
      ? ([
          ['Cargo.toml', CARGO_TOML],
          ['src/main.rs', RUST_STARTERS[target]],
          ['.gitignore', '/target\n/dist\n'],
        ] as [string, string][])
      : ([['src/index.js', STARTERS[target].code]] as [string, string][])),
    ['input.json', `${JSON.stringify(SAMPLE_INPUT, null, 2)}\n`],
  ];
  for (const [path, text] of files) await writeFile(join(dir, path), text, { flag: 'wx' });
  return files.map(([path]) => path);
}

/** Whether `path`, relative to `dir`, stays within it. */
function insideOf(dir: string, path: string): boolean {
  const inside = relative(dir, resolve(dir, path));
  return inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`);
}

/**
 * Builds the function in `dir`, with its build command where it has one, its output to `out`:
 * its module, checked as the Admin API checks it, with Hatti's own code (ADR-927): a WebAssembly
 * module of 256 KiB at most that compiles, its memory its own.
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
  try {
    await takeWasm(module);
  } catch (error) {
    if (error instanceof WasmError) throw new FunctionError(`${config.module}: ${error.message}`);
    throw error;
  }
  return module;
}

/**
 * Runs `module` on `input` as checkout runs it (ADR-927): capped, in a worker of Hatti's own with
 * its input on standard input alone, stopped past {@link RUN_LIMITS.timeMs}. Its answer, or why
 * there is none, and how long it took.
 */
export async function runFunction(module: Uint8Array, input: unknown): Promise<RunResult> {
  const capped = await takeWasm(module);
  const runner = new FunctionRunner();
  try {
    return await runner.run(createHash('sha256').update(capped).digest('hex'), capped, input);
  } finally {
    await runner.close();
  }
}

export { RUN_LIMITS };

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
