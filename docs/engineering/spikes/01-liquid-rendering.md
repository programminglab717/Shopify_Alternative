# Spike 1 · Liquid rendering

> **Status:** Done, 2026-09-30 · **Outcome: go**, with the rules below
> Roadmap: [Phase 0 spikes](../../product/04-roadmap.md#2-phase-0--foundations-oct--mid-nov-2026) ·
> Decision: [ADR-035](../../architecture/13-decision-log.md#adr-035--the-storefront-renders-liquid-with-limits-of-its-own-fetching-lists-a-chunk-at-a-time) ·
> Code: [`apps/storefront`](../../../apps/storefront), [`themes/hatti-base`](../../../themes/hatti-base) ·
> Raw output: [01-benchmark-output.md](./01-benchmark-output.md)

## Question

Storefronts render merchants' themes in Liquid, as Shopify's do, so that Liquid developers are
productive on day one and themes merchants own can be ported
([ADR-006](../../architecture/13-decision-log.md#adr-006--liquid-compatible-theme-engine-with-json-templates),
[04 · Storefront §3](../../architecture/04-storefront-and-themes.md#3-theme-architecture)). A page
that misses the edge cache must render at origin in 250 ms or less at p95, and each render is held
to 150 ms of CPU, 5,000 loop iterations and 2 MB of output. The spike asked:

1. Can [LiquidJS](https://liquidjs.com) render a Dawn-class theme (JSON templates, sections with
   schemas and blocks, section groups, snippets, translations, and Shopify's common tags, filters
   and objects) well within that budget?
2. Can templates be sandboxed: held to limits of time, work, output, memory and nesting, a section
   that breaks them left out rather than the page failing, and nothing of JavaScript or the file
   system in reach?
3. How should data reach templates, when the read models sit in Valkey a round trip away?

**Answer: go.**

* Hatti Base's pages render in 2 to 6 ms at p50 and under 10 ms at p95, on one core, with data in
  memory. The heaviest product page (100 variants, 10 images, 95 KB of HTML) takes 6.8 ms at p95,
  about 5% of the CPU budget.
* One Node process renders about 260 pages a second, mixed.
* Each limit stops the template it is for within 130 ms, and the page renders without that
  section.
* But LiquidJS evaluates one expression at a time, so batching by the tick, as DataLoader does,
  would fetch a list's products one round trip each. Fetching them in chunks, when a template
  first touches one, took a collection page from 28 round trips to 6: 7.1 ms instead of 33.8 at
  1 ms a round trip.

## Set-up

* **The renderer**, [`apps/storefront`](../../../apps/storefront): `PageRenderer` runs LiquidJS
  10.29 with Hatti's tags, filters and limits. It turns read models (the shop, products by handle
  or ID, collections, menus) into the objects templates use, and picks a JSON template by route:
  `/`, `/products/<handle>`, `/collections/<handle>`, or 404.
* **The theme**, [`themes/hatti-base`](../../../themes/hatti-base): a Dawn-class subset in 530
  lines of Liquid. It has:
  * a layout with header and footer section groups;
  * an image banner with blocks, and featured collections;
  * a product page: gallery, option pickers, a variant list, add to cart without JavaScript,
    "Order on WhatsApp" and cash on delivery;
  * a paginated collection page, and a 404 page;
  * product card and price snippets;
  * theme settings, and English and Urdu.
* **The shop**: 200 products in three collections, with 6 to 20 variants and 5 images each, and one
  heavy product with three options, 100 variants and 10 images.
* **The measurements**, `pnpm bench:storefront`: 500 renders of each page after 50 to warm up,
  in one Node 22 process, in the development container (Xeon at 2.1 GHz, 4 cores). Data comes
  from memory, and from memory held back a millisecond a round trip, as Valkey inside a cell
  would answer.
* **The look**: `pnpm --filter @hatti/storefront serve` serves the sample shop, opened in Chromium
  at phone width, light and dark, in English and Urdu.

## Results

### 1. Rendering costs a few milliseconds a page

Data in memory, so rendering alone:

| Page | p50 ms | p95 ms | p99 ms | CPU ms | HTML KB | Template nodes | Round trips |
|---|---:|---:|---:|---:|---:|---:|---:|
| Home | 3.5 | 5.4 | 6.8 | 4.7 | 18 | 1,204 | 9 |
| Home, Urdu | 3.3 | 4.4 | 5.3 | 4.0 | 18 | 1,204 | 9 |
| Product, 6 variants | 2.1 | 2.9 | 4.3 | 2.6 | 20 | 775 | 6 |
| Product, 100 variants and 10 images | 5.8 | 6.8 | 8.0 | 6.3 | 95 | 2,587 | 6 |
| Collection, 24 a page | 3.8 | 4.7 | 6.0 | 4.2 | 22 | 1,583 | 6 |

Time grows with the template nodes rendered, at about 2.5 µs a node. Dawn's product page renders
several times as many nodes as ours, and would still take tens of milliseconds, not hundreds.

The first render of a theme version parses what it uses, 2 to 4 ms more; parsing all of Hatti
Base takes 2 ms. Parsed templates are kept per theme version.

### 2. Fetch lists a chunk at a time

LiquidJS renders a template as a chain of generators and awaits each value a template reads, one
at a time. A loop over a collection's products reads the first product, waits for it, then the
second: DataLoader, which batches what is asked for in the same tick, would see one product at a
time and fetch each in its own round trip.

So a list fetches its products in chunks of 12, when a template first touches one of a chunk: a
featured collection showing 8 fetches 12 products in one round trip, not 8 round trips, nor the
50 products Shopify's `collection.products` would list. Resource settings (a section's
collection) and the route's product or collection are asked for before rendering starts.

At a millisecond a round trip:

| Page | In chunks: round trips | p50 ms | One by one: round trips | p50 ms |
|---|---:|---:|---:|---:|
| Home | 9 | 6.6 | 22 | 14.0 |
| Product, 6 variants | 6 | 4.5 | 9 | 8.0 |
| Collection, 24 a page | 6 | 7.1 | 28 | 33.8 |

### 3. Render sections side by side

A page's sections, and those its layout names, render at once, each fetching what it needs, and
the layout renders last, around them. With a millisecond a round trip, the home page takes
6.6 ms at p50 this way, and 11.6 ms with its sections in turn. A product page, with two sections,
takes 4.5 ms against 5.5; a collection page, with one, the same either way.

### 4. One process, about 260 pages a second

Pages mixed, a millisecond a round trip, for 5 seconds:

| Requests at a time | Pages a second | p50 ms | p95 ms | p99 ms |
|---:|---:|---:|---:|---:|
| 8 | 256 | 30.1 | 40.7 | 55.1 |
| 64 | 266 | 238.1 | 259.0 | 267.5 |

One thread renders about 4 ms of pages a request, so latency under load is queueing: a process
should be sized to stay well below 260 pages a second, and the edge cache serves most requests
anyway (04 §2.2).

### 5. Limits stop what they are for, and the page still renders

Each render, a section's or the layout's, has limits of its own. A section over one is left out,
as an HTML comment, and logged; the rest of the page renders:

| A section that tries | Stopped by | After ms | Nodes rendered |
|---|---|---:|---:|
| A loop of 400 × 400 | nodes | 42 | 50,001 |
| To render a snippet that renders itself | depth | 1.4 | 66 |
| 10 MB of output | output | 86 | 31,433 |
| A range of 10 million | memory | 0.4 | 2 |
| A slow loop of 45,000 filtered outputs | nodes | 127 | 50,001 |

The limits are 50,000 template nodes, 150 ms of wall-clock time, 2 MB of output, LiquidJS's
5 million memory units (range items, and strings some filters build), and snippets 32 deep.
Nodes stand in for the loop iterations the architecture names: a loop counts its body's nodes on
every pass, so they bound the work whatever the loop holds.

### 6. Templates reach only what they are given

* Objects are plain objects, and LiquidJS runs with `ownPropertyOnly`: `{{ product.constructor }}`
  and `{{ settings.__proto__ }}` print nothing.
* Snippets and layouts come from the theme's files, through a file system of Hatti's that knows
  nothing else: `{% render '../layout/theme' %}` fails.
* A filter the theme misspells fails when the theme is parsed (`strictFilters`), so publishing can
  refuse it; broken JSON names its file.

### 7. The Shopify Liquid it supports

* **Tags:** LiquidJS's own (`if`, `for`, `case`, `assign`, `capture`, `render`, `liquid` and
  more), and Shopify's `section`, `sections` (section groups), `schema`, `style`, `stylesheet`,
  `javascript`, `form` and `paginate`.
* **Filters:** LiquidJS's own, and Shopify's `money` and its variants, `image_url`, `image_tag`
  (with `srcset`, width and height), `t` (with plurals and values), `asset_url`,
  `stylesheet_tag`, `script_tag`, `handleize`, `link_to` and `default_pagination`.
* **Hatti's extensions** (04 §3.2): `money_pk` (lakh grouping), `whatsapp_url`, `direction` and
  `cod`.
* **Objects:** `shop`, `product` (variants, options with values, the selected variant, images),
  `collection` (with pagination), `section` (settings and blocks), `settings`, `request`,
  `routes`, `cart` (empty: the edge caches pages, and the cart is filled in on the phone),
  `localization`, `linklists`, `collections`, `all_products`, `template` and `page_title`.

### 8. Urdu

Hatti Base styles with logical properties (`margin-inline-start`, `inset-inline-start`), so its
Urdu pages mirror by themselves: the header, the option pickers, the grid and the badges all
flip, and the theme's strings come from `locales/ur.json`. But merchants' text is in whichever
language they wrote it: an English description on an Urdu page moved its full stops to the
wrong end ("…in Pakistan" became ".Pakistan") until the elements holding it took `dir="auto"`.

## What broke, and the fixes

* **LiquidJS types a template limit but does not enforce it**, and its render limit is only a
  deadline. The renderer passes its own limiter, which LiquidJS consults before rendering every
  node: it counts nodes as well as watching the clock.
* **A snippet that rendered itself ran for the whole 150 ms, and took as long again to unwind**
  (274 ms in all). `render` and `include` now count how deep they go, and stop at 32: 1.4 ms.
* **Sections side by side share one thread.** A section working hard uses the time of the
  others, which render in its gaps: under the loop above, sections beside it ran out of time.
  The node count is the limit that does not depend on neighbours; time is the backstop.
* **Drops are exempt from `ownPropertyOnly`.** `{{ collections.constructor }}` reaches the class
  of the drop behind `collections`, and LiquidJS calls it with no arguments, which throws: the
  section is left out, and nothing escapes, since a template can only call what it reaches
  without arguments. Drops are kept for lookups by name and lists fetched on first touch, with
  their state in private fields.
* **The theme's product form overflowed phones.** Its grid columns sized themselves to the
  longest variant name, and fieldsets keep their content's width unless told otherwise. Fixed
  with `minmax(0, 1fr)` columns and `min-inline-size: 0`.
* **English merchant text read wrongly on Urdu pages**, as above: fixed with `dir="auto"`.

## Rules that follow

1. Templates get plain objects, and LiquidJS runs with `ownPropertyOnly` and `strictFilters`.
   Drops only for lookups by name and lazy lists, holding their state in private fields.
2. Every render has its own limits: 50,000 nodes, 150 ms, 2 MB, 5 million memory units and
   snippets 32 deep. A section over one is left out and logged; the page is still sent.
3. Lists are fetched a chunk at a time, when first touched. What a page will need for certain
   (its product or collection, sections' resource settings, the shop) is asked for before
   rendering.
4. A page's sections, and its layout's, render side by side; the layout renders last.
5. Themes use logical CSS properties, and put `dir="auto"` on elements that hold merchants' text.
   Theme Check should flag both (04 §3.3).

## Caveats

* Measured in the development container, not the target cloud, with data in memory and latency
  simulated, not Valkey. There is no network, compression or streaming in these numbers.
* Hatti Base is a subset of Dawn: no search, cart page, blogs, customer accounts or predictive
  search, and 5 kinds of section. Rendering grows with nodes, so Dawn's pages would take a few
  times as long: still well within the budget.
* JSON templates only: no `.liquid` templates or `{% layout %}` tag, no theme blocks
  (`{% content_for 'blocks' %}`), and no section rendering API for the theme editor yet.
* The time limit is wall-clock time, waits for data included: Node cannot measure one request's
  CPU while others share its thread.

## Follow-ups

* Read models in Valkey, written by the catalog on its events, with the chunked fetches above.
* Streaming: send `<head>`, with its preload hints, before the sections finish (04 §3.3).
* The edge cache, keyed by theme version and locale (04 §2.2), and a budget per page besides the
  budget per render.
* Theme Check: `dir="auto"` on merchants' text, `image_tag` without `sizes`, lists fetched inside
  loops.
* The theme editor's protocol, the section rendering API, theme blocks, and more of Dawn's
  sections: search, cart, blogs and accounts, with the storefront (MVP).
