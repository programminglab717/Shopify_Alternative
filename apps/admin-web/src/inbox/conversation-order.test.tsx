import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserError } from '../api/types';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, renderAdmin, signedIn } from '../test-support';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** A fake core with one conversation and two open drafts, which sends a draft's link once. */
function orderCore(
  role: StaffRole,
  {
    replyableUntil = LATER,
    refusal = null,
  }: { replyableUntil?: string; refusal?: UserError | null } = {},
) {
  const conversation = {
    id: 'conv_1',
    customerPhone: '+923001234567',
    viaOwnNumber: true,
    status: 'OPEN',
    unread: 0,
    lastMessageAt: ago(10),
    lastInboundAt: ago(10),
    replyableUntil,
    lastMessage: null,
    createdAt: ago(600),
    assignee: null,
    waitingSince: null,
    answerBy: null,
    labels: [] as string[],
  };
  const draft = (id: string, name: string, quantity: number, amount: string) => ({
    id,
    name,
    status: 'OPEN',
    source: 'WHATSAPP',
    createdAt: ago(30),
    totalPrice: { amount, currencyCode: 'PKR' },
    shippingAddress: null,
    lineItems: [{ quantity }],
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
        return {
          draftOrders: {
            nodes: [draft('dft_1', '#D1', 2, '5000.00'), draft('dft_2', '#D2', 1, '2500.00')],
          },
        };
      case 'ConversationDraftLinkSend':
        return {
          conversationDraftLinkSend: refusal
            ? { conversation: null, userErrors: [refusal] }
            : { conversation, userErrors: [] },
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sends = (core: ReturnType<typeof orderCore>) =>
  core.sent
    .filter((each) => each.operation === 'ConversationDraftLinkSend')
    .map((each) => each.variables);

describe('An order sent from a conversation, in the admin (MSG-08, ADR-765)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("offers the shop's open drafts and sends one's link in the conversation", async () => {
    const core = orderCore('confirmation_agent');
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/inbox/conv_1');

    const drafts = await screen.findByRole('list', { name: 'Open drafts' });
    await waitFor(() => expect(drafts.textContent).toContain('#D2'));
    expect(drafts.textContent).toContain('2 items · Rs 5,000');
    expect(screen.getByRole('link', { name: 'New draft' }).getAttribute('href')).toBe(
      '/shop_1/drafts/new',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send link for #D2' }));
    expect(await screen.findByText('The link for #D2 was sent')).toBeTruthy();
    expect(sends(core)).toEqual([{ id: 'conv_1', draftOrderId: 'dft_2' }]);
  });

  it('says why the link was not sent', async () => {
    const core = orderCore('owner', {
      refusal: {
        field: ['draftOrderId'],
        code: 'INVALID',
        message: 'Bank transfer needs the shop’s bank account',
      },
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/inbox/conv_1');

    fireEvent.click(await screen.findByRole('button', { name: 'Send link for #D1' }));
    expect(await screen.findByText('Bank transfer needs the shop’s bank account')).toBeTruthy();
  });

  it('offers nothing once WhatsApp no longer lets the shop answer, nor to marketers', async () => {
    vi.stubGlobal('fetch', orderCore('owner', { replyableUntil: ago(5) }).fetcher);
    renderAdmin('/shop_1/inbox/conv_1');
    await screen.findByRole('heading', { name: /0300 1234567/ });
    expect(screen.queryByText('Send an order')).toBeNull();
    cleanup();

    vi.stubGlobal('fetch', orderCore('marketer').fetcher);
    renderAdmin('/shop_1/inbox/conv_1');
    await screen.findByRole('heading', { name: /0300/ });
    expect(screen.queryByText('Send an order')).toBeNull();
  });
});
