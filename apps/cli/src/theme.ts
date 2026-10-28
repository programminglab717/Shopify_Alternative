import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { HattiAdminClient } from '@hatti/admin-client';

// A shop's themes from the command line (DEV-08, ADR-850): listed, their files pulled into a
// directory and pushed back, as Shopify's CLI does for its themes. A Hatti theme's own files are
// JSON: its templates, its section groups and its settings (ADR-323); the platform theme's Liquid
// is the platform's. The shop's main theme, which shoppers see, is pushed to only when asked.

/** The files a shop keeps in a theme, by path. */
export const THEME_FILE =
  /^(templates\/[\w.-]+\.json|sections\/[\w.-]+\.json|config\/settings_data\.json)$/;

export interface ThemeSummary {
  id: string;
  name: string;
  role: string;
  previewUrl: string;
}

const THEMES = /* GraphQL */ `
  query Themes($after: String) {
    themes(first: 50, after: $after) {
      nodes {
        id
        name
        role
        previewUrl
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const THEME_FILES = /* GraphQL */ `
  query ThemeFiles($id: ID!) {
    theme(id: $id) {
      id
      name
      role
      previewUrl
      files {
        filename
        body
      }
    }
  }
`;

const UPSERT = /* GraphQL */ `
  mutation ThemeFilesUpsert($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    themeFilesUpsert(themeId: $themeId, files: $files) {
      upsertedThemeFiles {
        filename
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/** The shop's themes, the main one first. */
export async function listThemes(client: HattiAdminClient): Promise<ThemeSummary[]> {
  const themes: ThemeSummary[] = [];
  for await (const theme of client.paginate<ThemeSummary, { themes: never }>(
    THEMES,
    {},
    (data) => data.themes,
  )) {
    themes.push(theme);
  }
  return themes;
}

type ThemeWithFiles = ThemeSummary & { files: { filename: string; body: string }[] };

async function themeOf(client: HattiAdminClient, id: string): Promise<ThemeWithFiles> {
  const { data } = await client.request<{ theme: ThemeWithFiles | null }>(THEME_FILES, { id });
  if (!data.theme) throw new Error(`The shop has no theme ${id}`);
  return data.theme;
}

/** Writes the theme's files into `dir`, each at its path: what was written. */
export async function pullTheme(
  client: HattiAdminClient,
  id: string,
  dir: string,
): Promise<string[]> {
  const theme = await themeOf(client, id);
  const written: string[] = [];
  for (const file of theme.files) {
    // Its own path, never one that leaves the directory.
    if (!THEME_FILE.test(file.filename)) continue;
    const path = join(dir, ...file.filename.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.body.endsWith('\n') ? file.body : `${file.body}\n`);
    written.push(file.filename);
  }
  return written.sort();
}

/** The theme files under `dir`, by their paths in the theme. */
export async function themeFilesIn(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const folder of ['templates', 'sections', 'config']) {
    const entries = await readdir(join(dir, folder), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filename = `${folder}/${entry.name}`;
      if (THEME_FILE.test(filename)) found.push(filename);
    }
  }
  return found.sort();
}

export class ThemePushError extends Error {}

/**
 * Pushes `filenames`, or every theme file under `dir`, to the theme `id`: what was saved. The
 * main theme is pushed to only with `live`; a file that isn't JSON is refused before anything is
 * sent.
 */
export async function pushTheme(
  client: HattiAdminClient,
  id: string,
  dir: string,
  options: { live?: boolean; filenames?: readonly string[] } = {},
): Promise<string[]> {
  const theme = await themeOf(client, id);
  if (theme.role === 'MAIN' && !options.live) {
    throw new ThemePushError(
      `${theme.name} is the theme shoppers see: push to it with --allow-live, or to another theme`,
    );
  }
  const filenames = options.filenames ?? (await themeFilesIn(dir));
  const files = [];
  for (const filename of filenames) {
    if (!THEME_FILE.test(filename)) continue;
    const body = await readFile(join(dir, ...filename.split('/')), 'utf8');
    try {
      JSON.parse(body);
    } catch {
      throw new ThemePushError(`${filename} is not JSON: nothing was pushed`);
    }
    files.push({ filename, body });
  }
  if (files.length === 0) return [];
  const { data } = await client.request<{
    themeFilesUpsert: {
      upsertedThemeFiles: { filename: string }[];
      userErrors: { field: string[] | null; message: string }[];
    };
  }>(UPSERT, { themeId: id, files });
  const { upsertedThemeFiles, userErrors } = data.themeFilesUpsert;
  if (userErrors.length > 0) {
    throw new ThemePushError(userErrors.map((error) => error.message).join('; '));
  }
  return upsertedThemeFiles.map((file) => file.filename).sort();
}

/** A path under `dir`, as the theme names it; null for one that is none of its files. */
export function themePathOf(dir: string, path: string): string | null {
  const inside = relative(dir, path).split(sep).join('/');
  return THEME_FILE.test(inside) ? inside : null;
}

/** The theme's preview, for `dev` to show while it pushes. */
export async function previewOf(client: HattiAdminClient, id: string): Promise<string> {
  return (await themeOf(client, id)).previewUrl;
}
