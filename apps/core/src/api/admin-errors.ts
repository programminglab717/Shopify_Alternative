import type { Logger } from '@hatti/logger';
import type { RateLimit, RateLimiter } from '@hatti/ratelimit';
import type { FastifyInstance } from 'fastify';

/** Where the admin's browser reports what failed in it (ADR-745), on the admin's own origin. */
export const ADMIN_ERRORS_PATH = '/admin/errors';

/** A browser's reports a minute: a page in trouble sends a few, never a flood. */
const PER_BROWSER: RateLimit = { name: 'admin-errors', limit: 20, windowMs: 60_000 };

/**
 * Every browser's reports a minute, together: the error tracker takes 60 events a minute in all,
 * and the core's own errors keep the most of them however many browsers report.
 */
const ALL_BROWSERS: RateLimit = { name: 'admin-errors:all', limit: 20, windowMs: 60_000 };

/** The longest each part of a report is kept: the rest is cut. */
const LIMITS = { type: 100, message: 1_000, stack: 8_000, page: 200, release: 64 } as const;

/**
 * Numbers and email addresses in what a browser reports: an error's words may hold what was
 * typed, and only the logs' keys are redacted, not their values.
 */
const PERSONAL = [
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]'],
  [/\+?\d(?:[\d -]{7,}\d)/g, '[number]'],
] as const;

/** What a browser reports, its parts cut to their lengths and its numbers and emails taken out. */
export interface AdminErrorReport {
  type: string;
  message: string;
  stack?: string;
  page: string;
  release?: string;
}

/** A report read from a body, or null for what is none. */
export function adminErrorReportOf(body: unknown): AdminErrorReport | null {
  if (typeof body !== 'object' || body === null) return null;
  const fields = body as Record<string, unknown>;
  const text = (name: keyof typeof LIMITS, scrub = false) => {
    const value = fields[name];
    if (typeof value !== 'string' || value.trim() === '') return undefined;
    let cut = value.slice(0, LIMITS[name]);
    if (scrub) for (const [pattern, mark] of PERSONAL) cut = cut.replace(pattern, mark);
    return cut;
  };
  const message = text('message', true);
  if (!message) return null;
  const stack = text('stack', true);
  const release = text('release');
  return {
    type: text('type') ?? 'Error',
    message,
    ...(stack ? { stack } : {}),
    page: text('page', true) ?? '/',
    ...(release ? { release } : {}),
  };
}

/**
 * `POST /admin/errors` (ADR-745): an error the admin's browser could not handle, logged at error
 * as the admin's, so that it reaches the error tracker with the core's own, after the same
 * redaction; no DSN is in the browser. It is open, as errors come before signing in too, so each
 * browser's address may report 20 a minute and all of them together 20; past that, reports are
 * refused, and what cannot be read is refused.
 */
export function receiveAdminErrors(
  fastify: FastifyInstance,
  logger: Logger,
  limiter: RateLimiter | null,
): void {
  fastify.post(ADMIN_ERRORS_PATH, { bodyLimit: 16 * 1024 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const report = adminErrorReportOf(request.body);
    if (!report)
      return reply.code(400).send({ error: 'Send an error: its type, message and page' });
    if (limiter) {
      const allowed = await Promise.all([
        limiter.hit(PER_BROWSER, request.ip),
        limiter.hit(ALL_BROWSERS, 'all'),
      ]).then(
        (results) => results.every((result) => result.allowed),
        // Valkey unreachable: a report is worth less than the core's own errors' room.
        () => false,
      );
      if (!allowed) return reply.code(429).send({ error: 'Too many reports' });
    }
    logger.error(
      {
        service: 'admin-web',
        platform: 'javascript',
        ...(report.release ? { release: report.release } : {}),
        err: browserError(report),
        page: report.page,
        browser: String(request.headers['user-agent'] ?? '').slice(0, 300),
      },
      report.message,
    );
    return reply.code(204).send();
  });
}

/** The browser's error as an error, named as the browser named it, with the browser's stack. */
function browserError(report: AdminErrorReport): Error {
  const error = new Error(report.message);
  error.name = report.type;
  error.stack = report.stack ?? `${report.type}: ${report.message}`;
  return error;
}
