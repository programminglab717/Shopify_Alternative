import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';
import { plainTextOf } from './copy-draft';

const LOCATION = { id: 'loc_1', name: 'Shop', isPrimary: true };

function core(available: boolean, creditsLeft: number | null = null) {
  return fakeCore('owner', (operation) => {
    switch (operation) {
      case 'PrimaryLocation':
        return { location: LOCATION };
      case 'ProductCopyDrafting':
        return {
          productCopyDrafting: {
            available,
            usedToday: 3,
            limitPerDay: 100,
            creditsLeft,
            creditsPerMonth: creditsLeft === null ? null : 10,
          },
        };
      case 'ProductCopyDraft':
        return {
          productCopyDraft: {
            draft: {
              title: 'Printed lawn ka 3-piece suit',
              descriptionHtml:
                '<p>Garmiyon ke liye lawn.</p><ul><li>Shirt: 3m</li><li>Dupatta: chiffon</li></ul>',
              seoTitle: 'Printed lawn suit',
              seoDescription: 'Printed lawn suit by Zari.',
            },
            userErrors: [],
          },
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe("A product's copy written with AI (CAT-20, ADR-472)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('writes the title and description in the language chosen, from what the form says, to check before saving', async () => {
    const fake = core(true);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/new');

    const write = (await screen.findByRole('button', {
      name: 'Write with AI',
    })) as HTMLButtonElement;
    // Something to write from first.
    expect(write.disabled).toBe(true);
    expect(
      screen.getByText(
        'Give a title, or say what it is in the description, for the AI to write from.',
      ),
    ).toBeTruthy();
    type('Title', 'Lawn suit');
    type('Description', 'Shirt 3m, chiffon dupatta');
    type('Brand', 'Zari');
    expect(
      screen.getByText('97 AI drafts left today. The AI writes only from what the form says.'),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Write in'), { target: { value: 'ROMAN_URDU' } });
    await act(async () => fireEvent.click(write));

    expect(await screen.findByText(/^Written by AI from what you gave/)).toBeTruthy();
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe(
      'Printed lawn ka 3-piece suit',
    );
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe(
      'Garmiyon ke liye lawn.\n\n• Shirt: 3m\n• Dupatta: chiffon',
    );
    expect(fake.sent.find((each) => each.operation === 'ProductCopyDraft')?.variables).toEqual({
      input: {
        language: 'ROMAN_URDU',
        title: 'Lawn suit',
        productType: null,
        vendor: 'Zari',
        tags: [],
        options: [],
        description: 'Shirt 3m, chiffon dupatta',
      },
    });
    // Nothing is saved until the shop saves the product.
    expect(fake.sent.some((each) => each.operation === 'ProductCreate')).toBe(false);
  });

  it("says the plan's AI credits left this month, and drafts none once they are used (ADR-534)", async () => {
    vi.stubGlobal('fetch', core(true, 4).fetcher);
    renderAdmin('/shop_1/products/new');
    await screen.findByRole('button', { name: 'Write with AI' });
    type('Title', 'Lawn suit');
    expect(
      screen.getByText(
        "4 of your plan's 10 AI credits left this month. The AI writes only from what the form says.",
      ),
    ).toBeTruthy();
    cleanup();

    vi.stubGlobal('fetch', core(true, 0).fetcher);
    renderAdmin('/shop_1/products/new');
    const write = (await screen.findByRole('button', {
      name: 'Write with AI',
    })) as HTMLButtonElement;
    type('Title', 'Lawn suit');
    expect(write.disabled).toBe(true);
    expect(
      screen.getByText(
        "Your plan's AI credits for this month are used: they come back on the 1st, or choose a bigger plan for more.",
      ),
    ).toBeTruthy();
  });

  it('shows nothing of AI where this Hatti does not write with it', async () => {
    vi.stubGlobal('fetch', core(false).fetcher);
    renderAdmin('/shop_1/products/new');

    await screen.findByRole('heading', { name: 'Add product' });
    expect(screen.queryByRole('button', { name: 'Write with AI' })).toBeNull();
  });

  it('turns a drafted description into the form’s plain text', () => {
    expect(plainTextOf('<p>One.</p><p>Two <strong>bold</strong>.</p><ol><li>A</li></ol>')).toBe(
      'One.\n\nTwo bold.\n\n• A',
    );
  });
});
