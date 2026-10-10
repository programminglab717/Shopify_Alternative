import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfirmationAgentValue } from '../api/types';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

const DAY_MS = 86_400_000;

const delivery = (delivered: number, returned: number, inTransit = 0) => ({
  shipped: delivered + returned + inTransit,
  delivered,
  returned,
  inTransit,
  successRate: delivered + returned ? delivered / (delivered + returned) : null,
  returnRate: delivered + returned ? returned / (delivered + returned) : null,
  returnCharges: { amount: String(returned * 180), currencyCode: 'PKR' },
});

/** Members of staff, an app, and someone who has left: those who settled most first. */
const AGENTS: ConfirmationAgentValue[] = [
  {
    id: 'usr_sana',
    kind: 'STAFF',
    confirmed: 42,
    cancelled: 8,
    confirmationRate: 0.84,
    confirmationsPerHour: 5.25,
    activeHours: 8,
    calls: { noAnswer: 12, callBack: 3, wrongNumber: 1 },
    delivery: delivery(27, 3, 12),
  },
  {
    id: 'tok_01hzx9a1b2c',
    kind: 'APP',
    confirmed: 20,
    cancelled: 0,
    confirmationRate: 1,
    confirmationsPerHour: 10,
    activeHours: 2,
    calls: { noAnswer: 0, callBack: 0, wrongNumber: 0 },
    delivery: delivery(12, 8),
  },
  {
    id: 'usr_owner',
    kind: 'STAFF',
    confirmed: 1,
    cancelled: 0,
    confirmationRate: 1,
    confirmationsPerHour: 1,
    activeHours: 1,
    calls: { noAnswer: 0, callBack: 0, wrongNumber: 0 },
    delivery: delivery(1, 0),
  },
  {
    id: 'usr_gone',
    kind: 'STAFF',
    confirmed: 0,
    cancelled: 0,
    confirmationRate: null,
    confirmationsPerHour: 0,
    activeHours: 1,
    calls: { noAnswer: 2, callBack: 0, wrongNumber: 0 },
    delivery: delivery(0, 0),
  },
];

function agentsCore(role: StaffRole, agents: ConfirmationAgentValue[] = AGENTS) {
  return fakeCore(role, (operation) => {
    if (operation === 'ConfirmationQueue') {
      return {
        shop: { timezone: 'Asia/Karachi' },
        confirmationQueue: {
          callingNow: true,
          callingOpensAt: null,
          dueCount: 0,
          laterCount: 0,
          overdueCount: 0,
          nodes: [],
        },
      };
    }
    if (operation !== 'ConfirmationAgents') throw new Error(`unexpected ${operation}`);
    return {
      confirmationAgents: agents,
      staffMembers: [
        { id: 'usr_owner', name: 'Bilal Ahmed' },
        { id: 'usr_sana', name: 'Sana Iqbal' },
      ],
    };
  });
}

const periodOf = (variables: Record<string, unknown>) =>
  (Date.parse(String(variables.before)) - Date.parse(String(variables.from))) / DAY_MS;

describe("The Confirmation Desk's agents", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows an owner how each agent did, a high share of returns in red, over the days chosen', async () => {
    const core = agentsCore('owner');
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/desk/agents');

    const sana = (await screen.findByText('Sana Iqbal')).closest('li')!;
    // 42 confirmed of the 50 they decided, 5.25 an hour over 8 hours, 3 of 30 parcels back.
    expect(within(sana).getByText('42')).toBeTruthy();
    expect(within(sana).getByText('84% of the orders they decided')).toBeTruthy();
    expect(within(sana).getByText('8')).toBeTruthy();
    expect(within(sana).getByText('5.3')).toBeTruthy();
    expect(within(sana).getByText('8 hours on the desk')).toBeTruthy();
    expect(within(sana).getByText('3 of 30 parcels')).toBeTruthy();
    expect(within(sana).getByText('12 parcels on their way')).toBeTruthy();
    expect(within(sana).getByText('10%').className).not.toContain('text-danger');
    expect(within(sana).getByText('12 not answered')).toBeTruthy();
    expect(within(sana).getByText('3 to call back')).toBeTruthy();
    expect(within(sana).getByText('1 wrong number')).toBeTruthy();

    // An app, told apart by the end of its token: 8 of its 20 parcels came back.
    const app = screen.getByText('An app').closest('li')!;
    expect(within(app).getByText('…9a1b2c')).toBeTruthy();
    expect(within(app).getByText('40%').className).toContain('text-danger');
    expect(within(app).getByText('2 hours on the desk')).toBeTruthy();

    // The owner's one order was delivered: none of their one parcel came back.
    const owner = screen.getByText('Bilal Ahmed').closest('li')!;
    expect(within(owner).getByText('0 of 1 parcel')).toBeTruthy();
    expect(within(owner).getByText('0%')).toBeTruthy();

    // Someone no longer on the staff, who only called: no share of orders decided.
    const gone = screen.getByText('Former staff').closest('li')!;
    expect(within(gone).getByText('1 hour on the desk')).toBeTruthy();
    expect(within(gone).getByText('2 not answered')).toBeTruthy();
    expect(within(gone).getByText('0 of 0 parcels')).toBeTruthy();
    expect(within(gone).queryByText(/of the orders they decided/)).toBeNull();
    expect(within(gone).queryByText(/on their way/)).toBeNull();

    // Whole days in the shop's time zone, the last 30 first, then the last 7.
    const asked = () => core.sent.filter((each) => each.operation === 'ConfirmationAgents');
    expect(periodOf(asked()[0]!.variables)).toBe(30);
    fireEvent.click(screen.getByRole('tab', { name: 'Last 7 days' }));
    await waitFor(() => expect(periodOf(asked().at(-1)!.variables)).toBe(7));
  });

  it('takes a manager from the desk to how its agents did, saying when no one worked it', async () => {
    vi.stubGlobal('fetch', agentsCore('manager', []).fetcher);
    renderAdmin('/shop_1/desk');

    fireEvent.click(await screen.findByRole('link', { name: "Agents' performance" }));
    await screen.findByText('No one confirmed, cancelled or called in these days.');
    expect(screen.getByRole('tab', { name: 'Last 30 days' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('keeps how the agents did to owners and managers, never asking for anyone else', async () => {
    const core = agentsCore('confirmation_agent');
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/desk/agents');

    await screen.findByText('Only owners and managers see how the agents did.');
    expect(screen.queryByRole('tab')).toBeNull();
    expect(core.sent.some((each) => each.operation === 'ConfirmationAgents')).toBe(false);
  });
});
