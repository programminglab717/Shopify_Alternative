import { randomUUID } from 'node:crypto';
import { ErrorTracker, createLogger } from '@hatti/logger';
import { RateLimiter } from '@hatti/ratelimit';
import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { ADMIN_ERRORS_PATH, adminErrorReportOf, receiveAdminErrors } from './admin-errors.js';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl && process.env.CI) throw new Error('REDIS_URL must be set in CI');

describe("The admin's browser errors, logged for the error tracker (ADR-745)", () => {
  it('cuts what a browser reports to its lengths, takes numbers and emails out, refuses none', () => {
    expect(
      adminErrorReportOf({
        type: 'TypeError',
        message: 'No customer for +92 300 1234567 or ayesha@example.pk',
        stack:
          'TypeError: No customer\n    at find (https://admin.hatti.pk/assets/index-a1b2.js:1:20)',
        page: '/shops/:id/customers',
        release: 'admin-web@2026.10.23',
      }),
    ).toEqual({
      type: 'TypeError',
      message: 'No customer for [number] or [email]',
      stack:
        'TypeError: No customer\n    at find (https://admin.hatti.pk/assets/index-a1b2.js:1:20)',
      page: '/shops/:id/customers',
      release: 'admin-web@2026.10.23',
    });
    expect(adminErrorReportOf({ message: 'x'.repeat(5_000) })).toMatchObject({
      type: 'Error',
      message: 'x'.repeat(1_000),
      page: '/',
    });
    for (const wrong of [null, 'boom', {}, { message: '  ' }, { message: 7 }]) {
      expect(adminErrorReportOf(wrong)).toBeNull();
    }
  });

  describe.skipIf(!redisUrl)('POST /admin/errors', () => {
    const redis = new Redis(redisUrl ?? '', { lazyConnect: true });
    afterAll(() => redis.quit());

    it("logs a report at error as the admin's, sends it, and limits each browser and all", async () => {
      const sent: Record<string, unknown>[] = [];
      const tracker = new ErrorTracker({
        dsn: 'https://abc123@errors.hatti.pk/7',
        environment: 'production',
        release: 'core@1.4.0',
        fetch: (async (_url: string, init: RequestInit) => {
          const [, , event] = String(init.body).trimEnd().split('\n');
          sent.push(JSON.parse(event!) as Record<string, unknown>);
          return new Response(null, { status: 200 });
        }) as typeof fetch,
      });
      const lines: Record<string, unknown>[] = [];
      const logger = createLogger({
        name: 'core-api',
        destination: { write: (line: string) => lines.push(JSON.parse(line)) },
        errorTracker: tracker,
      });
      const app = Fastify();
      // A limiter of this test's own, so that its counts start at nothing.
      receiveAdminErrors(app, logger, new RateLimiter(redis, `test:${randomUUID()}`));
      const report = (remoteAddress: string, body: unknown) =>
        app.inject({
          method: 'POST',
          url: ADMIN_ERRORS_PATH,
          remoteAddress,
          headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14)' },
          payload: body as Record<string, unknown>,
        });
      try {
        const answer = await report('203.0.113.7', {
          type: 'TypeError',
          message: "Cannot read properties of undefined (reading 'total')",
          stack:
            "TypeError: Cannot read properties of undefined (reading 'total')\n" +
            '    at OrderPage (https://admin.hatti.pk/assets/index-a1b2.js:1:4521)',
          page: '/shops/:id/orders/:id',
          release: 'admin-web@2026.10.23',
        });
        expect(answer.statusCode).toBe(204);
        await tracker.flush();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({
          level: 'error',
          service: 'admin-web',
          page: '/shops/:id/orders/:id',
          browser: 'Mozilla/5.0 (Linux; Android 14)',
        });
        expect(sent[0]).toMatchObject({
          logger: 'admin-web',
          platform: 'javascript',
          release: 'admin-web@2026.10.23',
          tags: { service: 'admin-web' },
          exception: { values: [{ type: 'TypeError' }] },
        });
        const frames = (
          sent[0]!.exception as { values: { stacktrace: { frames: { function: string }[] } }[] }
        ).values[0]!.stacktrace.frames;
        expect(frames.at(-1)!.function).toBe('OrderPage');

        // What is no report is refused, and logged as nothing.
        expect((await report('203.0.113.7', { page: '/' })).statusCode).toBe(400);
        // 20 a minute from one browser's address...
        for (let i = 1; i < 20; i++) await report('203.0.113.7', { message: `failed ${i}` });
        expect((await report('203.0.113.7', { message: 'one too many' })).statusCode).toBe(429);
        // ...and from all of them together.
        expect((await report('198.51.100.9', { message: 'another browser' })).statusCode).toBe(429);
        expect(lines).toHaveLength(20);
      } finally {
        await app.close();
      }
    });
  });
});
