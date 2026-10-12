import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackerValue } from '../api/types';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

const DAY_MS = 86_400_000;

/** A member of staff, an app, and someone who has left: those who packed most first. */
const PACKERS: PackerValue[] = [
  { id: 'usr_bilal', kind: 'STAFF', packed: 38, units: 61, activeHours: 5, packedPerHour: 7.6 },
  { id: 'tok_01hzx9a1b2c', kind: 'APP', packed: 6, units: 6, activeHours: 1, packedPerHour: 6 },
  { id: 'usr_gone', kind: 'STAFF', packed: 1, units: 2, activeHours: 1, packedPerHour: 1 },
];

function packersCore(role: StaffRole, packers: PackerValue[] = PACKERS) {
  return fakeCore(role, (operation, variables) => {
    if (operation === 'Orders') {
      return {
        orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        orderStageCounts: [],
      };
    }
    if (operation !== 'Packers') throw new Error(`unexpected ${operation}`);
    return {
      packers,
      ...(variables.managing ? { staffMembers: [{ id: 'usr_bilal', name: 'Bilal Ahmed' }] } : {}),
    };
  });
}

const periodOf = (variables: Record<string, unknown>) =>
  (Date.parse(String(variables.before)) - Date.parse(String(variables.from))) / DAY_MS;

describe('How many orders each packer packed (ADR-376)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows an owner what each packer packed today, with the total, then over the days chosen', async () => {
    const core = packersCore('owner');
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/orders/packers');

    const bilal = (await screen.findByText('Bilal Ahmed')).closest('li')!;
    expect(within(bilal).getByText('38')).toBeTruthy();
    expect(within(bilal).getByText('61')).toBeTruthy();
    expect(within(bilal).getByText('7.6')).toBeTruthy();
    expect(within(bilal).getByText('5 hours packing')).toBeTruthy();
    const app = screen.getByText('An app').closest('li')!;
    expect(within(app).getByText('…9a1b2c')).toBeTruthy();
    expect(within(app).getByText('1 hour packing')).toBeTruthy();
    expect(screen.getByText('Former staff')).toBeTruthy();
    expect(screen.getByText('In all: 45 orders packed, 69 items')).toBeTruthy();

    // Today in the shop's time zone first, asking for the staff's names; then the last 7 days.
    const asked = () => core.sent.filter((each) => each.operation === 'Packers');
    expect(periodOf(asked()[0]!.variables)).toBe(1);
    expect(asked()[0]!.variables.managing).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: 'Last 7 days' }));
    await waitFor(() => expect(periodOf(asked().at(-1)!.variables)).toBe(7));
  });

  it('shows a packer their own count from the orders to pack, without asking for the staff', async () => {
    const core = packersCore('packer', [PACKERS[0]!]);
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/orders?stage=TO_PACK');

    fireEvent.click(await screen.findByRole('link', { name: 'What I packed' }));
    const you = (await screen.findByText('You')).closest('li')!;
    expect(within(you).getByText('38')).toBeTruthy();
    expect(screen.getByText(/The orders you marked as packed/)).toBeTruthy();
    expect(screen.queryByText(/In all/)).toBeNull();
    expect(core.sent.find((each) => each.operation === 'Packers')!.variables.managing).toBe(false);
  });

  it('says when no one packed, and keeps the counts from other staff', async () => {
    vi.stubGlobal('fetch', packersCore('manager', []).fetcher);
    renderAdmin('/shop_1/orders?stage=TO_PACK');
    fireEvent.click(await screen.findByRole('link', { name: 'Who packed what' }));
    await screen.findByText('No one marked an order as packed in these days.');
    expect(screen.getByRole('tab', { name: 'Today' }).getAttribute('aria-selected')).toBe('true');
    cleanup();

    const core = packersCore('confirmation_agent');
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/orders/packers');
    await screen.findByText('Only owners, managers and packers see how many orders were packed.');
    expect(screen.queryByRole('tab')).toBeNull();
    expect(core.sent.some((each) => each.operation === 'Packers')).toBe(false);
  });
});
