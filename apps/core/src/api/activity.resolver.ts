import {
  CurrentTenant,
  PageInfo,
  RequireScopes,
  badUserInput,
  decodeCursor,
  encodeCursor,
  pageSize,
  type ApiContext,
  type TenantContext,
} from '@hatti/api';
import { Database } from '@hatti/db';
import {
  actingAs,
  listActivity,
  type ActivityEntry as ActivityEntryRecord,
  type EventActor,
} from '@hatti/events';
import {
  ID_PREFIXES,
  PublicIdError,
  isUuid,
  parsePublicId,
  toPublicId,
  type IdKind,
} from '@hatti/ids';
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import {
  Args,
  ArgsType,
  Field,
  GqlExecutionContext,
  GraphQLISODateTime,
  ID,
  Int,
  ObjectType,
  Query,
  Resolver,
} from '@nestjs/graphql';
import { Observable } from 'rxjs';
import { AuditActor, AuditActorKind } from './audit.resolver.js';

/**
 * Makes the caller of each request to the Admin API the actor of what it records (ADR-256): the
 * events its resolver appends carry them, a member of staff with their role or an app, and are on
 * the shop's activity log. Hatti's support, which changes nothing, records no one.
 */
@Injectable()
export class EventActorInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType<string>() !== 'graphql') return next.handle();
    const actor = eventActorOf(GqlExecutionContext.create(context).getContext<ApiContext>().tenant);
    if (!actor) return next.handle();
    // The handler is bound to the context `handle` is called in.
    return new Observable((subscriber) => {
      const subscription = actingAs(actor, () => next.handle().subscribe(subscriber));
      return () => subscription.unsubscribe();
    });
  }
}

/** Who a tenant's caller is, as events record them; none for Hatti's support. */
function eventActorOf(tenant: TenantContext | undefined): EventActor | null {
  switch (tenant?.actor.kind) {
    case 'app':
      return { kind: 'app', id: tenant.actor.tokenId, role: null };
    case 'staff':
      return { kind: 'staff', id: tenant.actor.userId, role: tenant.actor.role };
    default:
      return null;
  }
}

@ObjectType({
  description:
    "A change the shop's staff or apps made (ADM-04, ADR-256): the event it recorded, by whom " +
    'and to what; never what it recorded.',
})
export class ActivityEntry {
  @Field(() => ID, { description: "The event's ID (evt_…)." })
  id!: string;

  @Field({
    description: 'What happened, as the event names it: "product.updated", "order.confirmed".',
  })
  type!: string;

  @Field({ description: 'What it happened to: "product", "order", "tax_settings".' })
  subjectType!: string;

  @Field(() => ID, {
    nullable: true,
    description: 'Its ID, where it has one in the API: prod_…, ord_…; null for settings and such.',
  })
  subjectId!: string | null;

  @Field(() => AuditActor)
  actor!: AuditActor;

  @Field(() => GraphQLISODateTime)
  occurredAt!: Date;
}

@ObjectType()
export class ActivityEntryEdge {
  @Field()
  cursor!: string;

  @Field(() => ActivityEntry)
  node!: ActivityEntry;
}

@ObjectType()
export class ActivityEntryConnection {
  @Field(() => [ActivityEntryEdge])
  edges!: ActivityEntryEdge[];

  @Field(() => [ActivityEntry])
  nodes!: ActivityEntry[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class ActivityLogArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;

  @Field(() => ID, { nullable: true, description: 'Only what happened to this, as prod_….' })
  subjectId?: string | null;

  @Field(() => String, { nullable: true, description: 'Only this type, as "product.updated".' })
  type?: string | null;
}

/** "billing_invoice" as the API's kind of ID: "billingInvoice"; null for one it has none of. */
function kindOf(aggregateType: string): IdKind | null {
  const kind = aggregateType.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  return Object.hasOwn(ID_PREFIXES, kind) ? (kind as IdKind) : null;
}

function toActivityEntry(record: ActivityEntryRecord): ActivityEntry {
  const kind = kindOf(record.aggregateType);
  return Object.assign(new ActivityEntry(), {
    id: toPublicId('event', record.id),
    type: record.type,
    subjectType: record.aggregateType,
    subjectId: kind && toPublicId(kind, record.aggregateId),
    actor: Object.assign(new AuditActor(), {
      kind: record.actor.kind.toUpperCase() as AuditActorKind,
      id: toPublicId(record.actor.kind === 'app' ? 'accessToken' : 'user', record.actor.id),
      role: record.actor.role,
    }),
    occurredAt: record.occurredAt,
  });
}

/** What the shop's staff and apps changed (ADM-04, ADR-256). */
@Resolver()
export class ActivityResolver {
  constructor(private readonly db: Database) {}

  @Query(() => ActivityEntryConnection, {
    description:
      "What the shop's staff and apps changed, the latest first: each change as the event it " +
      'recorded, by whom and to what. What needs accounting for, with more about it, is on ' +
      'auditLog. Owners and managers, and apps with read_settings.',
  })
  @RequireScopes('read_settings')
  async activityLog(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: ActivityLogArgs,
  ): Promise<ActivityEntryConnection> {
    let aggregateId: string | null = null;
    if (args.subjectId) {
      try {
        aggregateId = parsePublicId(args.subjectId).uuid;
      } catch (error) {
        if (!(error instanceof PublicIdError)) throw error;
        throw badUserInput(`Invalid id: ${args.subjectId.slice(0, 64)}`);
      }
    }
    let after: string | null = null;
    if (args.after) {
      after = decodeCursor(args.after, ['id']).id;
      if (!isUuid(after)) throw badUserInput('Invalid cursor');
    }
    const first = pageSize(args.first);
    const page = await this.db.tenant(tenant.shopId, (tx) =>
      listActivity(tx, tenant.shopId, {
        first,
        after,
        aggregateId,
        type: args.type?.slice(0, 100) ?? null,
      }),
    );
    const nodes = page.items.map(toActivityEntry);
    const edges = nodes.map((node, index) =>
      Object.assign(new ActivityEntryEdge(), {
        node,
        cursor: encodeCursor({ id: page.items[index]!.id }),
      }),
    );
    return Object.assign(new ActivityEntryConnection(), {
      edges,
      nodes,
      pageInfo: Object.assign(new PageInfo(), {
        hasNextPage: page.hasNextPage,
        endCursor: edges.at(-1)?.cursor ?? null,
      }),
    });
  }
}
