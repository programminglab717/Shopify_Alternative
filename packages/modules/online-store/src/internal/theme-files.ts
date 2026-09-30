import type { InputChecker } from '@hatti/api';

/** The platform theme new themes are built on. */
export const BASE_THEME = 'hatti-base';
export const BASE_THEME_NAME = 'Hatti Base';

export const THEME_LIMITS = {
  /** Files saved or deleted at a time. */
  filesPerCall: 50,
  /** A shop's own files in one theme. */
  filesPerTheme: 100,
  /** A file, in bytes. */
  fileBytes: 256 * 1024,
  /** Sections in a template or section group, as Shopify allows. */
  sections: 25,
  /** Blocks in a section. */
  blocks: 50,
  /** Themes a shop keeps. */
  themes: 20,
  name: 100,
} as const;

/**
 * The files a shop may keep in a theme: JSON templates, including alternates such as
 * product.unstitched, section groups, and the theme's settings. Liquid, assets and translations
 * are the platform theme's (ADR-039).
 */
const FILENAME =
  /^(templates\/[a-z0-9_-]+(\.[a-z0-9_-]+)?|sections\/[a-z0-9_-]+|config\/settings_data)\.json$/;
const TYPE = /^[a-z0-9_-]+$/;
const BLOCK_TYPE = /^@?[a-z0-9_-]+$/;
/** Section and block IDs, as Shopify allows them: themes print them into pages' attributes. */
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const ID_RULE = 'may have only letters, digits, "_" and "-" (at most 100)';

export function isThemeFilename(filename: string): boolean {
  return FILENAME.test(filename);
}

/**
 * Checks a file a shop saves in a theme: its name, its size, and that its JSON has the shape the
 * storefront reads. Theme Check then checks it against the platform theme (`@hatti/themes`).
 */
export function checkThemeFile(
  check: InputChecker,
  field: string[],
  file: { filename: string; body: string },
): void {
  if (!FILENAME.test(file.filename)) {
    check.addMessage(
      [...field, 'filename'],
      'INVALID',
      `"${file.filename}" isn't a file a theme can keep: templates/<name>.json, ` +
        'sections/<group>.json or config/settings_data.json',
    );
    return;
  }
  const at = [...field, 'body'];
  if (Buffer.byteLength(file.body) > THEME_LIMITS.fileBytes) {
    check.addMessage(at, 'TOO_LONG', `${file.filename} is larger than 256 KB`);
    return;
  }
  let json: unknown;
  try {
    json = JSON.parse(file.body);
  } catch (error) {
    check.addMessage(at, 'INVALID', `${file.filename} isn't JSON: ${(error as Error).message}`);
    return;
  }
  const problem = file.filename.startsWith('config/')
    ? settingsProblem(json)
    : sectionListProblem(json, file.filename.startsWith('templates/'));
  if (problem) check.addMessage(at, 'INVALID', `${file.filename}: ${problem}`);
}

/** What is wrong with a template or section group, if anything. */
function sectionListProblem(json: unknown, template: boolean): string | null {
  if (!isObject(json)) return 'must be a JSON object';
  const { sections, order } = json;
  if (!isObject(sections) || !Array.isArray(order)) return 'needs "sections" and "order"';
  if (order.length > THEME_LIMITS.sections) {
    return `has more than ${THEME_LIMITS.sections} sections`;
  }
  const seen = new Set<string>();
  for (const id of order) {
    if (typeof id !== 'string' || seen.has(id)) return '"order" must list section IDs once each';
    if (!(id in sections)) return `"order" names "${id}", which is not in "sections"`;
    seen.add(id);
  }
  for (const [id, section] of Object.entries(sections)) {
    if (!ID.test(id)) return `section ID "${id}" ${ID_RULE}`;
    const problem = sectionProblem(section);
    if (problem) return `section "${id}" ${problem}`;
  }
  if (template && 'layout' in json) {
    const { layout } = json;
    if (layout !== false && !(typeof layout === 'string' && TYPE.test(layout))) {
      return '"layout" must name a layout, or be false';
    }
  }
  return null;
}

function sectionProblem(section: unknown): string | null {
  if (!isObject(section)) return 'must be an object';
  if (typeof section.type !== 'string' || !TYPE.test(section.type)) {
    return 'needs a "type": the section\'s file name';
  }
  if ('settings' in section && !isObject(section.settings)) return '"settings" must be an object';
  if ('disabled' in section && typeof section.disabled !== 'boolean') {
    return '"disabled" must be true or false';
  }
  if (!('blocks' in section)) return null;
  const { blocks } = section;
  if (!isObject(blocks)) return '"blocks" must be an object';
  if (Object.keys(blocks).length > THEME_LIMITS.blocks) {
    return `has more than ${THEME_LIMITS.blocks} blocks`;
  }
  for (const [id, block] of Object.entries(blocks)) {
    if (!ID.test(id)) return `block ID "${id}" ${ID_RULE}`;
    if (!isObject(block) || typeof block.type !== 'string' || !BLOCK_TYPE.test(block.type)) {
      return `block "${id}" needs a "type"`;
    }
    if ('settings' in block && !isObject(block.settings)) {
      return `block "${id}" "settings" must be an object`;
    }
  }
  if ('block_order' in section) {
    const order = section.block_order;
    if (!Array.isArray(order) || order.some((id) => typeof id !== 'string' || !(id in blocks))) {
      return '"block_order" must list its block IDs';
    }
  }
  return null;
}

/** What is wrong with config/settings_data.json, if anything. */
function settingsProblem(json: unknown): string | null {
  if (!isObject(json)) return 'must be a JSON object';
  const { current, presets } = json;
  if (presets !== undefined && !(isObject(presets) && Object.values(presets).every(isObject))) {
    return '"presets" must hold objects';
  }
  if (typeof current === 'string') {
    return isObject(presets) && isObject(presets[current])
      ? null
      : `"current" names the preset "${current}", which "presets" does not have`;
  }
  return current === undefined || isObject(current)
    ? null
    : '"current" must be an object, or name a preset';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
