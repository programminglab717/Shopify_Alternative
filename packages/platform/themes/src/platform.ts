import { fileURLToPath } from 'node:url';
import { loadTheme, readThemeDir, type Theme } from './theme.js';

const loaded = new Map<string, Promise<Theme>>();

/** Where a platform theme's files are: themes/<name> at the repository's root. */
export function platformThemeDir(name: string): string {
  if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error(`There is no platform theme "${name}"`);
  return fileURLToPath(new URL(`../../../../themes/${name}`, import.meta.url));
}

/** A platform theme, such as hatti-base, read once per process. */
export function platformTheme(name: string): Promise<Theme> {
  let theme = loaded.get(name);
  if (!theme) {
    theme = readThemeDir(platformThemeDir(name)).then(loadTheme);
    loaded.set(name, theme);
    theme.catch(() => loaded.delete(name));
  }
  return theme;
}
