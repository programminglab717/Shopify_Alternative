import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { WEBHOOK_TOPIC_NAMES } from '../webhooks.js';
import { WebhookSubscriptionTopic, topicEnumOf, topicOf } from './webhooks.types.js';

describe('Webhook topics as the API names them (DEV-03, ADR-397)', () => {
  it('names every topic, and reads each name back, as Shopify spells them', () => {
    for (const topic of WEBHOOK_TOPIC_NAMES) {
      expect(Object.values(WebhookSubscriptionTopic)).toContain(topicEnumOf(topic));
      expect(topicOf(topicEnumOf(topic))).toBe(topic);
    }
    expect(topicOf(WebhookSubscriptionTopic.INVENTORY_LEVELS_UPDATE)).toBe(
      'inventory_levels/update',
    );
    // A charge's updates, for the app that asked it (ADR-914).
    expect(topicOf(WebhookSubscriptionTopic.APP_PURCHASES_ONE_TIME_UPDATE)).toBe(
      'app_purchases_one_time/update',
    );
  });
});
