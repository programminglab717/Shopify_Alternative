import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, press, renderAdmin, signedIn } from '../test-support';

const DOCUMENTS = [
  { handle: 'terms', version: '2026-11-01', url: 'https://hatti.pk/legal/terms' },
  { handle: 'acceptable-use', version: '2026-10-22', url: 'https://hatti.pk/legal/acceptable-use' },
  {
    handle: 'data-processing',
    version: '2026-10-22',
    url: 'https://hatti.pk/legal/data-processing',
  },
];
const AGREED = {
  terms: '2026-11-01',
  'acceptable-use': '2026-10-22',
  'data-processing': '2026-10-22',
};

describe("Hatti's terms agreed to again for a shop (ADR-739)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('asks its owner above every page until they agree, with each document linked', async () => {
    const account = { shop: { agreementDue: true } };
    const core = fakeCore(
      'owner',
      (operation) => {
        throw new Error(`unexpected ${operation}`);
      },
      (path) => {
        if (path === '/auth/agreement') return { documents: DOCUMENTS };
        if (path === '/auth/shops/shop_1/agreement') {
          account.shop.agreementDue = false;
          return { agreementDue: false };
        }
        return {};
      },
      account,
    );
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/more');

    const banner = await screen.findByRole('region', {
      name: "Agree to Hatti's terms for this shop",
    });
    const link = await within(banner).findByRole('link', { name: 'terms of service' });
    expect(link.getAttribute('href')).toBe('https://hatti.pk/legal/terms');
    // The rest of the admin stays open meanwhile.
    expect(screen.getAllByRole('navigation', { name: 'Main' }).length).toBeGreaterThan(0);

    const box = await within(banner).findByRole('checkbox');
    await waitFor(() => expect((box as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(box);
    await press('Agree');
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: "Agree to Hatti's terms for this shop" }),
      ).toBeNull(),
    );
    expect(core.sent.find((each) => each.operation === '/auth/shops/shop_1/agreement')).toEqual({
      operation: '/auth/shops/shop_1/agreement',
      method: 'POST',
      variables: { agreed: AGREED },
    });
  });

  it('asks no one whose agreement is not due, nor anyone but the owner', async () => {
    const core = fakeCore(
      'manager',
      (operation) => {
        throw new Error(`unexpected ${operation}`);
      },
      () => ({}),
      { shop: { agreementDue: false } },
    );
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/more');
    await screen.findAllByRole('navigation', { name: 'Main' });
    expect(
      screen.queryByRole('region', { name: "Agree to Hatti's terms for this shop" }),
    ).toBeNull();
    expect(core.sent.some((each) => each.operation === '/auth/agreement')).toBe(false);
  });
});
