import { ErrorCode, SUPPORT_READ_ONLY_MESSAGE, supportColumnsOf } from '@hatti/api';
import type { Database } from '@hatti/db';
import { recordAudit } from '@hatti/events';
import { toPublicId } from '@hatti/ids';
import type { MessagesService } from '@hatti/messaging/public';
import { sql } from 'drizzle-orm';
import type { preHandlerAsyncHookHandler } from 'fastify';
import { tellShop } from '../worker/shop-notices.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { operationOf, type GraphQLBody } from './idempotency.js';

/** The top-level fields a request's entry on the audit log names, at most. */
const LOGGED_FIELDS = 20;

/**
 * Hatti's support in a shop whose owner lets it look (ADR-156): each of its requests goes on the
 * shop's audit log before it runs, with the query's name and what it asked for; anything but one
 * query is refused, as support changes nothing. The resolvers' guard refuses its mutations too,
 * however they come. Its first look under a grant tells the shop, at its alerts number and its
 * owner's email, that support is looking now (ADR-882).
 */
export function supportAccessHook(
  database: Database,
  messages: Pick<MessagesService, 'queueIn'>,
): preHandlerAsyncHookHandler {
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
    const grant = toPublicId('supportGrant', actor.grantId);
    await database.tenant(tenant.shopId, async (tx) => {
      const { rows: looked } = await tx.execute(sql`
        SELECT 1 FROM platform.audit_log
         WHERE shop_id = ${tenant.shopId} AND action = 'support.looked'
           AND details ->> 'grant' = ${grant}
         LIMIT 1`);
      await recordAudit(tx, tenant.shopId, {
        action: 'support.looked',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...supportColumnsOf(actor),
        details: {
          grant,
          operation: operation.name,
          fields: operation.fields.slice(0, LOGGED_FIELDS),
        },
      });
      if (looked.length === 0) {
        const { rows } = await tx.execute<{ name: string }>(
          sql`SELECT name FROM control.shops WHERE id = ${tenant.shopId}`,
        );
        await tellShop(tx, messages, tenant.shopId, {
          kind: 'support_looking',
          dedupeKey: `support_looking:${actor.grantId}`,
          variables: { shop: rows[0]?.name ?? '' },
        });
      }
    });
  };
}
