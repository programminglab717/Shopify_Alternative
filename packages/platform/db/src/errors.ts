/** The fields of a Postgres error that callers act on. */
export interface PgErrorInfo {
  /** SQLSTATE, e.g. '23505' for a unique violation. */
  code: string;
  /** The constraint or index at fault, when there is one. */
  constraint?: string;
}

/**
 * The Postgres error behind `error`, which may be wrapped (Drizzle wraps driver errors in
 * `cause`), or undefined if it is not a database error.
 */
export function pgError(error: unknown): PgErrorInfo | undefined {
  let current = error as { code?: unknown; severity?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth++) {
    // Network errors have a code too ('ECONNRESET'); only server errors carry a severity.
    if (typeof current.code === 'string' && typeof current.severity === 'string') {
      const constraint = (current as { constraint?: unknown }).constraint;
      return typeof constraint === 'string'
        ? { code: current.code, constraint }
        : { code: current.code };
    }
    current = current.cause as typeof current;
  }
  return undefined;
}

/** A unique constraint or index rejected the write; pass `constraint` to check which. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const info = pgError(error);
  return info?.code === '23505' && (constraint === undefined || info.constraint === constraint);
}

/** A foreign key rejected the write: a referenced row is missing, or a referencing row exists. */
export function isForeignKeyViolation(error: unknown, constraint?: string): boolean {
  const info = pgError(error);
  return info?.code === '23503' && (constraint === undefined || info.constraint === constraint);
}
