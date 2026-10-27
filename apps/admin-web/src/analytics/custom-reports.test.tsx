import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomReportValue } from '../api/types';
import type { StaffRole } from '../auth/session';
import { LATER, fakeCore, renderAdmin, signedIn } from '../test-support';
import { cellText } from './custom-reports';

const SALES_COLUMNS = [
  { key: 'orders', title: 'Orders', kind: 'NUMBER', trueProfit: false },
  { key: 'net_sales', title: 'Net sales', kind: 'AMOUNT', trueProfit: false },
  { key: 'gross_margin', title: 'Gross margin', kind: 'RATIO', trueProfit: false },
  { key: 'profit', title: 'Profit', kind: 'AMOUNT', trueProfit: true },
];

const PRODUCT_COLUMNS = [
  { key: 'units_sold', title: 'Units sold', kind: 'NUMBER', trueProfit: false },
  { key: 'gross_sales', title: 'Gross sales', kind: 'AMOUNT', trueProfit: false },
  { key: 'gross_profit', title: 'Gross profit', kind: 'AMOUNT', trueProfit: false },
];

const MONTHLY: CustomReportValue = {
  id: 'crep_1',
  name: 'Monthly by channel',
  breakdown: 'SOURCE',
  columns: ['orders', 'net_sales', 'gross_margin'],
  period: 'LAST_MONTH',
};

function core(role: StaffRole) {
  const reports: CustomReportValue[] = [MONTHLY];
  return fakeCore(
    role,
    (operation, variables) => {
      switch (operation) {
        case 'CustomReports':
          return { customReports: reports };
        case 'CustomReportColumns':
          return {
            customReportColumns:
              variables.breakdown === 'PRODUCT' ? PRODUCT_COLUMNS : SALES_COLUMNS,
          };
        case 'CustomReport': {
          const report = reports.find((each) => each.id === variables.id) ?? null;
          return {
            customReport: report,
            customReportRun: report && {
              placedFrom: '2026-08-31T19:00:00.000Z',
              placedBefore: '2026-09-30T19:00:00.000Z',
              columns: SALES_COLUMNS.slice(0, 3),
              rows: [
                {
                  key: 'ONLINE_STORE',
                  label: 'Online store',
                  values: ['12', '48500.00', '0.4125'],
                },
                { key: 'WHATSAPP', label: 'WhatsApp', values: ['3', '9000.00', null] },
              ],
              totals: ['15', '57500.00', '0.4011'],
            },
          };
        }
        case 'CustomReportCreate': {
          const made = { id: 'crep_2', ...(variables.input as Omit<CustomReportValue, 'id'>) };
          reports.push(made);
          return { customReportCreate: { customReport: made, userErrors: [] } };
        }
        case 'CustomReportUpdate': {
          const input = variables.input as Omit<CustomReportValue, 'id'>;
          if (!input.name.trim()) {
            return {
              customReportUpdate: {
                customReport: null,
                userErrors: [
                  { field: ['input', 'name'], code: 'BLANK', message: 'Give it a name' },
                ],
              },
            };
          }
          Object.assign(reports[0]!, input);
          return { customReportUpdate: { customReport: reports[0], userErrors: [] } };
        }
        case 'CustomReportDelete':
          reports.splice(0, 1);
          return { customReportDelete: { deletedId: variables.id } };
        case 'CustomReportExport':
          return {
            customReportExport: {
              file: {
                filename: 'monthly-by-channel.xlsx',
                contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                content: btoa('PK'),
              },
              userErrors: [],
            },
          };
        case 'OrderExportScheduleCreate':
          return {
            orderExportScheduleCreate: {
              exportSchedule: {
                id: 'oes_1',
                frequency: 'WEEKLY',
                hour: 8,
                format: 'XLSX',
                layout: 'ORDERS',
                query: '',
                staffMemberId: 'usr_1',
                customReportId: 'crep_1',
                nextSendAt: LATER,
                nextPeriodFirstDay: '2026-10-26',
                nextPeriodLastDay: '2026-11-01',
                lastSentAt: null,
                lastError: null,
              },
              userErrors: [],
            },
          };
        case 'OrderExportSchedules':
          return {
            orderExportSchedules: [
              {
                id: 'oes_1',
                frequency: 'WEEKLY',
                hour: 8,
                format: 'XLSX',
                layout: 'ORDERS',
                query: '',
                staffMemberId: 'usr_1',
                customReportId: 'crep_1',
                nextSendAt: LATER,
                nextPeriodFirstDay: '2026-10-26',
                nextPeriodLastDay: '2026-11-01',
                lastSentAt: null,
                lastError: null,
              },
            ],
          };
        default:
          throw new Error(`unexpected ${operation}`);
      }
    },
    () => ({}),
    { user: { email: 'sana@zari.pk', emailVerified: true } },
  );
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('Custom reports in the admin (ANL-06, ADR-819)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('says each cell as the merchant reads it', () => {
    expect(cellText('48500.00', SALES_COLUMNS[1] as never)).toBe('Rs 48,500');
    expect(cellText('1200', SALES_COLUMNS[0] as never)).toBe('1,200');
    expect(cellText('0.4125', SALES_COLUMNS[2] as never)).toBe('41.3%');
    expect(
      cellText('3.2', { key: 'return_on_ad_spend', title: 'Return on ad spend', kind: 'RATIO' }),
    ).toBe('3.20×');
    expect(cellText(null, SALES_COLUMNS[0] as never)).toBe('–');
  });

  it("lists the shop's reports, and makes one of products, its columns in the order ticked", async () => {
    const fake = core('marketer');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/analytics/reports');

    const list = await screen.findByRole('list', { name: 'Custom reports' });
    expect(within(list).getByText('Monthly by channel')).toBeTruthy();
    expect(within(list).getByText('Each channel · Last month')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'New report' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Best sellers' } });
    // Profit's lines say which plans have them.
    expect(await screen.findByLabelText('Profit (Growth and bigger plans)')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Rows'), { target: { value: 'PRODUCT' } });
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: 'THIS_MONTH' } });
    // A report of products starts from its own usual columns.
    expect(((await screen.findByLabelText('Units sold')) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText('Gross sales'));
    fireEvent.click(screen.getByLabelText('Gross profit'));
    fireEvent.click(screen.getByRole('button', { name: 'Save report' }));

    // Saved, it opens.
    expect(await screen.findByRole('heading', { name: 'Best sellers' })).toBeTruthy();
    expect(sentOf(fake, 'CustomReportCreate')).toEqual([
      {
        input: {
          name: 'Best sellers',
          breakdown: 'PRODUCT',
          columns: ['units_sold', 'gross_profit'],
          period: 'THIS_MONTH',
        },
      },
    ]);
    // A marketer reads reports but takes none away.
    expect(screen.queryByRole('button', { name: 'Download as Excel' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Schedule email' })).toBeNull();
  });

  it('shows a report, downloads it, emails it on a schedule, changes it and deletes it', async () => {
    const fake = core('accountant');
    vi.stubGlobal('fetch', fake.fetcher);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:report');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderAdmin('/shop_1/analytics/reports/crep_1');

    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows.map((row) => row.textContent)).toEqual([
      'RowOrdersNet salesGross margin',
      'Online store12Rs 48,50041.3%',
      'WhatsApp3Rs 9,000–',
      'Total15Rs 57,50040.1%',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Download as Excel' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('monthly-by-channel.xlsx');

    const schedule = screen.getByRole('region', { name: 'Email it to me' });
    fireEvent.change(within(schedule).getByLabelText('How often'), {
      target: { value: 'MONTHLY' },
    });
    fireEvent.click(within(schedule).getByRole('button', { name: 'Schedule email' }));
    expect(await screen.findByText('Scheduled; it goes to sana@zari.pk.')).toBeTruthy();
    expect(sentOf(fake, 'OrderExportScheduleCreate')).toEqual([
      { input: { frequency: 'MONTHLY', hour: 8, customReportId: 'crep_1' } },
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Change report' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' ' } });
    // A name of spaces is no name: it cannot be saved.
    expect(
      (screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Channels, monthly' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('heading', { name: 'Channels, monthly' })).toBeTruthy();
    expect(sentOf(fake, 'CustomReportUpdate')).toEqual([
      {
        id: 'crep_1',
        input: {
          name: 'Channels, monthly',
          breakdown: 'SOURCE',
          columns: ['orders', 'net_sales', 'gross_margin'],
          period: 'LAST_MONTH',
        },
      },
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Delete report' }));
    expect(
      screen.getByText('Delete Channels, monthly? Its scheduled emails stop too.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete it' }));
    expect(await screen.findByText('No custom reports yet.')).toBeTruthy();
    expect(sentOf(fake, 'CustomReportDelete')).toEqual([{ id: 'crep_1' }]);
  });

  it('names a scheduled report on the exports page, and links to it', async () => {
    vi.stubGlobal('fetch', core('accountant').fetcher);
    renderAdmin('/shop_1/orders/export');
    const scheduled = await screen.findByRole('list', { name: 'Emailed on a schedule' });
    const [row] = within(scheduled).getAllByRole('listitem');
    expect(row!.textContent).toContain('Every Monday at 08:00 · A custom report, as Excel');
    expect(within(row!).getByRole('link', { name: 'See the report' }).getAttribute('href')).toBe(
      '/shop_1/analytics/reports/crep_1',
    );
  });
});
