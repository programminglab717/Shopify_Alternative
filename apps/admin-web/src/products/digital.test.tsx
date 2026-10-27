import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DigitalProductValue } from '../api/types';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

function product(digital: DigitalProductValue | null, isGiftCard = false) {
  return {
    id: 'prod_1',
    title: 'Embroidery patterns',
    description: '',
    handle: 'embroidery-patterns',
    status: 'ACTIVE',
    productType: null,
    vendor: null,
    tags: [],
    totalInventory: 0,
    tracksInventory: false,
    isGiftCard,
    digital,
    options: [],
    media: [],
    variants: [
      {
        id: 'var_1',
        title: 'Default Title',
        price: { amount: '1500.00', currencyCode: 'PKR' },
        compareAtPrice: null,
        sku: null,
        taxCode: null,
        selectedOptions: [],
        inventoryQuantity: 0,
        soldLast30Days: 0,
        daysOfStockLeft: null,
        inventoryItem: {
          id: 'item_1',
          tracked: false,
          inventoryPolicy: 'DENY',
          inventoryLevels: [],
        },
      },
    ],
  };
}

function core(digital: DigitalProductValue | null, isGiftCard = false) {
  let current = digital;
  return fakeCore('owner', (operation, variables) => {
    switch (operation) {
      case 'Product':
        return {
          location: { id: 'loc_1', name: 'Main location' },
          product: product(current, isGiftCard),
        };
      case 'DigitalProductSet': {
        const input = variables.input as {
          downloadLimit: number;
          linkDays: number;
          licenceKeys: boolean;
        };
        if (input.linkDays > 365) {
          return {
            digitalProductSet: {
              digitalProduct: null,
              userErrors: [
                {
                  field: ['input', 'linkDays'],
                  code: 'INVALID',
                  message: 'must be a whole number from 1 to 365',
                },
              ],
            },
          };
        }
        current = { keysLeft: 0, keysIssued: 0, files: [], ...current, ...input };
        return { digitalProductSet: { digitalProduct: current, userErrors: [] } };
      }
      case 'DigitalProductRemove':
        current = null;
        return { digitalProductRemove: { removed: true } };
      case 'DigitalFileStage': {
        const input = variables.input as { filename: string; size: number };
        return {
          digitalFileStage: {
            file: { id: 'dfile_1', filename: input.filename, size: input.size, ready: false },
            upload: {
              url: 'https://storage.test/put/dfile_1',
              method: 'PUT',
              headers: [{ name: 'Content-Type', value: 'application/pdf' }],
            },
            userErrors: [],
          },
        };
      }
      case 'DigitalFileCreate':
        return {
          digitalFileCreate: {
            file: { id: 'dfile_1', filename: 'patterns.pdf', size: 11, ready: true },
            userErrors: [],
          },
        };
      case 'DigitalFileDelete':
        return { digitalFileDelete: { deletedId: variables.id } };
      case 'LicenceKeysAdd':
        return {
          licenceKeysAdd: {
            added: (variables.keys as string[]).length - 1,
            already: 1,
            userErrors: [],
          },
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('A digital product, on its page (CAT-13, ADR-816)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('makes it digital, uploads its file and deletes it, and adds keys one a line', async () => {
    const fake = core(null);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    const save = () =>
      screen.getByRole('button', { name: 'Save digital product' }) as HTMLButtonElement;
    fireEvent.click(await screen.findByLabelText('Sell it as a download or licence keys'));
    expect((screen.getByLabelText('Downloads of each file') as HTMLInputElement).value).toBe('5');
    fireEvent.change(screen.getByLabelText('Days the link works'), { target: { value: '400' } });
    fireEvent.click(save());
    expect(await screen.findByText(/must be a whole number from 1 to 365/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Days the link works'), { target: { value: '7' } });
    fireEvent.click(screen.getByLabelText('Give each unit a licence key'));
    fireEvent.click(save());
    expect(await screen.findByText('Saved: it is sold as a digital product')).toBeTruthy();
    expect(sentOf(fake, 'DigitalProductSet').at(-1)).toEqual({
      productId: 'prod_1',
      input: { downloadLimit: 5, linkDays: 7, licenceKeys: true },
    });
    expect(save().disabled).toBe(true);

    // A file staged, put where it is told, and made the product's.
    expect(screen.getByText(/No files yet/)).toBeTruthy();
    const file = new File(['%PDF-1.7 hi'], 'patterns.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Upload a file'), { target: { files: [file] } });
    expect(await screen.findByText('patterns.pdf uploaded')).toBeTruthy();
    expect(sentOf(fake, 'DigitalFileStage')).toEqual([
      {
        productId: 'prod_1',
        input: { filename: 'patterns.pdf', contentType: 'application/pdf', size: 11 },
      },
    ]);
    expect(fake.uploads).toEqual([
      { url: 'https://storage.test/put/dfile_1', type: 'application/pdf', size: 11 },
    ]);
    expect(sentOf(fake, 'DigitalFileCreate')).toEqual([{ id: 'dfile_1' }]);
    expect(screen.getByText('11 B')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete patterns.pdf' }));
    await waitFor(() => expect(screen.queryByText('11 B')).toBeNull());
    expect(sentOf(fake, 'DigitalFileDelete')).toEqual([{ id: 'dfile_1' }]);

    // Keys, one a line, the blank lines left out.
    expect(screen.getByText('0 left to give, 0 given')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Keys to add'), {
      target: { value: 'KEY-0001\n\n  KEY-0002 \nKEY-0003\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add keys' }));
    expect(await screen.findByText('2 added; 1 it had already left out')).toBeTruthy();
    expect(sentOf(fake, 'LicenceKeysAdd')).toEqual([
      { productId: 'prod_1', keys: ['KEY-0001', 'KEY-0002', 'KEY-0003'] },
    ]);
    expect(screen.getByText('2 left to give, 0 given')).toBeTruthy();
  });

  it('makes it goods again, and is no part of a gift card', async () => {
    const fake = core({
      downloadLimit: 3,
      linkDays: 14,
      licenceKeys: false,
      keysLeft: 0,
      keysIssued: 0,
      files: [{ id: 'dfile_1', filename: 'patterns.pdf', size: 2_500_000, ready: true }],
    });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');
    expect(await screen.findByText('2.4 MB')).toBeTruthy();
    // No keys given, no keys asked for.
    expect(screen.queryByLabelText('Keys to add')).toBeNull();
    fireEvent.click(screen.getByLabelText('Sell it as a download or licence keys'));
    fireEvent.click(screen.getByRole('button', { name: 'Save digital product' }));
    expect(
      await screen.findByText('Saved: it is sold as goods to deliver, its files deleted'),
    ).toBeTruthy();
    expect(sentOf(fake, 'DigitalProductRemove')).toEqual([{ productId: 'prod_1' }]);
    expect(screen.queryByText('patterns.pdf')).toBeNull();
    cleanup();

    vi.stubGlobal('fetch', core(null, true).fetcher);
    renderAdmin('/shop_1/products/prod_1');
    await screen.findByRole('heading', { name: 'Embroidery patterns' });
    expect(screen.queryByLabelText('Sell it as a download or licence keys')).toBeNull();
  });
});
