import 'reflect-metadata';
import { DnsLookup, StorefrontSite } from '@hatti/api';
import { pgError } from '@hatti/db';
import { testDatabaseServer } from '@hatti/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DomainService } from './domain.service.js';
import { policyDraft, type PolicyFacts } from './policy-drafts.js';
import { POLICY_TYPES } from './policy-types.js';
import { PolicyService, shopPoliciesOf, shopPolicyVersionsOf } from './policy.service.js';
import { policies, policyVersions } from './schema.js';
import { errorsOf, onlineStoreFixture, unwrap, type OnlineStoreFixture } from './test-support.js';

const server = testDatabaseServer();

/** No domain of their own: the shops are at their handles' subdomains. */
class NoDns extends DnsLookup {
  async cnames(): Promise<string[]> {
    return [];
  }

  async addresses(): Promise<string[]> {
    return [];
  }
}

const FACTS: PolicyFacts = {
  shopName: 'Zari & Sons <Lahore>',
  storefrontUrl: 'https://zari.hatti.pk',
  whatsapp: '+923001234567',
  deliveryCharge: 'Rs 250',
  deliveryFree: false,
  freeDeliveryFrom: 'Rs 5,000',
  zones: [{ name: 'Lahore', cities: ['Lahore', 'Kasur'], charge: 'Rs 150' }],
};

describe('Drafts of policies', () => {
  it("fills each in from the shop's facts, in English and Urdu, its name kept to text", () => {
    for (const type of POLICY_TYPES) {
      for (const locale of ['en', 'ur'] as const) {
        const draft = policyDraft(type, locale, FACTS);
        expect(draft.title, `${type} ${locale}`).not.toBe('');
        expect(draft.body, `${type} ${locale}`).toMatch(/^<(p|h2)>/);
        expect(draft.body).not.toContain('\n');
        expect(draft.body).not.toContain('<Lahore>');
      }
    }
    const refund = policyDraft('refund_policy', 'en', FACTS).body;
    expect(refund).toContain(
      'buy from Zari &amp; Sons &lt;Lahore&gt;. If something is not right, you',
    );
    expect(refund).toContain('WhatsApp us at 0300 1234567 with your order number.');
    const shipping = policyDraft('shipping_policy', 'en', FACTS).body;
    expect(shipping).toContain(
      '<ul><li>Lahore (Lahore, Kasur): Rs 150</li><li>Everywhere else: Rs 250 an order</li></ul>' +
        '<p>Delivery is free on orders of Rs 5,000 or more.</p>',
    );
    expect(policyDraft('shipping_policy', 'ur', FACTS).body).toContain(
      '<span dir="ltr">Rs 5,000</span> یا اس سے زیادہ کے آرڈرز پر ڈیلیوری مفت ہے۔',
    );
    expect(policyDraft('refund_policy', 'ur', FACTS)).toMatchObject({ title: 'واپسی کی پالیسی' });

    // Without a WhatsApp number or charges: the store's address, and free delivery.
    const plain = {
      ...FACTS,
      whatsapp: null,
      deliveryFree: true,
      freeDeliveryFrom: null,
      zones: [],
    };
    expect(policyDraft('terms_of_service', 'en', plain).body).toContain(
      '<p>Contact us through our store at https://zari.hatti.pk.</p>',
    );
    expect(policyDraft('shipping_policy', 'en', plain).body).toContain('<p>Delivery is free.</p>');
    expect(policyDraft('contact_information', 'en', plain).body).toBe(
      '<p>Zari &amp; Sons &lt;Lahore&gt;</p><ul><li>Online: ' +
        '<a href="https://zari.hatti.pk">https://zari.hatti.pk</a></li></ul>',
    );
  });
});

describe.skipIf(!server)('PolicyService', () => {
  let f: OnlineStoreFixture;
  let service: PolicyService;

  beforeAll(async () => {
    f = await onlineStoreFixture(server!);
    const site = new StorefrontSite('https://hatti.pk');
    service = new PolicyService(f.db, site, new DomainService(f.db, site, new NoDns()));
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  it('matches the migrated tables', async () => {
    await f.db.tenant(f.a.shopId, (tx) => tx.select().from(policies).limit(1));
    await f.db.tenant(f.a.shopId, (tx) => tx.select().from(policyVersions).limit(1));
  });

  it('keeps each policy once, cleaned, and takes it away when blank', async () => {
    const refund = unwrap(
      await service.update(f.a, {
        type: 'refund_policy',
        body: '<p onclick="steal()">7 days.</p><script>steal()</script>',
      }),
    );
    expect(refund).toMatchObject({
      type: 'refund_policy',
      title: 'Refund policy',
      body: '<p>7 days.</p>',
    });
    unwrap(await service.update(f.a, { type: 'privacy_policy', body: '<p>We keep little.</p>' }));
    // The same body again changes nothing; another replaces it, keeping its ID.
    unwrap(await service.update(f.a, { type: 'refund_policy', body: '<p>7 days.</p>' }));
    const changed = unwrap(
      await service.update(f.a, { type: 'refund_policy', body: '<p>14 days.</p>' }),
    );
    expect(changed!.id).toBe(refund!.id);
    expect((await service.list(f.a)).map((policy) => [policy.type, policy.body])).toEqual([
      ['refund_policy', '<p>14 days.</p>'],
      ['privacy_policy', '<p>We keep little.</p>'],
    ]);
    // Blank, or nothing but empty tags, takes it away.
    expect(
      unwrap(await service.update(f.a, { type: 'privacy_policy', body: '<p> &nbsp;</p>' })),
    ).toBeNull();
    expect(unwrap(await service.update(f.a, { type: 'shipping_policy', body: '' }))).toBeNull();
    expect(await f.db.tenant(f.a.shopId, (tx) => shopPoliciesOf(tx, f.a.shopId))).toEqual([
      { type: 'refund_policy', body: '<p>14 days.</p>' },
    ]);
    expect((await f.outbox()).map((row) => [row.event_type, row.payload])).toEqual([
      ['shop_policy.updated', { type: 'refund_policy', removed: false }],
      ['shop_policy.updated', { type: 'privacy_policy', removed: false }],
      ['shop_policy.updated', { type: 'refund_policy', removed: false }],
      ['shop_policy.updated', { type: 'privacy_policy', removed: true }],
    ]);
    expect(
      errorsOf(
        await service.update(f.a, { type: 'terms_of_service', body: 'x'.repeat(600_000) }),
      )[0]?.[1],
    ).toBe('TOO_LONG');
    // Each shop's are its own.
    expect(await service.list(f.b)).toEqual([]);
    expect(await service.storefrontUrl(f.a)).toMatch(/^https:\/\/[\w-]+\.hatti\.pk$/);
  });

  it('keeps every body saved as a version, never changed, for what orders agreed to', async () => {
    const current = () => f.db.tenant(f.a.shopId, (tx) => shopPolicyVersionsOf(tx, f.a.shopId));
    unwrap(await service.update(f.a, { type: 'terms_of_service', body: '<p>Our terms.</p>' }));
    unwrap(await service.update(f.a, { type: 'refund_policy', body: '<p>7 days.</p>' }));
    const [first, terms] = await current();
    expect([first!.type, terms!.type]).toEqual(['refund_policy', 'terms_of_service']);
    // The same body again is the same version; another is a new one.
    unwrap(await service.update(f.a, { type: 'refund_policy', body: '<p>7 days.</p>' }));
    expect((await current())[0]).toEqual(first);
    unwrap(await service.update(f.a, { type: 'refund_policy', body: '<p>14 days.</p>' }));
    const [second] = await current();
    expect(second!.versionId).not.toBe(first!.versionId);

    // Taken away, a policy's versions stay, as they were saved.
    unwrap(await service.update(f.a, { type: 'refund_policy', body: '' }));
    expect(await current()).toEqual([terms]);
    const ids = [first!.versionId, second!.versionId, terms!.versionId];
    const versions = await service.versions(f.a, ids);
    expect(ids.map((id) => [versions.get(id)?.title, versions.get(id)?.body])).toEqual([
      ['Refund policy', '<p>7 days.</p>'],
      ['Refund policy', '<p>14 days.</p>'],
      ['Terms of service', '<p>Our terms.</p>'],
    ]);
    // Another shop's are not theirs to read; request code can neither change nor delete them.
    expect((await service.versions(f.b, ids)).size).toBe(0);
    expect(await service.versions(f.a, [])).toEqual(new Map());
    for (const statement of [
      "UPDATE online_store.policy_versions SET body = '<p>0 days.</p>'",
      'DELETE FROM online_store.policy_versions',
    ]) {
      const error = await f.db
        .tenant(f.a.shopId, (tx) => tx.execute(sql.raw(statement)))
        .catch((caught: unknown) => caught);
      expect([statement, pgError(error)?.code]).toEqual([statement, '42501']);
    }
  });
});
