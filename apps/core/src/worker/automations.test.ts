import type { CustomerRecord } from '@hatti/customers/public';
import type { DomainEvent } from '@hatti/events';
import type { AutomationCustomer } from '@hatti/messaging/public';
import { describe, expect, it } from 'vitest';
import { AutomationTriggers, WinBacks } from './automations.js';

function consentEvent(payload: Record<string, unknown>, customerId = 'cus_1'): DomainEvent {
  return {
    id: 'evt_1',
    type: 'customer.marketing_consent_updated',
    shopId: 'shop_1',
    aggregateType: 'customer',
    aggregateId: customerId,
    payload,
    occurredAt: new Date().toISOString(),
  };
}

function customer(id: string, whatsapp: string): CustomerRecord {
  const consent = (state: string) =>
    ({ state, consentedAt: null }) as CustomerRecord['consent']['sms'];
  return {
    id,
    phone: '+923001112223',
    name: 'Ayesha Khan',
    email: null,
    note: '',
    tags: [],
    consent: {
      whatsapp: consent(whatsapp),
      sms: consent('not_subscribed'),
      email: consent('not_subscribed'),
    },
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("The shop's automations in the worker (MKT-04, ADR-425)", () => {
  it('welcomes a customer who subscribed on WhatsApp at checkout or on the storefront, if they still are', async () => {
    const welcomed: { shopId: string; customer: AutomationCustomer }[] = [];
    const customers: Record<string, CustomerRecord> = {
      cus_1: customer('cus_1', 'subscribed'),
      cus_2: customer('cus_2', 'unsubscribed'),
    };
    const triggers = new AutomationTriggers(
      {
        welcome: async (shopId, each) => {
          welcomed.push({ shopId, customer: each });
          return 'msg_1';
        },
      },
      { get: async (_tenant, id) => customers[id] ?? null },
    );
    const subscribed = { channel: 'whatsapp', state: 'subscribed', version: 2 };
    await triggers.handle(consentEvent({ ...subscribed, source: 'checkout' }));
    await triggers.handle(consentEvent({ ...subscribed, source: 'storefront' }));
    // Not staff, an app or an import; not SMS; not unsubscribing; not one who stopped since.
    for (const source of ['manual', 'api', 'import']) {
      await triggers.handle(consentEvent({ ...subscribed, source }));
    }
    await triggers.handle(consentEvent({ ...subscribed, channel: 'sms', source: 'checkout' }));
    await triggers.handle(
      consentEvent({ ...subscribed, state: 'unsubscribed', source: 'checkout' }),
    );
    await triggers.handle(consentEvent({ ...subscribed, source: 'checkout' }, 'cus_2'));
    await triggers.handle(consentEvent({ ...subscribed, source: 'checkout' }, 'cus_gone'));
    expect(welcomed).toEqual([
      { shopId: 'shop_1', customer: { id: 'cus_1', phone: '+923001112223', name: 'Ayesha Khan' } },
      { shopId: 'shop_1', customer: { id: 'cus_1', phone: '+923001112223', name: 'Ayesha Khan' } },
    ]);
    expect(AutomationTriggers.EVENTS).toEqual(['customer.marketing_consent_updated']);
  });

  it("sweeps each shop's win-back, one shop's failure not the others'", async () => {
    const swept: string[] = [];
    const winBacks = new WinBacks({
      winBackShops: async () => ['shop_1', 'shop_2', 'shop_3'],
      winBack: async (shopId) => {
        swept.push(shopId);
        if (shopId === 'shop_2') throw new Error('unreachable');
        return shopId === 'shop_1' ? 4 : 1;
      },
    });
    expect(await winBacks.sweep(new Date())).toBe(5);
    expect(swept).toEqual(['shop_1', 'shop_2', 'shop_3']);
  });
});
