#!/usr/bin/env node
import { watch } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { HattiAdminApiError, HattiAdminClient } from '@hatti/admin-client';
import { AgentError, ask, describeSchema, schemaOf, shortcut, variablesOf } from './agent.js';
import {
  credentialsPath,
  loginOf,
  readCredentials,
  writeCredentials,
  type ShopLogin,
} from './credentials.js';
import { LoginError, login, revoke, type LoginAccess } from './login.js';
import { serveMcp } from './mcp.js';
import {
  FUNCTION_CONFIG,
  FunctionError,
  LANGUAGES,
  RUN_LIMITS,
  TARGETS,
  buildFunction,
  deployFunction,
  functionConfigIn,
  initFunction,
  listFunctions,
  orderInput,
  runFunction,
} from './function.js';
import { ThemeCheckError, checkTheme } from './check.js';
import {
  ThemePushError,
  listThemes,
  previewOf,
  pullTheme,
  pushTheme,
  themePathOf,
} from './theme.js';

// `hatti`, Hatti's command line for developers (DEV-08, ADR-850). It asks the Admin API with a
// custom app's token (ADR-395): the one `hatti login` was given (ADR-990), kept readable by its
// owner alone, or HATTI_ACCESS_TOKEN's, at HATTI_API_URL, as Shopify's CLI takes a theme access
// token. Its functions (ADR-922) are built and deployed as the app's own, with the same token.
// What an AI agent asks - any query, the schema, the lists, an MCP server - answers in JSON.

/** This command line's version, as `hatti mcp` names itself. */
export const CLI_VERSION = '0.1.0';

export const USAGE = `Usage: hatti login [--access read|write]
       hatti api <query> [--variables <json>]
       hatti theme <command> [options]
       hatti function <command> [options]

Signing in, for a shop's owner or a manager:
  login                        Open the admin to let this terminal in to a shop, as an app
        --access <a>           What it asks for: read (the default) or write; you choose there
        --no-browser           Print the link alone, to open on another device
  logout                       Give up the shop's login: its token stops working
  whoami                       The shop signed in to, and what the login may do

For AI agents and scripts, answered in JSON:
  api <query> | --file <f> | - Ask the Admin API any query or mutation (- reads it from stdin)
      --variables <json>       Its variables, as {"first": 5}; or --var name=value, repeated
      --read-only              Refuse a mutation
  schema [--type <T>]          The API's schema, one type's whole, or
         [--search <words>]    the queries, mutations and types that match
  products list                The shop's products: --query <search>, --first <n>
  orders list                  Its orders, the newest first: --query <search>, --first <n>
  orders get <id | #number>    One order, with its items
  mcp [--allow-mutations]      An MCP server on stdin and stdout, for Claude and other agents;
                               it only reads unless allowed to change the shop

Theme commands:
  list                         The shop's themes, the main one first
  pull --theme <id>            Write the theme's files into the directory
  push --theme <id>            Save the directory's theme files to the theme
  dev --theme <id>             Push each file as it is saved, with the theme's preview
  check --theme <id>           Read its pages through its preview for accessibility problems
        --url <preview link>   ...or a preview link's, with no token needed

Function commands, for the function ${FUNCTION_CONFIG} describes:
  init <handle> --target <t>   Begin one in the directory: ${TARGETS.join(' or ')};
       [--lang <l>]            in ${LANGUAGES.join(' or ')}, javascript unless given
  build                        Run its build, and check its module as Hatti will
  run --input <file.json>      Build it, then run it on that input as checkout runs it
      --order <id> [--save f]  ...or on one of the shop's orders, as checkout would give it
  deploy                       Build it, then give it to the shop as the app's new version
  list                         The app's functions in the shop, and whether each is on

Options:
  --shop <handle>              Use that shop's login, of those signed in to
  --dir <path>                 The theme's or function's directory; the current one unless given
  --allow-live                 Let push and dev change the theme shoppers see
  --no-build                   Deploy the module as it is, without running its build

Environment:
  HATTI_API_URL                Where Hatti's API answers: https://api.hatti.pk
  HATTI_ACCESS_TOKEN           A custom app's Admin API token, used instead of a login:
                               write_themes for themes, write_settings for functions
  HATTI_CONFIG_DIR             Where logins are kept: ~/.config/hatti unless set
`;

/** What `run` reads and writes besides its lines, and how it waits: the process's, unless given. */
export interface RunIo {
  stdin?: Readable;
  stdout?: Writable;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  openBrowser?: ((url: string) => void) | null;
}

const AGENT_AREAS = new Set([
  'login',
  'logout',
  'whoami',
  'api',
  'schema',
  'products',
  'orders',
  'mcp',
]);

/** Runs the command `argv` names, writing what it says to `out`: its exit code. */
export async function run(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  out: { log: (line: string) => void; error: (line: string) => void },
  client?: HattiAdminClient,
  io: RunIo = {},
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: false,
    options: {
      shop: { type: 'string' },
      'api-url': { type: 'string' },
      access: { type: 'string' },
      device: { type: 'string' },
      'no-browser': { type: 'boolean' },
      variables: { type: 'string' },
      var: { type: 'string', multiple: true },
      file: { type: 'string' },
      'read-only': { type: 'boolean' },
      'allow-mutations': { type: 'boolean' },
      compact: { type: 'boolean' },
      json: { type: 'boolean' },
      type: { type: 'string' },
      search: { type: 'string' },
      query: { type: 'string' },
      first: { type: 'string' },
      theme: { type: 'string' },
      url: { type: 'string' },
      dir: { type: 'string' },
      'allow-live': { type: 'boolean' },
      'no-build': { type: 'boolean' },
      input: { type: 'string' },
      order: { type: 'string' },
      save: { type: 'string' },
      target: { type: 'string' },
      lang: { type: 'string' },
      title: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [area, command] = positionals;
  const shop = typeof values.shop === 'string' ? values.shop : null;
  if (!values.help && area && AGENT_AREAS.has(area)) {
    return agentCommand(area, positionals.slice(1), values, env, out, client, io);
  }
  if (values.help || (area !== 'theme' && area !== 'function') || !command) {
    out.log(USAGE);
    return values.help ? 0 : 1;
  }
  const dir = resolve(typeof values.dir === 'string' ? values.dir : '.');
  // Begun on this machine alone, from the target's starter (ADR-935).
  if (area === 'function' && command === 'init') {
    try {
      const written = await initFunction(dir, {
        handle: positionals[2] ?? '',
        target: typeof values.target === 'string' ? values.target : '',
        ...(typeof values.title === 'string' && { title: values.title }),
        ...(typeof values.lang === 'string' && { language: values.lang }),
      });
      out.log(`Began ${positionals[2]} in ${dir}: ${written.join(', ')}`);
      out.log(
        values.lang === 'rust'
          ? 'Build it with Rust, its target added once: rustup target add wasm32-wasip1. Then:'
          : 'Build it with Javy (https://github.com/bytecodealliance/javy), then:',
      );
      out.log('  hatti function run --input input.json');
      return 0;
    } catch (error) {
      if (error instanceof FunctionError) {
        out.error(error.message);
        return 1;
      }
      throw error;
    }
  }
  // Built and run on this machine alone: no token needed.
  if (area === 'function' && (command === 'build' || command === 'run')) {
    try {
      const config = await functionConfigIn(dir);
      const noBuild = values['no-build'] === true;
      const module = await buildFunction(
        dir,
        noBuild ? { ...config, build: undefined } : config,
        out,
      );
      if (command === 'build') {
        out.log(`Built ${config.handle}: ${config.module}, ${module.length} bytes`);
        return 0;
      }
      // Made from one of the shop's orders, with its token (ADR-950); else from a file.
      if (typeof values.order === 'string') {
        const api = client ?? (await clientOf(env, shop, io.fetch));
        if (!api)
          throw new FunctionError(
            'Run hatti login, or set HATTI_ACCESS_TOKEN, to read the order: read_orders',
          );
        const input = await orderInput(api, values.order, config.handle);
        if (typeof values.save === 'string') {
          await writeFile(resolve(values.save), `${JSON.stringify(input, null, 2)}\n`);
          out.log(`Saved the order's input to ${values.save}`);
        }
        return await runOn(module, input, out);
      }
      return await runLocally(module, typeof values.input === 'string' ? values.input : null, out);
    } catch (error) {
      if (error instanceof FunctionError || error instanceof HattiAdminApiError) {
        out.error(error.message);
        return 1;
      }
      throw error;
    }
  }
  // A preview link's pages read from here: a reviewer's link needs no token (ADR-968).
  if (area === 'theme' && command === 'check' && typeof values.url === 'string') {
    return checkCommand(values.url, out);
  }
  const api = client ?? (await clientOf(env, shop, io.fetch));
  if (!api) {
    out.error(
      `Run hatti login, or set HATTI_ACCESS_TOKEN to a custom app token of the shop, with ${area === 'theme' ? 'write_themes' : 'write_settings'}.`,
    );
    return 1;
  }
  if (area === 'function')
    return functionCommand(api, command, dir, values['no-build'] === true, out);
  const theme = typeof values.theme === 'string' ? values.theme : null;
  const live = values['allow-live'] === true;
  try {
    switch (command) {
      case 'list': {
        for (const each of await listThemes(api)) {
          out.log(`${each.id}  ${each.role === 'MAIN' ? '[live] ' : ''}${each.name}`);
        }
        return 0;
      }
      case 'pull': {
        if (!theme) throw new ThemePushError('Say which theme: --theme <id>');
        const written = await pullTheme(api, theme, dir);
        out.log(`Pulled ${written.length} files into ${dir}`);
        return 0;
      }
      case 'push': {
        if (!theme) throw new ThemePushError('Say which theme: --theme <id>');
        const saved = await pushTheme(api, theme, dir, { live });
        out.log(`Pushed ${saved.length} files`);
        return 0;
      }
      case 'dev': {
        if (!theme) throw new ThemePushError('Say which theme: --theme <id>');
        await pushTheme(api, theme, dir, { live });
        out.log(`Previewing at ${await previewOf(api, theme)}`);
        out.log('Watching for changes: press Ctrl+C to stop.');
        await devLoop(api, theme, dir, live, out);
        return 0;
      }
      case 'check': {
        if (!theme) throw new ThemePushError('Say which theme: --theme <id>, or --url <preview>');
        return await checkCommand(await previewOf(api, theme), out);
      }
      default:
        out.log(USAGE);
        return 1;
    }
  } catch (error) {
    if (error instanceof ThemePushError || error instanceof HattiAdminApiError) {
      out.error(error.message);
      return 1;
    }
    throw error;
  }
}

/**
 * `hatti function run`: the module on the input file's JSON, as checkout runs it (ADR-927), its
 * answer printed with how long it took against Hatti's limit; its exit code.
 */
async function runLocally(
  module: Uint8Array,
  inputPath: string | null,
  out: { log: (line: string) => void; error: (line: string) => void },
): Promise<number> {
  if (!inputPath) throw new FunctionError('Say what it runs on: --input <file.json>');
  const text = await readFile(resolve(inputPath), 'utf8').catch(() => null);
  if (text === null) throw new FunctionError(`No input at ${inputPath}`);
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new FunctionError(`${inputPath} is not JSON`);
  }
  return runOn(module, input, out);
}

/** `hatti theme check`: the preview's pages read by axe, each problem said; its exit code. */
async function checkCommand(
  previewUrl: string,
  out: { log: (line: string) => void; error: (line: string) => void },
): Promise<number> {
  try {
    const { pages, problems } = await checkTheme(previewUrl, { log: out.log });
    for (const problem of problems) {
      out.error(`${problem.page}: ${problem.rule} (${problem.impact}): ${problem.help}`);
      for (const element of problem.elements) out.error(`    ${element}`);
    }
    if (problems.length > 0) {
      out.error(`${problems.length} accessibility problems on ${pages} pages.`);
      return 1;
    }
    out.log(`No accessibility problems on ${pages} pages.`);
    return 0;
  } catch (error) {
    if (error instanceof ThemeCheckError) {
      out.error(error.message);
      return 1;
    }
    throw error;
  }
}

/** The module run on `input`, its answer printed with how long it took: its exit code. */
async function runOn(
  module: Uint8Array,
  input: unknown,
  out: { log: (line: string) => void; error: (line: string) => void },
): Promise<number> {
  const result = await runFunction(module, input);
  const took = `${result.ms.toFixed(1)} ms of the ${RUN_LIMITS.timeMs} ms Hatti allows`;
  if (!result.ok) {
    out.error(`It gave no answer (${result.error}): ${result.detail}`);
    out.error(`Ran ${took}`);
    return 1;
  }
  out.log(JSON.stringify(result.output, null, 2));
  out.log(`Ran in ${took}`);
  return 0;
}

const DEFAULT_API_URL = 'https://api.hatti.pk';

/**
 * The Admin API's client: with HATTI_ACCESS_TOKEN where set, else with the login of `shop`, or of
 * the shop last signed in to; null without either.
 */
async function clientOf(
  env: Readonly<Record<string, string | undefined>>,
  shop: string | null,
  fetcher?: typeof fetch,
): Promise<HattiAdminClient | null> {
  if (env.HATTI_ACCESS_TOKEN) {
    return new HattiAdminClient({
      apiUrl: env.HATTI_API_URL ?? DEFAULT_API_URL,
      accessToken: env.HATTI_ACCESS_TOKEN,
      ...(fetcher && { fetch: fetcher }),
    });
  }
  const kept = loginOf(await readCredentials(credentialsPath(env)), shop);
  return kept
    ? new HattiAdminClient({
        apiUrl: kept.apiUrl,
        accessToken: kept.accessToken,
        ...(fetcher && { fetch: fetcher }),
      })
    : null;
}

type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;
type Out = { log: (line: string) => void; error: (line: string) => void };

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** Reads `stream` to its end. */
async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/** `hatti login`, `logout`, `whoami`, `api`, `schema`, the lists and `mcp`: their exit code. */
async function agentCommand(
  area: string,
  args: readonly string[],
  values: Values,
  env: Readonly<Record<string, string | undefined>>,
  out: Out,
  given: HattiAdminClient | undefined,
  io: RunIo,
): Promise<number> {
  const shop = text(values.shop) ?? null;
  const path = credentialsPath(env);
  const json = (value: unknown) =>
    out.log(values.compact === true ? JSON.stringify(value) : JSON.stringify(value, null, 2));
  try {
    switch (area) {
      case 'login': {
        const access = text(values.access) ?? 'read';
        if (access !== 'read' && access !== 'write') {
          throw new LoginError('--access is read or write');
        }
        const apiUrl = text(values['api-url']) ?? env.HATTI_API_URL ?? DEFAULT_API_URL;
        const made = await login({
          apiUrl,
          access: access as LoginAccess,
          ...(text(values.device) && { device: text(values.device) }),
          out,
          ...(io.fetch && { fetch: io.fetch }),
          ...(io.sleep && { sleep: io.sleep }),
          openBrowser: values['no-browser'] === true ? null : io.openBrowser,
        });
        const credentials = await readCredentials(path);
        // Signed in again: the token it had gives itself up, as the shop keeps 20 apps at most.
        const before = credentials.logins[made.shopHandle];
        if (before && before.accessToken !== made.accessToken) await revoke(before, io.fetch);
        credentials.logins[made.shopHandle] = made;
        credentials.current = made.shopHandle;
        await writeCredentials(path, credentials);
        out.log('');
        out.log(`Signed in to ${made.shopName} (${made.shopHandle}): ${accessOf(made.scopes)}.`);
        out.log(`Kept in ${path}`);
        return 0;
      }
      case 'logout': {
        const credentials = await readCredentials(path);
        const handle = shop ?? credentials.current;
        const kept = handle ? credentials.logins[handle] : undefined;
        if (!handle || !kept) {
          out.error(handle ? `Not signed in to ${handle}` : 'Not signed in');
          return 1;
        }
        const revoked = await revoke(kept, io.fetch);
        delete credentials.logins[handle];
        if (credentials.current === handle) {
          credentials.current = Object.keys(credentials.logins)[0] ?? null;
        }
        await writeCredentials(path, credentials);
        out.log(
          revoked
            ? `Signed out of ${kept.shopName}: its token works no more.`
            : `Signed out of ${kept.shopName} here. Hatti could not be told: remove ${appNameOf(kept)} in Settings › Apps.`,
        );
        return 0;
      }
      case 'whoami': {
        const credentials = await readCredentials(path);
        const api = given ?? (await clientOf(env, shop, io.fetch));
        if (!api) {
          out.error('Not signed in: run hatti login');
          return 1;
        }
        const { data } = await api.request<{
          shop: { id: string; name: string; handle: string };
          accessScopes: string[];
        }>('{ shop { id name handle } accessScopes }');
        const from = env.HATTI_ACCESS_TOKEN ? 'HATTI_ACCESS_TOKEN' : 'login';
        if (values.json === true) {
          json({
            shop: data.shop,
            scopes: data.accessScopes,
            from,
            logins: Object.keys(credentials.logins),
          });
          return 0;
        }
        out.log(
          `${data.shop.name} (${data.shop.handle}), from ${from === 'login' ? 'hatti login' : from}`,
        );
        out.log(`It may: ${accessOf(data.accessScopes)}`);
        out.log(`Scopes: ${data.accessScopes.join(', ')}`);
        const others = Object.keys(credentials.logins).filter((each) => each !== data.shop.handle);
        if (others.length > 0) out.log(`Also signed in to: ${others.join(', ')} (use --shop)`);
        return 0;
      }
      case 'mcp': {
        const api = given ?? (await clientOf(env, shop, io.fetch));
        if (!api) {
          out.error('Not signed in: run hatti login first');
          return 1;
        }
        const kept = env.HATTI_ACCESS_TOKEN ? null : loginOf(await readCredentials(path), shop);
        out.error(
          `Hatti MCP server for ${kept?.shopName ?? 'the shop'}${values['allow-mutations'] === true ? ', allowed to change it' : ', reading only'}: on stdin and stdout.`,
        );
        await serveMcp(
          io.stdin ?? process.stdin,
          io.stdout ?? process.stdout,
          {
            client: api,
            shop: kept
              ? { shopName: kept.shopName, shopHandle: kept.shopHandle, scopes: kept.scopes }
              : null,
            allowMutations: values['allow-mutations'] === true,
            version: CLI_VERSION,
          },
          out.error,
        );
        return 0;
      }
    }
    const api = given ?? (await clientOf(env, shop, io.fetch));
    if (!api) {
      out.error('Not signed in: run hatti login, or set HATTI_ACCESS_TOKEN');
      return 1;
    }
    switch (area) {
      case 'api': {
        const file = text(values.file);
        const query =
          args[0] === '-'
            ? await readAll(io.stdin ?? process.stdin)
            : file
              ? await readFile(resolve(file), 'utf8').catch(() => {
                  throw new AgentError(`No file at ${file}`);
                })
              : (args[0] ?? '');
        const pairs = (Array.isArray(values.var) ? values.var : []).filter(
          (each): each is string => typeof each === 'string',
        );
        const answer = await ask(api, query, variablesOf(text(values.variables), pairs), {
          readOnly: values['read-only'] === true,
        });
        json(answer.data);
        return 0;
      }
      case 'schema': {
        out.log(
          describeSchema(await schemaOf(api), {
            type: text(values.type),
            search: text(values.search),
          }),
        );
        return 0;
      }
      default: {
        json(
          await shortcut(api, area as 'products' | 'orders', args[0] ?? 'list', {
            first: text(values.first),
            query: text(values.query),
            id: args[1],
          }),
        );
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof HattiAdminApiError) {
      const errors = error.errors.length > 0 ? error.errors : [{ message: error.message }];
      out.error(JSON.stringify({ errors }, null, 2));
      return 1;
    }
    if (error instanceof LoginError || error instanceof AgentError) {
      out.error(error.message);
      return 1;
    }
    throw error;
  }
}

/** What a login's scopes let it do, in words. */
function accessOf(scopes: readonly string[]): string {
  return scopes.some((scope) => scope.startsWith('write_'))
    ? 'read and change things'
    : 'only read';
}

function appNameOf(kept: ShopLogin): string {
  return `Hatti CLI · ${kept.device}`;
}

/** `hatti function deploy` or `list`, through the API: its exit code. */
async function functionCommand(
  api: HattiAdminClient,
  command: string,
  dir: string,
  noBuild: boolean,
  out: { log: (line: string) => void; error: (line: string) => void },
): Promise<number> {
  try {
    switch (command) {
      case 'list': {
        for (const each of await listFunctions(api)) {
          const state = each.enabled ? '[on] ' : '[off]';
          out.log(`${each.handle}  ${state} ${each.title} (${each.target})`);
          if (each.lastError) out.log(`  last failed: ${each.lastError}`);
        }
        return 0;
      }
      case 'deploy': {
        const config = await functionConfigIn(dir);
        const module = await buildFunction(
          dir,
          noBuild ? { ...config, build: undefined } : config,
          out,
        );
        const deployed = await deployFunction(api, config, module);
        out.log(`Deployed ${deployed.handle}, ${deployed.bytes} bytes as it runs`);
        out.log(
          deployed.enabled
            ? 'It is on: checkout runs this version now.'
            : 'It is off until the shop turns it on in Settings › Apps.',
        );
        return 0;
      }
      default:
        out.log(USAGE);
        return 1;
    }
  } catch (error) {
    if (error instanceof FunctionError || error instanceof HattiAdminApiError) {
      out.error(error.message);
      return 1;
    }
    throw error;
  }
}

/** Pushes each theme file as it is saved, a moment after the last change, until stopped. */
function devLoop(
  api: HattiAdminClient,
  theme: string,
  dir: string,
  live: boolean,
  out: { log: (line: string) => void; error: (line: string) => void },
): Promise<void> {
  return new Promise((done) => {
    const changed = new Set<string>();
    let timer: NodeJS.Timeout | null = null;
    const flush = async () => {
      timer = null;
      const filenames = [...changed];
      changed.clear();
      try {
        const saved = await pushTheme(api, theme, dir, { live, filenames });
        for (const filename of saved) out.log(`Pushed ${filename}`);
      } catch (error) {
        out.error(error instanceof Error ? error.message : String(error));
      }
    };
    const watcher = watch(dir, { recursive: true }, (_event, name) => {
      const filename = name ? themePathOf(dir, resolve(dir, name.toString())) : null;
      if (!filename) return;
      changed.add(filename);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void flush(), 300);
    });
    process.once('SIGINT', () => {
      watcher.close();
      done();
    });
  });
}

// Run as `hatti`, not when imported.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/hatti')) {
  const out = {
    log: (line: string) => void process.stdout.write(`${line}\n`),
    error: (line: string) => void process.stderr.write(`${line}\n`),
  };
  // Ended once what was written has reached its reader: a pipe takes a large answer in parts.
  const exit = (code: number) => process.stdout.write('', () => process.exit(code));
  run(process.argv.slice(2), process.env, out).then(exit, (error: unknown) => {
    out.error(error instanceof Error ? error.message : String(error));
    exit(1);
  });
}
