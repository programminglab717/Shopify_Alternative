import { InputChecker as BaseInputChecker } from '@hatti/api';
import { fromMajor, type CurrencyCode } from '@hatti/money';
import { toHandle } from './handle.js';

export {
  fail,
  failOne,
  type FieldError,
  type FieldErrorCode,
  type MutationResult,
} from '@hatti/api';
export { isUniqueViolation } from '@hatti/db';

export const LIMITS = {
  title: 255,
  description: 100_000,
  shortText: 255,
  tags: 250,
  options: 3,
  optionValues: 100,
  variants: 250,
  media: 250,
  alt: 512,
  url: 2_048,
  handleAttempts: 20,
  /** Products per add, remove or reorder call. */
  batch: 250,
} as const;

/** Collects field errors while normalising catalog input. */
export class InputChecker extends BaseInputChecker {
  tags(field: string[], value: string[] | null | undefined): string[] {
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const raw of value ?? []) {
      const tag = raw.trim();
      if (tag.length === 0 || seen.has(tag.toLowerCase())) continue;
      if (tag.length > LIMITS.shortText) {
        this.add(field, 'TOO_LONG', `contain a tag longer than ${LIMITS.shortText} characters`);
      }
      seen.add(tag.toLowerCase());
      tags.push(tag);
    }
    if (tags.length > LIMITS.tags) this.add(field, 'TOO_MANY', `can have at most ${LIMITS.tags}`);
    return tags;
  }

  handle(field: string[], value: string): string | null {
    const handle = toHandle(value);
    if (!handle) this.add(field, 'INVALID', 'must contain letters or digits');
    return handle || null;
  }

  price(
    field: string[],
    value: string | null | undefined,
    currency: CurrencyCode,
    options: { required?: boolean } = {},
  ): bigint | null {
    if (value === null || value === undefined || value.trim() === '') {
      if (options.required) this.add(field, 'BLANK', "can't be blank");
      return null;
    }
    try {
      const amount = fromMajor(value.trim(), currency).amount;
      if (amount < 0n) throw new RangeError('negative');
      return amount;
    } catch {
      this.add(field, 'INVALID', 'must be an amount of zero or more, like 2499 or 2499.50');
      return null;
    }
  }

  /** An https URL, e.g. where an image is fetched from. */
  httpsUrl(field: string[], value: string | null | undefined): string | null {
    const trimmed = this.text(field, value, { required: true, max: LIMITS.url });
    if (trimmed === null) return null;
    try {
      const url = new URL(trimmed);
      if (url.protocol !== 'https:' || !url.hostname) throw new TypeError('not https');
      return url.toString();
    } catch {
      this.add(field, 'INVALID', 'must be an https:// URL');
      return null;
    }
  }
}
