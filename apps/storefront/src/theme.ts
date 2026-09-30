import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** A theme's files by path, as published: "sections/header.liquid", "templates/index.json". */
export type ThemeFiles = Readonly<Record<string, string>>;

/** A setting in a section's, a block's or the theme's schema. */
export interface SettingSchema {
  type: string;
  id?: string;
  label?: string;
  default?: unknown;
  /** A range's or a number's bounds. */
  min?: number;
  max?: number;
  /** A select's or radio's choices. */
  options?: { value: unknown; label?: string }[];
}

/** A kind of block a section takes. */
export interface BlockSchema {
  type: string;
  name?: string;
  limit?: number;
  settings?: SettingSchema[];
}

/** A section's `{% schema %}`: its settings and the blocks it takes. */
export interface SectionSchema {
  name?: string;
  settings?: SettingSchema[];
  blocks?: BlockSchema[];
  max_blocks?: number;
}

/** A section as a JSON template or a section group places it. */
export interface SectionPlacement {
  type: string;
  settings?: Record<string, unknown>;
  blocks?: Record<string, BlockPlacement>;
  block_order?: string[];
  disabled?: boolean;
}

export interface BlockPlacement {
  type: string;
  settings?: Record<string, unknown>;
  disabled?: boolean;
}

/**
 * Sections in order: a JSON template (templates/product.json), or a section group
 * (sections/header-group.json) that a layout renders with `{% sections %}`.
 */
export interface SectionList {
  /** A template's layout: "theme" unless given; false for none. */
  layout?: string | false;
  sections: Record<string, SectionPlacement>;
  order: string[];
}

/** A theme, loaded: its files, and what the renderer reads from them once per version. */
export interface Theme {
  files: ThemeFiles;
  /** A digest of the files. Parsed templates, and pages cached at the edge, are per version. */
  version: string;
  /** Sections' schemas, by section type. */
  schemas: ReadonlyMap<string, SectionSchema>;
  /** Sections' `{% stylesheet %}` and `{% javascript %}` bodies, sent once a page uses them. */
  assets: ReadonlyMap<string, { css: string; js: string }>;
  /** The theme's settings: the merchant's, over the schema's defaults. */
  settings: Readonly<Record<string, unknown>>;
  /** config/settings_schema.json's settings, for their types. */
  settingsSchema: readonly SettingSchema[];
  /**
   * The sections and section groups each layout names (`{% section 'x' %}`, `{% sections 'x' %}`),
   * rendered beside the template's sections rather than from inside the layout.
   */
  layoutSections: ReadonlyMap<string, readonly { group: boolean; name: string }[]>;
  /** Translations by locale ("en", "ur"). */
  locales: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  defaultLocale: string;
}

/** A theme that cannot be published as it is, with the file at fault. */
export class ThemeError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
  }
}

/** Section and block IDs, as Shopify allows them: themes print them into pages' attributes. */
const ID = /^[A-Za-z0-9_-]{1,100}$/;

const RAW_BLOCK = (tag: string) =>
  new RegExp(`{%-?\\s*${tag}\\s*-?%}([\\s\\S]*?){%-?\\s*end${tag}\\s*-?%}`);

/**
 * Reads what the renderer needs from a theme's files: section schemas, section assets, settings
 * and translations. Throws a ThemeError naming the file for JSON that does not parse.
 */
export function loadTheme(files: ThemeFiles): Theme {
  const schemas = new Map<string, SectionSchema>();
  const assets = new Map<string, { css: string; js: string }>();
  for (const [path, source] of Object.entries(files)) {
    const type = /^sections\/([\w-]+)\.liquid$/.exec(path)?.[1];
    if (!type) continue;
    const schema = RAW_BLOCK('schema').exec(source)?.[1];
    schemas.set(type, schema ? (parseJson(path, schema) as SectionSchema) : {});
    const css = RAW_BLOCK('stylesheet').exec(source)?.[1]?.trim() ?? '';
    const js = RAW_BLOCK('javascript').exec(source)?.[1]?.trim() ?? '';
    if (css || js) assets.set(type, { css, js });
  }

  const locales = new Map<string, Record<string, unknown>>();
  let defaultLocale = 'en';
  for (const [path, source] of Object.entries(files)) {
    const match = /^locales\/([\w-]+?)(\.default)?\.json$/.exec(path);
    if (!match) continue;
    locales.set(match[1]!, parseJson(path, source) as Record<string, unknown>);
    if (match[2]) defaultLocale = match[1]!;
  }

  const layoutSections = new Map<string, { group: boolean; name: string }[]>();
  for (const [path, source] of Object.entries(files)) {
    const layout = /^layout\/([\w-]+)\.liquid$/.exec(path)?.[1];
    if (!layout) continue;
    layoutSections.set(
      layout,
      [...source.matchAll(/{%-?\s*(sections?)\s+['"]([\w-]+)['"]\s*-?%}/g)].map((match) => ({
        group: match[1] === 'sections',
        name: match[2]!,
      })),
    );
  }

  const { settings, settingsSchema } = themeSettings(files);
  return {
    files,
    version: createHash('sha256')
      .update(JSON.stringify(Object.entries(files).sort()))
      .digest('hex')
      .slice(0, 12),
    schemas,
    assets,
    settings,
    settingsSchema,
    layoutSections,
    locales,
    defaultLocale,
  };
}

/** The files a shop keeps in its theme, over the platform theme's (ADR-039). */
const SHOP_FILE =
  /^(templates\/[a-z0-9_-]+(\.[a-z0-9_-]+)?|sections\/[a-z0-9_-]+|config\/settings_data)\.json$/;

/**
 * A shop's theme: the platform theme with the shop's own JSON files over it. A file the renderer
 * could not use is left out, and the platform theme's shows instead: one that is not a shop's to
 * change, that does not parse, or a template naming a section the platform theme lacks.
 * `onRejected` hears of each.
 */
export function overlayTheme(
  base: Theme,
  files: ThemeFiles,
  onRejected?: (error: ThemeError) => void,
): Theme {
  const merged: Record<string, string> = { ...base.files };
  const taken: string[] = [];
  for (const [path, source] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    try {
      if (!SHOP_FILE.test(path)) throw new ThemeError(path, 'is not a file a shop can change');
      if (path.startsWith('config/')) {
        themeSettings({ ...base.files, [path]: source });
      } else {
        sectionList({ ...base, files: { ...base.files, [path]: source } }, path);
      }
      merged[path] = source;
      taken.push(path, source);
    } catch (error) {
      onRejected?.(error instanceof ThemeError ? error : new ThemeError(path, String(error)));
    }
  }
  // Only JSON changes: the platform theme's schemas, assets, layouts and translations stand.
  return {
    ...base,
    files: merged,
    settings: themeSettings(merged).settings,
    version: `${base.version}-${createHash('sha256').update(JSON.stringify(taken)).digest('hex').slice(0, 12)}`,
  };
}

/** A JSON template, templates/<name>.json; null if the theme has none. */
export function jsonTemplate(theme: Theme, name: string): SectionList | null {
  return sectionList(theme, `templates/${name}.json`);
}

/** A section group, sections/<name>.json, which a layout renders with `{% sections %}`. */
export function sectionGroup(theme: Theme, name: string): SectionList | null {
  return sectionList(theme, `sections/${name}.json`);
}

/** A section's settings as placed: the schema's defaults, then the placement's values. */
export function settingsOf(
  schema: readonly SettingSchema[] | undefined,
  given: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const setting of schema ?? []) {
    if (setting.id && setting.default !== undefined) settings[setting.id] = setting.default;
  }
  return { ...settings, ...given };
}

/** Every file under `dir`, by its path from it, as a theme's files. */
export async function readThemeDir(dir: string): Promise<ThemeFiles> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[relative(dir, path).split('\\').join('/')] = await readFile(path, 'utf8');
  }
  return files;
}

function sectionList(theme: Theme, path: string): SectionList | null {
  const source = theme.files[path];
  if (source === undefined) return null;
  const list = parseJson(path, source) as Partial<SectionList>;
  if (typeof list.sections !== 'object' || !Array.isArray(list.order)) {
    throw new ThemeError(path, 'needs "sections" and "order"');
  }
  for (const id of list.order) {
    const type = list.sections[id]?.type;
    if (!type) throw new ThemeError(path, `"order" names "${id}", which is not in "sections"`);
    if (theme.files[`sections/${type}.liquid`] === undefined) {
      throw new ThemeError(path, `section "${id}" is a "${type}", which the theme does not have`);
    }
  }
  for (const [id, placement] of Object.entries(list.sections)) {
    const blocks = Object.keys(placement?.blocks ?? {});
    const bad = ID.test(id) ? blocks.find((block) => !ID.test(block)) : id;
    if (bad !== undefined) {
      throw new ThemeError(path, `"${bad}" is not an ID: only letters, digits, "_" and "-"`);
    }
  }
  return list as SectionList;
}

/**
 * config/settings_schema.json's defaults, then config/settings_data.json's current values; and
 * the schema's settings.
 */
function themeSettings(files: ThemeFiles): {
  settings: Record<string, unknown>;
  settingsSchema: SettingSchema[];
} {
  const schemaSource = files['config/settings_schema.json'];
  const groups = schemaSource
    ? (parseJson('config/settings_schema.json', schemaSource) as { settings?: SettingSchema[] }[])
    : [];
  const dataSource = files['config/settings_data.json'];
  const data = dataSource
    ? (parseJson('config/settings_data.json', dataSource) as {
        current?: Record<string, unknown> | string;
        presets?: Record<string, Record<string, unknown>>;
      })
    : {};
  const current =
    typeof data.current === 'string' ? (data.presets?.[data.current] ?? {}) : (data.current ?? {});
  const settingsSchema = groups.flatMap((group) => group.settings ?? []);
  return { settings: settingsOf(settingsSchema, current), settingsSchema };
}

/** A section a layout names alone, `{% section 'header' %}`: its settings are the theme's. */
export function staticSection(theme: Theme, name: string): SectionPlacement {
  const source = theme.files['config/settings_data.json'];
  const data = source
    ? (parseJson('config/settings_data.json', source) as {
        current?: { sections?: Record<string, SectionPlacement> };
      })
    : {};
  const placed = typeof data.current === 'object' ? data.current.sections?.[name] : undefined;
  return { ...placed, type: name };
}

function parseJson(file: string, source: string): unknown {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new ThemeError(file, `is not valid JSON: ${(error as Error).message}`);
  }
}
