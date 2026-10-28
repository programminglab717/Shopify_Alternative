import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HattiAdminClient } from '@hatti/admin-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { USAGE, run } from './main.js';
import { listThemes, pullTheme, pushTheme, themeFilesIn, themePathOf } from './theme.js';

type Asked = { query: string; variables: Record<string, unknown> };

const MAIN = {
  id: 'thm_1',
  name: 'Hatti Base',
  role: 'MAIN',
  previewUrl: 'https://zari.hatti.pk/?preview=1',
};
const DRAFT = {
  id: 'thm_2',
  name: 'Eid edit',
  role: 'UNPUBLISHED',
  previewUrl: 'https://zari.hatti.pk/?preview=2',
};

/** A fake Admin API holding the two themes and their files, each request kept. */
function api() {
  const asked: Asked[] = [];
  const files: Record<string, { filename: string; body: string }[]> = {
    thm_1: [{ filename: 'templates/index.json', body: '{"sections":{}}' }],
    thm_2: [
      { filename: 'templates/index.json', body: '{"sections":{"hero":{}}}' },
      { filename: 'config/settings_data.json', body: '{"current":{}}\n' },
      // A path that would leave the directory: never written.
      { filename: '../../etc/passwd', body: 'x' },
    ],
  };
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Asked;
    asked.push(body);
    const answer = (data: unknown) =>
      new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (body.query.includes('query Themes')) {
      return answer({
        themes: { nodes: [MAIN, DRAFT], pageInfo: { hasNextPage: false, endCursor: null } },
      });
    }
    if (body.query.includes('query ThemeFiles')) {
      const id = body.variables.id as string;
      const theme = id === 'thm_1' ? MAIN : id === 'thm_2' ? DRAFT : null;
      return answer({ theme: theme && { ...theme, files: files[id] } });
    }
    const pushed = body.variables.files as { filename: string }[];
    return answer({
      themeFilesUpsert: {
        upsertedThemeFiles: pushed.map(({ filename }) => ({ filename })),
        userErrors: [],
      },
    });
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new HattiAdminClient({ apiUrl: 'https://api.hatti.test', accessToken: 'hat_x', fetch }),
    asked,
  };
}

describe('Themes from the command line (DEV-08, ADR-850)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hatti-theme-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists the shop's themes, and pulls a theme's own files, none outside the directory", async () => {
    const { client } = api();
    expect((await listThemes(client)).map((theme) => theme.id)).toEqual(['thm_1', 'thm_2']);
    expect(await pullTheme(client, 'thm_2', dir)).toEqual([
      'config/settings_data.json',
      'templates/index.json',
    ]);
    expect(await readFile(join(dir, 'templates', 'index.json'), 'utf8')).toBe(
      '{"sections":{"hero":{}}}\n',
    );
    expect(await themeFilesIn(dir)).toEqual(['config/settings_data.json', 'templates/index.json']);
    // Nothing but the theme's own folders.
    expect((await readdir(dir)).sort()).toEqual(['config', 'templates']);
  });

  it('pushes the directory to a theme, the live one only when asked, JSON alone', async () => {
    const { client, asked } = api();
    await mkdir(join(dir, 'templates'), { recursive: true });
    await writeFile(join(dir, 'templates', 'index.json'), '{"sections":{}}');
    await writeFile(join(dir, 'templates', 'notes.txt'), 'not a theme file');
    expect(await pushTheme(client, 'thm_2', dir)).toEqual(['templates/index.json']);
    expect(asked.at(-1)!.variables).toEqual({
      themeId: 'thm_2',
      files: [{ filename: 'templates/index.json', body: '{"sections":{}}' }],
    });
    await expect(pushTheme(client, 'thm_1', dir)).rejects.toThrow(/--allow-live/);
    expect(await pushTheme(client, 'thm_1', dir, { live: true })).toEqual(['templates/index.json']);
    await writeFile(join(dir, 'templates', 'index.json'), '{"sections":');
    await expect(pushTheme(client, 'thm_2', dir)).rejects.toThrow(
      'templates/index.json is not JSON',
    );
    expect(themePathOf(dir, join(dir, 'sections', 'header-group.json'))).toBe(
      'sections/header-group.json',
    );
    expect(themePathOf(dir, join(dir, 'assets', 'app.js'))).toBeNull();
  });

  it('runs as `hatti theme …`, saying how without a command or a token', async () => {
    const lines: string[] = [];
    const out = {
      log: (line: string) => lines.push(line),
      error: (line: string) => lines.push(`! ${line}`),
    };
    expect(await run([], {}, out)).toBe(1);
    expect(lines.at(-1)).toBe(USAGE);
    expect(await run(['theme', 'list'], {}, out)).toBe(1);
    expect(lines.at(-1)).toMatch(/^! Set HATTI_ACCESS_TOKEN/);
    const { client } = api();
    expect(await run(['theme', 'list'], {}, out, client)).toBe(0);
    expect(lines.slice(-2)).toEqual(['thm_1  [live] Hatti Base', 'thm_2  Eid edit']);
    expect(await run(['theme', 'push', '--theme', 'thm_1', '--dir', dir], {}, out, client)).toBe(1);
    expect(lines.at(-1)).toMatch(/^! Hatti Base is the theme shoppers see/);
    expect(await run(['theme', 'pull', '--theme', 'thm_2', '--dir', dir], {}, out, client)).toBe(0);
    expect(lines.at(-1)).toBe(`Pulled 2 files into ${dir}`);
  });
});
