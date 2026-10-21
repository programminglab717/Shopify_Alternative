import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn } from '../test-support';
import { wordsOf } from './synonyms';

type Group = { words: string[] };

/** A fake core keeping the shop's synonyms, refusing what `refuse` says once. */
function core(
  role: StaffRole,
  groups: Group[],
  refuse?: { field: string[]; code: string; message: string }[],
) {
  let kept = groups;
  let refusal = refuse;
  return fakeCore(role, (operation, variables) => {
    if (operation === 'SearchSynonyms') return { searchSynonyms: kept };
    if (operation === 'SearchSynonymsSet') {
      if (refusal) {
        const userErrors = refusal;
        refusal = undefined;
        return { searchSynonymsSet: { searchSynonyms: null, userErrors } };
      }
      kept = variables.groups as Group[];
      return { searchSynonymsSet: { searchSynonyms: kept, userErrors: [] } };
    }
    throw new Error(`unexpected ${operation}`);
  });
}

const sentGroups = (fake: ReturnType<typeof core>) =>
  fake.sent
    .filter((each) => each.operation === 'SearchSynonymsSet')
    .map((each) => each.variables.groups);

describe("The online store's search synonyms (SRC-04, ADR-686)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the groups, changed, added and removed, and saves them whole', async () => {
    const fake = core('manager', [{ words: ['chappal', 'sandals'] }, { words: ['jora', 'suit'] }]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=synonyms');

    const first = await screen.findByLabelText('Group 1');
    expect((first as HTMLInputElement).value).toBe('chappal, sandals');
    const save = screen.getByRole('button', { name: 'Save synonyms' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(first, { target: { value: 'chappal, sandals، چپل' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove group 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a group' }));
    fireEvent.change(screen.getByLabelText('Group 2'), { target: { value: ' khussa ,, juti ' } });
    fireEvent.click(save);

    await screen.findByText('Saved. Your storefront shows it in a moment.');
    expect(sentGroups(fake)).toEqual([
      [{ words: ['chappal', 'sandals', 'چپل'] }, { words: ['khussa', 'juti'] }],
    ]);
    expect(save.disabled).toBe(true);
  });

  it('says what the core refused under its group, and what else went wrong above the button', async () => {
    const fake = core(
      'owner',
      [],
      [
        { field: ['groups', '1', '0'], code: 'INVALID', message: 'lawn suit must be one word' },
        {
          field: ['groups'],
          code: 'TOO_MANY',
          message: 'A shop keeps 100 groups of words at most',
        },
      ],
    );
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=synonyms');

    await screen.findByText('No synonyms of your own yet.');
    const add = screen.getByRole('button', { name: 'Add a group' });
    fireEvent.click(add);
    fireEvent.click(add);
    fireEvent.click(add);
    // A group left blank is not sent: the second sent is the third on the page.
    fireEvent.change(screen.getByLabelText('Group 1'), { target: { value: 'kurta, kameez' } });
    fireEvent.change(screen.getByLabelText('Group 3'), { target: { value: 'lawn suit, jora' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save synonyms' }));

    const third = (await screen.findByText('lawn suit must be one word')).closest('div')!;
    expect(within(third).getByLabelText('Group 3')).toBeTruthy();
    expect(screen.getByText('A shop keeps 100 groups of words at most')).toBeTruthy();
    expect(sentGroups(fake)).toEqual([
      [{ words: ['kurta', 'kameez'] }, { words: ['lawn suit', 'jora'] }],
    ]);
  });

  it('begins a group with the words of a search that found nothing, from analytics', async () => {
    vi.stubGlobal('fetch', core('owner', [{ words: ['chappal', 'sandals'] }]).fetcher);
    renderAdmin('/shop_1/online-store?tab=synonyms&word=velvet%20shawl');
    const begun = (await screen.findByLabelText('Group 2')) as HTMLInputElement;
    expect(begun.value).toBe('velvet shawl, ');
    await waitFor(() => expect(document.activeElement).toBe(begun));
  });

  it('is for those who change products', async () => {
    vi.stubGlobal('fetch', core('marketer', []).fetcher);
    renderAdmin('/shop_1/online-store');
    await screen.findByRole('heading', { name: 'Online store' });
    expect(screen.queryByRole('tab', { name: 'Search synonyms' })).toBeNull();
  });

  it("reads a group's words between commas, Urdu's among them", () => {
    expect(wordsOf(' chappal ,sandals،  چپل ,, ')).toEqual(['chappal', 'sandals', 'چپل']);
    expect(wordsOf(' , ')).toEqual([]);
  });
});
