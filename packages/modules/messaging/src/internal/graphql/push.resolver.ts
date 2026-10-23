import { CurrentTenant, UserError, type TenantContext } from '@hatti/api';
import {
  Args,
  Field,
  GraphQLISODateTime,
  InputType,
  Mutation,
  ObjectType,
  Query,
  Resolver,
  registerEnumType,
} from '@nestjs/graphql';
import { PushService, type PushKind, type PushSubscriptionRecord } from '../push.service.js';

export enum PushNotificationKind {
  NEW_ORDER = 'NEW_ORDER',
  NEEDS_REVIEW = 'NEEDS_REVIEW',
  CASH_REMITTED = 'CASH_REMITTED',
  LOW_STOCK = 'LOW_STOCK',
  CONTACT_MESSAGE = 'CONTACT_MESSAGE',
  COMMENT_PENDING = 'COMMENT_PENDING',
  ORDERS_OVERDUE = 'ORDERS_OVERDUE',
  CUSTOMER_REFUSED = 'CUSTOMER_REFUSED',
  ORDER_ASSIGNED = 'ORDER_ASSIGNED',
  ORDER_MENTIONED = 'ORDER_MENTIONED',
  CONVERSATION_MESSAGE = 'CONVERSATION_MESSAGE',
  CONVERSATION_ASSIGNED = 'CONVERSATION_ASSIGNED',
  CONVERSATION_OVERDUE = 'CONVERSATION_OVERDUE',
}

registerEnumType(PushNotificationKind, {
  name: 'PushNotificationKind',
  description:
    'News pushed to staff: a NEW_ORDER, an order that NEEDS_REVIEW for its risk, CASH_REMITTED ' +
    'by a courier, LOW_STOCK, a CONTACT_MESSAGE through the online store, or a comment on an ' +
    "article that waits for the shop's approval, COMMENT_PENDING, or orders waiting for their " +
    "first call longer than the shop's target, ORDERS_OVERDUE, or a customer who refused a " +
    'parcel while another of their orders waits to ship, CUSTOMER_REFUSED. Each goes to the ' +
    'roles whose work it is: orders and contact messages to owners, managers and confirmation ' +
    'agents; cash ' +
    'to owners, managers and accountants; stock to owners and managers; comments to owners, ' +
    "managers and marketers. And a member's own: an order given to them, ORDER_ASSIGNED, or " +
    'a comment on an order naming them, ORDER_MENTIONED, whatever their role. And, to those ' +
    'who answer customers, a customer who began waiting on WhatsApp, CONVERSATION_MESSAGE, ' +
    'to whom the conversation is given if anyone; and a conversation given to them by ' +
    'another, CONVERSATION_ASSIGNED (ADR-761); and a customer who has waited past the ' +
    "shop's time to answer, CONVERSATION_OVERDUE (ADR-762).",
});

@ObjectType({
  description: "A browser of the signed-in member of staff's, told of the shop's news.",
})
export class PushSubscription {
  @Field({ description: "The browser's push service address it subscribed with." })
  endpoint!: string;

  @Field(() => [PushNotificationKind])
  kinds!: PushNotificationKind[];

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

@ObjectType({ description: 'Push notifications for staff (APP-03, ADR-506).' })
export class PushNotifications {
  @Field(() => String, {
    nullable: true,
    description:
      "Hatti's VAPID public key, base64url, which browsers subscribe with " +
      '(applicationServerKey); null where Hatti pushes nothing yet.',
  })
  publicKey!: string | null;

  @Field(() => PushSubscription, {
    nullable: true,
    description: 'The subscription of the browser asked about, if it is this member of staff’s.',
  })
  subscription!: PushSubscription | null;
}

@InputType()
export class PushSubscribeInput {
  @Field({ description: 'PushSubscription.endpoint, as the browser gave it.' })
  endpoint!: string;

  @Field({ description: "The subscription's p256dh key, base64url." })
  p256dh!: string;

  @Field({ description: "The subscription's auth secret, base64url." })
  auth!: string;

  @Field(() => [PushNotificationKind], { description: 'The news this browser is told of.' })
  kinds!: PushNotificationKind[];
}

@ObjectType()
export class PushSubscribePayload {
  @Field(() => PushSubscription, { nullable: true })
  subscription!: PushSubscription | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class PushUnsubscribePayload {
  @Field({ description: 'Whether the browser was subscribed.' })
  unsubscribed!: boolean;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

/**
 * Each member of staff's own browsers, told of the shop's news: no scope is asked, since a
 * subscription is theirs and pushes go by role.
 */
@Resolver(() => PushNotifications)
export class PushResolver {
  constructor(private readonly service: PushService) {}

  @Query(() => PushNotifications, {
    description:
      'Whether Hatti pushes news to staff, its key, and the subscription of the browser at ' +
      '`endpoint`, if one is given.',
  })
  async pushNotifications(
    @CurrentTenant() tenant: TenantContext,
    @Args('endpoint', { type: () => String, nullable: true }) endpoint: string | null,
  ): Promise<PushNotifications> {
    const subscription = endpoint ? await this.service.subscriptionOf(tenant, endpoint) : null;
    return Object.assign(new PushNotifications(), {
      publicKey: this.service.publicKey,
      subscription: subscription && toSubscription(subscription),
    });
  }

  @Mutation(() => PushSubscribePayload, {
    description:
      "Turns the shop's news on in a browser of the signed-in member of staff, for the kinds " +
      'given, or changes them: the PushSubscription its push service gave. A browser someone ' +
      'else signed in on before is theirs no more.',
  })
  async pushSubscribe(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: PushSubscribeInput,
  ): Promise<PushSubscribePayload> {
    const result = await this.service.subscribe(tenant, {
      ...input,
      kinds: input.kinds.map((kind) => kind.toLowerCase()),
    });
    return Object.assign(new PushSubscribePayload(), {
      subscription: result.ok ? toSubscription(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => PushUnsubscribePayload, {
    description: "Turns the shop's news off in the signed-in member of staff's browser.",
  })
  async pushUnsubscribe(
    @CurrentTenant() tenant: TenantContext,
    @Args('endpoint') endpoint: string,
  ): Promise<PushUnsubscribePayload> {
    return Object.assign(new PushUnsubscribePayload(), {
      unsubscribed: await this.service.unsubscribe(tenant, endpoint),
      userErrors: [],
    });
  }
}

function toSubscription(record: PushSubscriptionRecord): PushSubscription {
  return Object.assign(new PushSubscription(), {
    endpoint: record.endpoint,
    kinds: record.kinds.map((kind: PushKind) => kind.toUpperCase() as PushNotificationKind),
    createdAt: record.createdAt,
  });
}
