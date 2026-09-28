import { fromMajor, type CurrencyCode } from '@hatti/money';

/**
 * Mutation results and input checking shared by modules. A mutation returns user errors for bad
 * input instead of throwing, so clients can show them next to the fields at fault.
 */

/** Stable codes of user errors. Clients branch on these, so never rename one. */
export type FieldErrorCode =
  | 'BLANK'
  | 'TOO_LONG'
  | 'TOO_MANY'
  | 'TOO_FEW'
  | 'INVALID'
  | 'TAKEN'
  | 'IN_USE'
  | 'NOT_FOUND'
  /** The data changed since the client read it, e.g. a stock count's compare quantity. */
  | 'STALE'
  /** Not enough stock to sell what was asked for. */
  | 'OUT_OF_STOCK';

export interface FieldError {
  /** Path to the input field at fault, e.g. ["input", "title"]. */
  field: string[];
  code: FieldErrorCode;
  message: string;
}

export type MutationResult<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

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

/**
 * Thrown inside a transaction to roll it back and return user errors, when a problem shows only
 * after the transaction has written something. Catch it with {@link rollbackResult}.
 */
export class UserErrorsRollback extends Error {
  constructor(readonly errors: FieldError[]) {
    super('Rolled back with user errors');
    this.name = 'UserErrorsRollback';
  }
}

/** Runs `fn`, turning a {@link UserErrorsRollback} it throws into a failed result. */
export async function rollbackResult<T>(
  fn: () => Promise<MutationResult<T>>,
): Promise<MutationResult<T>> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof UserErrorsRollback) return fail(error.errors);
    throw error;
  }
}

/** "productType" → "Product type", for messages like "Product type is too long". */
function humanize(name: string): string {
  const words = name.replace(/([A-Z])/g, ' $1').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Collects field errors while normalising input. Modules extend it with their own rules. */
export class InputChecker {
  readonly errors: FieldError[] = [];

  get ok(): boolean {
    return this.errors.length === 0;
  }

  /** Trimmed text; blank reads as null. */
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

  /** An amount of money of zero or more, as a decimal string in major units: "2,499.50". */
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

  /** Adds an error whose message starts with the field's name, e.g. "Title can't be blank". */
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
