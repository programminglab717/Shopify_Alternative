import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdSpendInput } from '../api/types';
import type { StaffRole } from '../auth/session';
import { formatDate, formatDateTime } from '../i18n/format';
import {
  confirmIdentity,
  fakeCore,
  LATER,
  REAUTHENTICATE,
  renderAdmin,
  signedIn,
  type,
} from '../test-support';
import { dayIn } from './ad-spend-page';

const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });

/** Days in the shop's time zone, Karachi's, as the page counts them. */
const TODAY = dayIn('Asia/Karachi');
const YESTERDAY = dayIn('Asia/Karachi', 1);
const words = (day: string) => formatDate(`${day}T12:00:00Z`, 'UTC', 'en');

/** The shop's Meta ad account, connected (ADR-564). */
const ACCOUNT = {
  adAccountId: '123456789',
  name: 'Zari Ads',
  currency: 'PKR',
  timezone: 'Asia/Karachi',
  accessTokenHint: 'Ab12',
  lastSyncedAt: '2026-10-18T07:30:00Z' as string | null,
  lastError: null as string | null,
  updatedAt: '2026-10-18T07:30:00Z',
};

/** What Meta reports of a campaign yesterday, as a pull keeps it. */
const PULLED = {
  platform: 'META',
  day: YESTERDAY,
  campaign: 'Eid Sale',
  amount: rupees('800.00'),
  source: 'META',
};

/**
 * A fake core keeping the shop's ad spend, as adSpendSet replaces and takes it away, and its Meta
 * ad account, connected once the member confirms who they are, pulled and disconnected.
 */
function core(
  role: StaffRole = 'marketer',
  { account = null as typeof ACCOUNT | null, pulled = [] as (typeof PULLED)[] } = {},
) {
  let entries = [
    { platform: 'META', day: TODAY, campaign: null, amount: rupees('2500.00'), source: 'MANUAL' },
    {
      platform: 'GOOGLE',
      day: YESTERDAY,
      campaign: 'eid-lawn',
      amount: rupees('1200.50'),
      source: 'MANUAL',
    },
    ...pulled,
  ];
  let meta = account;
  let confirmed = false;
  let pulls = 0;
  const answer = (operation: string, variables: Record<string, unknown>) => {
    switch (operation) {
      case 'AdSpendEntries':
        return { adSpendEntries: entries };
      case 'MetaAdAccount':
        return { metaAdAccount: meta };
      case 'MetaAdAccountConnect': {
        if (!confirmed) return REAUTHENTICATE;
        const input = variables.input as { adAccountId: string; accessToken: string };
        const refused = (field: string[], message: string) => ({
          metaAdAccountConnect: {
            metaAdAccount: null,
            userErrors: [{ field, code: 'INVALID', message }],
          },
        });
        if (input.adAccountId === 'act_999') {
          return refused(
            ['input', 'adAccountId'],
            'Hatti records ad spend in rupees: this ad account bills in USD',
          );
        }
        if (input.accessToken === 'on-starter') {
          return refused(
            ['input'],
            "The Starter plan doesn't include true profit: choose a bigger plan to connect Meta's ad spend",
          );
        }
        meta = {
          ...ACCOUNT,
          adAccountId: input.adAccountId.replace(/^act_/, ''),
          accessTokenHint: input.accessToken.slice(-4),
        };
        return { metaAdAccountConnect: { metaAdAccount: meta, userErrors: [] } };
      }
      case 'MetaAdSpendSync': {
        pulls += 1;
        if (pulls > 1) {
          return {
            metaAdSpendSync: {
              metaAdAccount: null,
              userErrors: [
                {
                  field: ['base'],
                  code: 'INVALID',
                  message: 'Its spend was pulled under a minute ago: try again in a minute',
                },
              ],
            },
          };
        }
        meta = { ...meta!, lastSyncedAt: '2026-10-18T09:15:00Z', lastError: null };
        entries = [...entries, PULLED];
        return { metaAdSpendSync: { metaAdAccount: meta, userErrors: [] } };
      }
      case 'MetaAdAccountDisconnect': {
        const deletedAdAccountId = meta?.adAccountId ?? null;
        meta = null;
        return { metaAdAccountDisconnect: { deletedAdAccountId, userErrors: [] } };
      }
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
            { ...entry!, amount: rupees(Number(entry!.amount).toFixed(2)), source: 'MANUAL' },
            ...entries,
          ].sort((a, b) => b.day.localeCompare(a.day));
        }
        return { adSpendSet: { count: 1, userErrors: [] } };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  };
  return fakeCore(role, answer, (path) => {
    if (path === '/auth/reauthenticate/options') {
      return { methods: ['password'], passkeyOptions: null, googleOptions: null, phone: null };
    }
    if (path === '/auth/reauthenticate') {
      confirmed = true;
      return { authenticatedAt: LATER, sensitiveActionsUntil: LATER };
    }
    return {};
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
      expect(screen.queryByRole('heading', { name: 'Meta ad account' })).toBeNull();
      expect(sentOf(fake, 'MetaAdAccount')).toEqual([]);
      cleanup();
    }
  });
});

describe("Meta's ad spend on the ad spend page (ADR-565)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('connects the ad account once the member confirms who they are, a field problem under its field', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/marketing/ad-spend');

    const section = (await screen.findByRole('heading', { name: 'Meta ad account' })).parentElement!
      .parentElement!;
    expect(await within(section).findByText('Not connected.')).toBeTruthy();
    expect(within(section).getByText(/pulls each day's spend by campaign from Meta/)).toBeTruthy();
    expect((screen.getByLabelText('Access token') as HTMLInputElement).type).toBe('password');

    type('Ad account ID', 'act_999');
    type('Access token', 'EAAB-token-Ab12');
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await confirmIdentity('Password', 'a long password');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(
      await screen.findByText('Hatti records ad spend in rupees: this ad account bills in USD'),
    ).toBeTruthy();
    expect(screen.getByLabelText('Ad account ID').getAttribute('aria-invalid')).toBe('true');

    // A plan without true profit is no field's problem.
    type('Ad account ID', 'act_123456789');
    type('Access token', 'on-starter');
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    const plan = await screen.findByText(/^The Starter plan doesn't include true profit/);
    expect(plan.closest('[role="alert"]')).toBeTruthy();
    expect(screen.getByLabelText('Ad account ID').getAttribute('aria-invalid')).not.toBe('true');
    expect(screen.getByLabelText('Access token').getAttribute('aria-invalid')).not.toBe('true');

    type('Access token', ' EAAB-token-Ab12 ');
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Connected to Zari Ads.')).toBeTruthy();
    expect(sentOf(fake, 'MetaAdAccountConnect')).toEqual([
      { input: { adAccountId: 'act_999', accessToken: 'EAAB-token-Ab12' } },
      { input: { adAccountId: 'act_999', accessToken: 'EAAB-token-Ab12' } },
      { input: { adAccountId: 'act_123456789', accessToken: 'on-starter' } },
      { input: { adAccountId: 'act_123456789', accessToken: 'EAAB-token-Ab12' } },
    ]);
    expect(screen.getByText('•••• Ab12')).toBeTruthy();
    expect(screen.queryByLabelText('Access token')).toBeNull();
  });

  it('shows the connected account, when it was last pulled, and why the last pull failed', async () => {
    const lastError = 'Error validating access token: Session has expired';
    vi.stubGlobal('fetch', core('marketer', { account: { ...ACCOUNT, lastError } }).fetcher);
    renderAdmin('/shop_1/marketing/ad-spend');

    expect(await screen.findByText('Connected to Zari Ads.')).toBeTruthy();
    const details = (term: string) => screen.getByText(term).nextElementSibling?.textContent;
    expect(details('Ad account')).toBe('Zari Ads');
    expect(details('Ad account ID')).toBe('123456789');
    expect(details('Currency')).toBe('PKR');
    expect(details('Access token')).toBe('•••• Ab12');
    expect(details('Last pulled')).toBe(
      formatDateTime(ACCOUNT.lastSyncedAt!, 'Asia/Karachi', 'en'),
    );
    expect(screen.getByText(/^The last pull failed, and Hatti tries again/)).toBeTruthy();
    expect(screen.getByText(lastError)).toBeTruthy();
    cleanup();

    vi.stubGlobal(
      'fetch',
      core('marketer', { account: { ...ACCOUNT, lastSyncedAt: null } }).fetcher,
    );
    renderAdmin('/shop_1/marketing/ad-spend');
    expect(await screen.findByText('Not pulled yet')).toBeTruthy();
    expect(screen.queryByText(/^The last pull failed/)).toBeNull();
  });

  it('pulls the spend now, and says when it was pulled under a minute ago', async () => {
    const fake = core('manager', { account: ACCOUNT });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/marketing/ad-spend');

    fireEvent.click(await screen.findByRole('button', { name: 'Pull now' }));
    expect(await screen.findByText('Spend pulled from Meta.')).toBeTruthy();
    expect(sentOf(fake, 'MetaAdSpendSync')).toEqual([{}]);
    await waitFor(() =>
      expect(screen.getByText('Last pulled').nextElementSibling?.textContent).toBe(
        formatDateTime('2026-10-18T09:15:00Z', 'Asia/Karachi', 'en'),
      ),
    );
    // What was pulled shows in the list.
    expect(await screen.findByText('Eid Sale')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Pull now' }));
    expect(
      await screen.findByText('Its spend was pulled under a minute ago: try again in a minute'),
    ).toBeTruthy();
    expect(screen.queryByText('Spend pulled from Meta.')).toBeNull();
  });

  it('gives the account another token once asked to change it', async () => {
    const fake = core('owner', { account: ACCOUNT });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/marketing/ad-spend');

    fireEvent.click(await screen.findByRole('button', { name: 'Change' }));
    expect((screen.getByLabelText('Ad account ID') as HTMLInputElement).value).toBe('123456789');
    type('New access token', 'EAAB-other-Zz99');
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await confirmIdentity('Password', 'a long password');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('•••• Zz99')).toBeTruthy();
    expect(sentOf(fake, 'MetaAdAccountConnect').at(-1)).toEqual({
      input: { adAccountId: '123456789', accessToken: 'EAAB-other-Zz99' },
    });
    expect(screen.queryByLabelText('New access token')).toBeNull();
  });

  it('disconnects the ad account once asked whether they mean it, the spend pulled kept', async () => {
    const fake = core('marketer', { account: ACCOUNT, pulled: [PULLED] });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/marketing/ad-spend');

    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect ad account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep it connected' }));
    expect(sentOf(fake, 'MetaAdAccountDisconnect')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect ad account' }));
    expect(
      screen.getByText(
        'Disconnect ad account 123456789? Hatti forgets its access token and pulls no more spend. The spend already pulled stays.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('Not connected.')).toBeTruthy();
    expect(sentOf(fake, 'MetaAdAccountDisconnect')).toEqual([{}]);
    expect(screen.getByText('Eid Sale')).toBeTruthy();
  });

  it("labels the spend pulled from Meta, and says typing over it keeps Meta's out", async () => {
    vi.stubGlobal('fetch', core('marketer', { account: ACCOUNT, pulled: [PULLED] }).fetcher);
    renderAdmin('/shop_1/marketing/ad-spend');

    const list = await screen.findByRole('list', { name: 'The last 30 days' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    const pulled = rows.find((row) => within(row).queryByText('Eid Sale'))!;
    expect(within(pulled).getByText('From Meta')).toBeTruthy();
    expect(within(list).getAllByText('From Meta')).toHaveLength(1);

    // Meta is the platform chosen to start with.
    expect(
      screen.getByText(/^Typing a figure for a campaign and day pulled from Meta replaces it/),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Platform'), { target: { value: 'TIKTOK' } });
    expect(
      screen.queryByText(/^Typing a figure for a campaign and day pulled from Meta/),
    ).toBeNull();
  });
});
