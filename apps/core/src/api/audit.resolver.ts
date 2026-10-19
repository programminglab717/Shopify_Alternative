import {
  CurrentTenant,
  PageInfo,
  RequireScopes,
  badUserInput,
  decodeCursor,
  encodeCursor,
  pageSize,
  type TenantContext,
} from '@hatti/api';
import { Database } from '@hatti/db';
import { listAudit, type AuditEntry as AuditEntryRecord } from '@hatti/events';
import { PublicIdError, isUuid, parsePublicId, toPublicId, type IdKind } from '@hatti/ids';
import {
  Args,
  ArgsType,
  Field,
  GraphQLISODateTime,
  ID,
  Int,
  ObjectType,
  Query,
  Resolver,
  registerEnumType,
} from '@nestjs/graphql';

export enum AuditActorKind {
  APP = 'APP',
  STAFF = 'STAFF',
  SUPPORT = 'SUPPORT',
  CUSTOMER = 'CUSTOMER',
}

registerEnumType(AuditActorKind, {
  name: 'AuditActorKind',
  valuesMap: {
    SUPPORT: { description: "Hatti's support, looking while the owner lets it (ADR-156)." },
    CUSTOMER: {
      description:
        'The customer themselves, asking for their data or its erasure from their account on the ' +
        'online store (ADR-572).',
    },
  },
});

@ObjectType({
  description:
    "Who did something: an app, by its access token, a staff member, Hatti's support agent, or " +
    'a customer, asking for themselves from their account.',
})
export class AuditActor {
  @Field(() => AuditActorKind)
  kind!: AuditActorKind;

  @Field(() => ID, {
    description:
      "The access token (tok_…), the staff member or Hatti's support agent (usr_…), or the " +
      'customer (cus_…), who may since have been erased.',
  })
  id!: string;

  @Field(() => String, {
    nullable: true,
    description: 'A staff member\'s role at the time, e.g. "confirmation_agent".',
  })
  role!: string | null;
}

@ObjectType({
  description:
    "Something done in the shop that it may need to account for later: a customer's number " +
    "revealed, customers exported, merged or erased, a policy changed, or what Hatti's support " +
    'looked at.',
})
export class AuditEntry {
  @Field(() => ID)
  id!: string;

  @Field({
    description:
      'e.g. "customer.phone_revealed", "order.phone_revealed", "customers.exported", ' +
      '"customer.merged", "customer.erased", "order_risk_settings.updated", "support.looked".',
  })
  action!: string;

  @Field(() => ID, { description: 'What it was done to: a customer, an order or the shop.' })
  subjectId!: string;

  @Field(() => AuditActor)
  actor!: AuditActor;

  @Field({ description: 'More about it, as a JSON object. Never contact details.' })
  details!: string;

  @Field(() => GraphQLISODateTime)
  occurredAt!: Date;
}

@ObjectType()
export class AuditEntryEdge {
  @Field()
  cursor!: string;

  @Field(() => AuditEntry)
  node!: AuditEntry;
}

@ObjectType()
export class AuditEntryConnection {
  @Field(() => [AuditEntryEdge])
  edges!: AuditEntryEdge[];

  @Field(() => [AuditEntry])
  nodes!: AuditEntry[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class AuditLogArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;

  @Field(() => ID, { nullable: true, description: 'Only what was done to this customer or order.' })
  subjectId?: string | null;

  @Field(() => String, { nullable: true, description: 'Only this action.' })
  action?: string | null;
}

/** The kind of public ID each kind of actor has. */
const AUDIT_ACTOR_IDS = {
  app: 'accessToken',
  staff: 'user',
  support: 'user',
  customer: 'customer',
} as const satisfies Record<AuditEntryRecord['actorKind'], IdKind>;

function toAuditEntry(record: AuditEntryRecord): AuditEntry {
  return Object.assign(new AuditEntry(), {
    id: toPublicId('auditEntry', record.id),
    action: record.action,
    subjectId: toPublicId(record.subjectType, record.subjectId),
    actor: Object.assign(new AuditActor(), {
      kind: record.actorKind.toUpperCase() as AuditActorKind,
      id: toPublicId(AUDIT_ACTOR_IDS[record.actorKind], record.actorId),
      role: record.actorRole,
    }),
    details: JSON.stringify(record.details),
    occurredAt: record.occurredAt,
  });
}

/** The shop's activity log (docs/design/02-information-architecture.md §4). */
@Resolver()
export class AuditResolver {
  constructor(private readonly db: Database) {}

  @Query(() => AuditEntryConnection, {
    description: "The shop's activity log, newest first. Owners and managers.",
  })
  @RequireScopes('read_settings')
  async auditLog(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: AuditLogArgs,
  ): Promise<AuditEntryConnection> {
    let subjectId: string | null = null;
    if (args.subjectId) {
      try {
        subjectId = parsePublicId(args.subjectId).uuid;
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
      listAudit(tx, tenant.shopId, { first, after, subjectId, action: args.action }),
    );
    const nodes = page.items.map(toAuditEntry);
    const edges = nodes.map((node, index) =>
      Object.assign(new AuditEntryEdge(), {
        node,
        cursor: encodeCursor({ id: page.items[index]!.id }),
      }),
    );
    return Object.assign(new AuditEntryConnection(), {
      edges,
      nodes,
      pageInfo: Object.assign(new PageInfo(), {
        hasNextPage: page.hasNextPage,
        endCursor: edges.at(-1)?.cursor ?? null,
      }),
    });
  }
}
