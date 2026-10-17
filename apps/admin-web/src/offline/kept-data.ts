import { onlineManager, type QueryClient, type QueryKey } from '@tanstack/react-query';
import type { SessionStore } from '../auth/session';

/**
 * The shop's last data kept for use offline (ADR-514): what staff last saw of Home, the orders and
 * customers lists' first pages, the orders and customers they opened, and the account's shops to
 * open them in, kept in the browser's storage for the session that read them. Another session on
 * the same phone never sees it; signing out forgets it.
 */

export const KEPT_KEY = 'hatti.kept';

export const KEPT_LIMITS = {
  /** The most queries kept, the latest first. */
  queries: 40,
  /** About as much of the browser's storage as they may take, in characters. */
  size: 1_500_000,
  /** Kept data older than this is not shown. */
  age: 3 * 86_400_000,
};

/** The pages whose data is kept, by the name after the shop in their query's key. */
const KEPT_PAGES = new Set(['home', 'homeStock', 'orders', 'order', 'customers', 'customer']);

export interface KeptQuery {
  key: QueryKey;
  data: unknown;
  /** When the data was fetched, in milliseconds. */
  at: number;
}

interface Kept {
  session: string;
  queries: KeptQuery[];
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Queries take the browser to be online until it says otherwise, and a phone that opens the admin
 * offline says nothing: told at once, the kept pages' queries wait for a connection instead of
 * failing over what they show.
 */
export function startAsTheBrowserIs(): void {
  if (typeof navigator !== 'undefined') onlineManager.setOnline(navigator.onLine);
}

/** Whether a query's data is kept: the account's, or one of the kept pages of a shop. */
export function isKept(key: QueryKey): boolean {
  if (key.length === 1 && key[0] === 'me') return true;
  return key[0] === 'admin' && typeof key[2] === 'string' && KEPT_PAGES.has(key[2]);
}

/** A list read page by page keeps its first page alone. */
function firstPage(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) return data;
  const { pages, pageParams } = data as { pages?: unknown; pageParams?: unknown };
  if (!Array.isArray(pages) || !Array.isArray(pageParams)) return data;
  return { pages: pages.slice(0, 1), pageParams: pageParams.slice(0, 1) };
}

/** What the client holds that is kept, the latest first, within the limits. */
export function keptQueriesOf(client: QueryClient): KeptQuery[] {
  const queries = client
    .getQueryCache()
    .getAll()
    .filter(
      (query) =>
        isKept(query.queryKey) &&
        query.state.status === 'success' &&
        query.state.data !== undefined,
    )
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
  const kept: KeptQuery[] = [];
  let size = 0;
  for (const query of queries) {
    if (kept.length === KEPT_LIMITS.queries) break;
    const entry = {
      key: query.queryKey,
      data: firstPage(query.state.data),
      at: query.state.dataUpdatedAt,
    };
    const length = JSON.stringify(entry).length;
    if (size + length > KEPT_LIMITS.size) continue;
    size += length;
    kept.push(entry);
  }
  return kept;
}

/** Keeps what the client holds for the session. */
export function keepData(client: QueryClient, session: string, storage: Storage): void {
  const kept: Kept = { session, queries: keptQueriesOf(client) };
  try {
    storage.setItem(KEPT_KEY, JSON.stringify(kept));
  } catch {
    // The browser's storage is full or refused: nothing is kept this time.
  }
}

/** Forgets what was kept. */
export function forgetKept(storage: Storage): void {
  try {
    storage.removeItem(KEPT_KEY);
  } catch {
    // Nothing to forget.
  }
}

/**
 * Puts what the session kept back in the client, each query as old as its data, so that each is
 * fetched again as its page opens online and shown as it was offline. What another session kept
 * is forgotten instead.
 */
export function restoreKept(
  client: QueryClient,
  session: string | null,
  storage: Storage,
  now: number = Date.now(),
): number {
  let kept: Kept | null;
  try {
    kept = JSON.parse(storage.getItem(KEPT_KEY) ?? 'null') as Kept | null;
  } catch {
    kept = null;
  }
  if (!kept || !Array.isArray(kept.queries)) return 0;
  if (!session || kept.session !== session) {
    forgetKept(storage);
    return 0;
  }
  let restored = 0;
  for (const { key, data, at } of kept.queries) {
    if (!Array.isArray(key) || !isKept(key) || typeof at !== 'number') continue;
    if (now - at > KEPT_LIMITS.age) continue;
    client.setQueryData(key, data, { updatedAt: at });
    restored += 1;
  }
  return restored;
}

/**
 * Keeps the client's data for the signed-in session as queries succeed, a second after the last
 * of them, and forgets it once the session ends, here or in another tab. Returns its undoing.
 */
export function keepShopData(
  client: QueryClient,
  session: SessionStore,
  storage: Storage | null = safeStorage(),
  delay = 1_000,
): () => void {
  if (!storage) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    timer = undefined;
    const id = session.sessionId();
    if (id) keepData(client, id, storage);
  };
  const unsubscribeCache = client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    if (!isKept(event.query.queryKey)) return;
    if (timer === undefined) timer = setTimeout(save, delay);
  });
  const unsubscribeSession = session.subscribe(() => {
    if (session.sessionId()) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    forgetKept(storage);
  });
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    unsubscribeCache();
    unsubscribeSession();
  };
}

function safeStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
