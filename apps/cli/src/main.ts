#!/usr/bin/env node
import { watch } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { HattiAdminApiError, HattiAdminClient } from '@hatti/admin-client';
import {
  FUNCTION_CONFIG,
  FunctionError,
  buildFunction,
  deployFunction,
  functionConfigIn,
  listFunctions,
} from './function.js';
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

Function commands, for the function ${FUNCTION_CONFIG} describes:
  build                        Run its build, and check its module as Hatti will
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
      dir: { type: 'string' },
      'allow-live': { type: 'boolean' },
      'no-build': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [area, command] = positionals;
  if (values.help || (area !== 'theme' && area !== 'function') || !command) {
    out.log(USAGE);
    return values.help ? 0 : 1;
  }
  const dir = resolve(typeof values.dir === 'string' ? values.dir : '.');
  // Built on this machine alone: no token needed.
  if (area === 'function' && command === 'build') {
    try {
      const config = await functionConfigIn(dir);
      const module = await buildFunction(dir, config, out);
      out.log(`Built ${config.handle}: ${config.module}, ${module.length} bytes`);
      return 0;
    } catch (error) {
      if (error instanceof FunctionError) {
        out.error(error.message);
        return 1;
      }
      throw error;
    }
  }
  const api =
    client ??
    (env.HATTI_ACCESS_TOKEN
      ? new HattiAdminClient({
          apiUrl: env.HATTI_API_URL ?? 'https://api.hatti.pk',
          accessToken: env.HATTI_ACCESS_TOKEN,
        })
      : null);
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
