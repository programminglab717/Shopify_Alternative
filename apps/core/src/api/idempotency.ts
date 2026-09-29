import { createHash } from 'node:crypto';
import { ErrorCode, mutationsRequiringIdempotencyKey, type TenantContext } from '@hatti/api';
import type { Database } from '@hatti/db';
import { sql } from 'drizzle-orm';
import type {
  FastifyReply,
  FastifyRequest,
  onSendAsyncHookHandler,
  preHandlerAsyncHookHandler,
} from 'fastify';
import {
  Kind,
  parse,
  type DefinitionNode,
  type DocumentNode,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from 'graphql';
import { ADMIN_GRAPHQL_PATH, IDEMPOTENCY_KEY_HEADER } from './constants.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set when this request claimed an Idempotency-Key, so that its answer is kept. */
    idempotencyKey?: KeyOwner;
  }
}

/** A key, and whose it is. */
interface KeyOwner {
  shopId: string;
  actorId: string;
  key: string;
}

/** What claiming a key found. */
export type Claim =
  | { kind: 'claimed' }
  | { kind: 'replay'; statusCode: number; response: string }
  | { kind: 'reused' }
  | { kind: 'in_use' };

/** 1 to 255 visible ASCII characters, such as a UUID. */
const KEY_PATTERN = /^[!-~]{1,255}$/;

/**
 * Keys and the first answer to each, in `platform.idempotency_keys`: kept for 24 hours, and held
 * for a minute while the first request runs, so that a request that died does not hold its key
 * for good.
 */
export class IdempotencyStore {
  constructor(private readonly database: Database) {}

  /**
   * Claims `key` for a request with this fingerprint. Otherwise: the answer to the first request
   * with the key, `reused` if that request was a different one, or `in_use` while it runs.
   * Sweeps the shop's expired keys on the way.
   */
  async claim(owner: KeyOwner, fingerprint: Buffer): Promise<Claim> {
    const { shopId, actorId, key } = owner;
    return this.database.tenant(shopId, async (tx): Promise<Claim> => {
      await tx.execute(sql`
        DELETE FROM platform.idempotency_keys
         WHERE shop_id = ${shopId} AND expires_at < now()
           AND NOT (actor_id = ${actorId} AND key = ${key})`);
      // A key whose answer expired starts afresh; one whose request died is taken over.
      const claimed = await tx.execute(sql`
        INSERT INTO platform.idempotency_keys AS k
               (shop_id, actor_id, key, fingerprint, locked_until, expires_at)
        VALUES (${shopId}, ${actorId}, ${key}, ${fingerprint},
                now() + interval '1 minute', now() + interval '24 hours')
        ON CONFLICT (shop_id, actor_id, key) DO UPDATE
           SET fingerprint = EXCLUDED.fingerprint, status_code = NULL, response = NULL,
               locked_until = EXCLUDED.locked_until, created_at = now(),
               expires_at = EXCLUDED.expires_at
         WHERE k.expires_at < now()
            OR (k.status_code IS NULL AND k.locked_until < now()
                AND k.fingerprint = EXCLUDED.fingerprint)
        RETURNING 1`);
      if (claimed.rows.length > 0) return { kind: 'claimed' };
      const { rows } = await tx.execute<{
        fingerprint: Buffer;
        status_code: number | null;
        response: string | null;
      }>(sql`
        SELECT fingerprint, status_code, response
          FROM platform.idempotency_keys
         WHERE shop_id = ${shopId} AND actor_id = ${actorId} AND key = ${key}`);
      const [first] = rows;
      if (!first || !first.fingerprint.equals(fingerprint)) return { kind: 'reused' };
      if (first.status_code === null || first.response === null) return { kind: 'in_use' };
      return { kind: 'replay', statusCode: first.status_code, response: first.response };
    });
  }

  /** Keeps the answer to the request that claimed the key. */
  async complete(owner: KeyOwner, statusCode: number, response: string): Promise<void> {
    await this.database.tenant(owner.shopId, (tx) =>
      tx.execute(sql`
        UPDATE platform.idempotency_keys
           SET status_code = ${statusCode}, response = ${response}
         WHERE shop_id = ${owner.shopId} AND actor_id = ${owner.actorId}
           AND key = ${owner.key}`),
    );
  }
}

interface GraphQLBody {
  query?: unknown;
  operationName?: unknown;
  variables?: unknown;
}

/**
 * The top-level fields of the request's mutation, such as `orderCreate`, or null when it is not a
 * mutation. A request that does not parse is left to the GraphQL server to refuse.
 */
export function mutationFields(body: GraphQLBody): string[] | null {
  if (typeof body.query !== 'string') return null;
  let document: DocumentNode;
  try {
    document = parse(body.query);
  } catch {
    return null;
  }
  const operations = document.definitions.filter(
    (definition: DefinitionNode): definition is OperationDefinitionNode =>
      definition.kind === Kind.OPERATION_DEFINITION,
  );
  const operation =
    typeof body.operationName === 'string'
      ? operations.find((candidate) => candidate.name?.value === body.operationName)
      : operations.length === 1
        ? operations[0]
        : undefined;
  if (operation?.operation !== 'mutation') return null;

  const fragments = new Map(
    document.definitions
      .filter(
        (definition: DefinitionNode): definition is FragmentDefinitionNode =>
          definition.kind === Kind.FRAGMENT_DEFINITION,
      )
      .map((fragment) => [fragment.name.value, fragment.selectionSet]),
  );
  const fields = new Set<string>();
  const visit = (selectionSet: SelectionSetNode, spread: ReadonlySet<string>) => {
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FIELD) {
        fields.add(selection.name.value);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        visit(selection.selectionSet, spread);
      } else {
        const name = selection.name.value;
        const fragment = fragments.get(name);
        if (fragment && !spread.has(name)) visit(fragment, new Set([...spread, name]));
      }
    }
  };
  visit(operation.selectionSet, new Set());
  return [...fields];
}

/** JSON with object keys sorted, so that the same request always gives the same text. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([name, entry]) => `${JSON.stringify(name)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** SHA-256 of what the request asks: its query, operation name and variables. */
export function fingerprintOf(body: GraphQLBody): Buffer {
  const request = canonicalJson({
    query: body.query,
    operationName: body.operationName ?? null,
    variables: body.variables ?? null,
  });
  return createHash('sha256').update(request).digest();
}

function actorIdOf(tenant: TenantContext): string {
  return tenant.actor.kind === 'app' ? tenant.actor.tokenId : tenant.actor.userId;
}

async function refuse(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): Promise<FastifyReply> {
  return reply.code(status).send({ errors: [{ message, extensions: { code } }] });
}

/**
 * Hooks that honour the `Idempotency-Key` header on Admin API mutations. With a key, the first
 * answer is kept, and a retry with the same key and request gets it back, marked
 * `Idempotent-Replayed: true`, without running again. Mutations that are not safe to repeat
 * (see `RequireIdempotencyKey`) are refused without one. Queries ignore the header.
 */
export function idempotencyHooks(store: IdempotencyStore): {
  preHandler: preHandlerAsyncHookHandler;
  onSend: onSendAsyncHookHandler;
} {
  return {
    async preHandler(request: FastifyRequest, reply: FastifyReply) {
      const tenant = request.tenant;
      if (request.method !== 'POST' || request.routeOptions.url !== ADMIN_GRAPHQL_PATH) return;
      if (!tenant) return;
      const body = (request.body ?? {}) as GraphQLBody;
      const fields = mutationFields(body);
      if (!fields) return;

      const header = request.headers[IDEMPOTENCY_KEY_HEADER];
      const key = typeof header === 'string' ? header : undefined;
      if (key === undefined) {
        const required = mutationsRequiringIdempotencyKey();
        const unsafe = fields.filter((field) => required.has(field));
        if (unsafe.length === 0) return;
        return refuse(
          reply,
          400,
          ErrorCode.IdempotencyKeyRequired,
          `${unsafe.join(' and ')} must not run twice, so send an Idempotency-Key header: a new ` +
            'value, such as a UUID, for each request, and the same one again when you retry it',
        );
      }
      if (!KEY_PATTERN.test(key)) {
        return refuse(
          reply,
          400,
          ErrorCode.IdempotencyKeyInvalid,
          'The Idempotency-Key header must be 1 to 255 visible ASCII characters, such as a UUID',
        );
      }

      const owner = { shopId: tenant.shopId, actorId: actorIdOf(tenant), key };
      const claim = await store.claim(owner, fingerprintOf(body));
      switch (claim.kind) {
        case 'claimed':
          request.idempotencyKey = owner;
          return;
        case 'replay':
          return reply
            .code(claim.statusCode)
            .header('content-type', 'application/json; charset=utf-8')
            .header('idempotent-replayed', 'true')
            .send(claim.response);
        case 'reused':
          return refuse(
            reply,
            422,
            ErrorCode.IdempotencyKeyReused,
            'This Idempotency-Key came before with a different request. Send a new key with a ' +
              'new request',
          );
        case 'in_use':
          return refuse(
            reply,
            409,
            ErrorCode.IdempotencyKeyInUse,
            'The first request with this Idempotency-Key is still running. Retry in a moment',
          );
      }
    },

    async onSend(request, reply, payload) {
      const owner = request.idempotencyKey;
      if (owner && typeof payload === 'string') {
        try {
          await store.complete(owner, reply.statusCode, payload);
        } catch (error) {
          // The work is done; the client still gets its answer. A retry within the minute the
          // key is held is told to wait, and one after it runs again.
          request.log.error({ err: error }, 'could not keep the answer to an Idempotency-Key');
        }
      }
      return payload;
    },
  };
}
