import {
  CurrentTenant,
  RequireScopes,
  UserError,
  failOne,
  type FieldError,
  type TenantContext,
} from '@hatti/api';
import { tryFromPublicId } from '@hatti/ids';
import {
  CONVERSATION_WINDOW_MS,
  Conversation,
  ConversationsService,
  toConversation,
} from '@hatti/messaging/public';
import { DraftOrderService } from '@hatti/orders/public';
import { Args, Field, ID, Int, Mutation, ObjectType, Resolver } from '@nestjs/graphql';

@ObjectType()
export class ConversationDraftLinkSendPayload {
  @Field(() => Conversation, {
    nullable: true,
    description: 'The conversation after: its last message is the one carrying the link.',
  })
  conversation!: Conversation | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

/**
 * An order from a conversation (MSG-08, ADR-765): a draft's link, where the customer adds their
 * address and confirms, sent as an answer in the conversation they wrote, from the number they
 * wrote to. Orders keeps the draft and makes its link; messaging sends it; the core joins them.
 */
@Resolver(() => Conversation)
export class ConversationDraftResolver {
  constructor(
    private readonly inbox: ConversationsService,
    private readonly drafts: DraftOrderService,
  ) {}

  @Mutation(() => ConversationDraftLinkSendPayload, {
    description:
      "Sends a draft order's link in a conversation, where the customer adds or corrects their " +
      'address and confirms it (MSG-08): only within a day of their last message, as WhatsApp ' +
      'allows. A new link replaces the one before, as `draftOrderLinkCreate` does.',
  })
  @RequireScopes('write_conversations', 'write_orders')
  async conversationDraftLinkSend(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID, description: 'The conversation.' }) id: string,
    @Args('draftOrderId', { type: () => ID }) draftOrderId: string,
    @Args('expiresInHours', {
      type: () => Int,
      nullable: true,
      description: 'How long the link works: 1 to 720 hours; default 72.',
    })
    expiresInHours?: number | null,
  ): Promise<ConversationDraftLinkSendPayload> {
    const refused = (errors: FieldError[]) =>
      Object.assign(new ConversationDraftLinkSendPayload(), {
        conversation: null,
        userErrors: UserError.list(errors),
      });
    const conversationId = tryFromPublicId(id, 'conversation');
    const found = conversationId ? await this.inbox.get(tenant, conversationId) : null;
    if (!conversationId || !found) {
      return refused([{ field: ['id'], code: 'NOT_FOUND', message: 'No such conversation' }]);
    }
    // Checked before the link is made, so that a link sent before is not replaced for nothing.
    const now = Date.now();
    if (!found.lastInboundAt || now - found.lastInboundAt.getTime() >= CONVERSATION_WINDOW_MS) {
      return refused([
        {
          field: ['id'],
          code: 'WINDOW_CLOSED',
          message: 'WhatsApp lets a shop answer only within a day of the customer’s last message',
        },
      ]);
    }
    const draftId = tryFromPublicId(draftOrderId, 'draftOrder');
    const link = draftId
      ? await this.drafts.createLink(tenant, draftId, { expiresInHours })
      : failOne<never>(['draftOrderId'], 'NOT_FOUND', 'No such draft order');
    if (!link.ok) {
      return refused(
        link.errors.map((error) =>
          error.field[0] === 'id' ? { ...error, field: ['draftOrderId'] } : error,
        ),
      );
    }
    const sent = await this.inbox.reply(tenant, conversationId, link.value.message);
    return sent.ok
      ? Object.assign(new ConversationDraftLinkSendPayload(), {
          conversation: toConversation(tenant, sent.value.conversation),
          userErrors: [],
        })
      : refused(sent.errors);
  }
}
