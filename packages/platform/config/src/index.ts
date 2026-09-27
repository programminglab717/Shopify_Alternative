import { z } from 'zod';

export type Env = Readonly<Record<string, string | undefined>>;

/** Thrown at startup when the environment is invalid. Lists every problem, never the values. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/**
 * Validates environment variables against a zod schema and returns the typed, frozen result.
 * Empty strings count as unset, so `FOO=` in a .env file falls back to the default.
 */
export function parseEnv<S extends z.ZodType<Record<string, unknown>>>(
  schema: S,
  env: Env = process.env,
): Readonly<z.output<S>> {
  const present = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const result = schema.safeParse(present);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return Object.freeze(result.data);
}

/** Reusable schemas for common settings. */
export const env = {
  nodeEnv: () => z.enum(['development', 'test', 'production']).default('development'),
  port: () => z.coerce.number().int().min(1).max(65_535),
  logLevel: () =>
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  postgresUrl: () => z.url({ protocol: /^postgres(ql)?$/, error: 'Expected a postgres:// URL' }),
  redisUrl: () => z.url({ protocol: /^rediss?$/, error: 'Expected a redis:// or rediss:// URL' }),
  httpUrl: () => z.url({ protocol: /^https?$/, error: 'Expected an http(s):// URL' }),
  /** Accepts true/false, 1/0, yes/no, on/off. */
  flag: () => z.stringbool(),
  /** Comma-separated list, trimmed, empty items dropped. */
  list: () =>
    z.string().transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  /** A secret with a minimum length, so placeholders like "changeme" fail fast. */
  secret: (minLength = 32) => z.string().min(minLength, `Must be at least ${minLength} characters`),
} as const;

export { z };
