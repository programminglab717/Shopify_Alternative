import { settingProblem } from './settings.js';
import { overlayTheme, type SettingSchema, type Theme } from './theme.js';

/**
 * Theme Check for a shop's file (ADR-039): what is wrong with it against the platform theme, as
 * the storefront would find it, each problem said without the file's name. Empty when the
 * storefront can use the file as it is: its sections, blocks and settings are the platform
 * theme's, each block within its section's limits, and each setting's value of its type.
 */
export function checkShopFile(base: Theme, filename: string, source: string): string[] {
  const problems: string[] = [];
  overlayTheme(base, { [filename]: source }, (error) => problems.push(error.problem));
  if (problems.length > 0) return problems;
  const json = JSON.parse(source) as Record<string, unknown>;
  if (filename.startsWith('config/')) return settingsDataProblems(base, json);
  for (const [id, placement] of Object.entries(json.sections as Record<string, Placement>)) {
    problems.push(...placementProblems(base, id, placement));
  }
  return problems;
}

interface Placement {
  type: string;
  settings?: Record<string, unknown>;
  blocks?: Record<string, { type: string; settings?: Record<string, unknown> }>;
}

/** A section as a template, a section group or the theme's settings place it. */
function placementProblems(base: Theme, id: string, placement: Placement): string[] {
  const where = `section "${id}"`;
  const schema = base.schemas.get(placement.type) ?? {};
  const problems = settingsProblems(where, schema.settings, placement.settings);
  const counts = new Map<string, number>();
  for (const [blockId, block] of Object.entries(placement.blocks ?? {})) {
    const blockSchema = schema.blocks?.find((each) => each.type === block.type);
    if (!blockSchema) {
      problems.push(`${where} takes no "${block.type}" blocks`);
      continue;
    }
    counts.set(block.type, (counts.get(block.type) ?? 0) + 1);
    const blockWhere = `block "${blockId}" of section "${id}"`;
    problems.push(...settingsProblems(blockWhere, blockSchema.settings, block.settings));
  }
  for (const blockSchema of schema.blocks ?? []) {
    const { limit, type } = blockSchema;
    if (limit !== undefined && (counts.get(type) ?? 0) > limit) {
      problems.push(`${where} takes at most ${limit} "${type}" block${limit === 1 ? '' : 's'}`);
    }
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (schema.max_blocks !== undefined && total > schema.max_blocks) {
    problems.push(`${where} takes at most ${schema.max_blocks} blocks`);
  }
  return problems;
}

function settingsProblems(
  where: string,
  schema: readonly SettingSchema[] | undefined,
  values: Readonly<Record<string, unknown>> | undefined,
): string[] {
  const problems: string[] = [];
  for (const [id, value] of Object.entries(values ?? {})) {
    const setting = schema?.find((each) => each.id === id);
    if (!setting) {
      problems.push(`${where} has no setting "${id}"`);
      continue;
    }
    // Left unset: the storefront uses the setting's default.
    if (value === null || value === '') continue;
    const problem = settingProblem(setting, value);
    if (problem) problems.push(`${where}'s "${id}" ${problem}`);
  }
  return problems;
}

/** config/settings_data.json: the theme's settings, and those of sections a layout names alone. */
function settingsDataProblems(base: Theme, json: Record<string, unknown>): string[] {
  const { current, presets } = json as {
    current?: Record<string, unknown> | string;
    presets?: Record<string, Record<string, unknown>>;
  };
  const values = typeof current === 'string' ? (presets?.[current] ?? {}) : (current ?? {});
  const { sections, ...settings } = values as Record<string, unknown> & {
    sections?: Record<string, Partial<Placement>>;
  };
  const problems = settingsProblems('the theme', base.settingsSchema, settings);
  for (const [name, placed] of Object.entries(sections ?? {})) {
    if (!base.schemas.has(name)) {
      problems.push(`the theme has no section "${name}" to set`);
      continue;
    }
    problems.push(...placementProblems(base, name, { ...placed, type: name }));
  }
  return problems;
}
