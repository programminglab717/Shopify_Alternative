import {
  CurrentTenant,
  Loaders,
  RequestLoaders,
  RequireScopes,
  UserError,
  badUserInput,
  deniedToRole,
  hasCapability,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { StaffService, type StaffMemberRecord } from '@hatti/identity/public';
import { Order, OrderBulkPayload, OrderService, toOrder } from '@hatti/orders/public';
import {
  Args,
  Field,
  ID,
  Mutation,
  ObjectType,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';

@ObjectType({
  description:
    'The member of staff an order is given to, to see it through (ORD-10): who they are, not how ' +
    'they sign in.',
})
export class OrderAssignee {
  @Field(() => ID, { description: 'Their account: usr_…' })
  id!: string;

  @Field()
  name!: string;
}

@ObjectType()
export class OrderAssignPayload {
  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

/**
 * Orders given to members of staff to see through (ORD-10, ADR-127). The orders module keeps whom
 * an order is given to; the core checks that they work in the shop, and says who they are.
 */
@Resolver(() => Order)
export class OrderAssignmentResolver {
  constructor(
    private readonly orders: OrderService,
    private readonly staff: StaffService,
  ) {}

  @Mutation(() => OrderAssignPayload, {
    description:
      'Gives an order to a member of staff to see through, or, without staffMemberId, to no one ' +
      '(ORD-10); staff find theirs with `assignee:me`. Owners, managers and apps give orders to ' +
      'anyone, and take them from whoever has them; other staff take an order no one has for ' +
      'themselves, and give back their own. Whoever is given one by someone else is told on ' +
      'WhatsApp (ADR-191).',
  })
  @RequireScopes('write_orders')
  async orderAssign(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('staffMemberId', {
      type: () => ID,
      nullable: true,
      description: 'Their account: usr_…',
    })
    staffMemberId?: string | null,
  ): Promise<OrderAssignPayload> {
    const orderId = tryFromPublicId(id, 'order');
    if (!orderId) throw badUserInput(`Invalid order id: ${id.slice(0, 64)}`);
    const assignee = await this.#assignee(tenant, staffMemberId);
    if (assignee === NOT_STAFF) {
      return Object.assign(new OrderAssignPayload(), { order: null, userErrors: notStaff() });
    }
    const result = await this.orders.assign(tenant, orderId, assignee, {
      fromOthers: mayReassign(tenant),
    });
    return Object.assign(new OrderAssignPayload(), {
      order: result.ok ? toOrder(result.value, tenant) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => OrderBulkPayload, {
    description:
      'Gives up to 250 orders to a member of staff, or, without staffMemberId, to no one, as ' +
      'orderAssign does each (ADR-634). Whoever is given them by someone else is told once, of ' +
      'them all.',
  })
  @RequireScopes('write_orders')
  async orderBulkAssign(
    @CurrentTenant() tenant: TenantContext,
    @Args('ids', { type: () => [ID] }) ids: string[],
    @Args('staffMemberId', {
      type: () => ID,
      nullable: true,
      description: 'Their account: usr_…',
    })
    staffMemberId?: string | null,
  ): Promise<OrderBulkPayload> {
    const orderIds = ids.map((id) => {
      const orderId = tryFromPublicId(id, 'order');
      if (!orderId) throw badUserInput(`Invalid order id: ${id.slice(0, 64)}`);
      return orderId;
    });
    const assignee = await this.#assignee(tenant, staffMemberId);
    if (assignee === NOT_STAFF) {
      return Object.assign(new OrderBulkPayload(), { orders: [], userErrors: notStaff() });
    }
    const result = await this.orders.bulkAssign(tenant, orderIds, assignee, {
      fromOthers: mayReassign(tenant),
    });
    return Object.assign(new OrderBulkPayload(), {
      orders: result.ok ? result.value.orders.map((order) => toOrder(order, tenant)) : [],
      userErrors: UserError.list(result.ok ? result.value.errors : result.errors),
    });
  }

  /**
   * Whom `staffMemberId` names, from the shop's staff; null for no one. Staff who may not give
   * orders to others name only themselves.
   */
  async #assignee(
    tenant: TenantContext,
    staffMemberId: string | null | undefined,
  ): Promise<{ staffMemberId: string; name: string } | null | typeof NOT_STAFF> {
    if (!staffMemberId) return null;
    const userId = tryFromPublicId(staffMemberId, 'user');
    if (!mayReassign(tenant) && userId !== staffMemberOf(tenant)) {
      throw deniedToRole(
        'Access denied. Only owners and managers give orders to others; staff take them for ' +
          'themselves.',
      );
    }
    const member = userId
      ? (await this.staff.staffOf(tenant.shopId)).find((each) => each.userId === userId)
      : undefined;
    return member ? { staffMemberId: member.userId, name: member.name } : NOT_STAFF;
  }

  @Query(() => [OrderAssignee], {
    description:
      "The shop's members of staff by name, A to Z, to give an order to or name in its comments " +
      'as @ and their name (ADR-637): who they are, nothing of how they sign in. For whoever ' +
      "reads orders, as the shop's staff list is not.",
  })
  @RequireScopes('read_orders')
  async staffNames(@CurrentTenant() tenant: TenantContext): Promise<OrderAssignee[]> {
    const staff = await this.staff.staffOf(tenant.shopId);
    return staff
      .map((member) =>
        Object.assign(new OrderAssignee(), {
          id: toPublicId('user', member.userId),
          name: member.name,
        }),
      )
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  @ResolveField(() => OrderAssignee, {
    nullable: true,
    description:
      'The member of staff it is given to, to see it through; null while no one has it, and ' +
      'once they leave the shop.',
  })
  async assignee(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() order: Order,
  ): Promise<OrderAssignee | null> {
    if (!order.assigneeId) return null;
    // The shop's staff, read once for a page of orders.
    const loader = loaders.get<string, StaffMemberRecord>('identity.staff', async () => {
      const staff = await this.staff.staffOf(tenant.shopId);
      return new Map(staff.map((member) => [member.userId, member]));
    });
    const member = await loader.load(order.assigneeId);
    return member
      ? Object.assign(new OrderAssignee(), {
          id: toPublicId('user', member.userId),
          name: member.name,
        })
      : null;
  }
}

/** No member of the shop's staff. */
const NOT_STAFF = Symbol('not staff');

function notStaff(): UserError[] {
  return UserError.list([
    { field: ['staffMemberId'], code: 'NOT_FOUND', message: 'Staff member not found' },
  ]);
}

/**
 * Owners, managers, custom roles of theirs that keep it (ADR-578) and apps give orders to anyone,
 * and take them from whoever has them.
 */
function mayReassign(tenant: TenantContext): boolean {
  const { actor } = tenant;
  return actor.kind === 'app' || hasCapability(actor, 'assign_orders');
}

function staffMemberOf(tenant: TenantContext): string | null {
  return tenant.actor.kind === 'staff' ? tenant.actor.userId : null;
}
