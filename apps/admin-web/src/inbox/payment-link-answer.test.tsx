import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, press, renderAdmin, signedIn, type } from '../test-support';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** A fake core with one conversation and three payment links, one no longer taking orders. */
function linkCore(role: StaffRole) {
  const conversation = {
    id: 'conv_1',
    customerPhone: '+923001234567',
    viaOwnNumber: true,
    status: 'OPEN',
    unread: 0,
    lastMessageAt: ago(10),
    lastInboundAt: ago(10),
    replyableUntil: LATER,
    lastMessage: null,
    createdAt: ago(600),
    assignee: null,
    waitingSince: null,
    answerBy: null,
    labels: [] as string[],
  };
  const link = (id: string, title: string, open: boolean, items: [string, number][]) => ({
    id,
    title,
    url: `https://zari.hatti.pk/pay/${id}`,
    active: open,
    open,
    ordersPlaced: 0,
    usageLimit: null,
    prepaidOnly: false,
    discountCode: null,
    expiresAt: null,
    lastOrderAt: null,
    createdAt: ago(60),
    items: items.map(([name, quantity]) => ({ variantId: 'var_1', title: name, quantity })),
    orders: [],
  });
  return fakeCore(role, (operation) => {
    switch (operation) {
      case 'Conversation':
        return { conversation };
      case 'ConversationMessages':
        return {
          conversationMessages: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        };
      case 'ConversationLabels':
        return { conversationLabels: [] };
      case 'DraftOrders':
        return { draftOrders: { nodes: [] } };
      case 'PaymentLinks':
        return {
          paymentLinks: [
            link('pl_1', 'Eid lawn set', true, [
              ['Lawn suit', 2],
              ['Dupatta', 1],
            ]),
            link('pl_2', 'Winter shawl', true, [['Shawl', 1]]),
            link('pl_3', 'Summer sale', false, [['Kurta', 1]]),
          ],
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe('A payment link put in an answer, in the admin (MSG-08, ADR-767)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('puts a link still taking orders in the answer, found by its title or what it sells', async () => {
    vi.stubGlobal('fetch', linkCore('confirmation_agent').fetcher);
    renderAdmin('/shop_1/inbox/conv_1');

    await screen.findByLabelText('Reply');
    type('Reply', 'Yahan se pay karein:');
    await press('Put in a payment link');
    expect(await screen.findByText('Winter shawl')).toBeTruthy();
    expect(screen.queryByText('Summer sale')).toBeNull();
    type('Find a payment link', 'dupatta');
    expect(screen.queryByText('Winter shawl')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Eid lawn set/ }));
    expect((screen.getByLabelText('Reply') as HTMLTextAreaElement).value).toBe(
      'Yahan se pay karein:\n\nEid lawn set\nLawn suit × 2, Dupatta\nhttps://zari.hatti.pk/pay/pl_1',
    );
  });

  it('says when no link taking orders matches, and is not offered to marketers', async () => {
    vi.stubGlobal('fetch', linkCore('owner').fetcher);
    renderAdmin('/shop_1/inbox/conv_1');
    await screen.findByLabelText('Reply');
    await press('Put in a payment link');
    type('Find a payment link', 'kurta');
    expect(await screen.findByText('No payment link taking orders matches')).toBeTruthy();
    cleanup();

    vi.stubGlobal('fetch', linkCore('marketer').fetcher);
    renderAdmin('/shop_1/inbox/conv_1');
    await screen.findByRole('heading', { name: /0300/ });
    expect(screen.queryByRole('button', { name: 'Put in a payment link' })).toBeNull();
  });
});
