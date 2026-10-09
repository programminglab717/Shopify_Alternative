import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';

const LOCATION = { id: 'loc_1', name: 'Lahore warehouse' };
const pkr = (amount: string) => ({ amount, currencyCode: 'PKR' });

const SETTINGS = {
  rate: 18,
  taxDelivery: false,
  ntn: null,
  strn: null,
  updatedAt: null,
  categories: [{ code: 'REDUCED', name: 'Reduced rate', rate: 10 }],
};

function variant(id: string, size: string, taxCode: string | null) {
  return {
    id,
    title: size,
    price: pkr('3200.00'),
    compareAtPrice: null,
    sku: null,
    taxCode,
    selectedOptions: [{ name: 'Size', value: size }],
    inventoryQuantity: 5,
    inventoryItem: {
      id: `item_${size}`,
      tracked: true,
      inventoryLevels: [{ available: 5, location: { id: LOCATION.id } }],
    },
  };
}

function kurta(codes: [string | null, string | null]) {
  return {
    id: 'prod_1',
    title: 'Khaddar Kurta',
    description: 'Warm khaddar.',
    handle: 'khaddar-kurta',
    status: 'ACTIVE',
    productType: 'Kurta',
    vendor: null,
    tags: [],
    totalInventory: 10,
    tracksInventory: true,
    options: [
      {
        id: 'opt_1',
        name: 'Size',
        optionValues: [
          { id: 'v1', name: 'S' },
          { id: 'v2', name: 'M' },
        ],
      },
    ],
    media: [],
    variants: [variant('var_s', 'S', codes[0]), variant('var_m', 'M', codes[1])],
  };
}

function core(role: StaffRole, codes: [string | null, string | null] = [null, null]) {
  let settings: typeof SETTINGS = SETTINGS;
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'TaxSettings':
        return { taxSettings: settings };
      case 'TaxSettingsUpdate': {
        const input = variables.input as Partial<typeof SETTINGS>;
        const taken = input.categories?.findIndex(
          (each) => each.code === 'REDUCED' && each.name !== 'Reduced rate',
        );
        if (taken !== undefined && taken >= 0) {
          return {
            taxSettingsUpdate: {
              taxSettings: null,
              userErrors: [
                {
                  field: ['input', 'categories', String(taken), 'code'],
                  code: 'TAKEN',
                  message: 'Code is given twice',
                },
              ],
            },
          };
        }
        settings = { ...settings, ...input };
        return { taxSettingsUpdate: { taxSettings: settings, userErrors: [] } };
      }
      case 'Product':
        return { location: LOCATION, product: kurta(codes) };
      case 'ProductVariantsBulkUpdate':
        return { productVariantsBulkUpdate: { productVariants: [], userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe("The shop's sales tax", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('changes the rate, its delivery, the registration and the rates of its own, sending what changed', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings');

    fireEvent.click(await screen.findByRole('link', { name: /Sales tax/ }));
    expect(((await screen.findByLabelText('Rate (%)')) as HTMLInputElement).value).toBe('18');
    type('Rate (%)', '17');
    expect(screen.getByText('At 17%, an item priced Rs 1,170 holds Rs 170 of tax.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/On delivery charges too/));
    type('NTN', '1234567-8');
    type('STRN', '3277876123456');
    fireEvent.click(screen.getByRole('button', { name: 'Add a rate' }));
    type('Rate 2: name', 'Books');
    type('Rate 2: code', 'reduced');
    type('Rate 2: %', '0.5');

    fireEvent.click(screen.getByRole('button', { name: 'Save sales tax' }));
    expect(await screen.findByText('Rate 2 · Code: Code is given twice')).toBeTruthy();
    type('Rate 2: code', 'books');
    fireEvent.click(screen.getByRole('button', { name: 'Save sales tax' }));
    expect(await screen.findByText(/^Saved\. Orders placed from now on/)).toBeTruthy();
    expect(sentOf(fake, 'TaxSettingsUpdate').at(-1)).toEqual({
      input: {
        rate: 17,
        taxDelivery: true,
        ntn: '1234567-8',
        strn: '3277876123456',
        categories: [
          { code: 'REDUCED', name: 'Reduced rate', rate: 10 },
          { code: 'BOOKS', name: 'Books', rate: 0.5 },
        ],
      },
    });
  });

  it('stops charging it', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/tax');
    fireEvent.click(await screen.findByLabelText(/Charge sales tax/));
    expect(screen.queryByLabelText('Rate (%)')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save sales tax' }));
    await waitFor(() =>
      expect(sentOf(fake, 'TaxSettingsUpdate')).toEqual([{ input: { rate: null } }]),
    );
  });

  it("taxes a product's variants at one of the shop's rates, all at once", async () => {
    const fake = core('owner', ['REDUCED', null]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    const rate = (await screen.findByLabelText('Rate')) as HTMLSelectElement;
    expect(rate.value).toBe('*');
    expect([...rate.options].map((each) => each.textContent)).toEqual([
      "The shop's rate (18%)",
      'Reduced rate (10%)',
      'Different for each variant',
    ]);
    fireEvent.change(rate, { target: { value: 'REDUCED' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sentOf(fake, 'ProductVariantsBulkUpdate')).toEqual([
        {
          productId: 'prod_1',
          variants: [
            { id: 'var_s', taxCode: 'REDUCED' },
            { id: 'var_m', taxCode: 'REDUCED' },
          ],
        },
      ]),
    );
  });
});
