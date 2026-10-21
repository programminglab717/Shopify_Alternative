import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorText } from '../i18n/errors';
import { LocaleProvider, translate } from '../i18n/locale';
import { AppNotices } from '../offline/notices';
import {
  ApiError,
  authRequest,
  busyUntil,
  graphqlRequest,
  isCostRefusal,
  throttleWait,
  type Fetch,
  type QueryCost,
} from './client';

const OPTIONS = { accessToken: 'hsa_1', shopId: 'shop_1' };

const cost = (requested: number, available: number, restoreRate = 100): QueryCost => ({
  requestedQueryCost: requested,
  actualQueryCost: null,
  throttleStatus: { maximumAvailable: 2000, currentlyAvailable: available, restoreRate },
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const throttled = (requested: number, available: number) =>
  json({
    data: null,
    errors: [
      {
        message: 'Throttled: try again in a moment',
        extensions: { code: 'THROTTLED', cost: requested },
      },
    ],
    extensions: { cost: cost(requested, available) },
  });

/** A fake core answering each request with the next of `answers`, recording what it was sent. */
function core(...answers: (() => Response)[]) {
  const calls: { body: string; headers: Record<string, string> }[] = [];
  const fetcher: Fetch = async (_path, init) => {
    calls.push({ body: String(init?.body), headers: init?.headers as Record<string, string> });
    const answer = answers[Math.min(calls.length, answers.length) - 1];
    if (!answer) throw new Error('no answer');
    return answer();
  };
  return { fetcher, calls };
}

/** Lets the client read an answer and start whatever it waits for, without moving the clock. */
const settle = () => act(() => vi.advanceTimersByTimeAsync(0));

describe("The Admin API's query cost (ADR-577)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('waits as long as the bucket needs, from one second to thirty', () => {
    expect(throttleWait(cost(250, 50))).toBe(2);
    expect(throttleWait(cost(201, 100))).toBe(2);
    expect(throttleWait(cost(150, 100))).toBe(1);
    expect(throttleWait(cost(100, 100))).toBe(1);
    expect(throttleWait(cost(9000, 0))).toBe(30);
    expect(throttleWait(cost(100, 0, 0))).toBe(30);
    expect(throttleWait(undefined)).toBe(1);
  });

  it('sends a throttled query again once the bucket holds enough', async () => {
    const { fetcher, calls } = core(
      () => throttled(250, 50),
      () => json({ data: { shop: { name: 'Zainab' } } }),
    );
    let done: unknown;
    void graphqlRequest(fetcher, 'query { shop { name } }', undefined, OPTIONS).then(
      (data) => (done = data),
    );
    await settle();
    expect(calls).toHaveLength(1);
    expect(busyUntil()).toBe(Date.now() + 2000);

    await act(() => vi.advanceTimersByTimeAsync(1999));
    expect(calls).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toBe(calls[0]!.body);
    expect(done).toEqual({ shop: { name: 'Zainab' } });
    expect(busyUntil()).toBeNull();
  });

  it('sends a throttled mutation again with the same Idempotency-Key', async () => {
    const { fetcher, calls } = core(
      () => throttled(10, 0),
      () => json({ data: { orderCancel: { userErrors: [] } } }),
    );
    const sent = graphqlRequest(
      fetcher,
      'mutation { orderCancel(id: "o_1") { userErrors { message } } }',
      { id: 'o_1' },
      { ...OPTIONS, idempotencyKey: 'key-1' },
    );
    await settle();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await expect(sent).resolves.toEqual({ orderCancel: { userErrors: [] } });
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.headers['idempotency-key'])).toEqual(['key-1', 'key-1']);
    expect(calls[1]!.body).toBe(calls[0]!.body);
  });

  it('gives up after three more tries, saying the shop is busy', async () => {
    const { fetcher, calls } = core(() => throttled(300, 100));
    const sent = graphqlRequest(fetcher, 'query { orders { id } }', undefined, OPTIONS);
    const failure = sent.catch((error: unknown) => error);
    await settle();
    for (let wait = 0; wait < 3; wait++) await act(() => vi.advanceTimersByTimeAsync(2000));
    const error = await failure;
    expect(calls).toHaveLength(4);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 200,
      code: 'THROTTLED',
      message: 'Hatti is busy for this shop right now; try again in a moment',
      retryAfter: 2,
    });
    expect(isCostRefusal(error)).toBe(true);
    expect(busyUntil()).toBeNull();
    expect(errorText(error, (key) => translate('en', key))).toBe(
      'Hatti is busy for this shop right now. Try again in a moment.',
    );
    expect(errorText(error, (key) => translate('ur', key))).toBe(
      'ہٹی اس وقت اس دکان کے لیے مصروف ہے۔ تھوڑی دیر میں دوبارہ کوشش کریں۔',
    );
  });

  it('never sends a query too costly to run again', async () => {
    const { fetcher, calls } = core(() =>
      json({
        data: null,
        errors: [
          {
            message: 'Query cost 2400 exceeds the maximum of 1000',
            extensions: { code: 'MAX_COST_EXCEEDED', cost: 2400, maxCost: 1000 },
          },
        ],
      }),
    );
    const error = await graphqlRequest(fetcher, 'query { a }', undefined, OPTIONS).catch(
      (failure: unknown) => failure,
    );
    expect(calls).toHaveLength(1);
    expect(error).toMatchObject({ status: 200, code: 'MAX_COST_EXCEEDED' });
    expect(isCostRefusal(error)).toBe(true);
    expect(busyUntil()).toBeNull();
    expect(errorText(error, (key) => translate('en', key))).toBe(
      'This page asks Hatti for too much at once. Try showing fewer items or narrowing the search.',
    );
  });

  it('takes an answer as it was, whatever its cost', async () => {
    const { fetcher, calls } = core(() =>
      json({ data: { shop: { name: 'Zainab' } }, extensions: { cost: cost(5, 1995) } }),
    );
    await expect(graphqlRequest(fetcher, 'query { a }', undefined, OPTIONS)).resolves.toEqual({
      shop: { name: 'Zainab' },
    });
    expect(calls).toHaveLength(1);
    expect(busyUntil()).toBeNull();
    expect(isCostRefusal(new ApiError(200, 'BAD_USER_INPUT', 'No'))).toBe(false);
    expect(isCostRefusal(new Error('THROTTLED'))).toBe(false);
  });

  it('says quietly, above every page, that Hatti is busy and when it tries again', async () => {
    render(
      <LocaleProvider initial="en">
        <AppNotices />
      </LocaleProvider>,
    );
    expect(screen.queryByRole('status')).toBeNull();
    const { fetcher } = core(
      () => throttled(250, 50),
      () => json({ data: { shop: { name: 'Zainab' } } }),
    );
    const sent = graphqlRequest(fetcher, 'query { shop { name } }', undefined, OPTIONS);
    await settle();
    expect(screen.getByRole('status').textContent).toBe(
      'Hatti is busy for this shop. Trying again in 2 seconds…',
    );
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByRole('status').textContent).toBe(
      'Hatti is busy for this shop. Trying again in 1 second…',
    );
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await expect(sent).resolves.toEqual({ shop: { name: 'Zainab' } });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says it in Urdu too', async () => {
    render(
      <LocaleProvider initial="ur">
        <AppNotices />
      </LocaleProvider>,
    );
    const { fetcher } = core(
      () => throttled(350, 50),
      () => json({ data: {} }),
    );
    const sent = graphqlRequest(fetcher, 'query { a }', undefined, OPTIONS);
    await settle();
    expect(screen.getByRole('status').textContent).toBe(
      'ہٹی اس دکان کے لیے مصروف ہے۔ 3 سیکنڈ میں دوبارہ کوشش ہو گی…',
    );
    await act(() => vi.advanceTimersByTimeAsync(3000));
    await sent;
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe("The browser's own ID, sent with each sign-in (ADR-179, ADR-681)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('makes one the first time, keeps it, and sends the same with every request to /auth', async () => {
    const fake = core(
      () => json({ accessToken: 'a' }),
      () => json({ accessToken: 'b' }),
    );
    await authRequest(fake.fetcher, '/auth/sign-in', { body: { email: 'a@zari.pk' } });
    await authRequest(fake.fetcher, '/auth/sessions', { accessToken: 'hsa_1' });
    const [first, second] = fake.calls.map((each) => each.headers['x-hatti-device']);
    expect(first).toMatch(/^[\w-]{32}$/);
    expect(second).toBe(first);
    expect(window.localStorage.getItem('hatti.device')).toBe(first);

    // Another browser, or this one with its data cleared, is another device.
    window.localStorage.clear();
    await authRequest(fake.fetcher, '/auth/sign-in', { body: {} });
    expect(fake.calls[2]!.headers['x-hatti-device']).toMatch(/^[\w-]{32}$/);
    expect(fake.calls[2]!.headers['x-hatti-device']).not.toBe(first);
  });

  it('sends none where the browser keeps nothing, never an ID made anew for each request', async () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('Access is denied for this document.', 'SecurityError');
    });
    const fake = core(() => json({}));
    await authRequest(fake.fetcher, '/auth/sign-in', { body: {} });
    expect(fake.calls[0]!.headers['x-hatti-device']).toBeUndefined();
  });
});
