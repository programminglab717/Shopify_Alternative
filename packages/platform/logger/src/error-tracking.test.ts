import { describe, expect, it } from 'vitest';
import { ErrorTracker, createLogger, framesOf, parseDsn } from './index.js';

const DSN = 'https://abc123@errors.hatti.pk/7';

/** A tracker sending to a fake fetch, and what it sent: each envelope's event. */
function tracked(options: { perMinute?: number; fails?: boolean } = {}) {
  const sent: { url: string; headers: Record<string, string>; event: Record<string, unknown> }[] =
    [];
  let now = new Date('2026-10-23T10:00:00Z');
  const tracker = new ErrorTracker({
    dsn: DSN,
    environment: 'production',
    release: 'core@1.4.0',
    perMinute: options.perMinute,
    now: () => now,
    fetch: (async (url: string, init: RequestInit) => {
      if (options.fails) throw new Error('connection refused');
      const [, item, event] = String(init.body).trimEnd().split('\n');
      expect(JSON.parse(item!)).toEqual({ type: 'event' });
      sent.push({
        url,
        headers: init.headers as Record<string, string>,
        event: JSON.parse(event!) as Record<string, unknown>,
      });
      return new Response(null, { status: 200 });
    }) as typeof fetch,
  });
  const lines: string[] = [];
  const logger = createLogger({
    name: 'core-api',
    destination: { write: (line: string) => lines.push(line) },
    errorTracker: tracker,
  });
  return {
    tracker,
    logger,
    sent,
    lines,
    later: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

describe('Errors sent to the error tracker (ADR-743)', () => {
  it("reads a DSN's envelope endpoint and key, and refuses what is no DSN", () => {
    expect(parseDsn(DSN)).toEqual({
      endpoint: 'https://errors.hatti.pk/api/7/envelope/',
      publicKey: 'abc123',
    });
    expect(parseDsn('http://key@localhost:8000/glitchtip/3').endpoint).toBe(
      'http://localhost:8000/glitchtip/api/3/envelope/',
    );
    for (const wrong of [
      'https://errors.hatti.pk/7',
      'https://key@errors.hatti.pk/',
      'ftp://k@x/1',
    ]) {
      expect(() => parseDsn(wrong), wrong).toThrow('Expected a DSN');
    }
  });

  it('sends a line logged at error with its stack, context and trace, redacted; not one at warn', async () => {
    const { tracker, logger, sent, lines } = tracked();
    logger.warn({ shopId: 'shop_1' }, 'a retry');
    const error = new TypeError('Cannot read properties of undefined');
    logger.error(
      { err: error, shopId: 'shop_1', phone: '+923001234567', path: 'orderConfirm' },
      'resolver failed',
    );
    await tracker.flush();
    // Both are logged as before.
    expect(lines).toHaveLength(2);
    expect(sent).toHaveLength(1);
    const [{ url, headers, event }] = sent as [(typeof sent)[number]];
    expect(url).toBe('https://errors.hatti.pk/api/7/envelope/');
    expect(headers['x-sentry-auth']).toContain('sentry_key=abc123');
    expect(event).toMatchObject({
      level: 'error',
      logger: 'core-api',
      environment: 'production',
      release: 'core@1.4.0',
      message: { formatted: 'resolver failed' },
      tags: { service: 'core-api', shop_id: 'shop_1' },
      extra: { shopId: 'shop_1', path: 'orderConfirm', phone: '[redacted]' },
    });
    expect(event.event_id).toMatch(/^[0-9a-f]{32}$/);
    const exception = (event.exception as { values: Record<string, unknown>[] }).values[0]!;
    expect(exception).toMatchObject({ type: 'TypeError', value: error.message });
    const frames = (exception.stacktrace as { frames: { filename: string }[] }).frames;
    // The oldest frame first, the one that threw last.
    expect(frames.at(-1)!.filename).toContain('error-tracking.test.ts');
    // Personal data never leaves: the line is sent as it was written, redacted.
    expect(JSON.stringify(event)).not.toContain('+923001234567');
  });

  it('sends a fatal line as fatal, and one without an error as its message', async () => {
    const { tracker, logger, sent } = tracked();
    logger.fatal('cannot start: no database');
    await tracker.flush();
    expect(sent[0]!.event).toMatchObject({
      level: 'fatal',
      message: { formatted: 'cannot start: no database' },
    });
    expect(sent[0]!.event.exception).toBeUndefined();
  });

  it('drops events past its limit a minute, and goes on the minute after', async () => {
    const { tracker, logger, sent, later } = tracked({ perMinute: 2 });
    for (let i = 0; i < 5; i++) logger.error({ i }, 'failed');
    await tracker.flush();
    expect(sent).toHaveLength(2);
    later(60_000);
    logger.error('failed again');
    await tracker.flush();
    expect(sent).toHaveLength(3);
  });

  it('never fails the logging when the tracker cannot be reached', async () => {
    const { tracker, logger, lines } = tracked({ fails: true });
    expect(() => logger.error(new Error('boom'), 'failed')).not.toThrow();
    await tracker.flush();
    expect(lines).toHaveLength(1);
  });

  it("reads a V8 stack's frames, the oldest first, those of node_modules not the app's", () => {
    const frames = framesOf(
      [
        'Error: boom',
        '    at confirm (/app/apps/core/dist/orders.js:10:5)',
        '    at /app/node_modules/fastify/lib/route.js:20:7',
        '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
      ].join('\n'),
    );
    expect(frames).toEqual([
      {
        function: 'process.processTicksAndRejections',
        filename: 'node:internal/process/task_queues',
        lineno: 95,
        colno: 5,
        in_app: false,
      },
      {
        function: '?',
        filename: '/app/node_modules/fastify/lib/route.js',
        lineno: 20,
        colno: 7,
        in_app: false,
      },
      {
        function: 'confirm',
        filename: '/app/apps/core/dist/orders.js',
        lineno: 10,
        colno: 5,
        in_app: true,
      },
    ]);
  });
});
