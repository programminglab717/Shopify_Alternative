import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { sampleStore } from './fixtures.js';
import { SERVICE_WORKER, initialIcon, shortNameOf, webManifest } from './pwa.js';

type Listener = (event: Record<string, unknown>) => void;

/** The worker run in a stand-in for a service worker's global scope, offline or not. */
function worker(options: { online: boolean }) {
  const listeners = new Map<string, Listener>();
  const cached = new Map<string, string>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const self = {
    location: { origin: 'https://zari.hatti.pk' },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: () => Promise.resolve(),
    clients: {
      claim: () => Promise.resolve(),
      openWindow: (url: string) => {
        opened.push(url);
        return Promise.resolve();
      },
    },
    registration: {
      showNotification: (title: string, shownOptions: Record<string, unknown>) => {
        shown.push({ title, options: shownOptions });
        return Promise.resolve();
      },
    },
  };
  const caches = {
    open: () =>
      Promise.resolve({
        add: (request: { url: string }) => {
          cached.set(request.url, 'offline page');
          return Promise.resolve();
        },
      }),
    keys: () => Promise.resolve(['hatti-offline-v0', 'hatti-offline-v1', 'other']),
    delete: (key: string) => {
      cached.set(`deleted:${key}`, '');
      return Promise.resolve(true);
    },
    match: (url: string) => Promise.resolve(cached.get(url) ?? null),
  };
  runInNewContext(SERVICE_WORKER, {
    self,
    caches,
    URL,
    Request: class {
      constructor(readonly url: string) {}
    },
    Response: { error: () => 'error' },
    fetch: () => (options.online ? Promise.resolve('network page') : Promise.reject(new Error())),
  });
  const dispatch = async (type: string, event: Record<string, unknown>) => {
    let waited: unknown;
    let answered: unknown;
    listeners.get(type)!({
      ...event,
      waitUntil: (promise: unknown) => (waited = promise),
      respondWith: (promise: unknown) => (answered = promise),
    });
    await waited;
    return answered === undefined ? undefined : await answered;
  };
  return { dispatch, cached, shown, opened };
}

describe('The installable storefront (ADR-832)', () => {
  it("names the shop's square logo at the image service's widths, else its initial", () => {
    const shop = sampleStore().shop;
    const logo = { ...shop, brand: { logo: null, squareLogo: '/images/s/logo-square.png?v=2' } };
    expect(webManifest(logo, { urdu: false }).icons).toEqual([
      { src: '/images/s/logo-square.png?v=2&width=192', sizes: '192x192', purpose: 'any' },
      { src: '/images/s/logo-square.png?v=2&width=540', sizes: '540x540', purpose: 'any' },
    ]);
    expect(shortNameOf('Zari')).toBe('Zari');
    expect(shortNameOf('Zari Fashions Lahore')).toBe('Zari');
    expect(shortNameOf('Khaadi Outlet Store')).toBe('Khaadi');
    expect(shortNameOf('Supercalifragilistic')).toBe('Supercalifra');
    const icon = initialIcon('<b>');
    expect(icon).toContain('>&lt;</text>');
    expect(icon).toBe(initialIcon('<b>'));
  });

  it('keeps the offline page alone, shows it for pages asked offline, and leaves the rest', async () => {
    const online = worker({ online: true });
    await online.dispatch('install', {});
    expect(online.cached.get('/offline')).toBe('offline page');
    await online.dispatch('activate', {});
    expect([...online.cached.keys()]).toEqual(['/offline', 'deleted:hatti-offline-v0']);
    const page = { mode: 'navigate', method: 'GET' };
    expect(await online.dispatch('fetch', { request: page })).toBe('network page');
    // A script's or an image's request is the network's alone, as is a form's.
    expect(await online.dispatch('fetch', { request: { mode: 'cors', method: 'GET' } })).toBe(
      undefined,
    );
    expect(await online.dispatch('fetch', { request: { mode: 'navigate', method: 'POST' } })).toBe(
      undefined,
    );

    const offline = worker({ online: false });
    await offline.dispatch('install', {});
    expect(await offline.dispatch('fetch', { request: page })).toBe('offline page');
  });

  it("shows a push, and opens the shop's own page it names, never another site's", async () => {
    const sw = worker({ online: true });
    const push = (message: unknown) => sw.dispatch('push', { data: { json: () => message } });
    await push({ title: 'Eid sale', body: '30% off', url: '/collections/eid', tag: 'pcmp_1' });
    // A message without words, or not JSON, shows nothing.
    await push({ body: 'no title' });
    await sw.dispatch('push', {
      data: {
        json: () => {
          throw new SyntaxError();
        },
      },
    });
    expect(sw.shown).toEqual([
      {
        title: 'Eid sale',
        options: {
          body: '30% off',
          icon: undefined,
          image: undefined,
          tag: 'pcmp_1',
          data: { url: '/collections/eid' },
        },
      },
    ]);
    const click = (url: string) =>
      sw.dispatch('notificationclick', { notification: { close: () => {}, data: { url } } });
    await click('/collections/eid');
    await click('https://evil.example/phish');
    expect(sw.opened).toEqual(['https://zari.hatti.pk/collections/eid']);
  });
});
