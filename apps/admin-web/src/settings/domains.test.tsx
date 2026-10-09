import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';

const EARLIER = new Date(Date.now() - 2 * 86_400_000).toISOString();

function domain(id: string, host: string, extra: object = {}) {
  return {
    id,
    host,
    url: `https://${host}`,
    dnsTarget: 'shops.hatti.pk',
    isPrimary: false,
    isVerified: false,
    verifiedAt: null,
    unpointedSince: null,
    ...extra,
  };
}

/** A fake core with the shop's domains, which change as the page asks. */
function core(role: StaffRole, onFree = false) {
  let domains = [
    domain('dom_1', 'www.zari.pk', { isVerified: true, isPrimary: true, verifiedAt: EARLIER }),
    domain('dom_2', 'zari.com.pk'),
  ];
  const payload = (field: string, changed: object | null, errors: object[] = []) => ({
    [field]: { domain: changed, userErrors: errors },
  });
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'ShopDomains':
        return {
          shop: { url: domains.find((each) => each.isPrimary)?.url ?? 'https://zari.hatti.pk' },
          domains,
        };
      case 'DomainCreate': {
        const host = (variables.domain as { host: string }).host;
        if (onFree) {
          return payload('domainCreate', null, [
            {
              field: ['domain'],
              code: 'PLAN',
              message: 'Free has no domains of its own: choose Basic or above',
            },
          ]);
        }
        const made = domain('dom_3', host);
        domains = [...domains, made];
        return payload('domainCreate', made);
      }
      case 'DomainVerify':
        return payload('domainVerify', null, [
          {
            field: ['id'],
            code: 'NOT_POINTED',
            message: 'zari.com.pk points at 203.0.113.9, not at shops.hatti.pk',
          },
        ]);
      case 'DomainUpdate': {
        const isPrimary = (variables.domain as { isPrimary: boolean }).isPrimary;
        domains = domains.map((each) => (each.id === variables.id ? { ...each, isPrimary } : each));
        return payload(
          'domainUpdate',
          domains.find((each) => each.id === variables.id)!,
        );
      }
      case 'DomainDelete':
        domains = domains.filter((each) => each.id !== variables.id);
        return { domainDelete: { deletedDomainId: variables.id, userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe("The shop's domains", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('connects one, says where to point it, and names why a check failed', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings');

    fireEvent.click(await screen.findByRole('link', { name: /Domains/ }));
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(screen.getByText('Primary')).toBeTruthy();
    expect(screen.getByText('Not pointed at Hatti yet')).toBeTruthy();
    expect(
      screen.getByText('At the company you bought zari.com.pk from, add this record:'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Check zari.com.pk again' }));
    expect(
      await screen.findByText('zari.com.pk points at 203.0.113.9, not at shops.hatti.pk'),
    ).toBeTruthy();

    type('Domain', ' shop.zari.pk ');
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(
      await screen.findByText('At the company you bought shop.zari.pk from, add this record:'),
    ).toBeTruthy();
    expect(sentOf(fake, 'DomainCreate')).toEqual([{ domain: { host: 'shop.zari.pk' } }]);
    expect((screen.getByLabelText('Domain') as HTMLInputElement).value).toBe('');
  });

  it('makes a domain primary no more, and removes one once asked', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/domains');

    fireEvent.click(await screen.findByRole('button', { name: 'Stop www.zari.pk being primary' }));
    expect(await screen.findByText('zari.hatti.pk')).toBeTruthy();
    expect(screen.queryByText('Primary')).toBeNull();
    expect(sentOf(fake, 'DomainUpdate')).toEqual([{ id: 'dom_1', domain: { isPrimary: false } }]);

    fireEvent.click(screen.getByRole('button', { name: 'Remove zari.com.pk' }));
    const ask = screen.getByText(/^Remove zari\.com\.pk\?/).closest('div')!.parentElement!;
    fireEvent.click(within(ask).getByRole('button', { name: 'Remove it' }));
    await waitFor(() => expect(screen.queryByText('Not pointed at Hatti yet')).toBeNull());
    expect(sentOf(fake, 'DomainDelete')).toEqual([{ id: 'dom_2' }]);
  });

  it("says why a plan without domains of its own can't connect one", async () => {
    vi.stubGlobal('fetch', core('owner', true).fetcher);
    renderAdmin('/shop_1/settings/domains');
    await screen.findByText('Connected');
    type('Domain', 'www.zari.pk');
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(
      await screen.findByText('Free has no domains of its own: choose Basic or above'),
    ).toBeTruthy();
  });
});
