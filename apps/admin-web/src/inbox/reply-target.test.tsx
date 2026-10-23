import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, LATER, renderAdmin, signedIn } from '../test-support';

const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

/**
 * A fake core with three conversations of a shop answering within 30 minutes: one waiting past
 * it, one waiting within it, one answered.
 */
function targetCore() {
  const conversations = [
    { id: 'conv_1', phone: '+923001234567', waitingSince: at(-45), answerBy: at(-15) },
    { id: 'conv_2', phone: '+923211234567', waitingSince: at(-10), answerBy: at(20) },
    { id: 'conv_3', phone: '+923451234567', waitingSince: null, answerBy: null },
  ].map(({ id, phone, waitingSince, answerBy }) => ({
    id,
    customerPhone: phone,
    viaOwnNumber: true,
    status: 'OPEN',
    unread: 0,
    lastMessageAt: at(-5),
    lastInboundAt: at(-10),
    replyableUntil: LATER,
    lastMessage: null,
    createdAt: at(-600),
    assignee: null,
    waitingSince,
    answerBy,
    labels: [] as string[],
  }));
  return fakeCore('confirmation_agent', (operation, variables) => {
    if (operation !== 'Conversations') throw new Error(`unexpected ${operation}`);
    const shown = conversations.filter(
      (each) => !variables.overdue || (each.answerBy && each.answerBy < at(0)),
    );
    return {
      conversations: { nodes: shown, pageInfo: { hasNextPage: false, endCursor: null } },
      conversationsUnreadCount: 0,
      conversationsOverdueCount: 1,
    };
  });
}

describe("The inbox's time to answer by, in the admin (MSG-06, ADR-760)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('marks who waits too long, says by when to answer the rest, and lists the overdue on their tab', async () => {
    const core = targetCore();
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/inbox');

    expect(await screen.findByText('Overdue · wrote 45 minutes ago')).toBeTruthy();
    expect(screen.getByText('Answer in 20 minutes')).toBeTruthy();
    expect(screen.getByText(/· 1 waiting too long/)).toBeTruthy();
    expect(screen.getAllByText(/^Overdue ·|^Answer in/)).toHaveLength(2);

    fireEvent.click(screen.getByRole('tab', { name: 'Overdue' }));
    await screen.findByText('Overdue · wrote 45 minutes ago');
    expect(screen.queryByText('Answer in 20 minutes')).toBeNull();
    expect(
      core.sent.filter((each) => each.operation === 'Conversations').at(-1)?.variables,
    ).toMatchObject({ status: 'OPEN', overdue: true });
  });
});
