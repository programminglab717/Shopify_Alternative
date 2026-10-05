import {
  CurrentTenant,
  Loaders,
  RequestLoaders,
  RequireScopes,
  UserError,
  badUserInput,
  deniedToRole,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { StaffService, type StaffMemberRecord } from '@hatti/identity/public';
import { Order, OrderService, toOrder } from '@hatti/orders/public';
import {
  Args,
  Field,
  ID,
  Mutation,
  ObjectType,
  Parent,
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
    const reassigning = mayReassign(tenant);
    let assignee: { staffMemberId: string; name: string } | null = null;
    if (staffMemberId) {
      const userId = tryFromPublicId(staffMemberId, 'user');
      if (!reassigning && userId !== staffMemberOf(tenant)) {
        throw deniedToRole(
          'Access denied. Only owners and managers give orders to others; staff take them for ' +
            'themselves.',
        );
      }
      const member = userId
        ? (await this.staff.staffOf(tenant.shopId)).find((each) => each.userId === userId)
        : undefined;
      if (!member) {
        return Object.assign(new OrderAssignPayload(), {
          order: null,
          userErrors: UserError.list([
            { field: ['staffMemberId'], code: 'NOT_FOUND', message: 'Staff member not found' },
          ]),
        });
      }
      assignee = { staffMemberId: member.userId, name: member.name };
    }
    const result = await this.orders.assign(tenant, orderId, assignee, {
      fromOthers: reassigning,
    });
    return Object.assign(new OrderAssignPayload(), {
      order: result.ok ? toOrder(result.value, tenant) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
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

/** Owners, managers and apps give orders to anyone, and take them from whoever has them. */
function mayReassign(tenant: TenantContext): boolean {
  const { actor } = tenant;
  return (
    actor.kind === 'app' ||
    (actor.kind === 'staff' && (actor.role === 'owner' || actor.role === 'manager'))
  );
}

function staffMemberOf(tenant: TenantContext): string | null {
  return tenant.actor.kind === 'staff' ? tenant.actor.userId : null;
}
