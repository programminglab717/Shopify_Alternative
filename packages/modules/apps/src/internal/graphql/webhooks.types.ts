import { UserError } from '@hatti/api';
import {
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';

/** The topics, as Shopify's WebhookSubscriptionTopic names them. */
export enum WebhookSubscriptionTopic {
  ORDERS_CREATE = 'ORDERS_CREATE',
  ORDERS_UPDATED = 'ORDERS_UPDATED',
  ORDERS_CANCELLED = 'ORDERS_CANCELLED',
  ORDERS_PAID = 'ORDERS_PAID',
  FULFILLMENTS_CREATE = 'FULFILLMENTS_CREATE',
  FULFILLMENTS_UPDATE = 'FULFILLMENTS_UPDATE',
  PRODUCTS_CREATE = 'PRODUCTS_CREATE',
  PRODUCTS_UPDATE = 'PRODUCTS_UPDATE',
  PRODUCTS_DELETE = 'PRODUCTS_DELETE',
  INVENTORY_LEVELS_UPDATE = 'INVENTORY_LEVELS_UPDATE',
  CUSTOMERS_CREATE = 'CUSTOMERS_CREATE',
  CUSTOMERS_UPDATE = 'CUSTOMERS_UPDATE',
  APP_UNINSTALLED = 'APP_UNINSTALLED',
}

registerEnumType(WebhookSubscriptionTopic, {
  name: 'WebhookSubscriptionTopic',
  description:
    'What an app is told of (DEV-03, ADR-397): ORDERS_CREATE is "orders/create", as its ' +
    'X-Hatti-Topic header says. Orders, fulfillments and refunds need read_orders; products ' +
    'read_products; stock levels read_inventory; customers read_customers. APP_UNINSTALLED tells ' +
    'an app it was removed.',
});

/** "orders/create" as the API names it, and back. */
export function topicEnumOf(topic: string): WebhookSubscriptionTopic {
  return topic.replace('/', '_').toUpperCase() as WebhookSubscriptionTopic;
}

export function topicOf(value: WebhookSubscriptionTopic): string {
  const [first, ...rest] = value.toLowerCase().split('_');
  // Every topic's resource is one word, or "inventory_levels".
  return first === 'inventory'
    ? `inventory_levels/${rest.slice(1).join('_')}`
    : `${first}/${rest.join('_')}`;
}

@ObjectType({
  description:
    "An app's subscription to a topic (DEV-03, ADR-397): each event of it is posted to its " +
    'address as JSON, signed in X-Hatti-Hmac-Sha256 with the HMAC-SHA256 of the body by the ' +
    "app's secret, in base64; tried again for two days until the app answers 2xx within five " +
    'seconds. The body names the resource by its ID, to fetch through the Admin API.',
})
export class WebhookSubscription {
  @Field(() => ID)
  id!: string;

  @Field(() => WebhookSubscriptionTopic)
  topic!: WebhookSubscriptionTopic;

  @Field({ description: 'Where it is posted: an https address.' })
  callbackUrl!: string;

  @Field(() => ID, { description: 'The app it is for.' })
  appId!: string;

  @Field()
  appName!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class WebhookSubscriptionInput {
  @Field({ description: 'An https address on the public internet, up to 2,000 characters.' })
  callbackUrl!: string;
}

@ObjectType()
export class WebhookSubscriptionPayload {
  @Field(() => WebhookSubscription, { nullable: true })
  webhookSubscription!: WebhookSubscription | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class WebhookSubscriptionDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedWebhookSubscriptionId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
