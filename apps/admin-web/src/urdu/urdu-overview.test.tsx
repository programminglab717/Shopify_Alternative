import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UrduResource } from '../api/types';
import type { StaffRole } from '../auth/session';
import { fakeCore, press, renderAdmin, signedIn } from '../test-support';
import { urduCount } from './urdu-overview';

/** Something of the shop's: its own words by field, and its Urdu, `!` marking one out of date. */
function resource(
  resourceId: string,
  own: Record<string, string | null>,
  urdu: Record<string, string> = {},
): UrduResource {
  return {
    resourceId,
    translatableContent: Object.entries(own).map(([key, value]) => ({
      key,
      value,
      digest: value === null ? null : `d-${key}`,
    })),
    translations: Object.entries(urdu).map(([key, value]) => ({
      key,
      value: value.replace(/^!/, ''),
      outdated: value.startsWith('!'),
    })),
  };
}

const KINDS: Record<string, UrduResource[]> = {
  PRODUCT: [
    resource(
      'prd_1',
      { title: 'Lawn suit', body_html: '<p>Three pieces</p>', meta_title: 'Lawn suit' },
      { title: 'لان سوٹ', body_html: '!<p>تین پیس</p>' },
    ),
    resource('prd_2', { title: 'Kurta' }, { title: 'کرتا' }),
    resource('prd_3', { title: 'Shawl', body_html: '<p>Wool</p>' }),
    // Nothing of its own to put in Urdu.
    resource('prd_4', { title: null }),
  ],
  ONLINE_STORE_PAGE: [resource('pag_1', { title: 'About us' }, { title: 'ہمارے بارے میں' })],
  SHOP: [resource('shop_1', { meta_title: 'Zari', meta_description: 'Lawn and more' })],
};

function urduCore(role: StaffRole, hasNextPage = false) {
  return fakeCore(role, (operation, variables) => {
    if (operation !== 'UrduOverview') throw new Error(`unexpected ${operation}`);
    return {
      translatableResources: {
        nodes: KINDS[variables.type as string] ?? [],
        pageInfo: { hasNextPage },
      },
    };
  });
}

const rowOf = (name: string) => screen.getByText(name).closest('a')!;

describe('What is left to put in Urdu, in the admin', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists what is left to write or check, kind by kind, each opening its Urdu's page", async () => {
    vi.stubGlobal('fetch', urduCore('owner').fetcher);
    renderAdmin('/shop_1/online-store?tab=urdu');

    await screen.findByText('1 of 3 all in Urdu.');
    const lawn = rowOf('Lawn suit');
    expect(lawn.getAttribute('href')).toBe('/shop_1/products/prd_1/urdu');
    expect(within(lawn).getByText('2 of 3 in Urdu')).toBeTruthy();
    expect(within(lawn).getByText('1 to check')).toBeTruthy();
    expect(within(rowOf('Shawl')).getByText('Not in Urdu yet')).toBeTruthy();
    // All in Urdu, so nothing left: shown once asked for.
    expect(screen.queryByText('Kurta')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Only what is left to write or check' }));
    expect(within(rowOf('Kurta')).getByText('All in Urdu')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'ONLINE_STORE_PAGE' } });
    await screen.findByText('1 of 1 all in Urdu.');
    expect(rowOf('About us').getAttribute('href')).toBe('/shop_1/online-store/pages/pag_1/urdu');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Only what is left to write or check' }));
    expect(screen.getByText('All of these are in Urdu.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'SHOP' } });
    const home = (await screen.findByText('Your home page')).closest('a')!;
    expect(home.getAttribute('href')).toBe('/shop_1/online-store/home-page/urdu');
    expect(within(home).getByText('Not in Urdu yet')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'MENU' } });
    await screen.findByText('None with words of their own yet.');
  });

  it('shows more of a long list, up to the newest 250, to those who write Urdu', async () => {
    const core = urduCore('marketer', true);
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/online-store?tab=urdu');

    await screen.findByText('1 of the newest 3 all in Urdu.');
    await press('Show more');
    await screen.findByText('The newest 250 are shown here; find the others from their own pages.');
    expect(
      core.sent
        .filter((each) => each.operation === 'UrduOverview')
        .map((each) => each.variables.first),
    ).toEqual([100, 250]);
  });

  it('keeps the tab from those who do not write Urdu, and counts only words of their own', async () => {
    vi.stubGlobal('fetch', urduCore('confirmation_agent').fetcher);
    renderAdmin('/shop_1/online-store?tab=urdu');
    await screen.findByText("Your role does not write the shop's pages.");
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'In Urdu' })).toBeNull());

    expect(urduCount(KINDS.PRODUCT![0]!)).toEqual({ total: 3, written: 2, outdated: 1 });
    // Urdu kept for a field with no words of its own any more is not counted.
    expect(
      urduCount(resource('prd_9', { title: 'Cap', body_html: null }, { body_html: 'ٹوپی' })),
    ).toEqual({ total: 1, written: 0, outdated: 0 });
  });
});
