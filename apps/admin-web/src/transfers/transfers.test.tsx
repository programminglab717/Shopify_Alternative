import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { transferOf } from '../stock/stock-changes';
import { startFromLow } from './new-transfer-page';
import { LATER, fakeCore, press, renderAdmin, signedIn, type } from '../test-support';

const GODOWN = { id: 'loc_1', name: 'Faisalabad godown' };
const STORE = { id: 'loc_2', name: 'Karachi store' };
const SHOP = { id: 'loc_3', name: 'Gulberg shop' };

/** A variant low at the store, with what each location has of it. */
function lowAt(
  variant: string,
  title: string,
  available: number,
  incoming: number,
  levels: [string, number][],
) {
  return {
    variantId: variant,
    variantTitle: title,
    productTitle: 'Khaddar suit',
    available,
    incoming,
    inventoryItem: {
      id: variant.replace('var_', 'invi_'),
      inventoryLevels: levels.map(([id, count]) => ({ available: count, location: { id } })),
    },
  };
}

const LOW_AT_STORE = {
  inventorySettings: { lowStockThreshold: 5 },
  inventoryLowStock: {
    nodes: [
      // Twice the mark less 1 there and 2 on the way: 7, of which the godown has 4.
      lowAt('var_1', 'S', 1, 2, [
        ['loc_1', 4],
        ['loc_2', 1],
        ['loc_3', 9],
      ]),
      lowAt('var_2', 'M', 0, 0, [
        ['loc_1', 20],
        ['loc_2', 0],
      ]),
      // None anywhere else.
      lowAt('var_3', 'L', 2, 0, [['loc_2', 2]]),
    ],
  },
};

function transfer(received: [number, number], status = 'IN_TRANSIT') {
  return {
    id: 'invt_1',
    name: 'T-1',
    status,
    reference: 'Bilty 4410',
    note: null,
    totalQuantity: 10,
    receivedQuantity: received[0] + received[1],
    origin: GODOWN,
    destination: STORE,
    closedAt: null,
    createdAt: LATER,
    lines: [
      ['invtl_1', 'S', 6, received[0], 'invi_1'],
      ['invtl_2', 'M', 4, received[1], 'invi_2'],
    ].map(([id, title, quantity, came, item]) => ({
      id,
      productTitle: 'Khaddar suit',
      variantTitle: title,
      sku: null,
      quantity,
      received: came,
      inventoryItem: { id: item },
    })),
  };
}

function transferCore(role: StaffRole, places = [GODOWN, STORE]) {
  let received: [number, number] = [0, 0];
  let status = 'IN_TRANSIT';
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Locations':
        return {
          locations: {
            nodes: places.map((place) => ({ ...place, isPrimary: place.id === GODOWN.id })),
          },
        };
      case 'InventoryTransfers':
        return {
          inventoryTransfers: {
            nodes:
              variables.status === status
                ? [
                    {
                      id: 'invt_1',
                      name: 'T-1',
                      status,
                      totalQuantity: 10,
                      receivedQuantity: received[0] + received[1],
                      origin: { name: GODOWN.name },
                      destination: { name: STORE.name },
                      createdAt: LATER,
                    },
                  ]
                : [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      case 'InventoryTransfer':
        return { inventoryTransfer: variables.id === 'invt_1' ? transfer(received, status) : null };
      case 'InventoryTransferDocument':
        return {
          inventoryTransferDocument: {
            html: `<p>T-1 to Karachi store, ${String(variables.language)}</p>`,
            title: 'Stock transfer T-1',
            fileName: 'transfer-1.html',
          },
        };
      case 'LowStockToSend':
        return variables.locationId === STORE.id
          ? LOW_AT_STORE
          : { ...LOW_AT_STORE, inventoryLowStock: { nodes: [] } };
      case 'LowStock':
        return {
          inventorySettings: { lowStockThreshold: 5 },
          inventoryLowStock: {
            nodes: (variables.locationId === STORE.id
              ? LOW_AT_STORE.inventoryLowStock.nodes
              : []
            ).map((each) => ({
              variantId: each.variantId,
              variantTitle: each.variantTitle,
              productId: 'prod_1',
              productTitle: each.productTitle,
              sku: null,
              available: each.available,
              incoming: each.incoming,
              lastSupplier: null,
              lastUnitCost: null,
              inventoryItem: { id: each.inventoryItem.id },
            })),
          },
        };
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
                    sku: null,
                    barcode: null,
                    inventoryQuantity: 6,
                    inventoryItem: { id: 'invi_1', tracked: true },
                  },
                ],
              },
            ],
          },
        };
      case 'InventoryTransferCreate':
        return {
          inventoryTransferCreate: { inventoryTransfer: { id: 'invt_1' }, userErrors: [] },
        };
      case 'InventoryTransferReceive':
        received = [6, 1];
        return {
          inventoryTransferReceive: { inventoryTransfer: { id: 'invt_1', status }, userErrors: [] },
        };
      case 'InventoryTransferCancel':
        status = 'CANCELLED';
        return { inventoryTransferCancel: { inventoryTransfer: { id: 'invt_1' }, userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof transferCore>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('Transfers between locations (INV-04)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('sends stock from the primary location to another, with the bilty number', async () => {
    const fake = transferCore('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/stock');
    fireEvent.click(await screen.findByRole('link', { name: 'Transfers' }));
    await screen.findByText(/T-1 · Faisalabad godown to Karachi store/);
    fireEvent.click(screen.getByRole('link', { name: 'Send stock' }));

    const from = (await screen.findByLabelText('From')) as HTMLSelectElement;
    const to = screen.getByLabelText('To') as HTMLSelectElement;
    expect([from.value, to.value]).toEqual(['loc_1', 'loc_2']);
    fireEvent.change(to, { target: { value: 'loc_1' } });
    expect(screen.getByText('Choose a different location to send it to.')).toBeTruthy();
    fireEvent.change(to, { target: { value: 'loc_2' } });
    type('Tracking or bilty number', 'Bilty 4410');
    type('Find products to send', 'khaddar');
    await press('Find');
    fireEvent.click(await screen.findByRole('button', { name: 'Send Khaddar suit · S' }));
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', false);
    type('How many of Khaddar suit · S', '0');
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true);
    type('How many of Khaddar suit · S', '6');
    await press('Send');
    await waitFor(() =>
      expect(sentOf(fake, 'InventoryTransferCreate')).toEqual([
        {
          input: {
            originId: 'loc_1',
            destinationId: 'loc_2',
            reference: 'Bilty 4410',
            lines: [{ inventoryItemId: 'invi_1', quantity: 6 }],
          },
        },
      ]),
    );
    expect(await screen.findByRole('heading', { name: 'T-1' })).toBeTruthy();
  });

  it('receives what arrived at the other end, and cancels the rest back where it left', async () => {
    const fake = transferCore('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/transfers/invt_1');

    expect(await screen.findByRole('heading', { name: 'T-1' })).toBeTruthy();
    expect(screen.getByText('On the way')).toBeTruthy();
    expect(screen.getByText('Bilty 4410')).toBeTruthy();
    const receive = screen.getByRole('heading', { name: 'Stock that arrived' }).parentElement!;
    expect(
      within(receive).getByText('Count what arrived; it goes into stock at Karachi store.'),
    ).toBeTruthy();
    await press('All that is on its way');
    const small = within(receive).getByLabelText('Arrived of Khaddar suit · S') as HTMLInputElement;
    const medium = within(receive).getByLabelText(
      'Arrived of Khaddar suit · M',
    ) as HTMLInputElement;
    expect([small.value, medium.value]).toEqual(['6', '4']);
    fireEvent.change(medium, { target: { value: '5' } });
    expect(within(receive).getByText('That is more than is on its way.')).toBeTruthy();
    fireEvent.change(medium, { target: { value: '1' } });
    await press('Receive 7 at Karachi store');
    expect(await screen.findByText('7 received into stock at Karachi store.')).toBeTruthy();
    expect(sentOf(fake, 'InventoryTransferReceive')).toEqual([
      {
        id: 'invt_1',
        input: {
          lines: [
            { lineId: 'invtl_1', quantity: 6 },
            { lineId: 'invtl_2', quantity: 1 },
          ],
        },
      },
    ]);
    await waitFor(() =>
      expect(within(receive).queryByLabelText('Arrived of Khaddar suit · S')).toBeNull(),
    );
    expect(within(receive).getByText('3 on the way')).toBeTruthy();

    await press('Cancel the transfer');
    expect(
      screen.getByText('Cancel T-1? The 3 that have not arrived go back to Faisalabad godown.'),
    ).toBeTruthy();
    await press('Keep it');
    expect(sentOf(fake, 'InventoryTransferCancel')).toEqual([]);
    await press('Cancel the transfer');
    await press('Cancel it');
    await waitFor(() =>
      expect(sentOf(fake, 'InventoryTransferCancel')).toEqual([{ id: 'invt_1' }]),
    );
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Stock that arrived' })).toBeNull(),
    );
    expect(screen.getByText('Cancelled')).toBeTruthy();
  });

  it('shows transfers to a packer without sending or receiving, and asks a shop of one location for another', async () => {
    vi.stubGlobal('fetch', transferCore('packer').fetcher);
    renderAdmin('/shop_1/transfers');
    await screen.findByText(/T-1 · Faisalabad godown to Karachi store/);
    expect(screen.getByText('0 of 10 arrived')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Send stock' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Received' }));
    expect(await screen.findByText('None here yet.')).toBeTruthy();
    cleanup();

    vi.stubGlobal('fetch', transferCore('packer').fetcher);
    renderAdmin('/shop_1/transfers/invt_1');
    await screen.findByRole('heading', { name: 'T-1' });
    expect(screen.queryByRole('heading', { name: 'Stock that arrived' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel the transfer' })).toBeNull();
    cleanup();

    vi.stubGlobal('fetch', transferCore('owner', [GODOWN]).fetcher);
    renderAdmin('/shop_1/transfers/new');
    expect(await screen.findByText('Add another location to send stock to it.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Add a location' }).getAttribute('href')).toBe(
      '/shop_1/settings/locations',
    );
  });

  it('sends what runs low at a branch from the location that has most of it (ADR-361)', async () => {
    const fake = transferCore('manager', [GODOWN, STORE, SHOP]);
    vi.stubGlobal('fetch', fake.fetcher);
    window.localStorage.setItem('hatti.ordersLocation.shop_1', 'loc_2');
    renderAdmin('/shop_1/stock');

    expect(await screen.findByText(/1 for sale · 2 on the way/)).toBeTruthy();
    const send = screen.getByRole('button', { name: 'Send the chosen from another location (0)' });
    expect(send).toHaveProperty('disabled', true);
    await press('Choose all');
    await press('Send the chosen from another location (3)');

    expect(await screen.findByText(/Filled in from what runs low at Karachi store/)).toBeTruthy();
    expect((screen.getByLabelText('From', { exact: true }) as HTMLSelectElement).value).toBe(
      'loc_1',
    );
    expect((screen.getByLabelText('To', { exact: true }) as HTMLSelectElement).value).toBe('loc_2');
    expect(screen.getByLabelText('How many of Khaddar suit · S')).toHaveProperty('value', '4');
    expect(screen.getByLabelText('How many of Khaddar suit · M')).toHaveProperty('value', '10');
    expect(screen.queryByLabelText('How many of Khaddar suit · L')).toBeNull();
    expect(
      screen.getByText(
        "1 of those chosen isn't available at Faisalabad godown; find it below to send from elsewhere.",
      ),
    ).toBeTruthy();
    await press('Send');
    await waitFor(() =>
      expect(sentOf(fake, 'InventoryTransferCreate')).toEqual([
        {
          input: {
            originId: 'loc_1',
            destinationId: 'loc_2',
            reference: null,
            lines: [
              { inventoryItemId: 'invi_1', quantity: 4 },
              { inventoryItemId: 'invi_2', quantity: 10 },
            ],
          },
        },
      ]),
    );
  });

  it('starts from the location that can send the most, the primary on a tie', () => {
    const places = [
      { id: 'loc_1', isPrimary: true },
      { id: 'loc_2', isPrimary: false },
      { id: 'loc_3', isPrimary: false },
    ];
    const start = startFromLow(LOW_AT_STORE, ['var_1', 'var_2', 'var_3'], 'loc_2', places);
    // The godown sends 4 + 10; the shop 7 of the small alone.
    expect(start).toMatchObject({ originId: 'loc_1', missing: 1 });
    expect(start!.lines.map((line) => [line.itemId, line.quantity])).toEqual([
      ['invi_1', '4'],
      ['invi_2', '10'],
    ]);
    // The small alone: the shop has all 7, the godown 4.
    expect(startFromLow(LOW_AT_STORE, ['var_1'], 'loc_2', places)).toMatchObject({
      originId: 'loc_3',
      lines: [{ itemId: 'invi_1', quantity: '7' }],
      missing: 0,
    });
    // The large: none anywhere else; the primary, with nothing to fill in.
    expect(startFromLow(LOW_AT_STORE, ['var_3'], 'loc_2', places)).toEqual({
      originId: 'loc_1',
      lines: [],
      missing: 1,
    });
    expect(startFromLow(LOW_AT_STORE, ['var_9'], 'loc_2', places)).toBeNull();
  });

  it('prints a transfer to go with the stock, in the language chosen, whoever looks (ADR-362)', async () => {
    const fake = transferCore('packer');
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
    renderAdmin('/shop_1/transfers/invt_1');

    const language = (await screen.findByLabelText('Language')) as HTMLSelectElement;
    fireEvent.change(language, { target: { value: 'URDU' } });
    await press('Print to go with the stock');
    await waitFor(() => expect(written).toEqual(['<p>T-1 to Karachi store, URDU</p>']));
    expect(tab.print).toHaveBeenCalled();
    expect(sentOf(fake, 'InventoryTransferDocument')).toEqual([{ id: 'invt_1', language: 'URDU' }]);
  });

  it("links a stock change to its transfer, by the ledger's reference", () => {
    expect(transferOf({ referenceDocumentUri: 'hatti://transfers/invt_01abc' })).toBe('invt_01abc');
    expect(transferOf({ referenceDocumentUri: 'hatti://purchase-orders/po_01abc' })).toBeNull();
    expect(transferOf({ referenceDocumentUri: null })).toBeNull();
  });
});
