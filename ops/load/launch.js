// The launch load test (ADR-735): shoppers browsing a shop's storefront and placing cash-on-delivery
// orders through its checkout at three times the traffic expected at launch, held to the
// objectives of docs/architecture/12-scalability-and-reliability.md §1. Run it with k6 against a
// staging storefront that serves a shop kept for load tests (see README.md):
//
//   k6 run -e BASE_URL=https://hatti-load.staging.hatti.pk ops/load/launch.js
//
// Settings, each from the environment:
//   BASE_URL      the shop's storefront, as shoppers reach it (required)
//   RESOLVE       an address to reach BASE_URL's host at, for hosts no DNS knows, such as
//                 http://{handle}.localhost:4100 (RESOLVE=127.0.0.1)
//   MULTIPLIER    times the launch peak to drive, 3 unless set
//   BROWSE_RATE   page views a second; MULTIPLIER × 300, §2's peak at the edge, unless set
//   ORDER_RATE    orders a minute; MULTIPLIER × 150, §2's peak, unless set
//   DURATION      how long to hold the peak, 10m unless set; it is reached over RAMP (2m)
//   SMOKE=true    one page a second and two orders a minute for 30 seconds, to try the script
//
// Each iteration comes from an address of its own in X-Forwarded-For, which a storefront run with
// TRUST_PROXY=true takes as the shopper's, so that the per-address limits (120 cart changes a
// minute, 20 orders an hour) see many shoppers rather than one load generator. Each order is from
// a number of its own, as checkout takes 3 orders a day from one (CHK-18).

import http from 'k6/http';
import exec from 'k6/execution';
import { check, fail } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || '').replace(/\/+$/, '');
if (!/^https?:\/\/[^/]+$/.test(BASE_URL)) {
  throw new Error('Set BASE_URL to the storefront to test, such as https://shop.example.com');
}
const HOST = BASE_URL.replace(/^https?:\/\//, '').replace(/:\d+$/, '');
const SMOKE = __ENV.SMOKE === 'true';
const MULTIPLIER = Number(__ENV.MULTIPLIER || 3);
const BROWSE_RATE = SMOKE ? 1 : Number(__ENV.BROWSE_RATE || MULTIPLIER * 300);
const ORDER_RATE = SMOKE ? 2 : Number(__ENV.ORDER_RATE || MULTIPLIER * 150);
const RAMP = SMOKE ? '5s' : __ENV.RAMP || '2m';
const DURATION = SMOKE ? '30s' : __ENV.DURATION || '10m';

/** Orders the checkout took, of those tried: the checkout objective, 99.95%. */
const ordersPlaced = new Rate('orders_placed');
/** Checkouts that asked for a code sent to the number (CHK-09): the shop isn't fit for the test. */
const codesAsked = new Counter('checkout_codes_asked');
/** Items the cart refused as sold out: the shop isn't ready either (see prepare.js). */
const soldOut = new Counter('cart_sold_out');
/** Placing the order, the form's POST alone: the objective's p95 of 800 ms. */
const placing = new Trend('order_placement', true);

/** A ramp to the rate, held for the duration, then let down. */
function stages(rate) {
  return [
    { target: rate, duration: RAMP },
    { target: rate, duration: DURATION },
    { target: 0, duration: SMOKE ? '5s' : '1m' },
  ];
}

export const options = {
  hosts: __ENV.RESOLVE ? { [HOST]: __ENV.RESOLVE } : {},
  discardResponseBodies: false,
  scenarios: {
    browse: {
      executor: 'ramping-arrival-rate',
      exec: 'browse',
      startRate: 0,
      timeUnit: '1s',
      stages: stages(BROWSE_RATE),
      preAllocatedVUs: Math.max(10, Math.ceil(BROWSE_RATE / 4)),
      maxVUs: Math.max(50, BROWSE_RATE * 2),
    },
    checkout: {
      executor: 'ramping-arrival-rate',
      exec: 'checkout',
      startRate: 0,
      timeUnit: '1m',
      stages: stages(ORDER_RATE),
      preAllocatedVUs: Math.max(5, Math.ceil(ORDER_RATE / 30)),
      maxVUs: Math.max(20, ORDER_RATE),
    },
  },
  thresholds: {
    // Storefront: 99.95% of page requests succeed (12 §1).
    'http_req_failed{scenario:browse}': ['rate<0.0005'],
    // A page that misses the edge renders at origin in 250 ms at p95 (spike 1's budget).
    'http_req_duration{scenario:browse,kind:page}': ['p(95)<250'],
    // Checkout: 99.95% of orders tried are placed, and placing one takes 800 ms at p95 (12 §1).
    orders_placed: ['rate>0.9995'],
    order_placement: ['p(95)<800'],
    checkout_codes_asked: ['count==0'],
    cart_sold_out: ['count==0'],
  },
};

/** The shop's products, variants that can be added to a cart, and collections, from its sitemap. */
export function setup() {
  const paths = (xml) =>
    [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) =>
      match[1].replace(/^https?:\/\/[^/]+/, ''),
    );
  const index = http.get(`${BASE_URL}/sitemap.xml`, { tags: { name: 'setup' } });
  if (index.status !== 200) fail(`${BASE_URL}/sitemap.xml answered ${index.status}`);
  const products = [];
  const collections = [];
  for (const sitemap of paths(index.body)) {
    const kind = sitemap.includes('/products')
      ? products
      : sitemap.includes('/collections')
        ? collections
        : null;
    if (!kind) continue;
    const listed = http.get(`${BASE_URL}${sitemap}`, { tags: { name: 'setup' } });
    if (listed.status === 200) kind.push(...paths(listed.body));
  }
  if (products.length === 0)
    fail('The sitemap lists no products: is this a shop with some on sale?');

  // Variants a cart takes, tried in a cart of setup's own, from products enough to spread orders.
  const variants = [];
  for (const product of products.slice(0, 25)) {
    const page = http.get(`${BASE_URL}${product}`, { tags: { name: 'setup' } });
    const select = /<select name="id">([\s\S]*?)<\/select>/.exec(page.body || '');
    const ids = select
      ? [...select[1].matchAll(/<option\s+value="([^"]+)"(?![^>]*disabled)/g)].map(
          (match) => match[1],
        )
      : [...(page.body || '').matchAll(/<input type="hidden" name="id" value="([^"]+)"/g)].map(
          (match) => match[1],
        );
    for (const id of ids.slice(0, 3)) {
      const added = http.post(`${BASE_URL}/cart/add.js`, JSON.stringify({ id, quantity: 1 }), {
        headers: shopper(variants.length, { 'content-type': 'application/json' }),
        tags: { name: 'setup' },
      });
      if (added.status === 200) variants.push(id);
      http.cookieJar().clear(BASE_URL);
    }
  }
  if (variants.length === 0) fail('No variant could be added to a cart: run prepare.js first?');

  const words = [...new Set(products.map((path) => path.split('/').pop().split('-')[0]))];
  // Numbers and addresses start somewhere new each run, so a run today doesn't meet the last's.
  const seed = Math.floor(Math.random() * 400_000_000);
  return { products, collections, variants, words, seed };
}

/** One page view, in the mix a shop sees: products most, then collections, then the home page. */
export function browse(data) {
  const roll = Math.random();
  const headers = shopper(data.seed + exec.scenario.iterationInTest);
  let response;
  if (roll < 0.4) {
    response = page(pick(data.products), headers, 'product');
  } else if (roll < 0.7) {
    response = page(
      data.collections.length ? pick(data.collections) : '/collections/all',
      headers,
      'collection',
    );
  } else if (roll < 0.9) {
    response = page('/', headers, 'home');
  } else if (roll < 0.95) {
    response = page(`/search?q=${encodeURIComponent(pick(data.words))}`, headers, 'search');
  } else {
    const word = pick(data.words);
    response = http.get(
      `${BASE_URL}/search/suggest.json?q=${encodeURIComponent(word.slice(0, 3))}`,
      {
        headers,
        tags: { name: 'suggest', kind: 'suggest' },
      },
    );
  }
  check(response, { 'answered 200': (r) => r.status === 200 });
}

/** A shopper's order: an item to the cart, the checkout, the form filled in for cash on delivery. */
export function checkout(data) {
  const n = data.seed + exec.scenario.iterationInTest;
  const headers = shopper(n);
  http.cookieJar().clear(BASE_URL);
  const placed = order(data, n, headers);
  ordersPlaced.add(placed);
}

function order(data, n, headers) {
  const added = http.post(
    `${BASE_URL}/cart/add.js`,
    JSON.stringify({ id: pick(data.variants), quantity: 1 }),
    { headers: { ...headers, 'content-type': 'application/json' }, tags: { name: 'cart add' } },
  );
  if (added.status === 422 && /sold out/.test(added.body || '')) {
    soldOut.add(1);
    return false;
  }
  if (!check(added, { 'cart took the item': (r) => r.status === 200 })) return false;

  const begun = http.get(`${BASE_URL}/checkout`, {
    headers,
    redirects: 0,
    tags: { name: 'checkout' },
  });
  const to = begun.headers.Location || begun.headers.location || '';
  if (!check(begun, { 'checkout begun': (r) => r.status === 303 && to.includes('/checkouts/') })) {
    return false;
  }
  const url = to.startsWith('http') ? to : `${BASE_URL}${to}`;
  const form = http.get(url, { headers, tags: { name: 'checkout page' } });
  const shown = /name="shown" value="([^"]+)"/.exec(form.body || '');
  if (!check(form, { 'checkout page shown': (r) => r.status === 200 && shown !== null }))
    return false;

  const posted = http.post(
    url,
    {
      shown: shown[1],
      name: 'Load Test',
      phone: number(n),
      city: 'Lahore',
      address1: `House ${(n % 900) + 1}, Street ${(n % 40) + 1}, Block C, Model Town`,
      payment: 'cash_on_delivery',
    },
    { headers: { ...headers, origin: BASE_URL }, redirects: 0, tags: { name: 'place order' } },
  );
  placing.add(posted.timings.duration);
  if (!check(posted, { 'order form taken': (r) => r.status === 303 })) return false;

  const after = http.get(url, { headers, tags: { name: 'thank you' } });
  if ((after.body || '').includes('name="code"')) {
    codesAsked.add(1);
    return false;
  }
  return check(after, {
    'order placed': (r) => r.status === 200 && /<title>Thank you!/.test(r.body),
  });
}

function page(path, headers, kind) {
  return http.get(`${BASE_URL}${path}`, { headers, tags: { name: kind, kind: 'page' } });
}

/**
 * A shopper's headers: an address of their own, from the carrier-grade range phones on Pakistan's
 * mobile networks share, and a phone's browser.
 */
function shopper(n, extra = {}) {
  const address = `100.${64 + ((n >> 16) & 63)}.${(n >> 8) & 255}.${n & 255}`;
  return {
    'x-forwarded-for': address,
    'user-agent':
      'Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0 Mobile Safari/537.36 hatti-load-test',
    'accept-language': 'en-PK,en;q=0.9,ur;q=0.8',
    ...extra,
  };
}

/** A mobile number of the order's own: 0300 to 0349, then seven digits. */
function number(n) {
  const wrapped = n % 500_000_000;
  return `03${String(wrapped % 50).padStart(2, '0')}${String(Math.floor(wrapped / 50)).padStart(7, '0')}`;
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}
