import type { CheckoutClient } from '@hatti/storefront-api';
import { cookieOf } from './cart.js';
import { scriptJson } from './liquid.js';

// Meta's pixel on a shop's pages (MKT-10, ADR-144). While the shop has Meta connected, each page
// its shoppers see loads the pixel, which sends PageView; a product's page sends ViewContent;
// adding to the cart sends AddToCart; and leaving for checkout sends InitiateCheckout. Pages are
// the same for every shopper, kept at the edge, so the script knows only the page's product: the
// rest it reads from the forms shoppers send. Checkout's pages run no scripts (ADR-044), so the
// orders themselves go from the server, through the conversions API (ADR-143); the pixel's
// cookies, which name the shopper's browser, go with the order placed, for them to name the same.
// TikTok's pixel loads beside it while the shop has TikTok connected (ADR-543), tracking the same
// steps, and its browser cookie goes with the order for TikTok's Events API (ADR-541).

/** Where Meta serves its pixel's script. */
export const META_PIXEL_SCRIPT = 'https://connect.facebook.net/en_US/fbevents.js';

/** Where TikTok serves its pixel's script. */
export const TIKTOK_PIXEL_SCRIPT = 'https://analytics.tiktok.com/i18n/pixel/events.js';

/** Meta's format: `fb.<subdomain index>.<when, in ms>.<random or click ID>`. */
const META_ID = /^fb\.[0-9]\.[0-9]{1,16}\.[!-~]{1,450}$/;

/** TikTok's browser ID: letters, digits and a few marks. */
const TIKTOK_ID = /^[A-Za-z0-9._-]{10,100}$/;

/**
 * The cookies the pixels keep on the shop's address, and the form of each: Meta's browser ID and
 * an ad's click, and TikTok's browser ID.
 */
const PIXEL_COOKIES = {
  fbp: ['_fbp', META_ID],
  fbc: ['_fbc', META_ID],
  ttp: ['_ttp', TIKTOK_ID],
} as const;

/** The IDs the shop's pixels gave the browser, from the request's cookies, for the order. */
export function browserIdsOf(cookies: string | undefined): CheckoutClient['browserIds'] {
  const ids: NonNullable<CheckoutClient['browserIds']> = {};
  for (const [name, [cookie, form]] of Object.entries(PIXEL_COOKIES)) {
    const value = cookieOf(cookies, cookie);
    if (value && form.test(value)) ids[name as keyof typeof PIXEL_COOKIES] = value;
  }
  return Object.keys(ids).length > 0 ? ids : undefined;
}

/** What the pixel says of the page's product: ViewContent's parameters, and each variant's price. */
export interface PixelProduct {
  view: {
    content_ids: string[];
    content_type: 'product' | 'product_group';
    content_name: string;
    currency: string;
    value: number;
  };
  /** In rupees, by variant ID: what AddToCart's value is when the page's form adds one. */
  prices: Record<string, number>;
}

/**
 * A product's page's product, as the pixel tells of it: its variant as a catalog feed's item
 * (ADR-142) when it has one alone; with more, the group of its variants, as the feed groups them.
 * Valued at the variant the page shows first.
 */
export function pixelProduct(product: Record<string, unknown> | undefined): PixelProduct | null {
  const variants = (product?.variants ?? []) as { id: string; price: number }[];
  const shown = product?.selected_or_first_available_variant as {
    id: string;
    price: number;
  } | null;
  if (!product || variants.length === 0 || !shown) return null;
  const grouped = variants.length > 1;
  return {
    view: {
      content_ids: [grouped ? String(product.id) : shown.id],
      content_type: grouped ? 'product_group' : 'product',
      content_name: String(product.title ?? ''),
      currency: 'PKR',
      value: shown.price / 100,
    },
    prices: Object.fromEntries(variants.map((variant) => [variant.id, variant.price / 100])),
  };
}

/**
 * The listeners a pixel's script adds for what shoppers do, calling its `added(id, quantity,
 * value)` for forms adding to the cart, the value in rupees when the page's product prices the
 * variant, and its `leaving()` for the cart's checkout button and links to checkout. Listening
 * before the page's own scripts do, they hear of them however the theme handles them after, its
 * drawer's Ajax cart too.
 */
function shopperActions(): string {
  return `    var ours = function (address) {
      var url = new URL(address, location.href);
      return url.origin === location.origin ? url.pathname : null;
    };
    document.addEventListener('submit', function (event) {
      try {
        var form = event.target;
        var path = ours(form.getAttribute('action') || '');
        if (path && ${CART_ADD_PATH}.test(path)) {
          var data = new FormData(form);
          var id = String(data.get('id') || '');
          if (!id) return;
          var quantity = Math.max(1, parseInt(data.get('quantity'), 10) || 1);
          var price = product && product.prices[id];
          added(
            id,
            quantity,
            typeof price === 'number' ? Math.round(price * quantity * 100) / 100 : undefined
          );
        } else if (
          path &&
          ((${CART_PATH}.test(path) && event.submitter && event.submitter.name === 'checkout') ||
            ${CHECKOUT_PATH}.test(path))
        ) {
          leaving();
        }
      } catch (error) {}
    }, true);
    document.addEventListener('click', function (event) {
      try {
        var link = event.target.closest && event.target.closest('a[href]');
        var path = link && ours(link.getAttribute('href'));
        if (path && ${CHECKOUT_PATH}.test(path)) leaving();
      } catch (error) {}
    }, true);`;
}

/** Paths of the cart, adding to it and checkout, in the shop's languages: `/ur/cart` as well. */
const CART_PATH = /^(\/[a-z]{2}(-[a-z]{2,4})?)?\/cart\/?$/i;
const CART_ADD_PATH = /^(\/[a-z]{2}(-[a-z]{2,4})?)?\/cart\/add(\.js)?\/?$/i;
const CHECKOUT_PATH = /^(\/[a-z]{2}(-[a-z]{2,4})?)?\/checkout\/?$/i;

/**
 * The script a page's head carries for the shop's pixel `pixelId`: Meta's own base code, the
 * pixel's queue until its script loads; then PageView, ViewContent for `product`, and, as
 * shoppers send them, AddToCart and InitiateCheckout. Classic, and silent when anything fails,
 * as when the pixel's script is blocked.
 */
export function metaPixelScript(pixelId: string, product: PixelProduct | null): string {
  return `(function () {
  try {
    var pixel = window.fbq;
    if (!pixel) {
      pixel = window.fbq = function () {
        pixel.callMethod ? pixel.callMethod.apply(pixel, arguments) : pixel.queue.push(arguments);
      };
      if (!window._fbq) window._fbq = pixel;
      pixel.push = pixel;
      pixel.loaded = true;
      pixel.version = '2.0';
      pixel.queue = [];
      var script = document.createElement('script');
      script.async = true;
      script.src = ${scriptJson(META_PIXEL_SCRIPT)};
      document.head.appendChild(script);
    }
    pixel('init', ${scriptJson(pixelId)});
    pixel('track', 'PageView');
    var product = ${scriptJson(product)};
    if (product) pixel('track', 'ViewContent', product.view);
    var added = function (id, quantity, value) {
      var event = {
        content_ids: [id],
        content_type: 'product',
        contents: [{ id: id, quantity: quantity }]
      };
      if (typeof value === 'number') {
        event.currency = 'PKR';
        event.value = value;
      }
      pixel('track', 'AddToCart', event);
    };
    var leaving = function () {
      pixel('track', 'InitiateCheckout');
    };
${shopperActions()}
  } catch (error) {}
})();`;
}

/**
 * The script a page's head carries for the shop's TikTok pixel `pixelCode` (ADR-543): TikTok's own
 * base code, its queue until its script loads; then the page, ViewContent for `product`, and, as
 * shoppers send them, AddToCart and InitiateCheckout, as Meta's pixel tracks them. Classic, and
 * silent when anything fails.
 */
export function tiktokPixelScript(pixelCode: string, product: PixelProduct | null): string {
  return `(function () {
  try {
    var code = ${scriptJson(pixelCode)};
    var ttq = window.ttq;
    if (!ttq) {
      window.TiktokAnalyticsObject = 'ttq';
      ttq = window.ttq = [];
      ttq.methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once',
        'ready', 'alias', 'group', 'enableCookie', 'disableCookie'];
      ttq.setAndDefer = function (target, method) {
        target[method] = function () {
          target.push([method].concat(Array.prototype.slice.call(arguments, 0)));
        };
      };
      for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
      ttq.instance = function (id) {
        var instance = ttq._i[id] || [];
        for (var j = 0; j < ttq.methods.length; j++) ttq.setAndDefer(instance, ttq.methods[j]);
        return instance;
      };
      ttq._i = {};
      ttq._i[code] = [];
      ttq._i[code]._u = ${scriptJson(TIKTOK_PIXEL_SCRIPT)};
      ttq._t = {};
      ttq._t[code] = +new Date();
      ttq._o = {};
      ttq._o[code] = {};
      var script = document.createElement('script');
      script.async = true;
      script.src = ${scriptJson(TIKTOK_PIXEL_SCRIPT)} + '?sdkid=' + encodeURIComponent(code) + '&lib=ttq';
      document.head.appendChild(script);
    }
    ttq.page();
    var product = ${scriptJson(product)};
    if (product) {
      ttq.track('ViewContent', {
        contents: product.view.content_ids.map(function (id) {
          return { content_id: id, content_name: product.view.content_name };
        }),
        content_type: product.view.content_type,
        currency: product.view.currency,
        value: product.view.value
      });
    }
    var added = function (id, quantity, value) {
      var event = {
        contents: [{ content_id: id, quantity: quantity }],
        content_type: 'product'
      };
      if (typeof value === 'number') {
        event.currency = 'PKR';
        event.value = value;
      }
      ttq.track('AddToCart', event);
    };
    var leaving = function () {
      ttq.track('InitiateCheckout');
    };
${shopperActions()}
  } catch (error) {}
})();`;
}
