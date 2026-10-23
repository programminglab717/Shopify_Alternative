import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

/** A fake core with a week of answers by two members of staff and an app. */
function timesCore(role: StaffRole) {
  return fakeCore(role, (operation) => {
    switch (operation) {
      case 'InboxReplyTimes':
        return {
          inboxReplyTimes: {
            answered: 12,
            medianWaitSeconds: 1320,
            withinTarget: 9,
            replyTargetMinutes: 30,
            repliers: [
              { id: 'usr_1', kind: 'STAFF', answered: 8, medianWaitSeconds: 600, withinTarget: 7 },
              { id: 'usr_9', kind: 'STAFF', answered: 3, medianWaitSeconds: 7500, withinTarget: 1 },
              { id: 'tok_1', kind: 'APP', answered: 1, medianWaitSeconds: 45, withinTarget: 1 },
            ],
          },
          staffMembers: [{ id: 'usr_1', name: 'Sana' }],
        };
      case 'Conversations':
        return {
          conversations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          conversationsUnreadCount: 0,
          conversationsOverdueCount: 0,
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe("The inbox's reply times, in the admin (MSG-06, ADR-763)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows owners the shop's waits and each who answered, by period", async () => {
    const core = timesCore('owner');
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/inbox');
    fireEvent.click(await screen.findByRole('link', { name: 'Reply times' }));

    await screen.findByText('The whole shop');
    // The shop's: 12 answered, a typical wait of 22 minutes, 9 in 12 in time.
    expect(screen.getByText('22 min')).toBeTruthy();
    expect(screen.getByText('75%')).toBeTruthy();
    expect(screen.getAllByText('Within 30 min')).toHaveLength(4);
    expect(screen.getByText('Sana')).toBeTruthy();
    // One who left, and an app, by what they were.
    expect(screen.getByText('Former staff')).toBeTruthy();
    expect(screen.getByText('2 h 5 min')).toBeTruthy();
    expect(screen.getByText('45 s')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Today' }));
    const sentTimes = () => core.sent.filter((each) => each.operation === 'InboxReplyTimes');
    await waitFor(() => expect(sentTimes()).toHaveLength(2));
    const sent = sentTimes();
    const [week, today] = sent.map((each) => each.variables as { from: string; before: string });
    expect(Date.parse(today!.from) - Date.parse(week!.from)).toBe(6 * 86_400_000);
  });

  it('shows agents neither the link nor the times', async () => {
    vi.stubGlobal('fetch', timesCore('confirmation_agent').fetcher);
    renderAdmin('/shop_1/inbox');
    await screen.findByRole('heading', { name: 'Inbox' });
    expect(screen.queryByRole('link', { name: 'Reply times' })).toBeNull();
    cleanup();
    renderAdmin('/shop_1/inbox/times');
    expect(await screen.findByText('Owners and managers see the reply times.')).toBeTruthy();
  });
});
