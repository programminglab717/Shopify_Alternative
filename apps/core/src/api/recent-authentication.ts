import {
  ErrorCode,
  REAUTHENTICATION_MESSAGE,
  mutationsRequiringRecentAuthentication,
  recentlyAuthenticated,
} from '@hatti/api';
import type { preHandlerAsyncHookHandler } from 'fastify';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { mutationFields, type GraphQLBody } from './idempotency.js';

/**
 * Turns away a request with a sensitive mutation from staff who have not proved who they are
 * lately (ADR-103), before its Idempotency-Key is claimed: once they re-authenticate, the same
 * request goes through with the same key. The resolvers' guard refuses such mutations too,
 * however they come.
 */
export function recentAuthenticationHook(): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    const tenant = request.tenant;
    if (!tenant || request.method !== 'POST' || request.routeOptions.url !== ADMIN_GRAPHQL_PATH) {
      return;
    }
    const fields = mutationFields((request.body ?? {}) as GraphQLBody);
    const sensitive = mutationsRequiringRecentAuthentication();
    if (!fields?.some((field) => sensitive.has(field))) return;
    if (recentlyAuthenticated(tenant, new Date())) return;
    return reply.code(403).send({
      errors: [
        {
          message: REAUTHENTICATION_MESSAGE,
          extensions: { code: ErrorCode.ReauthenticationRequired },
        },
      ],
    });
  };
}
