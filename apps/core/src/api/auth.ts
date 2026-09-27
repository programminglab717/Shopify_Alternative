import type { AccessTokenAuthenticator, TenantContext } from '@hatti/api';
import { ErrorCode } from '@hatti/api';
import type { onRequestAsyncHookHandler } from 'fastify';
import { ACCESS_TOKEN_HEADER, ADMIN_API_PREFIX } from './constants.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the Admin API authentication hook. */
    tenant?: TenantContext;
  }
}

/**
 * Authenticates every Admin API request before any GraphQL work: an unknown, revoked or expired
 * token, or a suspended shop, gets 401 and never reaches a resolver.
 */
export function adminApiAuthentication(
  authenticator: AccessTokenAuthenticator,
): onRequestAsyncHookHandler {
  return async (request, reply) => {
    if (!request.url.startsWith(ADMIN_API_PREFIX)) return;
    const header = request.headers[ACCESS_TOKEN_HEADER];
    const tenant = await authenticator.authenticate(
      typeof header === 'string' ? header : undefined,
    );
    if (!tenant) {
      await reply.code(401).send({
        errors: [
          {
            message: `Invalid API key or access token. Send it in the ${ACCESS_TOKEN_HEADER} header.`,
            extensions: { code: ErrorCode.Unauthenticated },
          },
        ],
      });
      return;
    }
    request.tenant = tenant;
  };
}
