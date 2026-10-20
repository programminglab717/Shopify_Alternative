import {
  CurrentTenant,
  PageInfo,
  RequireScopes,
  UserError,
  badUserInput,
  pageSize,
  shownPhone,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ContactMessagesService, type ContactMessageRecord } from '../contact-messages.service.js';
import {
  ContactMessage,
  ContactMessageConnection,
  ContactMessageDeletePayload,
  ContactMessageField,
  ContactMessagesArgs,
  ContactMessageUpdatePayload,
} from './contact-message.types.js';

const NOT_FOUND = [{ field: ['id'], code: 'NOT_FOUND' as const, message: 'No such message' }];

/**
 * Messages through the online store's contact form (OS-08, ADR-589), beside the inbox and under
 * its scopes: listed the latest first, marked read or unread, and deleted. Numbers are shown as
 * the caller may see them.
 */
@Resolver(() => ContactMessage)
export class ContactMessageResolver {
  constructor(private readonly messages: ContactMessagesService) {}

  @Query(() => ContactMessageConnection, {
    description: "What shoppers wrote through the online store's contact form, the latest first.",
  })
  @RequireScopes('read_conversations')
  async contactMessages(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: ContactMessagesArgs,
  ): Promise<ContactMessageConnection> {
    let after: string | null = null;
    if (args.after) {
      after = tryFromPublicId(args.after, 'contactMessage');
      if (!after) throw badUserInput('Invalid cursor');
    }
    const { items, hasNextPage } = await this.messages.list(tenant, {
      first: pageSize(args.first),
      after,
      unread: args.unread ?? false,
    });
    const nodes = items.map((record) => toContactMessage(tenant, record));
    return Object.assign(new ContactMessageConnection(), {
      nodes,
      pageInfo: Object.assign(new PageInfo(), {
        hasNextPage,
        endCursor: nodes.at(-1)?.id ?? null,
      }),
    });
  }

  @Query(() => ContactMessage, { nullable: true })
  @RequireScopes('read_conversations')
  async contactMessage(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<ContactMessage | null> {
    const uuid = tryFromPublicId(id, 'contactMessage');
    const record = uuid && (await this.messages.get(tenant, uuid));
    return record ? toContactMessage(tenant, record) : null;
  }

  @Query(() => Int, {
    description: "How many of the contact form's messages the shop's staff have not read.",
  })
  @RequireScopes('read_conversations')
  async contactMessagesUnreadCount(@CurrentTenant() tenant: TenantContext): Promise<number> {
    return this.messages.unreadCount(tenant);
  }

  @Mutation(() => ContactMessageUpdatePayload, {
    description:
      "Marks the message read by the shop's staff, or, with `read: false`, unread again.",
  })
  @RequireScopes('write_conversations')
  async contactMessageMarkRead(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('read', { type: () => Boolean, nullable: true, defaultValue: true }) read: boolean,
  ): Promise<ContactMessageUpdatePayload> {
    const uuid = tryFromPublicId(id, 'contactMessage');
    const record = uuid && (await this.messages.markRead(tenant, uuid, read));
    return Object.assign(new ContactMessageUpdatePayload(), {
      contactMessage: record ? toContactMessage(tenant, record) : null,
      userErrors: record ? [] : UserError.list(NOT_FOUND),
    });
  }

  @Mutation(() => ContactMessageDeletePayload, { description: 'Deletes the message for good.' })
  @RequireScopes('write_conversations')
  async contactMessageDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<ContactMessageDeletePayload> {
    const uuid = tryFromPublicId(id, 'contactMessage');
    const deleted = uuid !== null && (await this.messages.delete(tenant, uuid));
    return Object.assign(new ContactMessageDeletePayload(), {
      deletedContactMessageId: deleted ? id : null,
      userErrors: deleted ? [] : UserError.list(NOT_FOUND),
    });
  }
}

function toContactMessage(tenant: TenantContext, record: ContactMessageRecord): ContactMessage {
  return Object.assign(new ContactMessage(), {
    id: toPublicId('contactMessage', record.id),
    name: record.name,
    email: record.email,
    phone: record.phone && shownPhone(tenant, record.phone),
    body: record.body,
    fields: Object.entries(record.fields).map(([name, value]) =>
      Object.assign(new ContactMessageField(), { name, value }),
    ),
    page: record.page,
    language: record.language,
    receivedAt: record.receivedAt,
    readAt: record.readAt,
  });
}
