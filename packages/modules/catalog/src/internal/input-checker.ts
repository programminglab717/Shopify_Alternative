import { InputChecker as BaseInputChecker } from '@hatti/api';
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
  handle(field: string[], value: string): string | null {
    const handle = toHandle(value);
    if (!handle) this.add(field, 'INVALID', 'must contain letters or digits');
    return handle || null;
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
