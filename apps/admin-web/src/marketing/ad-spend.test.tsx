import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdSpendInput } from '../api/types';
import type { StaffRole } from '../auth/session';
import { formatDate } from '../i18n/format';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';
import { dayIn } from './ad-spend-page';

const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });

/** Days in the shop's time zone, Karachi's, as the page counts them. */
const TODAY = dayIn('Asia/Karachi');
const YESTERDAY = dayIn('Asia/Karachi', 1);
const words = (day: string) => formatDate(`${day}T12:00:00Z`, 'UTC', 'en');

/** A fake core keeping the shop's ad spend, as adSpendSet replaces and takes it away. */
function core(role: StaffRole = 'marketer') {
  let entries = [
    { platform: 'META', day: TODAY, campaign: null, amount: rupees('2500.00') },
    { platform: 'GOOGLE', day: YESTERDAY, campaign: 'eid-lawn', amount: rupees('1200.50') },
  ];
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'AdSpendEntries':
        return { adSpendEntries: entries };
      case 'AdSpendSet': {
        const [entry] = variables.entries as AdSpendInput[];
        if (!/^\d+(\.\d{1,2})?$/.test(entry!.amount)) {
          return {
            adSpendSet: {
              count: null,
              userErrors: [
                {
                  field: ['entries', '0', 'amount'],
                  code: 'INVALID',
                  message: 'must be an amount in rupees, as 2499.50',
                },
              ],
            },
          };
        }
        const same = (each: (typeof entries)[number]) =>
          each.platform === entry!.platform &&
          each.day === entry!.day &&
          each.campaign === entry!.campaign;
        entries = entries.filter((each) => !same(each));
        if (Number(entry!.amount) > 0) {
          entries = [
            { ...entry!, amount: rupees(Number(entry!.amount).toFixed(2)) },
            ...entries,
          ].sort((a, b) => b.day.localeCompare(a.day));
        }
        return { adSpendSet: { count: 1, userErrors: [] } };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('Ad spend in the admin (ADR-554)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists the last 30 days' spend, the latest first, with what they came to", async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/marketing/ad-spend');

    const list = await screen.findByRole('list', { name: 'The last 30 days' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Meta')).toBeTruthy();
    expect(within(rows[0]!).getByText(`· ${words(TODAY)}`)).toBeTruthy();
    expect(within(rows[0]!).getByText('All campaigns')).toBeTruthy();
    expect(within(rows[0]!).getByText('Rs 2,500')).toBeTruthy();
    expect(within(rows[1]!).getByText('Google')).toBeTruthy();
    expect(within(rows[1]!).getByText('eid-lawn')).toBeTruthy();
    expect(within(rows[1]!).getByText('Rs 1,200.50')).toBeTruthy();
    expect(screen.getByText('Total for the 30 days').nextElementSibling?.textContent).toBe(
      'Rs 3,700.50',
    );
    expect(
      screen.getByText(/The sales report takes it off your profit, and campaigns named here/),
    ).toBeTruthy();
    expect(sentOf(fake, 'AdSpendEntries')[0]).toEqual({
      from: dayIn('Asia/Karachi', 29),
      to: TODAY,
    });
    // The form starts on today, in the shop's time zone.
    expect((screen.getByLabelText('Day') as HTMLInputElement).value).toBe(TODAY);
  });

  it("records a day's spend on a campaign, and the list shows it", async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/marketing/ad-spend');

    await screen.findByRole('list', { name: 'The last 30 days' });
    fireEvent.change(screen.getByLabelText('Platform'), { target: { value: 'TIKTOK' } });
    type('Day', YESTERDAY);
    type('Campaign', ' azadi-sale ');
    type('Amount in rupees', '2499.50');
    fireEvent.click(screen.getByRole('button', { name: 'Record spend' }));

    expect(
      await screen.findByText(`Rs 2,499.50 on TikTok for ${words(YESTERDAY)} is recorded.`),
    ).toBeTruthy();
    expect(sentOf(fake, 'AdSpendSet')).toEqual([
      {
        entries: [
          { platform: 'TIKTOK', day: YESTERDAY, campaign: 'azadi-sale', amount: '2499.50' },
        ],
      },
    ]);
    expect(await screen.findByText('azadi-sale')).toBeTruthy();
    expect(screen.getByText('Total for the 30 days').nextElementSibling?.textContent).toBe(
      'Rs 6,200',
    );
    expect((screen.getByLabelText('Amount in rupees') as HTMLInputElement).value).toBe('');
  });

  it('removes a day, sending 0 for its platform, day and campaign', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/marketing/ad-spend');

    fireEvent.click(
      await screen.findByRole('button', {
        name: `Remove Google on ${words(YESTERDAY)}, eid-lawn`,
      }),
    );
    await waitFor(() => expect(screen.queryByText('eid-lawn')).toBeNull());
    expect(sentOf(fake, 'AdSpendSet')).toEqual([
      { entries: [{ platform: 'GOOGLE', day: YESTERDAY, campaign: 'eid-lawn', amount: '0' }] },
    ]);
    expect(screen.getByText('Total for the 30 days').nextElementSibling?.textContent).toBe(
      'Rs 2,500',
    );

    fireEvent.click(
      screen.getByRole('button', { name: `Remove Meta on ${words(TODAY)}, All campaigns` }),
    );
    expect(await screen.findByText('No ad spend recorded in the last 30 days.')).toBeTruthy();
    expect(sentOf(fake, 'AdSpendSet')[1]).toEqual({
      entries: [{ platform: 'META', day: TODAY, campaign: null, amount: '0' }],
    });
  });

  it('shows what the core found wrong under its field', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/marketing/ad-spend');

    await screen.findByRole('list', { name: 'The last 30 days' });
    type('Amount in rupees', '2,500');
    fireEvent.click(screen.getByRole('button', { name: 'Record spend' }));

    expect(await screen.findByText('must be an amount in rupees, as 2499.50')).toBeTruthy();
    expect(screen.getByLabelText('Amount in rupees').getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByText(/is recorded/)).toBeNull();
  });

  it('is reached from Marketing', async () => {
    vi.stubGlobal('fetch', core('manager').fetcher);
    renderAdmin('/shop_1/marketing');

    expect((await screen.findByRole('link', { name: /^Ad spend/ })).getAttribute('href')).toBe(
      '/shop_1/marketing/ad-spend',
    );
  });

  it('is not there for roles that do not market', async () => {
    for (const role of ['packer', 'accountant'] as const) {
      const fake = core(role);
      vi.stubGlobal('fetch', fake.fetcher);
      renderAdmin('/shop_1/marketing/ad-spend');

      expect(
        await screen.findByText(
          "Only the shop's owners, managers and marketers record its ad spend.",
        ),
      ).toBeTruthy();
      expect(screen.queryByRole('link', { name: /Marketing/ })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Record spend' })).toBeNull();
      expect(sentOf(fake, 'AdSpendEntries')).toEqual([]);
      cleanup();
    }
  });
});
