// App Bridge (DEV-06, ADR-912): what an app opened inside Hatti's admin (ADR-852) asks of the
// admin around it, over `postMessage`, as Shopify's App Bridge does: a fresh session token, a
// toast, a page of the admin to go to, and the save bar. The admin answers only the app's own
// frame, and the app only the admin that opened it, the `host` its address carries. In the
// browser only; no dependencies, and nothing of Node's, so an app's page can bundle it.

export const APP_BRIDGE = 'hatti-app-bridge';
export const APP_BRIDGE_VERSION = 1;

/** The longest toast, and how long to wait for the admin's answer to a token asked for. */
export const APP_BRIDGE_LIMITS = { toast: 200, path: 500, answerMs: 10_000 } as const;

/** What an app asks of the admin. */
export type AppBridgeRequest =
  | { type: 'id_token' }
  | { type: 'toast'; message: string; error: boolean }
  | { type: 'navigate'; path: string }
  | { type: 'save_bar'; visible: boolean };

/** What the admin tells an app: a token it asked for, or that the save bar's buttons were pressed. */
export type AppBridgeNotice =
  { type: 'id_token'; token: string } | { type: 'save' } | { type: 'discard' };

/** A message of the bridge's, either way, `id` pairing an answer with what it answers. */
export interface AppBridgeEnvelope<T> {
  bridge: typeof APP_BRIDGE;
  version: typeof APP_BRIDGE_VERSION;
  id?: string;
  message: T;
}

/** The envelope of `message`. */
export function envelopeOf<T>(message: T, id?: string): AppBridgeEnvelope<T> {
  return { bridge: APP_BRIDGE, version: APP_BRIDGE_VERSION, ...(id ? { id } : {}), message };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The bridge's envelope of `data`, its message unread; null for anything else posted. */
function envelopeIn(data: unknown): (AppBridgeEnvelope<unknown> & { id?: string }) | null {
  if (!isRecord(data) || data.bridge !== APP_BRIDGE || data.version !== APP_BRIDGE_VERSION) {
    return null;
  }
  if (data.id !== undefined && (typeof data.id !== 'string' || data.id.length > 100)) return null;
  return data as unknown as AppBridgeEnvelope<unknown>;
}

/**
 * A page of the admin an app may send the merchant to: a path of the shop's admin, such as
 * "/orders" or "/products/123", never another site's.
 */
export function isAdminPath(path: string): boolean {
  return (
    path.length <= APP_BRIDGE_LIMITS.path &&
    /^\/(?!\/)[A-Za-z0-9\-._~/%?=&]*$/.test(path) &&
    !path.split(/[/?]/).includes('..')
  );
}

/** What an app asked, as the admin reads it: null for anything not a request the admin answers. */
export function requestIn(data: unknown): { id?: string; request: AppBridgeRequest } | null {
  const envelope = envelopeIn(data);
  if (!envelope || !isRecord(envelope.message)) return null;
  const message = envelope.message;
  const id = envelope.id;
  switch (message.type) {
    case 'id_token':
      return id ? { id, request: { type: 'id_token' } } : null;
    case 'toast':
      return typeof message.message === 'string' && message.message.trim()
        ? {
            request: {
              type: 'toast',
              message: message.message.trim().slice(0, APP_BRIDGE_LIMITS.toast),
              error: message.error === true,
            },
          }
        : null;
    case 'navigate':
      return typeof message.path === 'string' && isAdminPath(message.path)
        ? { request: { type: 'navigate', path: message.path } }
        : null;
    case 'save_bar':
      return typeof message.visible === 'boolean'
        ? { request: { type: 'save_bar', visible: message.visible } }
        : null;
    default:
      return null;
  }
}

/** What the admin told the app, as the app reads it: null for anything else. */
export function noticeIn(data: unknown): { id?: string; notice: AppBridgeNotice } | null {
  const envelope = envelopeIn(data);
  if (!envelope || !isRecord(envelope.message)) return null;
  const message = envelope.message;
  if (message.type === 'id_token' && typeof message.token === 'string' && envelope.id) {
    return { id: envelope.id, notice: { type: 'id_token', token: message.token } };
  }
  if (message.type === 'save' || message.type === 'discard') {
    return { notice: { type: message.type } };
  }
  return null;
}

/** What of the window the bridge uses: the app's page, in the admin's frame. */
export interface AppBridgeWindow {
  location: { search: string };
  parent: { postMessage(message: unknown, targetOrigin: string): void };
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown; origin: string; source: unknown }) => void,
  ): void;
  removeEventListener(
    type: 'message',
    listener: (event: { data: unknown; origin: string; source: unknown }) => void,
  ): void;
}

export interface AppBridgeOptions {
  /** The admin's origin; by default the `host` of the page's address, as the admin gives it. */
  host?: string;
  /** The page's window; by default the global one. */
  window?: AppBridgeWindow;
}

export interface AppBridge {
  /** A fresh session token, a minute's life, to send the app's own server with each request. */
  idToken(): Promise<string>;
  /** A short message the admin shows, as an error with `error`. */
  toast(message: string, options?: { error?: boolean }): void;
  /** Sends the merchant to a page of the shop's admin, "/orders" say. */
  navigate(path: string): void;
  saveBar: {
    /** Shows the admin's save bar until hidden; its buttons call back. */
    show(handlers: { onSave: () => void; onDiscard: () => void }): void;
    hide(): void;
  };
  /** Stops listening to the admin. */
  destroy(): void;
}

/** The admin's origin `host` names, checked: https, or http on this machine. */
export function hostOrigin(host: string): string {
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    throw new Error(`Not an admin's address: ${host}`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(`Not an admin's address: ${host}`);
  }
  return url.origin;
}

/**
 * The bridge to the admin around an app's page. It answers only the admin at `host`, and posts
 * only to it; throws when the page has no host, as when opened outside the admin.
 */
export function createAppBridge(options: AppBridgeOptions = {}): AppBridge {
  const view = options.window ?? (globalThis as unknown as { window: AppBridgeWindow }).window;
  const host = options.host ?? new URLSearchParams(view.location.search).get('host');
  if (!host) throw new Error('Opened outside the admin: the address has no host');
  const origin = hostOrigin(host);
  const waiting = new Map<string, { resolve: (token: string) => void; timer: unknown }>();
  let saveBar: { onSave: () => void; onDiscard: () => void } | null = null;
  let sent = 0;

  const post = (message: AppBridgeRequest, id?: string) =>
    view.parent.postMessage(envelopeOf(message, id), origin);

  const listener = (event: { data: unknown; origin: string; source: unknown }) => {
    if (event.origin !== origin || event.source !== view.parent) return;
    const read = noticeIn(event.data);
    if (!read) return;
    const { notice } = read;
    if (notice.type === 'id_token') {
      const asked = read.id === undefined ? undefined : waiting.get(read.id);
      if (!asked) return;
      waiting.delete(read.id!);
      clearTimeout(asked.timer as ReturnType<typeof setTimeout>);
      asked.resolve(notice.token);
    } else if (notice.type === 'save') saveBar?.onSave();
    else saveBar?.onDiscard();
  };
  view.addEventListener('message', listener);

  return {
    idToken() {
      const id = `t${(sent += 1)}-${Date.now().toString(36)}`;
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error('The admin did not answer with a session token'));
        }, APP_BRIDGE_LIMITS.answerMs);
        waiting.set(id, { resolve, timer });
        post({ type: 'id_token' }, id);
      });
    },
    toast(message, { error = false } = {}) {
      post({ type: 'toast', message: message.slice(0, APP_BRIDGE_LIMITS.toast), error });
    },
    navigate(path) {
      if (!isAdminPath(path)) throw new Error(`Not a page of the admin: ${path}`);
      post({ type: 'navigate', path });
    },
    saveBar: {
      show(handlers) {
        saveBar = handlers;
        post({ type: 'save_bar', visible: true });
      },
      hide() {
        saveBar = null;
        post({ type: 'save_bar', visible: false });
      },
    },
    destroy() {
      view.removeEventListener('message', listener);
      for (const { timer } of waiting.values())
        clearTimeout(timer as ReturnType<typeof setTimeout>);
      waiting.clear();
    },
  };
}
