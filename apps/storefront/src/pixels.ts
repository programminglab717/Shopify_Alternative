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

/** Where Meta serves its pixel's script. */
export const META_PIXEL_SCRIPT = 'https://connect.facebook.net/en_US/fbevents.js';

/** The cookies the pixel keeps on the shop's address: its browser ID, and an ad's click. */
const PIXEL_COOKIES = { fbp: '_fbp', fbc: '_fbc' } as const;

/** Meta's format for both: `fb.<subdomain index>.<when, in ms>.<random or click ID>`. */
const META_ID = /^fb\.[0-9]\.[0-9]{1,16}\.[!-~]{1,450}$/;

/** The IDs the shop's Meta pixel gave the browser, from the request's cookies, for the order. */
export function browserIdsOf(cookies: string | undefined): CheckoutClient['browserIds'] {
  const ids: NonNullable<CheckoutClient['browserIds']> = {};
  for (const [name, cookie] of Object.entries(PIXEL_COOKIES)) {
    const value = cookieOf(cookies, cookie);
    if (value && META_ID.test(value)) ids[name as keyof typeof PIXEL_COOKIES] = value;
  }
  return ids.fbp || ids.fbc ? ids : undefined;
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

/** Paths of the cart, adding to it and checkout, in the shop's languages: `/ur/cart` as well. */
const CART_PATH = /^(\/[a-z]{2}(-[a-z]{2,4})?)?\/cart\/?$/i;
const CART_ADD_PATH = /^(\/[a-z]{2}(-[a-z]{2,4})?)?\/cart\/add(\.js)?\/?$/i;
const CHECKOUT_PATH = /^(\/[a-z]{2}(-[a-z]{2,4})?)?\/checkout\/?$/i;

/**
 * The script a page's head carries for the shop's pixel `pixelId`: Meta's own base code, the
 * pixel's queue until its script loads; then PageView, ViewContent for `product`, and, as
 * shoppers send them, AddToCart for forms adding to the cart and InitiateCheckout for the cart's
 * checkout button and links to checkout. Listening before the page's own scripts do, it hears of
 * them however the theme handles them after, its drawer's Ajax cart too. Classic, and silent when
 * anything fails, as when the pixel's script is blocked.
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
    var ours = function (address) {
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
          var added = {
            content_ids: [id],
            content_type: 'product',
            contents: [{ id: id, quantity: quantity }]
          };
          var price = product && product.prices[id];
          if (typeof price === 'number') {
            added.currency = 'PKR';
            added.value = Math.round(price * quantity * 100) / 100;
          }
          pixel('track', 'AddToCart', added);
        } else if (
          path &&
          ((${CART_PATH}.test(path) && event.submitter && event.submitter.name === 'checkout') ||
            ${CHECKOUT_PATH}.test(path))
        ) {
          pixel('track', 'InitiateCheckout');
        }
      } catch (error) {}
    }, true);
    document.addEventListener('click', function (event) {
      try {
        var link = event.target.closest && event.target.closest('a[href]');
        var path = link && ours(link.getAttribute('href'));
        if (path && ${CHECKOUT_PATH}.test(path)) pixel('track', 'InitiateCheckout');
      } catch (error) {}
    }, true);
  } catch (error) {}
})();`;
}
