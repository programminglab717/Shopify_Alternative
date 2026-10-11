import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { transferOf } from '../stock/stock-changes';
import { LATER, fakeCore, press, renderAdmin, signedIn, type } from '../test-support';

const GODOWN = { id: 'loc_1', name: 'Faisalabad godown' };
const STORE = { id: 'loc_2', name: 'Karachi store' };

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

  it("links a stock change to its transfer, by the ledger's reference", () => {
    expect(transferOf({ referenceDocumentUri: 'hatti://transfers/invt_01abc' })).toBe('invt_01abc');
    expect(transferOf({ referenceDocumentUri: 'hatti://purchase-orders/po_01abc' })).toBeNull();
    expect(transferOf({ referenceDocumentUri: null })).toBeNull();
  });
});
