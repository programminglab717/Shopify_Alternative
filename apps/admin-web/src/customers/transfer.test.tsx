import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import {
  confirmIdentity,
  fakeCore,
  LATER,
  REAUTHENTICATE,
  renderAdmin,
  signedIn,
} from '../test-support';

const CSV =
  'Phone,First Name\n03001234567,Ayesha\n03211112233,Bilal\n03331234567,Sana\nabc,Nobody\n';

function core(role: StaffRole) {
  let confirmed = false;
  return fakeCore(
    role,
    (operation, variables) => {
      switch (operation) {
        case 'Customers':
          return { customers: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
        case 'Segments':
          return {
            segments: {
              nodes: [
                { id: 'seg_1', name: 'Lahore regulars', query: 'city = Lahore', memberCount: 12 },
              ],
            },
          };
        case 'CustomersImport':
          return {
            customersImport: {
              dryRun: variables.dryRun,
              rows: 4,
              created: 2,
              updated: variables.overwrite ? 1 : 0,
              skipped: variables.overwrite ? 0 : 1,
              rowErrorCount: 1,
              rowErrors: [{ row: 5, column: 'Phone', message: 'Enter a Pakistani mobile number' }],
              userErrors: [],
            },
          };
        case 'CustomersExport':
          return confirmed
            ? { customersExport: { csv: 'Phone\n+923001234567\n', rowCount: 12, userErrors: [] } }
            : REAUTHENTICATE;
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
  );
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('Customers in and out', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('checks a CSV first, saying what it would do, then imports it, updating those here when asked', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/customers');

    fireEvent.click(await screen.findByRole('link', { name: 'Import and export' }));
    await act(async () =>
      fireEvent.change(await screen.findByLabelText('Customers CSV'), {
        target: { files: [new File([CSV], 'customers.csv', { type: 'text/csv' })] },
      }),
    );
    expect(
      await screen.findByText(
        'customers.csv: 4 rows. 2 would be added, 0 updated and 1 left as they are.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Row 5, Phone: Enter a Pakistani mobile number')).toBeTruthy();
    expect(sentOf(fake, 'CustomersImport')).toEqual([{ csv: CSV, dryRun: true, overwrite: false }]);

    fireEvent.click(screen.getByLabelText(/Update customers already here/));
    expect(
      await screen.findByText(
        'customers.csv: 4 rows. 2 would be added, 1 updated and 0 left as they are.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Import them' }));
    expect(await screen.findByText('Added 2, updated 1; 0 left as they were.')).toBeTruthy();
    expect(sentOf(fake, 'CustomersImport').at(-1)).toEqual({
      csv: CSV,
      dryRun: false,
      overwrite: true,
    });
  });

  it("exports a segment's customers once the member confirms who they are", async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:customers');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderAdmin('/shop_1/customers/transfer');

    const who = (await screen.findByLabelText('Who')) as HTMLSelectElement;
    await screen.findByRole('option', { name: 'Lahore regulars (12)' });
    fireEvent.change(who, { target: { value: 'seg_1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Download the CSV' }));

    await confirmIdentity('Password', 'a long password');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('12 customers are in the file.')).toBeTruthy();
    expect(sentOf(fake, 'CustomersExport')).toEqual([
      { segmentId: 'seg_1' },
      { segmentId: 'seg_1' },
    ]);
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('customers.csv');
  });

  it('leaves importing and exporting to owners and managers', async () => {
    vi.stubGlobal('fetch', core('marketer').fetcher);
    renderAdmin('/shop_1/customers');
    expect(await screen.findByRole('link', { name: 'Segments' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Import and export' })).toBeNull();
    cleanup();
    vi.stubGlobal('fetch', core('marketer').fetcher);
    renderAdmin('/shop_1/customers/transfer');
    expect(
      await screen.findByText('Only owners and managers import and export customers.'),
    ).toBeTruthy();
  });
});
