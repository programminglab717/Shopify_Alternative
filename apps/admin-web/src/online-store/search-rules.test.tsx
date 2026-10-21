import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchRuleValue } from '../api/types';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn } from '../test-support';
import { ruleProblems } from './search-rules';

const LAWN = { id: 'gid://hatti/Product/1', title: 'Eid Lawn' };
const KURTA = { id: 'gid://hatti/Product/2', title: 'Eid Kurta' };
const OLD = { id: 'gid://hatti/Product/3', title: 'Eid 2023' };

/** A fake core keeping the shop's rules and finding its products, refusing `refuse` once. */
function core(
  role: StaffRole,
  rules: SearchRuleValue[],
  refuse?: { field: string[]; code: string; message: string }[],
) {
  let kept = rules;
  let refusal = refuse;
  return fakeCore(role, (operation, variables) => {
    if (operation === 'SearchRules') return { searchRules: kept };
    if (operation === 'CollectionProductSearch') {
      return {
        products: { nodes: [LAWN, KURTA, OLD].map((each) => ({ ...each, status: 'ACTIVE' })) },
      };
    }
    if (operation === 'SearchRuleSet') {
      if (refusal) {
        const userErrors = refusal;
        refusal = undefined;
        return { searchRuleSet: { searchRule: null, userErrors } };
      }
      const all = [LAWN, KURTA, OLD];
      const rule: SearchRuleValue = {
        id: `srch_${kept.length + 1}`,
        query: variables.query as string,
        pinnedProducts: (variables.pinnedProductIds as string[]).map((id) =>
          all.find((each) => each.id === id)!,
        ),
        hiddenProducts: (variables.hiddenProductIds as string[]).map((id) =>
          all.find((each) => each.id === id)!,
        ),
      };
      kept = [...kept.filter((each) => each.query !== rule.query), rule];
      return { searchRuleSet: { searchRule: rule, userErrors: [] } };
    }
    if (operation === 'SearchRuleDelete') {
      kept = kept.filter((each) => each.id !== variables.id);
      return { searchRuleDelete: { deletedSearchRuleId: variables.id, userErrors: [] } };
    }
    throw new Error(`unexpected ${operation}`);
  });
}

const sentRules = (fake: ReturnType<typeof core>) =>
  fake.sent.filter((each) => each.operation === 'SearchRuleSet').map((each) => each.variables);

/** Finds products by name and adds the one named, as the finder does. */
async function add(title: string) {
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'eid' } });
  fireEvent.click(screen.getByRole('button', { name: 'Find' }));
  fireEvent.click(await screen.findByRole('button', { name: `Add ${title}` }));
}

describe("The online store's search results (SRC-04, ADR-693)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("pins a search's products in order and hides others, saved together", async () => {
    const fake = core('manager', []);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=searchRules');

    await screen.findByText('No searches of your own yet. Every search shows what it finds.');
    fireEvent.click(screen.getByRole('button', { name: 'Add a search' }));
    fireEvent.change(screen.getByLabelText('Search words'), { target: { value: 'Eid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pin a product' }));
    await add('Eid Lawn');
    await add('Eid Kurta');
    // Pinned once: a second time, or hidden too, is said, not added.
    await add('Eid Kurta');
    expect(screen.getByText('Eid Kurta is pinned or hidden already.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Move Eid Kurta up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide a product' }));
    await add('Eid 2023');
    const pinned = screen.getByRole('list', { name: 'Pinned to the top' });
    expect(
      within(pinned)
        .getAllByRole('listitem')
        .map((each) => each.textContent),
    ).toEqual(['Eid Kurta', 'Eid Lawn']);
    fireEvent.click(screen.getByRole('button', { name: 'Save the search' }));

    await screen.findByText('Saved. Your storefront shows it in a moment.');
    expect(sentRules(fake)).toEqual([
      { query: 'Eid', pinnedProductIds: [KURTA.id, LAWN.id], hiddenProductIds: [OLD.id] },
    ]);
    const list = await screen.findByRole('list', { name: 'What a search shows first' });
    await waitFor(() => expect(within(list).getByText('2 pinned, 1 hidden')).toBeTruthy());

    // Taken away from the list.
    fireEvent.click(screen.getByRole('button', { name: 'Remove the search for Eid' }));
    await screen.findByText('No searches of your own yet. Every search shows what it finds.');
  });

  it('says what the core refused under the words, and of each product by its name', async () => {
    const fake = core(
      'owner',
      [{ id: 'srch_1', query: 'lawn', pinnedProducts: [LAWN], hiddenProducts: [OLD] }],
      [
        { field: ['query'], code: 'INVALID', message: 'A search term must have a word' },
        { field: ['hiddenProductIds', '0'], code: 'NOT_FOUND', message: 'Product not found' },
      ],
    );
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=searchRules');
    fireEvent.click(await screen.findByRole('button', { name: 'Change the search for lawn' }));
    expect((screen.getByLabelText('Search words') as HTMLInputElement).value).toBe('lawn');
    fireEvent.click(screen.getByRole('button', { name: 'Save the search' }));
    await screen.findByText('A search term must have a word');
    expect(screen.getByText('Eid 2023: Product not found')).toBeTruthy();
  });

  it('opens a top search from analytics, with its rule where it has one', async () => {
    vi.stubGlobal(
      'fetch',
      core('owner', [{ id: 'srch_1', query: 'Lawn', pinnedProducts: [LAWN], hiddenProducts: [] }])
        .fetcher,
    );
    renderAdmin('/shop_1/online-store?tab=searchRules&term=velvet%20shawl');
    const words = (await screen.findByLabelText('Search words')) as HTMLInputElement;
    expect(words.value).toBe('velvet shawl');
    expect(screen.getByRole('heading', { name: 'A new search' })).toBeTruthy();
    cleanup();
    renderAdmin('/shop_1/online-store?tab=searchRules&term=lawn');
    expect(await screen.findByRole('heading', { name: 'The search for Lawn' })).toBeTruthy();
    const pinned = screen.getByRole('list', { name: 'Pinned to the top' });
    expect(within(pinned).getByText('Eid Lawn')).toBeTruthy();
  });

  it('is for those who change products', async () => {
    vi.stubGlobal('fetch', core('marketer', []).fetcher);
    renderAdmin('/shop_1/online-store');
    await screen.findByRole('heading', { name: 'Online store' });
    expect(screen.queryByRole('tab', { name: 'Search results' })).toBeNull();
  });

  it('names the product the core refused, where it is one', () => {
    expect(
      ruleProblems(
        [
          { field: ['pinnedProductIds', '1'], code: 'NOT_FOUND', message: 'Product not found' },
          { field: ['pinnedProductIds'], code: 'TOO_MANY', message: 'Too many' },
          { field: ['query'], code: 'TOO_LONG', message: 'Too long' },
        ],
        [LAWN, KURTA],
        [],
      ),
    ).toEqual({ query: 'Too long', rest: ['Eid Kurta: Product not found', 'Too many'] });
  });
});
