import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PosCatalogItemValue, PosSessionValue } from '../api/types';
import { queued } from '../offline/outbox';
import { fakeCore, renderAdmin, signedIn } from '../test-support';
import { added, amountOf, byCode, matching, paisaOf, quickCash, totalsOf } from './cart';
import { receiptHtml, type ReceiptWords } from './receipt';

const SUIT: PosCatalogItemValue = {
  variantId: 'gid://hatti/ProductVariant/1',
  productTitle: 'Lawn Suit',
  variantTitle: 'M',
  sku: 'LS-M',
  barcode: '8964000123456',
  price: { amount: '3000.00' },
  available: 4,
};
const DUPATTA: PosCatalogItemValue = {
  variantId: 'gid://hatti/ProductVariant/2',
  productTitle: 'Chiffon Dupatta',
  variantTitle: 'Default Title',
  sku: null,
  barcode: null,
  price: { amount: '1500.00' },
  available: null,
};

describe("The till's sums and lookups (POS-01, ADR-872)", () => {
  it('counts in paisa, as the core does', () => {
    expect([paisaOf('3,000.50'), paisaOf('x'), amountOf(300050), amountOf(-5)]).toEqual([
      300050,
      0,
      '3000.50',
      '-0.05',
    ]);
    const cart = added(added(added([], SUIT), SUIT), DUPATTA);
    expect(cart.map((line) => [line.title, line.quantity, line.unitPrice])).toEqual([
      ['Lawn Suit', 2, 300000],
      ['Chiffon Dupatta', 1, 150000],
    ]);
    // A discount is never more than the items come to.
    expect(totalsOf(cart, 50000)).toEqual({ subtotal: 750000, discount: 50000, total: 700000 });
    expect(totalsOf(cart, 9_000_000).total).toBe(0);
  });

  it('finds an item by its barcode or SKU, or by every word of its name', () => {
    expect(byCode([SUIT, DUPATTA], ' 8964000123456 ')).toBe(SUIT);
    expect(byCode([SUIT, DUPATTA], 'ls-m')).toBe(SUIT);
    expect(byCode([SUIT, DUPATTA], 'nothing')).toBeNull();
    expect(matching([SUIT, DUPATTA], 'chiffon dup')).toEqual([DUPATTA]);
    expect(matching([SUIT, DUPATTA], '')).toEqual([SUIT, DUPATTA]);
  });

  it('offers the notes a shopper may hand over: the total, and round sums above it', () => {
    expect(quickCash(285000)).toEqual([285000, 290000, 300000, 500000]);
    // Exact: Rs 5,000 is the largest note.
    expect(quickCash(500000)).toEqual([500000]);
  });

  it('prints a receipt of what was sold, in what the shop wrote escaped', () => {
    const words: ReceiptWords = {
      receipt: 'Receipt',
      pending: '(to be numbered)',
      subtotal: 'Subtotal',
      discount: 'Discount',
      total: 'Total',
      taxIncluded: 'Sales tax included',
      change: 'Change',
      servedBy: 'Served by',
      thanks: 'Thank you!',
      methods: { CASH: 'Cash' },
    };
    const html = receiptHtml(
      {
        name: null,
        soldAt: '2026-10-28T10:00:00Z',
        lines: [{ title: 'Suit <b>', variantTitle: 'M', quantity: 2, total: 600000 }],
        subtotal: 600000,
        discount: 50000,
        tax: 0,
        total: 550000,
        tenders: [{ method: 'CASH', amount: 600000 }],
        change: 50000,
        cashier: 'Bilal',
      },
      { shopName: 'Zari', registerName: 'Counter 1', when: '28 Oct', words, rtl: false },
    );
    expect(html).toContain('2 × Suit &lt;b&gt;<br><small>M</small>');
    expect(html).toContain('Receipt (to be numbered) · 28 Oct');
    expect(html).toContain('<td>Change</td><td class="n">Rs 500</td>');
    expect(html).toContain('<tr class="strong"><td>Total</td><td class="n">Rs 5,500</td>');
    expect(html).toContain('<p class="foot">Served by: Bilal</p>');
  });
});

const amount = (value: string) => ({ amount: value });

/** What was sent of `operation`, in order. */
const sentOf = (fake: { sent: { operation: string; variables: unknown }[] }, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

function session(extra: Partial<PosSessionValue> = {}): PosSessionValue {
  return {
    id: 'pses_1',
    registerId: 'preg_1',
    openedAt: '2026-10-28T04:00:00Z',
    closedAt: null,
    openingFloat: amount('5000.00'),
    salesCount: 1,
    gross: amount('7500.00'),
    discounts: amount('500.00'),
    tax: amount('0.00'),
    returnsCount: 0,
    returned: amount('0.00'),
    tenders: [{ method: 'CASH', amount: amount('7000.00') }],
    cashIn: amount('0.00'),
    cashOut: amount('0.00'),
    ordersPaidCount: 0,
    ordersPaid: amount('0.00'),
    cashiers: [{ name: 'Bilal', salesCount: 1, total: amount('7000.00') }],
    expectedCash: amount('12000.00'),
    countedCash: null,
    difference: null,
    closingNote: null,
    ...extra,
  };
}

/** A fake core with the shop's registers, a catalog, and the session's sales, as the core answers. */
function core(options: { registers?: { id: string; openSessionId: string | null }[] } = {}) {
  let registers = (options.registers ?? []).map((each) => ({
    name: 'Counter 1',
    locationId: 'gid://hatti/Location/1',
    ...each,
  }));
  let sales = 0;
  return fakeCore('owner', (operation, variables) => {
    switch (operation) {
      case 'PosRegisters':
        return { posRegisters: registers };
      case 'Locations':
        return {
          locations: {
            nodes: [{ id: 'gid://hatti/Location/1', name: 'Gulberg shop', isPrimary: true }],
          },
        };
      case 'PosRegisterSave': {
        const input = variables.input as { name: string; locationId: string };
        const register = { id: 'preg_1', openSessionId: null, ...input };
        registers = [register];
        return { posRegisterSave: { register, userErrors: [] } };
      }
      case 'PosSessionOpen':
        registers = registers.map((each) => ({ ...each, openSessionId: 'pses_1' }));
        return { posSessionOpen: { session: session({ salesCount: 0 }), userErrors: [] } };
      case 'PosCatalog':
        return { posCatalog: [SUIT, DUPATTA] };
      case 'PosSaleCreate':
        sales += 1;
        return {
          posSaleCreate: {
            sale: {
              id: `psal_${sales}`,
              name: `#P${sales}`,
              clientId: (variables.input as { clientId: string }).clientId,
              customerId: null,
              subtotal: amount('7500.00'),
              discount: amount('500.00'),
              tax: amount('0.00'),
              total: amount('7000.00'),
              changeGiven: amount('3000.00'),
              returned: amount('0.00'),
              note: '',
              soldAt: '2026-10-28T10:00:00Z',
              lines: [],
              tenders: [],
            },
            userErrors: [],
          },
        };
      case 'PosSession':
        return { posSession: session() };
      case 'PosSales':
        return {
          posSales: {
            nodes: [
              {
                id: 'psal_1',
                name: '#P1',
                clientId: 'c1',
                customerId: null,
                subtotal: amount('6000.00'),
                discount: amount('0.00'),
                tax: amount('0.00'),
                total: amount('6000.00'),
                changeGiven: amount('0.00'),
                returned: amount('0.00'),
                note: '',
                soldAt: '2026-10-28T10:00:00Z',
                lines: [
                  {
                    id: 'psln_1',
                    title: 'Lawn Suit',
                    variantTitle: 'M',
                    sku: 'LS-M',
                    quantity: 2,
                    unitPrice: amount('3000.00'),
                    total: amount('6000.00'),
                    returnedQuantity: 0,
                  },
                ],
                tenders: [{ method: 'CASH', amount: amount('6000.00'), reference: null }],
              },
            ],
          },
        };
      case 'PosPin':
        return { posPin: { set: false, name: null } };
      case 'PosPinSet':
        return { posPinSet: { pin: { set: true, name: variables.name }, userErrors: [] } };
      case 'PosCashierSignIn':
        return variables.pin === '58203'
          ? {
              posCashierSignIn: {
                cashier: { name: 'Bilal', token: 'sealed', expiresAt: '2999-01-01T00:00:00Z' },
                userErrors: [],
              },
            }
          : {
              posCashierSignIn: {
                cashier: null,
                userErrors: [
                  { field: ['pin'], code: 'INVALID', message: 'No member of staff has this PIN' },
                ],
              },
            };
      case 'PosPickups':
        return {
          posPickups: [
            {
              orderId: 'gid://hatti/Order/7',
              name: '#1043',
              customerName: 'Ayesha Khan',
              total: amount('2500.00'),
              owed: amount('2500.00'),
              ready: true,
            },
            {
              orderId: 'gid://hatti/Order/8',
              name: '#1044',
              customerName: null,
              total: amount('900.00'),
              owed: amount('0.00'),
              ready: false,
            },
          ],
        };
      case 'PosPickupHandOver':
        return {
          posPickupHandOver: {
            orderId: variables.orderId,
            paid: amount('2500.00'),
            userErrors: [],
          },
        };
      case 'PosOrderCreate':
        return {
          posOrderCreate: {
            order: {
              id: 'gid://hatti/Order/9',
              name: '#1045',
              total: amount('3000.00'),
              paid: amount('1000.00'),
            },
            userErrors: [],
          },
        };
      case 'PosSaleReturn':
        return { posSaleReturn: { sale: { id: 'psal_1' }, userErrors: [] } };
      case 'PosCashMove':
        return {
          posCashMove: { session: session({ cashOut: amount('2000.00') }), userErrors: [] },
        };
      case 'PosSessionClose':
        return {
          posSessionClose: {
            session: session({
              closedAt: '2026-10-28T18:00:00Z',
              countedCash: amount('11800.00'),
              difference: amount('-200.00'),
            }),
            userErrors: [],
          },
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe("The shop's till in the admin (POS-01, POS-02, POS-07, ADR-872)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('adds a register, opens it with its float, and sells by name and by scanner, with change', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/pos');

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Counter 1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a register' }));
    fireEvent.change(await screen.findByLabelText('Cash in the drawer'), {
      target: { value: '5,000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open the register' }));
    await waitFor(() =>
      expect(sentOf(fake, 'PosSessionOpen')).toEqual([
        { registerId: 'preg_1', openingFloat: '5,000' },
      ]),
    );

    // By name, then by scanning the suit's barcode: a second suit.
    fireEvent.click(await screen.findByRole('button', { name: 'Add Chiffon Dupatta' }));
    const search = screen.getByLabelText('Search or scan');
    fireEvent.change(search, { target: { value: '8964000123456' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    fireEvent.change(search, { target: { value: 'LS-M' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    const cart = screen.getByRole('list', { name: 'Sale' });
    expect(within(cart).getByText('2 × Rs 3,000')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Discount (Rs, off the sale)'), {
      target: { value: '500' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Charge Rs 7,000' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rs 10,000' }));
    expect(screen.getByText('Change: Rs 3,000')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Complete the sale' }));

    expect(await screen.findByRole('heading', { name: 'Sold: #P1' })).toBeTruthy();
    expect(screen.getByText('Give change: Rs 3,000')).toBeTruthy();
    const [sent] = sentOf(fake, 'PosSaleCreate') as { input: Record<string, unknown> }[];
    expect(sent!.input).toMatchObject({
      sessionId: 'pses_1',
      lines: [
        { variantId: DUPATTA.variantId, quantity: 1 },
        { variantId: SUIT.variantId, quantity: 2 },
      ],
      discount: '500.00',
      tenders: [{ method: 'CASH', amount: '10000.00' }],
    });
    expect(sent!.input.clientId).toMatch(/^[0-9a-f-]{36}$/);

    // The receipt prints in a tab of its own.
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
    };
    vi.stubGlobal('open', () => tab);
    fireEvent.click(screen.getByRole('button', { name: 'Print the receipt' }));
    expect(written[0]).toContain('Receipt #P1');
    fireEvent.click(screen.getByRole('button', { name: 'New sale' }));
    expect(screen.getByText('Add items to start a sale.')).toBeTruthy();
  });

  it('keeps a sale made offline on the device, to send once it is back', async () => {
    const fake = core({ registers: [{ id: 'preg_1', openSessionId: 'pses_1' }] });
    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
      if (String(init?.body ?? '').includes('PosSaleCreate')) {
        throw new TypeError('Failed to fetch');
      }
      return fake.fetcher(path, init);
    });
    renderAdmin('/shop_1/pos');
    fireEvent.click(await screen.findByRole('button', { name: 'Add Lawn Suit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Charge Rs 3,000' }));
    fireEvent.click(screen.getByRole('button', { name: 'Card' }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete the sale' }));
    expect(await screen.findByRole('heading', { name: 'Sold, kept on this device' })).toBeTruthy();
    expect(queued().map((each) => each.operation)).toEqual(['PosSaleCreate']);
    expect(queued()[0]!.variables).toMatchObject({
      input: { tenders: [{ method: 'CARD', amount: '3000.00' }] },
    });
  });

  it('shows the Z report, records cash taken out, takes a return, and closes with the drawer short', async () => {
    const fake = core({ registers: [{ id: 'preg_1', openSessionId: 'pses_1' }] });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/pos');
    fireEvent.click(await screen.findByRole('tab', { name: 'Register' }));
    expect(await screen.findByText('Cash the drawer should hold')).toBeTruthy();
    expect(screen.getByText('Rs 12,000')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Amount (Rs)'), { target: { value: '2,000' } });
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'Banked' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record it' }));
    await waitFor(() =>
      expect(sentOf(fake, 'PosCashMove')).toEqual([
        { sessionId: 'pses_1', out: true, amount: '2,000', note: 'Banked' },
      ]),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Take a return of #P1' }));
    fireEvent.change(screen.getByLabelText('Lawn Suit: how many back (of 2)'), {
      target: { value: '1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Pay back' }));
    await waitFor(() =>
      expect(sentOf(fake, 'PosSaleReturn')).toEqual([
        {
          input: {
            saleId: 'psal_1',
            sessionId: 'pses_1',
            lines: [{ lineId: 'psln_1', quantity: 1 }],
            restock: true,
            method: 'CASH',
          },
        },
      ]),
    );

    fireEvent.change(screen.getByLabelText('Cash counted in the drawer'), {
      target: { value: '11,800' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close and print the Z report' }));
    expect(await screen.findByRole('heading', { name: 'Register closed' })).toBeTruthy();
    expect(screen.getByText('The drawer is Rs 200 short.')).toBeTruthy();
  });

  it('hands over a click-and-collect order, collecting what it owes (POS-06, ADR-873)', async () => {
    const fake = core({ registers: [{ id: 'preg_1', openSessionId: 'pses_1' }] });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/pos');
    fireEvent.click(await screen.findByRole('tab', { name: 'Pickups' }));
    // One not confirmed waits; the other is handed over, its money collected.
    const waiting = await screen.findByRole('button', { name: 'Hand over #1044' });
    expect((waiting as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Waits for the customer to confirm, or for its payment.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('What they owe, paid by'), {
      target: { value: 'WALLET' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Hand over #1043' }));
    expect(await screen.findByText('#1043 handed over, Rs 2,500 paid.')).toBeTruthy();
    expect(sentOf(fake, 'PosPickupHandOver')).toEqual([
      { sessionId: 'pses_1', orderId: 'gid://hatti/Order/7', method: 'WALLET' },
    ]);
  });

  it('sends the cart to the customer’s home, its advance paid at the till (POS-08)', async () => {
    const fake = core({ registers: [{ id: 'preg_1', openSessionId: 'pses_1' }] });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/pos');
    fireEvent.click(await screen.findByRole('button', { name: 'Add Lawn Suit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send to their home' }));
    fireEvent.change(screen.getByLabelText('Customer’s name'), { target: { value: 'Ayesha' } });
    fireEvent.change(screen.getByLabelText('Mobile number'), {
      target: { value: '0300 7654321' },
    });
    fireEvent.change(screen.getByLabelText('House and street'), {
      target: { value: 'House 12, Street 4' },
    });
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Karachi' } });
    fireEvent.change(screen.getByLabelText('Paid'), { target: { value: 'ADVANCE' } });
    fireEvent.change(screen.getByLabelText('Advance paid now (Rs)'), {
      target: { value: '1,000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Place the order' }));
    expect(await screen.findByRole('heading', { name: 'Order #1045 placed' })).toBeTruthy();
    expect(screen.getByText('#1045 ships from the shop’s stock; Rs 1,000 paid now.')).toBeTruthy();
    expect(sentOf(fake, 'PosOrderCreate')).toEqual([
      {
        input: {
          sessionId: 'pses_1',
          lines: [{ variantId: SUIT.variantId, quantity: 1 }],
          address: {
            name: 'Ayesha',
            phone: '0300 7654321',
            address1: 'House 12, Street 4',
            city: 'Karachi',
          },
          payment: 'ADVANCE',
          advance: '1,000',
          method: 'CASH',
        },
      },
    ]);
  });

  it('signs a cashier in with their PIN, each sale then naming them (POS-07, ADR-874)', async () => {
    const fake = core({ registers: [{ id: 'preg_1', openSessionId: 'pses_1' }] });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/pos');
    expect(await screen.findByText('No cashier signed in')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with your PIN' }));
    fireEvent.change(screen.getByLabelText('PIN'), { target: { value: '1111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('No member of staff has this PIN')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('PIN'), { target: { value: '5820a3' } });
    expect((screen.getByLabelText('PIN') as HTMLInputElement).value).toBe('58203');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Cashier: Bilal')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add Lawn Suit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Charge Rs 3,000' }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete the sale' }));
    await screen.findByRole('heading', { name: 'Sold: #P1' });
    expect(sentOf(fake, 'PosSaleCreate')[0]).toMatchObject({
      input: { cashierToken: 'sealed' },
    });
  });

  it('sets a member’s own till PIN, and shows sales by cashier in the Z report', async () => {
    const fake = core({ registers: [{ id: 'preg_1', openSessionId: 'pses_1' }] });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/pos');
    fireEvent.click(await screen.findByRole('tab', { name: 'Register' }));
    expect(await screen.findByText('Bilal (1)')).toBeTruthy();
    const name = (await screen.findByLabelText('Name on the till')) as HTMLInputElement;
    expect(name.value).toBe('Sana');
    fireEvent.change(screen.getByLabelText('PIN'), { target: { value: '4071' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save the PIN' }));
    expect(await screen.findByText('Saved. Sign in at the till with it.')).toBeTruthy();
    expect(sentOf(fake, 'PosPinSet')).toEqual([{ pin: '4071', name: 'Sana' }]);
  });
});
