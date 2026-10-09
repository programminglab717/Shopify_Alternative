import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

/** Types into a field found by its label within part of the page. */
const typeIn = (scope: HTMLElement, label: string, value: string) =>
  fireEvent.change(within(scope).getByLabelText(label), { target: { value } });

interface Saved {
  id: string;
  name: string;
  query: string;
}

function core(role: StaffRole) {
  let saved: Saved[] = [
    { id: 'ss_1', name: 'Karachi COD', query: 'city:Karachi payment:cod' },
    { id: 'ss_2', name: 'Big orders', query: 'total:>10000' },
  ];
  const refused = (field: string, message: string) => ({
    savedSearch: null,
    userErrors: [{ field: ['input', field], code: 'TAKEN', message }],
  });
  return fakeCore(role, (operation, variables) => {
    const input = (variables?.input ?? {}) as Partial<Saved> & { resourceType?: string };
    switch (operation) {
      case 'Orders':
        return {
          orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          orderStageCounts: [],
        };
      case 'OrderSavedSearches':
        return { savedSearches: { nodes: saved } };
      case 'SavedSearchCreate': {
        if (input.name === 'Big orders') {
          return { savedSearchCreate: refused('name', 'is the name of another saved search') };
        }
        const made = { id: 'ss_3', name: input.name!, query: input.query! };
        saved = [...saved, made];
        return { savedSearchCreate: { savedSearch: made, userErrors: [] } };
      }
      case 'SavedSearchUpdate': {
        if (input.query === 'colour:red') {
          return { savedSearchUpdate: refused('query', 'colour is not a filter of orders') };
        }
        saved = saved.map((each) => (each.id === input.id ? { ...each, ...input } : each));
        return {
          savedSearchUpdate: {
            savedSearch: saved.find((each) => each.id === input.id),
            userErrors: [],
          },
        };
      }
      case 'SavedSearchDelete':
        saved = saved.filter((each) => each.id !== input.id);
        return { savedSearchDelete: { deletedSavedSearchId: input.id, userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe("The orders list's saved searches", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('runs one in a tap, and saves the search shown by a name, after a refusal named', async () => {
    const fake = core('confirmation_agent');
    vi.stubGlobal('fetch', fake.fetcher);
    const { router } = renderAdmin('/shop_1/orders');

    fireEvent.click(await screen.findByRole('button', { name: 'Karachi COD' }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ q: 'city:Karachi payment:cod' }),
    );
    expect(screen.getByRole('button', { name: 'Karachi COD' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect((screen.getByLabelText('Search orders') as HTMLInputElement).value).toBe(
      'city:Karachi payment:cod',
    );
    // A search saved already is not offered to save again; tapped again, it is cleared.
    expect(screen.queryByRole('button', { name: 'Save this search' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Karachi COD' }));
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('q'));

    fireEvent.change(screen.getByLabelText('Search orders'), {
      target: { value: 'tag:eid stage:to_pack' },
    });
    fireEvent.submit(screen.getByRole('search'));
    fireEvent.click(await screen.findByRole('button', { name: 'Save this search' }));
    const saved = screen.getByRole('region', { name: 'Saved searches' });
    typeIn(saved, 'Name it', 'Big orders');
    fireEvent.click(within(saved).getByRole('button', { name: 'Save' }));
    expect(
      await within(saved).findByText('Name: is the name of another saved search'),
    ).toBeTruthy();
    typeIn(saved, 'Name it', 'Eid to pack');
    fireEvent.click(within(saved).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('button', { name: 'Eid to pack', pressed: true })).toBeTruthy();
    expect(sentOf(fake, 'SavedSearchCreate').at(-1)).toEqual({
      input: { name: 'Eid to pack', query: 'tag:eid stage:to_pack', resourceType: 'ORDER' },
    });
  });

  it('renames one, refuses a search orders do not know, and deletes one once asked', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders');

    fireEvent.click(await screen.findByRole('button', { name: 'Edit saved' }));
    const saved = screen.getByRole('region', { name: 'Saved searches' });
    const row = within(saved).getByLabelText('Name of Big orders').closest('li')!;
    typeIn(row, 'Name of Big orders', 'Over Rs 10,000');
    typeIn(row, 'Search of Big orders', 'colour:red');
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    expect(await within(row).findByText('Search: colour is not a filter of orders')).toBeTruthy();
    typeIn(row, 'Search of Big orders', 'total:>10000');
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('button', { name: 'Over Rs 10,000' })).toBeTruthy();
    expect(sentOf(fake, 'SavedSearchUpdate')).toEqual([
      { input: { id: 'ss_2', name: 'Over Rs 10,000', query: 'colour:red' } },
      { input: { id: 'ss_2', name: 'Over Rs 10,000' } },
    ]);

    fireEvent.click(within(saved).getByRole('button', { name: 'Delete Karachi COD' }));
    fireEvent.click(within(saved).getByRole('button', { name: 'Delete it' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Karachi COD' })).toBeNull());
    expect(sentOf(fake, 'SavedSearchDelete')).toEqual([{ input: { id: 'ss_1' } }]);
  });

  it('lets a marketer run them, but not save or change them', async () => {
    vi.stubGlobal('fetch', core('marketer').fetcher);
    renderAdmin('/shop_1/orders?q=tag:eid');
    expect(await screen.findByRole('button', { name: 'Karachi COD' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit saved' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save this search' })).toBeNull();
  });
});
