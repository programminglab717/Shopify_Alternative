import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { formatDateTime, localInput } from '../i18n/format';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

function product(status: string, publishAt: string | null) {
  return {
    id: 'prod_1',
    title: 'Eid Kurta',
    description: '',
    handle: 'eid-kurta',
    status,
    productType: null,
    vendor: null,
    tags: [],
    totalInventory: 0,
    tracksInventory: true,
    preorder: null,
    publishAt,
    options: [],
    media: [],
    variants: [
      {
        id: 'var_1',
        title: 'Default Title',
        price: { amount: '4999.00', currencyCode: 'PKR' },
        compareAtPrice: null,
        sku: null,
        taxCode: null,
        selectedOptions: [],
        inventoryQuantity: 0,
        soldLast30Days: 0,
        daysOfStockLeft: null,
        inventoryItem: {
          id: 'item_1',
          tracked: true,
          inventoryPolicy: 'DENY',
          inventoryLevels: [],
        },
      },
    ],
  };
}

function core(role: StaffRole, status: string, publishAt: string | null) {
  let current = publishAt;
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Product':
        return {
          location: { id: 'loc_1', name: 'Main location' },
          product: product(status, current),
        };
      case 'ProductSchedulePublish': {
        const wanted = variables.publishAt as string | null;
        if (wanted && new Date(wanted).getTime() < Date.now()) {
          return {
            productSchedulePublish: {
              product: null,
              userErrors: [
                {
                  field: ['publishAt'],
                  code: 'INVALID',
                  message: 'Give a time a minute ahead at least',
                },
              ],
            },
          };
        }
        current = wanted;
        return {
          productSchedulePublish: {
            product: { id: 'prod_1', status: 'DRAFT', publishAt: current },
            userErrors: [],
          },
        };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>) =>
  fake.sent
    .filter((each) => each.operation === 'ProductSchedulePublish')
    .map((each) => each.variables);
const inWords = (iso: string) => formatDateTime(iso, 'Asia/Karachi', 'en');

describe('A draft put on sale at a time ahead, on its page (CAT-17, ADR-441)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('sets the time a draft goes on sale, and says why a time was refused', async () => {
    const fake = core('owner', 'DRAFT', null);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    const box = (await screen.findByLabelText(/Put it on sale at a set time/)) as HTMLInputElement;
    expect(box.checked).toBe(false);
    const save = () => screen.getByRole('button', { name: 'Save time' }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    fireEvent.click(box);
    const field = screen.getByLabelText('Goes on sale at');
    fireEvent.change(field, { target: { value: localInput('2020-01-01T00:00:00Z') } });
    fireEvent.click(save());
    expect(await screen.findByText(/a minute ahead at least/)).toBeTruthy();

    const ahead = new Date(Date.now() + 3 * 86_400_000);
    ahead.setSeconds(0, 0);
    fireEvent.change(field, { target: { value: localInput(ahead.toISOString()) } });
    fireEvent.click(save());
    await waitFor(() =>
      expect(sentOf(fake).at(-1)).toEqual({ productId: 'prod_1', publishAt: ahead.toISOString() }),
    );
    expect(
      await screen.findByText(`Saved: it goes on sale ${inWords(ahead.toISOString())}`),
    ).toBeTruthy();
  });

  it('takes a time away, and is shown for drafts alone, to those who may change products', async () => {
    const at = new Date(Date.now() + 86_400_000).toISOString();
    const fake = core('manager', 'DRAFT', at);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');
    expect(await screen.findByText(`It goes on sale ${inWords(at)}.`)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Put it on sale at a set time/));
    fireEvent.click(screen.getByRole('button', { name: 'Save time' }));
    expect(
      await screen.findByText('No time set: it stays a draft until you put it on sale'),
    ).toBeTruthy();
    expect(sentOf(fake)).toEqual([{ productId: 'prod_1', publishAt: null }]);
    cleanup();

    vi.stubGlobal('fetch', core('owner', 'ACTIVE', null).fetcher);
    renderAdmin('/shop_1/products/prod_1');
    await screen.findByRole('heading', { name: 'Eid Kurta' });
    expect(screen.queryByLabelText(/Put it on sale at a set time/)).toBeNull();
    cleanup();

    vi.stubGlobal('fetch', core('marketer', 'DRAFT', at).fetcher);
    renderAdmin('/shop_1/products/prod_1');
    await screen.findByRole('heading', { name: 'Eid Kurta' });
    expect(screen.queryByLabelText(/Put it on sale at a set time/)).toBeNull();
  });
});
