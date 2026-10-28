import { ApiError } from '../api/client';

/**
 * Work saved on the phone while it is offline (APP-05, ADR-840): the changes staff make most on a
 * phone, on a bad network, kept in this browser with the Idempotency-Key each was first sent
 * with, and sent in order once the network is back, so that one the core took before the
 * network failed runs once however often it is tried, within the day the core keeps keys
 * (ADR-030). Only these: a change sent late must still be right, and these say what happened
 * (confirmed, packed, collected, a call's outcome, a comment), not what to do next.
 */
export const QUEUEABLE: ReadonlySet<string> = new Set([
  'OrderConfirm',
  'OrderBulkConfirm',
  'OrderMarkPacked',
  'OrderBulkMarkPacked',
  'OrderMarkPickedUp',
  'OrderConfirmationCall',
  'OrderCommentCreate',
]);

/** A change kept to send: as it was first sent, with the key that makes it run once. */
export interface QueuedChange {
  /** Its Idempotency-Key, which is its ID here too. */
  id: string;
  shopId: string;
  operation: string;
  document: string;
  variables: Record<string, unknown>;
  /** When it was saved, epoch ms. */
  queuedAt: number;
  /** Why the core refused it once sent; absent while it waits to go. */
  refused?: string;
}

const KEY = 'hatti.outbox';

/** The most a browser keeps, the oldest given up past it. */
const MOST = 200;

/** The operation a GraphQL document names: "OrderConfirm" for `mutation OrderConfirm(…)`. */
export function operationOf(document: string): string | null {
  return /\bmutation\s+([A-Za-z_]\w*)/.exec(document)?.[1] ?? null;
}

/** A refusal the network gave rather than the core: the change may be saved to send later. */
export const isUnreachable = (error: unknown) =>
  error instanceof ApiError && error.code === 'NETWORK';

/** What the admin says when a change was saved to send later, as its screens show errors. */
export const QUEUED = 'QUEUED_OFFLINE';

const watchers = new Set<() => void>();
let cache: { raw: string | null; list: QueuedChange[] } = { raw: null, list: [] };

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** What the browser keeps, the oldest first; the same list while it is unchanged. */
export function queued(): QueuedChange[] {
  const raw = storage()?.getItem(KEY) ?? null;
  if (raw === cache.raw) return cache.list;
  let list: QueuedChange[] = [];
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (Array.isArray(parsed)) list = parsed as QueuedChange[];
  } catch {
    list = [];
  }
  cache = { raw, list };
  return list;
}

function save(list: QueuedChange[]): void {
  try {
    if (list.length === 0) storage()?.removeItem(KEY);
    else storage()?.setItem(KEY, JSON.stringify(list.slice(-MOST)));
  } catch {
    // No room or no storage: what was kept stays as it was.
  }
  for (const watcher of watchers) watcher();
}

/** Calls `watcher` whenever what is kept changes, here or in another tab; returns the undo. */
export function watchQueued(watcher: () => void): () => void {
  watchers.add(watcher);
  const other = (event: StorageEvent) => {
    if (event.key === KEY) watcher();
  };
  window.addEventListener('storage', other);
  return () => {
    watchers.delete(watcher);
    window.removeEventListener('storage', other);
  };
}

/** Keeps a change to send once the network is back. */
export function enqueue(change: Omit<QueuedChange, 'queuedAt'>, now = Date.now()): void {
  save([...queued().filter((each) => each.id !== change.id), { ...change, queuedAt: now }]);
}

/** Forgets a change: sent, or a refusal staff have read. */
export function forget(id: string): void {
  save(queued().filter((each) => each.id !== id));
}

/** Forgets everything kept, as when staff sign out of this browser. */
export function forgetAll(): void {
  save([]);
}

function refuse(id: string, refused: string): void {
  save(queued().map((each) => (each.id === id ? { ...each, refused } : each)));
}

/** The first of a mutation's answer's `userErrors`, wherever its one field has them. */
function userErrorOf(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  for (const value of Object.values(data as Record<string, unknown>)) {
    const errors = (value as { userErrors?: { message: string }[] } | null)?.userErrors;
    if (errors?.[0]) return errors[0].message;
  }
  return null;
}

/**
 * Sends what waits, the oldest first, each with its own key: sent, it is forgotten; refused by the
 * core, it stays with why, for staff to read; the network still out, the rest wait for the next
 * time. How many went.
 */
export function sendQueued(
  send: (change: QueuedChange) => Promise<unknown>,
  describe: (error: unknown) => string,
): Promise<number> {
  // One round at a time in a tab: another asked meanwhile waits for this one.
  sending ??= sendEach(send, describe).finally(() => {
    sending = null;
  });
  return sending;
}

let sending: Promise<number> | null = null;

async function sendEach(
  send: (change: QueuedChange) => Promise<unknown>,
  describe: (error: unknown) => string,
): Promise<number> {
  let sent = 0;
  for (const change of queued().filter((each) => !each.refused)) {
    try {
      const data = await send(change);
      const refused = userErrorOf(data);
      if (refused) refuse(change.id, refused);
      else {
        forget(change.id);
        sent += 1;
      }
    } catch (error) {
      if (isUnreachable(error)) break;
      refuse(change.id, describe(error));
    }
  }
  return sent;
}
