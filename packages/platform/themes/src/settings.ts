import type { SettingSchema } from './theme.js';

// What settings of these types may hold. A link or an image's address is a path on the
// storefront or a web address (a link may also be an email address or a phone number), with
// nothing that could end the attribute it is printed in.
const COLOR =
  /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\(\s*\d{1,3}(\s*,\s*\d{1,3}){2}(\s*,\s*(0|1|0?\.\d+))?\s*\))$/i;
const LINK = /^(\/(?![/\\])|https?:\/\/|mailto:|tel:)[^\s"'<>\\`]*$/i;
const IMAGE_SRC = /^(\/(?![/\\])|https:\/\/)[^\s"'<>\\`]*$/i;

/** A link a theme may print as it is: a path on the storefront, or a web, mail or phone address. */
export function isSafeLink(url: string): boolean {
  return LINK.test(url);
}

/** A setting's value if it is of the setting's type, else its default if that is, else null. */
export function settingValue(setting: SettingSchema, value: unknown): unknown {
  return ofType(setting, value) ?? ofType(setting, setting.default) ?? null;
}

/**
 * `value` as a setting of its type holds it, a number kept within its range; undefined if it is
 * not one. Shops' files can hold anything, and themes print colours, numbers and links as they
 * are, into styles and attributes.
 */
export function ofType(setting: SettingSchema, value: unknown): unknown {
  switch (setting.type) {
    case 'color':
      return typeof value === 'string' && COLOR.test(value) ? value : undefined;
    case 'range':
    case 'number': {
      const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof number !== 'number' || !Number.isFinite(number)) return undefined;
      return Math.min(Math.max(number, setting.min ?? -Infinity), setting.max ?? Infinity);
    }
    case 'checkbox':
      return typeof value === 'boolean' ? value : undefined;
    case 'select':
    case 'radio':
      return setting.options?.some((option) => option.value === value) ? value : undefined;
    case 'url':
      return typeof value === 'string' && LINK.test(value) ? value : undefined;
    case 'image_picker':
      return imageValue(value) ? value : undefined;
    case 'text':
    case 'textarea':
    case 'richtext':
    case 'inline_richtext':
    case 'html':
    case 'collection':
    case 'product':
    case 'page':
    case 'blog':
    case 'article':
    case 'link_list':
      return typeof value === 'string' ? value : undefined;
    default:
      return value;
  }
}

/** An image setting's value: its address, or the image with its size; null if it is neither. */
export function imageValue(
  value: unknown,
): { src: string; width: number; height: number; alt: string | null } | null {
  if (typeof value === 'string') {
    return IMAGE_SRC.test(value) ? { src: value, width: 0, height: 0, alt: null } : null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { src, width, height, alt } = value as Record<string, unknown>;
  if (typeof src !== 'string' || !IMAGE_SRC.test(src)) return null;
  const size = (pixels: unknown) =>
    typeof pixels === 'number' && Number.isFinite(pixels) && pixels > 0 ? Math.round(pixels) : 0;
  return {
    src,
    width: size(width),
    height: size(height),
    alt: typeof alt === 'string' ? alt : null,
  };
}

/**
 * What is wrong with a setting's value, as Theme Check says it; null if nothing is. A number
 * outside its range is wrong here, where the storefront would bring it within.
 */
export function settingProblem(setting: SettingSchema, value: unknown): string | null {
  const given = ofType(setting, value);
  const outside =
    typeof given === 'number' &&
    ((setting.min !== undefined && Number(value) < setting.min) ||
      (setting.max !== undefined && Number(value) > setting.max));
  if (given !== undefined && !outside) return null;
  switch (setting.type) {
    case 'color':
      return 'must be a colour, such as #0F766E';
    case 'range':
    case 'number':
      return setting.min !== undefined && setting.max !== undefined
        ? `must be a number from ${setting.min} to ${setting.max}`
        : 'must be a number';
    case 'checkbox':
      return 'must be true or false';
    case 'select':
    case 'radio':
      return `must be one of ${(setting.options ?? []).map((o) => JSON.stringify(o.value)).join(', ')}`;
    case 'url':
      return (
        'must be a path on the storefront, such as /collections/eid, or a web, mail or phone ' +
        'address'
      );
    case 'image_picker':
      return 'must be an image at a path on the storefront or an https address';
    case 'collection':
    case 'product':
    case 'page':
    case 'blog':
    case 'link_list':
      return `must be a ${setting.type === 'link_list' ? 'menu' : setting.type}'s handle`;
    case 'article':
      return "must be an article's blog's handle and its own, such as news/eid-edit";
    default:
      return 'must be text';
  }
}
