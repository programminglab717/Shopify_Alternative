// A theme's JSON files as the editor changes them (ADR-323): its templates, section groups and
// settings, each read from the core's editor data, changed here a step at a time, and saved
// whole. Shopify's shapes throughout, so that the storefront reads what is saved as it is.

/** A setting as a theme's schema gives it: the fields of Shopify's the editor reads. */
export interface Setting {
  type: string;
  id?: string;
  label?: string;
  info?: string;
  /** A header's or a paragraph's words. */
  content?: string;
  placeholder?: string;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { value: string; label?: string }[];
}

export interface BlockSchema {
  type: string;
  name?: string;
  limit?: number;
  settings?: Setting[];
}

export interface SectionSchema {
  name?: string;
  settings?: Setting[];
  blocks?: BlockSchema[];
  max_blocks?: number;
}

export interface BlockPlacement {
  type: string;
  settings?: Record<string, unknown>;
  disabled?: boolean;
}

/** A section as a template or a section group places it. */
export interface Placement {
  type: string;
  settings?: Record<string, unknown>;
  blocks?: Record<string, BlockPlacement>;
  block_order?: string[];
  disabled?: boolean;
}

/** A JSON template, templates/<name>.json, or a section group, sections/<group>.json. */
export interface SectionList {
  /** A section group's kind, such as header or footer. */
  type?: string;
  name?: string;
  /** A template's layout: theme unless given; false for none. */
  layout?: string | false;
  sections: Record<string, Placement>;
  order: string[];
}

/** config/settings_data.json: the theme's settings, or the name of one of its presets. */
export interface SettingsData {
  current?: Record<string, unknown> | string;
  presets?: Record<string, Record<string, unknown>>;
}

/** A group of the theme's own settings, as config/settings_schema.json gives them. */
export interface SettingsGroup {
  name: string;
  settings?: Setting[];
}

/** One of the theme's files as the core gave it. */
export interface EditorFile {
  filename: string;
  body: string;
  own: boolean;
  problems: string[];
}

export const SETTINGS_FILE = 'config/settings_data.json';

/** Templates in the order merchants look for them; others, such as alternates, after. */
const TEMPLATE_ORDER = [
  'index',
  'product',
  'collection',
  'page',
  'blog',
  'article',
  'search',
  'cart',
  'password',
  '404',
];

/** The theme's templates by name, such as index and product.unstitched, in a merchant's order. */
export function templatesOf(files: readonly EditorFile[]): string[] {
  const names = files
    .map((file) => /^templates\/([a-z0-9_.-]+)\.json$/.exec(file.filename)?.[1])
    .filter((name): name is string => name !== undefined);
  const rank = (name: string) => {
    const [base] = name.split('.');
    const at = TEMPLATE_ORDER.indexOf(base!);
    return at === -1 ? TEMPLATE_ORDER.length : at;
  };
  return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * The files a template's page shows, top to bottom: the section groups its layout renders, those
 * of the header kind above the template and the rest below. A template on a layout of its own,
 * such as the password page's, has none of them.
 */
export function pageFilesOf(
  template: string,
  read: (filename: string) => unknown,
  files: readonly EditorFile[],
): { above: string[]; template: string; below: string[] } {
  const filename = `templates/${template}.json`;
  const layout = (read(filename) as SectionList | null)?.layout;
  const groups =
    layout === undefined || layout === 'theme'
      ? files
          .map((file) => file.filename)
          .filter((name) => /^sections\/[a-z0-9_-]+\.json$/.test(name))
      : [];
  const isHeader = (name: string) => (read(name) as SectionList | null)?.type === 'header';
  return {
    above: groups.filter(isHeader),
    template: filename,
    below: groups.filter((name) => !isHeader(name)),
  };
}

/** A setting's value as placed, else its default. */
export function valueOf(setting: Setting, values: Readonly<Record<string, unknown>> | undefined) {
  const given = setting.id === undefined ? undefined : values?.[setting.id];
  return given === undefined ? setting.default : given;
}

/** The first words a section or block shows, to tell it from others of its kind. */
export function summaryOf(
  settings: readonly Setting[] | undefined,
  values: Readonly<Record<string, unknown>> | undefined,
): string {
  for (const setting of settings ?? []) {
    if (!['text', 'textarea', 'inline_richtext', 'collection'].includes(setting.type)) continue;
    const value = valueOf(setting, values);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** The order a section's blocks show in: its block_order, else as they are kept. */
export function blockOrderOf(placement: Placement): string[] {
  const blocks = placement.blocks ?? {};
  return (placement.block_order ?? Object.keys(blocks)).filter((id) => id in blocks);
}

function withSection(
  list: SectionList,
  id: string,
  change: (placement: Placement) => Placement,
): SectionList {
  return { ...list, sections: { ...list.sections, [id]: change(list.sections[id]!) } };
}

function moved(ids: readonly string[], id: string, by: -1 | 1): string[] {
  const from = ids.indexOf(id);
  const to = from + by;
  if (from === -1 || to < 0 || to >= ids.length) return [...ids];
  const next = [...ids];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

/** A section's setting set; an empty text leaves the setting empty, as Shopify's editor does. */
export function withSetting(
  list: SectionList,
  section: string,
  setting: string,
  value: unknown,
): SectionList {
  return withSection(list, section, (placement) => ({
    ...placement,
    settings: { ...placement.settings, [setting]: value },
  }));
}

export function withBlockSetting(
  list: SectionList,
  section: string,
  block: string,
  setting: string,
  value: unknown,
): SectionList {
  return withSection(list, section, (placement) => {
    const blocks = placement.blocks ?? {};
    const old = blocks[block]!;
    return {
      ...placement,
      blocks: { ...blocks, [block]: { ...old, settings: { ...old.settings, [setting]: value } } },
    };
  });
}

/** Shown or hidden: a hidden one is kept, as Shopify's `disabled`, and shows nothing. */
export function toggled(list: SectionList, section: string): SectionList {
  return withSection(list, section, ({ disabled, ...placement }) =>
    disabled ? placement : { ...placement, disabled: true },
  );
}

export function toggledBlock(list: SectionList, section: string, block: string): SectionList {
  return withSection(list, section, (placement) => {
    const { disabled, ...old } = placement.blocks![block]!;
    return {
      ...placement,
      blocks: { ...placement.blocks, [block]: disabled ? old : { ...old, disabled: true } },
    };
  });
}

export function movedSection(list: SectionList, section: string, by: -1 | 1): SectionList {
  return { ...list, order: moved(list.order, section, by) };
}

export function removedSection(list: SectionList, section: string): SectionList {
  const { [section]: _removed, ...sections } = list.sections;
  return { ...list, sections, order: list.order.filter((id) => id !== section) };
}

export function movedBlock(
  list: SectionList,
  section: string,
  block: string,
  by: -1 | 1,
): SectionList {
  return withSection(list, section, (placement) => ({
    ...placement,
    block_order: moved(blockOrderOf(placement), block, by),
  }));
}

export function removedBlock(list: SectionList, section: string, block: string): SectionList {
  return withSection(list, section, (placement) => {
    const { [block]: _removed, ...blocks } = placement.blocks ?? {};
    return {
      ...placement,
      blocks,
      block_order: blockOrderOf(placement).filter((id) => id !== block),
    };
  });
}

/** A block of `type` added at the end, its settings the schema's defaults until changed. */
export function addedBlock(
  list: SectionList,
  section: string,
  type: string,
  id: string = blockIdFor(type),
): SectionList {
  return withSection(list, section, (placement) => ({
    ...placement,
    blocks: { ...placement.blocks, [id]: { type, settings: {} } },
    block_order: [...blockOrderOf(placement), id],
  }));
}

/** An ID for a new block, as Shopify's IDs may be: letters, digits, "_" and "-". */
function blockIdFor(type: string): string {
  const name = type.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'block';
  return `${name}_${Math.random().toString(36).slice(2, 8)}`;
}

/** The kinds of block a section may take one more of, within each kind's limit and its own. */
export function blockTypesLeft(schema: SectionSchema | undefined, placement: Placement): string[] {
  const placed = Object.values(placement.blocks ?? {});
  if (schema?.max_blocks !== undefined && placed.length >= schema.max_blocks) return [];
  return (schema?.blocks ?? [])
    .filter(
      (block) =>
        block.limit === undefined ||
        placed.filter((each) => each.type === block.type).length < block.limit,
    )
    .map((block) => block.type);
}

/** The theme's settings now: its current ones, or those of the preset it names. */
export function currentSettings(data: SettingsData | null): Record<string, unknown> {
  if (!data) return {};
  return typeof data.current === 'string'
    ? { ...data.presets?.[data.current] }
    : { ...data.current };
}

/** One of the theme's settings set, a preset it named copied into its own first. */
export function withThemeSetting(
  data: SettingsData | null,
  setting: string,
  value: unknown,
): SettingsData {
  return { ...data, current: { ...currentSettings(data), [setting]: value } };
}
