import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

function core(role: StaffRole, test = false) {
  let status = 'PENDING';
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'AppPurchase':
        return {
          appPurchaseOneTime:
            variables.id === 'achg_1'
              ? {
                  id: 'achg_1',
                  name: 'Photo reviews, for good',
                  appName: 'Reviews Pro',
                  price: { amount: '2500.00' },
                  status,
                  test,
                  returnUrl: 'https://reviews.example.pk/charged',
                }
              : null,
        };
      case 'AppPurchaseApprove':
        status = test ? 'PAID' : 'ACCEPTED';
        return {
          appPurchaseOneTimeApprove: {
            appPurchaseOneTime: { id: 'achg_1', status },
            invoiceId: test ? null : 'binv_7',
            userErrors: [],
          },
        };
      case 'AppPurchaseDecline':
        status = 'DECLINED';
        return {
          appPurchaseOneTimeDecline: {
            appPurchaseOneTime: { id: 'achg_1', status },
            userErrors: [],
          },
        };
      case 'BillingInvoicePay':
        return {
          billingInvoicePay: { checkoutUrl: 'https://pay.example.pk/binv_7', userErrors: [] },
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe("An app's one-time charge (DEV-05, ADR-854)", () => {
  const assign = vi.fn();

  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
    assign.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('is approved by the owner and paid through Hatti at once', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/apps/charges/achg_1');
    vi.stubGlobal('location', { ...window.location, assign });

    expect(await screen.findByText('Reviews Pro asks to charge Rs 2,500 once, for:')).toBeTruthy();
    expect(screen.getByText('Photo reviews, for good')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve and pay Rs 2,500' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://pay.example.pk/binv_7'));
    expect(screen.getByRole('link', { name: 'Back to Reviews Pro' }).getAttribute('href')).toBe(
      'https://reviews.example.pk/charged',
    );
  });

  it('pays a test at once, or is declined', async () => {
    vi.stubGlobal('fetch', core('owner', true).fetcher);
    renderAdmin('/shop_1/settings/apps/charges/achg_1');
    expect(await screen.findByText(/^A test, on a development store/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve the test' }));
    expect(await screen.findByText('Paid.')).toBeTruthy();
    cleanup();

    vi.stubGlobal('fetch', core('owner').fetcher);
    renderAdmin('/shop_1/settings/apps/charges/achg_1');
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    expect(await screen.findByText('Declined.')).toBeTruthy();
  });

  it('is answered by the owner alone, and says so of a charge no app asked', async () => {
    vi.stubGlobal('fetch', core('manager').fetcher);
    renderAdmin('/shop_1/settings/apps/charges/achg_1');
    expect(await screen.findByText("Only the shop's owner answers what apps charge.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    cleanup();

    vi.stubGlobal('fetch', core('owner').fetcher);
    renderAdmin('/shop_1/settings/apps/charges/achg_404');
    expect(await screen.findByText('No app asked this charge.')).toBeTruthy();
  });
});
