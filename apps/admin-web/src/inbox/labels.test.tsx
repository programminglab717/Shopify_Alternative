import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, press, renderAdmin, signedIn, type } from '../test-support';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/**
 * A fake core with two open conversations, one labelled Delivery, which labels them as the core
 * would: in place of the labels before, a label the shop uses written as the shop writes it.
 */
function labelsCore(role: StaffRole) {
  const conversations = [
    { id: 'conv_1', phone: '+923001234567', labels: [] as string[] },
    { id: 'conv_2', phone: '+923211234567', labels: ['Delivery'] },
  ].map(({ id, phone, labels }) => ({
    id,
    customerPhone: phone,
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
    labels,
  }));
  const find = (id: unknown) => conversations.find((each) => each.id === id)!;
  const used = () => {
    const names = [...new Set(conversations.flatMap((each) => each.labels))].sort();
    return names.map((name) => ({
      name,
      open: conversations.filter((each) => each.labels.includes(name)).length,
    }));
  };
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Conversations': {
        const shown = conversations.filter(
          (each) => !variables.label || each.labels.includes(String(variables.label)),
        );
        return {
          conversations: { nodes: shown, pageInfo: { hasNextPage: false, endCursor: null } },
          conversationsUnreadCount: 0,
          conversationsOverdueCount: 0,
          conversationLabels: used(),
        };
      }
      case 'Conversation':
        return { conversation: find(variables.id) };
      case 'ConversationMessages':
        return {
          conversationMessages: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        };
      case 'ConversationLabels':
        return { conversationLabels: used() };
      case 'ConversationLabelsSet': {
        const found = find(variables.id);
        const known = new Map(used().map((each) => [each.name.toLowerCase(), each.name]));
        found.labels = (variables.labels as string[]).map(
          (label) => known.get(label.toLowerCase()) ?? label,
        );
        return { conversationLabelsSet: { conversation: found, userErrors: [] } };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const labelled = (core: ReturnType<typeof labelsCore>) =>
  core.sent
    .filter((each) => each.operation === 'ConversationLabelsSet')
    .map((each) => each.variables);

describe("Labels on the inbox's conversations, in the admin (MSG-06, ADR-764)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lets an agent label a conversation, written as the shop writes the label, and take it off', async () => {
    const core = labelsCore('confirmation_agent');
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/inbox/conv_1');

    await screen.findByText('What the customer writes about, like delivery, size or a refund.');
    type('Add a label', 'delivery');
    await press('Add');
    await screen.findByRole('button', { name: 'Take off Delivery' });
    type('Add a label', ' Size ');
    await press('Add');
    await screen.findByRole('button', { name: 'Take off Size' });
    // A label it has already is not added twice.
    type('Add a label', 'SIZE');
    await press('Add');
    fireEvent.click(screen.getByRole('button', { name: 'Take off Delivery' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Take off Delivery' })).toBeNull(),
    );
    expect(labelled(core)).toEqual([
      { id: 'conv_1', labels: ['delivery'] },
      { id: 'conv_1', labels: ['Delivery', 'Size'] },
      { id: 'conv_1', labels: ['Size'] },
    ]);
  });

  it('shows the conversations with one label, and their labels on the list', async () => {
    const core = labelsCore('owner');
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/inbox');

    await screen.findByText('0321 1234567');
    expect(screen.getByText('0300 1234567')).toBeTruthy();
    const filter = screen.getByRole('group', { name: 'Labels' });
    expect(filter.textContent).toBe('All labelsDelivery1');
    fireEvent.click(screen.getByRole('button', { name: /^Delivery/ }));
    await waitFor(() =>
      expect(
        core.sent.filter((each) => each.operation === 'Conversations').at(-1)?.variables,
      ).toMatchObject({ status: 'OPEN', label: 'Delivery' }),
    );
    expect(await screen.findByText('0321 1234567')).toBeTruthy();
    expect(screen.queryByText('0300 1234567')).toBeNull();
    // Each conversation's labels show on its row.
    expect(screen.getByRole('link', { name: /0321 1234567/ }).textContent).toContain('Delivery');
    // The label stays chosen on another tab.
    fireEvent.click(screen.getByRole('tab', { name: 'Unread' }));
    await waitFor(() =>
      expect(
        core.sent.filter((each) => each.operation === 'Conversations').at(-1)?.variables,
      ).toMatchObject({ unread: true, label: 'Delivery' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'All labels' }));
    await waitFor(() =>
      expect(
        core.sent.filter((each) => each.operation === 'Conversations').at(-1)?.variables,
      ).toMatchObject({ unread: true, label: null }),
    );
  });

  it('shows a marketer the labels alone', async () => {
    vi.stubGlobal('fetch', labelsCore('marketer').fetcher);
    renderAdmin('/shop_1/inbox/conv_2');

    const labels = await screen.findByRole('list', { name: 'Labels' });
    expect(labels.textContent).toBe('Delivery');
    expect(screen.queryByLabelText('Add a label')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Take off Delivery' })).toBeNull();
  });
});
