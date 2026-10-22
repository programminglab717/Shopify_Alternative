// Readies the load-test shop for ops/load/launch.js (ADR-735): each tracked variant that stops
// selling at zero is made to keep selling, so that thousands of orders don't sell it out and leave
// the test measuring "sold out" rather than checkout. Stock is still taken off, as on a sale day.
//
//   k6 run -e ADMIN_URL=https://api.staging.hatti.pk -e ADMIN_TOKEN=hat_... ops/load/prepare.js
//
// ADMIN_TOKEN is a custom app's token in the load-test shop alone, with read_products and
// write_inventory (DEV-04). Never point it at a shop that sells for real.

import http from 'k6/http';
import { fail, sleep } from 'k6';

const ADMIN_URL = (__ENV.ADMIN_URL || '').replace(/\/+$/, '');
const ADMIN_TOKEN = __ENV.ADMIN_TOKEN || '';
if (!ADMIN_URL || !ADMIN_TOKEN) throw new Error('Set ADMIN_URL and ADMIN_TOKEN');

export const options = { vus: 1, iterations: 1 };

const PRODUCTS = `query Products($after: String) {
  products(first: 50, after: $after, query: "status:active") {
    nodes { title variants { inventoryItem { id tracked inventoryPolicy } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const KEEP_SELLING = `mutation KeepSelling($id: ID!) {
  inventoryItemUpdate(id: $id, input: { inventoryPolicy: CONTINUE }) {
    userErrors { field message }
  }
}`;

export default function () {
  let after = null;
  let changed = 0;
  do {
    const page = admin(PRODUCTS, { after }).products;
    for (const product of page.nodes) {
      for (const variant of product.variants) {
        const item = variant.inventoryItem;
        if (!item.tracked || item.inventoryPolicy === 'CONTINUE') continue;
        const errors = admin(KEEP_SELLING, { id: item.id }).inventoryItemUpdate.userErrors;
        if (errors.length > 0) fail(`${product.title}: ${errors.map((e) => e.message).join('; ')}`);
        changed += 1;
      }
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  console.log(`${changed} variants keep selling past their stock.`);
}

/** One Admin API call, waiting out the shop's bucket of query cost when it runs dry (DEV-01). */
function admin(query, variables) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = http.post(
      `${ADMIN_URL}/admin/api/2026-10/graphql`,
      JSON.stringify({ query, variables }),
      {
        headers: { 'content-type': 'application/json', 'x-hatti-access-token': ADMIN_TOKEN },
      },
    );
    const body = response.json();
    const throttled = (body.errors || []).some((error) => error.extensions?.code === 'THROTTLED');
    if (throttled) {
      sleep(1);
      continue;
    }
    if (response.status !== 200 || body.errors) {
      fail(`The Admin API answered ${response.status}: ${JSON.stringify(body.errors || body)}`);
    }
    return body.data;
  }
  return fail('The Admin API stayed throttled');
}
