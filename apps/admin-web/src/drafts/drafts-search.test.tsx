import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, GraphQLErrors, renderAdmin, signedIn } from '../test-support';

const LATER = new Date(Date.now() - 3_600_000).toISOString();

function draft(id: string, name: string, customer: string, source: string) {
  return {
    id,
    name,
    status: 'OPEN',
    source,
    createdAt: LATER,
    totalPrice: { amount: '6650.00', currencyCode: 'PKR' },
    shippingAddress: { name: customer, city: 'Lahore' },
    lineItems: [{ quantity: 1 }],
  };
}

const DRAFTS = [
  draft('dft_1', '#D7', 'Ayesha', 'whatsapp'),
  draft('dft_2', '#D8', 'Bilal', 'instagram'),
];

/** A fake core whose drafts answer a source filter, with one search saved. */
function core(role: StaffRole) {
  let saved = [{ id: 'ss_1', name: 'From Instagram', query: 'source:instagram' }];
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'DraftOrders': {
        const query = (variables.query as string | null) ?? '';
        if (query.startsWith('colour:')) {
          return new GraphQLErrors([
            {
              message:
                "Drafts can't be filtered by colour; filters are status, source, payment_method, tag",
              extensions: { code: 'BAD_USER_INPUT' },
            },
          ]);
        }
        const source = /source:(\w+)/.exec(query)?.[1];
        return {
          draftOrders: { nodes: DRAFTS.filter((each) => !source || each.source === source) },
        };
      }
      case 'DraftOrderSavedSearches':
        return { savedSearches: { nodes: saved } };
      case 'SavedSearchCreate': {
        const input = variables.input as { name: string; query: string };
        const made = { id: 'ss_2', ...input };
        saved = [...saved, made];
        return { savedSearchCreate: { savedSearch: made, userErrors: [] } };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('Searching drafts', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('runs a saved search, searches by filter, and saves the search shown', async () => {
    const fake = core('confirmation_agent');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/drafts');

    expect(await screen.findByText('Ayesha, Lahore')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'From Instagram' }));
    expect(await screen.findByText('Bilal, Lahore')).toBeTruthy();
    expect(screen.queryByText('Ayesha, Lahore')).toBeNull();
    expect((screen.getByLabelText('Search drafts') as HTMLInputElement).value).toBe(
      'source:instagram',
    );

    fireEvent.change(screen.getByLabelText('Search drafts'), {
      target: { value: 'source:facebook' },
    });
    fireEvent.submit(screen.getByRole('search'));
    expect(await screen.findByText('No drafts match this search.')).toBeTruthy();

    // A filter drafts do not know is refused in the core's words, not as a lost connection.
    fireEvent.change(screen.getByLabelText('Search drafts'), { target: { value: 'colour:red' } });
    fireEvent.submit(screen.getByRole('search'));
    expect(
      await screen.findByText(
        "Drafts can't be filtered by colour; filters are status, source, payment_method, tag",
      ),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Search drafts'), {
      target: { value: 'source:whatsapp' },
    });
    fireEvent.submit(screen.getByRole('search'));
    await screen.findByText('Ayesha, Lahore');
    fireEvent.click(screen.getByRole('button', { name: 'Save this search' }));
    fireEvent.change(screen.getByLabelText('Name it'), { target: { value: 'WhatsApp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('button', { name: 'WhatsApp', pressed: true })).toBeTruthy();
    expect(sentOf(fake, 'SavedSearchCreate')).toEqual([
      { input: { name: 'WhatsApp', query: 'source:whatsapp', resourceType: 'DRAFT_ORDER' } },
    ]);
    expect(sentOf(fake, 'DraftOrders').at(-1)).toEqual({
      status: 'OPEN',
      query: 'source:whatsapp',
    });
  });
});
