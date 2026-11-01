import { toPublicId } from '@hatti/ids';
import type { RateLimit, RateLimiter } from '@hatti/ratelimit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CliLogins } from '../cli-logins.js';

/** Where a terminal begins its login, and asks whether it is approved (ADR-990). */
export const CLI_LOGIN_PATH = '/cli/login';
export const CLI_LOGIN_TOKEN_PATH = '/cli/login/token';

/** Logins begun from one address: enough for a person, too few to fill the codes. */
const BEGUN: RateLimit = { name: 'cli-login:begin', limit: 10, windowMs: 10 * 60_000 };
/** Asks from one address, every five seconds for ten minutes, for a few terminals at once. */
const ASKED: RateLimit = { name: 'cli-login:poll', limit: 600, windowMs: 10 * 60_000 };

function fieldsOf(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

async function allowed(
  limiter: RateLimiter | null,
  limit: RateLimit,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  if (!limiter) return true;
  const result = await limiter.hit(limit, request.ip).catch(() => null);
  // Valkey unreachable: logins wait in it too, so none could begin anyway.
  if (!result) return false;
  if (!result.allowed) reply.header('retry-after', Math.ceil(result.retryAfterMs / 1000));
  return result.allowed;
}

/**
 * `hatti login`'s two routes, open as a sign-in page is, named as RFC 8628 names a device's:
 *
 * `POST /cli/login` with `{ device?, access?: "read" | "write" }`: `{ device_code, user_code,
 * verification_uri, verification_uri_complete, expires_in, interval }`. The terminal shows the code
 * and the link, and keeps the device code to itself.
 *
 * `POST /cli/login/token` with `{ device_code }`, every `interval` seconds: `{ access_token,
 * shop_id, scope }` once approved, the scopes comma separated, given once; else 400 with `error`
 * `authorization_pending`, `access_denied` or `expired_token`.
 */
export function receiveCliLogins(
  fastify: FastifyInstance,
  logins: CliLogins,
  limiter: RateLimiter | null,
): void {
  fastify.post(CLI_LOGIN_PATH, { bodyLimit: 4 * 1024 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!(await allowed(limiter, BEGUN, request, reply))) {
      return reply.code(429).send({ error: 'slow_down', error_description: 'Too many logins' });
    }
    const fields = fieldsOf(request.body);
    const begun = await logins.begin({
      device: fields.device,
      access: fields.access,
      requestedFrom: request.ip ?? null,
    });
    return reply.code(200).send({
      device_code: begun.deviceCode,
      user_code: begun.userCode,
      verification_uri: begun.verificationUrl,
      verification_uri_complete: begun.verificationUrlComplete,
      expires_in: begun.expiresIn,
      interval: begun.interval,
    });
  });

  fastify.post(CLI_LOGIN_TOKEN_PATH, { bodyLimit: 4 * 1024 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!(await allowed(limiter, ASKED, request, reply))) {
      return reply.code(429).send({ error: 'slow_down', error_description: 'Ask less often' });
    }
    const deviceCode = fieldsOf(request.body).device_code;
    if (typeof deviceCode !== 'string' || deviceCode.length === 0 || deviceCode.length > 200) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', error_description: 'Send the device_code' });
    }
    const answer = await logins.poll(deviceCode);
    switch (answer.status) {
      case 'approved':
        return reply.code(200).send({
          access_token: answer.accessToken,
          shop_id: toPublicId('shop', answer.shopId),
          scope: answer.scopes.join(','),
        });
      case 'pending':
        return reply.code(400).send({
          error: 'authorization_pending',
          error_description: 'Not approved yet',
        });
      case 'denied':
        return reply.code(400).send({
          error: 'access_denied',
          error_description: 'The login was refused in the admin',
        });
      default:
        return reply.code(400).send({
          error: 'expired_token',
          error_description: 'The login took too long, or its token was given already',
        });
    }
  });
}
