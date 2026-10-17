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
  strn: null as string | null,
  province: 'PUNJAB',
  filerStatus: 'ACTIVE',
  tier1: true,
  withholding: { digitalPercent: 2, cashOnDeliveryPercent: 4 },
  guidance: [{ code: 'REGISTER_NTN', status: 'DONE' }],
  updatedAt: null,
  categories: [],
};

/** A shop registered for sales tax that is not a Tier-1 retailer. */
const REGISTERED = { ...SETTINGS, tier1: false, strn: '3277876175852', province: 'SINDH' };

const CONNECTED = {
  system: 'POS',
  posId: 812345 as number | null,
  accessTokenHint: 'Ab12',
  environment: 'SANDBOX',
  pctCode: '62044200',
  updatedAt: '2026-10-01T10:00:00Z',
};

const CONNECTED_DI = {
  ...CONNECTED,
  system: 'DIGITAL_INVOICING',
  posId: null,
  accessTokenHint: 'f818',
  environment: 'PRODUCTION',
};

const INVOICES = [
  {
    id: 'fi_3',
    system: 'POS',
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
    system: 'POS',
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
    system: 'POS',
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
  options: {
    connected?: typeof CONNECTED;
    plan?: string;
    invoices?: (Record<string, unknown> & { id: string; usin: string; status: string })[];
    settings?: typeof SETTINGS;
  } = {},
) {
  const settings = options.settings ?? SETTINGS;
  let pos: Record<string, unknown> | null = options.connected ?? null;
  let invoices = (options.invoices ?? []).map((each) => ({ ...each }));
  let confirmed = false;
  return fakeCore(
    role,
    (operation, variables) => {
      switch (operation) {
        case 'TaxSettings':
          return { taxSettings: settings };
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
          const system = input.system ?? pos?.system ?? 'POS';
          if (system === 'DIGITAL_INVOICING' && !(settings.ntn && settings.strn)) {
            return fail(
              ['input', 'system'],
              "FBR's digital invoicing is for sellers registered for sales tax: set the shop's NTN, STRN and province in its tax settings first",
            );
          }
          if (system === 'DIGITAL_INVOICING' && input.posId !== undefined) {
            return fail(['input', 'posId'], "FBR's digital invoicing has no POS ID: leave it out");
          }
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
            system,
            ...(system === 'DIGITAL_INVOICING' && { posId: null }),
            ...(pctCode !== undefined && { pctCode: String(pctCode).replace(/\D/g, '') }),
            accessTokenHint: accessToken ? String(accessToken).slice(-4) : pos?.accessTokenHint,
            updatedAt: new Date().toISOString(),
          };
          return { fbrPosUpdate: { fbrPos: pos, userErrors: [] } };
        }
        case 'FbrPosDelete': {
          const deleted = {
            deletedSystem: pos?.system ?? null,
            deletedPosId: pos?.posId ?? null,
            userErrors: [],
          };
          pos = null;
          return { fbrPosDelete: deleted };
        }
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

describe('Reporting to FBR (POS-04, ADR-555, ADR-563)', () => {
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

    expect(await screen.findByRole('heading', { name: 'Reporting to FBR' })).toBeTruthy();
    expect(await screen.findByText('Not connected.')).toBeTruthy();
    expect(screen.getByText(/^Tier-1 retailers must report each sale to FBR/)).toBeTruthy();
    // A Tier-1 retailer most likely reports through its POS.
    expect(
      (screen.getByRole('radio', { name: /^FBR's POS integration/ }) as HTMLInputElement).checked,
    ).toBe(true);
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
        system: 'POS',
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
        system: 'POS',
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
    expect(within(shown).getByText('POS integration')).toBeTruthy();
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

  it("connects FBR's digital invoicing for a shop registered for sales tax, without a POS ID", async () => {
    const fake = core('owner', { settings: REGISTERED });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/tax');

    // Registered for sales tax and not a Tier-1 retailer, it most likely reports this way.
    const di = await screen.findByRole('radio', { name: /^FBR's digital invoicing/ });
    expect((di as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByLabelText('POS ID')).toBeNull();
    expect(screen.getByText(/^Each invoice goes to FBR with the seller details/)).toBeTruthy();
    expect(
      screen.getByText(/Credit notes are not sent: they go in your sales tax return\.$/),
    ).toBeTruthy();
    const token = screen.getByLabelText('Security token') as HTMLInputElement;
    expect(token.type).toBe('password');
    expect(token.required).toBe(true);
    expect(
      screen.getByText('The security token FBR issued you through IRIS for digital invoicing.'),
    ).toBeTruthy();

    type('PCT code', '6204.4200');
    fireEvent.submit(screen.getByRole('button', { name: 'Connect FBR' }).closest('form')!);
    expect(await screen.findByText('Type the token FBR gave.')).toBeTruthy();
    expect(token.getAttribute('aria-invalid')).toBe('true');
    expect(sentOf(fake, 'FbrPosUpdate')).toEqual([]);

    type('Security token', 'fbr-di-token-f818');
    fireEvent.click(screen.getByRole('button', { name: 'Connect FBR' }));
    await confirmIdentity('Password', 'a long password');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(
      await screen.findByText(
        "Connected through FBR's digital invoicing: invoices are reported to FBR as they are printed.",
      ),
    ).toBeTruthy();
    expect(sentOf(fake, 'FbrPosUpdate').at(-1)).toEqual({
      input: {
        system: 'DIGITAL_INVOICING',
        accessToken: 'fbr-di-token-f818',
        environment: 'SANDBOX',
        pctCode: '6204.4200',
      },
    });
    const shown = screen.getByText('•••• f818').closest('dl')!;
    expect(within(shown).getByText('Digital invoicing')).toBeTruthy();
    expect(within(shown).getByText('Security token')).toBeTruthy();
    expect(within(shown).queryByText('POS ID')).toBeNull();
    expect(
      screen.getByText(/^In FBR's sandbox: .* once FBR approves your digital invoicing\.$/),
    ).toBeTruthy();
    expect((screen.getByLabelText('New security token') as HTMLInputElement).required).toBe(false);
  });

  it("shows a shop not registered for sales tax as the system choice's problem", async () => {
    const fake = core('owner', { settings: { ...SETTINGS, tier1: false } });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/tax');

    // Neither a Tier-1 retailer nor registered for sales tax: the POS, as before.
    const pos = await screen.findByRole('radio', { name: /^FBR's POS integration/ });
    expect((pos as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /^FBR's digital invoicing/ }));
    type('Security token', 'fbr-di-token-f818');
    type('PCT code', '62044200');
    fireEvent.click(screen.getByRole('button', { name: 'Connect FBR' }));
    await confirmIdentity('Password', 'a long password');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    const problem = await screen.findByText(
      "FBR's digital invoicing is for sellers registered for sales tax: set the shop's NTN, STRN and province in its tax settings first",
    );
    const choice = screen.getByRole('group', { name: 'How the shop reports' });
    expect(choice.contains(problem)).toBe(true);
    expect(choice.getAttribute('aria-describedby')).toBe(problem.id);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(sentOf(fake, 'FbrPosUpdate').at(-1)).toEqual({
      input: {
        system: 'DIGITAL_INVOICING',
        accessToken: 'fbr-di-token-f818',
        environment: 'SANDBOX',
        pctCode: '62044200',
      },
    });
    expect(screen.getByText('Not connected.')).toBeTruthy();
  });

  it('shows a shop reporting through digital invoicing, without a POS ID, and disconnects it', async () => {
    const fake = core('manager', {
      connected: CONNECTED_DI,
      settings: REGISTERED,
      invoices: [
        {
          ...INVOICES[0]!,
          id: 'fi_5',
          system: 'DIGITAL_INVOICING',
          usin: 'INV/2026-27/00005',
          fbrInvoiceNumber: '3277876175852DI1760000000001',
        },
        {
          ...INVOICES[1]!,
          id: 'fi_4',
          system: 'DIGITAL_INVOICING',
          usin: 'CN/2026-27/00002',
          status: 'SKIPPED',
          attempts: 0,
          error: "Not sent: FBR's digital invoicing takes no credit notes",
        },
        ...INVOICES,
      ],
    });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/tax');

    const shown = (await screen.findByText('•••• f818')).closest('dl')!;
    expect(within(shown).getByText('Digital invoicing')).toBeTruthy();
    expect(within(shown).getByText('Production')).toBeTruthy();
    expect(within(shown).queryByText('POS ID')).toBeNull();
    expect(screen.queryByLabelText('POS ID')).toBeNull();
    expect(screen.queryByText(/^In FBR's sandbox/)).toBeNull();
    expect(
      (screen.getByRole('radio', { name: /^FBR's digital invoicing/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.getByText('Leave it blank to keep the one ending f818.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);

    // The list has some of each, so each row says how it was reported.
    const skipped = await waitFor(() => rowOf('CN/2026-27/00002'));
    expect(within(skipped).getByText('Digital invoicing')).toBeTruthy();
    expect(
      within(skipped).getByText("Not sent: FBR's digital invoicing takes no credit notes"),
    ).toBeTruthy();
    // Digital invoicing takes no credit notes, and the POS is no longer connected.
    expect(within(skipped).queryByRole('button', { name: 'Send again' })).toBeNull();
    expect(within(rowOf('CN/2026-27/00001')).getByText('POS integration')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send again' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect FBR' }));
    expect(screen.getByText(/^Disconnect FBR's digital invoicing\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('Not connected.')).toBeTruthy();
    expect(sentOf(fake, 'FbrPosDelete')).toEqual([{}]);
  });

  it('switches a connected POS to digital invoicing only with a new token', async () => {
    const fake = core('owner', {
      connected: CONNECTED,
      settings: { ...REGISTERED, tier1: true },
    });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/tax');

    expect(await screen.findByText('•••• Ab12')).toBeTruthy();
    expect(screen.queryByText(/^Switching how the shop reports/)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /^FBR's digital invoicing/ }));
    expect(
      screen.getByText(
        "Switching how the shop reports needs the new way's token, and a POS ID for a POS. Invoices still waiting to go the old way are not sent.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText('POS ID')).toBeNull();
    const token = screen.getByLabelText('Security token') as HTMLInputElement;
    expect(token.required).toBe(true);
    expect(screen.queryByText('Leave it blank to keep the one ending Ab12.')).toBeNull();

    fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form')!);
    expect(await screen.findByText('Type the token FBR gave.')).toBeTruthy();
    expect(sentOf(fake, 'FbrPosUpdate')).toEqual([]);

    type('Security token', 'fbr-di-token-f818');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await confirmIdentity('Password', 'a long password');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(
      await screen.findByText('Saved. Invoices printed from now on are reported like this.'),
    ).toBeTruthy();
    expect(sentOf(fake, 'FbrPosUpdate').at(-1)).toEqual({
      input: { system: 'DIGITAL_INVOICING', accessToken: 'fbr-di-token-f818' },
    });
    const shown = screen.getByText('•••• f818').closest('dl')!;
    expect(within(shown).getByText('Digital invoicing')).toBeTruthy();
    expect(within(shown).queryByText('812345')).toBeNull();
    expect(screen.queryByText(/^Switching how the shop reports/)).toBeNull();

    // Back to the POS, which needs its POS ID again.
    fireEvent.click(screen.getByRole('radio', { name: /^FBR's POS integration/ }));
    expect((screen.getByLabelText('POS ID') as HTMLInputElement).value).toBe('');
    type('Access token', 'fbr-pos-token-Zz99');
    fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form')!);
    expect(await screen.findByText('Type the number FBR gave, digits only.')).toBeTruthy();
    type('POS ID', '812345');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sentOf(fake, 'FbrPosUpdate').at(-1)).toEqual({
        input: { system: 'POS', posId: 812345, accessToken: 'fbr-pos-token-Zz99' },
      }),
    );
    expect(await within(shown).findByText('812345')).toBeTruthy();
    expect(within(shown).getByText('POS integration')).toBeTruthy();
  });

  it('is not shown to those who do not open settings', async () => {
    const fake = core('marketer', { connected: CONNECTED });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/tax');

    expect(await screen.findByRole('button', { name: 'Save sales tax' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Reporting to FBR' })).toBeNull();
    expect(sentOf(fake, 'FbrPos')).toEqual([]);
    expect(sentOf(fake, 'FiscalInvoices')).toEqual([]);
  });
});
