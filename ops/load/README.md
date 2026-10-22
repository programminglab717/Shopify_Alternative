# Load tests

The launch checklist asks for a load test at three times the traffic expected at launch
([roadmap](../../docs/product/04-roadmap.md)), and [12 §8](../../docs/architecture/12-scalability-and-reliability.md#8-performance-engineering)
for k6 runs before each sale season. These scripts are that test
([ADR-735](../../docs/architecture/13-decision-log.md#adr-735--the-launch-load-test-is-a-k6-script-kept-in-the-repository-shoppers-browsing-and-placing-cash-on-delivery-orders-side-by-side-at-three-times-12-2s-launch-peak-held-to-12-1s-objectives-against-stagings-load-test-shop-each-shopper-from-an-address-and-a-number-of-its-own)). They run with [k6](https://k6.io), from a
machine of its own (`k6` installed, or `docker run --rm -i grafana/k6`).

| Script | What it does |
|---|---|
| `launch.js` | Shoppers browsing (product, collection, home and search pages, and search suggestions) and placing cash-on-delivery orders through checkout, side by side, held to 12 §1's objectives |
| `prepare.js` | Readies the load-test shop: its tracked variants keep selling past their stock, so the test measures checkout rather than "sold out" |

## The traffic

`launch.js` ramps over two minutes to `MULTIPLIER` (3) times 12 §2's peak at the end of the MVP,
holds it for ten minutes, and lets it down:

| | 12 §2's peak | Driven by default | Set with |
|---|---|---|---|
| Page views | 300 a second, at the edge | 900 a second | `BROWSE_RATE` |
| Orders | 150 a minute | 450 a minute | `ORDER_RATE` |

The page rate is the edge's whole peak. Run against the origin, with no cache in front, the test
asks the storefront to take the entire peak as if the cache had failed, a harder test than 12 §2
plans for, where the edge answers more than 90% of pages. For the origin's planned share alone, set
`BROWSE_RATE=90`.

## What passes

| Threshold | From |
|---|---|
| 99.95% of page requests succeed | 12 §1, the storefront's objective |
| Pages render in 250 ms at p95 | Spike 1's budget for a page that misses the edge |
| 99.95% of orders tried are placed | 12 §1, checkout's objective |
| Placing an order takes 800 ms at p95 | 12 §1, the form's POST alone |
| No checkout asks for a code, and no cart refuses an item as sold out | The shop is fit for the test (below) |

k6 exits non-zero when any threshold fails.

## Running it

The test places real orders, thousands of them, and so it runs only on **staging**, against a
**shop kept for load tests**, never a shop that sells:

1. Staging's storefront runs with `TRUST_PROXY=true`. Each iteration comes from an address of its
   own in `X-Forwarded-For`, so that the per-address limits (120 cart changes a minute, 20 orders
   an hour, CHK-18) see many shoppers rather than one load generator; without it, the test is
   refused by the limits at once.
2. Staging sends **no messages**: no `WHATSAPP_*`, `SMS_*`, `VOICE_*` or `SES_*` keys. The test's
   numbers are made up, 0300 to 0349 and seven digits, and some of them are someone's.
3. The load-test shop has products on sale, a few with several variants, and asks no code at
   checkout (CHK-09: its risk rules ask none). Ready its stock, with a custom app's token in that
   shop alone that has `read_products` and `write_inventory`:

   ```sh
   k6 run -e ADMIN_URL=https://api.staging.example -e ADMIN_TOKEN=hat_... ops/load/prepare.js
   ```

4. Try the script for half a minute at a page a second and two orders a minute, then run it:

   ```sh
   k6 run -e BASE_URL=https://loadtest.staging.example -e SMOKE=true ops/load/launch.js
   k6 run -e BASE_URL=https://loadtest.staging.example ops/load/launch.js
   ```

Watch the storefront's and checkout's burn-rate alerts and the dashboard in `ops/grafana` while it
runs: a passing test that fires an alert has still found something.

Locally, against `pnpm dev:storefront` started with `TRUST_PROXY=true` and the seeded shop (which
keeps its own `.localhost` address):

```sh
k6 run -e ADMIN_URL=http://localhost:4000 -e ADMIN_TOKEN=<the seed's app token> ops/load/prepare.js
k6 run -e BASE_URL=http://<handle>.localhost:4100 -e RESOLVE=127.0.0.1 -e SMOKE=true ops/load/launch.js
```

A laptop runs the database, the core, the worker, the storefront and k6 on the same cores, so a
local run checks the script, not the platform's capacity.

## Settings

| Variable | Meaning | Default |
|---|---|---|
| `BASE_URL` | The shop's storefront, as shoppers reach it | required |
| `RESOLVE` | An address to reach `BASE_URL`'s host at, for hosts no DNS knows | — |
| `MULTIPLIER` | Times 12 §2's launch peak | 3 |
| `BROWSE_RATE` | Page views a second | `MULTIPLIER` × 300 |
| `ORDER_RATE` | Orders a minute | `MULTIPLIER` × 150 |
| `RAMP`, `DURATION` | The ramp to the peak, and how long it is held | 2m, 10m |
| `SMOKE` | `true` for 30 seconds at a page a second and two orders a minute | — |
