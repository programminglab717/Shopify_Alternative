import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, GraphQLErrors, renderAdmin, signedIn, type } from '../test-support';
import { buildQuery, parseQuery } from './segment-query';
import type { Condition } from './segment-query';

const FILTERS = [
  { name: 'number_of_orders', type: 'NUMBER' },
  { name: 'last_order_date', type: 'DATE' },
  { name: 'city', type: 'TEXT' },
  { name: 'customer_tags', type: 'TEXT_LIST' },
  { name: 'blocked', type: 'BOOLEAN' },
  { name: 'whatsapp_subscription_status', type: 'TEXT' },
].map((filter) => ({ ...filter, description: filter.name, example: '', operators: [] }));

const member = (id: string, displayName: string) => ({
  id,
  displayName,
  phone: '+92300•••4567',
  numberOfOrders: 3,
  lastOrderAt: '2026-06-01T09:00:00Z',
  tags: [],
  amountSpent: { amount: '9000.00', currencyCode: 'PKR' },
  blocklistEntry: null,
});

const SAVED = {
  id: 'seg_1',
  name: 'Lahore or WhatsApp',
  query: 'city = Lahore OR whatsapp_subscription_status = subscribed',
  memberCount: 12,
};

function core(role: StaffRole, saved = SAVED) {
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Customers':
        return { customers: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
      case 'Segments':
        return { segments: { nodes: [SAVED] } };
      case 'Segment':
        return { segment: saved };
      case 'SegmentFilters':
        return { segmentFilters: FILTERS };
      case 'SegmentPreview':
        return String(variables.query).includes('>>')
          ? new GraphQLErrors([
              {
                message: 'Expected a value after >= at 18',
                extensions: { code: 'BAD_USER_INPUT' },
              },
            ])
          : {
              segmentPreview: {
                memberCount: 3,
                members: [member('cus_1', 'Ayesha Khan'), member('cus_2', 'Bilal Ahmed')],
              },
            };
      case 'SegmentCreate':
        return { segmentCreate: { segment: { id: 'seg_9' }, userErrors: [] } };
      case 'SegmentUpdate':
        return { segmentUpdate: { segment: { id: variables.id }, userErrors: [] } };
      case 'SegmentDelete':
        return { segmentDelete: { deletedSegmentId: variables.id, userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

const pick = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('Customer segments', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('writes conditions as the core reads them, and reads back only what it writes', () => {
    const conditions: Condition[] = [
      { field: 'number_of_orders', op: '>=', value: '2' },
      { field: 'last_order_date', op: 'BEFORE_DAYS', value: '60' },
      { field: 'city', op: 'IN', value: 'Lahore, Rahim Yar Khan' },
      { field: 'customer_tags', op: 'CONTAINS', value: "Eid '25" },
      { field: 'blocked', op: '=', value: 'false' },
    ];
    const query = buildQuery(conditions, 'AND');
    expect(query).toBe(
      "number_of_orders >= 2 AND last_order_date < -60d AND city IN (Lahore, 'Rahim Yar Khan') AND customer_tags CONTAINS 'Eid ''25' AND blocked = false",
    );
    expect(parseQuery(query)).toEqual({ join: 'AND', conditions });
    expect(parseQuery('city = Lahore OR last_order_date > -30d')).toEqual({
      join: 'OR',
      conditions: [
        { field: 'city', op: '=', value: 'Lahore' },
        { field: 'last_order_date', op: 'WITHIN_DAYS', value: '30' },
      ],
    });
    expect(buildQuery([{ field: 'city', op: '=', value: ' ' }], 'AND')).toBe('');
    expect(parseQuery('city = Lahore AND blocked = false OR number_of_orders > 1')).toBeNull();
    expect(parseQuery('NOT blocked = true')).toBeNull();
    expect(parseQuery('(city = Lahore OR city = Karachi) AND blocked = false')).toBeNull();
    expect(parseQuery('')).toEqual({ join: 'AND', conditions: [] });
  });

  it('builds a segment in words, counts who it holds as it changes, and keeps it', async () => {
    const fake = core('marketer');
    vi.stubGlobal('fetch', fake.fetcher);
    const { router } = renderAdmin('/shop_1/customers');

    fireEvent.click(await screen.findByRole('link', { name: 'Segments' }));
    expect((await screen.findByRole('link', { name: /Lahore or WhatsApp/ })).textContent).toContain(
      '12 customers',
    );
    fireEvent.click(screen.getByRole('link', { name: 'New segment' }));

    await screen.findByLabelText('Condition 1: answer');
    type('Condition 1: answer', '2');
    fireEvent.click(await screen.findByRole('button', { name: 'Add a condition' }));
    pick('Condition 2: what', 'last_order_date');
    pick('Condition 2: how', 'BEFORE_DAYS');
    type('Condition 2: answer', '60');
    fireEvent.click(screen.getByLabelText('Match all of these'));

    expect(await screen.findByText('3 customers')).toBeTruthy();
    const members = screen.getByRole('list', { name: 'Customers in the segment' });
    expect(within(members).getByText('Ayesha Khan')).toBeTruthy();
    await waitFor(() =>
      expect(sentOf(fake, 'SegmentPreview').at(-1)).toEqual({
        query: 'number_of_orders >= 2 AND last_order_date < -60d',
      }),
    );

    type('Name', 'Lapsed regulars');
    fireEvent.click(screen.getByRole('button', { name: 'Keep the segment' }));
    await waitFor(() =>
      expect(sentOf(fake, 'SegmentCreate')).toEqual([
        { name: 'Lapsed regulars', query: 'number_of_orders >= 2 AND last_order_date < -60d' },
      ]),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/shop_1/customers/segments/seg_9'),
    );
  });

  it('changes a saved segment, keeps a query it cannot show as text, and deletes it', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/customers/segments/seg_1');

    expect(((await screen.findByLabelText('Match any of these')) as HTMLInputElement).checked).toBe(
      true,
    );
    pick('Condition 2: answer', 'unsubscribed');
    fireEvent.click(screen.getByRole('button', { name: 'Save the segment' }));
    await waitFor(() =>
      expect(sentOf(fake, 'SegmentUpdate')).toEqual([
        { id: 'seg_1', query: 'city = Lahore OR whatsapp_subscription_status = unsubscribed' },
      ]),
    );
    cleanup();

    const kept = core('owner', { ...SAVED, query: 'NOT blocked = true' });
    vi.stubGlobal('fetch', kept.fetcher);
    renderAdmin('/shop_1/customers/segments/seg_1');
    const query = (await screen.findByLabelText('Query')) as HTMLTextAreaElement;
    expect(query.value).toBe('NOT blocked = true');
    expect(screen.queryByRole('button', { name: 'Build it from conditions' })).toBeNull();
    fireEvent.change(query, { target: { value: 'number_of_orders >>' } });
    expect(
      await screen.findByText('This does not read yet: Expected a value after >= at 18'),
    ).toBeTruthy();
    fireEvent.change(query, { target: { value: 'blocked = false' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Build it from conditions' }));
    expect((screen.getByLabelText('Condition 1: answer') as HTMLSelectElement).value).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Delete the segment' }));
    expect(screen.getByText(/Its customers stay/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete it' }));
    await waitFor(() => expect(sentOf(kept, 'SegmentDelete')).toEqual([{ id: 'seg_1' }]));
  });

  it('leaves segments to those who market the shop', async () => {
    vi.stubGlobal('fetch', core('confirmation_agent').fetcher);
    renderAdmin('/shop_1/customers');
    expect(await screen.findByRole('heading', { name: 'Customers' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Segments' })).toBeNull();
    cleanup();
    vi.stubGlobal('fetch', core('confirmation_agent').fetcher);
    renderAdmin('/shop_1/customers/segments');
    expect(await screen.findByText("Your role does not keep the shop's segments.")).toBeTruthy();
  });
});
