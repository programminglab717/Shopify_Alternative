import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CourierCityMatchValue } from '../api/types';
import { fakeCore, LATER, press, renderAdmin, signedIn, type } from '../test-support';

const AGO = new Date(Date.now() - 3_600_000).toISOString();
const ACCOUNT = { id: 'acc_1', name: 'PostEx Lahore', courierName: 'PostEx', isDefault: true };
const AGAIN = "Give PostEx's name for the city, then book the order again";

function booking(
  id: string,
  orderId: string,
  orderName: string,
  status: string,
  error = null as string | null,
) {
  return {
    id,
    accountId: 'acc_1',
    orderId,
    orderName,
    courierName: 'PostEx',
    status,
    parcelStatus: null,
    trackingNumber: null,
    error,
    createdAt: AGO,
    bookedAt: null,
    codAmount: { amount: '5599.00', currencyCode: 'PKR' },
  };
}

/** The cities the orders go to, as their addresses write them: one with none. */
const CITIES: Record<string, string | null> = { ord_1: 'Gujran', ord_3: 'Lahore', ord_4: null };

function matchOf(city: string): CourierCityMatchValue {
  return city === 'Lahore'
    ? { city, courierCity: 'Lahore', source: 'LIST', suggestions: [], listError: null }
    : {
        city,
        courierCity: null,
        source: null,
        suggestions: ['Gujranwala', 'Gujrat'],
        listError: null,
      };
}

/**
 * A fake core with bookings that failed: #1001 for a city PostEx names otherwise, #1002 once but
 * waiting again since, #1003 for its own reasons, and #1004 to an address without a city; and
 * the shop's own names for two cities with the account.
 */
function cityCore() {
  return fakeCore('owner', (operation, variables) => {
    switch (operation) {
      case 'Shipping':
        return {
          shop: { timezone: 'Asia/Karachi' },
          courierAccounts: [ACCOUNT],
          courierBookings: {
            nodes: [
              booking('b5', 'ord_2', '#1002', 'PENDING'),
              booking(
                'b1',
                'ord_1',
                '#1001',
                'FAILED',
                `PostEx has no city named Gujran; its nearest: Gujranwala, Gujrat. ${AGAIN}`,
              ),
              booking('b2', 'ord_2', '#1002', 'FAILED', 'PostEx has no city named Pindi.'),
              booking('b3', 'ord_3', '#1003', 'FAILED', 'PostEx: Invalid phone number'),
              booking('b4', 'ord_4', '#1004', 'FAILED', "The order's address names no city"),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      case 'OrderCity': {
        const id = variables.id as string;
        const city = CITIES[id];
        return {
          order: { id, name: '#', shippingAddress: city === null ? null : { city } },
        };
      }
      case 'CourierCityMatch':
        return { courierCityMatch: matchOf(variables.city as string) };
      case 'CourierCityNameSet': {
        const input = variables.input as { city: string; courierCity: string | null };
        if (input.courierCity === 'Gujrnwala') {
          return {
            courierCityNameSet: {
              match: null,
              userErrors: [
                {
                  field: ['input', 'courierCity'],
                  code: 'INVALID',
                  message: "Gujrnwala is not on PostEx's list of cities",
                },
              ],
            },
          };
        }
        return {
          courierCityNameSet: {
            match: {
              city: input.city,
              courierCity: input.courierCity,
              source: input.courierCity ? 'SHOP' : 'LIST',
              suggestions: [],
              listError: null,
            },
            userErrors: [],
          },
        };
      }
      case 'OrdersBook':
        return {
          ordersBook: {
            bookings: [{ id: 'b9', orderName: '#' }],
            refused: [],
            userErrors: [],
          },
        };
      case 'CourierAccounts':
        return {
          couriers: [],
          courierAccounts: [
            {
              ...ACCOUNT,
              courier: 'postex',
              credentialsHint: 'f00d',
              pickupCode: null,
              createdAt: AGO,
            },
          ],
        };
      case 'CourierCityNames':
        return {
          courierAccounts: [ACCOUNT],
          courierCityNames: [
            { city: 'Isb', courierCity: 'Islamabad', updatedAt: AGO },
            { city: 'Pindi', courierCity: 'Rawalpindi', updatedAt: LATER },
          ],
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (core: ReturnType<typeof cityCore>, operation: string) =>
  core.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe("Couriers' names for cities in the admin", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("puts right a booking that failed for its city: the courier's name chosen, kept and booked again", async () => {
    const core = cityCore();
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/shipping?tab=booked');

    fireEvent.click(await screen.findByRole('button', { name: 'Fix #1001 and book it again' }));
    // #1002 failed once, but is waiting to be booked again since: nothing to put right.
    expect(screen.queryByRole('button', { name: 'Fix #1002 and book it again' })).toBeNull();

    await screen.findByText('PostEx has no city named Gujran.');
    expect(screen.getByLabelText('Gujranwala')).toHaveProperty('checked', true);
    expect(screen.getByLabelText('Gujrat')).toHaveProperty('checked', false);

    // A name not on PostEx's list is refused, and nothing is booked.
    fireEvent.click(screen.getByLabelText('Another name'));
    type("PostEx's name for Gujran", 'Gujrnwala');
    await press('Keep the name and book again');
    expect((await screen.findByRole('alert')).textContent).toBe(
      "Gujrnwala is not on PostEx's list of cities",
    );
    expect(sentOf(core, 'OrdersBook')).toHaveLength(0);

    fireEvent.click(screen.getByLabelText('Gujranwala'));
    await press('Keep the name and book again');
    await screen.findByText('#1001 sent to PostEx again. It is booked in a minute or so.');
    expect(sentOf(core, 'CourierCityNameSet').at(-1)).toEqual({
      input: { accountId: 'acc_1', city: 'Gujran', courierCity: 'Gujranwala' },
    });
    expect(sentOf(core, 'OrdersBook')).toEqual([{ ids: ['ord_1'], accountId: 'acc_1' }]);
    expect(screen.queryByText('PostEx has no city named Gujran.')).toBeNull();
  });

  it('books again an order whose city the courier knows, and sends one without a city to its page', async () => {
    const core = cityCore();
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/shipping?tab=booked');

    fireEvent.click(await screen.findByRole('button', { name: 'Fix #1003 and book it again' }));
    await screen.findByText('PostEx knows Lahore as Lahore.');
    expect(screen.getByText("That is on PostEx's list of cities.")).toBeTruthy();
    await press('Book again');
    await screen.findByText('#1003 sent to PostEx again. It is booked in a minute or so.');
    expect(sentOf(core, 'OrdersBook')).toEqual([{ ids: ['ord_3'], accountId: 'acc_1' }]);
    expect(sentOf(core, 'CourierCityNameSet')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Fix #1004 and book it again' }));
    const open = await screen.findByRole('link', { name: 'Open #1004' });
    expect(open.getAttribute('href')).toBe('/shop_1/orders/ord_4');
    expect(open.parentElement?.textContent).toContain(
      "The order's address names no city. Correct its address, then book it again.",
    );
    // An order without a city is not looked up.
    expect(new Set(sentOf(core, 'CourierCityMatch').map((each) => each.city))).toEqual(
      new Set(['Lahore']),
    );
  });

  it("lists the shop's own names for an account's cities, forgets one, and names a city looked up", async () => {
    const core = cityCore();
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/settings/couriers');

    fireEvent.click(await screen.findByRole('link', { name: 'City names' }));
    await screen.findByRole('heading', { name: 'City names with PostEx Lahore' });
    // The latest changed first.
    const rows = screen
      .getAllByRole('button', { name: /^Forget the name for / })
      .map((button) => button.closest('li')!);
    expect(rows.map((row) => row.firstElementChild?.textContent)).toEqual(['Pindi', 'Isb']);
    expect(within(rows[0]!).getByText('Rawalpindi')).toBeTruthy();

    await press('Forget the name for Pindi');
    await screen.findByText('The name for Pindi is forgotten.');
    expect(sentOf(core, 'CourierCityNameSet').at(-1)).toEqual({
      input: { accountId: 'acc_1', city: 'Pindi', courierCity: null },
    });

    type('A city, as orders write it', ' Gujran ');
    await press('Look it up');
    await screen.findByText('PostEx has no city named Gujran.');
    await press('Keep the name');
    await screen.findByText('From now on PostEx is given Gujranwala for Gujran.');
    expect(sentOf(core, 'CourierCityNameSet').at(-1)).toEqual({
      input: { accountId: 'acc_1', city: 'Gujran', courierCity: 'Gujranwala' },
    });
  });
});
