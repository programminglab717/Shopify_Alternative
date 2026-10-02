import {
  CurrentTenant,
  RequireRecentAuthentication,
  RequireScopes,
  UserError,
  actorColumnsOf,
  deniedToRole,
  type TenantContext,
} from '@hatti/api';
import { Database } from '@hatti/db';
import { recordAudit } from '@hatti/events';
import { toPublicId } from '@hatti/ids';
import { SupportAccessService, type SupportGrantRecord } from '@hatti/identity/public';
import {
  Args,
  Field,
  GraphQLISODateTime,
  ID,
  Int,
  Mutation,
  ObjectType,
  Query,
  Resolver,
  registerEnumType,
} from '@nestjs/graphql';

export enum SupportAccessLevel {
  READ = 'READ',
}

registerEnumType(SupportAccessLevel, {
  name: 'SupportAccessLevel',
  valuesMap: {
    READ: { description: 'It looks, numbers masked as most staff see them, and changes nothing.' },
  },
});

@ObjectType({
  description: "A time the shop's owner let Hatti's support look at the shop (ADR-156).",
})
export class SupportAccessGrant {
  @Field(() => ID)
  id!: string;

  @Field(() => SupportAccessLevel)
  access!: SupportAccessLevel;

  @Field(() => String, { nullable: true, description: 'What it is for, as the owner noted it.' })
  note!: string | null;

  @Field({ description: 'The owner who allowed it: their name.' })
  grantedBy!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime, { description: 'When it ends by itself.' })
  expiresAt!: Date;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When it stopped before its time; or when its time ran out, once another came.',
  })
  endedAt!: Date | null;

  @Field(() => String, {
    nullable: true,
    description: 'Who stopped it before its time: their name.',
  })
  endedBy!: string | null;

  @Field({ description: "Open now: Hatti's support may look." })
  open!: boolean;
}

@ObjectType()
export class SupportAccessGrantPayload {
  @Field(() => SupportAccessGrant, { nullable: true })
  grant!: SupportAccessGrant | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class SupportAccessEndPayload {
  @Field(() => SupportAccessGrant, { nullable: true, description: 'The access ended.' })
  grant!: SupportAccessGrant | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

/**
 * Hatti's support looking at the shop with its owner's consent (ADM-08, ADR-156): the owner lets
 * it look for a while, having signed in lately; the owner or a manager ends it at any time; owners
 * and managers see when it was allowed, and the audit log what it looked at.
 */
@Resolver()
export class SupportAccessResolver {
  constructor(
    private readonly support: SupportAccessService,
    private readonly db: Database,
  ) {}

  @Query(() => SupportAccessGrant, {
    nullable: true,
    description:
      "Whether Hatti's support may look at the shop now, and until when. Staff need to be the " +
      'owner or a manager.',
  })
  @RequireScopes('read_settings')
  async supportAccess(@CurrentTenant() tenant: TenantContext): Promise<SupportAccessGrant | null> {
    managing(tenant);
    const grant = await this.support.openGrantOf(tenant.shopId);
    return grant && toGrant(grant);
  }

  @Query(() => [SupportAccessGrant], {
    description:
      "Each time the owner let Hatti's support look, the newest first, 50 at most. Staff need to " +
      'be the owner or a manager.',
  })
  @RequireScopes('read_settings')
  async supportAccessGrants(
    @CurrentTenant() tenant: TenantContext,
    @Args('first', { type: () => Int, defaultValue: 20 }) first: number,
  ): Promise<SupportAccessGrant[]> {
    managing(tenant);
    return (await this.support.grantsOf(tenant.shopId, first)).map(toGrant);
  }

  @Mutation(() => SupportAccessGrantPayload, {
    description:
      "Lets Hatti's support look at the shop for `minutes`, 15 to 1,440, an hour unless said: " +
      'it reads, numbers masked, and changes nothing, each of its requests on the audit log. ' +
      'Access still open ends first. The owner alone, having signed in lately.',
  })
  @RequireScopes('write_settings')
  @RequireRecentAuthentication()
  async supportAccessGrant(
    @CurrentTenant() tenant: TenantContext,
    @Args('minutes', { type: () => Int, nullable: true }) minutes?: number | null,
    @Args('note', {
      type: () => String,
      nullable: true,
      description: 'What it is for, up to 200 characters: "Order #1043 won\'t ship".',
    })
    note?: string | null,
  ): Promise<SupportAccessGrantPayload> {
    const actor = owning(tenant);
    const result = await this.support.grant(actor, tenant.shopId, { minutes, note });
    if (result.ok) {
      const { grant, ended } = result.value;
      await this.audit(tenant, 'support.access_granted', {
        grant: toPublicId('supportGrant', grant.id),
        expiresAt: grant.expiresAt.toISOString(),
        ...(ended ? { ended: toPublicId('supportGrant', ended.id) } : {}),
      });
    }
    return Object.assign(new SupportAccessGrantPayload(), {
      grant: result.ok ? toGrant(result.value.grant) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => SupportAccessEndPayload, {
    description: "Ends Hatti's support's access to the shop now. The owner or a manager.",
  })
  @RequireScopes('write_settings')
  async supportAccessEnd(@CurrentTenant() tenant: TenantContext): Promise<SupportAccessEndPayload> {
    const actor = managingStaff(tenant);
    const result = await this.support.end(actor, tenant.shopId);
    if (result.ok) {
      await this.audit(tenant, 'support.access_ended', {
        grant: toPublicId('supportGrant', result.value.id),
      });
    }
    return Object.assign(new SupportAccessEndPayload(), {
      grant: result.ok ? toGrant(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  /** On the shop's audit log, once the change stands in the identity module's tables. */
  private async audit(
    tenant: TenantContext,
    action: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.db.tenant(tenant.shopId, (tx) =>
      recordAudit(tx, tenant.shopId, {
        action,
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actorColumnsOf(tenant.actor),
        details,
      }),
    );
  }
}

/** Owners and managers see Hatti's support's access; apps with read_settings too. */
function managing(tenant: TenantContext): void {
  if (tenant.actor.kind === 'staff' && !['owner', 'manager'].includes(tenant.actor.role)) {
    throw deniedToRole("Access denied. Only owners and managers see Hatti's support's access.");
  }
}

/** The owner or a manager, acting: they end support's access, never apps. */
function managingStaff(tenant: TenantContext): { userId: string } {
  if (
    tenant.actor.kind !== 'staff' ||
    (tenant.actor.role !== 'owner' && tenant.actor.role !== 'manager')
  ) {
    throw deniedToRole("Access denied. Only the owner and managers end Hatti's support's access.");
  }
  return { userId: tenant.actor.userId };
}

/** The shop's owner, acting: only they let Hatti's support look, never apps. */
function owning(tenant: TenantContext): { userId: string } {
  if (tenant.actor.kind !== 'staff' || tenant.actor.role !== 'owner') {
    throw deniedToRole("Access denied. Only the shop's owner lets Hatti's support look.");
  }
  return { userId: tenant.actor.userId };
}

function toGrant(record: SupportGrantRecord): SupportAccessGrant {
  return Object.assign(new SupportAccessGrant(), {
    id: toPublicId('supportGrant', record.id),
    access: SupportAccessLevel.READ,
    note: record.note,
    grantedBy: record.grantedBy.name,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    endedAt: record.endedAt,
    endedBy: record.endedBy?.name ?? null,
    open: record.open,
  });
}
