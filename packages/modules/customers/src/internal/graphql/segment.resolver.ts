import {
  CurrentTenant,
  PageInfo,
  RequireScopes,
  UserError,
  badUserInput,
  encodeCursor,
  pageSize,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { Args, ID, Int, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { GraphQLError } from 'graphql';
import type { SegmentRecord } from '../records.js';
import { SEGMENT_OPERATORS } from '../segment-fields.js';
import { SegmentQueryError } from '../segment-query.js';
import { SegmentService } from '../segment.service.js';
import { CustomerConnection } from './customer.types.js';
import { cursorAfter, toCustomer, toCustomerConnection, uuidOf } from './mappers.js';
import {
  Segment,
  SegmentConnection,
  SegmentCreatePayload,
  SegmentDeletePayload,
  SegmentEdge,
  SegmentFilter,
  SegmentFilterType,
  SegmentPreview,
  SegmentUpdatePayload,
  SegmentsArgs,
} from './segment.types.js';

function toSegment(record: SegmentRecord): Segment {
  return Object.assign(new Segment(), {
    id: toPublicId('segment', record.id),
    name: record.name,
    query: record.query,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

type Payload = { segment: Segment | null; userErrors: UserError[] };

function payload<T extends Payload>(type: new () => T, result: MutationResult<SegmentRecord>): T {
  return Object.assign(new type(), {
    segment: result.ok ? toSegment(result.value) : null,
    userErrors: result.ok ? [] : UserError.list(result.errors),
  });
}

/** A query the caller sent that does not parse or check. */
function badQuery<T>(run: () => Promise<T>): Promise<T> {
  return run().catch((error: unknown) => {
    throw error instanceof SegmentQueryError ? badUserInput(error.message) : error;
  });
}

/** A saved query that no longer checks, e.g. after a field was renamed. */
function brokenSegment<T>(segment: Segment, run: () => Promise<T>): Promise<T> {
  return run().catch((error: unknown) => {
    if (!(error instanceof SegmentQueryError)) throw error;
    throw new GraphQLError(`Segment "${segment.name}" needs fixing: ${error.message}`, {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });
}

@Resolver(() => Segment)
export class SegmentResolver {
  constructor(private readonly service: SegmentService) {}

  @Query(() => SegmentConnection, { description: 'Segments, newest first.' })
  @RequireScopes('read_segments')
  async segments(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: SegmentsArgs,
  ): Promise<SegmentConnection> {
    const { items, hasNextPage } = await this.service.list(tenant, {
      first: pageSize(args.first),
      after: cursorAfter(args.after),
    });
    const nodes = items.map(toSegment);
    const edges = nodes.map((node, index) =>
      Object.assign(new SegmentEdge(), { node, cursor: encodeCursor({ id: items[index]!.id }) }),
    );
    return Object.assign(new SegmentConnection(), {
      edges,
      nodes,
      pageInfo: Object.assign(new PageInfo(), {
        hasNextPage,
        endCursor: edges.at(-1)?.cursor ?? null,
      }),
    });
  }

  @Query(() => Segment, { nullable: true, description: 'A segment by ID, or null if not found.' })
  @RequireScopes('read_segments')
  async segment(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<Segment | null> {
    const record = await this.service.get(tenant, uuidOf('segment', id));
    return record ? toSegment(record) : null;
  }

  @Query(() => [SegmentFilter], { description: 'The fields segment queries can use.' })
  @RequireScopes('read_segments')
  segmentFilters(): SegmentFilter[] {
    return this.service.fields().map((field) =>
      Object.assign(new SegmentFilter(), {
        name: field.name,
        type: field.type.toUpperCase() as SegmentFilterType,
        description: field.description,
        example: field.example,
        operators: [...SEGMENT_OPERATORS[field.type]],
      }),
    );
  }

  @Query(() => SegmentPreview, {
    description:
      'What a query matches now, e.g. while it is being written. A query that does not check is ' +
      'a BAD_USER_INPUT error saying what is wrong and where.',
  })
  @RequireScopes('read_segments', 'read_customers')
  async segmentPreview(
    @CurrentTenant() tenant: TenantContext,
    @Args('query') query: string,
    @Args('first', {
      type: () => Int,
      nullable: true,
      description: 'Members to show: 1 to 250; default 10.',
    })
    first?: number | null,
  ): Promise<SegmentPreview> {
    return badQuery(async () => {
      const [memberCount, members] = await Promise.all([
        this.service.count(tenant, query),
        this.service.members(tenant, query, { first: pageSize(first, 10) }),
      ]);
      return Object.assign(new SegmentPreview(), {
        memberCount,
        members: members.items.map((record) => toCustomer(record, tenant)),
      });
    });
  }

  @ResolveField(() => Int, { description: 'How many customers match it now.' })
  @RequireScopes('read_segments', 'read_customers')
  async memberCount(
    @CurrentTenant() tenant: TenantContext,
    @Parent() segment: Segment,
  ): Promise<number> {
    return brokenSegment(segment, () => this.service.count(tenant, segment.query));
  }

  @ResolveField(() => CustomerConnection, {
    description: 'The customers who match it now, newest first.',
  })
  @RequireScopes('read_segments', 'read_customers')
  async members(
    @CurrentTenant() tenant: TenantContext,
    @Parent() segment: Segment,
    @Args() args: SegmentsArgs,
  ): Promise<CustomerConnection> {
    const { items, hasNextPage } = await brokenSegment(segment, () =>
      this.service.members(tenant, segment.query, {
        first: pageSize(args.first),
        after: cursorAfter(args.after),
      }),
    );
    return toCustomerConnection(items, hasNextPage, tenant);
  }

  @Mutation(() => SegmentCreatePayload, {
    description:
      'Saves a customer filter. The query is checked; problems come back as user errors.',
  })
  @RequireScopes('write_segments')
  async segmentCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('name') name: string,
    @Args('query') query: string,
  ): Promise<SegmentCreatePayload> {
    return payload(SegmentCreatePayload, await this.service.create(tenant, { name, query }));
  }

  @Mutation(() => SegmentUpdatePayload, { description: 'Renames a segment or changes its query.' })
  @RequireScopes('write_segments')
  async segmentUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('name', { type: () => String, nullable: true }) name?: string | null,
    @Args('query', { type: () => String, nullable: true }) query?: string | null,
  ): Promise<SegmentUpdatePayload> {
    return payload(
      SegmentUpdatePayload,
      await this.service.update(tenant, uuidOf('segment', id), {
        ...(name === undefined ? {} : { name }),
        ...(query === undefined ? {} : { query }),
      }),
    );
  }

  @Mutation(() => SegmentDeletePayload, { description: 'Deletes a segment. Its customers stay.' })
  @RequireScopes('write_segments')
  async segmentDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<SegmentDeletePayload> {
    const result = await this.service.delete(tenant, uuidOf('segment', id));
    return Object.assign(new SegmentDeletePayload(), {
      deletedSegmentId: result.ok ? toPublicId('segment', result.value.id) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
