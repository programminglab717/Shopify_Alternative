import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

// Errors sent to an error tracker (ADR-743): every line logged at error or fatal, after its
// redaction, as an event in the protocol Sentry's SDKs speak, which GlitchTip, the open-source
// tracker Hatti hosts itself, takes. Without a DSN nothing is sent. Sending never throws, never
// holds up the line's logging, and drops events past a few a second rather than queue them.

/** Where events go, read from a DSN: "https://<key>@errors.hatti.pk/<project>". */
export interface ErrorTrackerDsn {
  /** The project's envelope endpoint. */
  endpoint: string;
  publicKey: string;
}

/** A DSN's endpoint and key; throws for one that is no DSN. */
export function parseDsn(dsn: string): ErrorTrackerDsn {
  const url = new URL(dsn);
  const project = url.pathname.split('/').filter(Boolean);
  const id = project.pop();
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.username || !id) {
    throw new Error('Expected a DSN, such as https://<key>@errors.hatti.pk/<project>');
  }
  const prefix = project.length > 0 ? `/${project.join('/')}` : '';
  return {
    endpoint: `${url.protocol}//${url.host}${prefix}/api/${id}/envelope/`,
    publicKey: decodeURIComponent(url.username),
  };
}

export interface ErrorTrackerOptions {
  dsn: string;
  /** "production", "staging": which the tracker files each event under. */
  environment: string;
  /** The release running, such as the image's version. */
  release?: string;
  /** Events sent at most each minute; past it, until the minute is out, they are dropped. */
  perMinute?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** A line as the logger writes it: redacted JSON. */
type LogLine = Record<string, unknown>;

/** The fields of a line that are no context of its error: they are the event's own. */
const OWN_FIELDS = new Set([
  'service',
  'release',
  'platform',
  'level',
  'time',
  'msg',
  'name',
  'pid',
  'hostname',
  'err',
  'error',
  'trace_id',
  'span_id',
]);

/** The longest an event's extra value may be, so that a large one is cut, not refused. */
const EXTRA_LIMIT = 2_000;

/** Sends logged errors to the tracker, as events. */
export class ErrorTracker {
  readonly #dsn: ErrorTrackerDsn;
  readonly #options: ErrorTrackerOptions;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #inFlight = new Set<Promise<void>>();
  #minute = 0;
  #sentThisMinute = 0;

  constructor(options: ErrorTrackerOptions) {
    this.#dsn = parseDsn(options.dsn);
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  /** Sends the event of a logged line, if this minute has room for it. */
  capture(line: LogLine): void {
    const now = this.#now();
    const minute = Math.floor(now.getTime() / 60_000);
    if (minute !== this.#minute) {
      this.#minute = minute;
      this.#sentThisMinute = 0;
    }
    if (this.#sentThisMinute >= (this.#options.perMinute ?? 60)) return;
    this.#sentThisMinute += 1;
    const event = eventOf(line, this.#options, now);
    const sent = this.#send(event).finally(() => this.#inFlight.delete(sent));
    this.#inFlight.add(sent);
  }

  /** Waits, at most `timeoutMs`, for the events being sent: before the process exits. */
  async flush(timeoutMs = 2_000): Promise<void> {
    if (this.#inFlight.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this.#inFlight]),
      new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
  }

  async #send(event: Record<string, unknown>): Promise<void> {
    const header = { event_id: event.event_id, sent_at: this.#now().toISOString() };
    const body = [JSON.stringify(header), JSON.stringify({ type: 'event' }), JSON.stringify(event)];
    try {
      await this.#fetch(this.#dsn.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-sentry-envelope',
          'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${this.#dsn.publicKey}, sentry_client=hatti-logger/1.0`,
        },
        body: `${body.join('\n')}\n`,
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // The tracker unreachable: the line is in the logs still, which is where errors are kept.
    }
  }
}

/** The event of a logged line: its error with its stack, its message, and its context. */
export function eventOf(
  line: LogLine,
  options: Pick<ErrorTrackerOptions, 'environment' | 'release'>,
  now: Date,
): Record<string, unknown> {
  const error = (line.err ?? line.error) as
    { type?: string; name?: unknown; message?: string; stack?: string } | undefined;
  const message = typeof line.msg === 'string' ? line.msg : undefined;
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(line)) {
    if (OWN_FIELDS.has(key)) continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    extra[key] = text && text.length > EXTRA_LIMIT ? `${text.slice(0, EXTRA_LIMIT)}…` : value;
  }
  const traceId = typeof line.trace_id === 'string' ? line.trace_id : undefined;
  const spanId = typeof line.span_id === 'string' ? line.span_id : undefined;
  // A line may speak for another service than the logger's, such as the admin's browser errors
  // the core logs for it (ADR-745), with that service's release and platform.
  const text = (key: string) => (typeof line[key] === 'string' ? line[key] : undefined);
  const service = text('service') ?? text('name');
  const release = text('release') ?? options.release;
  return {
    event_id: randomUUID().replaceAll('-', ''),
    timestamp: now.getTime() / 1000,
    platform: text('platform') ?? 'node',
    level: line.level === 'fatal' ? 'fatal' : 'error',
    logger: service,
    server_name: hostname(),
    environment: options.environment,
    ...(release ? { release } : {}),
    ...(message ? { message: { formatted: message } } : {}),
    ...(error
      ? {
          exception: {
            values: [
              {
                // An error's own name, as a class that names itself or a browser's error has,
                // says more than the constructor pino read its type from.
                type: (typeof error.name === 'string' && error.name) || error.type || 'Error',
                value: error.message ?? message ?? '',
                ...(error.stack ? { stacktrace: { frames: framesOf(error.stack) } } : {}),
              },
            ],
          },
        }
      : {}),
    tags: {
      ...(service ? { service } : {}),
      ...(typeof line.shopId === 'string' ? { shop_id: line.shopId } : {}),
    },
    extra,
    ...(traceId && spanId ? { contexts: { trace: { trace_id: traceId, span_id: spanId } } } : {}),
  };
}

/**
 * A stack's frames, the oldest first as the tracker reads them: V8's (Node, Chrome, Edge),
 * "    at fn (file:1:2)", or Firefox's and Safari's, "fn@file:1:2".
 */
export function framesOf(stack: string): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = [];
  for (const line of stack.split('\n')) {
    const match =
      /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line) ??
      /^\s*([^@\s]*)@(.+?):(\d+):(\d+)$/.exec(line);
    if (!match) continue;
    const [, fn, file, lineNo, column] = match;
    frames.push({
      function: fn || '?',
      filename: file,
      lineno: Number(lineNo),
      colno: Number(column),
      in_app: !file!.includes('node_modules') && !file!.startsWith('node:'),
    });
  }
  return frames.reverse();
}
