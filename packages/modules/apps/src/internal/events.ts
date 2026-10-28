/**
 * Events the apps module publishes. Payloads are thin: fetch current state through the API.
 */
export const AppEvents = {
  Created: 'app.created',
  Updated: 'app.updated',
  TokenRotated: 'app.token_rotated',
  SecretRotated: 'app.secret_rotated',
  Deleted: 'app.deleted',
  /** A public app installed on the shop, or uninstalled from it (ADR-851). */
  Installed: 'app.installed',
  Uninstalled: 'app.uninstalled',
} as const;

/** A custom app made, changed, given a new token or secret, or removed. */
export interface AppChangedPayload {
  name: string;
  /** Its scopes now; none once it is removed. */
  scopes: string[];
  /** What changed, for an update: "name" or "scopes". */
  changed?: string[];
}

/** Events of apps' webhook subscriptions. */
export const WebhookEvents = {
  SubscriptionCreated: 'webhook_subscription.created',
  SubscriptionUpdated: 'webhook_subscription.updated',
  SubscriptionDeleted: 'webhook_subscription.deleted',
} as const;

/** A webhook subscription made, sent elsewhere, or ended. */
export interface WebhookSubscriptionChangedPayload {
  appId: string;
  topic: string;
  uri: string;
}
