import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  confirmIdentity,
  fakeCore,
  LATER,
  REAUTHENTICATE,
  renderAdmin,
  signedIn,
} from '../test-support';
import { cliCodeOf } from './cli-login-page';

const LOGIN = {
  code: 'BCDF-GHJK',
  device: 'sana-laptop',
  access: 'READ',
  requestedFrom: '203.0.113.7',
  status: 'PENDING',
  expiresAt: LATER,
};

function core(
  options: { confirmed?: boolean; login?: object | null; role?: 'owner' | 'packer' } = {},
) {
  let confirmed = options.confirmed ?? true;
  return fakeCore(
    options.role ?? 'owner',
    (operation) => {
      if (operation === 'CliLogin')
        return { cliLogin: options.login === undefined ? LOGIN : options.login };
      if (operation === 'CliLoginApprove') {
        if (!confirmed) return REAUTHENTICATE;
        return {
          cliLoginApprove: {
            appName: 'Hatti CLI · sana-laptop',
            scopes: ['read_products'],
            userErrors: [],
          },
        };
      }
      if (operation === 'CliLoginDeny') return { cliLoginDeny: { denied: true } };
      return {};
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

describe("Letting a terminal's hatti login in (DEV-08, ADR-990)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const at = (search: string) =>
    vi.stubGlobal('location', { ...window.location, search, assign: vi.fn() });

  it('reads a code as linked or typed', () => {
    expect(cliCodeOf('bcdf ghjk')).toBe('BCDF-GHJK');
    expect(cliCodeOf('BCDFGHJK')).toBe('BCDF-GHJK');
    expect(cliCodeOf('ABCD-EFGH')).toBeNull();
    expect(cliCodeOf(null)).toBeNull();
  });

  it('shows the code and warns, then lets it in read-only once the owner confirms who they are', async () => {
    at('?code=BCDF-GHJK');
    signedIn();
    const fake = core({ confirmed: false });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/cli-login?code=BCDF-GHJK');

    expect(await screen.findByText('sana-laptop asks to sign in to your shop')).toBeTruthy();
    expect(screen.getByLabelText('Code').textContent).toBe('BCDF-GHJK');
    expect(screen.getByText('Asked from 203.0.113.7')).toBeTruthy();
    expect(screen.getByText(/^Approve only if you ran hatti login yourself just now/)).toBeTruthy();
    expect((screen.getByLabelText('It may') as HTMLSelectElement).value).toBe('READ');

    fireEvent.click(screen.getByRole('button', { name: 'Let it in' }));
    await confirmIdentity('Password', 'a long password');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(
      await screen.findByText(
        /^Your terminal is signed in to Zari, as the app Hatti CLI · sana-laptop/,
      ),
    ).toBeTruthy();
    const approvals = fake.sent.filter((each) => each.operation === 'CliLoginApprove');
    expect(approvals.at(-1)?.variables).toEqual({ code: 'BCDF-GHJK', access: 'READ' });
  });

  it('lets it read and change things where chosen', async () => {
    at('?code=BCDF-GHJK');
    signedIn();
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/cli-login?code=BCDF-GHJK');
    fireEvent.change(await screen.findByLabelText('It may'), { target: { value: 'WRITE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Let it in' }));
    await screen.findByText(/^Your terminal is signed in to Zari/);
    expect(fake.sent.find((each) => each.operation === 'CliLoginApprove')?.variables).toEqual({
      code: 'BCDF-GHJK',
      access: 'WRITE',
    });
  });

  it('refuses it', async () => {
    at('?code=BCDF-GHJK');
    signedIn();
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/cli-login?code=BCDF-GHJK');
    fireEvent.click(await screen.findByRole('button', { name: 'Refuse' }));
    expect(await screen.findByText('Refused: the terminal was given nothing.')).toBeTruthy();
    expect(fake.sent.some((each) => each.operation === 'CliLoginApprove')).toBe(false);
  });

  it('asks for the code where the link had none, and says when it has ended', async () => {
    at('');
    signedIn();
    vi.stubGlobal('fetch', core({ login: null }).fetcher);
    renderAdmin('/cli-login');
    const field = await screen.findByLabelText('Code');
    fireEvent.change(field, { target: { value: 'not it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('A code is eight letters, as XXXX-XXXX.')).toBeTruthy();
    fireEvent.change(field, { target: { value: 'bcdf ghjk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText(/^This code has ended or was answered already/)).toBeTruthy();
  });

  it('is for owners and managers alone', async () => {
    at('?code=BCDF-GHJK');
    signedIn();
    vi.stubGlobal('fetch', core({ role: 'packer' }).fetcher);
    renderAdmin('/cli-login?code=BCDF-GHJK');
    expect(await screen.findByText(/^Terminals are let in by owners and managers/)).toBeTruthy();
  });

  it('keeps the link while its person signs in, and opens it after', async () => {
    at('?code=BCDF-GHJK');
    vi.stubGlobal('fetch', core().fetcher);
    const { router } = renderAdmin('/cli-login?code=BCDF-GHJK');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
    expect(window.sessionStorage.getItem('hatti.oauth')).toBe('/cli-login?code=BCDF-GHJK');
    cleanup();

    signedIn();
    const second = renderAdmin('/shops');
    await waitFor(() => expect(second.router.state.location.pathname).toBe('/cli-login'));
    expect(await screen.findByText('sana-laptop asks to sign in to your shop')).toBeTruthy();
  });
});
