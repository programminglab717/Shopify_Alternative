import { html, renderPage, say, type RenderedPage, type Words } from '@hatti/documents';
import type { ShopDoc } from '@hatti/storefront-data';
import { escapeHtml } from './liquid.js';

// The installable storefront (OS-14, ADR-832): every shop's pages name a web app manifest of its
// own and register one service worker, so shoppers may add the shop to their phone's home screen
// and open it as an app. The worker keeps one page, the offline page, and shows it when a page
// can't be fetched for want of a network; it caches nothing else, so prices, stock and carts are
// always the shop's own as they are now. It also shows the shop's pushes (ADR-833).

export const PWA_PATHS = {
  manifest: '/manifest.webmanifest',
  worker: '/sw.js',
  offline: '/offline',
  icon: '/pwa-icon.svg',
} as const;

/** The worker's cache, named for what it keeps: a new name drops the old one. */
const CACHE = 'hatti-offline-v1';

/** The most of the shop's name the home screen shows beneath its icon. */
const SHORT_NAME = 12;

const WORDS = {
  offline: { en: "You're offline", ur: 'آپ آف لائن ہیں' },
  connect: {
    en: 'Connect to the internet to keep shopping. Your cart is kept.',
    ur: 'خریداری جاری رکھنے کے لیے انٹرنیٹ سے جڑیں۔ آپ کی ٹوکری محفوظ ہے۔',
  },
  again: { en: 'Try again', ur: 'دوبارہ کوشش کریں' },
} satisfies Record<string, Words>;

/** The shop's name as the home screen shows it: whole, if short, else cut at a word. */
export function shortNameOf(name: string): string {
  const whole = name.trim();
  if (whole.length <= SHORT_NAME) return whole;
  const cut = whole.slice(0, SHORT_NAME + 1);
  const space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : whole.slice(0, SHORT_NAME)).trim();
}

/**
 * The shop's web app manifest: its name, its pages from its home page, standing alone like an
 * app, in the page's language; its icon its square logo at the image service's widths (ADR-205),
 * else one of its initial, made here.
 */
export function webManifest(doc: ShopDoc, options: { urdu: boolean }): Record<string, unknown> {
  const logo = doc.brand?.squareLogo ?? null;
  const sized = (width: number) => `${logo}${logo!.includes('?') ? '&' : '?'}width=${width}`;
  return {
    id: '/',
    name: doc.name,
    short_name: shortNameOf(doc.name),
    lang: options.urdu ? 'ur' : 'en',
    dir: options.urdu ? 'rtl' : 'ltr',
    start_url: options.urdu ? '/ur' : '/',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    icons: logo
      ? [
          // The image service's own widths, so neither is made larger than asked.
          { src: sized(192), sizes: '192x192', purpose: 'any' },
          { src: sized(540), sizes: '540x540', purpose: 'any' },
        ]
      : [{ src: PWA_PATHS.icon, sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  };
}

/** The colours an initial's icon is drawn in, one picked by the shop's name. */
const ICON_COLOURS = ['#1f2937', '#7c2d12', '#14532d', '#1e3a8a', '#581c87', '#831843'] as const;

/** An icon of the shop's initial, for a shop without a square logo. */
export function initialIcon(name: string): string {
  const initial = [...name.trim()][0]?.toUpperCase() ?? 'H';
  let sum = 0;
  for (const char of name) sum = (sum + char.codePointAt(0)!) % ICON_COLOURS.length;
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
    `<rect width="512" height="512" fill="${ICON_COLOURS[sum]}"/>` +
    '<text x="256" y="256" dy=".35em" text-anchor="middle" fill="#ffffff" ' +
    'font-family="system-ui,sans-serif" font-size="280" font-weight="600">' +
    `${escapeHtml(initial)}</text></svg>`
  );
}

/**
 * The service worker: the offline page kept when it installs; a page asked for while offline
 * answered with it; anything else left to the network. A push shows its notification, and its
 * click opens the shop's page it names, never another site's.
 */
export const SERVICE_WORKER = `"use strict";
const CACHE = ${JSON.stringify(CACHE)};
const OFFLINE = ${JSON.stringify(PWA_PATHS.offline)};
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE, { cache: "reload" })))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith("hatti-") && key !== CACHE).map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.mode !== "navigate" || request.method !== "GET") return;
  event.respondWith(
    fetch(request).catch(() =>
      caches.match(OFFLINE).then((page) => page || Response.error()),
    ),
  );
});
self.addEventListener("push", (event) => {
  let message = null;
  try {
    message = event.data ? event.data.json() : null;
  } catch (error) {
    message = null;
  }
  if (!message || typeof message.title !== "string") return;
  event.waitUntil(
    self.registration.showNotification(message.title, {
      body: typeof message.body === "string" ? message.body : "",
      icon: message.icon || undefined,
      image: message.image || undefined,
      tag: message.tag || undefined,
      data: { url: typeof message.url === "string" ? message.url : "/" },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin);
  if (url.origin !== self.location.origin) return;
  event.waitUntil(self.clients.openWindow(url.href));
});
`;

/** Where a page's script turns the shopper's notifications on and off (ADR-833). */
export const PUSH_PATHS = {
  subscribe: '/push/subscribe',
  unsubscribe: '/push/unsubscribe',
} as const;

/**
 * Notifications from the shop (ADR-833), for themes to offer: `window.HattiPush.supported`,
 * whether the browser can have them; `subscribed()`, whether they are on; `subscribe()`, which
 * asks the shopper's leave, as only a tap may, and turns them on, answering "subscribed",
 * "denied" or "unsupported"; and `unsubscribe()`. Each change is told as a `hatti:push` event on
 * the document, `detail.subscribed` saying which.
 */
function pushScript(publicKey: string): string {
  return (
    '<script data-hatti-push>(function(){' +
    `var key=${JSON.stringify(publicKey)};` +
    'var ok="serviceWorker"in navigator&&"PushManager"in window&&"Notification"in window;' +
    'function bytes(){var b=key.replace(/-/g,"+").replace(/_/g,"/");' +
    'var raw=atob(b+"===".slice((b.length+3)%4));var out=new Uint8Array(raw.length);' +
    'for(var i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out}' +
    'function told(on){document.dispatchEvent(new CustomEvent("hatti:push",{detail:{subscribed:on}}))}' +
    'function post(path,body){return fetch(path,{method:"POST",credentials:"same-origin",' +
    'headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(function(r){' +
    'if(!r.ok)throw new Error("Notifications could not be turned on")})}' +
    'function current(){return navigator.serviceWorker.ready.then(function(r){' +
    'return r.pushManager.getSubscription()})}' +
    'window.HattiPush={supported:ok,' +
    'subscribed:function(){return ok?current().then(function(s){return!!s}):Promise.resolve(false)},' +
    'subscribe:function(){if(!ok)return Promise.resolve("unsupported");' +
    'return Notification.requestPermission().then(function(p){if(p!=="granted")return"denied";' +
    'return navigator.serviceWorker.ready.then(function(r){' +
    'return r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes()})})' +
    '.then(function(s){var j=s.toJSON();' +
    `return post(${JSON.stringify(PUSH_PATHS.subscribe)},{endpoint:j.endpoint,` +
    'p256dh:j.keys&&j.keys.p256dh,auth:j.keys&&j.keys.auth,' +
    'locale:document.documentElement.lang==="ur"?"ur":"en"})})' +
    '.then(function(){told(true);return"subscribed"})})},' +
    'unsubscribe:function(){if(!ok)return Promise.resolve();return current().then(function(s){' +
    'if(!s)return;var endpoint=s.endpoint;return s.unsubscribe().then(function(){' +
    `return post(${JSON.stringify(PUSH_PATHS.unsubscribe)},{endpoint:endpoint})})})` +
    '.then(function(){told(false)})}}' +
    '})()</script>'
  );
}

/**
 * What every shopper's page carries for it: the manifest, and the worker registered once the
 * page has loaded, where the browser has service workers; and, where Hatti pushes, the script
 * that turns the shop's notifications on (ADR-833).
 */
export function pwaHead(urdu: boolean, pushPublicKey?: string): string {
  return (
    `<link rel="manifest" href="${PWA_PATHS.manifest}${urdu ? '?locale=ur' : ''}">` +
    '<script data-hatti-pwa>if("serviceWorker"in navigator)addEventListener("load",function(){' +
    `navigator.serviceWorker.register(${JSON.stringify(PWA_PATHS.worker)}).catch(function(){})` +
    '})</script>' +
    (pushPublicKey ? pushScript(pushPublicKey) : '')
  );
}

/**
 * The page the worker shows while the shopper is offline: the shop's name, that they are
 * offline, and a link to try its home page again; in English and Urdu, as the platform's other
 * pages are, since the worker keeps one page for every language.
 */
export function offlinePage(shop: ShopDoc): RenderedPage {
  return renderPage({
    title: `${WORDS.offline.en} · ${shop.name}`,
    body: html`
      <p class="shop"><bdi>${shop.name}</bdi></p>
      <h1 class="title stack">${say('bilingual', WORDS.offline)}</h1>
      <div class="text center muted">${say('bilingual', WORDS.connect)}</div>
      <p class="center"><a href="/">${say('bilingual', WORDS.again)}</a></p>
    `,
  });
}
