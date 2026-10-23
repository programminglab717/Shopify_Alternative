import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, press, renderAdmin, signedIn, type } from '../test-support';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const money = (amount: string) => ({ amount, currencyCode: 'PKR' });

/** A fake core with one conversation and three products, one a draft, found by their words. */
function productCore(role: StaffRole) {
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
  const products = [
    {
      id: 'prd_1',
      title: 'Lawn suit',
      handle: 'lawn-suit',
      status: 'ACTIVE',
      low: '2500.00',
      high: '3200.00',
    },
    {
      id: 'prd_2',
      title: 'Lawn dupatta',
      handle: 'lawn-dupatta',
      status: 'ACTIVE',
      low: '900.00',
      high: '900.00',
    },
    {
      id: 'prd_3',
      title: 'Lawn shawl',
      handle: 'lawn-shawl',
      status: 'DRAFT',
      low: '1500.00',
      high: '1500.00',
    },
  ].map(({ low, high, ...product }) => ({
    ...product,
    priceRange: { minVariantPrice: money(low), maxVariantPrice: money(high) },
  }));
  return fakeCore(role, (operation, variables) => {
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
      case 'SavedReplies':
        return { savedReplies: [] };
      case 'ProductCardSearch': {
        const words = String(variables.query ?? '').toLowerCase();
        return {
          shop: { url: 'https://www.zari.pk/' },
          products: {
            nodes: products.filter((each) => each.title.toLowerCase().includes(words)),
          },
        };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe('A product put in an answer, in the admin (MSG-08, ADR-766)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('puts a product on sale in the answer with its price and link, after what is written', async () => {
    const core = productCore('confirmation_agent');
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/inbox/conv_1');

    await screen.findByLabelText('Reply');
    type('Reply', 'Yeh dekhein:');
    await press('Put in a product');
    // Drafts are not offered: the customer would find no page.
    await screen.findByText('Lawn dupatta');
    expect(screen.queryByText('Lawn shawl')).toBeNull();
    expect(screen.getByText('Rs 2,500 – Rs 3,200')).toBeTruthy();
    type('Find a product on sale', 'suit');
    fireEvent.click(await screen.findByRole('button', { name: /Lawn suit/ }));
    expect((screen.getByLabelText('Reply') as HTMLTextAreaElement).value).toBe(
      'Yeh dekhein:\n\nLawn suit\nRs 2,500 – Rs 3,200\nhttps://www.zari.pk/products/lawn-suit',
    );
    expect(screen.queryByLabelText('Find a product on sale')).toBeNull();
    expect(
      core.sent.filter((each) => each.operation === 'ProductCardSearch').at(-1)?.variables,
    ).toEqual({ query: 'suit' });
    // What was found before the words were typed is not offered once they are.
    await press('Put in a product');
    type('Find a product on sale', 'suit');
    await screen.findByRole('button', { name: /Lawn suit/ });
    await waitFor(() => expect(screen.queryByText('Lawn dupatta')).toBeNull());
  });

  it('puts a single price alone, and says when nothing on sale matches', async () => {
    vi.stubGlobal('fetch', productCore('owner').fetcher);
    renderAdmin('/shop_1/inbox/conv_1');

    await screen.findByLabelText('Reply');
    await press('Put in a product');
    fireEvent.click(await screen.findByRole('button', { name: /Lawn dupatta/ }));
    expect((screen.getByLabelText('Reply') as HTMLTextAreaElement).value).toBe(
      'Lawn dupatta\nRs 900\nhttps://www.zari.pk/products/lawn-dupatta',
    );
    await press('Put in a product');
    type('Find a product on sale', 'shawl');
    expect(await screen.findByText('No product on sale matches')).toBeTruthy();
  });
});
