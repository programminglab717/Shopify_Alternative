import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, REAUTHENTICATE, renderAdmin, signedIn, type } from '../test-support';
import { queryOf } from './export-page';

const MINE = {
  id: 'oes_1',
  frequency: 'WEEKLY',
  hour: 8,
  format: 'XLSX',
  layout: 'ORDERS',
  query: 'stage:to_pack lahore',
  staffMemberId: 'usr_1',
  nextSendAt: LATER,
  nextPeriodFirstDay: '2026-10-05',
  nextPeriodLastDay: '2026-10-11',
  lastSentAt: null,
  lastError: null,
};

const THEIRS = {
  ...MINE,
  id: 'oes_2',
  frequency: 'MONTHLY',
  query: '',
  staffMemberId: 'usr_9',
  lastError: 'Their email bounced; prove it again to keep this export.',
};

function core(role: StaffRole, email: string | null = 'sana@zari.pk') {
  let confirmed = false;
  return fakeCore(
    role,
    (operation, variables) => {
      switch (operation) {
        case 'Orders':
          return {
            orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            orderStageCounts: [],
          };
        case 'OrdersExport':
          return confirmed
            ? {
                ordersExport: {
                  rowCount: 12,
                  file: {
                    content: btoa('Order,Total\n#1001,3499.00\n'),
                    contentType: 'text/csv; charset=utf-8',
                    filename: 'orders-2026-10-09.csv',
                  },
                  userErrors: [],
                },
              }
            : REAUTHENTICATE;
        case 'OrderExportSchedules':
          return { orderExportSchedules: [MINE, THEIRS] };
        case 'OrderExportScheduleCreate':
          return {
            orderExportScheduleCreate: {
              exportSchedule: { ...MINE, id: 'oes_3', ...(variables.input as object) },
              userErrors: [],
            },
          };
        case 'OrderExportScheduleDelete':
          return {
            orderExportScheduleDelete: { deletedExportScheduleId: variables.id, userErrors: [] },
          };
        default:
          throw new Error(`unexpected ${operation}`);
      }
    },
    (path) => {
      if (path === '/auth/reauthenticate/options') {
        return { methods: ['password'], passkeyOptions: null, googleOptions: null, phone: null };
      }
      if (path === '/auth/reauthenticate') {
        confirmed = true;
        return { authenticatedAt: LATER, sensitiveActionsUntil: LATER };
      }
      return {};
    },
    { user: { email, emailVerified: email !== null } },
  );
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('Order exports', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('writes the list as the query language reads it', () => {
    expect(queryOf({ stage: 'TO_PACK', q: 'lahore' })).toBe('stage:to_pack lahore');
    expect(queryOf({ q: 'tag:vip' })).toBe('tag:vip');
    expect(queryOf({})).toBe('');
  });

  it('downloads the orders the list shows, between two days in Pakistan, once the member confirms who they are', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:orders');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderAdmin('/shop_1/orders?stage=TO_PACK&q=lahore');

    fireEvent.click(await screen.findByRole('link', { name: 'Export' }));
    const now = await screen.findByRole('region', { name: 'Download now' });
    expect(within(now).getByText('Orders in To pack matching “lahore”')).toBeTruthy();
    fireEvent.change(within(now).getByLabelText('File'), { target: { value: 'CSV' } });
    fireEvent.change(within(now).getByLabelText('Rows'), { target: { value: 'LINE_ITEMS' } });
    fireEvent.change(within(now).getByLabelText('Placed from (optional)'), {
      target: { value: '2026-10-01' },
    });
    fireEvent.change(within(now).getByLabelText('Placed to (optional)'), {
      target: { value: '2026-10-07' },
    });
    fireEvent.click(within(now).getByRole('button', { name: 'Download' }));
    await screen.findByText('Confirm it is you');
    type('Password', 'a long password');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText('12 rows are in the file.')).toBeTruthy();
    const asked = {
      format: 'CSV',
      layout: 'LINE_ITEMS',
      query: 'lahore',
      stage: 'TO_PACK',
      // 1 October from midnight in Pakistan, to the end of 7 October there.
      placedFrom: '2026-09-30T19:00:00.000Z',
      placedBefore: '2026-10-07T19:00:00.000Z',
    };
    expect(sentOf(fake, 'OrdersExport')).toEqual([asked, asked]);
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('orders-2026-10-09.csv');
  });

  it('lists scheduled exports, schedules one of the list, and stops one', async () => {
    const fake = core('accountant');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/export?stage=TO_PACK&q=lahore');

    const scheduled = await screen.findByRole('list', { name: 'Emailed on a schedule' });
    const [mine, theirs] = within(scheduled).getAllByRole('listitem');
    expect(mine!.textContent).toContain('Every Monday at 08:00 · Excel · A row per order');
    expect(mine!.textContent).toContain('stage:to_pack lahore · to you');
    expect(theirs!.textContent).toContain('Every order · to another member of staff');
    expect(within(theirs!).getByText(/Their email bounced/)).toBeTruthy();

    const section = screen.getByRole('region', { name: 'Emailed on a schedule' });
    fireEvent.change(within(section).getByLabelText('How often'), {
      target: { value: 'DAILY' },
    });
    fireEvent.change(within(section).getByLabelText('At'), { target: { value: '9' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Email it on a schedule' }));
    expect(await screen.findByText('Scheduled; it goes to sana@zari.pk.')).toBeTruthy();
    expect(sentOf(fake, 'OrderExportScheduleCreate')).toEqual([
      {
        input: {
          frequency: 'DAILY',
          hour: 9,
          format: 'XLSX',
          layout: 'ORDERS',
          query: 'stage:to_pack lahore',
        },
      },
    ]);

    fireEvent.click(within(mine!).getByRole('button', { name: 'Stop this export' }));
    await waitFor(() =>
      expect(sentOf(fake, 'OrderExportScheduleDelete')).toEqual([{ id: 'oes_1' }]),
    );
  });

  it('asks for a proved email before scheduling, and leaves exports to those who keep the books', async () => {
    vi.stubGlobal('fetch', core('manager', null).fetcher);
    renderAdmin('/shop_1/orders/export');
    expect(
      await screen.findByText(/Scheduled exports go to your email once you have proved it/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Email it on a schedule' })).toBeNull();
    cleanup();

    vi.stubGlobal('fetch', core('packer').fetcher);
    renderAdmin('/shop_1/orders');
    expect(await screen.findByRole('heading', { name: 'Orders' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Export' })).toBeNull();
  });
});
