import type { InputChecker } from '@hatti/api';
import { handleCandidate, toHandle } from '@hatti/catalog/public';
import { newId } from '@hatti/ids';
import { PAGE_HANDLE, TEMPLATE_SUFFIX, cleanPageBody } from './page-body.js';

// What a shop's pages, blogs and articles are given the same way (ADR-045, ADR-176): handles,
// HTML cleaned of anything that could run, and the theme's other templates.

/** Tries at handles from a title before one with a random end: about-us, about-us-2, … */
const HANDLE_ATTEMPTS = 20;

/** A handle as given, made one as the catalog makes them: "About Us" gives about-us. */
export function checkHandle(check: InputChecker, value: string): string {
  const handle = toHandle(value);
  if (handle === '' || !PAGE_HANDLE.test(handle)) {
    check.add(['handle'], 'INVALID', 'must contain letters or digits');
  }
  return handle;
}

/** HTML, cleaned, within `maxBytes`: "Body is too long (maximum is 512 KB)". */
export function checkHtml(
  check: InputChecker,
  field: string,
  value: string,
  maxBytes: number,
): string {
  const html = cleanPageBody(value);
  if (Buffer.byteLength(html) > maxBytes) {
    const name = field.charAt(0).toUpperCase() + field.slice(1);
    check.addMessage([field], 'TOO_LONG', `${name} is too long (maximum is ${maxBytes / 1024} KB)`);
  }
  return html;
}

/** A template suffix; undefined when not given, null to have none. */
export function checkSuffix(
  check: InputChecker,
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  const suffix = value?.trim() ?? '';
  if (suffix === '') return null;
  if (!TEMPLATE_SUFFIX.test(suffix)) {
    check.add(
      ['templateSuffix'],
      'INVALID',
      'may have only lower-case letters, digits, hyphens and underscores (at most 50)',
    );
  }
  return suffix;
}

/**
 * Inserts a row with the handle asked for, or else one made from its title: about-us, then
 * about-us-2 and on, then one with a random end. Safe to race: `insert` does nothing on a handle
 * taken, and the next is tried. The row; undefined when the handle asked for is taken.
 */
export async function insertWithHandle<R>(
  insert: (handle: string) => Promise<R | undefined>,
  handle: string | null,
  title: string,
  fallback: string,
): Promise<R | undefined> {
  if (handle !== null) return insert(handle);
  const base = toHandle(title) || fallback;
  for (let attempt = 0; attempt < HANDLE_ATTEMPTS; attempt++) {
    const row = await insert(handleCandidate(base, attempt));
    if (row) return row;
  }
  return insert(`${base.slice(0, 80)}-${newId().slice(-6)}`);
}
