import { ErrorCode, SUPPORT_READ_ONLY_MESSAGE, supportColumnsOf } from '@hatti/api';
import type { Database } from '@hatti/db';
import { recordAudit } from '@hatti/events';
import { toPublicId } from '@hatti/ids';
import type { preHandlerAsyncHookHandler } from 'fastify';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { operationOf, type GraphQLBody } from './idempotency.js';

/** The top-level fields a request's entry on the audit log names, at most. */
const LOGGED_FIELDS = 20;

/**
 * Hatti's support in a shop whose owner lets it look (ADR-156): each of its requests goes on the
 * shop's audit log before it runs, with the query's name and what it asked for; anything but one
 * query is refused, as support changes nothing. The resolvers' guard refuses its mutations too,
 * however they come.
 */
export function supportAccessHook(database: Database): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    const tenant = request.tenant;
    if (tenant?.actor.kind !== 'support') return;
    const actor = tenant.actor;
    const body = (request.method === 'GET' ? request.query : request.body) ?? {};
    const operation =
      request.routeOptions.url === ADMIN_GRAPHQL_PATH ? operationOf(body as GraphQLBody) : null;
    if (operation?.kind !== 'query') {
      return reply.code(403).send({
        errors: [
          { message: SUPPORT_READ_ONLY_MESSAGE, extensions: { code: ErrorCode.SupportReadOnly } },
        ],
      });
    }
    await database.tenant(tenant.shopId, (tx) =>
      recordAudit(tx, tenant.shopId, {
        action: 'support.looked',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...supportColumnsOf(actor),
        details: {
          grant: toPublicId('supportGrant', actor.grantId),
          operation: operation.name,
          fields: operation.fields.slice(0, LOGGED_FIELDS),
        },
      }),
    );
  };
}
