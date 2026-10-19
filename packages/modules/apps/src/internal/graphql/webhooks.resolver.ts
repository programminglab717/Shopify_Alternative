import {
  CurrentTenant,
  UserError,
  deniedToRole,
  failOne,
  hasCapability,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  WebhookService,
  type WebhookDeliveryRecord,
  type WebhookSubscriptionRecord,
} from '../webhooks.service.js';
import {
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookSubscription,
  WebhookSubscriptionDeletePayload,
  WebhookSubscriptionInput,
  WebhookSubscriptionPayload,
  WebhookSubscriptionTopic,
  topicEnumOf,
  topicOf,
} from './webhooks.types.js';

/**
 * Whose subscriptions the caller manages: an app its own alone; the owner and managers any app's,
 * and custom roles of managers' that keep it (ADR-578). Other staff none.
 */
function ownApp(tenant: TenantContext): string | null {
  switch (tenant.actor.kind) {
    case 'app':
      return tenant.actor.tokenId;
    case 'staff':
      if (hasCapability(tenant.actor, 'manage_apps')) return null;
      throw deniedToRole("Access denied. Only the owner and managers manage apps' webhooks.");
    default:
      throw deniedToRole("Access denied. Apps' webhooks are managed by apps and the shop.");
  }
}

const NOT_FOUND = 'No webhook subscription of the shop has this ID';

@Resolver()
export class WebhookResolver {
  constructor(private readonly service: WebhookService) {}

  @Query(() => [WebhookSubscription], {
    description:
      "The calling app's webhook subscriptions; for the owner and managers, every app's, by " +
      'app and topic (DEV-03, ADR-397).',
  })
  async webhookSubscriptions(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<WebhookSubscription[]> {
    return (await this.service.list(tenant, ownApp(tenant))).map(toSubscription);
  }

  @Query(() => [WebhookDelivery], {
    description:
      "A webhook subscription's deliveries of the last 30 days, the latest first, `first` of " +
      'them (20 unless given, 100 at most).',
  })
  async webhookDeliveries(
    @CurrentTenant() tenant: TenantContext,
    @Args('subscriptionId', { type: () => ID }) subscriptionId: string,
    @Args('first', { type: () => Int, nullable: true }) first?: number | null,
  ): Promise<WebhookDelivery[]> {
    const own = ownApp(tenant);
    const id = tryFromPublicId(subscriptionId, 'webhookSubscription');
    const records = id ? await this.service.deliveries(tenant, id, own, first ?? 20) : null;
    return (records ?? []).map(toDelivery);
  }

  @Mutation(() => WebhookSubscriptionPayload, {
    description:
      'Subscribes an app to a topic at an https address: the calling app, or for the owner and ' +
      'managers the app `appId` names. The app must be able to read what the topic tells of.',
  })
  async webhookSubscriptionCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('topic', { type: () => WebhookSubscriptionTopic }) topic: WebhookSubscriptionTopic,
    @Args('webhookSubscription') input: WebhookSubscriptionInput,
    @Args('appId', { type: () => ID, nullable: true }) appId?: string | null,
  ): Promise<WebhookSubscriptionPayload> {
    const own = ownApp(tenant);
    let result: MutationResult<WebhookSubscriptionRecord>;
    if (own) {
      result = await this.service.create(tenant, own, {
        topic: topicOf(topic),
        uri: input.callbackUrl,
      });
    } else {
      const forApp = appId ? tryFromPublicId(appId, 'accessToken') : null;
      result = forApp
        ? await this.service.create(tenant, forApp, {
            topic: topicOf(topic),
            uri: input.callbackUrl,
          })
        : failOne(['appId'], appId ? 'NOT_FOUND' : 'BLANK', 'Name the app to subscribe');
    }
    return payload(result);
  }

  @Mutation(() => WebhookSubscriptionPayload, {
    description: "Posts a subscription's topic to another https address, from its next on.",
  })
  async webhookSubscriptionUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('webhookSubscription') input: WebhookSubscriptionInput,
  ): Promise<WebhookSubscriptionPayload> {
    const own = ownApp(tenant);
    const subscriptionId = tryFromPublicId(id, 'webhookSubscription');
    return payload(
      subscriptionId
        ? await this.service.update(tenant, subscriptionId, own, { uri: input.callbackUrl })
        : failOne(['id'], 'NOT_FOUND', NOT_FOUND),
    );
  }

  @Mutation(() => WebhookSubscriptionDeletePayload, {
    description: 'Ends a webhook subscription: what it has not yet posted, it does not.',
  })
  async webhookSubscriptionDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<WebhookSubscriptionDeletePayload> {
    const own = ownApp(tenant);
    const subscriptionId = tryFromPublicId(id, 'webhookSubscription');
    const result = subscriptionId
      ? await this.service.delete(tenant, subscriptionId, own)
      : failOne<WebhookSubscriptionRecord>(['id'], 'NOT_FOUND', NOT_FOUND);
    return Object.assign(new WebhookSubscriptionDeletePayload(), {
      deletedWebhookSubscriptionId: result.ok
        ? toPublicId('webhookSubscription', result.value.id)
        : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function payload(result: MutationResult<WebhookSubscriptionRecord>): WebhookSubscriptionPayload {
  return Object.assign(new WebhookSubscriptionPayload(), {
    webhookSubscription: result.ok ? toSubscription(result.value) : null,
    userErrors: result.ok ? [] : UserError.list(result.errors),
  });
}

export function toSubscription(record: WebhookSubscriptionRecord): WebhookSubscription {
  return Object.assign(new WebhookSubscription(), {
    id: toPublicId('webhookSubscription', record.id),
    topic: topicEnumOf(record.topic),
    callbackUrl: record.uri,
    appId: toPublicId('accessToken', record.appId),
    appName: record.appName,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastDelivery: record.lastDelivery && toDelivery(record.lastDelivery),
  });
}

function toDelivery(record: WebhookDeliveryRecord): WebhookDelivery {
  return Object.assign(new WebhookDelivery(), {
    ...record,
    id: toPublicId('webhookDelivery', record.id),
    status: record.status.toUpperCase() as WebhookDeliveryStatus,
  });
}
