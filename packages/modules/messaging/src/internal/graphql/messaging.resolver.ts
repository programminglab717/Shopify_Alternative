import {
  CurrentTenant,
  PageInfo,
  RequireScopes,
  UserError,
  badUserInput,
  decodeTimeCursor,
  encodeCursor,
  pageSize,
  shownPhone,
  type TenantContext,
} from '@hatti/api';
import { isUuid, toPublicId, tryFromPublicId } from '@hatti/ids';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  MessagesService,
  type MessageRecord,
  type MessageStatus as MessageStatusValue,
} from '../messages.service.js';
import {
  MessagingSettingsService,
  type MessageRouting as MessageRoutingValue,
  type MessagingSettingsRecord,
} from '../settings.service.js';
import type { MessageLanguage as MessageLanguageValue } from '../templates.js';
import {
  Message,
  MessageChannel,
  MessageConnection,
  MessageEdge,
  MessageKind,
  MessageLanguage,
  MessageRouting,
  MessagesArgs,
  MessageStatus,
  MessagingSettings,
  MessagingSettingsInput,
  MessagingSettingsUpdatePayload,
} from './messaging.types.js';

@Resolver()
export class MessagingResolver {
  constructor(
    private readonly queue: MessagesService,
    private readonly settings: MessagingSettingsService,
  ) {}

  @Query(() => MessageConnection, {
    description:
      "Messages to the shop's customers about their orders (MSG-01), the latest first, with how " +
      'sending each went.',
  })
  @RequireScopes('read_orders')
  async messages(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: MessagesArgs,
  ): Promise<MessageConnection> {
    let after: { id: string; at: string } | null = null;
    if (args.after) {
      after = decodeTimeCursor(args.after);
      if (!isUuid(after.id)) throw badUserInput('Invalid cursor');
    }
    let orderId: string | null = null;
    if (args.orderId) {
      orderId = tryFromPublicId(args.orderId, 'order');
      if (!orderId) throw badUserInput(`Invalid order id: ${args.orderId.slice(0, 64)}`);
    }
    const { items, hasNextPage } = await this.queue.list(tenant, {
      first: pageSize(args.first),
      after: after && { id: after.id, createdAt: after.at },
      status: args.status ? (args.status.toLowerCase() as MessageStatusValue) : null,
      orderId,
    });
    const edges = items.map((record) =>
      Object.assign(new MessageEdge(), {
        node: toMessage(tenant, record),
        cursor: encodeCursor({ id: record.id, at: record.createdAtExactly }),
      }),
    );
    return Object.assign(new MessageConnection(), {
      edges,
      nodes: edges.map((edge) => edge.node),
      pageInfo: Object.assign(new PageInfo(), {
        hasNextPage,
        endCursor: edges.at(-1)?.cursor ?? null,
      }),
    });
  }

  @Query(() => MessagingSettings, {
    description: "How the shop's customers are told about their orders.",
  })
  @RequireScopes('read_settings')
  async messagingSettings(@CurrentTenant() tenant: TenantContext): Promise<MessagingSettings> {
    return toSettings(await this.settings.get(tenant));
  }

  @Mutation(() => MessagingSettingsUpdatePayload, {
    description:
      "Changes how the shop's customers are told about their orders, from the next message: by " +
      'WhatsApp or SMS, in English or Urdu, and which notifications they get.',
  })
  @RequireScopes('write_settings')
  async messagingSettingsUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: MessagingSettingsInput,
  ): Promise<MessagingSettingsUpdatePayload> {
    const result = await this.settings.update(tenant, {
      routing: input.routing ? (input.routing.toLowerCase() as MessageRoutingValue) : null,
      language: input.language ? (input.language.toLowerCase() as MessageLanguageValue) : null,
      disabled: input.disabledNotifications
        ? input.disabledNotifications.map((kind) => kind.toLowerCase())
        : null,
      alertsPhone: input.alertsPhone,
    });
    return Object.assign(new MessagingSettingsUpdatePayload(), {
      messagingSettings: result.ok ? toSettings(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function toMessage(tenant: TenantContext, record: MessageRecord): Message {
  return Object.assign(new Message(), {
    id: toPublicId('message', record.id),
    kind: record.kind.toUpperCase() as MessageKind,
    channel: record.channel.toUpperCase() as MessageChannel,
    recipient: shownPhone(tenant, record.recipient),
    language: record.language.toUpperCase() as MessageLanguage,
    status: record.status.toUpperCase() as MessageStatus,
    attempts: record.attempts,
    orderId: record.orderId && toPublicId('order', record.orderId),
    error: record.error,
    replacesId: record.replacesId && toPublicId('message', record.replacesId),
    sentAt: record.sentAt,
    deliveredAt: record.deliveredAt,
    readAt: record.readAt,
    createdAt: record.createdAt,
  });
}

function toSettings(record: MessagingSettingsRecord): MessagingSettings {
  return Object.assign(new MessagingSettings(), {
    routing: record.routing.toUpperCase() as MessageRouting,
    language: record.language.toUpperCase() as MessageLanguage,
    disabledNotifications: record.disabled.map((kind) => kind.toUpperCase() as MessageKind),
    alertsPhone: record.alertsPhone,
    updatedAt: record.updatedAt,
  });
}
