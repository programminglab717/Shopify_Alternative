/**
 * The admin's service worker (ADR-295), built to /sw.js. Its build prepends `self.__hatti`: the
 * build's version and the files it keeps. A new version waits until the admin asks it to take
 * over, so a page is never left with scripts of two builds.
 */
import { notificationOf, pageFor } from './push';
import { answerFor } from './rules';

interface LifecycleEvent extends Event {
  waitUntil(work: Promise<unknown>): void;
}

interface FetchEvent extends LifecycleEvent {
  request: Request;
  respondWith(answer: Promise<Response>): void;
}

interface PushEvent extends LifecycleEvent {
  data: { json(): unknown } | null;
}

interface NotificationEvent extends LifecycleEvent {
  notification: { data: unknown; close(): void };
}

interface WindowClient {
  url: string;
  focus(): Promise<WindowClient>;
  navigate(url: string): Promise<WindowClient | null>;
}

interface ServiceWorkerScope {
  __hatti: { version: string; precache: string[] };
  location: Location;
  clients: {
    claim(): Promise<void>;
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<WindowClient[]>;
    openWindow(url: string): Promise<WindowClient | null>;
  };
  registration: { showNotification(title: string, options: object): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', listener: (event: LifecycleEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  addEventListener(type: 'push', listener: (event: PushEvent) => void): void;
  addEventListener(type: 'notificationclick', listener: (event: NotificationEvent) => void): void;
}

const worker = self as unknown as ServiceWorkerScope;
const { version, precache } = worker.__hatti;
const CACHE = `hatti-admin-${version}`;

worker.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(precache)));
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('hatti-admin-') && name !== CACHE) await caches.delete(name);
      }
      await worker.clients.claim();
    })(),
  );
});

worker.addEventListener('message', (event) => {
  if (event.data === 'take-over') void worker.skipWaiting();
});

worker.addEventListener('fetch', (event) => {
  const answer = answerFor(event.request, worker.location.origin);
  if (answer === 'page') event.respondWith(page(event.request));
  else if (answer === 'cache-first') event.respondWith(kept(event.request));
});

// The shop's news, pushed to a member of staff who turned it on (ADR-506).
worker.addEventListener('push', (event) => {
  let data: unknown = null;
  try {
    data = event.data?.json() ?? null;
  } catch {
    // Not the core's: nothing to show.
  }
  const shown = notificationOf(data);
  if (shown) event.waitUntil(worker.registration.showNotification(shown.title, shown.options));
});

// Tapped: the admin, already open or opened, on the page the news is about.
worker.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data as { url?: unknown } | null;
  const url = pageFor(data?.url, worker.location.origin);
  event.waitUntil(
    (async () => {
      const [open] = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (open) {
        await open.focus();
        await open.navigate(url);
      } else {
        await worker.clients.openWindow(url);
      }
    })(),
  );
});

/** The admin's page from the network, so a new build shows; offline, the one kept. */
async function page(request: Request): Promise<Response> {
  try {
    return await fetch(request);
  } catch (failure) {
    const cached = await caches.match('/', { cacheName: CACHE });
    if (cached) return cached;
    throw failure;
  }
}

/** A file named by its content never changes: from the cache, else fetched and kept. */
async function kept(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}
