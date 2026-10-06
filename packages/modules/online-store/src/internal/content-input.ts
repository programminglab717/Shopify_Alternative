import type { InputChecker } from '@hatti/api';
import { handleCandidate, toHandle } from '@hatti/catalog/public';
import { newId } from '@hatti/ids';
import { PAGE_HANDLE, TEMPLATE_SUFFIX, cleanPageBody } from './page-body.js';

// What a shop's pages, blogs and articles are given the same way (ADR-045, ADR-176): handles,
// HTML cleaned of anything that could run, the theme's other templates, and when pages and
// articles are published, now or at a time ahead (ADR-215, ADR-217).

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

/** How far ahead of the server's clock a publish date is still now, for clients' clocks running fast. */
const CLOCK_SKEW_MS = 60_000;

/**
 * A publish date as given (ADR-215): a time gone by, or one ahead, at most `days`; one a minute
 * ahead or less, as a client's clock running fast gives, is now. Undefined when not given.
 */
export function checkPublishDate(
  check: InputChecker,
  value: Date | null | undefined,
  days: number,
): Date | undefined {
  if (value === undefined || value === null) return undefined;
  if (Number.isNaN(value.getTime())) {
    check.add(['publishDate'], 'INVALID', 'is not a date');
  } else if (value.getTime() > Date.now() + days * 86_400_000) {
    check.add(['publishDate'], 'INVALID', "can't be more than a year ahead");
  }
  return value.getTime() > Date.now() && value.getTime() <= Date.now() + CLOCK_SKEW_MS
    ? new Date()
    : value;
}

/** Whether a page or an article published at `at` shows now: published, and its time come. */
export function shownBy(at: Date | null): boolean {
  return at !== null && at.getTime() <= Date.now();
}

/** What a page's or an article's publication becomes, and what of it changed (ADR-215). */
export interface Publication {
  /** When it is published; null when hidden, undefined for now, as the database's clock says. */
  publishedAt: Date | null | undefined;
  /** Published at a time ahead, until the worker shows it. */
  scheduled: boolean;
  /** Shown now, as its events say. */
  shown: boolean;
  /** Of `isPublished` and `publishedAt`, those that changed. */
  changed: ('isPublished' | 'publishedAt')[];
}

/**
 * A page's or an article's publication as `isPublished` and `publishDate` make it of `current`,
 * or of a new one (ADR-215): published unless hidden, now or at its date; one published keeps its
 * time unless given another, and one hidden then published again shows now. Shown or hidden alone
 * says `isPublished`; a date moved, or one ahead set or taken off, `publishedAt`. One whose time
 * came but which the worker has not shown yet counts as not shown.
 */
export function publicationOf(
  current: { publishedAt: Date | null; scheduled: boolean } | null,
  isPublished: boolean | null | undefined,
  publishDate: Date | undefined,
): Publication {
  const before = current?.publishedAt ?? null;
  const published = isPublished ?? (current ? before !== null : true);
  const at = published ? (publishDate ?? before ?? undefined) : null;
  const shown = published && (at === undefined || shownBy(at));
  if (!current) return { publishedAt: at, scheduled: published && !shown, shown, changed: [] };
  const wasShown = shownBy(before) && !current.scheduled;
  const moved =
    at === null ? before !== null : at === undefined || at.getTime() !== before?.getTime();
  const toggled = (before === null && shown) || (at === null && wasShown);
  return {
    publishedAt: at,
    scheduled: published && !shown,
    shown,
    changed: [
      ...(wasShown !== shown ? (['isPublished'] as const) : []),
      ...(moved && !toggled ? (['publishedAt'] as const) : []),
    ],
  };
}
