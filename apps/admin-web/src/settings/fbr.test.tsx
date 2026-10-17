import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import {
  confirmIdentity,
  fakeCore,
  LATER,
  REAUTHENTICATE,
  renderAdmin,
  signedIn,
  type,
} from '../test-support';

const SETTINGS = {
  rate: 18,
  taxDelivery: false,
  ntn: '1234567-8',
  strn: null,
  province: 'PUNJAB',
  filerStatus: 'ACTIVE',
  tier1: true,
  withholding: { digitalPercent: 2, cashOnDeliveryPercent: 4 },
  guidance: [{ code: 'REGISTER_NTN', status: 'DONE' }],
  updatedAt: null,
  categories: [],
};

const CONNECTED = {
  posId: 812345,
  accessTokenHint: 'Ab12',
  environment: 'SANDBOX',
  pctCode: '62044200',
  updatedAt: '2026-10-01T10:00:00Z',
};

const INVOICES = [
  {
    id: 'fi_3',
    kind: 'INVOICE',
    usin: 'INV/2026-27/00003',
    orderId: 'ord_3',
    status: 'REPORTED',
    fbrInvoiceNumber: '812345FBR20261010120501',
    attempts: 1,
    error: null,
    reportedAt: '2026-10-10T07:05:03Z',
    createdAt: '2026-10-10T07:05:00Z',
  },
  {
    id: 'fi_2',
    kind: 'CREDIT_NOTE',
    usin: 'CN/2026-27/00001',
    orderId: 'ord_2',
    status: 'FAILED',
    fbrInvoiceNumber: null,
    attempts: 2,
    error: 'FBR 0401: Invalid PCT code',
    reportedAt: null,
    createdAt: '2026-10-09T05:00:00Z',
  },
  {
    id: 'fi_1',
    kind: 'INVOICE',
    usin: 'INV/2026-27/00001',
    orderId: 'ord_1',
    status: 'SKIPPED',
    fbrInvoiceNumber: null,
    attempts: 0,
    error: null,
    reportedAt: null,
    createdAt: '2026-10-08T05:00:00Z',
  },
];

function core(
  role: StaffRole,
  options: { connected?: typeof CONNECTED; plan?: string; invoices?: typeof INVOICES } = {},
) {
  let pos: Record<string, unknown> | null = options.connected ?? null;
  let invoices = (options.invoices ?? []).map((each) => ({ ...each }));
  let confirmed = false;
  return fakeCore(
    role,
    (operation, variables) => {
      switch (operation) {
        case 'TaxSettings':
          return { taxSettings: SETTINGS };
        case 'FbrPos':
          return { fbrPos: pos };
        case 'FbrPosUpdate': {
          if (!confirmed) return REAUTHENTICATE;
          const fail = (field: string[], message: string) => ({
            fbrPosUpdate: { fbrPos: null, userErrors: [{ field, code: 'INVALID', message }] },
          });
          if (!pos && options.plan) {
            return fail(
              ['input'],
              `The ${options.plan} plan doesn't include FBR's POS integration: choose a bigger plan to connect one`,
            );
          }
          const input = variables.input as Record<string, unknown>;
          if (input.pctCode === '6204.42') {
            return fail(
              ['input', 'pctCode'],
              'must be a PCT code of 8 digits, as FBR\'s tariff writes it: "6204.4200"',
            );
          }
          const { accessToken, pctCode, ...kept } = input;
          pos = {
            ...pos,
            ...kept,
            ...(pctCode !== undefined && { pctCode: String(pctCode).replace(/\D/g, '') }),
            accessTokenHint: accessToken ? String(accessToken).slice(-4) : pos?.accessTokenHint,
            updatedAt: new Date().toISOString(),
          };
          return { fbrPosUpdate: { fbrPos: pos, userErrors: [] } };
        }
        case 'FbrPosDelete':
          pos = null;
          return { fbrPosDelete: { deletedPosId: CONNECTED.posId, userErrors: [] } };
        case 'FiscalInvoices':
          return {
            fiscalInvoices: variables.status
              ? invoices.filter((each) => each.status === variables.status)
              : invoices,
          };
        case 'FiscalInvoiceRetry': {
          invoices = invoices.map((each) =>
            each.id === variables.id ? { ...each, status: 'PENDING', error: null } : each,
          );
          const sent = invoices.find((each) => each.id === variables.id)!;
          return {
            fiscalInvoiceRetry: {
              fiscalInvoice: { usin: sent.usin, status: sent.status },
              userErrors: [],
            },
          };
        }
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

const rowOf = (usin: string) => screen.getByText(usin).closest('li')!;

describe("FBR's POS integration (POS-04, ADR-555)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('connects the POS once the member confirms who they are, a problem shown under its field', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/tax');

    expect(await screen.findByRole('heading', { name: 'FBR POS' })).toBeTruthy();
    expect(await screen.findByText('Not connected.')).toBeTruthy();
    expect(screen.getByText(/^Tier-1 retailers must report each sale to FBR/)).toBeTruthy();
    expect((screen.getByRole('radio', { name: /^Sandbox/ }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((screen.getByLabelText('Access token') as HTMLInputElement).type).toBe('password');

    type('POS ID', '812345');
    type('Access token', 'fbr-pos-token-Ab12');
    fireEvent.click(screen.getByRole('radio', { name: /^Production/ }));
    type('PCT code', '6204.42');
    fireEvent.click(screen.getByRole('button', { name: 'Connect FBR' }));
    await confirmIdentity('Password', 'a long password');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    const problem = await screen.findByText(
      'must be a PCT code of 8 digits, as FBR\'s tariff writes it: "6204.4200"',
    );
    const pct = screen.getByLabelText('PCT code');
    expect(pct.getAttribute('aria-invalid')).toBe('true');
    expect(pct.getAttribute('aria-describedby')).toContain(problem.id);
    expect(screen.queryByRole('alert')).toBeNull();

    type('PCT code', '6204.4200');
    fireEvent.click(screen.getByRole('button', { name: 'Connect FBR' }));
    expect(
      await screen.findByText(
        'Connected: invoices and credit notes are reported to FBR as they are printed.',
      ),
    ).toBeTruthy();
    expect(sentOf(fake, 'FbrPosUpdate').at(-1)).toEqual({
      input: {
        posId: 812345,
        accessToken: 'fbr-pos-token-Ab12',
        environment: 'PRODUCTION',
        pctCode: '6204.4200',
      },
    });
    expect(
      await screen.findByText('Saved. Invoices printed from now on are reported like this.'),
    ).toBeTruthy();
    expect(screen.getByText('Leave it blank to keep the one ending Ab12.')).toBeTruthy();
    expect((screen.getByLabelText('New access token') as HTMLInputElement).value).toBe('');
    expect(screen.queryByText(/^In FBR's sandbox/)).toBeNull();
  });

  it("shows a plan without FBR's POS integration as the form's problem", async () => {
    const fake = core('manager', { plan: 'Growth' });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/tax');

    await screen.findByLabelText('POS ID');
    type('POS ID', '812345');
    type('Access token', 'fbr-pos-token-Ab12');
    type('PCT code', '62044200');
    fireEvent.click(screen.getByRole('button', { name: 'Connect FBR' }));
    await confirmIdentity('Password', 'a long password');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      "The Growth plan doesn't include FBR's POS integration: choose a bigger plan to connect one",
    );
    expect(sentOf(fake, 'FbrPosUpdate').at(-1)).toEqual({
      input: {
        posId: 812345,
        accessToken: 'fbr-pos-token-Ab12',
        environment: 'SANDBOX',
        pctCode: '62044200',
      },
    });
    expect(screen.getByText('Not connected.')).toBeTruthy();
  });

  it('shows what the POS gave, changes only what changed, and disconnects once asked', async () => {
    const fake = core('manager', { connected: CONNECTED, invoices: INVOICES });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/tax');

    expect(await screen.findByText('•••• Ab12')).toBeTruthy();
    const shown = screen.getByText('•••• Ab12').closest('dl')!;
    expect(within(shown).getByText('812345')).toBeTruthy();
    expect(within(shown).getByText('Sandbox')).toBeTruthy();
    expect(within(shown).getByText('6204.4200')).toBeTruthy();
    expect(
      screen.getByText(/^In FBR's sandbox: invoices reported there don't count\./),
    ).toBeTruthy();
    expect((screen.getByLabelText('POS ID') as HTMLInputElement).value).toBe('812345');
    expect((screen.getByLabelText('PCT code') as HTMLInputElement).value).toBe('6204.4200');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('radio', { name: /^Production/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await confirmIdentity('Password', 'a long password');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(
      await screen.findByText('Saved. Invoices printed from now on are reported like this.'),
    ).toBeTruthy();
    expect(sentOf(fake, 'FbrPosUpdate')).toEqual([
      { input: { environment: 'PRODUCTION' } },
      { input: { environment: 'PRODUCTION' } },
    ]);
    expect(within(shown).getByText('Production')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect FBR' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep it connected' }));
    expect(sentOf(fake, 'FbrPosDelete')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect FBR' }));
    expect(screen.getByText(/^Disconnect POS 812345\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('Not connected.')).toBeTruthy();
    expect(sentOf(fake, 'FbrPosDelete')).toEqual([{}]);
    // Nothing is sent again without a POS connected.
    expect(screen.getByText('CN/2026-27/00001')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send again' })).toBeNull();
  });

  it('lists the invoices reported, of one status, and sends one again', async () => {
    const fake = core('owner', { connected: CONNECTED, invoices: INVOICES });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/tax');

    expect(await screen.findByRole('heading', { name: 'Invoices reported to FBR' })).toBeTruthy();
    const reported = await waitFor(() => rowOf('INV/2026-27/00003'));
    expect(within(reported).getByText('Invoice')).toBeTruthy();
    expect(within(reported).getByText('Reported')).toBeTruthy();
    expect(within(reported).getByText('812345FBR20261010120501')).toBeTruthy();
    expect(within(reported).getByText('Issued 10 Oct 2026, 12:05 pm')).toBeTruthy();
    expect(within(reported).getByRole('link', { name: 'Its order' }).getAttribute('href')).toBe(
      '/shop_1/orders/ord_3',
    );
    expect(within(reported).queryByRole('button', { name: 'Send again' })).toBeNull();

    const refused = rowOf('CN/2026-27/00001');
    expect(within(refused).getByText('Credit note')).toBeTruthy();
    expect(within(refused).getByText('Failed')).toBeTruthy();
    expect(within(refused).getByText('FBR 0401: Invalid PCT code')).toBeTruthy();
    expect(within(refused).getByText('Tried 2 times')).toBeTruthy();
    expect(within(rowOf('INV/2026-27/00001')).getByText('Skipped')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Send again' })).toHaveLength(2);
    expect(sentOf(fake, 'FiscalInvoices')).toEqual([{ status: null }]);

    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'FAILED' } });
    await waitFor(() => expect(screen.queryByText('INV/2026-27/00003')).toBeNull());
    expect(await screen.findByText('CN/2026-27/00001')).toBeTruthy();
    expect(screen.queryByText('INV/2026-27/00001')).toBeNull();
    expect(sentOf(fake, 'FiscalInvoices').at(-1)).toEqual({ status: 'FAILED' });
    fireEvent.click(within(rowOf('CN/2026-27/00001')).getByRole('button', { name: 'Send again' }));
    expect(await screen.findByText('CN/2026-27/00001 goes to FBR again.')).toBeTruthy();
    expect(sentOf(fake, 'FiscalInvoiceRetry')).toEqual([{ id: 'fi_2' }]);
    expect(await screen.findByText('None yet.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'ALL' } });
    await waitFor(() =>
      expect(within(rowOf('CN/2026-27/00001')).getByText('Pending')).toBeTruthy(),
    );
    expect(within(rowOf('CN/2026-27/00001')).queryByText('FBR 0401: Invalid PCT code')).toBeNull();
  });

  it('is not shown to those who do not open settings', async () => {
    const fake = core('marketer', { connected: CONNECTED });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/tax');

    expect(await screen.findByRole('button', { name: 'Save sales tax' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'FBR POS' })).toBeNull();
    expect(sentOf(fake, 'FbrPos')).toEqual([]);
    expect(sentOf(fake, 'FiscalInvoices')).toEqual([]);
  });
});
