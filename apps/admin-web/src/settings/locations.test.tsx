import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

/** Types into a field found by its label within part of the page. */
const typeIn = (scope: HTMLElement, label: string, value: string) =>
  fireEvent.change(within(scope).getByLabelText(label), { target: { value } });

function location(id: string, name: string, extra: object = {}) {
  return {
    id,
    name,
    isPrimary: false,
    isActive: true,
    fulfillsOnlineOrders: true,
    address: {
      address1: null,
      address2: null,
      city: null,
      province: null,
      zip: null,
      phone: null,
      formatted: [],
    },
    ...extra,
  };
}

function core(role: StaffRole) {
  let locations = [
    location('loc_1', 'Lahore warehouse', {
      isPrimary: true,
      address: {
        address1: '12 Mall Road',
        address2: null,
        city: 'Lahore',
        province: 'Punjab',
        zip: '54000',
        phone: '+923001234567',
        formatted: ['12 Mall Road', 'Lahore 54000', 'Punjab'],
      },
    }),
    location('loc_2', 'Karachi shop'),
  ];
  const ok = (field: string, changed: object | null) => ({
    [field]: { location: changed, userErrors: [] },
  });
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'ShopLocations':
        return { locations: { nodes: locations } };
      case 'LocationAdd': {
        const input = variables.input as { name: string; address: { city: string | null } };
        if (input.address.city === 'Atlantis') {
          return {
            locationAdd: {
              location: null,
              userErrors: [
                {
                  field: ['input', 'address', 'city'],
                  code: 'INVALID',
                  message: 'is not a city we know',
                },
              ],
            },
          };
        }
        const added = location('loc_3', input.name);
        locations = [...locations, added];
        return ok('locationAdd', added);
      }
      case 'LocationEdit': {
        const input = variables.input as { name: string; fulfillsOnlineOrders: boolean };
        locations = locations.map((each) =>
          each.id === variables.id
            ? { ...each, name: input.name, fulfillsOnlineOrders: input.fulfillsOnlineOrders }
            : each,
        );
        return ok(
          'locationEdit',
          locations.find((each) => each.id === variables.id)!,
        );
      }
      case 'LocationDeactivate':
        return {
          locationDeactivate: {
            location: null,
            userErrors: [
              {
                field: ['locationId'],
                code: 'HAS_STOCK',
                message: 'It holds stock: move it first',
              },
            ],
          },
        };
      case 'LocationDelete':
        locations = locations.filter((each) => each.id !== variables.locationId);
        return { locationDelete: { deletedLocationId: variables.locationId, userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe("The shop's locations", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists them, adds one with its address, and names a refusal', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings');

    fireEvent.click(await screen.findByRole('link', { name: /Locations/ }));
    expect(await screen.findByText('12 Mall Road, Lahore 54000, Punjab')).toBeTruthy();
    expect(screen.getByText('Primary')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete Lahore warehouse' })).toBeNull();

    const add = screen.getByRole('region', { name: 'Add a location' });
    typeIn(add, 'Name', 'Islamabad stockroom');
    typeIn(add, 'City', 'Atlantis');
    typeIn(add, 'Mobile for pickups', '0321 7654321');
    fireEvent.click(within(add).getByRole('button', { name: 'Add location' }));
    expect(await within(add).findByText('City: is not a city we know')).toBeTruthy();
    typeIn(add, 'City', 'Islamabad');
    fireEvent.click(within(add).getByRole('button', { name: 'Add location' }));
    expect(await within(add).findByText('Islamabad stockroom was added.')).toBeTruthy();
    expect(sentOf(fake, 'LocationAdd').at(-1)).toEqual({
      input: {
        name: 'Islamabad stockroom',
        fulfillsOnlineOrders: true,
        address: {
          address1: null,
          address2: null,
          city: 'Islamabad',
          province: null,
          zip: null,
          phone: '0321 7654321',
        },
      },
    });
    expect(await screen.findByText('Islamabad stockroom')).toBeTruthy();
  });

  it("edits one, says why it can't be taken out of use, and deletes another once asked", async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/locations');

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Karachi shop' }));
    const row = screen.getByRole('button', { name: 'Save location' }).closest('li')!;
    typeIn(row as HTMLElement, 'Name', 'Karachi Clifton shop');
    fireEvent.click(within(row as HTMLElement).getByLabelText(/^Fulfils online orders/));
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Save location' }));
    expect(await screen.findByText('Karachi Clifton shop')).toBeTruthy();
    expect(screen.getByText('Does not fulfil online orders')).toBeTruthy();
    expect(sentOf(fake, 'LocationEdit')[0]).toMatchObject({
      id: 'loc_2',
      input: { name: 'Karachi Clifton shop', fulfillsOnlineOrders: false },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Take out of use' }));
    expect(await screen.findByText('It holds stock: move it first')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Karachi Clifton shop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText('Karachi Clifton shop')).toBeNull());
    expect(sentOf(fake, 'LocationDelete')).toEqual([{ locationId: 'loc_2' }]);
  });
});
