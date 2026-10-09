import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

const LOCATION = { id: 'loc_1', name: 'Lahore warehouse' };
const pkr = (amount: string) => ({ amount, currencyCode: 'PKR' });

/** Types into a field found by its label within part of the page. */
const typeIn = (scope: HTMLElement, label: string, value: string) =>
  fireEvent.change(within(scope).getByLabelText(label), { target: { value } });

function variant(id: string, values: string[], names: string[]) {
  return {
    id,
    title: values.join(' / '),
    price: pkr('3200.00'),
    compareAtPrice: null,
    sku: null,
    taxCode: null,
    selectedOptions: values.map((value, index) => ({ name: names[index]!, value })),
    inventoryQuantity: 0,
    inventoryItem: { id: `item_${id}`, tracked: false, inventoryLevels: [] },
  };
}

interface Option {
  id: string;
  name: string;
  optionValues: { id: string; name: string }[];
}

/** A fake core with a kurta in sizes S and M, which changes as the page asks. */
function core(role: StaffRole) {
  let options: Option[] = [
    {
      id: 'opt_1',
      name: 'Size',
      optionValues: [
        { id: 'ov_s', name: 'S' },
        { id: 'ov_m', name: 'M' },
      ],
    },
  ];
  let variants = [variant('var_s', ['S'], ['Size']), variant('var_m', ['M'], ['Size'])];
  let made = 0;
  const names = () => options.map((option) => option.name);
  const ok = (field: string) => ({ [field]: { product: { id: 'prod_1' }, userErrors: [] } });
  const refused = (field: string, message: string) => ({
    [field]: { product: null, userErrors: [{ field: null, code: 'INVALID', message }] },
  });
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Product':
        return {
          location: LOCATION,
          product: {
            id: 'prod_1',
            title: 'Khaddar Kurta',
            description: '',
            handle: 'khaddar-kurta',
            status: 'ACTIVE',
            productType: null,
            vendor: null,
            tags: [],
            totalInventory: 0,
            tracksInventory: false,
            options,
            media: [],
            variants,
          },
        };
      case 'ProductOptionUpdate': {
        const option = variables.option as { id: string; name?: string };
        const toAdd = (variables.optionValuesToAdd as string[] | undefined) ?? [];
        const toDelete = (variables.optionValuesToDelete as string[] | undefined) ?? [];
        if (toDelete.length > 0) {
          return refused('productOptionUpdate', 'M is used by a variant: delete that first');
        }
        options = options.map((each) =>
          each.id === option.id
            ? {
                ...each,
                name: option.name ?? each.name,
                optionValues: [
                  ...each.optionValues,
                  ...toAdd.map((name) => ({ id: `ov_${name}`, name })),
                ],
              }
            : each,
        );
        variants = variants.map((each) => variant(each.id, each.title.split(' / '), names()));
        return ok('productOptionUpdate');
      }
      case 'ProductOptionsCreate': {
        const [added] = variables.options as { name: string; values: string[] }[];
        options = [
          ...options,
          {
            id: 'opt_2',
            name: added!.name,
            optionValues: added!.values.map((name) => ({ id: `ov_${name}`, name })),
          },
        ];
        variants = variants.map((each) =>
          variant(each.id, [...each.title.split(' / '), added!.values[0]!], names()),
        );
        return ok('productOptionsCreate');
      }
      case 'ProductOptionsDelete':
        return {
          productOptionsDelete: {
            deletedOptionsIds: null,
            userErrors: [
              { field: null, code: 'INVALID', message: 'Two variants would then be the same' },
            ],
          },
        };
      case 'ProductVariantsBulkCreate': {
        const [input] = variables.variants as { optionValues: string[] }[];
        made += 1;
        variants = [...variants, variant(`var_new${made}`, input!.optionValues, names())];
        return {
          productVariantsBulkCreate: { productVariants: [{ id: 'var_new' }], userErrors: [] },
        };
      }
      case 'ProductVariantsBulkDelete':
        variants = variants.filter(
          (each) => !(variables.variantsIds as string[]).includes(each.id),
        );
        return ok('productVariantsBulkDelete');
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe("A product's options and variants", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renames an option, adds values, adds an option, and names what the core refuses', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    const section = await screen.findByRole('region', { name: 'Options and variants' });
    typeIn(section, 'Name of Size', 'Length');
    fireEvent.click(within(section).getByRole('button', { name: 'Rename' }));
    expect(await within(section).findByLabelText('Name of Length')).toBeTruthy();

    typeIn(section, 'Add values to Length', 'L, XL');
    fireEvent.click(within(section).getByRole('button', { name: 'Add' }));
    const values = await within(section).findByRole('list', { name: 'Values of Length' });
    await waitFor(() =>
      expect(
        within(values)
          .getAllByRole('listitem')
          .map((each) => each.textContent),
      ).toEqual(['S', 'M', 'L', 'XL']),
    );

    fireEvent.click(within(section).getByRole('button', { name: 'Remove M' }));
    expect(
      await within(section).findByText('M is used by a variant: delete that first'),
    ).toBeTruthy();

    typeIn(section, 'Option name', 'Colour');
    typeIn(section, 'Its values', 'Maroon, Black');
    fireEvent.click(within(section).getByLabelText(/^Add a variant for every combination/));
    fireEvent.click(within(section).getByRole('button', { name: 'Add option' }));
    expect(await within(section).findByText('S / Maroon')).toBeTruthy();
    expect(sentOf(fake, 'ProductOptionUpdate')).toEqual([
      { productId: 'prod_1', option: { id: 'opt_1', name: 'Length' } },
      { productId: 'prod_1', option: { id: 'opt_1' }, optionValuesToAdd: ['L', 'XL'] },
      { productId: 'prod_1', option: { id: 'opt_1' }, optionValuesToDelete: ['ov_m'] },
    ]);
    expect(sentOf(fake, 'ProductOptionsCreate')).toEqual([
      {
        productId: 'prod_1',
        options: [{ name: 'Colour', values: ['Maroon', 'Black'] }],
        variantStrategy: 'LEAVE_AS_IS',
      },
    ]);

    fireEvent.click(within(section).getByRole('button', { name: 'Take away Colour' }));
    fireEvent.click(within(section).getByRole('button', { name: 'Take it away' }));
    expect(await within(section).findByText('Two variants would then be the same')).toBeTruthy();
  });

  it('adds a variant for a combination it lacks, and deletes one once asked, keeping the last', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    const section = await screen.findByRole('region', { name: 'Options and variants' });
    typeIn(section, 'Add values to Size', 'L');
    fireEvent.click(within(section).getByRole('button', { name: 'Add' }));
    await within(section).findByRole('option', { name: 'L' });

    expect(within(section).getByText('S is a variant already.')).toBeTruthy();
    fireEvent.change(within(section).getByLabelText('Size'), { target: { value: 'L' } });
    typeIn(section, 'Price (Rs)', '3,500');
    fireEvent.click(within(section).getByRole('button', { name: 'Add variant' }));
    expect(await within(section).findByRole('button', { name: 'Delete L' })).toBeTruthy();
    expect(sentOf(fake, 'ProductVariantsBulkCreate')).toEqual([
      { productId: 'prod_1', variants: [{ optionValues: ['L'], price: '3500' }] },
    ]);

    for (const title of ['S', 'M']) {
      fireEvent.click(within(section).getByRole('button', { name: `Delete ${title}` }));
      fireEvent.click(within(section).getByRole('button', { name: 'Delete, with its stock' }));
      await waitFor(() =>
        expect(within(section).queryByRole('button', { name: `Delete ${title}` })).toBeNull(),
      );
    }
    await waitFor(() =>
      expect(within(section).queryByRole('button', { name: 'Delete L' })).toBeNull(),
    );
    expect(sentOf(fake, 'ProductVariantsBulkDelete')).toEqual([
      { productId: 'prod_1', variantsIds: ['var_s'] },
      { productId: 'prod_1', variantsIds: ['var_m'] },
    ]);
  });

  it('is not there for those who only look at products', async () => {
    vi.stubGlobal('fetch', core('packer').fetcher);
    renderAdmin('/shop_1/products/prod_1');
    expect(await screen.findByRole('heading', { name: 'Khaddar Kurta' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Options and variants' })).toBeNull();
  });
});
