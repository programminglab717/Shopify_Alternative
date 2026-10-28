import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpinWheelValue } from '../api/types';
import { fakeCore, press, renderAdmin, signedIn, type } from '../test-support';

const OFF: SpinWheelValue = {
  enabled: false,
  slices: [],
  codeDays: 7,
  minimumSubtotal: null,
  spins: 0,
  codesUsed: 0,
  updatedAt: null,
};

const fill = (field: HTMLElement, value: string) => fireEvent.change(field, { target: { value } });

/** A fake core keeping the shop's wheel as the core would. */
function wheelCore(start: SpinWheelValue = OFF) {
  let wheel = { ...start };
  return fakeCore('marketer', (operation, variables) => {
    const input = (variables?.spinWheel ?? {}) as {
      enabled: boolean;
      slices: {
        label: string;
        kind: string;
        percentage?: number;
        amount?: string;
        weight: number;
      }[];
      codeDays: number;
      minimumSubtotal: string | null;
    };
    switch (operation) {
      case 'SpinWheel':
        return { spinWheel: wheel };
      case 'SpinWheelUpdate': {
        if (input.slices.some((slice) => slice.percentage === 150)) {
          return {
            spinWheelUpdate: {
              spinWheel: null,
              userErrors: [
                {
                  field: ['spinWheel', 'slices', '0', 'percentage'],
                  code: 'INVALID',
                  message: 'Percentage must be from 0.01 to 100, with two decimals at most',
                },
              ],
            },
          };
        }
        const rs = (text: string) => ({ amount: `${text.replace(/,/g, '')}.00` });
        wheel = {
          ...wheel,
          enabled: input.enabled,
          slices: input.slices.map((slice) => ({
            label: slice.label,
            kind: slice.kind as SpinWheelValue['slices'][number]['kind'],
            percentage: slice.percentage ?? null,
            amount: slice.amount ? rs(slice.amount) : null,
            weight: slice.weight,
          })),
          codeDays: input.codeDays,
          minimumSubtotal: input.minimumSubtotal ? rs(input.minimumSubtotal) : null,
          updatedAt: '2026-10-28T09:00:00Z',
        };
        return { spinWheelUpdate: { spinWheel: wheel, userErrors: [] } };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe('Spin to win in the admin (OS-08, ADR-900)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('starts from example slices, checks them, and turns the wheel on', async () => {
    const core = wheelCore();
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/marketing/spin-wheel');

    await screen.findByText('Slice 3');
    const fields = (label: string) => screen.getAllByLabelText(label) as HTMLInputElement[];
    expect(fields('Words on the wheel').map((field) => field.value)).toEqual([
      '10% off',
      'Free delivery',
      'Next time',
    ]);
    expect(screen.getByText('0 spins so far; 0 orders used their codes.')).toBeTruthy();

    // Checked here first, then by the core.
    fill(fields('Weight')[2]!, '0');
    await press('Save');
    await screen.findByText(
      'Give each slice its words and a weight from 1 to 100, and the days from 1 to 90.',
    );
    fill(fields('Weight')[2]!, '2');
    fill(fields('Percent off')[0]!, '150');
    await press('Save');
    await screen.findByText(/Percentage must be from 0.01 to 100/);

    fill(fields('Percent off')[0]!, '15');
    await press('Add a slice');
    fill(fields('Words on the wheel')[3]!, 'Rs 300 off');
    const kinds = screen.getAllByLabelText('Gives') as HTMLSelectElement[];
    fill(kinds[3]!, 'FIXED_AMOUNT');
    fill(await screen.findByLabelText('Amount off (Rs)'), '300');
    type('Order of at least (Rs)', '1,500');
    screen.getByRole('checkbox', { name: /Show the wheel/ }).click();
    await press('Save');
    await screen.findByText('Saved.');
    expect(
      core.sent.filter((each) => each.operation === 'SpinWheelUpdate').at(-1)?.variables,
    ).toEqual({
      spinWheel: {
        enabled: true,
        slices: [
          { label: '10% off', kind: 'PERCENTAGE', percentage: 15, weight: 1 },
          { label: 'Free delivery', kind: 'FREE_SHIPPING', weight: 1 },
          { label: 'Next time', kind: 'NONE', weight: 2 },
          { label: 'Rs 300 off', kind: 'FIXED_AMOUNT', amount: '300', weight: 1 },
        ],
        codeDays: 7,
        minimumSubtotal: '1,500',
      },
    });
    await waitFor(() =>
      expect((screen.getByLabelText('Order of at least (Rs)') as HTMLInputElement).value).toBe(
        '1500',
      ),
    );
  });

  it("shows the shop's own slices, and keeps two at fewest", async () => {
    vi.stubGlobal(
      'fetch',
      wheelCore({
        ...OFF,
        enabled: true,
        slices: [
          {
            label: 'Rs 500 off',
            kind: 'FIXED_AMOUNT',
            percentage: null,
            amount: { amount: '500.00' },
            weight: 1,
          },
          { label: 'So close', kind: 'NONE', percentage: null, amount: null, weight: 3 },
        ],
        spins: 12,
        codesUsed: 4,
      }).fetcher,
    );
    renderAdmin('/shop_1/marketing/spin-wheel');

    expect(await screen.findByText('12 spins so far; 4 orders used their codes.')).toBeTruthy();
    expect((screen.getByLabelText('Amount off (Rs)') as HTMLInputElement).value).toBe('500');
    expect(screen.queryByRole('button', { name: 'Remove slice 1' })).toBeNull();
    await press('Add a slice');
    expect(screen.getByRole('button', { name: 'Remove slice 3' })).toBeTruthy();
  });

  it('is linked from Marketing', async () => {
    vi.stubGlobal('fetch', wheelCore().fetcher);
    renderAdmin('/shop_1/marketing');
    const link = await screen.findByRole('link', { name: /Spin to win/ });
    expect(link.getAttribute('href')).toBe('/shop_1/marketing/spin-wheel');
  });
});
