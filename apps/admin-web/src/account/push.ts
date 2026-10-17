/**
 * This browser's push subscription (APP-03, ADR-506), through its service worker: what the admin
 * asks of the browser to turn the shop's news on and off. Kept apart so that tests stand in for
 * a browser's push service.
 */

/** A browser's push subscription, as the Admin API takes it. */
export interface BrowserSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Whether this browser can be pushed to: 'yes'; 'install' where it can once the admin is on the
 * home screen, as an iPhone's Safari; 'no' otherwise.
 */
export function pushSupport(): 'yes' | 'install' | 'no' {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    const apple = typeof navigator !== 'undefined' && /iPhone|iPad/.test(navigator.userAgent);
    return apple ? 'install' : 'no';
  }
  return 'serviceWorker' in navigator && 'PushManager' in window ? 'yes' : 'no';
}

/** Whether the person said no to notifications from the admin, which only their browser undoes. */
export function notificationsBlocked(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'denied';
}

const asBrowser = (subscription: PushSubscription): BrowserSubscription => {
  const json = subscription.toJSON();
  return {
    endpoint: subscription.endpoint,
    p256dh: json.keys?.p256dh ?? '',
    auth: json.keys?.auth ?? '',
  };
};

/** This browser's subscription, if it has one. */
export async function currentSubscription(): Promise<BrowserSubscription | null> {
  if (pushSupport() !== 'yes') return null;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  return subscription ? asBrowser(subscription) : null;
}

/** The bytes of a base64url key, as PushManager takes Hatti's. */
function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const base64 = key
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(key.length / 4) * 4, '=');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Asks the person to let the admin notify them, then subscribes this browser with Hatti's key;
 * null where they said no.
 */
export async function subscribeBrowser(publicKey: string): Promise<BrowserSubscription | null> {
  if ((await Notification.requestPermission()) !== 'granted') return null;
  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey),
    }));
  return asBrowser(subscription);
}

/** Ends this browser's subscription with its push service. */
export async function unsubscribeBrowser(): Promise<void> {
  if (pushSupport() !== 'yes') return;
  const registration = await navigator.serviceWorker.ready;
  await (await registration.pushManager.getSubscription())?.unsubscribe();
}
