import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';
import { paragraphsHtml } from './in-urdu';

const LOCATION = { id: 'loc_1', name: 'Lahore warehouse' };

const PRODUCT = {
  id: 'prod_1',
  title: 'Lawn suit',
  description: 'Soft lawn.\n\nThree pieces & a dupatta.',
  handle: 'lawn-suit',
  status: 'ACTIVE',
  productType: 'Suits',
  vendor: null,
  tags: [],
  totalInventory: 0,
  tracksInventory: false,
  options: [
    {
      id: 'opt_size',
      name: 'Size',
      optionValues: [
        { id: 'optv_s', name: 'Small' },
        { id: 'optv_m', name: 'Medium' },
      ],
    },
  ],
  media: [],
  variants: [],
};

const COLLECTION = {
  id: 'col_1',
  title: 'Eid edit',
  handle: 'eid-edit',
  description: 'Picked for Eid',
  sortOrder: 'MANUAL',
  productsCount: 0,
  ruleSet: null,
  products: { nodes: [] },
};

const PAGE = {
  id: 'pg_1',
  title: 'About us',
  handle: 'about-us',
  body: '<h2>Our story</h2>\n<p>Since 1990.</p>',
  isPublished: true,
  publishedAt: '2026-01-01T00:00:00Z',
};

/** Each thing's words of the shop's own, as the core gives them, each with a digest of them. */
const CONTENT: Record<string, { key: string; value: string; digest: string }[]> = {
  prod_1: [
    { key: 'title', value: 'Lawn suit', digest: 'd_title' },
    {
      key: 'body_html',
      value: '<p>Soft lawn.</p><p>Three pieces &amp; a dupatta.</p>',
      digest: 'd_body',
    },
    { key: 'product_type', value: 'Suits', digest: 'd_type' },
  ],
  opt_size: [{ key: 'name', value: 'Size', digest: 'd_size' }],
  optv_s: [{ key: 'name', value: 'Small', digest: 'd_small' }],
  optv_m: [{ key: 'name', value: 'Medium', digest: 'd_medium' }],
  col_1: [
    { key: 'title', value: 'Eid edit', digest: 'd_eid' },
    { key: 'body_html', value: '<p>Picked for Eid</p>', digest: 'd_picked' },
  ],
  pg_1: [
    { key: 'title', value: 'About us', digest: 'd_about' },
    { key: 'body_html', value: PAGE.body, digest: 'd_story' },
  ],
};

interface Kept {
  key: string;
  value: string;
  outdated: boolean;
}

/** A fake core keeping the Urdu it is sent, refusing one written for words since changed. */
function core(role: StaffRole, kept: Record<string, Kept[]> = {}, options = { stale: false }) {
  const urdu: Record<string, Kept[]> = structuredClone(kept);
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Product':
        return { location: LOCATION, product: PRODUCT };
      case 'Collection':
        return { collection: COLLECTION };
      case 'Page':
        return { page: PAGE };
      case 'InUrdu':
        return {
          translatableResourcesByIds: {
            nodes: (variables.ids as string[])
              .filter((id) => CONTENT[id])
              .map((id) => ({
                resourceId: id,
                translatableContent: CONTENT[id],
                translations: urdu[id] ?? [],
              })),
          },
        };
      case 'TranslationsRegister': {
        if (options.stale) {
          return {
            translationsRegister: {
              userErrors: [
                {
                  field: ['translations', '0', 'translatableContentDigest'],
                  code: 'STALE',
                  message: "The product's title has changed since it was read: read it again",
                },
              ],
            },
          };
        }
        const id = variables.resourceId as string;
        for (const each of variables.translations as { key: string; value: string }[]) {
          urdu[id] = [
            ...(urdu[id] ?? []).filter((other) => other.key !== each.key),
            { key: each.key, value: each.value, outdated: false },
          ];
        }
        return { translationsRegister: { userErrors: [] } };
      }
      case 'TranslationsRemove': {
        const id = variables.resourceId as string;
        const keys = variables.keys as string[];
        urdu[id] = (urdu[id] ?? []).filter((each) => !keys.includes(each.key));
        return { translationsRemove: { userErrors: [] } };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

const valueOf = (label: string) =>
  (screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement).value;

describe("The shop's words in Urdu", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('writes paragraphs as the catalog keeps a description', () => {
    expect(paragraphsHtml('نرم لان۔\nسلا ہوا\n\n\n  <تین> & دوپٹہ  \n')).toBe(
      '<p>نرم لان۔<br>سلا ہوا</p><p>&lt;تین&gt; &amp; دوپٹہ</p>',
    );
    expect(paragraphsHtml('  \n\n ')).toBe('');
  });

  it("puts a product's words and its options in Urdu, from its page (OS-06)", async () => {
    const fake = core('owner', { prod_1: [{ key: 'title', value: 'لان سوٹ', outdated: false }] });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    // On the product's page: how much of it is in Urdu, and the way there.
    const card = await screen.findByRole('region', { name: 'In Urdu' });
    await waitFor(() => expect(card.textContent).toContain('1 of 6 in Urdu'));
    fireEvent.click(screen.getByRole('link', { name: 'Write in Urdu' }));

    expect(await screen.findByRole('heading', { name: 'Lawn suit in Urdu' })).toBeTruthy();
    expect(valueOf('Title in Urdu')).toBe('لان سوٹ');
    const title = screen.getByLabelText('Title in Urdu');
    expect([title.getAttribute('dir'), title.getAttribute('lang')]).toEqual(['rtl', 'ur']);
    // The shop's own words beside each box, a description as its paragraphs.
    expect(screen.getByText(/Three pieces & a dupatta\./).textContent).toBe(
      'Soft lawn.\n\nThree pieces & a dupatta.',
    );
    expect(
      (screen.getByRole('button', { name: 'Save the Urdu' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    type('Description in Urdu', 'نرم لان۔\n\nتین پیس اور دوپٹہ۔');
    type('Size in Urdu', 'سائز');
    type('Small in Urdu', 'چھوٹا');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save the Urdu' })));

    expect(
      await screen.findByText("Saved. Your store's Urdu pages show it in a moment."),
    ).toBeTruthy();
    // Each thing's Urdu for the words as they are now; the title, unchanged, not sent again.
    expect(sentOf(fake, 'TranslationsRegister')).toEqual([
      {
        resourceId: 'prod_1',
        translations: [
          {
            key: 'body_html',
            locale: 'ur',
            translatableContentDigest: 'd_body',
            value: '<p>نرم لان۔</p><p>تین پیس اور دوپٹہ۔</p>',
          },
        ],
      },
      {
        resourceId: 'opt_size',
        translations: [
          { key: 'name', locale: 'ur', translatableContentDigest: 'd_size', value: 'سائز' },
        ],
      },
      {
        resourceId: 'optv_s',
        translations: [
          { key: 'name', locale: 'ur', translatableContentDigest: 'd_small', value: 'چھوٹا' },
        ],
      },
    ]);
    expect(sentOf(fake, 'TranslationsRemove')).toEqual([]);
    // As kept now, with nothing left to save.
    expect(valueOf('Description in Urdu')).toBe('نرم لان۔\n\nتین پیس اور دوپٹہ۔');
    expect(
      (screen.getByRole('button', { name: 'Save the Urdu' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('says what changed since, keeps what is still right, and forgets what is emptied', async () => {
    const fake = core('marketer', {
      prod_1: [
        { key: 'title', value: 'لان سوٹ', outdated: true },
        { key: 'product_type', value: 'سوٹ', outdated: false },
      ],
    });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1/urdu');

    expect(
      await screen.findByText(
        'Your own words changed after this Urdu was written. Your Urdu pages still show it.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: "It's still right" }));
    expect(screen.getByText('Kept as it is when you save.')).toBeTruthy();
    type('Type in Urdu', '');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save the Urdu' })));

    await screen.findByText("Saved. Your store's Urdu pages show it in a moment.");
    expect(sentOf(fake, 'TranslationsRegister')).toEqual([
      {
        resourceId: 'prod_1',
        translations: [
          { key: 'title', locale: 'ur', translatableContentDigest: 'd_title', value: 'لان سوٹ' },
        ],
      },
    ]);
    expect(sentOf(fake, 'TranslationsRemove')).toEqual([
      { resourceId: 'prod_1', keys: ['product_type'] },
    ]);
    expect(screen.queryByText(/Your own words changed after/)).toBeNull();
  });

  it('says so when the shop’s own words changed while the Urdu was written', async () => {
    const fake = core('manager', {}, { stale: true });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1/urdu');

    type((await screen.findByLabelText('Title in Urdu')).getAttribute('aria-label')!, 'لان سوٹ');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save the Urdu' })));
    expect(
      await screen.findByText(
        'Title: your own words changed while you were writing. Check the Urdu against them and save again.',
      ),
    ).toBeTruthy();
    // What was written stays, to check and save again.
    expect(valueOf('Title in Urdu')).toBe('لان سوٹ');
  });

  it("puts a collection's and a page's words in Urdu, a page's text as its blocks", async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    const { router } = renderAdmin('/shop_1/collections/col_1');

    const card = await screen.findByRole('region', { name: 'In Urdu' });
    await waitFor(() => expect(card.textContent).toContain('Not in Urdu yet'));
    fireEvent.click(screen.getByRole('link', { name: 'Write in Urdu' }));
    type((await screen.findByLabelText('Title in Urdu')).getAttribute('aria-label')!, 'عید');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save the Urdu' })));
    await screen.findByText("Saved. Your store's Urdu pages show it in a moment.");
    expect(sentOf(fake, 'TranslationsRegister')).toEqual([
      {
        resourceId: 'col_1',
        translations: [
          { key: 'title', locale: 'ur', translatableContentDigest: 'd_eid', value: 'عید' },
        ],
      },
    ]);

    await act(() =>
      router.navigate({
        to: '/$shopId/online-store/pages/$pageId',
        params: { shopId: 'shop_1', pageId: 'pg_1' },
      }),
    );
    fireEvent.click(await screen.findByRole('link', { name: 'Write in Urdu' }));
    expect(await screen.findByRole('heading', { name: 'About us in Urdu' })).toBeTruthy();
    expect(screen.getByText(/Since 1990\./).textContent).toBe('Our story\n\nSince 1990.');
    type('Text in Urdu', '## ہماری کہانی\n\n1990 سے۔');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save the Urdu' })));
    await screen.findByText("Saved. Your store's Urdu pages show it in a moment.");
    expect(sentOf(fake, 'TranslationsRegister').at(-1)).toEqual({
      resourceId: 'pg_1',
      translations: [
        {
          key: 'body_html',
          locale: 'ur',
          translatableContentDigest: 'd_story',
          value: '<h2>ہماری کہانی</h2>\n<p><span dir="ltr">1990</span> سے۔</p>',
        },
      ],
    });
    // Read back as the blocks it was written as.
    expect(valueOf('Text in Urdu')).toBe('## ہماری کہانی\n\n1990 سے۔');
  });

  it('is written by owners, managers and marketers alone', async () => {
    vi.stubGlobal('fetch', core('packer').fetcher);
    renderAdmin('/shop_1/products/prod_1');
    expect(await screen.findByRole('heading', { name: 'Lawn suit' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'In Urdu' })).toBeNull();

    cleanup();
    renderAdmin('/shop_1/products/prod_1/urdu');
    expect(
      await screen.findByText("Only the shop's owners, managers and marketers write its Urdu."),
    ).toBeTruthy();
  });
});
