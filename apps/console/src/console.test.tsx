import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createConsoleRouter } from './app';
import { CONTENT_SECURITY_POLICY, headersFile } from './headers';
import { keepSession, keepSignInState, sessionOf } from './session';
import type { SupportRequest } from './types';

const LATER = new Date(Date.now() + 8 * 3_600_000).toISOString();
const AGENT = { email: 'ayesha@hatti.pk', name: 'Ayesha', expiresAt: LATER };

const REQUEST: SupportRequest = {
  id: 'sreq_1',
  shop: { id: 'shop_1', name: 'Zari', plan: 'growth' },
  channel: 'whatsapp',
  topic: 'couriers',
  language: 'ur',
  priority: 2,
  message: 'ملتان کی بکنگ نہیں ہو رہی',
  callBack: null,
  createdAt: '2026-10-28T05:00:00Z',
  dueAt: '2026-10-28T09:00:00Z',
  late: true,
  lastInbound: { text: 'جلدی کریں', at: '2026-10-28T06:00:00Z' },
};

interface Sent {
  method: string;
  path: string;
  body: unknown;
  token: string | null;
}

/** The console's server, faked: its answers as the test sets them, what it was sent kept. */
function fakeServer(options: { requests?: SupportRequest[]; signedOut?: boolean } = {}) {
  const sent: Sent[] = [];
  let requests = [...(options.requests ?? [])];
  const actions: unknown[] = [];
  const json = (status: number, body: unknown) =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^\/console\/api/, '');
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    const authorization = new Headers(init?.headers).get('authorization');
    sent.push({
      method: init?.method ?? 'GET',
      path,
      body,
      token: authorization?.replace(/^Bearer /, '') ?? null,
    });
    if (path === '/auth/start') {
      return json(200, { url: 'https://login.hatti.example/authorize?state=s1', state: 's1' });
    }
    if (path === '/auth/redeem') {
      return (body as { code: string }).code === 'good'
        ? json(200, { token: 'hcs_1', agent: AGENT })
        : json(400, { error: { code: 'CONSOLE_EXPIRED', message: 'This sign-in has expired' } });
    }
    if (path === '/auth/sign-out') return json(204, null);
    if (options.signedOut) {
      return json(401, {
        error: { code: 'CONSOLE_SIGNED_OUT', message: 'Your console session has ended' },
      });
    }
    if (path === '/support-requests') return json(200, { requests });
    const answering = /^\/support-requests\/([^/]+)\/answer$/.exec(path);
    if (answering) {
      const answer = (body as { answer: string }).answer;
      if (!answer.trim()) {
        return json(422, {
          error: { code: 'BLANK', message: 'Say what Hatti answers', fields: { answer: 'BLANK' } },
        });
      }
      const request = requests.find((each) => each.id === answering[1])!;
      requests = requests.filter((each) => each !== request);
      actions.unshift({
        id: `a${actions.length}`,
        email: AGENT.email,
        action: 'support_request.answer',
        subject: request.id,
        details: {},
        at: '2026-10-28T07:00:00Z',
      });
      return json(200, { request, whatsapp: 'window_closed' });
    }
    if (path.startsWith('/actions')) return json(200, { actions });
    return json(404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
  });
  return { fetcher, sent };
}

function renderConsole(path: string) {
  const router = createConsoleRouter(createMemoryHistory({ initialEntries: [path] }));
  render(<App router={router} />);
  return router;
}

describe("Hatti's console (ADR-876)", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends an agent who isn't signed in to Hatti's sign-in, keeping its state in the tab", async () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      assign,
    } as Location);
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetcher);
    const router = renderConsole('/support');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Hatti' }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://login.hatti.example/authorize?state=s1'),
    );
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(window.sessionStorage.getItem('hatti.console.state')).toBe('s1');
  });

  it('takes the answer of a sign-in this tab began, once, and opens the requests', async () => {
    const server = fakeServer({ requests: [REQUEST] });
    vi.stubGlobal('fetch', server.fetcher);
    keepSignInState('s1');
    const router = renderConsole('/signed-in?code=good&state=s1');
    expect(await screen.findByRole('heading', { name: 'Support requests' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/support');
    expect(sessionOf()).toEqual({ token: 'hcs_1', agent: AGENT });
    expect(server.sent.filter((each) => each.path === '/auth/redeem')).toHaveLength(1);
    expect(window.sessionStorage.getItem('hatti.console.state')).toBeNull();
    expect(screen.getByText(/^ayesha@hatti\.pk, until/)).toBeTruthy();
  });

  it("refuses an answer this tab didn't ask for, and says why the provider refused", async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetcher);
    keepSignInState('s1');
    renderConsole('/signed-in?code=good&state=other');
    expect(await screen.findByText(/wasn't started in this tab/)).toBeTruthy();
    expect(server.sent.filter((each) => each.path === '/auth/redeem')).toEqual([]);
    cleanup();

    renderConsole('/signed-in?error=no_key');
    expect(await screen.findByText('Sign in with your security key.')).toBeTruthy();
    cleanup();

    keepSignInState('s1');
    renderConsole('/signed-in?code=stale&state=s1');
    expect(await screen.findByText('That sign-in expired. Start it again.')).toBeTruthy();
    expect(sessionOf()).toBeNull();
  });

  it('answers a request as the agent, says how it went, and logs it', async () => {
    keepSession({ token: 'hcs_1', agent: AGENT });
    const server = fakeServer({ requests: [REQUEST] });
    vi.stubGlobal('fetch', server.fetcher);
    renderConsole('/support');
    expect(await screen.findByText('ملتان کی بکنگ نہیں ہو رہی')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Zari/ })).toBeTruthy();
    expect(screen.getByText(/^Late: was due/)).toBeTruthy();
    expect(screen.getByText('جلدی کریں')).toBeTruthy();
    const answer = screen.getByLabelText('Answer (they asked in Urdu)');
    expect(answer.getAttribute('lang')).toBe('ur');

    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(await screen.findByText('Say what Hatti answers')).toBeTruthy();
    expect(answer.getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(answer, { target: { value: 'پوسٹ ایکس نے ٹھیک کر دیا' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(
      await screen.findByText(
        'Answered: Zari sees it in its admin. Not sent on WhatsApp: more than 24 hours since they last wrote.',
      ),
    ).toBeTruthy();
    expect(await screen.findByText('No request waits.')).toBeTruthy();
    const answered = server.sent.filter((each) => each.path === '/support-requests/sreq_1/answer');
    expect(answered.at(-1)).toMatchObject({
      method: 'POST',
      body: { answer: 'پوسٹ ایکس نے ٹھیک کر دیا' },
      token: 'hcs_1',
    });

    fireEvent.click(screen.getByRole('link', { name: 'Log' }));
    expect(await screen.findByText('support_request.answer')).toBeTruthy();
    expect(screen.getByText('sreq_1')).toBeTruthy();
  });

  it('goes back to signing in once the session has ended, and signs out', async () => {
    keepSession({ token: 'hcs_1', agent: AGENT });
    vi.stubGlobal('fetch', fakeServer({ signedOut: true }).fetcher);
    const router = renderConsole('/support');
    expect(await screen.findByText('Your session ended. Sign in again.')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(sessionOf()).toBeNull();
    cleanup();

    keepSession({ token: 'hcs_1', agent: AGENT });
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetcher);
    const again = renderConsole('/support');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(again.state.location.pathname).toBe('/sign-in'));
    expect(server.sent.find((each) => each.path === '/auth/sign-out')?.token).toBe('hcs_1');
    expect(sessionOf()).toBeNull();
  });

  it("runs the console's own scripts alone, never framed or indexed", () => {
    expect(CONTENT_SECURITY_POLICY['script-src']).toEqual(["'self'"]);
    expect(CONTENT_SECURITY_POLICY['connect-src']).toEqual(["'self'"]);
    expect(headersFile()).toContain('X-Frame-Options: DENY');
    expect(headersFile()).toContain('X-Robots-Tag: noindex, nofollow');
  });
});
