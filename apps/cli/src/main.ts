#!/usr/bin/env node
import { watch } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { HattiAdminApiError, HattiAdminClient } from '@hatti/admin-client';
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
// custom app's token (ADR-395) from HATTI_ACCESS_TOKEN, at HATTI_API_URL, as Shopify's CLI takes
// a theme access token: the token is never written to disk. Its functions (ADR-922) are built
// and deployed as the app's own, with the same token.

export const USAGE = `Usage: hatti theme <command> [options]
       hatti function <command> [options]

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
  --dir <path>                 The theme's or function's directory; the current one unless given
  --allow-live                 Let push and dev change the theme shoppers see
  --no-build                   Deploy the module as it is, without running its build

Environment:
  HATTI_API_URL                Where Hatti's API answers: https://api.hatti.pk
  HATTI_ACCESS_TOKEN           A custom app's Admin API token: write_themes for themes,
                               write_settings for functions
`;

/** Runs the command `argv` names, writing what it says to `out`: its exit code. */
export async function run(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  out: { log: (line: string) => void; error: (line: string) => void },
  client?: HattiAdminClient,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: false,
    options: {
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
        const api = client ?? clientOf(env);
        if (!api) throw new FunctionError('Set HATTI_ACCESS_TOKEN to read the order: read_orders');
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
  const api = client ?? clientOf(env);
  if (!api) {
    out.error(
      `Set HATTI_ACCESS_TOKEN to a custom app token of the shop, with ${area === 'theme' ? 'write_themes' : 'write_settings'}.`,
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

/** The Admin API's client, with the token the environment gives; null without one. */
function clientOf(env: Readonly<Record<string, string | undefined>>): HattiAdminClient | null {
  return env.HATTI_ACCESS_TOKEN
    ? new HattiAdminClient({
        apiUrl: env.HATTI_API_URL ?? 'https://api.hatti.pk',
        accessToken: env.HATTI_ACCESS_TOKEN,
      })
    : null;
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
  run(process.argv.slice(2), process.env, out).then(
    (code) => process.exit(code),
    (error: unknown) => {
      out.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
