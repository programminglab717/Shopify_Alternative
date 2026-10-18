import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';

type Filter = {
  kind: string;
  key: string | null;
  label: string | null;
  labelUr: string | null;
  defaultLabel: string;
  metafieldType: string | null;
};
type Input = { kind: string; key?: string; label?: string; labelUr?: string };

const filter = (
  kind: string,
  defaultLabel: string,
  key: string | null = null,
  metafieldType: string | null = null,
): Filter => ({ kind, key, label: null, labelUr: null, defaultLabel, metafieldType });

const AVAILABLE = [
  filter('AVAILABILITY', 'Availability'),
  filter('PRICE', 'Price'),
  filter('PRODUCT_TYPE', 'Product type'),
  filter('VENDOR', 'Brand'),
  filter('OPTION', 'Size', 'Size'),
  filter('OPTION', 'Colour', 'Colour'),
  filter('STITCHING', 'Stitching'),
  filter('PIECES', 'Pieces'),
  filter('FABRIC', 'Fabric'),
  filter('SEASON', 'Season'),
  filter('PRODUCT_METAFIELD', 'Material', 'custom.material', 'single_line_text_field'),
  filter('VARIANT_METAFIELD', 'Handmade', 'custom.handmade', 'boolean'),
];

const DEFAULT_NAMES = [
  'Availability',
  'Price',
  'Product type',
  'Brand',
  'Size',
  'Colour',
  'Stitching',
  'Pieces',
  'Fabric',
  'Season',
];

/** The core's answer to a list chosen: each filter as it is available, under the words given. */
function chosenOf(given: Input[], available: Filter[]): Filter[] {
  return given.map((each) => {
    const found = available.find(
      (one) =>
        one.kind === each.kind && (one.key ?? '').toLowerCase() === (each.key ?? '').toLowerCase(),
    )!;
    return {
      ...found,
      key: each.key ?? null,
      label: each.label ?? null,
      labelUr: each.labelUr ?? null,
    };
  });
}

function core(
  role: StaffRole,
  {
    chosen = null,
    available = AVAILABLE,
    refuse,
  }: {
    chosen?: Filter[] | null;
    available?: Filter[];
    refuse?: { field: string[]; code: string; message: string }[];
  } = {},
) {
  let filters = chosen;
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'OnlineStoreFilters':
        return { onlineStoreFilters: { filters, availableFilters: available } };
      case 'OnlineStoreFiltersUpdate': {
        if (refuse) {
          return { onlineStoreFiltersUpdate: { onlineStoreFilters: null, userErrors: refuse } };
        }
        const given = (variables.input as { filters: Input[] | null }).filters;
        filters = given === null ? null : chosenOf(given, available);
        return {
          onlineStoreFiltersUpdate: {
            onlineStoreFilters: { filters, availableFilters: available },
            userErrors: [],
          },
        };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>) =>
  fake.sent
    .filter((each) => each.operation === 'OnlineStoreFiltersUpdate')
    .map((each) => each.variables);

/** The filters a list shows, by name, in its order. */
const names = (list: HTMLElement) =>
  within(list)
    .getAllByRole('listitem')
    .map((row) => row.querySelector('[dir="auto"]')!.textContent);

const radio = (name: RegExp) => screen.getByRole('radio', { name }) as HTMLInputElement;
const saveButton = () => screen.getByRole('button', { name: 'Save filters' }) as HTMLButtonElement;

describe("The storefront's filters", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows every filter by default, in the standard order', async () => {
    vi.stubGlobal('fetch', core('owner').fetcher);
    renderAdmin('/shop_1/online-store');

    fireEvent.click(await screen.findByRole('tab', { name: 'Filters' }));
    expect(await screen.findByText(/Shoppers narrow your collections and search/)).toBeTruthy();
    expect(radio(/^Show every filter \(default\)/).checked).toBe(true);
    expect(radio(/^Choose the filters/).checked).toBe(false);
    const shown = screen.getByRole('list', { name: 'Show every filter (default)' });
    expect(names(shown)).toEqual(DEFAULT_NAMES);
    expect(within(shown).getByText('Built in: brand')).toBeTruthy();
    expect(within(shown).getAllByText('Option')).toHaveLength(2);
    // Metafields show only once chosen.
    expect(screen.queryByText('Material')).toBeNull();
    expect(saveButton().disabled).toBe(true);
  });

  it('chooses from the default list: reorders, relabels, removes, adds a metafield, and saves the exact list', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=filters');

    fireEvent.click(await screen.findByRole('radio', { name: /^Choose the filters/ }));
    const chosen = screen.getByRole('list', { name: 'Your filters' });
    expect(names(chosen)).toEqual(DEFAULT_NAMES);
    // The same list as the default's, but fixed: saving it is a change.
    expect(saveButton().disabled).toBe(false);
    expect((screen.getByLabelText('Filter 1: English label') as HTMLInputElement).placeholder).toBe(
      'Availability',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Move Size up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Availability down' }));
    expect(
      (screen.getByRole('button', { name: 'Move Price up' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    for (const name of ['Season', 'Pieces', 'Stitching', 'Colour', 'Product type']) {
      fireEvent.click(screen.getByRole('button', { name: `Remove ${name}` }));
    }
    expect(names(chosen)).toEqual(['Price', 'Availability', 'Size', 'Brand', 'Fabric']);
    type('Filter 2: English label', '  In stock ');
    type('Filter 2: Urdu label', 'دستیاب');
    type('Filter 3: Urdu label', 'سائز');

    const add = screen.getByLabelText('Filter to add') as HTMLSelectElement;
    expect([...add.querySelectorAll('optgroup')].map((group) => group.label)).toEqual([
      'Built in',
      'Options',
      'Product custom fields',
      'Variant custom fields',
    ]);
    fireEvent.change(add, { target: { value: 'PRODUCT_METAFIELD:custom.material' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a filter' }));
    expect(screen.getByText('custom.material')).toBeTruthy();
    expect(screen.getByText(/Text, one line/)).toBeTruthy();

    fireEvent.click(saveButton());
    expect(await screen.findByText(/^Saved\./)).toBeTruthy();
    expect(sentOf(fake)).toEqual([
      {
        input: {
          filters: [
            { kind: 'PRICE' },
            { kind: 'AVAILABILITY', label: 'In stock', labelUr: 'دستیاب' },
            { kind: 'OPTION', key: 'Size', labelUr: 'سائز' },
            { kind: 'VENDOR' },
            { kind: 'FABRIC' },
            { kind: 'PRODUCT_METAFIELD', key: 'custom.material' },
          ],
        },
      },
    ]);
    expect(radio(/^Choose the filters/).checked).toBe(true);
    expect(saveButton().disabled).toBe(true);
  });

  it('adds an option and a variant metafield to the list chosen, and goes back to every filter', async () => {
    const fake = core('owner', {
      chosen: [
        { ...filter('PRICE', 'Price'), label: 'Budget' },
        { ...filter('OPTION', 'Size', 'size'), labelUr: 'سائز' },
      ],
    });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=filters');

    const chosen = await screen.findByRole('list', { name: 'Your filters' });
    expect(radio(/^Choose the filters/).checked).toBe(true);
    expect(names(chosen)).toEqual(['Price', 'Size']);
    expect((screen.getByLabelText('Filter 1: English label') as HTMLInputElement).value).toBe(
      'Budget',
    );
    expect((screen.getByLabelText('Filter 2: Urdu label') as HTMLInputElement).value).toBe('سائز');
    expect(saveButton().disabled).toBe(true);

    // An option chosen under another case is still the one chosen.
    const add = screen.getByLabelText('Filter to add') as HTMLSelectElement;
    expect([...add.options].map((option) => option.textContent)).not.toContain('Size');
    fireEvent.change(add, { target: { value: 'OPTION:colour' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a filter' }));
    fireEvent.change(screen.getByLabelText('Filter to add'), {
      target: { value: 'VARIANT_METAFIELD:custom.handmade' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add a filter' }));
    expect(names(chosen)).toEqual(['Price', 'Size', 'Colour', 'Handmade']);
    expect(screen.getByText(/^Variant custom field/)).toBeTruthy();
    type('Filter 4: Urdu label', 'ہاتھ سے بنا');

    fireEvent.click(saveButton());
    expect(await screen.findByText(/^Saved\./)).toBeTruthy();
    expect(sentOf(fake)).toEqual([
      {
        input: {
          filters: [
            { kind: 'PRICE', label: 'Budget' },
            { kind: 'OPTION', key: 'size', labelUr: 'سائز' },
            { kind: 'OPTION', key: 'Colour' },
            { kind: 'VARIANT_METAFIELD', key: 'custom.handmade', labelUr: 'ہاتھ سے بنا' },
          ],
        },
      },
    ]);

    fireEvent.click(radio(/^Show every filter/));
    expect(names(screen.getByRole('list', { name: 'Show every filter (default)' }))).toEqual(
      DEFAULT_NAMES,
    );
    fireEvent.click(saveButton());
    await waitFor(() => expect(sentOf(fake)).toHaveLength(2));
    expect(await screen.findByText(/^Saved\./)).toBeTruthy();
    expect(sentOf(fake)[1]).toEqual({ input: { filters: null } });
    expect(radio(/^Show every filter/).checked).toBe(true);
    expect(saveButton().disabled).toBe(true);
  });

  it('saves an empty list, saying the pages then show no filters', async () => {
    const fake = core('owner', { chosen: [filter('PRICE', 'Price'), filter('VENDOR', 'Brand')] });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=filters');

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Price' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Brand' }));
    expect(screen.queryByRole('list', { name: 'Your filters' })).toBeNull();
    expect(screen.getByText(/^No filters chosen: your collection and search pages/)).toBeTruthy();
    fireEvent.click(saveButton());
    expect(await screen.findByText(/^Saved\./)).toBeTruthy();
    expect(sentOf(fake)).toEqual([{ input: { filters: [] } }]);
  });

  it("shows a filter's problems under it, and the others above Save", async () => {
    const fake = core('owner', {
      refuse: [
        {
          field: ['input', 'filters', '1', 'label'],
          code: 'TOO_LONG',
          message: 'Label is too long (at most 60 characters)',
        },
        {
          field: ['input', 'filters', '0', 'key'],
          code: 'NOT_FOUND',
          message: 'No such custom field',
        },
        { field: ['input', 'filters'], code: 'INVALID', message: 'Choose at most 25 filters' },
      ],
    });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=filters');

    fireEvent.click(await screen.findByRole('radio', { name: /^Choose the filters/ }));
    type('Filter 2: English label', 'Price range');
    fireEvent.click(saveButton());

    const rows = within(screen.getByRole('list', { name: 'Your filters' })).getAllByRole(
      'listitem',
    );
    expect(
      await within(rows[1]!).findByText('Label is too long (at most 60 characters)'),
    ).toBeTruthy();
    expect(
      within(rows[1]!).getByLabelText('Filter 2: English label').getAttribute('aria-invalid'),
    ).toBe('true');
    expect(within(rows[0]!).getByText('No such custom field')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Choose at most 25 filters');
    expect(screen.queryByText(/^Saved\./)).toBeNull();
  });

  it('adds no more than 25', async () => {
    const options = Array.from({ length: 26 }, (_, at) =>
      filter('OPTION', `Option ${at + 1}`, `Option ${at + 1}`),
    );
    vi.stubGlobal(
      'fetch',
      core('owner', { chosen: options.slice(0, 25), available: options }).fetcher,
    );
    renderAdmin('/shop_1/online-store?tab=filters');

    expect(await screen.findByText(/^Your pages show at most 25 filters/)).toBeTruthy();
    const add = () => screen.getByRole('button', { name: 'Add a filter' }) as HTMLButtonElement;
    expect(add().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Option 1' }));
    expect(add().disabled).toBe(false);
    expect(screen.queryByText(/^Your pages show at most 25 filters/)).toBeNull();
  });

  it('leaves the filters to owners and managers', async () => {
    vi.stubGlobal('fetch', core('marketer').fetcher);
    renderAdmin('/shop_1/online-store?tab=filters');
    expect(await screen.findByRole('tab', { name: 'Pages' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Filters' })).toBeNull();
    expect(screen.queryByText(/Shoppers narrow your collections and search/)).toBeNull();
  });
});
