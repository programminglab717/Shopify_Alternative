import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadTheme, readThemeDir, type Theme, type ThemeFiles } from './theme.js';

// Hatti's own themes (OS-01, ADR-730), each a folder under themes/ at the repository's root,
// listed in themes/library.json in the order shops are offered them. A theme may be built on
// another: its folder holds only the files it changes, laid over its parent's, so the vertical
// themes keep Hatti Base's sections and change what they look like and how their pages begin.

/** A platform theme as the library lists it. */
export interface PlatformThemeInfo {
  /** Its folder, and the name a shop's theme keeps as its base: "hatti-base". */
  handle: string;
  name: string;
  /** What it is for, in a line, in English and Urdu. */
  description: { en: string; ur: string };
  /** The theme it is built on, if any. */
  extends: string | null;
}

const NAME = /^[a-z0-9-]{1,40}$/;
const loaded = new Map<string, Promise<Theme>>();
let library: Promise<readonly PlatformThemeInfo[]> | null = null;

/** Where a platform theme's files are: themes/<name> at the repository's root. */
export function platformThemeDir(name: string): string {
  if (!NAME.test(name)) throw new Error(`There is no platform theme "${name}"`);
  return fileURLToPath(new URL(`../../../../themes/${name}`, import.meta.url));
}

/** The platform themes, in the order shops are offered them, Hatti Base first. */
export function platformThemes(): Promise<readonly PlatformThemeInfo[]> {
  library ??= readFile(
    fileURLToPath(new URL('../../../../themes/library.json', import.meta.url)),
    'utf8',
  ).then((source) => libraryOf(JSON.parse(source) as unknown));
  library.catch(() => (library = null));
  return library;
}

/** The library's entries, checked: known names, parents listed before their children. */
export function libraryOf(value: unknown): PlatformThemeInfo[] {
  if (!Array.isArray(value)) throw new Error('themes/library.json is not a list');
  const seen = new Set<string>();
  return value.map((entry: Partial<PlatformThemeInfo>) => {
    const handle = String(entry?.handle ?? '');
    if (!NAME.test(handle) || seen.has(handle)) {
      throw new Error(`themes/library.json: "${handle}" is no theme's name, or is listed twice`);
    }
    const parent = entry.extends ?? null;
    if (parent !== null && !seen.has(parent)) {
      throw new Error(
        `themes/library.json: "${handle}" is built on "${parent}", not listed before it`,
      );
    }
    if (typeof entry.name !== 'string' || !entry.description?.en || !entry.description?.ur) {
      throw new Error(
        `themes/library.json: "${handle}" needs a name and a description in en and ur`,
      );
    }
    seen.add(handle);
    return {
      handle,
      name: entry.name,
      description: { en: entry.description.en, ur: entry.description.ur },
      extends: parent,
    };
  });
}

/** Whether `name` is one of the library's themes. */
export async function isPlatformTheme(name: string): Promise<boolean> {
  return (await platformThemes()).some((theme) => theme.handle === name);
}

/**
 * A platform theme, such as hatti-base, read once per process: a theme built on another is its
 * parent's files with its own over them.
 */
export function platformTheme(name: string): Promise<Theme> {
  let theme = loaded.get(name);
  if (!theme) {
    theme = platformFiles(name).then(loadTheme);
    loaded.set(name, theme);
    theme.catch(() => loaded.delete(name));
  }
  return theme;
}

/** Every platform theme, by its handle. */
export async function allPlatformThemes(): Promise<ReadonlyMap<string, Theme>> {
  const themes = new Map<string, Theme>();
  for (const { handle } of await platformThemes()) themes.set(handle, await platformTheme(handle));
  return themes;
}

async function platformFiles(name: string): Promise<ThemeFiles> {
  const own = await readThemeDir(platformThemeDir(name));
  const info = (await platformThemes().catch(() => [])).find((theme) => theme.handle === name);
  if (!info?.extends) return own;
  return { ...(await platformTheme(info.extends)).files, ...own };
}
