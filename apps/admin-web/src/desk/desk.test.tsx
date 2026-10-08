import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserFetch } from '../api/client';
import { SessionProvider } from '../auth/context';
import { SessionStore } from '../auth/session';
import { LocaleProvider } from '../i18n/locale';
import { createAdminRouter } from '../router';

const LATER = new Date(Date.now() + 3_600_000).toISOString();
const PLACED = new Date(Date.now() - 600_000).toISOString();

function order(id: string, name: string, total: string) {
  return {
    id,
    name,
    createdAt: PLACED,
    stage: 'NEEDS_CONFIRMATION',
    paymentMethod: 'COD',
    overPlanLimit: false,
    note: null,
    phone: '0300 ••••567',
    totalPrice: { amount: total, currencyCode: 'PKR' },
    codAmount: { amount: total, currencyCode: 'PKR' },
    shippingAddress: { name: 'Ayesha Khan', city: 'Karachi', formatted: ['House 12', 'Karachi'] },
    customer: { displayName: 'Ayesha Khan', numberOfOrders: 1 },
    risk: { level: 'LOW', score: 10, reasons: [] },
    lineItems: [{ id: `${id}-1`, title: 'Sindhi Ajrak', variantTitle: null, quantity: 1 }],
  };
}

/**
 * A fake core with a desk of two orders due: it deals the first due to whoever asks, and an order
 * leaves the queue once its call is recorded.
 */
function fakeCore() {
  const orders = [order('ord_1', '#1001', '5599.00'), order('ord_2', '#1002', '2100.00')];
  const due = new Set(orders.map((item) => item.id));
  let held: string | null = null;
  let later = 0;
  const sent: { operation: string; variables: Record<string, unknown> }[] = [];

  const item = (id: string) => ({
    claimedByYou: held === id,
    claimedUntil: held === id ? LATER : null,
    dueAt: PLACED,
    overdue: false,
    unansweredCalls: 0,
    lastCall: null,
    order: orders.find((each) => each.id === id)!,
  });
  const answer = (operation: string, variables: Record<string, unknown>): unknown => {
    switch (operation) {
      case 'Shop':
        return {
          shop: {
            id: 'shop_1',
            name: 'Zari',
            handle: 'zari',
            currencyCode: 'PKR',
            timezone: 'Asia/Karachi',
          },
        };
      case 'ConfirmationQueue':
        return {
          shop: { timezone: 'Asia/Karachi' },
          confirmationQueue: {
            callingNow: true,
            callingOpensAt: null,
            dueCount: due.size,
            laterCount: later,
            overdueCount: 0,
            nodes: [...due].map(item),
          },
        };
      case 'ConfirmationQueueNext': {
        held = held && due.has(held) ? held : ([...due][0] ?? null);
        return { confirmationQueueNext: { callingOpensAt: null, item: held ? item(held) : null } };
      }
      case 'OrderPhoneReveal':
        return { orderPhoneReveal: { phone: '+923001234567', userErrors: [] } };
      case 'OrderConfirmationCall':
      case 'OrderConfirm': {
        const id = variables.id as string;
        due.delete(id);
        if (operation === 'OrderConfirmationCall') later += 1;
        if (held === id) held = null;
        const payload = { order: { id, stage: 'NEEDS_CONFIRMATION' }, userErrors: [] };
        return operation === 'OrderConfirm'
          ? { orderConfirm: payload }
          : { orderConfirmationCall: payload };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  };

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/auth/me') {
      return json({
        user: { id: 'usr_1', name: 'Sana', language: 'en' },
        session: { id: 'ses_1', mfaVerified: false },
        shops: [{ id: 'shop_1', name: 'Zari', role: 'confirmation_agent', mfaRequired: false }],
      });
    }
    const { query, variables } = JSON.parse(String(init!.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const operation = /(?:query|mutation) (\w+)/.exec(query)![1]!;
    sent.push({ operation, variables });
    return json({ data: answer(operation, variables) });
  });
  return { fetcher, sent };
}

const press = async (name: string) => {
  await act(async () => fireEvent.click(screen.getByRole('button', { name })));
};

describe('The Confirmation Desk', () => {
  let core: ReturnType<typeof fakeCore>;

  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(
      'hatti.session',
      JSON.stringify({
        accessToken: 'hsa_1',
        accessTokenExpiresAt: LATER,
        refreshToken: 'hsr_1',
        refreshTokenExpiresAt: LATER,
        session: { id: 'ses_1', mfaVerified: false, authenticatedAt: PLACED },
      }),
    );
    core = fakeCore();
    vi.stubGlobal('fetch', core.fetcher);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('deals an agent one order at a time, and the next as soon as a call is recorded', async () => {
    const session = new SessionStore(browserFetch);
    const router = createAdminRouter(
      session,
      createMemoryHistory({ initialEntries: ['/shop_1/desk'] }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <LocaleProvider initial="en">
        <SessionProvider store={session}>
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </SessionProvider>
      </LocaleProvider>,
    );

    await screen.findByText('2 due');
    await press('Take the next order');
    await screen.findByText('How did the call go?');
    expect(screen.getAllByText('#1001')).toHaveLength(2);

    // The number stays masked until the agent asks for it, which the core logs.
    expect(screen.getByText('0300 ••••567')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Call' })).toBeNull();
    await press('Show number');
    const call = await screen.findByRole('link', { name: 'Call' });
    expect(call.getAttribute('href')).toBe('tel:+923001234567');
    expect(screen.getByRole('link', { name: 'WhatsApp' }).getAttribute('href')).toBe(
      'https://wa.me/923001234567',
    );

    await press('No answer');
    await screen.findByText('Rs 2,100', { selector: '.font-semibold' });
    expect(screen.getByRole('button', { name: 'Show number' })).toBeTruthy();
    expect(core.sent.find((each) => each.operation === 'OrderConfirmationCall')?.variables).toEqual(
      { id: 'ord_1', outcome: 'NO_ANSWER', note: null, callBackAt: null },
    );

    await press('Confirmed');
    await screen.findByText('No orders to call right now.');
    await screen.findByText('0 due · 1 to call later');
    expect(core.sent.map((each) => each.operation)).toEqual(
      expect.arrayContaining(['OrderPhoneReveal', 'OrderConfirm']),
    );
    expect(core.sent.filter((each) => each.operation === 'ConfirmationQueueNext')).toHaveLength(3);
  });
});
