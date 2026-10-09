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

function core(role: StaffRole) {
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'StorefrontPreferences':
        return { onlineStorePreferences: PREFERENCES };
      case 'StorefrontPreferencesUpdate':
        return {
          onlineStorePreferencesUpdate: { preferences: PREFERENCES, userErrors: [] },
        };
      case 'UrlRedirects':
        return {
          urlRedirects: {
            nodes: [{ id: 'red_1', path: '/products/old-lawn', target: '/products/lawn' }],
            pageInfo: { hasNextPage: false },
          },
        };
      case 'UrlRedirectCreate':
        return { urlRedirectCreate: { urlRedirect: { id: 'red_2' }, userErrors: [] } };
      case 'UrlRedirectDelete':
        return { urlRedirectDelete: { deletedUrlRedirectId: variables.id, userErrors: [] } };
      case 'UrlRedirectsImport':
        return {
          urlRedirectsImport: variables.dryRun
            ? CHECKED
            : { ...CHECKED, dryRun: false, rowErrorCount: 0, rowErrors: [] },
        };
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
