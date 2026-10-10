import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { LATER, fakeCore, press, renderAdmin, signedIn, type } from '../test-support';

const pkr = (amount: string) => ({ amount, currencyCode: 'PKR' });
const GODOWN = { id: 'loc_1', name: 'Faisalabad godown' };

function order(received: [number, number], status = 'OPEN') {
  return {
    id: 'po_1',
    name: 'PO-1',
    status,
    reference: 'INV-88',
    note: null,
    expectedOn: '2026-11-15',
    totalQuantity: 20,
    receivedQuantity: received[0] + received[1],
    totalCost: pkr('42004.00'),
    supplier: { id: 'sup_1', name: 'Nishat Mills', phone: '+923007654321' },
    location: GODOWN,
    closedAt: null,
    createdAt: LATER,
    lines: [
      {
        id: 'poli_1',
        productTitle: 'Khaddar suit',
        variantTitle: 'S',
        sku: 'KS-S',
        quantity: 12,
        received: received[0],
        unitCost: pkr('2100.00'),
        inventoryItem: { id: 'invi_1' },
      },
      {
        id: 'poli_2',
        productTitle: 'Khaddar suit',
        variantTitle: 'M',
        sku: 'KS-M',
        quantity: 8,
        received: received[1],
        unitCost: null,
        inventoryItem: { id: 'invi_2' },
      },
    ],
  };
}

/**
 * A fake core with one open purchase order from Nishat Mills, of which 12 small and 5 medium came
 * once received; a supplier of the shop's, and a product to order.
 */
function poCore(role: StaffRole) {
  let received: [number, number] = [0, 0];
  let status = 'OPEN';
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'PurchaseOrders':
        return {
          purchaseOrders: {
            nodes:
              variables.status === status
                ? [
                    {
                      ...order(received, status),
                      lines: undefined,
                    },
                  ]
                : [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      case 'PurchaseOrder':
        return { purchaseOrder: variables.id === 'po_1' ? order(received, status) : null };
      case 'PurchaseOrderForm':
        return {
          suppliers: [{ id: 'sup_1', name: 'Nishat Mills', phone: null }],
          locations: { nodes: [{ ...GODOWN, isPrimary: true }] },
        };
      case 'SupplierCreate':
        return { supplierCreate: { supplier: { id: 'sup_2', name: 'Gul Ahmed' }, userErrors: [] } };
      case 'StockSearch':
        return {
          products: {
            nodes: [
              {
                id: 'prod_1',
                title: 'Khaddar suit',
                variants: [
                  {
                    id: 'var_1',
                    title: 'S',
                    sku: 'KS-S',
                    barcode: null,
                    inventoryQuantity: 0,
                    inventoryItem: { id: 'invi_1', tracked: true },
                  },
                ],
              },
            ],
          },
        };
      case 'StockCountFind':
        return {
          products: {
            nodes:
              variables.query === 'sku:"KS-M"'
                ? [
                    {
                      id: 'prod_1',
                      title: 'Khaddar suit',
                      variants: [
                        {
                          id: 'var_2',
                          title: 'M',
                          sku: 'KS-M',
                          barcode: null,
                          inventoryItem: { id: 'invi_2', inventoryLevel: null },
                        },
                      ],
                    },
                  ]
                : [],
          },
        };
      case 'PurchaseOrderCreate':
        return { purchaseOrderCreate: { purchaseOrder: { id: 'po_1' }, userErrors: [] } };
      case 'PurchaseOrderReceive':
        received = [12, 5];
        return { purchaseOrderReceive: { purchaseOrder: { id: 'po_1', status }, userErrors: [] } };
      case 'PurchaseOrderClose':
        status = 'CLOSED';
        return { purchaseOrderClose: { purchaseOrder: { id: 'po_1' }, userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof poCore>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('Purchase orders (INV-05)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('orders goods from a new supplier, each line with how many and what one costs', async () => {
    const fake = poCore('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/purchase-orders/new');

    const supplier = (await screen.findByLabelText('Supplier')) as HTMLSelectElement;
    fireEvent.change(supplier, { target: { value: '+new' } });
    type("Supplier's name", 'Gul Ahmed');
    type("Supplier's mobile number", '0300 1112223');
    await press('Add the supplier');
    expect(sentOf(fake, 'SupplierCreate')).toEqual([
      { input: { name: 'Gul Ahmed', phone: '0300 1112223' } },
    ]);
    expect((screen.getByLabelText('Goods go to') as HTMLSelectElement).value).toBe('loc_1');
    type("Supplier's number", 'INV-88');
    type('Expected on', '2026-11-15');

    type('Find products to order', 'khaddar');
    await press('Find');
    fireEvent.click(await screen.findByRole('button', { name: 'Order Khaddar suit · S' }));
    expect(screen.getByRole('button', { name: 'Order Khaddar suit · S' })).toHaveProperty(
      'disabled',
      true,
    );
    type('How many of Khaddar suit · S', '12');
    type('Cost of one Khaddar suit · S', '21,00');
    expect(screen.getByText('Write an amount, like 1450 or 1450.50.')).toBeTruthy();
    type('Cost of one Khaddar suit · S', '2100');
    await press('Save the purchase order');
    await waitFor(() =>
      expect(sentOf(fake, 'PurchaseOrderCreate')).toEqual([
        {
          input: {
            supplierId: 'sup_2',
            locationId: 'loc_1',
            reference: 'INV-88',
            expectedOn: '2026-11-15',
            lines: [{ inventoryItemId: 'invi_1', quantity: 12, unitCost: '2100' }],
          },
        },
      ]),
    );
    expect(await screen.findByRole('heading', { name: 'PO-1' })).toBeTruthy();
  });

  it('receives what came, by count, all at once or scanned box by box, and closes the order once sure', async () => {
    const fake = poCore('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/purchase-orders');

    const link = await screen.findByRole('link', { name: /PO-1 · Nishat Mills/ });
    expect(link.textContent).toContain('0 of 20 came');
    expect(link.textContent).toContain('expected');
    fireEvent.click(link);
    expect(await screen.findByRole('heading', { name: 'PO-1' })).toBeTruthy();
    expect(screen.getByText('Rs 42,004')).toBeTruthy();

    const receive = screen.getByRole('heading', { name: 'Goods that came' }).parentElement!;
    await press('All that is still to come');
    const small = within(receive).getByLabelText('Came of Khaddar suit · S') as HTMLInputElement;
    const medium = within(receive).getByLabelText('Came of Khaddar suit · M') as HTMLInputElement;
    expect([small.value, medium.value]).toEqual(['12', '8']);
    fireEvent.change(medium, { target: { value: '9' } });
    expect(
      within(receive).getByRole('button', { name: /^Receive \d+ into stock$/ }),
    ).toHaveProperty('disabled', true);
    fireEvent.change(medium, { target: { value: '4' } });
    // A box scanned or typed by its SKU is one more of its line.
    type('Barcode or SKU', 'KS-M');
    await press('Add');
    await waitFor(() => expect(medium.value).toBe('5'));
    type('Barcode or SKU', 'NOPE');
    await press('Add');
    expect(
      await within(receive).findByText('Nothing on this order has the barcode or SKU NOPE.'),
    ).toBeTruthy();

    await press('Receive 17 into stock');
    expect(await screen.findByText('17 received into stock at Faisalabad godown.')).toBeTruthy();
    expect(sentOf(fake, 'PurchaseOrderReceive')).toEqual([
      {
        id: 'po_1',
        input: {
          lines: [
            { lineId: 'poli_1', quantity: 12 },
            { lineId: 'poli_2', quantity: 5 },
          ],
        },
      },
    ]);
    // Only the medium is still to come.
    await waitFor(() =>
      expect(within(receive).queryByLabelText('Came of Khaddar suit · S')).toBeNull(),
    );
    expect(within(receive).getByText('3 still to come')).toBeTruthy();

    await press('Close the order');
    await press('Keep it open');
    expect(sentOf(fake, 'PurchaseOrderClose')).toEqual([]);
    await press('Close the order');
    expect(screen.getByText("Close PO-1? What hasn't come is no longer expected.")).toBeTruthy();
    await press('Close it');
    await waitFor(() => expect(sentOf(fake, 'PurchaseOrderClose')).toEqual([{ id: 'po_1' }]));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Goods that came' })).toBeNull(),
    );
    expect(screen.getAllByText('Closed').length).toBeGreaterThan(0);
  });

  it('shows purchase orders to a packer without changing them', async () => {
    vi.stubGlobal('fetch', poCore('packer').fetcher);
    renderAdmin('/shop_1/purchase-orders');
    await screen.findByRole('link', { name: /PO-1/ });
    expect(screen.queryByRole('link', { name: 'New purchase order' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Closed' }));
    expect(await screen.findByText('None here yet.')).toBeTruthy();
    cleanup();

    renderAdmin('/shop_1/purchase-orders/po_1');
    expect(await screen.findByRole('heading', { name: 'PO-1' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Goods that came' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close the order' })).toBeNull();
  });
});
