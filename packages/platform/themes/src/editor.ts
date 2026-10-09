import type { SectionSchema, Theme } from './theme.js';

/** The words in a theme's schemas that people read, which Shopify's `t:` keys may stand for. */
const WORDS = new Set(['name', 'label', 'info', 'content', 'placeholder', 'unit']);

/** A language as a theme's locale files name it: ur, en, or pt-BR. */
const LOCALE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

/** What a theme editor shows of a theme's schemas. */
export interface EditorSchemas {
  /** config/settings_schema.json: the theme's settings, in their groups. */
  settingsSchema: unknown[];
  /** Each section's `{% schema %}`: its settings, blocks and presets, by its type. */
  sections: { type: string; schema: SectionSchema }[];
}

/**
 * The theme's schemas as its editor shows them (ADR-323): the settings in their groups, and each
 * section's settings, blocks and presets, with the names, labels and notes people read in
 * `locale`. A theme gives them as Shopify's do, a `t:` key into `locales/<locale>.schema.json`;
 * the theme's default language stands in for words `locale` lacks, and a word that is no key
 * is as written. Defaults are left as they are: the storefront prints them.
 */
export function editorSchemas(theme: Theme, locale: string): EditorSchemas {
  const words = schemaWords(theme, locale);
  const source = theme.files['config/settings_schema.json'];
  const settingsSchema = source ? (JSON.parse(source) as unknown[]) : [];
  return {
    settingsSchema: translated(settingsSchema, words) as unknown[],
    sections: [...theme.schemas]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([type, schema]) => ({ type, schema: translated(schema, words) as SectionSchema })),
  };
}

/** Finds a `t:` key's words in the locale's schema translations, then the default language's. */
function schemaWords(theme: Theme, locale: string): (key: string) => string | undefined {
  const read = (path: string | undefined) => {
    const source = path ? theme.files[path] : undefined;
    return source ? (JSON.parse(source) as Record<string, unknown>) : {};
  };
  const defaultPath = Object.keys(theme.files).find((path) =>
    /^locales\/[\w-]+\.default\.schema\.json$/.test(path),
  );
  const chosen = LOCALE.test(locale)
    ? [`locales/${locale}.schema.json`, `locales/${locale}.default.schema.json`].find(
        (path) => theme.files[path] !== undefined,
      )
    : undefined;
  const tables = [read(chosen), read(defaultPath)];
  return (key) => {
    for (const table of tables) {
      let found: unknown = table;
      for (const part of key.split('.')) {
        found =
          typeof found === 'object' && found !== null
            ? (found as Record<string, unknown>)[part]
            : undefined;
      }
      if (typeof found === 'string') return found;
    }
    return undefined;
  };
}

function translated(value: unknown, words: (key: string) => string | undefined): unknown {
  if (Array.isArray(value)) return value.map((each) => translated(each, words));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      key === 'default'
        ? inner
        : WORDS.has(key) && typeof inner === 'string' && inner.startsWith('t:')
          ? (words(inner.slice(2)) ?? inner)
          : translated(inner, words),
    ]),
  );
}
