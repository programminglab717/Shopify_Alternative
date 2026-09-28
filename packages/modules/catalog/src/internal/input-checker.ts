import { fromMajor, type CurrencyCode } from '@hatti/money';
import { toHandle } from './handle.js';

export type FieldErrorCode =
  'BLANK' | 'TOO_LONG' | 'TOO_MANY' | 'TOO_FEW' | 'INVALID' | 'TAKEN' | 'IN_USE' | 'NOT_FOUND';

export interface FieldError {
  field: string[];
  code: FieldErrorCode;
  message: string;
}

export type MutationResult<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

/** Whether a database error, or one it wraps, is a unique violation. */
export function isUniqueViolation(error: unknown): boolean {
  let current = error as { code?: string; cause?: unknown } | undefined;
  while (current) {
    if (current.code === '23505') return true;
    current = current.cause as { code?: string; cause?: unknown } | undefined;
  }
  return false;
}

export function fail<T>(errors: FieldError[]): MutationResult<T> {
  return { ok: false, errors };
}

export function failOne<T>(
  field: string[],
  code: FieldErrorCode,
  message: string,
): MutationResult<T> {
  return { ok: false, errors: [{ field, code, message }] };
}

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

/** "productType" → "Product type", for messages like "Product type is too long". */
function humanize(name: string): string {
  const words = name.replace(/([A-Z])/g, ' $1').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Collects field errors while normalising input. */
export class InputChecker {
  readonly errors: FieldError[] = [];

  get ok(): boolean {
    return this.errors.length === 0;
  }

  text(
    field: string[],
    value: string | null | undefined,
    options: { required?: boolean; max: number },
  ): string | null {
    const trimmed = value?.trim() ?? '';
    if (trimmed.length === 0) {
      if (options.required) this.add(field, 'BLANK', "can't be blank");
      return null;
    }
    if (trimmed.length > options.max) {
      this.add(field, 'TOO_LONG', `is too long (maximum is ${options.max} characters)`);
    }
    return trimmed;
  }

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

  /** A whole number within bounds, e.g. a weight in grams. */
  integer(
    field: string[],
    value: number | null | undefined,
    options: { min: number; max: number },
  ): number | null {
    if (value === null || value === undefined) return null;
    if (!Number.isInteger(value) || value < options.min || value > options.max) {
      this.add(field, 'INVALID', `must be a whole number from ${options.min} to ${options.max}`);
      return null;
    }
    return value;
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

  add(field: string[], code: FieldErrorCode, message: string): void {
    this.errors.push({
      field,
      code,
      message: `${humanize(field[field.length - 1] ?? 'input')} ${message}`,
    });
  }

  /** An error whose message is already a sentence. */
  addMessage(field: string[], code: FieldErrorCode, message: string): void {
    this.errors.push({ field, code, message });
  }
}
