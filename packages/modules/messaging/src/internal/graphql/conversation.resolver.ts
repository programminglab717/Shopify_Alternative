import {
  CurrentTenant,
  PageInfo,
  RequireScopes,
  UserError,
  badUserInput,
  decodeTimeCursor,
  encodeCursor,
  failOne,
  pageSize,
  shownPhone,
  type TenantContext,
} from '@hatti/api';
import { isUuid, toPublicId, tryFromPublicId } from '@hatti/ids';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  CONVERSATION_WINDOW_MS,
  ConversationsService,
  type ConversationMessageRecord,
  type ConversationRecord,
} from '../conversations.service.js';
import {
  Conversation,
  ConversationConnection,
  ConversationEdge,
  ConversationMessage,
  ConversationMessageConnection,
  ConversationMessageDirection,
  ConversationMessagesArgs,
  ConversationReplyPayload,
  ConversationReplyStatus,
  ConversationStatus,
  ConversationsArgs,
  ConversationUpdatePayload,
} from './conversation.types.js';

/**
 * The inbox (MSG-05, ADR-545): the shop's conversations with its customers on WhatsApp, their
 * messages, marking them read or closed, and answering them (ADR-546). Numbers are shown as the
 * caller may see them.
 */
@Resolver(() => Conversation)
export class ConversationResolver {
  constructor(private readonly inbox: ConversationsService) {}

  @Query(() => ConversationConnection, {
    description: "The shop's conversations with its customers, the latest written first.",
  })
  @RequireScopes('read_conversations')
  async conversations(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: ConversationsArgs,
  ): Promise<ConversationConnection> {
    let after: { id: string; at: string } | null = null;
    if (args.after) {
      after = decodeTimeCursor(args.after);
      if (!isUuid(after.id)) throw badUserInput('Invalid cursor');
    }
    // An app is no member of staff, and is given none.
    const me = tenant.actor.kind === 'staff' ? tenant.actor.userId : null;
    const { items, hasNextPage } = await (args.assignedToMe && !me
      ? Promise.resolve({ items: [], hasNextPage: false })
      : this.inbox.list(tenant, {
          first: pageSize(args.first),
          after: after && { id: after.id, lastMessageAt: after.at },
          unread: args.unread ?? false,
          status: args.status ? (args.status.toLowerCase() as 'open' | 'closed') : null,
          assigneeId: args.assignedToMe ? me : null,
          unassigned: args.unassigned ?? false,
        }));
    const edges = items.map((record) =>
      Object.assign(new ConversationEdge(), {
        node: toConversation(tenant, record),
        cursor: encodeCursor({ id: record.id, at: record.lastMessageAtExactly }),
      }),
    );
    return Object.assign(new ConversationConnection(), {
      edges,
      nodes: edges.map((edge) => edge.node),
      pageInfo: Object.assign(new PageInfo(), {
        hasNextPage,
        endCursor: edges.at(-1)?.cursor ?? null,
      }),
    });
  }

  @Query(() => Conversation, { nullable: true })
  @RequireScopes('read_conversations')
  async conversation(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<Conversation | null> {
    const uuid = tryFromPublicId(id, 'conversation');
    if (!uuid) return null;
    const record = await this.inbox.get(tenant, uuid);
    return record && toConversation(tenant, record);
  }

  @Query(() => Int, {
    description: "How many of the shop's conversations have messages its staff have not read.",
  })
  @RequireScopes('read_conversations')
  async conversationsUnreadCount(@CurrentTenant() tenant: TenantContext): Promise<number> {
    return this.inbox.unreadCount(tenant);
  }

  @Query(() => ConversationMessageConnection, {
    description: "A conversation's messages, the latest first, a page at a time.",
  })
  @RequireScopes('read_conversations')
  async conversationMessages(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: ConversationMessagesArgs,
  ): Promise<ConversationMessageConnection> {
    const conversationId = tryFromPublicId(args.conversationId, 'conversation');
    if (!conversationId) {
      throw badUserInput(`Invalid conversation id: ${args.conversationId.slice(0, 64)}`);
    }
    let before: string | null = null;
    if (args.before) {
      before = tryFromPublicId(args.before, 'conversationMessage');
      if (!before) throw badUserInput(`Invalid message id: ${args.before.slice(0, 64)}`);
    }
    const { items, hasNextPage } = await this.inbox.messages(tenant, conversationId, {
      first: pageSize(args.first),
      before,
    });
    const nodes = items.map(toMessage);
    return Object.assign(new ConversationMessageConnection(), {
      nodes,
      pageInfo: Object.assign(new PageInfo(), {
        hasNextPage,
        endCursor: nodes.at(-1)?.id ?? null,
      }),
    });
  }

  @Mutation(() => ConversationUpdatePayload, {
    description: "Marks the conversation's messages read by the shop's staff.",
  })
  @RequireScopes('write_conversations')
  async conversationMarkRead(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<ConversationUpdatePayload> {
    const uuid = tryFromPublicId(id, 'conversation');
    return payload(tenant, uuid ? await this.inbox.markRead(tenant, uuid) : null);
  }

  @Mutation(() => ConversationUpdatePayload, {
    description:
      'Closes the conversation, read, or opens it again. The customer writing opens it again.',
  })
  @RequireScopes('write_conversations')
  async conversationUpdateStatus(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('status', { type: () => ConversationStatus }) status: ConversationStatus,
  ): Promise<ConversationUpdatePayload> {
    const uuid = tryFromPublicId(id, 'conversation');
    return payload(
      tenant,
      uuid
        ? await this.inbox.setStatus(tenant, uuid, status.toLowerCase() as 'open' | 'closed')
        : null,
    );
  }

  @Mutation(() => ConversationReplyPayload, {
    description:
      "Answers the customer on WhatsApp in the shop's own words, from the number they wrote to: " +
      'only within a day of their last message, as WhatsApp allows. Marks the conversation read.',
  })
  @RequireScopes('write_conversations')
  async conversationReply(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('body') body: string,
  ): Promise<ConversationReplyPayload> {
    const uuid = tryFromPublicId(id, 'conversation');
    const result = uuid
      ? await this.inbox.reply(tenant, uuid, body)
      : failOne<never>(['id'], 'NOT_FOUND', 'No such conversation');
    return Object.assign(new ConversationReplyPayload(), {
      conversation: result.ok ? toConversation(tenant, result.value.conversation) : null,
      message: result.ok ? toMessage(result.value.message) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function payload(
  tenant: TenantContext,
  record: ConversationRecord | null,
): ConversationUpdatePayload {
  return Object.assign(new ConversationUpdatePayload(), {
    conversation: record && toConversation(tenant, record),
    userErrors: record
      ? []
      : UserError.list([{ field: ['id'], code: 'NOT_FOUND', message: 'No such conversation' }]),
  });
}

export function toConversation(tenant: TenantContext, record: ConversationRecord): Conversation {
  return Object.assign(new Conversation(), {
    id: toPublicId('conversation', record.id),
    customerPhone: shownPhone(tenant, record.customerPhone),
    viaOwnNumber: record.viaOwnNumber,
    status: record.status.toUpperCase() as ConversationStatus,
    unread: record.unread,
    lastMessageAt: record.lastMessageAt,
    lastInboundAt: record.lastInboundAt,
    replyableUntil:
      record.lastInboundAt && new Date(record.lastInboundAt.getTime() + CONVERSATION_WINDOW_MS),
    lastMessage: record.lastMessage && toMessage(record.lastMessage),
    createdAt: record.createdAt,
    assigneeId: record.assigneeId,
  });
}

function toMessage(record: ConversationMessageRecord): ConversationMessage {
  return Object.assign(new ConversationMessage(), {
    id: toPublicId('conversationMessage', record.id),
    direction: record.direction.toUpperCase() as ConversationMessageDirection,
    body: record.body,
    mediaKind: record.mediaKind,
    at: record.at,
    status: record.status && (record.status.toUpperCase() as ConversationReplyStatus),
    error: record.error,
  });
}
