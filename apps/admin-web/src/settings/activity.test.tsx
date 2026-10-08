import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messages } from '../i18n/messages';
import { fakeCore, LATER, renderAdmin, signedIn } from '../test-support';
import { describe as describeEvent } from './activity-page';

const STAFF = [
  { id: 'usr_1', name: 'Sana' },
  { id: 'usr_2', name: 'Bilal' },
];

const english = (key: string, values?: Record<string, string | number>) =>
  (messages.en as Record<string, string>)[key]!.replace(/\{(\w+)\}/g, (_, name: string) =>
    String(values?.[name] ?? ''),
  );

describe('The activity log in the admin', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('says what changed in words, by whom, linking to what it changed', async () => {
    const core = fakeCore('manager', (operation, variables) => {
      if (operation === 'Activity') {
        return {
          activityLog: {
            nodes: [
              {
                id: 'evt_1',
                type: 'product.updated',
                subjectType: 'product',
                subjectId: 'prod_1',
                occurredAt: LATER,
                actor: { id: 'usr_2', kind: 'STAFF', role: 'packer' },
              },
              {
                id: 'evt_2',
                type: 'delivery_settings.updated',
                subjectType: 'delivery_settings',
                subjectId: null,
                occurredAt: LATER,
                actor: { id: 'usr_9', kind: 'STAFF', role: 'confirmation_agent' },
              },
              {
                id: 'evt_3',
                type: 'webhook_subscription.created',
                subjectType: 'webhook_subscription',
                subjectId: null,
                occurredAt: LATER,
                actor: { id: 'tok_1', kind: 'APP', role: null },
              },
            ],
            pageInfo: { hasNextPage: variables.first === 50 },
          },
          staffMembers: STAFF,
        };
      }
      if (operation === 'Audit') {
        return {
          auditLog: {
            nodes: [
              {
                id: 'aud_1',
                action: 'customer.phone_revealed',
                subjectId: 'cus_1',
                occurredAt: LATER,
                actor: { id: 'usr_1', kind: 'STAFF', role: 'owner' },
              },
            ],
            pageInfo: { hasNextPage: false },
          },
          staffMembers: STAFF,
        };
      }
      throw new Error(`unexpected ${operation}`);
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/settings/activity');

    const product = await screen.findByRole('link', { name: 'Product updated' });
    expect(product.getAttribute('href')).toBe('/shop_1/products/prod_1');
    expect(screen.getByText('Bilal')).toBeTruthy();
    // Someone no longer on the staff is named by their role; an app as an app.
    expect(screen.getByText('Delivery charges updated')).toBeTruthy();
    expect(screen.getByText('Confirmation agent')).toBeTruthy();
    expect(screen.getByText('webhook subscription created')).toBeTruthy();
    expect(screen.getByText('An app')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show older' }));
    await waitFor(() =>
      expect(core.sent.filter((each) => each.operation === 'Activity').at(-1)?.variables).toEqual({
        first: 100,
      }),
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Numbers seen and exports' }));
    const seen = await screen.findByRole('link', { name: 'Customer number seen' });
    expect(seen.getAttribute('href')).toBe('/shop_1/customers/cus_1');
    expect(screen.getByText('Sana')).toBeTruthy();
  });

  it('reads an event with no subject or verb the admin knows as it is named', () => {
    expect(describeEvent('order.confirmed', english)).toBe('Order confirmed');
    expect(describeEvent('support.looked', english)).toBe("Hatti's support looked");
    expect(describeEvent('gift_card.issued', english)).toBe('gift card issued');
  });
});
