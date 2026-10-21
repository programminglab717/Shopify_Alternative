import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonalisationFieldValue } from '../api/types';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn } from '../test-support';
import { fieldsInput } from './personalisation';

function product(personalisationFields: PersonalisationFieldValue[]) {
  return {
    id: 'prod_1',
    title: 'Eid Kurta',
    description: '',
    handle: 'eid-kurta',
    status: 'ACTIVE',
    productType: null,
    vendor: null,
    tags: [],
    totalInventory: 0,
    tracksInventory: true,
    preorder: null,
    personalisationFields,
    options: [],
    media: [],
    variants: [
      {
        id: 'var_1',
        title: 'Default Title',
        price: { amount: '4999.00', currencyCode: 'PKR' },
        compareAtPrice: null,
        sku: null,
        taxCode: null,
        selectedOptions: [],
        inventoryQuantity: 0,
        soldLast30Days: 0,
        daysOfStockLeft: null,
        inventoryItem: {
          id: 'item_1',
          tracked: true,
          inventoryPolicy: 'DENY',
          inventoryLevels: [],
        },
      },
    ],
  };
}

const EMBROIDERY: PersonalisationFieldValue = {
  name: 'Name to embroider',
  kind: 'TEXT',
  required: true,
  maxLength: 12,
  choices: [],
};

function core(role: StaffRole, fields: PersonalisationFieldValue[]) {
  let current = fields;
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Product':
        return { location: { id: 'loc_1', name: 'Main location' }, product: product(current) };
      case 'ProductPersonalisationSet': {
        const given = variables.fields as {
          name: string;
          kind: 'TEXT' | 'CHOICE';
          required: boolean;
          maxLength?: number | null;
          choices?: string[];
          price?: string;
        }[];
        const unpriced = given.findIndex(
          (field) => field.price && !/^\d+(\.\d+)?$/.test(field.price),
        );
        if (unpriced >= 0) {
          return {
            productPersonalisationSet: {
              personalisationFields: null,
              userErrors: [
                {
                  field: ['fields', String(unpriced), 'price'],
                  code: 'INVALID',
                  message: 'must be an amount of zero or more, like 2499 or 2499.50',
                },
              ],
            },
          };
        }
        const bad = given.findIndex(
          (field) => field.kind === 'CHOICE' && (field.choices ?? []).length < 2,
        );
        if (bad >= 0) {
          return {
            productPersonalisationSet: {
              personalisationFields: null,
              userErrors: [
                {
                  field: ['fields', String(bad), 'choices'],
                  code: 'TOO_FEW',
                  message: 'A choice offers two at least',
                },
              ],
            },
          };
        }
        current = given.map((field) => ({
          name: field.name,
          kind: field.kind,
          required: field.required,
          maxLength: field.kind === 'TEXT' ? (field.maxLength ?? 50) : null,
          choices: field.kind === 'CHOICE' ? (field.choices ?? []) : [],
          price: field.price
            ? { amount: Number(field.price).toFixed(2), currencyCode: 'PKR' }
            : null,
        }));
        return { productPersonalisationSet: { personalisationFields: current, userErrors: [] } };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>) =>
  fake.sent
    .filter((each) => each.operation === 'ProductPersonalisationSet')
    .map((each) => each.variables);

describe("A product's personalisation fields on its page (CAT-15, ADR-690)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('sends a text field its length, blank as none, and a choice its options', () => {
    expect(
      fieldsInput([
        {
          key: 1,
          name: 'Name',
          kind: 'TEXT',
          required: true,
          maxLength: '',
          choices: 'x',
          price: ' ',
        },
        {
          key: 2,
          name: 'Thread',
          kind: 'CHOICE',
          required: false,
          maxLength: '9',
          choices: 'Gold، Silver, Gold',
          price: ' 1,500 ',
        },
      ]),
    ).toEqual([
      { name: 'Name', kind: 'TEXT', required: true, maxLength: null },
      // What an answer adds to the price, where one is typed (ADR-697).
      {
        name: 'Thread',
        kind: 'CHOICE',
        required: false,
        choices: ['Gold', 'Silver'],
        price: '1500',
      },
    ]);
  });

  it('adds a choice to what a product asks for, says what the core refused, and saves', async () => {
    const fake = core('owner', [EMBROIDERY]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    const card = await screen.findByRole('region', { name: 'Personalisation' });
    expect((within(card).getByLabelText(/What to ask/) as HTMLInputElement).value).toBe(
      'Name to embroider',
    );
    expect((within(card).getByLabelText(/Longest answer/) as HTMLInputElement).value).toBe('12');
    const save = within(card).getByRole('button', { name: 'Save personalisation' });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(card).getByRole('button', { name: 'Add a field' }));
    const second = within(card).getByRole('group', { name: 'Field 2' });
    fireEvent.change(within(second).getByLabelText(/What to ask/), { target: { value: 'Thread' } });
    fireEvent.change(within(second).getByLabelText('Answer'), { target: { value: 'CHOICE' } });
    fireEvent.change(within(second).getByLabelText('Choices'), { target: { value: 'Gold' } });
    fireEvent.click(within(second).getByLabelText(/The shopper must answer/));
    fireEvent.click(save);
    expect(await within(second).findByText('A choice offers two at least')).toBeTruthy();

    fireEvent.change(within(second).getByLabelText('Choices'), {
      target: { value: 'Gold, Silver' },
    });
    fireEvent.click(save);
    expect(
      await within(card).findByText('Saved. Its page asks for these in a moment.'),
    ).toBeTruthy();
    expect(sentOf(fake).at(-1)).toEqual({
      productId: 'prod_1',
      fields: [
        { name: 'Name to embroider', kind: 'TEXT', required: true, maxLength: 12 },
        { name: 'Thread', kind: 'CHOICE', required: false, choices: ['Gold', 'Silver'] },
      ],
    });
  });

  it('adds to the price what an answer costs, after a price the core refused (ADR-698)', async () => {
    const fake = core('owner', [EMBROIDERY]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    const card = await screen.findByRole('region', { name: 'Personalisation' });
    const first = within(card).getByRole('group', { name: 'Field 1' });
    const price = within(first).getByLabelText(/Adds to the price/) as HTMLInputElement;
    expect(price.value).toBe('');
    fireEvent.change(price, { target: { value: 'free' } });
    const save = within(card).getByRole('button', { name: 'Save personalisation' });
    fireEvent.click(save);
    expect(
      await within(first).findByText('must be an amount of zero or more, like 2499 or 2499.50'),
    ).toBeTruthy();

    fireEvent.change(price, { target: { value: '500' } });
    fireEvent.click(save);
    expect(
      await within(card).findByText('Saved. Its page asks for these in a moment.'),
    ).toBeTruthy();
    expect(sentOf(fake).at(-1)).toEqual({
      productId: 'prod_1',
      fields: [
        { name: 'Name to embroider', kind: 'TEXT', required: true, maxLength: 12, price: '500' },
      ],
    });
    // The price as the core keeps it, whole rupees without their paisa, in the fields saved.
    const kept = within(card).getByLabelText(/Adds to the price/) as HTMLInputElement;
    expect(kept.value).toBe('500');
    expect((save as HTMLButtonElement).disabled).toBe(true);

    // Blank takes it away.
    fireEvent.change(kept, { target: { value: '' } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(sentOf(fake).at(-1)).toEqual({
        productId: 'prod_1',
        fields: [{ name: 'Name to embroider', kind: 'TEXT', required: true, maxLength: 12 }],
      }),
    );
  });

  it('takes a field away, at most five being asked for', async () => {
    const fake = core('manager', [EMBROIDERY]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    const card = await screen.findByRole('region', { name: 'Personalisation' });
    const add = within(card).getByRole('button', { name: 'Add a field' });
    for (let count = 1; count < 5; count += 1) fireEvent.click(add);
    expect((add as HTMLButtonElement).disabled).toBe(true);
    for (let number = 5; number >= 1; number -= 1) {
      fireEvent.click(within(card).getByRole('button', { name: `Remove field ${number}` }));
    }
    expect(within(card).getByText('Its page asks for nothing.')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Save personalisation' }));
    await waitFor(() => expect(sentOf(fake)).toEqual([{ productId: 'prod_1', fields: [] }]));
  });

  it('is not offered to those who may not change products', async () => {
    vi.stubGlobal('fetch', core('marketer', [EMBROIDERY]).fetcher);
    renderAdmin('/shop_1/products/prod_1');
    await screen.findByRole('heading', { name: 'Eid Kurta' });
    expect(screen.queryByRole('region', { name: 'Personalisation' })).toBeNull();
  });
});
