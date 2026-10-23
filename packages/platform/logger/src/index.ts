import { isSpanContextValid, trace } from '@opentelemetry/api';
import { destination, pino, stdSerializers, stdTimeFunctions, symbols } from 'pino';
import type { DestinationStream, Level, LevelWithSilent, Logger } from 'pino';
import type { ErrorTracker } from './error-tracking.js';

export type { Level, LevelWithSilent, Logger };
export {
  ErrorTracker,
  eventOf,
  framesOf,
  parseDsn,
  type ErrorTrackerDsn,
  type ErrorTrackerOptions,
} from './error-tracking.js';

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
  'landmark',
  // An address's pin (ADR-259) says where someone lives as plainly as the address does.
  'location',
  'latitude',
  'longitude',
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
  /** Where lines at error and fatal go too, redacted, once a DSN is set (ADR-743). */
  errorTracker?: ErrorTracker;
}

/** pino's error level: lines at it or above go to the error tracker. */
const ERROR_LEVEL = 50;

/**
 * `destination`, with each line at error or above also given to `tracker`: as written, so
 * redacted. pino tells a stream that asks for it each line's level.
 */
function trackedDestination(
  destination: DestinationStream,
  tracker: ErrorTracker,
): DestinationStream {
  const stream = {
    [symbols.needsMetadataGsym]: true,
    lastLevel: 0,
    write(line: string) {
      destination.write(line);
      if (stream.lastLevel < ERROR_LEVEL) return;
      try {
        tracker.capture(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // A line that is no JSON is in the logs still.
      }
    },
  };
  return stream;
}

/** trace_id and span_id of the active span, so logs and traces can be joined. */
function traceFields(): Record<string, string> {
  const context = trace.getActiveSpan()?.spanContext();
  return context && isSpanContextValid(context)
    ? { trace_id: context.traceId, span_id: context.spanId }
    : {};
}

/**
 * JSON logger with ISO timestamps, string levels, error serialisation, redaction and, inside a
 * traced operation, the trace and span ids.
 */
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
      mixin: traceFields,
    },
    options.errorTracker
      ? trackedDestination(options.destination ?? destination(1), options.errorTracker)
      : options.destination,
  );
}
