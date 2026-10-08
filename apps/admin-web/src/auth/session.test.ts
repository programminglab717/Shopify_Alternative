import { describe, expect, it } from 'vitest';
import type { Fetch } from '../api/client';
import { SessionStore, type SessionStorage, type Tokens } from './session';

const NOW = Date.parse('2026-10-08T10:00:00Z');

function tokens(n: number, accessMinutes = 15): Tokens {
  return {
    accessToken: `hsa_${n}`,
    accessTokenExpiresAt: new Date(NOW + accessMinutes * 60_000).toISOString(),
    refreshToken: `hsr_${n}`,
    refreshTokenExpiresAt: new Date(NOW + 30 * 86_400_000).toISOString(),
    session: { id: 'ses_1', mfaVerified: true, authenticatedAt: new Date(NOW).toISOString() },
  };
}

function memory(): SessionStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

/** A fake core: answers each path with what `routes` says, and records the calls. */
function core(routes: Record<string, (body: unknown, auth: string | null) => Response>) {
  const calls: { path: string; body: unknown; auth: string | null }[] = [];
  const fetcher: Fetch = async (path, init) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    const auth = (init?.headers as Record<string, string>)?.authorization ?? null;
    calls.push({ path, body, auth });
    const route = routes[path];
    if (!route) throw new Error(`unexpected ${path}`);
    // Answer on the next turn, as the network would, so that callers overlap.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return route(body, auth);
  };
  return { fetcher, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe("A staff member's session", () => {
  it('refreshes a token about to run out once, however many requests ask at once', async () => {
    const { fetcher, calls } = core({
      '/auth/refresh': () => json(200, tokens(2)),
    });
    const store = new SessionStore(fetcher, memory(), () => NOW);
    store.signedIn(tokens(1, 0.25));
    const got = await Promise.all([store.accessToken(), store.accessToken(), store.accessToken()]);
    expect(got).toEqual(['hsa_2', 'hsa_2', 'hsa_2']);
    expect(calls.filter((call) => call.path === '/auth/refresh')).toEqual([
      { path: '/auth/refresh', body: { refreshToken: 'hsr_1' }, auth: null },
    ]);
  });

  it('tries a GraphQL request once more with fresh tokens after a 401', async () => {
    const { fetcher, calls } = core({
      '/auth/refresh': () => json(200, tokens(2)),
      '/admin/api/2026-10/graphql': (_body, auth) =>
        auth === 'Bearer hsa_2'
          ? json(200, { data: { shop: { name: 'Zari' } } })
          : json(401, {
              errors: [{ message: 'Signed out', extensions: { code: 'UNAUTHENTICATED' } }],
            }),
    });
    const store = new SessionStore(fetcher, memory(), () => NOW);
    store.signedIn(tokens(1));
    expect(await store.graphql('shop_1', '{ shop { name } }')).toEqual({ shop: { name: 'Zari' } });
    expect(calls.map((call) => [call.path, call.auth])).toEqual([
      ['/admin/api/2026-10/graphql', 'Bearer hsa_1'],
      ['/auth/refresh', null],
      ['/admin/api/2026-10/graphql', 'Bearer hsa_2'],
    ]);
  });

  it("takes another tab's tokens rather than refreshing what it already used", async () => {
    const storage = memory();
    const { fetcher, calls } = core({});
    const store = new SessionStore(fetcher, storage, () => NOW);
    store.signedIn(tokens(1, 0.25));
    // Another tab refreshed and kept its tokens.
    storage.setItem('hatti.session', JSON.stringify(tokens(7)));
    expect(await store.accessToken()).toBe('hsa_7');
    expect(calls).toEqual([]);
  });

  it('signs out when the core says the session is over, and when it was never there', async () => {
    const storage = memory();
    const { fetcher } = core({
      '/auth/refresh': () =>
        json(401, { error: { code: 'SESSION_REVOKED', message: 'The session was revoked' } }),
    });
    const store = new SessionStore(fetcher, storage, () => NOW);
    expect(store.getSnapshot()).toEqual({ signedIn: false, mfaVerified: false });
    store.signedIn(tokens(1, 0.25));
    expect(store.getSnapshot()).toEqual({ signedIn: true, mfaVerified: true });
    let told = 0;
    store.subscribe(() => (told += 1));
    expect(await store.accessToken()).toBeNull();
    expect(store.getSnapshot().signedIn).toBe(false);
    expect(storage.data.size).toBe(0);
    expect(told).toBe(1);
  });

  it('keeps a session through a reload, and proves a second factor set up in it', () => {
    const storage = memory();
    const first = new SessionStore(core({}).fetcher, storage, () => NOW);
    first.signedIn({ ...tokens(1), session: { ...tokens(1).session, mfaVerified: false } });
    const reloaded = new SessionStore(core({}).fetcher, storage, () => NOW);
    expect(reloaded.getSnapshot()).toEqual({ signedIn: true, mfaVerified: false });
    reloaded.mfaProved();
    expect(new SessionStore(core({}).fetcher, storage, () => NOW).getSnapshot()).toEqual({
      signedIn: true,
      mfaVerified: true,
    });
  });
});
