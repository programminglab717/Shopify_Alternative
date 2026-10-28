import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, presetAccess, renderAdmin, signedIn, type } from '../test-support';

function core(role: StaffRole = 'owner') {
  let stores: Record<string, unknown>[] = [];
  const fake = fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'ExpansionStores':
        return { expansionStores: stores };
      case 'ExpansionStoreSave': {
        const made = {
          shopId: variables.shopId,
          name: 'Zari Abroad',
          currencyCode: 'USD',
          priceRate: variables.priceRate,
          copiedAt: null,
          lastCopy: null,
        };
        stores = [made];
        return { expansionStoreSave: { expansionStore: made, userErrors: [] } };
      }
      case 'ExpansionStoreCopy':
        stores = stores.map((each) => ({
          ...each,
          copiedAt: '2026-10-28T09:00:00Z',
          lastCopy: { created: 12, updated: 3, problems: 1 },
        }));
        return { expansionStoreCopy: { expansionStore: stores[0], userErrors: [] } };
      case 'ExpansionStoreRemove':
        stores = [];
        return { expansionStoreRemove: { userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
  // The member owns another shop besides this one.
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/auth/me') {
      return new Response(
        JSON.stringify({
          session: { id: 'ses_1', mfaVerified: true },
          shops: [
            presetAccess(role),
            { ...presetAccess('owner'), id: 'shop_2', name: 'Zari Abroad' },
          ],
          user: { id: 'usr_1', name: 'Sana', language: 'en' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return fake.fetcher(path, init);
  });
  return { ...fake, fetcher };
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('Expansion stores (CH-11, ADR-859)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("links the owner's other shop at a rate, copies to it, and stops", async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings');

    fireEvent.click(await screen.findByRole('link', { name: /Expansion stores/ }));
    expect(await screen.findByText('No expansion store yet.')).toBeTruthy();
    expect((screen.getByLabelText('Shop') as HTMLSelectElement).value).toBe('shop_2');
    type('Price rate', '0.0036');
    fireEvent.click(screen.getByRole('button', { name: 'Add the expansion store' }));
    expect(await screen.findByText('0.0036 USD for each PKR')).toBeTruthy();
    expect(sentOf(fake, 'ExpansionStoreSave')).toEqual([{ shopId: 'shop_2', priceRate: '0.0036' }]);
    expect(screen.getByText('Not copied yet.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Copy products to Zari Abroad' }));
    expect(await screen.findByText(/: 12 made, 3 updated, 1 not taken\.$/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Stop copying to Zari Abroad' }));
    await waitFor(() =>
      expect(sentOf(fake, 'ExpansionStoreRemove')).toEqual([{ shopId: 'shop_2' }]),
    );
    expect(await screen.findByText('No expansion store yet.')).toBeTruthy();
  });

  it('is kept by the owner alone', async () => {
    vi.stubGlobal('fetch', core('manager').fetcher);
    renderAdmin('/shop_1/settings');
    await screen.findByRole('link', { name: /Apps/ });
    expect(screen.queryByRole('link', { name: /Expansion stores/ })).toBeNull();
  });
});
