import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, press, renderAdmin, signedIn } from '../test-support';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const SANA = { id: 'usr_1', name: 'Sana' };
const BILAL = { id: 'usr_2', name: 'Bilal' };

/**
 * A fake core with two open conversations, one given to Bilal, which gives them as the core would:
 * those who answer take one no one has, and give back their own.
 */
function assignmentCore(role: StaffRole) {
  const conversations = [
    { id: 'conv_1', phone: '+923001234567', assignee: null as typeof SANA | null },
    { id: 'conv_2', phone: '+923211234567', assignee: BILAL as typeof SANA | null },
  ].map(({ id, phone, assignee }) => ({
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
    assignee,
  }));
  const find = (id: unknown) => conversations.find((each) => each.id === id)!;
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Conversations': {
        const shown = conversations.filter(
          (each) => !variables.assignedToMe || each.assignee?.id === SANA.id,
        );
        return {
          conversations: { nodes: shown, pageInfo: { hasNextPage: false, endCursor: null } },
          conversationsUnreadCount: 0,
        };
      }
      case 'Conversation':
        return { conversation: find(variables.id) };
      case 'ConversationMessages':
        return {
          conversationMessages: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        };
      case 'Staff':
        return {
          staffMembers: [SANA, BILAL].map((member) => ({
            ...member,
            email: null,
            role: 'CONFIRMATION_AGENT',
            customRole: null,
            joinedAt: ago(9000),
            expiresAt: null,
          })),
          staffInvitations: [],
        };
      case 'ConversationAssign': {
        const found = find(variables.id);
        found.assignee = [SANA, BILAL].find((each) => each.id === variables.staffMemberId) ?? null;
        return { conversationAssign: { conversation: found, userErrors: [] } };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const assignments = (core: ReturnType<typeof assignmentCore>) =>
  core.sent.filter((each) => each.operation === 'ConversationAssign').map((each) => each.variables);

describe('Conversations given to staff, in the admin (MSG-06, ADR-759)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lets an agent take a conversation no one has, find it under Mine, and give it back', async () => {
    const core = assignmentCore('confirmation_agent');
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/inbox');

    // Whose each is shows on the list.
    expect(await screen.findByText('Given to Bilal')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Mine' }));
    await screen.findByText('None given to you');
    cleanup();

    renderAdmin('/shop_1/inbox/conv_1');
    await screen.findByText('No one is answering it yet');
    await press('Answer it myself');
    await screen.findByText('Given to Sana');
    await press('Give it back');
    await screen.findByText('No one is answering it yet');
    expect(assignments(core)).toEqual([
      { id: 'conv_1', staffMemberId: 'usr_1' },
      { id: 'conv_1', staffMemberId: null },
    ]);
    cleanup();

    // Someone else's is theirs to give back.
    renderAdmin('/shop_1/inbox/conv_2');
    await screen.findByText('Given to Bilal');
    expect(screen.queryByRole('button', { name: 'Answer it myself' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Give it back' })).toBeNull();
  });

  it('lets a manager give a conversation to anyone on the staff, or to no one', async () => {
    const core = assignmentCore('manager');
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/inbox/conv_2');

    const select = (await screen.findByLabelText('Given to')) as HTMLSelectElement;
    await waitFor(() =>
      expect([...select.options].map((option) => option.text)).toEqual([
        'No one',
        'Sana (you)',
        'Bilal',
      ]),
    );
    expect(select.value).toBe('usr_2');
    fireEvent.change(select, { target: { value: 'usr_1' } });
    await waitFor(() =>
      expect(assignments(core)).toEqual([{ id: 'conv_2', staffMemberId: 'usr_1' }]),
    );
    fireEvent.change(screen.getByLabelText('Given to'), { target: { value: '' } });
    await waitFor(() =>
      expect(assignments(core).at(-1)).toEqual({ id: 'conv_2', staffMemberId: null }),
    );
  });
});
