/** Registering the admin's service worker, and offering a new build's when it has installed. */

export const UPDATE_READY = 'hatti:update-ready';

let waiting: ServiceWorker | null = null;
let registered: ServiceWorkerContainer | null = null;

/** A new build's worker, installed and waiting to take over, if one is. */
export const updateWaiting = () => waiting;

/** Has the waiting worker take over; the page reloads on the new build once it has. */
export function takeOver(worker: ServiceWorker): void {
  registered?.addEventListener('controllerchange', () => window.location.reload(), { once: true });
  worker.postMessage('take-over');
}

/**
 * Registers /sw.js, and says when a new build's worker has installed while this page runs on an
 * older one; looks for a new build each time the admin comes back into view, as a phone's apps
 * are opened again. A browser that refuses a worker keeps the admin working online.
 */
export async function registerServiceWorker(container = navigator.serviceWorker): Promise<void> {
  registered = container;
  const offer = (worker: ServiceWorker | null) => {
    if (!worker || !container.controller) return;
    waiting = worker;
    window.dispatchEvent(new Event(UPDATE_READY));
  };
  try {
    const registration = await container.register('/sw.js');
    offer(registration.waiting);
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      installing?.addEventListener('statechange', () => {
        if (installing.state === 'installed') offer(installing);
      });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void registration.update().catch(() => {});
    });
  } catch {
    // Online, the admin needs no worker.
  }
}
