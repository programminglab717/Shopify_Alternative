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
function poCore(role: StaffRole, start: [number, number] = [0, 0]) {
  let received: [number, number] = start;
  let status = 'OPEN';
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'PurchaseOrders':
        return {
          purchaseOrders: {
            nodes:
              variables.status === status && (variables.supplierId ?? 'sup_1') === 'sup_1'
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
      case 'Suppliers':
        return {
          suppliers: [
            { id: 'sup_1', name: 'Nishat Mills', phone: '+923007654321', note: null },
            { id: 'sup_9', name: 'Ajrak House', phone: null, note: 'Hala' },
          ],
        };
      case 'SupplierUpdate':
        return { supplierUpdate: { supplier: { id: 'sup_1' }, userErrors: [] } };
      case 'PurchaseOrderDocument':
        return {
          purchaseOrderDocument: {
            html: `<p>PO-1 for Nishat Mills, ${String(variables.language)}</p>`,
            title: 'Purchase order PO-1',
            fileName: 'purchase-order-1.html',
          },
        };
      case 'PurchaseOrderUpdate':
        return { purchaseOrderUpdate: { purchaseOrder: { id: 'po_1' }, userErrors: [] } };
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
                  {
                    id: 'var_3',
                    title: 'L',
                    sku: 'KS-L',
                    barcode: null,
                    inventoryQuantity: 0,
                    inventoryItem: { id: 'invi_3', tracked: true },
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
      case 'LowStock':
        return {
          inventorySettings: { lowStockThreshold: 5 },
          inventoryLowStock: {
            nodes: [
              ['var_1', 'S', -2, 0, 'Nishat Mills', '2100.00'],
              ['var_2', 'M', 3, 4, 'Nishat Mills', null],
              ['var_3', 'L', 2, 0, null, null],
            ].map(([id, title, available, incoming, from, cost], index) => ({
              variantId: id,
              variantTitle: title,
              productId: 'prod_1',
              productTitle: 'Khaddar suit',
              sku: null,
              available,
              incoming,
              lastSupplier: from ? { id: 'sup_1', name: from } : null,
              lastUnitCost: cost ? pkr(cost as string) : null,
              inventoryItem: { id: `invi_${index + 1}` },
            })),
          },
        };
      case 'Locations':
        return { locations: { nodes: [{ ...GODOWN, isPrimary: true, isActive: true }] } };
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
    expect(
      within(receive).getByText(
        "What each costs on this order becomes its cost, averaged with what's on hand.",
      ),
    ).toBeTruthy();
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

  it("keeps suppliers: one changed, one added, and one's orders alone", async () => {
    const fake = poCore('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/purchase-orders/suppliers');

    expect(await screen.findByText('Nishat Mills')).toBeTruthy();
    expect(screen.getByText('Hala')).toBeTruthy();
    await press('Change Nishat Mills');
    expect((screen.getByLabelText("Supplier's name") as HTMLInputElement).value).toBe(
      'Nishat Mills',
    );
    type('Note', 'Pays on delivery');
    await press('Save the supplier');
    await waitFor(() =>
      expect(sentOf(fake, 'SupplierUpdate')).toEqual([
        {
          id: 'sup_1',
          input: {
            name: 'Nishat Mills',
            phone: expect.stringMatching(/300/),
            note: 'Pays on delivery',
          },
        },
      ]),
    );
    await press('A new supplier');
    type("Supplier's name", 'Gul Ahmed');
    await press('Add the supplier');
    await waitFor(() =>
      expect(sentOf(fake, 'SupplierCreate')).toEqual([
        { input: { name: 'Gul Ahmed', phone: null, note: null } },
      ]),
    );

    fireEvent.click(await screen.findByRole('link', { name: 'Purchase orders from Ajrak House' }));
    expect(await screen.findByText('Orders from one supplier.')).toBeTruthy();
    expect(await screen.findByText('No goods are on their way from suppliers.')).toBeTruthy();
    expect(sentOf(fake, 'PurchaseOrders').at(-1)).toMatchObject({ supplierId: 'sup_9' });
  });

  it('changes an open order: no fewer than came, its cost, a line taken off and goods added', async () => {
    const fake = poCore('owner', [4, 0]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/purchase-orders/po_1');

    fireEvent.click(await screen.findByRole('button', { name: 'Change the order' }));
    expect(await screen.findByText('4 came already')).toBeTruthy();
    type('How many of Khaddar suit · S', '3');
    expect(screen.getByText('At least 4.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save the changes' })).toHaveProperty(
      'disabled',
      true,
    );
    type('How many of Khaddar suit · S', '10');
    expect((screen.getByLabelText('Cost of one Khaddar suit · S') as HTMLInputElement).value).toBe(
      '2100',
    );
    type('Cost of one Khaddar suit · S', '2000');
    // Some of the small came, so only the medium can be taken off.
    expect(screen.queryByRole('button', { name: 'Remove Khaddar suit · S' })).toBeNull();
    await press('Remove Khaddar suit · M');
    type('Find products to order', 'khaddar');
    await press('Find');
    expect(await screen.findByRole('button', { name: 'Order Khaddar suit · S' })).toHaveProperty(
      'disabled',
      true,
    );
    await press('Order Khaddar suit · L');
    type('How many of Khaddar suit · L', '3');
    await press('Save the changes');
    await waitFor(() =>
      expect(sentOf(fake, 'PurchaseOrderUpdate')).toEqual([
        {
          id: 'po_1',
          input: {
            reference: 'INV-88',
            expectedOn: '2026-11-15',
            note: '',
            linesToUpdate: [{ lineId: 'poli_1', quantity: 10, unitCost: '2000' }],
            lineIdsToRemove: ['poli_2'],
            linesToAdd: [{ inventoryItemId: 'invi_3', quantity: 3, unitCost: null }],
          },
        },
      ]),
    );
    expect(await screen.findByRole('heading', { name: 'Goods that came' })).toBeTruthy();
  });

  it('prints an order for its supplier, in the language chosen, whoever looks', async () => {
    const fake = poCore('packer');
    vi.stubGlobal('fetch', fake.fetcher);
    const written: string[] = [];
    const tab = {
      document: {
        open: vi.fn(),
        write: (html: string) => written.push(html),
        close: vi.fn(),
        fonts: { ready: Promise.resolve() },
      },
      focus: vi.fn(),
      print: vi.fn(),
      close: vi.fn(),
    };
    vi.stubGlobal(
      'open',
      vi.fn(() => tab),
    );
    renderAdmin('/shop_1/purchase-orders/po_1');

    const language = (await screen.findByLabelText('Language')) as HTMLSelectElement;
    fireEvent.change(language, { target: { value: 'URDU' } });
    await press('Print for the supplier');
    await waitFor(() => expect(written).toEqual(['<p>PO-1 for Nishat Mills, URDU</p>']));
    expect(tab.print).toHaveBeenCalled();
    expect(sentOf(fake, 'PurchaseOrderDocument')).toEqual([{ id: 'po_1', language: 'URDU' }]);
  });

  it('orders what runs low, chosen on the stock page, filled in from what is on order and came last', async () => {
    const fake = poCore('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/stock');

    expect(await screen.findByText(/Out of stock · last from Nishat Mills/)).toBeTruthy();
    expect(screen.getByText(/3 for sale · 4 on order · last from Nishat Mills/)).toBeTruthy();
    const order = screen.getByRole('button', { name: 'Order the chosen (0)' });
    expect(order).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Choose Khaddar suit · S to order' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Choose Khaddar suit · M to order' }));
    await press('Order the chosen (2)');

    expect(await screen.findByText(/Filled in from what runs low/)).toBeTruthy();
    expect((screen.getByLabelText('Supplier') as HTMLSelectElement).value).toBe('sup_1');
    expect(screen.getByLabelText('How many of Khaddar suit · S')).toHaveProperty('value', '12');
    expect(screen.getByLabelText('Cost of one Khaddar suit · S')).toHaveProperty('value', '2100');
    expect(screen.getByLabelText('How many of Khaddar suit · M')).toHaveProperty('value', '3');
    expect(screen.getByLabelText('Cost of one Khaddar suit · M')).toHaveProperty('value', '');
    expect(screen.queryByLabelText('How many of Khaddar suit · L')).toBeNull();
    await press('Save the purchase order');
    await waitFor(() =>
      expect(sentOf(fake, 'PurchaseOrderCreate')).toEqual([
        {
          input: {
            supplierId: 'sup_1',
            locationId: 'loc_1',
            reference: null,
            expectedOn: null,
            lines: [
              { inventoryItemId: 'invi_1', quantity: 12, unitCost: '2100' },
              { inventoryItemId: 'invi_2', quantity: 3, unitCost: null },
            ],
          },
        },
      ]),
    );
  });

  it('chooses all that runs low at once, and none for a packer', async () => {
    vi.stubGlobal('fetch', poCore('manager').fetcher);
    renderAdmin('/shop_1/stock');
    await screen.findByRole('button', { name: 'Choose all' });
    await press('Choose all');
    expect(screen.getByRole('button', { name: 'Order the chosen (3)' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(screen.queryByRole('button', { name: 'Choose all' })).toBeNull();
    cleanup();

    vi.stubGlobal('fetch', poCore('packer').fetcher);
    renderAdmin('/shop_1/stock');
    await screen.findByText(/Out of stock · last from Nishat Mills/);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Order the chosen/ })).toBeNull();
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
    expect(screen.queryByRole('button', { name: 'Change the order' })).toBeNull();
  });
});
