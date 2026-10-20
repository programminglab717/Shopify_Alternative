import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';

const PREFERENCES = {
  passwordEnabled: false,
  password: null,
  passwordMessage: '',
  maintenanceEnabled: false,
  maintenanceMessage: '',
  maintenanceUntil: null,
  seo: { title: null, description: null },
  returnDays: null,
  returnExchangesOnly: false,
  hidePoweredBy: false,
  consentBanner: false,
};

const CHECKED = {
  dryRun: true,
  rows: 3,
  created: 2,
  skipped: 0,
  rowErrorCount: 1,
  rowErrors: [{ row: 4, column: 'Redirect to', message: 'Give where it goes' }],
  userErrors: [],
};

const REDIRECTS: Record<string, unknown>[] = [
  { id: 'red_1', path: '/products/old-lawn', target: '/products/lawn' },
];

function core(role: StaffRole, redirects = REDIRECTS) {
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'StorefrontPreferences':
        return { onlineStorePreferences: PREFERENCES };
      case 'StorefrontPreferencesUpdate':
        // The shop's plan leaves hiding "Powered by Hatti" out (ADR-526).
        if ((variables.input as { hidePoweredBy?: boolean }).hidePoweredBy) {
          return {
            onlineStorePreferencesUpdate: {
              preferences: null,
              userErrors: [
                {
                  field: ['hidePoweredBy'],
                  code: 'INVALID',
                  message:
                    'The Free plan doesn\'t include hiding "Powered by Hatti": choose a bigger plan to hide it',
                },
              ],
            },
          };
        }
        return {
          onlineStorePreferencesUpdate: { preferences: PREFERENCES, userErrors: [] },
        };
      case 'UrlRedirects':
        return {
          urlRedirects: {
            nodes: redirects,
            pageInfo: { hasNextPage: false },
          },
        };
      case 'UrlRedirectCreate':
        return { urlRedirectCreate: { urlRedirect: { id: 'red_2' }, userErrors: [] } };
      case 'UrlRedirectDelete':
        return { urlRedirectDelete: { deletedUrlRedirectId: variables.id, userErrors: [] } };
      case 'UrlRedirectUpdate': {
        const input = variables.urlRedirect as { path: string; target: string };
        if (input.target === input.path) {
          return {
            urlRedirectUpdate: {
              urlRedirect: null,
              userErrors: [
                {
                  field: ['urlRedirect', 'target'],
                  code: 'INVALID',
                  message: 'A redirect cannot go to its own address',
                },
              ],
            },
          };
        }
        return {
          urlRedirectUpdate: {
            // An address pasted whole is kept as its path, as the core keeps it.
            urlRedirect: {
              id: variables.id,
              path: input.path.replace(/^https?:\/\/[^/]+/, ''),
              target: input.target,
            },
            userErrors: [],
          },
        };
      }
      case 'UrlRedirectsImport':
        return {
          urlRedirectsImport: variables.dryRun
            ? CHECKED
            : { ...CHECKED, dryRun: false, rowErrorCount: 0, rowErrors: [] },
        };
      case 'UrlRedirectsStraighten':
        return { urlRedirectsStraighten: { updated: 1, userErrors: [] } };
      case 'UrlRedirectsExport':
        return { urlRedirectsExport: { count: 1, csv: 'Redirect from,Redirect to\n' } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe("The storefront's preferences and redirects", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps the storefront behind a password, pauses it until a time, and sets its home page for search engines', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=storefront');

    const password = await screen.findByRole('region', { name: 'Password' });
    fireEvent.click(within(password).getByLabelText(/Keep the storefront behind a password/));
    const save = within(password).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    type('Storefront password', ' zari2026 ');
    type('Message on the password page', 'Opening on 1 November.');
    fireEvent.click(save);
    await waitFor(() =>
      expect(sentOf(fake, 'StorefrontPreferencesUpdate').at(-1)).toEqual({
        input: {
          passwordEnabled: true,
          password: 'zari2026',
          passwordMessage: 'Opening on 1 November.',
        },
      }),
    );

    const pause = screen.getByRole('region', { name: 'Pause' });
    expect(within(pause).queryByLabelText('Open again on')).toBeNull();
    fireEvent.click(within(pause).getByLabelText(/Pause the storefront/));
    type('Open again on', '2026-11-01T09:00');
    fireEvent.click(within(pause).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sentOf(fake, 'StorefrontPreferencesUpdate').at(-1)).toEqual({
        input: {
          maintenanceEnabled: true,
          maintenanceUntil: new Date('2026-11-01T09:00').toISOString(),
        },
      }),
    );

    const search = screen.getByRole('region', { name: 'Search engines' });
    type('Home page title', 'Zari: lawn and chiffon');
    type('Home page description', 'Unstitched lawn, delivered across Pakistan.');
    expect(
      within(search).getByText("22 of 70 letters. Your shop's name unless you give one."),
    ).toBeTruthy();
    fireEvent.click(within(search).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sentOf(fake, 'StorefrontPreferencesUpdate').at(-1)).toEqual({
        input: {
          seo: {
            title: 'Zari: lawn and chiffon',
            description: 'Unstitched lawn, delivered across Pakistan.',
          },
        },
      }),
    );
  });

  it('pauses checkout alone, keeping the storefront open to browse (ADR-603)', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=storefront');

    const pause = await screen.findByRole('region', { name: 'Pause' });
    fireEvent.click(within(pause).getByLabelText(/Pause the storefront/));
    expect(within(pause).getByText('Shoppers see it is back soon, and cannot order.')).toBeTruthy();
    fireEvent.click(within(pause).getByLabelText(/Keep the storefront open to browse/));
    expect(
      within(pause).getByText('Shoppers can browse, but checkout says it is back soon.'),
    ).toBeTruthy();
    fireEvent.click(within(pause).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sentOf(fake, 'StorefrontPreferencesUpdate').at(-1)).toEqual({
        input: { maintenanceEnabled: true, maintenanceCheckoutOnly: true },
      }),
    );
  });

  it('sets the return window product pages show, refusing more than 90 days (ADR-468)', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=storefront');

    const returns = await screen.findByRole('region', { name: 'Returns' });
    const save = within(returns).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    type('Days to return an order', '120');
    expect(
      within(returns).getByText('Give a whole number of days from 0 to 90, or leave it empty.'),
    ).toBeTruthy();
    expect(save.disabled).toBe(true);
    // No returns at all leaves nothing to exchange.
    type('Days to return an order', '0');
    expect(within(returns).queryByLabelText(/Exchanges only/)).toBeNull();
    type('Days to return an order', ' 7 ');
    fireEvent.click(within(returns).getByLabelText(/Exchanges only/));
    fireEvent.click(save);
    await waitFor(() =>
      expect(sentOf(fake, 'StorefrontPreferencesUpdate').at(-1)).toEqual({
        input: { returnDays: 7, returnExchangesOnly: true },
      }),
    );
  });

  it('hides "Powered by Hatti", and says when the plan leaves it out (ADR-527)', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=storefront');

    const branding = await screen.findByRole('region', { name: 'Powered by Hatti' });
    const save = within(branding).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    const shown = within(branding).getByLabelText(/Show "Powered by Hatti"/) as HTMLInputElement;
    expect(shown.checked).toBe(true);
    expect(save.disabled).toBe(true);
    fireEvent.click(shown);
    expect(within(branding).getByText('Your storefront says nothing of Hatti.')).toBeTruthy();
    fireEvent.click(save);
    await waitFor(() =>
      expect(sentOf(fake, 'StorefrontPreferencesUpdate').at(-1)).toEqual({
        input: { hidePoweredBy: true },
      }),
    );
    expect(
      await within(branding).findByText(
        'The Free plan doesn\'t include hiding "Powered by Hatti": choose a bigger plan to hide it',
      ),
    ).toBeTruthy();
  });

  it('asks shoppers before the pixels load, once turned on (ADR-552)', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=storefront');

    const consent = await screen.findByRole('region', { name: 'Cookie consent' });
    const save = within(consent).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    const asks = within(consent).getByLabelText(/Ask shoppers first/) as HTMLInputElement;
    expect(asks.checked).toBe(false);
    expect(
      within(consent).getByText('Your pixels load on every page, as they do now.'),
    ).toBeTruthy();
    expect(save.disabled).toBe(true);
    fireEvent.click(asks);
    expect(within(consent).getByText(/^A banner asks each shopper/)).toBeTruthy();
    fireEvent.click(save);
    await waitFor(() =>
      expect(sentOf(fake, 'StorefrontPreferencesUpdate').at(-1)).toEqual({
        input: { consentBanner: true },
      }),
    );
  });

  it('changes a redirect in place, and says what the core refuses', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=redirects');

    fireEvent.click(
      await screen.findByRole('button', { name: 'Change the redirect from /products/old-lawn' }),
    );
    const row = screen.getByRole('button', { name: 'Save the redirect' }).closest('li')!;
    const path = within(row).getByLabelText('Old address') as HTMLInputElement;
    const target = within(row).getByLabelText('Goes to') as HTMLInputElement;
    expect([path.value, target.value]).toEqual(['/products/old-lawn', '/products/lawn']);

    fireEvent.change(target, { target: { value: '/products/old-lawn' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save the redirect' }));
    expect((await within(row).findByRole('alert')).textContent).toBe(
      'A redirect cannot go to its own address',
    );

    fireEvent.change(path, { target: { value: ' https://zari.hatti.pk/products/old-lawn-2 ' } });
    fireEvent.change(target, { target: { value: '/products/lawn-suit' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save the redirect' }));
    await screen.findByText('The redirect from /products/old-lawn-2 is changed.');
    expect(sentOf(fake, 'UrlRedirectUpdate').at(-1)).toEqual({
      id: 'red_1',
      urlRedirect: {
        path: 'https://zari.hatti.pk/products/old-lawn-2',
        target: '/products/lawn-suit',
      },
    });
    expect(screen.queryByRole('button', { name: 'Save the redirect' })).toBeNull();
  });

  it('says where redirects in a row end, sends one straight there, and says a loop (ADR-607)', async () => {
    const fake = core('manager', [
      {
        id: 'red_1',
        path: '/sale-2025',
        target: '/sale-2026',
        finalTarget: '/collections/eid',
        loops: false,
      },
      {
        id: 'red_2',
        path: '/sale-2026',
        target: '/collections/eid',
        finalTarget: null,
        loops: false,
      },
      { id: 'red_3', path: '/a', target: '/b', finalTarget: null, loops: true },
    ]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=redirects');

    const chained = (
      await screen.findByText('Another redirect sends shoppers on from there, to /collections/eid.')
    ).closest('li')!;
    expect(within(chained).getByText('/sale-2025')).toBeTruthy();
    expect(screen.getAllByText(/Another redirect sends shoppers on/)).toHaveLength(1);
    fireEvent.click(
      within(chained).getByRole('button', { name: 'Send straight to /collections/eid' }),
    );
    await screen.findByText('The redirect from /sale-2025 is changed.');
    expect(sentOf(fake, 'UrlRedirectUpdate')).toEqual([
      { id: 'red_1', urlRedirect: { path: '/sale-2025', target: '/collections/eid' } },
    ]);
    const looping = screen
      .getByText(
        'This goes round in a loop with other redirects: change where it goes, or delete it.',
      )
      .closest('li')!;
    expect(within(looping).getByText('/a')).toBeTruthy();
  });

  it('straightens every chain at once, offered while one is shown (ADR-612)', async () => {
    const fake = core('manager', [
      {
        id: 'red_1',
        path: '/sale-2025',
        target: '/sale-2026',
        finalTarget: '/collections/eid',
        loops: false,
      },
      {
        id: 'red_2',
        path: '/sale-2026',
        target: '/collections/eid',
        finalTarget: null,
        loops: false,
      },
    ]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=redirects');

    await screen.findByText(/Some redirects send shoppers on through others/);
    fireEvent.click(screen.getByRole('button', { name: 'Straighten every chain' }));
    await screen.findByText('Sent 1 redirect straight to where its chain ends.');
    expect(sentOf(fake, 'UrlRedirectsStraighten')).toEqual([{}]);
  });

  it('offers no straightening where no redirect is chained', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=redirects');
    await screen.findByText('/products/old-lawn');
    expect(screen.queryByRole('button', { name: 'Straighten every chain' })).toBeNull();
  });

  it('finds, adds, deletes, imports after checking, and exports redirects', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    const objectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:redirects');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderAdmin('/shop_1/online-store?tab=redirects');

    const list = await screen.findByRole('list', { name: 'Redirects' });
    expect(list.textContent).toContain('/products/old-lawn');
    fireEvent.change(screen.getByPlaceholderText('Find a redirect'), { target: { value: 'lawn' } });
    await waitFor(() => expect(sentOf(fake, 'UrlRedirects').at(-1)).toEqual({ query: 'lawn' }));

    type('Old address', '/collections/eid-2025');
    type('Goes to', '/collections/eid');
    fireEvent.click(screen.getByRole('button', { name: 'Add the redirect' }));
    await waitFor(() =>
      expect(sentOf(fake, 'UrlRedirectCreate')).toEqual([
        { urlRedirect: { path: '/collections/eid-2025', target: '/collections/eid' } },
      ]),
    );
    expect(
      await screen.findByText('/collections/eid-2025 now goes to its new address.'),
    ).toBeTruthy();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete the redirect from /products/old-lawn' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete it' }));
    await waitFor(() => expect(sentOf(fake, 'UrlRedirectDelete')).toEqual([{ id: 'red_1' }]));

    const csv = 'Redirect from,Redirect to\n/a,/b\n/c,/d\n/e,\n';
    await act(async () =>
      fireEvent.change(screen.getByLabelText('Redirects CSV'), {
        target: { files: [new File([csv], 'redirects.csv', { type: 'text/csv' })] },
      }),
    );
    expect(await screen.findByText(/redirects\.csv: 3 rows\. 2 would be added/)).toBeTruthy();
    expect(screen.getByText('Row 4: Give where it goes')).toBeTruthy();
    expect(sentOf(fake, 'UrlRedirectsImport')).toEqual([{ csv, dryRun: true }]);
    fireEvent.click(screen.getByRole('button', { name: 'Add the 2 redirects' }));
    expect(await screen.findByText('Added 2 redirects; 0 left as they were.')).toBeTruthy();
    expect(sentOf(fake, 'UrlRedirectsImport').at(-1)).toEqual({ csv, dryRun: false });

    fireEvent.click(screen.getByRole('button', { name: "Download them as Shopify's CSV" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(objectUrl.mock.calls[0]![0]).toBeInstanceOf(Blob);
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('redirects.csv');
  });

  it('leaves the storefront and redirects to owners and managers', async () => {
    vi.stubGlobal('fetch', core('marketer').fetcher);
    renderAdmin('/shop_1/online-store?tab=redirects');
    expect(await screen.findByRole('tab', { name: 'Blogs' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Redirects' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Storefront' })).toBeNull();
  });
});
