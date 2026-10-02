import {
  CurrentTenant,
  PlanAllowance,
  RequireRecentAuthentication,
  RequireScopes,
  UserError,
  actorColumnsOf,
  deniedToRole,
  type FieldError,
  type StaffRole,
  type TenantContext,
} from '@hatti/api';
import { Database } from '@hatti/db';
import { recordAudit } from '@hatti/events';
import { tryFromPublicId, toPublicId } from '@hatti/ids';
import {
  StaffService,
  type StaffInvitationRecord,
  type StaffMemberRecord,
} from '@hatti/identity/public';
import { OrderService } from '@hatti/orders/public';
import { Optional } from '@nestjs/common';
import {
  Args,
  Field,
  GraphQLISODateTime,
  ID,
  Mutation,
  ObjectType,
  Query,
  Resolver,
  registerEnumType,
} from '@nestjs/graphql';

export enum StaffMemberRole {
  OWNER = 'OWNER',
  MANAGER = 'MANAGER',
  CONFIRMATION_AGENT = 'CONFIRMATION_AGENT',
  PACKER = 'PACKER',
  MARKETER = 'MARKETER',
  ACCOUNTANT = 'ACCOUNTANT',
}

registerEnumType(StaffMemberRole, {
  name: 'StaffMemberRole',
  description: 'What a staff member does in the shop, which says what they may see and do.',
});

@ObjectType({ description: 'Someone who works in the shop (ADR-101).' })
export class StaffMember {
  @Field(() => ID, { description: 'Their account: usr_…' })
  id!: string;

  @Field()
  name!: string;

  @Field(() => String, {
    nullable: true,
    description: 'Their email; none for one who opened their account with a phone alone.',
  })
  email!: string | null;

  @Field(() => StaffMemberRole)
  role!: StaffMemberRole;

  @Field(() => GraphQLISODateTime, { description: 'When they began working in the shop.' })
  joinedAt!: Date;
}

@ObjectType({
  description:
    'An invitation to work in the shop, waiting for whoever holds its link to accept it, signed ' +
    'in, before it expires (ADR-101).',
})
export class StaffInvitation {
  @Field(() => ID)
  id!: string;

  @Field(() => StaffMemberRole)
  role!: StaffMemberRole;

  @Field(() => String, { nullable: true, description: 'Whom it is for, as the inviter noted it.' })
  note!: string | null;

  @Field({ description: "Who invited them: the staff member's name." })
  invitedBy!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime, { description: '7 days after it was made.' })
  expiresAt!: Date;
}

@ObjectType()
export class StaffInvitationCreatePayload {
  @Field(() => StaffInvitation, { nullable: true })
  invitation!: StaffInvitation | null;

  @Field(() => String, {
    nullable: true,
    description:
      "The invitation's secret, shown this once: the admin's link to accept it carries it, and " +
      'POST /auth/invitations/accept takes it from a signed-in user.',
  })
  token!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class StaffInvitationRevokePayload {
  @Field(() => StaffInvitation, { nullable: true })
  invitation!: StaffInvitation | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class StaffMemberRoleUpdatePayload {
  @Field(() => StaffMember, { nullable: true })
  staffMember!: StaffMember | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class ShopOwnershipTransferPayload {
  @Field(() => StaffMember, { nullable: true, description: 'Who owns the shop now.' })
  owner!: StaffMember | null;

  @Field(() => StaffMember, {
    nullable: true,
    description: 'Who owned it, a manager from now on.',
  })
  previousOwner!: StaffMember | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class StaffMemberRemovePayload {
  @Field(() => ID, { nullable: true })
  removedStaffMemberId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

const ROLES = {
  owner: StaffMemberRole.OWNER,
  manager: StaffMemberRole.MANAGER,
  confirmation_agent: StaffMemberRole.CONFIRMATION_AGENT,
  packer: StaffMemberRole.PACKER,
  marketer: StaffMemberRole.MARKETER,
  accountant: StaffMemberRole.ACCOUNTANT,
} satisfies Record<StaffRole, StaffMemberRole>;

/**
 * Who works in the shop, and the invitations to it (ADR-101): owners and managers see and manage
 * them, the owner every role but its own and managers those below them, and the owner hands the
 * shop to a manager (ADR-104). Apps never do. Each change goes on the shop's audit log.
 */
@Resolver()
export class StaffResolver {
  constructor(
    private readonly staff: StaffService,
    private readonly orders: OrderService,
    private readonly db: Database,
    /** The shop's plan's limit on staff (ADR-154); without it, none. */
    @Optional() private readonly allowance?: PlanAllowance,
  ) {}

  @Query(() => [StaffMember], {
    description:
      'Who works in the shop: its owner first, then everyone else as they joined. Staff need to ' +
      'be the owner or a manager.',
  })
  @RequireScopes('read_settings')
  async staffMembers(@CurrentTenant() tenant: TenantContext): Promise<StaffMember[]> {
    managingStaff(tenant);
    return (await this.staff.staffOf(tenant.shopId)).map(toStaffMember);
  }

  @Query(() => [StaffInvitation], {
    description:
      'Invitations neither accepted, taken back nor expired, the newest first. Staff need to be ' +
      'the owner or a manager.',
  })
  @RequireScopes('read_settings')
  async staffInvitations(@CurrentTenant() tenant: TenantContext): Promise<StaffInvitation[]> {
    managingStaff(tenant);
    return (await this.staff.invitationsOf(tenant.shopId)).map(toStaffInvitation);
  }

  @Mutation(() => StaffInvitationCreatePayload, {
    description:
      'Invites someone to work in the shop in `role`, by a link the inviter sends them, good for ' +
      '7 days and accepted once. The owner invites any role but its own; managers, those below ' +
      'them. Staff confirm who they are first when they signed in over 15 minutes ago.',
  })
  @RequireScopes('write_settings')
  @RequireRecentAuthentication()
  async staffInvitationCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('role', { type: () => StaffMemberRole }) role: StaffMemberRole,
    @Args('note', {
      type: () => String,
      nullable: true,
      description: 'Whom it is for, up to 100 characters: "Bilal, for packing".',
    })
    note?: string | null,
  ): Promise<StaffInvitationCreatePayload> {
    const actor = managingStaff(tenant);
    const limit = (await this.allowance?.limitOf(tenant.shopId, 'staff')) ?? null;
    const result = await this.staff.invite(
      actor,
      tenant.shopId,
      { role: roleOf(role), note },
      {},
      limit,
    );
    if (result.ok) {
      await this.audit(tenant, 'staff.invited', 'staffInvitation', result.value.invitation.id, {
        role,
      });
    }
    return Object.assign(new StaffInvitationCreatePayload(), {
      invitation: result.ok ? toStaffInvitation(result.value.invitation) : null,
      token: result.ok ? result.value.token : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => StaffInvitationRevokePayload, {
    description: 'Takes back an invitation not yet accepted: its link opens nothing after.',
  })
  @RequireScopes('write_settings')
  async staffInvitationRevoke(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<StaffInvitationRevokePayload> {
    const actor = managingStaff(tenant);
    const invitationId = tryFromPublicId(id, 'staffInvitation');
    const result = invitationId
      ? await this.staff.revokeInvitation(actor, tenant.shopId, invitationId)
      : notFound('Invitation not found');
    if (result.ok) {
      await this.audit(tenant, 'staff.invitation_revoked', 'staffInvitation', result.value.id, {
        role: ROLES[result.value.role],
      });
    }
    return Object.assign(new StaffInvitationRevokePayload(), {
      invitation: result.ok ? toStaffInvitation(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => StaffMemberRoleUpdatePayload, {
    description:
      'Gives a staff member another role, from the next request they make: both roles must be ' +
      'ones the acting member manages, and nobody changes their own. Staff confirm who they are ' +
      'first when they signed in over 15 minutes ago.',
  })
  @RequireScopes('write_settings')
  @RequireRecentAuthentication()
  async staffMemberRoleUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('role', { type: () => StaffMemberRole }) role: StaffMemberRole,
  ): Promise<StaffMemberRoleUpdatePayload> {
    const actor = managingStaff(tenant);
    const userId = tryFromPublicId(id, 'user');
    const result = userId
      ? await this.staff.changeRole(actor, tenant.shopId, userId, roleOf(role))
      : notFound('Staff member not found');
    if (result.ok && result.value.previousRole !== result.value.member.role) {
      await this.audit(tenant, 'staff.role_changed', 'user', result.value.member.userId, {
        from: ROLES[result.value.previousRole],
        to: role,
      });
    }
    return Object.assign(new StaffMemberRoleUpdatePayload(), {
      staffMember: result.ok ? toStaffMember(result.value.member) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => StaffMemberRemovePayload, {
    description:
      'Removes a staff member the acting member manages: the shop is closed to them from their ' +
      'next request, and their open orders go back to no one. The owner is never removed so. ' +
      'Staff confirm who they are first when they signed in over 15 minutes ago.',
  })
  @RequireScopes('write_settings')
  @RequireRecentAuthentication()
  async staffMemberRemove(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<StaffMemberRemovePayload> {
    const actor = managingStaff(tenant);
    const userId = tryFromPublicId(id, 'user');
    const result = userId
      ? await this.staff.remove(actor, tenant.shopId, userId)
      : notFound('Staff member not found');
    if (result.ok) {
      await this.audit(tenant, 'staff.removed', 'user', result.value.userId, {
        role: ROLES[result.value.role],
      });
      // Their open orders go back to no one, for others to take (ADR-127).
      await this.orders.release(tenant, result.value.userId);
    }
    return Object.assign(new StaffMemberRemovePayload(), {
      removedStaffMemberId: result.ok ? toPublicId('user', result.value.userId) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => ShopOwnershipTransferPayload, {
    description:
      'Hands the shop to one of its managers, who needs a passkey or an authenticator app. Only ' +
      'the owner does it, and stays on as a manager from their next request. Staff confirm who ' +
      'they are first when they signed in over 15 minutes ago.',
  })
  @RequireScopes('write_settings')
  @RequireRecentAuthentication()
  async shopOwnershipTransfer(
    @CurrentTenant() tenant: TenantContext,
    @Args('staffMemberId', { type: () => ID, description: 'The manager to own the shop: usr_…' })
    staffMemberId: string,
  ): Promise<ShopOwnershipTransferPayload> {
    const actor = owning(tenant);
    const userId = tryFromPublicId(staffMemberId, 'user');
    const result = userId
      ? await this.staff.transferOwnership(actor, tenant.shopId, userId)
      : notFound('Staff member not found', ['staffMemberId']);
    if (result.ok) {
      await this.audit(tenant, 'shop.ownership_transferred', 'shop', tenant.shopId, {
        from: toPublicId('user', result.value.previousOwner.userId),
        to: toPublicId('user', result.value.owner.userId),
      });
    }
    return Object.assign(new ShopOwnershipTransferPayload(), {
      owner: result.ok ? toStaffMember(result.value.owner) : null,
      previousOwner: result.ok ? toStaffMember(result.value.previousOwner) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  /** On the shop's audit log, once the change stands in the identity module's tables. */
  private async audit(
    tenant: TenantContext,
    action: string,
    subjectType: 'shop' | 'staffInvitation' | 'user',
    subjectId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.db.tenant(tenant.shopId, (tx) =>
      recordAudit(tx, tenant.shopId, {
        action,
        subjectType,
        subjectId,
        ...actorColumnsOf(tenant.actor),
        details,
      }),
    );
  }
}

/** The acting staff member: the owner or a manager. Apps manage no staff. */
function managingStaff(tenant: TenantContext): { userId: string } {
  if (tenant.actor.kind !== 'staff') {
    throw deniedToRole('Access denied. Staff are managed by the owner and managers, not apps.');
  }
  if (tenant.actor.role !== 'owner' && tenant.actor.role !== 'manager') {
    throw deniedToRole('Access denied. Only the owner and managers manage staff.');
  }
  return { userId: tenant.actor.userId };
}

/** The shop's owner, acting: only they hand it over, never apps. */
function owning(tenant: TenantContext): { userId: string } {
  if (tenant.actor.kind !== 'staff') {
    throw deniedToRole('Access denied. A shop is handed over by its owner, not apps.');
  }
  if (tenant.actor.role !== 'owner') {
    throw deniedToRole('Access denied. Only the owner hands the shop over.');
  }
  return { userId: tenant.actor.userId };
}

function roleOf(role: StaffMemberRole): StaffRole {
  return role.toLowerCase() as StaffRole;
}

function notFound(message: string, field = ['id']): { ok: false; errors: FieldError[] } {
  return { ok: false, errors: [{ field, code: 'NOT_FOUND', message }] };
}

function toStaffMember(record: StaffMemberRecord): StaffMember {
  return Object.assign(new StaffMember(), {
    id: toPublicId('user', record.userId),
    name: record.name,
    email: record.email,
    role: ROLES[record.role],
    joinedAt: record.joinedAt,
  });
}

function toStaffInvitation(record: StaffInvitationRecord): StaffInvitation {
  return Object.assign(new StaffInvitation(), {
    id: toPublicId('staffInvitation', record.id),
    role: ROLES[record.role],
    note: record.note,
    invitedBy: record.invitedBy.name,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  });
}
