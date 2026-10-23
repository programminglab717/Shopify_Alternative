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
import { Conversation, ConversationsService, toConversation } from '@hatti/messaging/public';
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
    'The member of staff a conversation is given to, to answer (MSG-06): who they are, not how ' +
    'they sign in.',
})
export class ConversationAssignee {
  @Field(() => ID, { description: 'Their account: usr_…' })
  id!: string;

  @Field()
  name!: string;
}

@ObjectType()
export class ConversationAssignPayload {
  @Field(() => Conversation, { nullable: true })
  conversation!: Conversation | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

/**
 * Conversations given to members of staff to answer (MSG-06, ADR-759). Messaging keeps whom a
 * conversation is given to; the core checks that they work in the shop, and says who they are,
 * as it does for orders (ADR-127).
 */
@Resolver(() => Conversation)
export class ConversationAssignmentResolver {
  constructor(
    private readonly inbox: ConversationsService,
    private readonly staff: StaffService,
  ) {}

  @Mutation(() => ConversationAssignPayload, {
    description:
      'Gives a conversation to a member of staff to answer, or, without staffMemberId, to no ' +
      'one (MSG-06); staff find theirs with `assignedToMe`. Those who give orders to others ' +
      '(owners, managers and apps) give conversations to anyone, and take them from whoever ' +
      'has them; other staff take one no one has for themselves, and give back their own.',
  })
  @RequireScopes('write_conversations')
  async conversationAssign(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('staffMemberId', {
      type: () => ID,
      nullable: true,
      description: 'Their account: usr_…',
    })
    staffMemberId?: string | null,
  ): Promise<ConversationAssignPayload> {
    const conversationId = tryFromPublicId(id, 'conversation');
    if (!conversationId) throw badUserInput(`Invalid conversation id: ${id.slice(0, 64)}`);
    const fromOthers = mayReassign(tenant);
    let assigneeId: string | null = null;
    if (staffMemberId) {
      const userId = tryFromPublicId(staffMemberId, 'user');
      const self = tenant.actor.kind === 'staff' ? tenant.actor.userId : null;
      if (!fromOthers && userId !== self) {
        throw deniedToRole(
          'Access denied. Only owners and managers give conversations to others; staff take ' +
            'them for themselves.',
        );
      }
      const member = userId
        ? (await this.staff.staffOf(tenant.shopId)).find((each) => each.userId === userId)
        : undefined;
      if (!member) {
        return Object.assign(new ConversationAssignPayload(), {
          conversation: null,
          userErrors: UserError.list([
            { field: ['staffMemberId'], code: 'NOT_FOUND', message: 'Staff member not found' },
          ]),
        });
      }
      assigneeId = member.userId;
    }
    const result = await this.inbox.assign(tenant, conversationId, assigneeId, { fromOthers });
    return Object.assign(new ConversationAssignPayload(), {
      conversation: result.ok ? toConversation(tenant, result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @ResolveField(() => ConversationAssignee, {
    nullable: true,
    description:
      'The member of staff it is given to, to answer; null while no one has it, and once they ' +
      'leave the shop.',
  })
  async assignee(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() conversation: Conversation,
  ): Promise<ConversationAssignee | null> {
    if (!conversation.assigneeId) return null;
    // The shop's staff, read once for a page of conversations.
    const loader = loaders.get<string, StaffMemberRecord>('identity.staff', async () => {
      const staff = await this.staff.staffOf(tenant.shopId);
      return new Map(staff.map((member) => [member.userId, member]));
    });
    const member = await loader.load(conversation.assigneeId);
    return member
      ? Object.assign(new ConversationAssignee(), {
          id: toPublicId('user', member.userId),
          name: member.name,
        })
      : null;
  }
}

/** Those who give orders to others (ADR-578) give conversations too; apps give them to anyone. */
function mayReassign(tenant: TenantContext): boolean {
  const { actor } = tenant;
  return actor.kind === 'app' || hasCapability(actor, 'assign_orders');
}
