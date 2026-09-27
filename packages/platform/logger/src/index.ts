import { pino, stdSerializers, stdTimeFunctions } from 'pino';
import type { DestinationStream, Level, LevelWithSilent, Logger } from 'pino';

export type { Level, LevelWithSilent, Logger };

/**
 * Keys whose values never reach logs: credentials, and personal data covered by our privacy
 * commitments (phone, email, CNIC, addresses). Matched at the top level and one level deep;
 * log IDs (cus_…, ord_…) instead of personal data wherever possible.
 */
export const REDACTED_KEYS = [
  'password',
  'passwordHash',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'otp',
  'cnic',
  'phone',
  'email',
  'address',
  'address1',
  'address2',
] as const;

export const REDACT_PATHS: readonly string[] = [
  ...REDACTED_KEYS.flatMap((key) => [key, `*.${key}`]),
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-hatti-access-token"]',
  'res.headers["set-cookie"]',
];

export interface CreateLoggerOptions {
  /** Service or process name, e.g. "core-api" or "core-worker". */
  name: string;
  level?: LevelWithSilent;
  /** Extra fields on every line, e.g. { cell: "sg-1" }. */
  base?: Record<string, unknown>;
  /** Defaults to stdout. Tests pass an in-memory stream. */
  destination?: DestinationStream;
}

/** JSON logger with ISO timestamps, string levels, error serialisation and redaction. */
export function createLogger(options: CreateLoggerOptions): Logger {
  return pino(
    {
      name: options.name,
      level: options.level ?? 'info',
      base: { ...options.base },
      timestamp: stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      serializers: { err: stdSerializers.err, error: stdSerializers.err },
      redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
    },
    options.destination,
  );
}
