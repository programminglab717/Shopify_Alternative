import {
  CurrentTenant,
  RequestLoaders,
  RequireScopes,
  UserError,
  actorColumnsOf,
  type TenantContext,
} from '@hatti/api';
import { Database, toDate, toDateOrNull } from '@hatti/db';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { ObjectStorage } from '@hatti/storage';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Logger } from '@hatti/logger';
import { LOGGER } from './constants.js';
import { HttpAdapterHost } from '@nestjs/core';
import {
  Args,
  Field,
  GraphQLISODateTime,
  GraphQLSchemaHost,
  ID,
  Int,
  Mutation,
  ObjectType,
  Query,
  Resolver,
  registerEnumType,
} from '@nestjs/graphql';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  Kind,
  parse,
  print,
  validate,
  type DocumentNode,
  type FieldNode,
  type OperationDefinitionNode,
  type SelectionNode,
} from 'graphql';

// Bulk operations (DEV-10, ADR-843), as Shopify's bulkOperationRunQuery: a caller asks for all
// of one of the shop's lists at once; the API runs the query a page at a time in the background,
// as the caller, with their scopes, and writes each node to a JSONL file in storage, which a link
// gives for a week. Its pages aren't metered (ADR-576): one bulk operation runs at a time for a
// caller instead.

export const BULK_LIMITS = {
  /** Nodes asked for a page. */
  pageSize: 250,
  /** The most a file holds, in nodes and in bytes. */
  objects: 1_000_000,
  bytes: 500 * 1024 * 1024,
  /** How long the file's link works, in seconds: a week, as Shopify's. */
  urlSeconds: 7 * 24 * 3600,
  /** A run not finished in this long is taken to have died with the process that ran it. */
  staleMinutes: 120,
  query: 20_000,
} as const;

/** Arguments a bulk query's list may not take: the run pages it itself. */
const PAGING_ARGUMENTS = new Set(['first', 'last', 'after', 'before']);

/** The query as each page runs it, and the key its list answers under; or what is wrong. */
export function pagedQuery(
  query: string,
): { ok: true; document: string; key: string } | { ok: false; message: string } {
  let document: DocumentNode;
  try {
    document = parse(query);
  } catch (error) {
    return { ok: false, message: `The query doesn't parse: ${(error as Error).message}` };
  }
  const operations = document.definitions.filter(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === Kind.OPERATION_DEFINITION,
  );
  if (operations.length !== 1 || document.definitions.length !== 1) {
    return { ok: false, message: 'Give one query, without fragments' };
  }
  const operation = operations[0]!;
  if (operation.operation !== 'query')
    return { ok: false, message: 'Give a query, not a mutation' };
  if ((operation.variableDefinitions?.length ?? 0) > 0) {
    return { ok: false, message: 'Write its values into the query: it takes no variables' };
  }
  const fields = operation.selectionSet.selections.filter(
    (selection): selection is FieldNode =>
      selection.kind === Kind.FIELD && selection.name.value !== '__typename',
  );
  if (fields.length !== 1 || fields.length !== operation.selectionSet.selections.length) {
    return { ok: false, message: 'Ask for one list, such as products or orders, at its top' };
  }
  const list = fields[0]!;
  if (list.arguments?.some((argument) => PAGING_ARGUMENTS.has(argument.name.value))) {
    return {
      ok: false,
      message: 'Leave out first, last, after and before: it pages the list itself',
    };
  }
  const named = (selection: SelectionNode, name: string) =>
    selection.kind === Kind.FIELD && selection.name.value === name;
  const selections = list.selectionSet?.selections ?? [];
  const nodes = selections.some((selection) => named(selection, 'nodes'));
  const edges = selections.find((selection) => named(selection, 'edges')) as FieldNode | undefined;
  if (!nodes && !edges?.selectionSet?.selections.some((selection) => named(selection, 'node'))) {
    return { ok: false, message: 'Ask for the list’s nodes, or its edges’ node' };
  }
  const variable = { kind: Kind.VARIABLE, name: { kind: Kind.NAME, value: 'bulkAfter' } } as const;
  const paged: OperationDefinitionNode = {
    ...operation,
    variableDefinitions: [
      {
        kind: Kind.VARIABLE_DEFINITION,
        variable,
        type: { kind: Kind.NAMED_TYPE, name: { kind: Kind.NAME, value: 'String' } },
      },
    ],
    selectionSet: {
      ...operation.selectionSet,
      selections: [
        {
          ...list,
          arguments: [
            ...(list.arguments ?? []),
            {
              kind: Kind.ARGUMENT,
              name: { kind: Kind.NAME, value: 'first' },
              value: { kind: Kind.INT, value: String(BULK_LIMITS.pageSize) },
            },
            { kind: Kind.ARGUMENT, name: { kind: Kind.NAME, value: 'after' }, value: variable },
          ],
          selectionSet: {
            kind: Kind.SELECTION_SET,
            selections: [
              ...selections,
              {
                kind: Kind.FIELD,
                alias: { kind: Kind.NAME, value: 'bulkPageInfo' },
                name: { kind: Kind.NAME, value: 'pageInfo' },
                selectionSet: {
                  kind: Kind.SELECTION_SET,
                  selections: ['hasNextPage', 'endCursor'].map((name) => ({
                    kind: Kind.FIELD,
                    name: { kind: Kind.NAME, value: name },
                  })),
                },
              },
            ],
          },
        },
      ],
    },
  };
  return {
    ok: true,
    document: print({ ...document, definitions: [paged] }),
    key: list.alias?.value ?? list.name.value,
  };
}

/** A page's nodes, from its `nodes` or its edges' `node`. */
function nodesOf(connection: Record<string, unknown>): unknown[] {
  if (Array.isArray(connection.nodes)) return connection.nodes;
  const edges = connection.edges as { node: unknown }[] | undefined;
  return (edges ?? []).map((edge) => edge.node);
}

export type BulkStatus = 'running' | 'completed' | 'failed' | 'canceled';

export interface BulkOperationRecord {
  id: string;
  query: string;
  status: BulkStatus;
  objectCount: number;
  fileKey: string | null;
  fileSize: number | null;
  errorCode: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

type BulkRow = {
  id: string;
  query: string;
  status: BulkStatus;
  object_count: number;
  file_key: string | null;
  file_size: number | null;
  error_code: string | null;
  created_at: string;
  completed_at: string | null;
};

const toRecord = (row: BulkRow): BulkOperationRecord => ({
  id: row.id,
  query: row.query,
  status: row.status,
  objectCount: row.object_count,
  fileKey: row.file_key,
  fileSize: row.file_size,
  errorCode: row.error_code,
  createdAt: toDate(row.created_at),
  completedAt: toDateOrNull(row.completed_at),
});

const COLUMNS = sql.raw(
  'id, query, status, object_count, file_key, file_size, error_code, created_at, completed_at',
);

/** Who asks, as a bulk operation keeps it: an app's token or a member of staff. */
const callerOf = (tenant: TenantContext) => {
  const { actorKind, actorId } = actorColumnsOf(tenant.actor);
  return `${actorKind}:${actorId}`;
};

@Injectable()
export class BulkOperationsService {
  constructor(
    private readonly db: Database,
    private readonly storage: ObjectStorage,
    private readonly adapter: HttpAdapterHost,
    private readonly schema: GraphQLSchemaHost,
    @Optional() @Inject(LOGGER) private readonly logger?: Logger,
  ) {}

  /**
   * Starts running `query` for the caller, as {@link pagedQuery} pages it, in the background:
   * the operation, running; or what is wrong. One runs at a time for a caller.
   */
  async run(
    tenant: TenantContext,
    query: string,
  ): Promise<{ ok: true; value: BulkOperationRecord } | { ok: false; message: string }> {
    if (query.length > BULK_LIMITS.query) return { ok: false, message: 'The query is too long' };
    const paged = pagedQuery(query);
    if (!paged.ok) return paged;
    // Fields and arguments the API has, before it runs in the background.
    const invalid = validate(this.schema.schema, parse(paged.document))[0];
    if (invalid) return { ok: false, message: invalid.message };
    const caller = callerOf(tenant);
    await this.#endStale(tenant.shopId);
    const started = await this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<BulkRow>(sql`
        INSERT INTO apps.bulk_operations (shop_id, caller, query)
             VALUES (${tenant.shopId}, ${caller}, ${query})
        ON CONFLICT (shop_id, caller) WHERE status = 'running' DO NOTHING
        RETURNING ${COLUMNS}`);
      return rows[0] ? toRecord(rows[0]) : null;
    });
    if (!started) {
      return {
        ok: false,
        message: 'A bulk operation of yours is running: wait for it, or cancel it',
      };
    }
    // In the background, past the answer: its outcome is kept on it.
    setImmediate(() => void this.#runPages(tenant, started.id, paged.document, paged.key));
    return { ok: true, value: started };
  }

  /** The caller's latest bulk operation, if any. */
  async current(tenant: TenantContext): Promise<BulkOperationRecord | null> {
    await this.#endStale(tenant.shopId);
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<BulkRow>(sql`
        SELECT ${COLUMNS} FROM apps.bulk_operations
         WHERE shop_id = ${tenant.shopId} AND caller = ${callerOf(tenant)}
         ORDER BY created_at DESC, id DESC
         LIMIT 1`);
      return rows[0] ? toRecord(rows[0]) : null;
    });
  }

  /** Stops the caller's running operation `id` before its next page. Whether it ran. */
  async cancel(tenant: TenantContext, id: string): Promise<BulkOperationRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<BulkRow>(sql`
        UPDATE apps.bulk_operations SET status = 'canceled', completed_at = now()
         WHERE shop_id = ${tenant.shopId} AND id = ${id} AND caller = ${callerOf(tenant)}
           AND status = 'running'
        RETURNING ${COLUMNS}`);
      return rows[0] ? toRecord(rows[0]) : null;
    });
  }

  /** The file's link, for a week. */
  urlOf(record: BulkOperationRecord): string | null {
    return record.fileKey
      ? this.storage.signDownload(record.fileKey, BULK_LIMITS.urlSeconds, {
          filename: `bulk-${record.createdAt.toISOString().slice(0, 10)}.jsonl`,
          attachment: true,
        })
      : null;
  }

  /** Runs that died with the process that ran them, failed. */
  async #endStale(shopId: string): Promise<void> {
    await this.db.tenant(shopId, (tx) =>
      tx.execute(sql`
        UPDATE apps.bulk_operations SET status = 'failed', error_code = 'TIMEOUT', completed_at = now()
         WHERE shop_id = ${shopId} AND status = 'running'
           AND created_at < now() - make_interval(mins => ${BULK_LIMITS.staleMinutes})`),
    );
  }

  async #runPages(tenant: TenantContext, id: string, document: string, key: string) {
    const app = this.adapter.httpAdapter.getInstance<FastifyInstance>() as FastifyInstance & {
      graphql: (
        source: string,
        context: Record<string, unknown>,
        variables: Record<string, unknown>,
      ) => Promise<{ data?: Record<string, unknown> | null; errors?: readonly unknown[] }>;
    };
    const chunks: Buffer[] = [];
    let bytes = 0;
    let count = 0;
    let after: string | null = null;
    const finish = (fields: { status: BulkStatus; errorCode?: string; fileKey?: string }) =>
      this.db.tenant(tenant.shopId, (tx) =>
        tx.execute(sql`
          UPDATE apps.bulk_operations
             SET status = ${fields.status}, error_code = ${fields.errorCode ?? null},
                 file_key = ${fields.fileKey ?? null},
                 file_size = ${fields.fileKey ? bytes : null},
                 object_count = ${count}, completed_at = now()
           WHERE shop_id = ${tenant.shopId} AND id = ${id} AND status = 'running'`),
      );
    try {
      for (;;) {
        const running = await this.db.tenant(tenant.shopId, async (tx) => {
          const { rows } = await tx.execute<{ status: BulkStatus }>(sql`
            SELECT status FROM apps.bulk_operations WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
          return rows[0]?.status === 'running';
        });
        if (!running) return;
        const result = await app.graphql(
          document,
          { tenant, loaders: new RequestLoaders(), bulk: true },
          { bulkAfter: after },
        );
        const problem = result.errors?.[0] as { extensions?: { code?: string } } | undefined;
        if (problem) {
          await finish({ status: 'failed', errorCode: problem.extensions?.code ?? 'QUERY_FAILED' });
          return;
        }
        const connection = (result.data?.[key] ?? {}) as Record<string, unknown>;
        for (const node of nodesOf(connection)) {
          const line = Buffer.from(`${JSON.stringify(node)}\n`);
          chunks.push(line);
          bytes += line.length;
          count += 1;
        }
        if (count > BULK_LIMITS.objects || bytes > BULK_LIMITS.bytes) {
          await finish({ status: 'failed', errorCode: 'TOO_LARGE' });
          return;
        }
        await this.db.tenant(tenant.shopId, (tx) =>
          tx.execute(sql`
            UPDATE apps.bulk_operations SET object_count = ${count}
             WHERE shop_id = ${tenant.shopId} AND id = ${id} AND status = 'running'`),
        );
        const page = connection.bulkPageInfo as { hasNextPage: boolean; endCursor: string | null };
        if (!page?.hasNextPage || !page.endCursor) break;
        after = page.endCursor;
      }
      const fileKey = `shops/${tenant.shopId}/bulk-operations/${id}.jsonl`;
      await this.storage.put(fileKey, Buffer.concat(chunks), 'application/jsonl');
      await finish({ status: 'completed', fileKey });
    } catch (error) {
      this.logger?.error({ err: error, bulkOperationId: id }, 'bulk operation failed');
      await finish({ status: 'failed', errorCode: 'INTERNAL_SERVER_ERROR' }).catch(() => undefined);
    }
  }
}

export enum BulkOperationStatus {
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELED = 'CANCELED',
}

registerEnumType(BulkOperationStatus, { name: 'BulkOperationStatus' });

@ObjectType({
  description:
    "All of one of the shop's lists at once (DEV-10, ADR-843), as Shopify's bulk operations: its " +
    'nodes in a JSONL file, a line each.',
})
export class BulkOperation {
  @Field(() => ID)
  id!: string;

  @Field()
  query!: string;

  @Field(() => BulkOperationStatus)
  status!: BulkOperationStatus;

  @Field(() => Int, { description: 'The nodes written so far.' })
  objectCount!: number;

  @Field(() => Int, { nullable: true, description: "The file's bytes, once written." })
  fileSize!: number | null;

  @Field(() => String, {
    nullable: true,
    description: 'Where the file is, for a week: a line of JSON for each node.',
  })
  url!: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'Why it failed: the code of the query’s first error, TOO_LARGE past a million nodes or ' +
      '500 MB, or TIMEOUT for one that stopped running.',
  })
  errorCode!: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  completedAt!: Date | null;
}

@ObjectType()
export class BulkOperationPayload {
  @Field(() => BulkOperation, { nullable: true })
  bulkOperation!: BulkOperation | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@Resolver()
export class BulkOperationsResolver {
  constructor(private readonly bulk: BulkOperationsService) {}

  #view(record: BulkOperationRecord): BulkOperation {
    return Object.assign(new BulkOperation(), {
      id: toPublicId('bulkOperation', record.id),
      query: record.query,
      status: record.status.toUpperCase() as BulkOperationStatus,
      objectCount: record.objectCount,
      fileSize: record.fileSize,
      url: this.bulk.urlOf(record),
      errorCode: record.errorCode,
      createdAt: record.createdAt,
      completedAt: record.completedAt,
    });
  }

  @Query(() => BulkOperation, {
    nullable: true,
    description: "The caller's latest bulk operation: running, or how it ended.",
  })
  @RequireScopes()
  async currentBulkOperation(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<BulkOperation | null> {
    const record = await this.bulk.current(tenant);
    return record && this.#view(record);
  }

  @Mutation(() => BulkOperationPayload, {
    description:
      'Runs a query for all of one list in the background, as the caller, a page at a time, ' +
      'writing each node to a JSONL file: one list at its top, with its nodes or edges, and ' +
      'without first, last, after or before. The scopes it needs are the list’s own. Its pages ' +
      'cost nothing of the query budget; one runs at a time for a caller.',
  })
  @RequireScopes()
  async bulkOperationRunQuery(
    @CurrentTenant() tenant: TenantContext,
    @Args('query') query: string,
  ): Promise<BulkOperationPayload> {
    const result = await this.bulk.run(tenant, query);
    return Object.assign(new BulkOperationPayload(), {
      bulkOperation: result.ok ? this.#view(result.value) : null,
      userErrors: result.ok
        ? []
        : [
            Object.assign(new UserError(), {
              field: ['query'],
              code: 'INVALID',
              message: result.message,
            }),
          ],
    });
  }

  @Mutation(() => BulkOperationPayload, { description: 'Stops a running bulk operation.' })
  @RequireScopes()
  async bulkOperationCancel(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<BulkOperationPayload> {
    const uuid = tryFromPublicId(id, 'bulkOperation');
    const record = uuid ? await this.bulk.cancel(tenant, uuid) : null;
    return Object.assign(new BulkOperationPayload(), {
      bulkOperation: record && this.#view(record),
      userErrors: record
        ? []
        : [
            Object.assign(new UserError(), {
              field: ['id'],
              code: 'NOT_FOUND',
              message: 'No bulk operation of yours is running by that id',
            }),
          ],
    });
  }
}
