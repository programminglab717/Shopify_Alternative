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
    localPickupSettings: null as { instructions: string | null } | null,
    storefrontListed: false,
    openingHours: null as string | null,
    serves: { cities: [] as string[], provinceCodes: [] as string[] },
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
        const input = variables.input as {
          name: string;
          fulfillsOnlineOrders: boolean;
          storefrontListed?: boolean;
          openingHours?: string | null;
          serves?: { cities: string[]; provinces: string[] };
        };
        if (input.storefrontListed !== undefined) {
          if (variables.id === 'loc_2' && input.storefrontListed) {
            return {
              locationEdit: {
                location: null,
                userErrors: [
                  {
                    field: ['input', 'storefrontListed'],
                    code: 'INVALID',
                    message:
                      'Give the location its street address and city, for customers to find it',
                  },
                ],
              },
            };
          }
          locations = locations.map((each) =>
            each.id === variables.id
              ? {
                  ...each,
                  storefrontListed: input.storefrontListed!,
                  openingHours:
                    input.openingHours === undefined ? each.openingHours : input.openingHours,
                }
              : each,
          );
          return ok(
            'locationEdit',
            locations.find((each) => each.id === variables.id)!,
          );
        }
        locations = locations.map((each) =>
          each.id === variables.id
            ? {
                ...each,
                name: input.name,
                fulfillsOnlineOrders: input.fulfillsOnlineOrders,
                ...(input.serves && {
                  serves: {
                    cities: input.serves.cities,
                    provinceCodes: input.serves.provinces.map((each) =>
                      each === 'Sindh' ? 'SD' : each,
                    ),
                  },
                }),
              }
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
      case 'LocationMakePrimary':
        locations = locations.map((each) => ({
          ...each,
          isPrimary: each.id === variables.locationId,
        }));
        return ok(
          'locationMakePrimary',
          locations.find((each) => each.id === variables.locationId) ?? null,
        );
      case 'LocationLocalPickupEnable': {
        const settings = variables.settings as { locationId: string; instructions: string | null };
        if (settings.locationId === 'loc_2') {
          return {
            locationLocalPickupEnable: {
              location: null,
              userErrors: [
                {
                  field: ['localPickupSettings', 'locationId'],
                  code: 'INVALID',
                  message:
                    'Give the location its street address and city, for customers to find it',
                },
              ],
            },
          };
        }
        locations = locations.map((each) =>
          each.id === settings.locationId
            ? { ...each, localPickupSettings: { instructions: settings.instructions } }
            : each,
        );
        return ok(
          'locationLocalPickupEnable',
          locations.find((each) => each.id === settings.locationId)!,
        );
      }
      case 'LocationLocalPickupDisable':
        locations = locations.map((each) =>
          each.id === variables.locationId ? { ...each, localPickupSettings: null } : each,
        );
        return ok(
          'locationLocalPickupDisable',
          locations.find((each) => each.id === variables.locationId)!,
        );
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

  it('says where a location ships to first, its orders routed there (SHP-09, ADR-839)', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/locations');

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Karachi shop' }));
    const row = screen.getByRole('button', { name: 'Save location' }).closest('li')!;
    typeIn(row as HTMLElement, 'Cities it ships to first', 'Karachi, Hyderabad ,');
    typeIn(row as HTMLElement, 'Provinces it ships to first', 'Sindh');
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Save location' }));
    expect(await screen.findByText('Ships first to Karachi, Hyderabad, Sindh')).toBeTruthy();
    expect(sentOf(fake, 'LocationEdit')[0]).toMatchObject({
      id: 'loc_2',
      input: { serves: { cities: ['Karachi', 'Hyderabad'], provinces: ['Sindh'] } },
    });
    // Adding a location asks nothing of it: it ships anywhere until edited.
    expect(screen.queryAllByLabelText('Cities it ships to first')).toHaveLength(0);
  });

  it('makes another active location the primary one', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/locations');

    await screen.findByText('12 Mall Road, Lahore 54000, Punjab');
    expect(
      screen.queryByRole('button', { name: 'Make Lahore warehouse the primary location' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Make Karachi shop the primary location' }));
    await waitFor(() =>
      expect(sentOf(fake, 'LocationMakePrimary')).toEqual([{ locationId: 'loc_2' }]),
    );
    expect(
      await screen.findByRole('button', { name: 'Make Lahore warehouse the primary location' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete Lahore warehouse' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete Karachi shop' })).toBeNull();
  });

  it('lets customers pick up at a location with its address, changes what it says, and stops it (ADR-389)', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/locations');

    const [warehouse, shop] = await screen.findAllByRole('listitem');
    fireEvent.click(within(warehouse!).getByRole('button', { name: 'Let customers pick up here' }));
    typeIn(warehouse!, 'Pickup instructions', '  Ask at the counter  ');
    fireEvent.click(within(warehouse!).getByRole('button', { name: 'Start pickup' }));
    expect(await within(warehouse!).findByText('Customers can pick up orders here')).toBeTruthy();
    expect(within(warehouse!).getByText(/Ask at the counter/)).toBeTruthy();
    expect(sentOf(fake, 'LocationLocalPickupEnable')).toEqual([
      { settings: { locationId: 'loc_1', instructions: 'Ask at the counter' } },
    ]);

    // A location without its address says why.
    fireEvent.click(within(shop!).getByRole('button', { name: 'Let customers pick up here' }));
    fireEvent.click(within(shop!).getByRole('button', { name: 'Start pickup' }));
    expect(
      await within(shop!).findByText(
        'Give the location its street address and city, for customers to find it',
      ),
    ).toBeTruthy();

    fireEvent.click(within(warehouse!).getByRole('button', { name: 'Stop pickup here' }));
    await waitFor(() =>
      expect(within(warehouse!).queryByText('Customers can pick up orders here')).toBeNull(),
    );
    expect(sentOf(fake, 'LocationLocalPickupDisable')).toEqual([{ locationId: 'loc_1' }]);
  });

  it('shows a location on the store locator with its hours, changes them, and takes it off (ADR-831)', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/locations');

    const [warehouse, shop] = await screen.findAllByRole('listitem');
    fireEvent.click(within(warehouse!).getByRole('button', { name: 'Show on your store locator' }));
    typeIn(warehouse!, 'Opening hours', '  Mon–Sat 11am–9pm\nSunday closed  ');
    fireEvent.click(within(warehouse!).getByRole('button', { name: 'Show it' }));
    expect(
      await within(warehouse!).findByText('Shown on your online store’s store locator'),
    ).toBeTruthy();
    expect(within(warehouse!).getByText(/Sunday closed/)).toBeTruthy();

    fireEvent.click(within(warehouse!).getByRole('button', { name: 'Change opening hours' }));
    expect((within(warehouse!).getByLabelText('Opening hours') as HTMLTextAreaElement).value).toBe(
      'Mon–Sat 11am–9pm\nSunday closed',
    );
    typeIn(warehouse!, 'Opening hours', ' ');
    fireEvent.click(within(warehouse!).getByRole('button', { name: 'Save hours' }));
    await waitFor(() => expect(within(warehouse!).queryByText(/Sunday closed/)).toBeNull());

    // A location without its address says why.
    fireEvent.click(within(shop!).getByRole('button', { name: 'Show on your store locator' }));
    fireEvent.click(within(shop!).getByRole('button', { name: 'Show it' }));
    expect(
      await within(shop!).findByText(
        'Give the location its street address and city, for customers to find it',
      ),
    ).toBeTruthy();

    fireEvent.click(within(warehouse!).getByRole('button', { name: 'Take off the store locator' }));
    await waitFor(() =>
      expect(
        within(warehouse!).queryByText('Shown on your online store’s store locator'),
      ).toBeNull(),
    );
    expect(sentOf(fake, 'LocationEdit')).toEqual([
      {
        id: 'loc_1',
        input: { storefrontListed: true, openingHours: 'Mon–Sat 11am–9pm\nSunday closed' },
      },
      { id: 'loc_1', input: { storefrontListed: true, openingHours: null } },
      { id: 'loc_2', input: { storefrontListed: true, openingHours: null } },
      { id: 'loc_1', input: { storefrontListed: false } },
    ]);
  });
});
