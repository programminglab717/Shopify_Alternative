import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

const KITS = [
  {
    kit: 'FASHION',
    collections: [
      { title: 'New arrivals', handle: 'new-arrivals', tag: null },
      { title: 'Lawn', handle: 'lawn', tag: 'lawn' },
    ],
    sizeCharts: ['Kameez (women)'],
  },
  {
    kit: 'JEWELLERY',
    collections: [{ title: 'Bangles', handle: 'bangles', tag: 'bangles' }],
    sizeCharts: [],
  },
];

function core(collections: unknown[]) {
  return fakeCore('owner', (operation) => {
    switch (operation) {
      case 'Collections':
        return { collections: { nodes: collections } };
      case 'StarterKits':
        return { starterKits: KITS };
      case 'StarterKitApply':
        return {
          starterKitApply: {
            collectionsMade: 2,
            collectionsKept: 0,
            sizeChartsMade: 1,
            menuLinksAdded: 2,
          },
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe('Starter kits on the collections page (ONB-13, ADR-486)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('offers a new shop a kit for what it sells, says what it sets up, and applies it', async () => {
    const fake = core([]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/collections');

    expect(await screen.findByText('New arrivals, Lawn, Kameez (women) size chart')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('You sell'), { target: { value: 'JEWELLERY' } });
    expect(screen.getByText('Bangles')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('You sell'), { target: { value: 'FASHION' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set it up' }));
    await waitFor(() =>
      expect(
        fake.sent
          .filter((each) => each.operation === 'StarterKitApply')
          .map((each) => each.variables),
      ).toEqual([{ kit: 'FASHION' }]),
    );
    expect(
      await screen.findByText(
        /Made 2 collections and 1 size charts, and added 2 links to your main menu\./,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set it up' })).toBeNull();
  });

  it('offers no kit to a shop that has its collections', async () => {
    const collection = (id: string) => ({ id, title: id, productsCount: 1, ruleSet: null });
    vi.stubGlobal('fetch', core([collection('a'), collection('b'), collection('c')]).fetcher);
    renderAdmin('/shop_1/collections');
    expect(await screen.findByText('a')).toBeTruthy();
    expect(screen.queryByText('Start with a kit for what you sell')).toBeNull();
  });
});
