import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { LATER, fakeCore, press, renderAdmin, signedIn, type } from '../test-support';

const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });

const line = (id: string, title: string, variantTitle: string, quantity: number) => ({
  id,
  productId: 'prod_1',
  variantId: `var_${id.slice(3)}`,
  title,
  variantTitle,
  sku: null,
  quantity,
  unitPrice: rupees('2500'),
  totalPrice: rupees(String(2500 * quantity)),
});

function order(fulfillments: unknown[], stage = 'TO_PACK') {
  return {
    shop: { timezone: 'Asia/Karachi' },
    paymentSessions: [],
    order: {
      id: 'ord_7',
      name: '#1007',
      createdAt: LATER,
      stage,
      status: 'OPEN',
      paymentMethod: 'CASH_ON_DELIVERY',
      financialStatus: 'PENDING',
      confirmationStatus: 'CONFIRMED',
      cancelReason: null,
      overPlanLimit: false,
      location: { id: 'loc_1', name: 'Main location' },
      note: null,
      tags: [],
      phone: '+923001234567',
      email: null,
      source: 'WEB',
      lineItems: [line('li_1', 'Lawn suit', 'M', 2), line('li_2', 'Dupatta', 'Default Title', 1)],
      subtotalPrice: rupees('7500'),
      totalShippingPrice: rupees('200'),
      totalDiscounts: rupees('0'),
      codFee: rupees('0'),
      totalPrice: rupees('7700'),
      amountPaid: rupees('0'),
      codAmount: rupees('7700'),
      customer: null,
      shippingAddress: {
        name: 'Ayesha',
        phone: '+923001234567',
        city: 'Lahore',
        formatted: ['House 4', 'Lahore'],
      },
      risk: null,
      assignee: null,
      amountRefunded: rupees('0'),
      advanceDue: rupees('0'),
      transferReceipts: [],
      customerLink: null,
      refunds: [],
      fulfillments,
      returns: [],
      events: { nodes: [] },
    },
  };
}

/** The shop's variants by barcode: both of the order's, and a kurta it has none of. */
const BY_CODE: Record<string, { id: string; item: string }> = {
  'LS-M': { id: 'var_1', item: 'invi_1' },
  '8901234': { id: 'var_2', item: 'invi_2' },
  'KURTA-L': { id: 'var_9', item: 'invi_9' },
};

/** An order to pack in the list. */
const listed = (id: string, name: string) => ({
  id,
  name,
  createdAt: LATER,
  stage: 'TO_PACK',
  paymentMethod: 'CASH_ON_DELIVERY',
  overPlanLimit: false,
  totalPrice: rupees('7700'),
  customer: null,
  shippingAddress: { name: 'Ayesha', city: 'Lahore' },
  risk: null,
  lineItems: [{ quantity: 3 }],
});

function core(role: StaffRole, toPack = [listed('ord_7', '#1007'), listed('ord_8', '#1008')]) {
  let packed = false;
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Order':
        return order([], packed ? 'TO_BOOK' : 'TO_PACK');
      case 'Locations':
        return { locations: { nodes: [{ id: 'loc_1', name: 'Main location', isPrimary: true }] } };
      case 'Orders':
        return {
          orders: {
            nodes: packed ? toPack.filter((each) => each.id !== 'ord_7') : toPack,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          orderStageCounts: [{ stage: 'TO_PACK', count: toPack.length }],
        };
      case 'StockCountFind': {
        const code = /"(.*)"/.exec(String(variables.query))![1]!;
        const found = BY_CODE[code];
        const byBarcode = String(variables.query).startsWith('barcode:');
        return {
          products: {
            nodes: found
              ? [
                  {
                    id: 'prod_1',
                    title: 'Found',
                    variants: [
                      {
                        id: found.id,
                        title: 'M',
                        sku: byBarcode ? null : code,
                        barcode: byBarcode ? code : null,
                        inventoryItem: { id: found.item, inventoryLevel: { onHand: 5 } },
                      },
                    ],
                  },
                ]
              : [],
          },
        };
      }
      case 'OrderMarkPacked':
        packed = true;
        return { orderMarkPacked: { userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe('An order packed by scanning (ADR-373)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('ticks off each item read, says what is not in the order or one too many, and packs it once all is there', async () => {
    const fake = core('packer');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    await screen.findByRole('button', { name: 'Pack by scanning' });
    await press('Pack by scanning');
    const panel = screen.getByRole('heading', {
      name: 'Scan what goes in the parcel',
    }).parentElement!;
    const pack = within(panel).getByRole('button', { name: 'Pack the order' });
    expect(pack).toHaveProperty('disabled', true);
    expect(within(panel).getByText('3 items still to scan')).toBeTruthy();

    const scan = async (code: string) => {
      type('Barcode or SKU', code);
      fireEvent.submit(within(panel).getByLabelText('Barcode or SKU').closest('form')!);
    };
    await scan('LS-M');
    expect(await within(panel).findByText('1 of 2')).toBeTruthy();
    // Not in the order: said, nothing ticked.
    await scan('KURTA-L');
    expect(await within(panel).findByText('KURTA-L is not in this order')).toBeTruthy();
    await scan('LS-M');
    expect(await within(panel).findByText('2 of 2')).toBeTruthy();
    // One too many of a line already full.
    await scan('LS-M');
    expect(await within(panel).findByText('All 2 of Lawn suit · M are already in')).toBeTruthy();
    expect(within(panel).getByText('1 item still to scan')).toBeTruthy();
    await scan('8901234');
    expect(await within(panel).findByText('Everything in the order is here.')).toBeTruthy();

    fireEvent.click(pack);
    await waitFor(() =>
      expect(fake.sent.filter((each) => each.operation === 'OrderMarkPacked')).toHaveLength(1),
    );
    // Then the next to pack, opened to scan (ADR-374).
    const next = await screen.findByRole('link', { name: 'Scan the next to pack: #1008' });
    expect(next.getAttribute('href')).toBe('/shop_1/orders/ord_8?scan=true');
  });

  it('works through the orders to pack from the list, opening each to scan, until none is left', async () => {
    const fake = core('packer', [listed('ord_7', '#1007')]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders?stage=TO_PACK');
    const start = await screen.findByRole('link', { name: 'Pack by scanning' });
    expect(start.getAttribute('href')).toBe('/shop_1/orders/ord_7?scan=true');
    cleanup();

    // Opened to scan at once; with the last packed, none is left.
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7?scan=true');
    const panel = (await screen.findByRole('heading', { name: 'Scan what goes in the parcel' }))
      .parentElement!;
    for (const code of ['LS-M', 'LS-M', '8901234']) {
      type('Barcode or SKU', code);
      fireEvent.submit(within(panel).getByLabelText('Barcode or SKU').closest('form')!);
      await within(panel).findByText(code === '8901234' ? '1 of 1' : /of 2/);
    }
    fireEvent.click(await within(panel).findByRole('button', { name: 'Pack the order' }));
    expect(await screen.findByText('Nothing more to pack.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Orders to pack' }).getAttribute('href')).toBe(
      '/shop_1/orders?stage=TO_PACK',
    );
  });
});
