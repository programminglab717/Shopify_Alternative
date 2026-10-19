import {
  CurrentTenant,
  Loaders,
  PRESET_CAPABILITIES,
  ROLE_SCOPES,
  RequestLoaders,
  RequireRecentAuthentication,
  RequireScopes,
  STAFF_ROLES,
  UserError,
  actorColumnsOf,
  type StaffCapability,
  type TenantContext,
} from '@hatti/api';
import { Database } from '@hatti/db';
import { recordAudit } from '@hatti/events';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { CUSTOM_ROLE_LIMITS, StaffService, type CustomRoleRecord } from '@hatti/identity/public';
import {
  Args,
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  Mutation,
  ObjectType,
  Parent,
  Query,
  ResolveField,
  Resolver,
  registerEnumType,
} from '@nestjs/graphql';
import {
  ROLES,
  StaffInvitation,
  StaffMember,
  StaffMemberRole,
  managingStaff,
  notFound,
  roleOf,
} from './staff.resolver.js';

export enum StaffCapabilityEnum {
  SEE_CUSTOMER_NUMBERS = 'SEE_CUSTOMER_NUMBERS',
  REVEAL_CUSTOMER_NUMBERS = 'REVEAL_CUSTOMER_NUMBERS',
  EXPORT_ORDERS = 'EXPORT_ORDERS',
  MANAGE_EXPORT_SCHEDULES = 'MANAGE_EXPORT_SCHEDULES',
  REFUND_ORDERS = 'REFUND_ORDERS',
  ASSIGN_ORDERS = 'ASSIGN_ORDERS',
  MODERATE_COMMENTS = 'MODERATE_COMMENTS',
  SEE_STAFF_PERFORMANCE = 'SEE_STAFF_PERFORMANCE',
  RECONCILE_PAYMENTS = 'RECONCILE_PAYMENTS',
  CLAIM_FROM_COURIERS = 'CLAIM_FROM_COURIERS',
  MANAGE_STAFF = 'MANAGE_STAFF',
  MANAGE_APPS = 'MANAGE_APPS',
  SEE_BILLING = 'SEE_BILLING',
  SEE_VERIFICATION = 'SEE_VERIFICATION',
  MANAGE_SUPPORT_ACCESS = 'MANAGE_SUPPORT_ACCESS',
}

const CAPABILITIES = {
  see_customer_numbers: StaffCapabilityEnum.SEE_CUSTOMER_NUMBERS,
  reveal_customer_numbers: StaffCapabilityEnum.REVEAL_CUSTOMER_NUMBERS,
  export_orders: StaffCapabilityEnum.EXPORT_ORDERS,
  manage_export_schedules: StaffCapabilityEnum.MANAGE_EXPORT_SCHEDULES,
  refund_orders: StaffCapabilityEnum.REFUND_ORDERS,
  assign_orders: StaffCapabilityEnum.ASSIGN_ORDERS,
  moderate_comments: StaffCapabilityEnum.MODERATE_COMMENTS,
  see_staff_performance: StaffCapabilityEnum.SEE_STAFF_PERFORMANCE,
  reconcile_payments: StaffCapabilityEnum.RECONCILE_PAYMENTS,
  claim_from_couriers: StaffCapabilityEnum.CLAIM_FROM_COURIERS,
  manage_staff: StaffCapabilityEnum.MANAGE_STAFF,
  manage_apps: StaffCapabilityEnum.MANAGE_APPS,
  see_billing: StaffCapabilityEnum.SEE_BILLING,
  see_verification: StaffCapabilityEnum.SEE_VERIFICATION,
  manage_support_access: StaffCapabilityEnum.MANAGE_SUPPORT_ACCESS,
} satisfies Record<StaffCapability, StaffCapabilityEnum>;

registerEnumType(StaffCapabilityEnum, {
  name: 'StaffCapability',
  description:
    'What staff may do beyond their scopes, which each role preset holds some of and a custom ' +
    "role some of its preset's (ADM-01, ADR-578). What only the owner does is none of them.",
  valuesMap: {
    SEE_CUSTOMER_NUMBERS: { description: "Customers' mobile numbers whole." },
    REVEAL_CUSTOMER_NUMBERS: {
      description:
        'One number at a time, with orderPhoneReveal or customerPhoneReveal, each on the audit ' +
        'log, where numbers are masked otherwise.',
    },
    EXPORT_ORDERS: { description: 'Orders as a file, now or scheduled to their email.' },
    MANAGE_EXPORT_SCHEDULES: {
      description: "Deleting anyone's scheduled export, not their own alone.",
    },
    REFUND_ORDERS: {
      description: 'Recording refunds, and settling those a gateway never answered.',
    },
    ASSIGN_ORDERS: {
      description: 'Giving an order to anyone, and taking it from whoever has it (ADR-127).',
    },
    MODERATE_COMMENTS: { description: "Deleting anyone's comment on an order (ADR-128)." },
    SEE_STAFF_PERFORMANCE: { description: 'How each confirmation agent and packer did.' },
    RECONCILE_PAYMENTS: {
      description:
        "Couriers' remittances, gateways' settlements, and the report of what the shop is paid.",
    },
    CLAIM_FROM_COURIERS: { description: 'Claims for parcels couriers lost or damaged.' },
    MANAGE_STAFF: {
      description:
        'Staff, their invitations, requests for access and custom roles, within the roles ' +
        'their preset manages (ADR-101).',
    },
    MANAGE_APPS: { description: "The shop's custom apps and apps' webhooks." },
    SEE_BILLING: { description: 'What the shop pays Hatti.' },
    SEE_VERIFICATION: { description: "The shop's verification by Hatti (ADR-465)." },
    MANAGE_SUPPORT_ACCESS: {
      description: "Seeing Hatti's support's access to the shop, and ending it (ADR-156).",
    },
  },
});

@ObjectType({
  description:
    "A shop's own staff role (ADM-01, ADR-578): made from a preset other than the owner's, for " +
    "good, holding some of its scopes and capabilities, never more. Its members' role is the " +
    'preset, which says the rest, such as whether they need a second factor.',
})
export class CustomRole {
  @Field(() => ID, { description: 'role_…' })
  id!: string;

  @Field({ description: `Up to ${CUSTOM_ROLE_LIMITS.name} characters, the shop's alone.` })
  name!: string;

  @Field(() => StaffMemberRole, { description: 'The preset it was made from.' })
  basedOn!: StaffMemberRole;

  @Field(() => [String], {
    description:
      'Its access scopes, such as "write_orders": some of its preset\'s, or the read of what ' +
      'the preset writes.',
  })
  scopes!: string[];

  @Field(() => [StaffCapabilityEnum], { description: "Some of its preset's capabilities." })
  capabilities!: StaffCapabilityEnum[];

  @Field(() => Int, { description: 'Members of staff who hold it.' })
  staffMemberCount!: number;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType({
  description:
    'A role preset (ADR-578), with the scopes and capabilities it holds: what a custom role made from it holds some of.',
})
export class RolePreset {
  @Field(() => StaffMemberRole)
  role!: StaffMemberRole;

  @Field(() => [String])
  scopes!: string[];

  @Field(() => [StaffCapabilityEnum])
  capabilities!: StaffCapabilityEnum[];

  @Field({ description: "Whether a custom role is made from it: every preset but the owner's." })
  customizable!: boolean;
}

@InputType()
export class CustomRoleCreateInput {
  @Field({
    description: `1 to ${CUSTOM_ROLE_LIMITS.name} characters, no other role's of the shop.`,
  })
  name!: string;

  @Field(() => StaffMemberRole, { description: "The preset it is made from: any but the owner's." })
  basedOn!: StaffMemberRole;

  @Field(() => [String], {
    description:
      "Its access scopes, each one of its preset's, or the read of a resource the preset writes.",
  })
  scopes!: string[];

  @Field(() => [StaffCapabilityEnum], { description: "Its capabilities, each its preset's." })
  capabilities!: StaffCapabilityEnum[];
}

@InputType()
export class CustomRoleUpdateInput {
  @Field(() => String, { nullable: true })
  name?: string | null;

  @Field(() => [String], { nullable: true, description: 'In place of its scopes, where given.' })
  scopes?: string[] | null;

  @Field(() => [StaffCapabilityEnum], {
    nullable: true,
    description: 'In place of its capabilities, where given.',
  })
  capabilities?: StaffCapabilityEnum[] | null;
}

@ObjectType()
export class CustomRoleCreatePayload {
  @Field(() => CustomRole, { nullable: true })
  customRole!: CustomRole | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class CustomRoleUpdatePayload {
  @Field(() => CustomRole, { nullable: true })
  customRole!: CustomRole | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class CustomRoleDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedCustomRoleId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

/**
 * The shop's custom roles (ADM-01, ADR-578), made, changed and deleted by those who manage staff:
 * the owner from any preset but its own, managers from those below them, as they manage staff
 * (ADR-101). Each change goes on the shop's audit log.
 */
@Resolver()
export class CustomRoleResolver {
  constructor(
    private readonly staff: StaffService,
    private readonly db: Database,
  ) {}

  @Query(() => [CustomRole], {
    description:
      "The shop's custom roles (ADR-578), by name. Staff need to be the owner or a manager.",
  })
  @RequireScopes('read_settings')
  async customRoles(@CurrentTenant() tenant: TenantContext): Promise<CustomRole[]> {
    managingStaff(tenant);
    return (await this.staff.customRolesOf(tenant.shopId)).map(toCustomRole);
  }

  @Query(() => [RolePreset], {
    description:
      'The role presets, with the scopes and capabilities each holds: what a custom role made ' +
      'from one holds some of (ADR-578). Staff need to be the owner or a manager.',
  })
  @RequireScopes('read_settings')
  rolePresets(@CurrentTenant() tenant: TenantContext): RolePreset[] {
    managingStaff(tenant);
    return STAFF_ROLES.map((role) =>
      Object.assign(new RolePreset(), {
        role: ROLES[role],
        scopes: [...ROLE_SCOPES[role]],
        capabilities: PRESET_CAPABILITIES[role].map((capability) => CAPABILITIES[capability]),
        customizable: role !== 'owner',
      }),
    );
  }

  @Mutation(() => CustomRoleCreatePayload, {
    description:
      'Makes a custom role (ADR-578) from a preset, with some of its scopes and capabilities, ' +
      `never more; a shop has ${CUSTOM_ROLE_LIMITS.perShop} at most. The owner makes them from ` +
      'any preset but its own; managers, from those below them.',
  })
  @RequireScopes('write_settings')
  async customRoleCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: CustomRoleCreateInput,
  ): Promise<CustomRoleCreatePayload> {
    const actor = managingStaff(tenant);
    const result = await this.staff.createCustomRole(actor, tenant.shopId, {
      name: input.name,
      basedOn: roleOf(input.basedOn),
      scopes: input.scopes,
      capabilities: input.capabilities.map(capabilityOf),
    });
    if (result.ok) {
      await this.audit(tenant, 'staff.custom_role_created', result.value);
    }
    return Object.assign(new CustomRoleCreatePayload(), {
      customRole: result.ok ? toCustomRole(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => CustomRoleUpdatePayload, {
    description:
      "Changes a custom role's name, scopes or capabilities, those given, within its preset's " +
      'still; its preset stays. Those who hold it have what it says from their next request. ' +
      'Staff confirm who they are first when they signed in over 15 minutes ago.',
  })
  @RequireScopes('write_settings')
  @RequireRecentAuthentication()
  async customRoleUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: CustomRoleUpdateInput,
  ): Promise<CustomRoleUpdatePayload> {
    const actor = managingStaff(tenant);
    const roleId = tryFromPublicId(id, 'customRole');
    const result = roleId
      ? await this.staff.updateCustomRole(actor, tenant.shopId, roleId, {
          name: input.name,
          scopes: input.scopes,
          capabilities: input.capabilities?.map(capabilityOf),
        })
      : notFound('Custom role not found');
    if (result.ok) {
      await this.audit(tenant, 'staff.custom_role_updated', result.value);
    }
    return Object.assign(new CustomRoleUpdatePayload(), {
      customRole: result.ok ? toCustomRole(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => CustomRoleDeletePayload, {
    description:
      'Deletes a custom role no member of staff holds, nor any invitation waiting: give them ' +
      'another role, or take the invitations back, first (IN_USE).',
  })
  @RequireScopes('write_settings')
  async customRoleDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<CustomRoleDeletePayload> {
    const actor = managingStaff(tenant);
    const roleId = tryFromPublicId(id, 'customRole');
    const result = roleId
      ? await this.staff.deleteCustomRole(actor, tenant.shopId, roleId)
      : notFound('Custom role not found');
    if (result.ok) {
      await this.audit(tenant, 'staff.custom_role_deleted', result.value);
    }
    return Object.assign(new CustomRoleDeletePayload(), {
      deletedCustomRoleId: result.ok ? toPublicId('customRole', result.value.id) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  /** On the shop's audit log, with what the role holds, once it stands in identity's tables. */
  private async audit(
    tenant: TenantContext,
    action: string,
    role: CustomRoleRecord,
  ): Promise<void> {
    await this.db.tenant(tenant.shopId, (tx) =>
      recordAudit(tx, tenant.shopId, {
        action,
        subjectType: 'customRole',
        subjectId: role.id,
        ...actorColumnsOf(tenant.actor),
        details: {
          name: role.name,
          basedOn: ROLES[role.basedOn],
          scopes: role.scopes,
          capabilities: role.capabilities.map((capability) => CAPABILITIES[capability]),
        },
      }),
    );
  }
}

/** A member of staff's custom role, of the shop's read once a request. */
@Resolver(() => StaffMember)
export class StaffMemberCustomRoleResolver {
  constructor(private readonly staff: StaffService) {}

  @ResolveField(() => CustomRole, {
    nullable: true,
    description: 'Their custom role (ADR-578), whose preset is their role; null for a preset.',
  })
  async customRole(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() member: StaffMember,
  ): Promise<CustomRole | null> {
    return customRoleIn(this.staff, tenant, loaders, member.customRoleUuid);
  }
}

/** An invitation's custom role, of the shop's read once a request. */
@Resolver(() => StaffInvitation)
export class StaffInvitationCustomRoleResolver {
  constructor(private readonly staff: StaffService) {}

  @ResolveField(() => CustomRole, {
    nullable: true,
    description: 'The custom role it gives (ADR-578), whose preset is its role; null for a preset.',
  })
  async customRole(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() invitation: StaffInvitation,
  ): Promise<CustomRole | null> {
    return customRoleIn(this.staff, tenant, loaders, invitation.customRoleUuid);
  }
}

async function customRoleIn(
  staff: StaffService,
  tenant: TenantContext,
  loaders: RequestLoaders,
  id: string | null,
): Promise<CustomRole | null> {
  if (!id) return null;
  const loader = loaders.get<string, CustomRoleRecord>('identity.customRoles', async () => {
    const roles = await staff.customRolesOf(tenant.shopId);
    return new Map(roles.map((role) => [role.id, role]));
  });
  const role = await loader.load(id);
  return role ? toCustomRole(role) : null;
}

function capabilityOf(capability: StaffCapabilityEnum): string {
  return capability.toLowerCase();
}

function toCustomRole(record: CustomRoleRecord): CustomRole {
  return Object.assign(new CustomRole(), {
    id: toPublicId('customRole', record.id),
    name: record.name,
    basedOn: ROLES[record.basedOn],
    scopes: record.scopes,
    capabilities: record.capabilities.map((capability) => CAPABILITIES[capability]),
    staffMemberCount: record.members,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}
