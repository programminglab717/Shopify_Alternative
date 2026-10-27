import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import type { DropInput, DropValue } from '../api/types';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

const LAWN = { id: 'prod_1', title: 'Lawn suit' };
const SHAWL = { id: 'prod_2', title: 'Pashmina shawl' };
const FOUND = [
  { ...LAWN, status: 'ACTIVE' },
  { ...SHAWL, status: 'DRAFT' },
];
const LIVE: DropValue = {
  id: 'drop_1',
  name: 'Eid lawn',
  startsAt: '2026-10-26T19:00:00Z',
  endsAt: '2026-10-28T19:00:00Z',
  status: 'LIVE',
  perCustomerLimit: 2,
  admitPerMinute: 500,
  products: [{ ...LAWN, status: 'ACTIVE' }],
};

function core(role: StaffRole, drops: DropValue[]) {
  let current = drops;
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Drops':
        return { drops: current };
      case 'CollectionProductSearch':
        return { products: { nodes: FOUND } };
      case 'DropCreate': {
        const input = variables.input as DropInput;
        if (input.name === 'On Growth') {
          return {
            dropCreate: {
              drop: null,
              userErrors: [
                {
                  field: ['input'],
                  code: 'PROHIBITED',
                  message:
                    "The Growth plan doesn't include drops: choose the Pro plan to schedule one",
                },
              ],
            },
          };
        }
        if (input.name === 'Clash') {
          return {
            dropCreate: {
              drop: null,
              userErrors: [
                {
                  field: ['input', 'productIds', '0'],
                  code: 'TAKEN',
                  message: 'This product is in another drop',
                },
              ],
            },
          };
        }
        const made: DropValue = {
          id: 'drop_2',
          name: input.name,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          status: 'SCHEDULED',
          perCustomerLimit: input.perCustomerLimit,
          admitPerMinute: input.admitPerMinute,
          products: FOUND.filter((each) => input.productIds.includes(each.id)),
        };
        current = [made, ...current];
        return { dropCreate: { drop: made, userErrors: [] } };
      }
      case 'DropDelete':
        current = current.filter((each) => each.id !== variables.id);
        return { dropDelete: { deletedId: variables.id } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

/** Fills in the form for a drop of the products named. */
async function fill(name: string, titles: string[]) {
  fireEvent.change(await screen.findByLabelText('Name'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-11-01T00:00' } });
  fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-11-02T00:00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add a product' }));
  fireEvent.change(screen.getByLabelText('Find a product to add'), { target: { value: 'a' } });
  fireEvent.click(screen.getByRole('button', { name: 'Find' }));
  for (const title of titles) {
    fireEvent.click(await screen.findByRole('button', { name: `Add ${title}` }));
  }
}

describe("The admin's drops (INV-09, OS-17, ADR-823)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('schedules a drop with a limit and a waiting room, naming what the core refuses', async () => {
    const fake = core('owner', []);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products');
    fireEvent.click(await screen.findByRole('link', { name: 'Drops' }));
    expect(await screen.findByText('No drops yet')).toBeTruthy();

    await fill('On Growth', ['Lawn suit']);
    const schedule = () => screen.getByRole('button', { name: 'Schedule drop' });
    fireEvent.click(schedule());
    expect(
      await screen.findByText(
        "The Growth plan doesn't include drops: choose the Pro plan to schedule one",
      ),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Clash' } });
    fireEvent.click(schedule());
    expect(await screen.findByText('Lawn suit: This product is in another drop')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Eid lawn' } });
    fireEvent.click(await screen.findByRole('button', { name: `Add ${SHAWL.title}` }));
    fireEvent.change(screen.getByLabelText('Most each customer may buy (optional)'), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByLabelText('Let shoppers in from a waiting room'));
    fireEvent.change(screen.getByLabelText('Shoppers let in a minute'), {
      target: { value: '300' },
    });
    fireEvent.click(schedule());
    expect(await screen.findByText('Eid lawn is scheduled.')).toBeTruthy();
    expect(sentOf(fake, 'DropCreate').at(-1)).toEqual({
      input: {
        name: 'Eid lawn',
        startsAt: new Date('2026-11-01T00:00').toISOString(),
        endsAt: new Date('2026-11-02T00:00').toISOString(),
        productIds: ['prod_1', 'prod_2'],
        perCustomerLimit: 2,
        admitPerMinute: 300,
      },
    });
    const card = (await screen.findByText('Waiting room: 300 a minute')).closest('li')!;
    expect(within(card).getByText('Scheduled')).toBeTruthy();
    expect(within(card).getByText(/2 each customer/)).toBeTruthy();
    expect(within(card).getByText('Lawn suit, Pashmina shawl')).toBeTruthy();
  });

  it('deletes a drop after asking, and is read by those who change no products', async () => {
    const fake = core('manager', [LIVE]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/drops');
    expect(await screen.findByText('Live')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete drop' }));
    expect(screen.getByText(/Delete Eid lawn\? Its products sell as any others/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete it' }));
    await waitFor(() => expect(sentOf(fake, 'DropDelete')).toEqual([{ id: 'drop_1' }]));
    expect(await screen.findByText('No drops yet')).toBeTruthy();
    cleanup();

    vi.stubGlobal('fetch', core('marketer', [LIVE]).fetcher);
    renderAdmin('/shop_1/products/drops');
    expect(await screen.findByText('Eid lawn')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Schedule drop' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete drop' })).toBeNull();
  });
});
