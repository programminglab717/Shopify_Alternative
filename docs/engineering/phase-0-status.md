# Phase 0 · Engineering foundations: status

> **Last updated:** 2026-10-01 · Tracks the Engineering row of
> [Roadmap §2](../product/04-roadmap.md#2-phase-0--foundations-oct--mid-nov-2026).
> Change by change history, and the work in progress: [progress log](./progress-log.md).

## Summary

The monorepo, the data layer and one vertical slice are in place and tested end to end. An
authenticated Admin API request creates a product under row-level security, and the product's event
reaches a worker through the outbox. Staff sign-in and tracing are in. Spike 5 showed that row-level
security and PgBouncer transaction pooling hold up. It fixed what broke behind the pooler, and CI
now runs every database test through PgBouncer. Spike 1 showed that LiquidJS renders a Dawn-class
theme, in English and Urdu, in a few milliseconds a page, within limits of the storefront's own. The storefront
now renders from documents the worker publishes to Valkey as the catalog and stock change, a
fraction of a second after each change, and serves every shop at its own subdomain, and at domains of its own once their DNS points at the platform, in its own theme, or one it is preparing through a preview link, and with its own menus and pages, and a search that finds its products however shoppers spell them, suggesting them as they type. Links to a shop's old addresses follow its redirects, and a shop can close its storefront behind a password until it opens. Its returns, privacy, shipping and terms policies are at Shopify's addresses, linked from its footer, and the Admin API drafts them in English or Urdu from what the shop has set. Shoppers fill carts from product pages, in a drawer that opens over the page, and change them there or on the cart page, in English or Urdu; the core keeps each cart, priced from the catalog whenever it is read, and shops set what delivery costs, which their pages show. Shoppers then check out on one page, on the shop's own address, its policies linked at its foot, placing a cash-on-delivery order that the shop confirms as any other; the order keeps which versions of the shop's policies they agreed to, and where they placed it from. No order collects more cash on delivery than the law allows, whoever places it. Shops keep discount codes, for a percentage or an amount off or free delivery, which shoppers apply at checkout: the cart keeps the code, and its use is counted with the order, never past its limit or twice by a customer meant to use it once. The catalog has options, bulk variants, images and
collections, and a shop moving from Shopify brings its products in one CSV file, keeping their addresses. Stock is in: locations, levels per variant and location, an append-only ledger, and
reserve, commit and fulfil operations that never sell a unit twice. Orders run end to end: staff and
apps place them, which commits their stock; cash-on-delivery orders are confirmed or cancelled;
parcels ship, are delivered, or are refused and checked back in with items restocked or written off;
and orders close when they are paid or back. Confirmed orders wait to be packed, then to be booked,
and staff confirm, cancel, pack or tag up to 250 at once. The admin's home says what waits:
orders to confirm, review, pack and book, parcels coming back, and the cash on delivery still to
come, each with how many and how much. COD health follows a period's cash-on-delivery orders
through confirmation and delivery, for the shop and by city, product, source and courier, and
sales reports say what orders came to in Shopify's terms, day by day, with the products that
sold most. Packing slips and invoices print from the
browser, in English and Urdu, on A4 or thermal paper. Owners and managers record refunds, up to what
was paid. Orders export to CSV for spreadsheets. Orders taken in chats start as drafts at the
prices agreed: staff place them, or send the customer a link where they confirm the order
themselves. Any order's customer can get a link too, to confirm or cancel a cash-on-delivery
order, and then to see where it is. Mutations that must not run twice, such as placing an order, take an idempotency key,
so a retry never does the work again. Every order belongs to a
customer, found by mobile number, whose profile shows what their orders add up to and how they
turned out. Orders from numbers on the merchant's blocklist wait for review, and so do
cash-on-delivery orders whose risk score, from transparent rules, reaches the shop's threshold.
Segments filter customers by who they are and what they ordered, in a query language close to
Shopify's, and marketing consent is kept per channel with a ledger of every change. Customers come
in from Shopify or a spreadsheet and go out as CSV. A customer can have several numbers; duplicates
merge, and a customer's data can be erased on request while the shop keeps its order records. Staff
other than owners and managers see customers' numbers masked; confirmation agents reveal one when
they call, and an audit log records it, with exports, merges and erasures. Environments and IaC wait
on the hosting decision.

| Deliverable (roadmap) | Status | Where |
|---|---|---|
| Monorepo | ✅ Done | pnpm workspaces and catalog, Turborepo, TypeScript (ESM), ESLint, Prettier |
| CI | ✅ Done | `.github/workflows/ci.yml`: format, lint, catalog check, build, typecheck, tests against real Postgres and Valkey (request-serving connections through PgBouncer, as in production), fresh migrate and seed |
| CD, environments, IaC | ⏳ Not started | Waits on the hosting decision (ADR-015 latency bake-off) |
| Observability | 🟡 Mostly done | OpenTelemetry traces and metrics over OTLP, one trace from API through the outbox to the worker, `shop_id` on spans, trace ids in logs, outbox and sign-in metrics, local Grafana stack. Not yet: Sentry, dashboards and SLO alerts, collector tail sampling (with the infrastructure) |
| Tenancy skeleton with RLS | ✅ Done | `db/migrations/0001_foundation.sql`, `@hatti/db` |
| Auth | 🟡 Mostly done | App access tokens with scopes. Staff sign-in: argon2id passwords with breach checks, TOTP with recovery codes, rotating refresh tokens, device list, role presets with MFA for owners, managers and accountants ([ADR-020](../architecture/13-decision-log.md#adr-020--staff-identity-built-in-house-on-audited-primitives)). Not yet: passkeys, email verification and password reset (need email delivery), staff invitations, re-authentication for sensitive actions, OAuth apps |
| Design tokens | ✅ Done | `@hatti/tokens`, with WCAG contrast tests for every text pair |
| Catalog and stock (ahead of the MVP) | ✅ Done | Options, variants, images and collections (CAT-01–04), and stock: INV-03 (quantities and adjustment ledger) and the tracking half of INV-01. Multi-location levels (INV-02) and the restock reason for INV-06 are in place for the features that use them. Products come from a Shopify product export in one CSV file, each made as `productCreate` makes it, keeping its handle and so its address, with its images and the stock Shopify tracked at the primary location, after a dry run if the shop wants one ([ADR-059](../architecture/13-decision-log.md#adr-059--a-shopify-product-export-is-imported-product-by-product-as-productcreate-makes-them-keeping-their-handles-the-core-sets-the-stock)); with customers' imports, the CSV half of ONB-05 |
| Orders (ahead of the MVP) | ✅ Done, first slice | Placing orders with per-shop numbers and committed stock, confirmation, cancellation that releases stock, edits, payment, search by number, mobile, tracking number or name, counts by stage, a timeline, and parcels: shipped, delivered, or refused and checked back in with restock or write-off. Cash-on-delivery risk scores with reasons, from transparent rules, and holds for review at the shop's threshold ([ADR-025](../architecture/13-decision-log.md#adr-025--order-risk-is-a-snapshot-taken-when-an-order-is-placed-or-re-addressed)). Packing, which splits confirmed orders into To pack and To book, and bulk confirm, cancel, pack and tag for up to 250 orders, each changed on its own. Parts of ORD-01, ORD-02, ORD-10, COD-04 and COD-09. Draft orders taken in chats at the prices agreed, which staff place or the customer confirms through a link ([ADR-031](../architecture/13-decision-log.md#adr-031--draft-orders-keep-agreed-prices-and-hold-no-stock-customers-confirm-them-through-a-secret-link)), after adding their address there if it has none ([ADR-034](../architecture/13-decision-log.md#adr-034--customers-add-a-drafts-address-and-their-number-while-it-has-none-through-its-link)), and links where an order's customer confirms or cancels it and then follows it ([ADR-032](../architecture/13-decision-log.md#adr-032--customers-confirm-or-cancel-cash-on-delivery-orders-through-a-link-that-then-follows-the-order)) until 30 days after it ends ([ADR-038](../architecture/13-decision-log.md#adr-038--an-orders-link-lasts-until-30-days-after-the-order-ends)), and corrects its address until it is packed ([ADR-033](../architecture/13-decision-log.md#adr-033--customers-correct-an-orders-address-through-its-link-until-it-is-packed-the-number-stays-the-shops)). Bilingual packing slips and invoices for A4 and thermal printers, for up to 250 orders at a time ([ADR-028](../architecture/13-decision-log.md#adr-028--printable-documents-are-html-pages-with-print-styles-pdfs-will-render-the-same-pages)). Refunds that owners and managers record, up to what was paid, with the financial status following ([ADR-029](../architecture/13-decision-log.md#adr-029--refunds-record-money-staff-sent-back-only-owners-and-managers-make-them)). CSV exports of orders or their line items, filtered as the list is, by owners, managers and accountants. The admin's home: how many orders wait to be confirmed, reviewed, packed and booked, and how many parcels are coming back, each with what they come to, and the cash on delivery still to come, worked out when asked. What couriers owe: the cash on delivery of delivered orders not yet paid, by courier and by days since delivery, and what is still on its way ([ADR-066](../architecture/13-decision-log.md#adr-066--what-couriers-owe-is-worked-out-from-the-orders-when-asked-delivered-cash-on-delivery-orders-not-yet-paid-by-courier-and-by-days-since-delivery)). COD health: of a period's cash-on-delivery orders, how many were confirmed, cancelled first or still wait, and of their parcels how many were delivered, came back or are on their way, with the rates of those that turned out, for the shop and by city, product, source or courier ([ADR-060](../architecture/13-decision-log.md#adr-060--cod-health-follows-a-periods-cash-on-delivery-orders-worked-out-from-them-when-asked-its-rates-of-those-that-turned-out)). Sales reports in Shopify's terms (orders, gross sales, discounts, returns, net sales, shipping, total sales and average order value) for a period and every day, week or month of it in the shop's time, cancelled orders aside and items that came back as returns on their order's day, with the products that sold most ([ADR-061](../architecture/13-decision-log.md#adr-061--sales-are-reported-in-shopifys-terms-from-the-orders-when-asked-an-order-counts-on-the-day-it-was-placed-cancelled-ones-aside-and-so-do-its-items-that-came-back)). ORD-03 but payment links; COD-02 but sending the links; ORD-05 but booking; ORD-06 as pages to print; ORD-09 but store credit and gateway refunds; ORD-11 but Excel files and scheduled exports; the MVP half of COD-06; INV-06; the orders half of ANL-01; COD-12 but its screen; ANL-02 but sessions, conversion and a live view. Not yet: courier booking (spike 2), confirmation messages (spike 3), PDFs and tax invoices |
| Customers (ahead of the MVP) | ✅ Done, first slice | Phone-first profiles that orders find or create, with their orders, what they paid, their delivery history and the addresses they used, worked out from the orders ([ADR-023](../architecture/13-decision-log.md#adr-023--customer-order-stats-are-worked-out-from-orders-when-read)); the merchant's blocklist, whose numbers' orders wait for review; segments over customer and order fields, evaluated when asked for ([ADR-024](../architecture/13-decision-log.md#adr-024--segments-are-queries-evaluated-on-demand-over-fields-modules-contribute)); marketing consent per channel (WhatsApp, SMS, email) with an append-only ledger; CSV import (Hatti, Shopify or a spreadsheet) and watermarked, recorded exports; several numbers per customer, merging duplicates, and erasure on request that keeps the shop's order records ([ADR-026](../architecture/13-decision-log.md#adr-026--a-customer-can-have-several-numbers-modules-with-customer-data-join-merges-and-erasure)); numbers masked for every staff role but owners and managers, with a logged reveal for confirmation agents, and the shop's audit log ([ADR-027](../architecture/13-decision-log.md#adr-027--customers-numbers-are-masked-by-role-and-reveals-go-to-an-append-only-audit-log)). CUS-01, CUS-03, CUS-04, CUS-07, the erasure half of CUS-05 and the merchant half of COD-07. Not yet: a customer's own data export |
| Storefront documents (ahead of the MVP) | ✅ Done, first slice | Documents in Valkey for each active product, with whether each variant can be sold online, each collection's active products in its order, `/collections/all`, menus and the shop, published by the worker from catalog and stock events: one publisher per shop at a time rebuilds what they mark stale from the database, a batch at a time, and a publisher that loses its lock cannot write ([ADR-036](../architecture/13-decision-log.md#adr-036--one-publisher-per-shop-rebuilds-storefront-documents-from-the-database-its-writes-fenced-by-its-lock)). The storefront reads them in as many round trips as from memory, and serves each open shop at its handle's subdomain, found through a directory in Valkey ([ADR-037](../architecture/13-decision-log.md#adr-037--every-shop-has-a-handle-naming-its-storefront-on-the-platforms-domain-storefronts-find-shops-through-a-directory-in-valkey)); the Admin API gives each shop its storefront's address, and the seed publishes its shop. Shops keep their own templates, section groups and settings over the platform theme, through the Admin API, which checks them against it as the storefront would read them, and the storefront shows each shop's main theme, published with the shop's document, a fraction of a second after a change ([ADR-039](../architecture/13-decision-log.md#adr-039--a-shops-theme-is-a-platform-theme-with-the-shops-own-json-files-over-it)), and their own menus, three levels deep, whose links follow collections' and products' handles ([ADR-040](../architecture/13-decision-log.md#adr-040--a-shops-menus-are-kept-whole-linking-to-collections-and-products-by-id)), and the WhatsApp number their "Order on WhatsApp" links go to ([ADR-041](../architecture/13-decision-log.md#adr-041--what-a-shop-sets-for-its-storefront-as-a-whole-is-the-online-stores-starting-with-its-whatsapp-number)), and their pages, such as About us and their returns policy, their HTML cleaned of anything that runs when saved, which menus link to ([ADR-045](../architecture/13-decision-log.md#adr-045--a-shops-pages-keep-html-cleaned-of-anything-that-runs-when-saved-the-storefront-shows-it-as-it-is)). Pages and menus of OS-07. Search finds a shop's active products with every word typed, matches in titles first, however Roman Urdu is spelt: storefronts ask the core, which matches them as the admin's search does, and Hatti Base's search page shows them a page at a time, while its header suggests them as a shopper types, as Shopify's predictive search does ([ADR-046](../architecture/13-decision-log.md#adr-046--storefront-search-asks-the-core-which-finds-products-in-postgres-as-the-admins-search-does-until-typesense)). SRC-01 but typo tolerance. Pages go out as the edge is to keep them: five minutes, tagged with the shop and the handles they name, and the publisher purges the tags of the documents that change, by comparing each with the one stored ([ADR-047](../architecture/13-decision-log.md#adr-047--the-edge-keeps-storefront-pages-by-the-handles-they-name-before-they-stream-and-forgets-those-whose-documents-change)). Shops connect domains of their own through the Admin API, pointed at the platform with a CNAME record and checked by asking DNS; the storefront answers at the verified ones, and sends pages asked for at a shop's other addresses on to its primary domain ([ADR-048](../architecture/13-decision-log.md#adr-048--a-shops-own-domains-are-the-online-stores-one-shops-each-served-once-dns-points-them-at-the-platform-the-primary-one-where-pages-send-shoppers)). ONB-07 but its certificates. Any theme, published or not, can be seen on the storefront through a link the Admin API gives, for 14 days: every page shows it as saved, uncached, with a bar that names it and ends the preview ([ADR-049](../architecture/13-decision-log.md#adr-049--a-theme-is-previewed-through-a-link-the-core-seals-which-storefronts-keep-in-a-cookie-and-render-from-the-cores-files-never-kept)). A preview the theme editor frames is in design mode, and its script and the editor talk through `postMessage`, as Shopify's theme editor and its themes do: what the page has, which section or block is chosen, and sections rendered again with settings not yet saved ([ADR-050](../architecture/13-decision-log.md#adr-050--the-theme-editor-talks-to-its-preview-through-postmessage-a-framed-preview-is-in-design-mode-and-renders-sections-with-the-editors-unsaved-files)). Each page's canonical address is at the shop's own, in its language, with its address in the other language beside it; link previews get the page's description and image at that address; products carry schema.org's structured data; and `/sitemap.xml` and `robots.txt` come from the storefront's documents ([ADR-051](../architecture/13-decision-log.md#adr-051--search-engines-and-link-previews-are-told-each-pages-address-at-the-shops-own-in-each-language-and-find-pages-through-sitemaps-of-the-storefronts-documents)). Shops keep URL redirects from addresses they have no page at, such as their old store's, through the Admin API, one at a time or a Shopify redirects export at once, which they can export again, and the storefront follows one where it would answer 404, in the shopper's language ([ADR-052](../architecture/13-decision-log.md#adr-052--a-shops-url-redirects-are-the-online-stores-and-the-storefront-follows-one-only-where-it-has-no-page)); a product, collection or page whose handle changes sends shoppers from its old address to its new one when the change asks, as Shopify's `redirectNewHandle` does ([ADR-053](../architecture/13-decision-log.md#adr-053--a-handle-change-asks-for-its-redirect-as-shopifys-redirectnewhandle-does-and-the-redirect-leads-to-where-the-page-is-now)). Shops add rules of their own to robots.txt, lines crawlers read, checked when saved ([ADR-055](../architecture/13-decision-log.md#adr-055--a-shop-adds-rules-to-its-robotstxt-as-lines-crawlers-read-checked-when-saved-never-liquid)). OS-09 but the toolkit's screens. A shop can close its storefront behind a password: shoppers without it see only the theme's password page, in their language, and nothing of the shop is kept at the edge until it opens ([ADR-054](../architecture/13-decision-log.md#adr-054--a-shops-storefront-can-be-closed-behind-a-password-which-the-storefront-checks-against-a-verifier-in-the-shops-document)); the password half of OS-15. A shop's refund, privacy, shipping and terms policies and its contact information are kept as Shopify keeps them, through the Admin API, and shown at `/policies/refund-policy` and the rest in Shopify's markup, whatever the theme, in the page's language, listed in Liquid's `shop.policies` and linked from Hatti Base's footer; the Admin API drafts each, in English or Urdu, from the shop's name, WhatsApp number and delivery charges, and saves none until the shop does ([ADR-056](../architecture/13-decision-log.md#adr-056--a-shops-policies-are-kept-as-shopify-keeps-them-shown-in-shopifys-markup-and-drafted-from-what-the-shop-has-set-never-saved-by-themselves)). ONB-09 but the admin's screens. Not yet: the editor's screens, translations, facets, blogs, the edge itself, and certificates for shops' domains |
| Carts and checkout (ahead of the MVP) | ✅ Done, first slice | Carts kept by the core, priced from the catalog and held to the stock that can be sold online whenever they are read or changed, through routes only storefronts reach ([ADR-042](../architecture/13-decision-log.md#adr-042--carts-are-kept-by-the-core-and-priced-whenever-they-are-read-storefronts-change-them-with-a-key-of-their-own)). The storefront serves the cart page and Shopify's cart forms and Ajax cart over them, with Hatti Base's cart page and a drawer that opens over the page when a product is added, filled through Shopify's section rendering API with the shopper's cart, its count on every page from a cookie, and the whole cart as a WhatsApp order. What shops charge for delivery: one charge for everywhere, zones of cities, and free delivery from a subtotal, through the Admin API, on product and cart pages ([ADR-043](../architecture/13-decision-log.md#adr-043--a-shop-charges-for-delivery-once-for-everywhere-by-zones-of-cities-and-not-at-all-from-a-subtotal)). A one-page checkout on the shop's address, in English and Urdu and without scripts: the shopper's name, mobile number, city and address, then a cash-on-delivery order placed as the page showed it, with the city's delivery charge, its stock committed, its customer found by number and its risk scored, and the cart emptied; placing twice places one order; the shop's policies linked at its foot, as Shopify's checkout links them ([ADR-044](../architecture/13-decision-log.md#adr-044--checkout-is-one-page-the-core-renders-and-storefronts-serve-on-the-shops-address-placing-a-cash-on-delivery-order-as-the-page-showed-it)). Above its button it says that placing the order agrees to them, and the order keeps the versions its page linked and the address and browser it came from, which the Admin API shows, the policies as they were then ([ADR-057](../architecture/13-decision-log.md#adr-057--what-a-shopper-agrees-to-in-placing-an-order-is-kept-with-it-the-versions-of-the-shops-policies-its-checkout-linked-and-where-it-was-placed-from)). Shopify's cart permalinks, `/cart/{variant}:{quantity}`, which shops send in chats, begin a cart of their own and go to its checkout, the shopper's own cart left as it is ([ADR-065](../architecture/13-decision-log.md#adr-065--a-cart-permalink-begins-a-cart-of-its-own-and-goes-to-its-checkout-leaving-the-shoppers-cart-as-it-is)). The cash-on-delivery half of CHK-01, CHK-19, part of CHK-02, CH-07's checkout links, CHK-22 but a delivery estimate, the MVP half of CHK-04, and TAX-06's e-contract logs. No order collects more than Rs 200,000 in cash at the door, the law's cap, whoever places it: the rest is paid in advance, or the order is refused, and checkout says so before the shopper types ([ADR-058](../architecture/13-decision-log.md#adr-058--no-order-collects-more-cash-on-delivery-than-the-law-allows-whoever-places-it-the-rest-is-paid-in-advance-or-the-order-is-not-placed)); TAX-07. Discount codes are in their own row. Not yet: the OTP, COD rules and fee, online payment, abandoned checkouts |
| Discounts (ahead of the MVP) | ✅ Codes, at checkout and in the cart | Discount codes through the Admin API, as Shopify's basic and free-shipping codes are: a percentage or an amount off an order's items, or free delivery, with a minimum, dates, a limit on uses and one use a customer, matched in any letter case, in a pricing module of their own ([ADR-062](../architecture/13-decision-log.md#adr-062--discount-codes-are-the-pricing-modules-a-percentage-or-an-amount-off-an-orders-items-or-free-delivery-matched-in-any-letter-case)). Checkout's page takes a code in a form of its own and the cart keeps it; the page shows what it takes off, and the order is placed with it, its use counted in the order's transaction, never past its limit or twice by a customer meant to use it once, and kept with the order ([ADR-063](../architecture/13-decision-log.md#adr-063--a-shoppers-discount-code-is-kept-with-their-cart-and-counted-with-the-order-placed-with-it-in-the-orders-transaction)). Shopify's `/discount/` links keep a code with the shopper's cart, one begun for it if need be, and send them on; the cart takes Shopify's `discount` from scripts, and its JSON and Liquid's `cart` say what the code takes off, which Hatti Base's cart page and drawer show, in English and Urdu ([ADR-064](../architecture/13-decision-log.md#adr-064--discount-links-keep-their-code-with-the-shoppers-cart-one-begun-for-it-if-need-be-and-a-cart-says-of-a-code-only-whether-it-applies)). CHK-06's MVP half. Not yet: codes for some products or collections, automatic discounts, combining codes, codes on staff's orders and drafts, and the admin's screens |
| Couriers' cash (ahead of the MVP) | ✅ Statements and what is owed | What couriers owe the shop for cash on delivery: on delivered orders not yet paid, by courier and by days since delivery, and what is still on its way ([ADR-066](../architecture/13-decision-log.md#adr-066--what-couriers-owe-is-worked-out-from-the-orders-when-asked-delivered-cash-on-delivery-orders-not-yet-paid-by-courier-and-by-days-since-delivery)). Couriers' remittance statements imported as the CSV they send, their columns found by the names couriers use: each line matched to a parcel by its tracking number and its cash received on the parcel's order, at most what it owes, in full or in part, in one transaction; lines that match no parcel, a parcel paid for before, or an order that owes nothing, kept to look into, with the courier's charges and the tax withheld; a dry run first, and a statement's reference taken once ([ADR-067](../architecture/13-decision-log.md#adr-067--couriers-remittance-statements-are-imported-whole-into-a-logistics-module-each-lines-cash-received-on-its-parcels-order-at-most-what-the-order-owes-and-a-parcels-cash-once)). The MVP half of COD-10. Not yet: couriers' APIs, the ledger of fees and tax credits, dispute sheets, and the admin's screens |
| Spike 1: Liquid rendering | ✅ Done: go | [Results](./spikes/01-liquid-rendering.md). `apps/storefront` renders Hatti Base, a Dawn-class reference theme in English and Urdu, from JSON templates, sections, blocks and section groups, with Shopify's common tags and filters. Pages take 2 to 6 ms at p50 and under 10 ms at p95; one process renders about 260 a second. Limits on nodes, time, output, memory and snippet depth leave a failing section out; lists are fetched a chunk at a time ([ADR-035](../architecture/13-decision-log.md#adr-035--the-storefront-renders-liquid-with-limits-of-its-own-fetching-lists-a-chunk-at-a-time)) |
| Spike 5: RLS and PgBouncer performance | ✅ Done: go | [Results](./spikes/05-rls-and-pooling.md). RLS keeps every listing plan and costs about 0.1 ms per transaction. PgBouncer adds about 0.03 ms per round trip, and serves 1,024 clients where direct connections fail at 128. Fixed: timeout startup parameters that PgBouncer refused, and the relay's `LISTEN` behind a pooler ([ADR-021](../architecture/13-decision-log.md#adr-021--pgbouncer-transaction-pooling-with-no-session-state)) |

## What exists

| Package | Purpose | Tests |
|---|---|---|
| `@hatti/ids` | UUIDv7 keys, typed public IDs (`prod_…`) | 12 |
| `@hatti/money` | Exact minor-unit money, allocation, rounding, PKR formatting | 24 |
| `@hatti/pk` | Mobile numbers (and their masked form), CNIC and NTN, IBAN, cities and provinces, Urdu and Roman Urdu search keys, and keys of words still being typed | 56 |
| `@hatti/config` | Validated environment configuration | 6 |
| `@hatti/crypto` | Secret encryption with key rotation, TOTP, base32, secret tokens, verifiers of shared passwords, such as a storefront's | 37 |
| `@hatti/ratelimit` | Redis fixed-window rate limits; subjects hashed | 3 |
| `@hatti/logger` | JSON logging with secret and PII redaction, trace ids | 6 |
| `@hatti/tokens` | Colour, type, space and motion tokens, CSS variables, contrast checks | 37 |
| `@hatti/telemetry` | OpenTelemetry set-up with privacy-safe instrumentation | 3 |
| `@hatti/db` | Pools, tenant transactions with per-transaction limits, migrator, setup, Postgres error checks, timestamps from raw queries, disposable test databases (direct or through PgBouncer, and migrated only so far, for migration tests); the shop directory's rules, such as handles | 26 |
| `@hatti/events` | Transactional outbox (one event or many per statement), relay (`SKIP LOCKED` with `LISTEN`/`NOTIFY` checked at start-up, poison-event isolation), BullMQ transport, trace propagation, and the append-only audit log | 13 |
| `@hatti/csv` | CSV reading and writing: RFC 4180 quoting, byte-order marks, formula-safe cells | 7 |
| `@hatti/documents` | Printable documents and pages for customers' phones: HTML templates that escape by default, English and Urdu wording, pages set up for A4, 4×6 inch labels and 80 mm rolls, and a phone page with its content security policy | 7 |
| `@hatti/api` | Tenant context and the shop's directory entry, the public site's and storefronts' addresses, what DNS says of a host, access tokens, scopes (the legal policies' and discounts' among them) and role presets, who sees customers' numbers, scope guard, which mutations need an idempotency key (field resolvers too), input checks (text, prices, tags, email, Pakistani mobiles) and mutation results, per-request batch loaders, shared GraphQL types | 18 |
| `@hatti/catalog` | Products with up to three options and 250 variants, bulk variant changes, variant cost and weight, images by URL, manual and smart collections, and the product search storefronts ask for; handle changes that ask for their old address to redirect, as Shopify's `redirectNewHandle` does; Shopify's product exports read into products, made one at a time, with a dry run: services, GraphQL API, events, and reads in the caller's transaction for read models | 63 |
| `@hatti/inventory` | Locations with Pakistani addresses, stock levels, an append-only ledger with history, stock counts and adjustments, reserve, commit, fulfil and restock for checkout and orders: services, GraphQL API, stock fields on products and variants, events, and whether variants can be sold online, and how many, for read models and carts | 34 |
| `@hatti/customers` | Customers by mobile number, found or created by orders, with other numbers, search by number, its last digits or name, the blocklist, segments (a query language with typed fields other modules contribute, compiled to one SQL statement), marketing consent with its ledger, CSV import and export, merging and erasure that other modules take part in, numbers masked by role with a logged reveal: services, GraphQL API, events | 49 |
| `@hatti/orders` | Orders from staff and apps with Pakistani addresses and committed stock, per-shop numbers, confirmation, cancellation, edits, payment, parcels through delivery or return to origin, search, stage counts, timeline, customers' numbers hidden from packers; each order's customer, holds for blocked numbers, each customer's orders and what they add up to, order fields for segments, COD risk scores with reasons, holds at the shop's threshold and the policy, orders moved on a merge or kept without personal data after an erasure, numbers masked by role with a logged reveal, packing, bulk confirm, cancel, pack and tag, packing slips and invoices, refunds, CSV exports, draft orders, and links where customers confirm or cancel drafts and orders, add or correct their addresses and follow them, and what customers agreed to in placing orders through checkout, and where from, shown by role and cleared by erasure; no more cash on delivery than the law allows an order; what waits for the shop, for the admin's home; what couriers owe, by courier and age; COD health; sales reports: services, GraphQL API, the links' pages, events | 106 |
| `@hatti/online-store` | Shops' themes: a platform theme with the shop's own templates, section groups and settings over it, a main theme and others prepared to publish in its place, files checked for their shape and by Theme Check when saved; shops' menus, three levels deep, saved whole, their links to collections and products by ID, and the main and footer menus made on first use; storefront preferences, such as the WhatsApp number; shops' pages, their HTML cleaned of anything that runs when saved, and menus' links to them; shops' own domains, one shop's each, checked with DNS, one of them primary; links that preview a theme, published or not, sealed so nothing is stored; URL redirects from paths the shop has no page at, kept as the storefront compares addresses, and from where a page, product or collection was when it moves, never the long way round; the storefront's password, sealed, with a verifier for the storefront; rules for its robots.txt, checked line by line; its policies, as Shopify keeps them, every version kept, and drafts of them in English and Urdu from what the shop has set; redirects from and to Shopify's redirects export: services, GraphQL API, the route storefronts fetch a previewed theme from, events, and reads in the caller's transaction for read models | 55 |
| `@hatti/checkout` | Shoppers' carts: variants, quantities and properties with a note and attributes, found by the digest of a secret, priced from the catalog and held to online stock whenever read or changed, as Shopify's cart forms and Ajax cart change them; the routes storefronts change them through; what shops charge for delivery, by zones of cities and free from a subtotal; checkouts, whose page places a cash-on-delivery order through the orders module as it showed it, once, served by the core and by storefronts on shops' addresses, and links the shop's policies, which placing the order agrees to, the order keeping which versions, and says when a cart is more than cash on delivery may collect; a discount code kept with the cart, set through the cart as Shopify's `discount` or on the checkout's page, said with the cart as it applies, and counted with the order: services, GraphQL API, the checkout's page, events, and reads in the caller's transaction for read models | 54 |
| `@hatti/pricing` | Discount codes: a percentage or an amount off an order's items, or free delivery, with a minimum, dates, a limit on uses and one use a customer, matched in any letter case; what a code takes off an order, and its uses, counted with the orders placed with it, which customers' merges move: services, GraphQL API, events | 13 |
| `@hatti/logistics` | Couriers' remittance statements: read from couriers' CSV by the names of their columns, each line matched to a parcel by its tracking number, its cash received on the parcel's order through the orders module, and what came of it kept: services, GraphQL API, events | 7 |
| `@hatti/identity` | Staff accounts, passwords, two-step verification, sessions, shop roles | 25 |
| `@hatti/core` | Admin API (app and staff callers, idempotency keys), `/auth`, customers' links to drafts and orders (`/d/`, `/o/`), the audit log's API, the shop's handle and storefront address, at its primary domain if it has one, the routes storefronts reach with their key (`/storefront/`), checkouts' pages (`/checkouts/`), worker, the storefront publisher, seed, health checks, telemetry wiring, configuration; the publisher's purges of the edge's pages, through Cloudflare or nothing; redirects from products' and collections' old addresses, written by the worker; DNS for checking shops' domains; the shop's policies and their drafts, from its delivery charges and WhatsApp number; the policies an order's customer agreed to, as they were; products from a Shopify export, and the stock Shopify tracked for them; the admin's home | 155 |
| `@hatti/storefront-data` | Storefront documents in Valkey: their shapes, keys, a store that reads each in one round trip, writes fenced by the shop's build lock, handles kept right, the queue of what waits to be built per shop, the directory of shops by handle and by their own domains, shops' main themes, their menus, written whole, and their pages, found by handle; their URL redirects by path, written by what changed; a closed shop's password verifier; its policies, found by type; the cache tags pages carry, a path's among them; every document's handle, for sitemaps | 16 |
| `@hatti/storefront-api` | What storefronts ask of the core: carts' actions and JSON shapes, starting checkouts and fetching their pages, with where the shopper placed the order from, search, whole or as a shopper types, the theme a preview link shows, and a client over HTTP with the platform's storefront key | 7 |
| `@hatti/themes` | Themes as the storefront reads them: a theme's files and its sections' schemas, a shop's files laid over a platform theme, settings held to their types, and Theme Check, which the core runs on shops' files when they are saved | 3 |
| `@hatti/storefront` | The storefront renderer: Liquid themes with JSON templates, sections, blocks and section groups, Shopify's common tags and filters, objects over documents fetched a chunk at a time, from Valkey or memory, limits per render; a server that finds each request's shop by its host, its handle's subdomain or a domain of its own, and renders it in its own theme, laid over the platform theme once per version, its settings held to their types and its menus three levels deep, sent as it is written, the head first, and that renders a page of each template before it listens; the cart page and Shopify's cart forms and Ajax cart over the core's carts, with the cart's cookies and a limit on changes, and the cart's discount code and what it takes off; Shopify's `/discount/` links and cart permalinks; shoppers sent only along paths on the shop; checkout from the cart form and `/checkout`, and checkouts' pages on the shop's address; shops' pages at `/pages/`, in the template they name; the search page at `/search`, a page at a time, its links keeping the words, and suggestions as a shopper types, as Shopify's predictive search gives them; Shopify's section rendering API, with the shopper's cart, on pages and the Ajax cart's answers; answers sent as the edge is to keep them, pages tagged with what they name; pages asked for at a shop's other addresses sent on to its primary domain; the theme a preview link shows on every page after it until it ends, never kept, with a bar that ends it; design mode in the theme editor's frame, with the script that talks to the editor and sections rendered with its unsaved files; canonical and alternate addresses, link previews and structured data at the shop's own address, sitemaps and robots.txt, with the shop's own rules; shops' URL redirects followed where a page would be 404, in the shopper's language; a closed shop's password page, the password taken with a limit and remembered in a cookie, and nothing of the shop kept at the edge; shops' policies at `/policies/`, in Shopify's markup, and `shop.policies`; the Hatti Base theme, with a cart drawer, a benchmark and a dev server | 68 |

That is 910 tests. They cover:

* RLS isolation at the SQL level, including a shop setting that must not leak to the next
  transaction, and 400 interleaved transactions for two shops on four shared connections;
* cross-tenant probes through the API, including every catalog, stock, location, order, customer
  and blocklist mutation;
* stock that is never sold twice (20 buyers for 5 units), orders listing the same variants in
  opposite orders without deadlocking, and a location deactivation that waits for a sale in
  progress there;
* a page of products that reads all its variants' stock with one query;
* orders numbered without gaps while several are placed at once and some run out of stock;
* orders placed at the same moment by a new number sharing one customer, and a number blocked by
  two requests at once getting one entry;
* a customer's delivery history across a completed, a delivered, a refused, a cancelled and a new
  order;
* risk scores from a customer's refusals (counted from when the parcel starts coming back),
  deliveries and a possible duplicate, with holds at the shop's threshold, and an address change
  that holds an order only when it makes the order risky;
* merging a customer's second SIM into their profile, after which that number's orders and
  refusals are theirs; erasure refused while an order is open, then orders kept for the accounts
  without the customer's details; consent-ledger functions that stay in the caller's shop;
* migrations run on a database with data in it, which the empty test databases cannot show;
* bulk actions that change each order on its own, name each one that could not change and why,
  count an ID given twice once, and leave another shop's orders as they were;
* packing slips and invoices page by page, as a reader sees them, in English and Urdu, with what
  people typed escaped, numbers masked for packers, and an erased customer's details left off;
* refunds up to what was paid, a completed order that stays completed after one, spending net of
  refunds, a confirmation agent refused where a manager may refund, and refund notes cleared on
  erasure;
* idempotency keys: an order placed once however often it is retried, a key reused for another
  request or by another caller, a key held while its request runs and freed if it dies, and
  answers forgotten after a day;
* order exports cell by cell, with times in the shop's time zone, numbers masked for an
  accountant, the list's filters, a row per line item, and more than 10,000 orders refused;
* draft orders at the prices agreed, whatever the catalog says later, placed once however often
  they are completed or confirmed; links replaced, expired, or dropped when their draft can no
  longer be confirmed; a confirmation from a page that is out of date shown the change instead; a
  blocked number's confirmation held for review, and an item that sold out named to the customer;
  the link's page through the API, with its headers, escaping and masked number; a draft sent
  before its address, filled in by the customer with their number, corrected, then its order
  corrected through the same link until packed; and drafts gone with their customer's erasure;
* storefront pages from Hatti Base: sections in their template's order, products fetched a chunk
  at a time, pagination, Urdu right to left, 404s, a section over each limit left out while the
  page renders, and templates that reach nothing of JavaScript or of files outside the theme; the
  head sent while the sections wait for their data, the streamed page the same as the whole one,
  and the layout's wait for its sections not counted against its time;
* storefront documents: a new shop published whole, drafts left out; a new handle, stock, a
  location starting to sell online, a new sort order, and products leaving listings, each
  reaching the storefront through its events; `/collections/all` given to a collection with that
  handle and back; lost documents rebuilt and stray ones taken off; products swapping handles;
  a failed batch put back, a stalled publisher's taken over, and its writes refused; the same
  pages rendered from Valkey as from memory, in as many round trips; each shop served at its
  handle's subdomain and nothing at hosts no shop has; a suspended shop taken out of the
  directory and put back; and a shop whose documents are of an older shape published again; the
  edge told to forget the pages of what changed and only those, nothing for stock that leaves a
  product for sale, a product's listings with it, its old handle and its new, and the whole shop
  for its settings, the documents written whether or not the edge answers; and on the storefront,
  pages sent to be kept five minutes and tagged with what they name, search a minute, and a
  shopper's cart never;
* shop handles: given to shops made before them, checked as DNS labels, unique, and beyond
  request code, which may only rename its shop;
* themes: the main theme made once however many ask for it at once; files saved all or none,
  their JSON checked and what is wrong said; files read over Hatti Base as the storefront reads
  them, sections, blocks and settings it lacks, blocks over their limit and settings not of their
  type refused and said, and Hatti Base's own files passing; a copy prepared, published in place of the main
  theme and the one before deleted; scopes, and other shops' themes, refused through the API;
  the main theme published before the shop's document that names it, after each change and
  each publishing; a shop's own templates, section groups and settings rendered over Hatti
  Base, a file the storefront cannot use left out, and the next version shown once published;
  each version laid over the platform theme once, however many pages ask at once, and kept
  within a size; and settings held to their types, and IDs to letters, digits, `_` and `-`, so
  nothing a shop saves ends a style or an attribute;
* theme previews: a link to a theme, published or not, at the shop's subdomain for 14 days, its
  files as saved when asked for; nothing for another shop's storefront, an ended link, an altered
  token or a deleted theme, and links sealed before a key rotation still open; the route
  storefronts fetch it from, with their key alone; and on the storefront, the theme on every
  page, section and search after the link, kept by a cookie until the link or the bar ends it,
  uncached and unindexed, with its bar in the page's language, and not sent on to the primary
  domain, while other shoppers see the main theme;
* the theme editor's protocol: design mode only for a preview the editor frames, with its
  origins set, each section marked with the file and key its settings are under and each block
  with its ID, and `request.design_mode` for themes; framing by the editor alone; the preview's
  cookie the frame's own there; sections rendered again with unsaved files over the saved ones,
  a file the storefront cannot use said while the saved one stands, and nothing rendered but for
  the editor's script in a preview; and in Chromium, a stand-in editor on another origin choosing
  and changing a block, a tap in the page choosing a section, the cart drawer open while chosen,
  and a link in the frame still the preview in design mode;
* search engines and link previews: each page's canonical address at the shop's own, in its
  language, a page of a listing keeping its page; its address in both languages beside it, but
  for a page not found; the preview's image and address absolute; a product's structured data,
  an offer for each variant in rupees; a `</script>` in a shop's text kept from ending the page's
  scripts; robots.txt, and rules of the shop's own in it, directives kept in their usual case,
  lines crawlers would not read said by their number, rules for every crawler joining the
  platform's group, and the shop's groups and sitemaps after; and the sitemaps' index and every
  product, collection and page, the home page first, each with its Urdu address, from memory and
  from Valkey, at the shop's address;
* URL redirects: paths kept as the storefront looks them up however they are typed or pasted,
  one redirect a path; the home page, a target back to its own path, control characters and
  halves of characters refused; 20,000 a shop at most; changes recorded, and none when nothing
  changed; scopes, and other shops' redirects, refused through the API; the hash in Valkey
  written by what changed, 500 at a time, and put right by a full build; and on the storefront, a
  301 only where the page would be 404, in the shopper's language with their query, kept at the
  edge by the path's tag, which the publisher purges, or the shop's past 25 paths; followed in a
  preview, not in the theme editor's frame; a page's old address redirected with its change, and
  a product's and collection's by the worker, to where it is now however late or out of order
  the events come, others that pointed at the old address following it, one from the new address
  gone and one back at an old address freed; none asked for, none written; and live, a renamed
  product's old address, in English and Urdu, sent to the new one; a Shopify redirects export
  imported after a dry run that counted the same, each row checked as one redirect is, paths
  repeated in the file or the shop's already said or skipped, one event for the lot and the same
  file again making nothing, its export taken back by another shop, and files that are not
  redirects or too many for a shop refused; and live, an imported redirect followed at once;
* menus: the main and footer menus made once however many ask at once, from what the storefront
  showed; menus three levels deep of links to collections, products and addresses, saved whole,
  their items' IDs kept; what is wrong said, and an address that could end an attribute refused;
  links following handles, and left out of the storefront when what they lead to is gone or not
  active; a deleted menu gone from the storefront; scopes, and other shops' menus and
  collections, refused through the API;
* pages: handles from titles as the catalog makes them, given ones made the same way and kept to
  one page; bodies cleaned of scripts, handlers, frames, forms, style sheets, IDs, classes and
  `javascript:` links however written, while text, links, images, tables and alignment stay, and
  cleaning twice changing nothing; what is wrong said; changes recorded, naming the fields, and
  none when nothing changed; published pages on the storefront at their handle, hidden and
  deleted ones taken off, in the template they name when the theme has it; `pages` by handle in
  Liquid; menus' links following pages' handles; scopes, and other shops' pages, refused;
* policies: one of each kind a shop, cleaned as pages' bodies are, blank ones and ones of nothing
  but empty tags taken away, the same body again changing nothing, each change recorded, and the
  legal policies scopes; drafts of each in English and Urdu from the shop's name, WhatsApp
  number, delivery charges and zones, what the shop typed kept to text, and nothing saved; a
  change rebuilding the policies and the shop's document, which lists them, their bodies apart;
  and on the storefront, each at its Shopify address in Shopify's markup and in Urdu, 404 for one
  the shop has not set, and the footer listing them in the page's language; and live, drafts
  saved through the API and followed from the footer in Chromium, in English and Urdu;
* storefront preferences: a shop's WhatsApp number kept in E.164 however it is written, only a
  Pakistani mobile taken, each change recorded and published, and taken away when blank;
* storefront passwords: none closed without a password, which is kept sealed for its shop alone
  and changed but never taken away, the same one keeping its verifier; a verifier checking a
  password however it is spaced or composed, and nothing for a verifier not made by the core; and
  on the storefront, pages sent to the password page in their language, scripts, sections and
  sitemaps refused and robots.txt shut; the theme's password page with the shop's message, a
  wrong password said, the right one leaving a pass that a new password undoes and a forged one
  cannot stand in for; nothing of a closed shop kept at the edge, even for those with the pass;
  staff through a preview; ten tries a minute from an address; and in Chromium, a shopper sent
  from a product to the password page, refused, then let in;
* carts: lines added to by variant and properties, changed by key, variant or place, updated as
  the cart was and cleared as Shopify's are; priced as the catalog prices them now, a product
  taken off sale left out; more than the online stock refused, while a line whose stock ran out
  can go down; a secret kept only as its digest, never taken up once it names no cart, and
  nothing for another shop; ten changes at once to one cart taking turns; and the routes
  answering only the storefront key, through the client storefronts use. On the storefront:
  Shopify's cart forms and Ajax calls, `items[][id]` and `updates[]` among them, reaching the
  core as its actions; the cart page in English and Urdu, what the shopper typed escaped and the
  shop's own properties hidden; refusals said in the page's language; the cart's cookies set,
  and dropped once the core no longer has the cart; changes from other sites refused, and more
  than 120 a minute from an address; and the core being down said as such; the sections a change
  asks for, and a page's, rendered with the shopper's cart as part of the page that asked, and
  never kept; and Hatti Base's drawer on every page, empty, unless the theme sends shoppers to
  the cart page;
* delivery charges: the city's zone, else everywhere's, and nothing from the free subtotal;
  cities as addresses write them, each in one zone, and what is wrong said; each change recorded
  and published in the shop's document, which product and cart pages show; and the settings
  scopes;
* checkout: started for a cart with something to order, by a secret of which only the digest is
  kept, and shown only to its own shop's storefront; the page's cart, charges and form in both
  languages, what the shopper typed kept and what is wrong said beside each box, escaped; an
  order placed as the page showed it, cash on delivery with the city's charge and committed
  stock, lines' properties in its note, held for review from a blocked number, and the cart
  emptied; nothing placed when the cart or charges changed or something sold out; one order
  however many posts or checkouts; a day's life, swept by later checkouts, and nothing shown for
  closed shops; the shop's policies linked at the foot of the page and of its thank-you page, in
  Shopify's order and both languages, each opening beside the checkout; and on the storefront,
  the cart form's checkout button, `/checkout`, the page on the shop's address and the cart's
  count reset once the order is placed;
* e-contract logs: every body a policy is saved with kept as a version, the same body again
  none, and one taken away leaving its versions, which request code can neither change nor
  delete, and another shop cannot read; policies kept before made their first versions by the
  migration; the checkout's page saying what placing the order agrees to, each policy linked but
  the contact information, in both languages; nothing placed when a policy changed while the
  page was open, and the next order agreeing to the new version; the order keeping the
  versions, the address, if it is one, and the browser's name without control characters, cut
  short, which storefronts pass on; both shown only to those who see numbers whole, and cleared
  by erasure while the versions stay; through the Admin API, the policies as they were after
  they changed; and live, an order placed in Chromium keeping its address, browser and policies
  after the refund policy changed;
* the cash-on-delivery cap: orders and drafts refused when they would collect more than
  Rs 200,000 at the door, saying the advance that would do, and placed with that advance, or
  prepaid; the cap exactly allowed; orders in other currencies not the law's; and checkout
  saying so without its form for a cart past it, and when delivery takes one past it, placing
  nothing;
* products from a Shopify export: rows grouped by handle into products with their options and
  variants, Title / Default Title a product without options, Status or Published its state,
  Body (HTML) the text of its description, images by position, then variants' own, and stock
  where Shopify tracked it, never below nothing; gift cards, untitled products and images not at
  https addresses said by row and column and left out; files that are not product exports,
  unreadable or too long refused; the products made keeping their handles, with their prices,
  compare-at prices, costs, weights and images; what the catalog would refuse said at the
  variant's row and column while the rest went in; nothing made in a dry run, which counts the
  same; the same file again skipping every product; and through the API, the stock set on hand
  at the primary location, selling on where Shopify did, and the products and inventory scopes
  both needed; and live, 300 products with 900 variants made in six seconds;
* the admin's home: orders waiting to be confirmed, reviewed, packed and booked, and parcels
  coming back, each counted with what they come to; the cash still to come on parcels on their
  way, on delivered orders not yet paid and on the rest of an advance, but none on prepaid
  orders or paid ones; nothing of another shop's; and through the API, orders placed counted at
  once in rupees, and a token without the orders scope refused;
* COD health: a period's cash-on-delivery orders confirmed, cancelled first and waiting, an
  order confirmed then cancelled still confirmed, and their parcels delivered, refused and on
  their way, prepaid orders left out; by city, a place typed two ways counted once under the
  spelling most orders have; by product, an order with two counted for each; by source; and by
  courier, parcels alone, the names however typed; most orders first, as many rows as asked; a
  period of more than a year refused; nothing of another shop's or another period's; and through
  the API, rates of those that turned out, none while nothing has, products by their IDs and
  sources by `OrderSource`;
* sales reports: a period's orders day by day in Karachi time, an order placed at 01:30 on the
  shop's day though UTC has it the day before, days without orders there, cancelled orders left
  out, a refused parcel's items as returns on its order's day; weeks from Monday and months; net
  sales and average order value worked out from the totals; the products that sold most, as many
  as asked; a period of more than a year refused, and nothing of another shop's; and through the
  API, amounts in rupees and no average without orders;
* discount codes: a percentage, an amount or free delivery, with a minimum, dates, a limit and
  one use a customer; codes as shoppers type them, and in any letter case one to a shop, though
  another shop may have the same; a percentage to two decimals at most, rounded half up to the
  paisa, an amount never more than the items, and two things in one code refused; changes that
  leave the rest, clear what is null and keep the end after the start; the newest first, a page
  at a time, found by code or title; 10,000 a shop; and through the API, Shopify's discount
  scopes, which owners, managers and marketers have, and a line saying what each code gives;
* discount codes at checkout: a code typed in any letter case kept with the cart and shown with
  what it takes off, a free-delivery code making delivery free wherever it goes, and the order
  placed with it, its use counted and kept with the order's customer; refusals by its field in
  both languages, kept out of the cart: unknown, not yet started, ended, under its minimum, used
  up; ten refused, then no more codes on that page; a code used up between the page and the
  order, shown again without it; a customer's second order with a once-a-customer code undone,
  and placed once the code is taken off; merges moving uses; and through the core's page, a code
  applied and the order in the Admin API with its code;
* search: a shop's active products with every word typed, however it is spelt, matches in
  titles first, for storefronts with the key alone, and nothing of other shops'; a word still
  being typed found by its start; and on the storefront, the search page a page at a time, its
  links keeping the words, what was typed escaped, and the core being down said as such;
  suggestions as Shopify's predictive search gives them, as JSON and in the theme's section
  rendered alone, those that cannot be bought last, left out or where they fall; and 240
  searches a minute from an address, suggestions among them;
* domains: read as DNS has them however typed, internationalised ones in their `xn--` form, and
  one shop's on the platform, which another cannot take, though it sees none of the first's;
  never the platform's own, its subdomains or the DNS target; ten a shop; verified by a CNAME
  naming the target, or at an apex by the target's own addresses, and what DNS answered said
  otherwise, or that it could not be asked; one primary at a time, only once verified; changes
  recorded once each; the shop's address in the API following the primary one; the directory
  keeping only verified domains, and letting go of those a shop lets go; and the storefront
  answering at them and sending pages at its other addresses on to the primary one, unrendered,
  while the cart stays where it is;
* orders' links: a customer confirming the order as the page showed it, while notes and tags
  change nothing for them; cancelling after a question, with the stock released; told to ask the
  shop once the order moved on; a new address saved as the customer typed it, or said back to
  them with what is wrong, their number kept and the order scored again, until the order is
  packed; a page that follows the order to delivery, with the tracking link, until 30 days
  after the order ends however long it was open, and asks the customer to keep it; and
  nothing shown once the link expired or the customer's details were erased;
* numbers masked for each staff role, a confirmation agent revealing one through the API and a
  packer refused, with the reveal in the audit log, which request code cannot change, and masked
  roles limited to whole-number searches;
* segment queries over every field type, including days counted in Pakistan time, customers with
  no orders under `NOT`, and error messages that point at the mistake;
* a consent ledger that request code cannot change or delete, and consent that starts again when
  a number or email changes;
* importing Shopify's customer export with the problems real files have, and a Hatti export that
  imports into another shop unchanged;
* parcels through every path, including an order split into a delivered parcel and a refused one,
  with stock and stage checked at each step;
* smart collections that follow product, variant and rule changes, and pages in every sort order;
* a migration that gives products created before options a "Title" option;
* concurrent relays that never publish an event twice, and a bad event that must not block other
  shops' events;
* refresh-token reuse detection and one-time TOTP codes;
* database role boundaries around identity data;
* a committed GraphQL schema snapshot, and every enum of the orders' API holding each value the
  database can, with an order from checkout read back through the Admin API.

One test starts the built API exactly as production does and checks the exported spans, so a
dependency upgrade cannot silently break tracing. CI runs everything against Postgres 17 and
Valkey 8, through PgBouncer 1.22. The suite also runs locally against Postgres 16, directly and
through PgBouncer.

`tools/db-bench` (`pnpm bench:db`) is the spike 5 benchmark. It loads 1,000 shops and runs
pgbench, the application's own code and leak checks, directly and through PgBouncer.
`pnpm bench:storefront` is spike 1's: it renders Hatti Base's pages from a sample shop of 201
products, and `pnpm dev:storefront` serves them at `http://localhost:4100/`, and each published
shop at `http://{handle}.localhost:4100/`.

A manual run on 2026-09-27 went through setup, migrate, seed, starting the API and the worker, and
querying with a Roman Urdu search. A product created through the API reached the worker **3 ms**
after the request finished. Both processes shut down cleanly on SIGTERM. On 2026-09-28 migration
0005 went onto the development database, the seed stocked two locations, and the running API
reported each variant's stock and whether it can be sold online. Later that day migrations 0006
and 0007 went on, and the seed's seven orders came back through the API at every stage, from
waiting for confirmation to delivered and paid, and a refused parcel checked back in. Then 0008
and 0009 gave the development database's orders their customers, and a new seed's nine orders
came back with eight customers, their delivery history, and an order from a blocked number
waiting for review with the reason on its timeline. Migration 0010 went on next, and the seed's
four segments and a preview came back through the API with the customers they should have.
With 0011, the seed's customers came back with their consent, its history, and a segment of
WhatsApp subscribers. With 0012, the seed's ten orders came back scored through the API, and the
large order of the customer who refused a parcel was waiting for review at risk 0.70, with its
three reasons on its timeline; the shop's policy changed and came back through the API. Migration
0013 first failed on the development database, whose customers made the backfill leave checks
pending (the empty test databases had passed); fixed, and a migration test now runs it over data.
The seed's customer found by her second SIM came back with both numbers and her three orders, and
a customer erased through the API left their completed order with its total, stage, city and
province, and an `erased` timeline entry. With 0014, a number revealed through the API came back
in the shop's audit log, naming the access token that asked. On 2026-09-29, 0015 moved the
development database's 25 confirmed orders to To pack. The seed's packed order came back under
To book, and bulk confirm, pack and tag through the API changed the orders they could and named
the cancelled and the shipped order they could not. Packing slips and invoices for the seed's
orders came back through the API on A4, 4×6 labels and an 80 mm roll, in English, Urdu and both,
and were checked in Chromium with their fonts. That check found Urdu headings aligned to the
wrong side of their columns and Urdu line spacing that pushed a 4×6 slip onto a second label,
both fixed. With 0016, the seed's completed order from Peshawar came back through the API still
completed and closed, partially refunded, with its customer's spending net of the refund, the
refund in the audit log, and the refund beside what was paid on its invoice. With 0017, an order
placed through the API without an idempotency key was refused, and placed once with one: the
retry got the same order back, marked as replayed. The seed shop's orders then exported through
the API, with Karachi times and whole numbers for the app that asked. With 0018, the seed's four
draft orders came back through the API: one waiting for its address, one confirmed through its
link, one placed after a bank transfer, and one whose printed link was opened in Chromium at
phone width, in light and dark. Confirming it there placed order #1014, confirmed and to pack.
That check found an Urdu sentence that moved a date's day to its far end, and an Urdu label
split across two lines; both fixed. With 0019, the seed's first order came with a link. Opened in
Chromium at phone width, it asked before cancelling, and confirming it there left order #1001
confirmed and to pack, with "Confirmed by the customer through their link" on its timeline after
the app's "Made a link for the customer". That check found a form
posted without its action when submitted without its button; the action moved into a hidden
field. With 0020, the seed's first draft went out before its address. Opened in Chromium at
phone width, its page asked for the address and number; confirming then placed order #1014,
confirmed and to pack, and the same link opened the order's address form, the number masked.
Later that day the seed published its shop's storefront, served from Valkey in Chromium at phone
width: its menu led to its two collections and all products, Footwear listed by price, and the
draft shawl answered 404. With the worker running, a product renamed through the API showed on
the storefront about 220 ms later, with its new description in paragraphs, and the worker first
published 19 older development shops from their waiting events. That check found a page's
section styles ordered by which section finished first, so a page could differ from one render
to the next; they now come in the order sections start. With 0021, the development database's
shops got handles. The seed's new shop answered at its subdomain, in curl and in Chromium at
phone width, with its five active products under all products; the sample shop stayed at
`localhost`, and a handle no shop has answered 404. An older shop, published before handles,
answered at its new one once a product edit through the API had the worker publish it again.

## Deliberate simplifications

Each item below is smaller than the target architecture on purpose, and each has a trigger for
revisiting it.

| # | Now | Target (architecture docs) | Revisit when |
|---|---|---|---|
| 1 | Outbox is one table, with a partial index on unpublished rows | Daily range partitions, dropped after 7 days | Before launch, or above about 1M events a day |
| 2 | `control.shops` lives in the application database | A control-plane database, replicated read-only into cells | When the control-plane service is built (MVP) |
| 3 | Product and order searches, the storefront's too, use `LIKE` over a normalised `search_text` column, which no index serves: a storefront search reads all of a shop's active products (25 to 30 ms for 100,000), and has no typo tolerance past folding, no facets or synonyms, and finds products only, with no suggested queries; an address may search 240 times a minute, suggestions included, however many shoppers share it ([ADR-046](../architecture/13-decision-log.md#adr-046--storefront-search-asks-the-core-which-finds-products-in-postgres-as-the-admins-search-does-until-typesense)) | Typesense with per-shop scoped keys: typo tolerance, facets (SRC-03), synonyms and merchandising (SRC-04), pages and articles in results | Facets and typo tolerance (V1), or a shop above about 100,000 products, for which a trigram index would come first |
| 4 | Every API request looks up its token in Postgres | Short-lived cache with revocation fan-out | When token lookups show up in latency profiles |
| 5 | The worker wires handlers, and the module services the storefront publisher reads through, by hand, without NestJS DI | A NestJS application context shared with the API modules | When a second consumer needs module services (search indexing, webhooks) |
| 6 | One BullMQ queue for all domain events | Separate queues and worker pools (`critical`, `integrations`, `messaging`, `bulk`, `indexing`) | When a second real consumer arrives |
| 7 | Tests use CI service containers | Testcontainers | Only if we need versions or topologies that service containers can't provide |
| 8 | No rate limiting | Cost-based GraphQL limits per app and shop (Shopify-style leaky bucket) | Before any third-party app gets a token |
| 9 | Product images keep their source URL; nothing fetches or resizes them yet | A media worker that fetches, checks and resizes into R2 (AVIF/WebP), with signed uploads | With the infrastructure (R2), before the storefront shows images |
| 10 | `Product.collections` loads per product, so a list asking for it runs one query per product | Batched loading per request, as stock fields already do (`@Loaders()`) | When an admin screen lists collections beside products |
| 11 | Stock holds (`reserved`) have no expiry of their own | Checkout holds that lapse after 15–30 minutes, released by a sweeper | With checkout, which owns its holds and calls `releaseReservation` |
| 12 | The first location stays primary; no transfers, purchase orders or low-stock alerts; history lives in one table | A primary chosen in settings; transfers (INV-04), purchase orders (INV-05), low-stock alerts (INV-01), monthly partitions for movements | Alerts with messaging (MVP); the rest with multi-location merchants (V1), or above about 10M movements |
| 13 | A customer's order stats are worked out from their orders on every read, and a segment using order fields aggregates the shop's orders each time it runs; customers can't be sorted by those stats | A customers search index (Typesense) fed by order events, behind the same segment language ([ADR-023](../architecture/13-decision-log.md#adr-023--customer-order-stats-are-worked-out-from-orders-when-read), [ADR-024](../architecture/13-decision-log.md#adr-024--segments-are-queries-evaluated-on-demand-over-fields-modules-contribute)) | A shop above about 50k orders, or when segment counts show up in latency profiles |
| 14 | No tax lines; each order ships from one location | Sales tax (TAX-01), routing lines to locations (INV-10) | Tax in the MVP; routing with multi-location merchants |
| 15 | Order numbers come from one counter row per shop, so a shop's orders are numbered one at a time | Unchanged for normal shops; flash sales go through Drop Mode (ADR-019) | If numbering shows up as a wait in traces |
| 16 | Confirmation is recorded by staff or apps; no WhatsApp, SMS or call outcomes yet | The confirmation sequence and Confirmation Desk (COD-01, 02, 04) | With messaging (spike 3) |
| 17 | Parcels are marked shipped, delivered or refused by hand, with a free-text courier and tracking number | Couriers booked and tracked through adapters, with normalised statuses (SHP-01, 02) | Spike 2, the courier adapter SDK |
| 18 | Marking an order paid records the full amount at once; no COD remittance matching | Remittance statements reconciled against expected cash, per parcel (COD-10) | With courier integrations |
| 19 | A delivered parcel cannot come back yet | Customer returns and exchanges (ORD-07) | V1 |
| 20 | The blocklist and the risk rules hold orders for review; nothing refuses an order or asks for an OTP or an advance; the rules see only this shop's history, with fixed weights | The checkout risk decision: OTP, partial advance, prepaid only or a hard block (COD-03), a model trained on delivery outcomes (COD-06, V1), and a cross-store reliability tier (COD-07, Growth) | Checkout (MVP); the model once there are outcomes to train on (V1); the network tier after legal sign-off |
| 21 | Erasure happens at once when staff or an app ask; there is no request with a waiting period, and a customer cannot get their own data as a file; imports and exports carry main numbers only; a customer's addresses are where their orders went | Erasure requests that wait and can be cancelled, a customer's data export (CUS-05), other numbers in CSV, saved addresses | Scheduled jobs in the worker; the privacy work before launch; customer accounts (CUS-02) |
| 22 | Masking follows fixed role presets, and apps see numbers whole; the audit log is one table, and records reveals, exports, merges, erasures and the risk policy only | Custom roles with a PII-visibility permission, protected customer data scopes for apps, monthly partitions kept 24 months, and every sensitive action logged ([security §2.1](../architecture/11-security-and-compliance.md#21-merchant-staff)) | Custom roles (V1); the app platform; above about 1M entries a month |
| 23 | Segment dates count days in Pakistan time for every shop; segments have no behaviour fields and nothing reacts to someone joining one | A shop time zone setting; storefront behaviour fields; automations that evaluate membership per event | A shop outside Pakistan; storefront analytics; automations (V1) |
| 24 | Consent is recorded by staff and apps; no checkout box, keyword opt-outs, push consent or email double opt-in yet | Consent at checkout and on forms, "STOP" and "band karo" replies (MSG-09), push per device, confirmed email opt-in | Checkout and the storefront (MVP); messaging (spike 3) |
| 25 | Imports and exports run inside one API request, capped at 5,000 and 10,000 customers; imports bring profiles and consent, not addresses or order history | Background jobs with files in R2 and progress; the full Shopify migration (F10) | With the infrastructure (R2) and the migration tool |
| 26 | An order's risk is scored when it is placed and when its address changes; a refusal of the customer's other orders later does not re-score open ones ([ADR-025](../architecture/13-decision-log.md#adr-025--order-risk-is-a-snapshot-taken-when-an-order-is-placed-or-re-addressed)) | Re-scoring open orders on events that change the customer's history | With the Confirmation Desk (COD-04) |
| 27 | Bulk actions run inside the request, one order after another, up to 250 | Larger batches as background jobs on the `bulk` queue, with progress | When merchants select more than 250 orders, or a batch takes more than a few seconds |
| 28 | Packing slips and invoices are HTML pages the browser prints, from fixed templates, with fonts from Google Fonts; an invoice goes by its order's number and has no tax details | PDFs from the documents service (Gotenberg) in bulk through the queue, to email or send on WhatsApp; fonts from our CDN; templates merchants can edit; FBR tax invoices in a gapless series (TAX-04, TAX-05) | With the infrastructure (Gotenberg, R2, the CDN); tax invoices with the tax module (MVP) |
| 29 | Refunds are records of money staff sent by hand: no gateway refunds, store credit, refund lines or corrections | Refunds through the payment adapters, a store-credit ledger, refund lines with customer returns (ORD-07) | Gateways with checkout (MVP); returns (V1) |
| 30 | An idempotency key is claimed and its answer kept in transactions of their own, apart from the work, so a process that dies between the work and keeping its answer lets a retry after a minute run again ([ADR-030](../architecture/13-decision-log.md#adr-030--idempotency-keys-are-kept-in-postgres-per-caller-for-a-day)) | The key written in the transaction of the work, for mutations that run in one | If duplicate orders or refunds after crashes show up in support |
| 31 | Exports run inside the request and return the CSV in the response, up to 10,000 orders; no Excel files or scheduled exports; marketers cannot export | Background exports to R2 with a download link and progress, `.xlsx`, scheduled exports by email or WhatsApp, and approvals for roles such as marketers ([security §2.1](../architecture/11-security-and-compliance.md#21-merchant-staff)) | With the infrastructure (R2) and messaging; approvals with custom roles (V1) |
| 32 | Draft orders hold no stock; staff send drafts' and orders' links by hand; a draft's link confirms a cash-on-delivery draft only; an order's link works until 30 days after the order ends, and takes a new address until the order is packed but never a new number, and a cancellation only while the order waits for its customer; the core API serves the pages, without a rate limit of their own ([ADR-031](../architecture/13-decision-log.md#adr-031--draft-orders-keep-agreed-prices-and-hold-no-stock-customers-confirm-them-through-a-secret-link), [ADR-032](../architecture/13-decision-log.md#adr-032--customers-confirm-or-cancel-cash-on-delivery-orders-through-a-link-that-then-follows-the-order), [ADR-033](../architecture/13-decision-log.md#adr-033--customers-correct-an-orders-address-through-its-link-until-it-is-packed-the-number-stays-the-shops)) | Reservations with an expiry as an option, links sent by the confirmation sequence (WhatsApp, then SMS), payment links (PAY-04), cancellation within a window the merchant sets, and pages served by the storefront under the shop's domain | Messaging (spike 3); gateways and checkout (spike 4, MVP); the storefront |
| 33 | The storefront serves each shop at its handle's subdomain and at its verified domains, in its main theme: no edge in front of it, certificates for shops' domains, theme editor or `.liquid` templates, and a subset of Dawn's sections; handles come from the seed, and a shop's status reaches the directory only when it is next published; a domain is checked only when the shop asks, and one that stops pointing at the platform stays connected; domains are the application database's, not the control plane's ([ADR-035](../architecture/13-decision-log.md#adr-035--the-storefront-renders-liquid-with-limits-of-its-own-fetching-lists-a-chunk-at-a-time), [ADR-037](../architecture/13-decision-log.md#adr-037--every-shop-has-a-handle-naming-its-storefront-on-the-platforms-domain-storefronts-find-shops-through-a-directory-in-valkey), [ADR-048](../architecture/13-decision-log.md#adr-048--a-shops-own-domains-are-the-online-stores-one-shops-each-served-once-dns-points-them-at-the-platform-the-primary-one-where-pages-send-shoppers)) | Shops' domains as Cloudflare for SaaS custom hostnames, with their certificates, looked up at the edge and checked again in the background; handles chosen at sign-up; the edge (Cloudflare) keeping pages per theme version and locale, its cache key rules and tiering, the editor's protocol, theme blocks | The control plane; the storefront (MVP) |
| 34 | A listing is one document with all its products' IDs, read whole for each page of it; an edit that can change listings rebuilds all the shop's smart collections; no translations, facets or COD fee in the documents; items whose publisher ran out of retries wait for the shop's next event ([ADR-036](../architecture/13-decision-log.md#adr-036--one-publisher-per-shop-rebuilds-storefront-documents-from-the-database-its-writes-fenced-by-its-lock)) | Listings per sort order read a page at a time, with facets; smart collections re-checked for what changed; shop settings merchants edit; translations; a sweeper for shops with items waiting | A collection above about 5,000 products; the storefront (MVP) |
| 35 | A theme keeps only the shop's JSON files, and a change replaces the file before it: no versions to roll back to, scheduled publishing or Liquid from shops, and Theme Check reads only JSON files; every theme is on Hatti Base; a preview shows a theme as saved, through a link that lasts 14 days and cannot be taken back but by deleting the theme, and costs a round trip to the core per page; the editor's frame renders sections again one at a time with unsaved settings, while adding, moving or removing sections and the layout's settings show once saved, and design mode needs HTTPS or `localhost` ([ADR-039](../architecture/13-decision-log.md#adr-039--a-shops-theme-is-a-platform-theme-with-the-shops-own-json-files-over-it), [ADR-049](../architecture/13-decision-log.md#adr-049--a-theme-is-previewed-through-a-link-the-core-seals-which-storefronts-keep-in-a-cookie-and-render-from-the-cores-files-never-kept), [ADR-050](../architecture/13-decision-log.md#adr-050--the-theme-editor-talks-to-its-preview-through-postmessage-a-framed-preview-is-in-design-mode-and-renders-sections-with-the-editors-unsaved-files)) | Immutable theme versions with rollback and scheduled publishing (OS-03), the editor's screens (OS-02) with sections added, moved and removed in the frame, links that can be taken back, the code editor with Theme Check for Liquid and performance (OS-04), the free theme line-up (04 §3.5) | The visual editor (MVP); the code editor (V1); a second platform theme |
| 36 | Menus link to the home page, all products, collections, products, pages and addresses: no blogs, search, policies or tags on links; Hatti Base shows a menu's first level; saving a menu replaces it, the last save standing ([ADR-040](../architecture/13-decision-log.md#adr-040--a-shops-menus-are-kept-whole-linking-to-collections-and-products-by-id)) | Blogs (OS-07), search, links that filter a collection by tag, nested menus in Hatti Base (a drawer on phones), and edits that cannot overwrite each other | Blogs (V1); the theme editor |
| 37 | A shop's storefront preferences are its WhatsApp number, a Pakistani mobile that nothing checks is on WhatsApp, and its password ([ADR-041](../architecture/13-decision-log.md#adr-041--what-a-shop-sets-for-its-storefront-as-a-whole-is-the-online-stores-starting-with-its-whatsapp-number)) | The storefront's title, description and social image; numbers from other countries; the number the shop connects through WhatsApp's API (MSG-02) | Onboarding (ONB-10); messaging (spike 3) |
| 38 | Carts are priced at their variants' prices, less what their discount code takes off, with no delivery or COD fee before checkout; the core deletes expired carts as a shop gets new ones rather than on a schedule; one storefront key serves the platform; the Ajax cart takes no multipart forms ([ADR-042](../architecture/13-decision-log.md#adr-042--carts-are-kept-by-the-core-and-priced-whenever-they-are-read-storefronts-change-them-with-a-key-of-their-own)) | The pricing pipeline (05 §3) on every read; a sweeper job; keys per storefront pool, rotated; multipart forms | Checkout (MVP); the infrastructure; the theme editor's protocol |
| 39 | Delivery costs one charge for everywhere, a charge per zone of known cities, or nothing from a subtotal: no rates by weight or value, couriers' rates, local delivery or pickup; cash on delivery has no fee yet ([ADR-043](../architecture/13-decision-log.md#adr-043--a-shop-charges-for-delivery-once-for-everywhere-by-zones-of-cities-and-not-at-all-from-a-subtotal)) | Shipping profiles with rates by weight or value (CHK-04), couriers' rates, local delivery and pickup; the COD fee (CHK-08) | The COD fee with checkout (MVP); the rest in V1 |
| 40 | Checkout takes cash on delivery alone, with no OTP, COD rules or fee; it holds no stock while the shopper types and keeps nothing they typed until the order has it; with zones, it shows the shop's charges by city until a city is typed, since the page has no scripts; it cannot be branded, and its links go to the shop's platform subdomain; lines' properties go in the order's note ([ADR-044](../architecture/13-decision-log.md#adr-044--checkout-is-one-page-the-core-renders-and-storefronts-serve-on-the-shops-address-placing-a-cash-on-delivery-order-as-the-page-showed-it)); a cart permalink fills in nothing of the shopper's, and every one followed begins a cart and a checkout, link previews' included ([ADR-065](../architecture/13-decision-log.md#adr-065--a-cart-permalink-begins-a-cart-of-its-own-and-goes-to-its-checkout-leaving-the-shoppers-cart-as-it-is)) | The OTP (CHK-09), COD rules and fee (CHK-07, CHK-08), online payment (PAY-01), reserving stock during drops, capturing abandoned checkouts (CHK-12), a script that shows the total as the city is typed, branding (CHK-14), custom domains, properties on orders' lines, and a permalink's details filled in, as Shopify's `checkout[shipping_address]` | The COD rules and fee next; the OTP with messaging (spike 3); the rest in the MVP |
| 41 | A page's body keeps text, its formatting, links, images and tables, and nothing that runs, frames or posts: no maps, videos or forms in pages; a page is shown or hidden now, not at a time set ahead; pages are in one language ([ADR-045](../architecture/13-decision-log.md#adr-045--a-shops-pages-keep-html-cleaned-of-anything-that-runs-when-saved-the-storefront-shows-it-as-it-is)) | Maps, videos and contact forms as the theme's sections (OS-08), scheduled publishing (OS-03), translations | With the theme editor, forms and translations |
| 42 | Sitemaps list addresses alone, with no `lastmod` or images, and a new product reaches them within an hour; a shop adds lines to `robots.txt` but cannot take the platform's away; structured data covers products alone ([ADR-051](../architecture/13-decision-log.md#adr-051--search-engines-and-link-previews-are-told-each-pages-address-at-the-shops-own-in-each-language-and-find-pages-through-sitemaps-of-the-storefronts-documents), [ADR-055](../architecture/13-decision-log.md#adr-055--a-shop-adds-rules-to-its-robotstxt-as-lines-crawlers-read-checked-when-saved-never-liquid)) | Image sitemaps; breadcrumbs, `Organization` and `WebSite` data; the SEO toolkit's screens, with a robots.txt tester | The SEO toolkit's screens (MVP) |
| 43 | A redirect's path has no query, so `/collections/all?page=2` goes where `/collections/all` does; chains are followed a hop at a time, and loops are not refused; redirects come through the API one at a time or a file at once, 20,000 a shop at most, and reach the storefront through the worker; a handle changed redirects only when the change asks, and a product's or collection's a moment after it ([ADR-052](../architecture/13-decision-log.md#adr-052--a-shops-url-redirects-are-the-online-stores-and-the-storefront-follows-one-only-where-it-has-no-page)) | The SEO toolkit's screens over the API's import and export; a warning for chains and loops | The SEO toolkit's screens (MVP) |
| 44 | A closed shop's pages are rendered for every visit, nothing kept at the edge; one password for everyone, and a pass lasts a month or until it changes; new shops are open until their staff close them; while closed, nothing can be ordered on the storefront ([ADR-054](../architecture/13-decision-log.md#adr-054--a-shops-storefront-can-be-closed-behind-a-password-which-the-storefront-checks-against-a-verifier-in-the-shops-document)) | Shops closed at sign-up by the control plane, as Shopify's are until they choose a plan; the admin's screen for the password; a maintenance message for an open shop | The control plane (ONB); the admin app |
| 45 | A policy is in one language, whichever the page's, and a shop's policies are its own to write: the drafts cover Pakistan's usual cash-on-delivery terms and are not legal advice; checkout links them in a new tab; a new shop has none until it saves some ([ADR-056](../architecture/13-decision-log.md#adr-056--a-shops-policies-are-kept-as-shopify-keeps-them-shown-in-shopifys-markup-and-drafted-from-what-the-shop-has-set-never-saved-by-themselves)) | Policies translated with the rest of the storefront; the admin's screens, with the drafts offered in onboarding | Onboarding with the admin app (MVP) |
| 46 | Only orders placed through checkout keep what their customer agreed to: drafts confirmed through their links and orders from staff and apps keep none; assent is the sentence beside the button, not a box ticked; the address is the one the storefront sees, the edge's own once there is one, until the storefront trusts the address the edge forwards; versions are kept as long as the shop ([ADR-057](../architecture/13-decision-log.md#adr-057--what-a-shopper-agrees-to-in-placing-an-order-is-kept-with-it-the-versions-of-the-shops-policies-its-checkout-linked-and-where-it-was-placed-from)) | Drafts' links saying what confirming agrees to; the edge's forwarded address trusted, for this and rate limits; a box to tick if the law comes to ask for one | Drafts' links with the next change to them; the edge with the infrastructure |
| 47 | The cap binds the cash collected on orders in rupees, and is the orders module's constant, changed with the law; a shopper whose cart is past it cannot check out until online payment exists, and the cart page does not say so before checkout ([ADR-058](../architecture/13-decision-log.md#adr-058--no-order-collects-more-cash-on-delivery-than-the-law-allows-whoever-places-it-the-rest-is-paid-in-advance-or-the-order-is-not-placed)) | Online payment for the rest (PAY-01), or an advance taken at checkout; the cart page saying so | Online payment (MVP) |
| 48 | An import runs in its request, about two seconds a hundred products, and makes only products: Shopify's collections, SEO titles and descriptions, metafields and gift cards are not in it, and redirects come in a file of their own; images stay at Shopify's addresses until the media worker copies them; a product imported again is left as it was, and every variant's stock goes to the primary location ([ADR-059](../architecture/13-decision-log.md#adr-059--a-shopify-product-export-is-imported-product-by-product-as-productcreate-makes-them-keeping-their-handles-the-core-sets-the-stock)) | Imports in the background with progress, from the admin's screen; the media worker; updating products from a newer export | With the admin app and the media worker (MVP) |
| 49 | The home counts orders alone: no low stock, payouts, today's sales or setup checklist yet; every role sees the same tallies, and the cash still to come is what the orders say, not what couriers have reported collecting; counts are worked out each time the home is asked for | Low stock, payouts and today's sales beside them, each from its module; tallies filtered by role; the cash couriers report, from their settlements | With the admin app, courier settlements and analytics (MVP) |
| 50 | COD health is worked out from the orders in Postgres each time it is asked for, a year at most: a year of 57,000 orders takes up to half a second, and no index covers when orders were placed; couriers are the names staff typed, and there are no rescue rates, delivery times or failed attempts, which need couriers' tracking ([ADR-060](../architecture/13-decision-log.md#adr-060--cod-health-follows-a-periods-cash-on-delivery-orders-worked-out-from-them-when-asked-its-rates-of-those-that-turned-out)) | ClickHouse's `orders_fact` and `shipments_fact` (ADR-014); couriers from their bookings; rescue rate and days to deliver (06 §11) | ClickHouse with V1; courier booking (SHP-01) |
| 51 | Sales reports are worked out from the orders in Postgres each time, a year at most, about 0.4 seconds for a year of 54,000 orders; there are no taxes, sessions, conversion or live view, no comparison with the period before, and refunds are not taken off ([ADR-061](../architecture/13-decision-log.md#adr-061--sales-are-reported-in-shopifys-terms-from-the-orders-when-asked-an-order-counts-on-the-day-it-was-placed-cancelled-ones-aside-and-so-do-its-items-that-came-back)) | ClickHouse, with the storefront's events for sessions and conversion; taxes with TAX-01; refunds in the finance reports | ClickHouse and storefront events with V1; TAX-01 |
| 52 | A discount code applies to a whole order, one at a time: no codes for some products, collections or customers, no automatic discounts, and no combining; a code's status is by its dates alone; a cancelled order's use stays counted; staff's orders and drafts take amounts, not codes ([ADR-062](../architecture/13-decision-log.md#adr-062--discount-codes-are-the-pricing-modules-a-percentage-or-an-amount-off-an-orders-items-or-free-delivery-matched-in-any-letter-case)); every discount link followed without a cart begins one, link previews' included, and codes put on carts are not among the ten checkout's page takes, the limit on cart changes bounding them ([ADR-064](../architecture/13-decision-log.md#adr-064--discount-links-keep-their-code-with-the-shoppers-cart-one-begun-for-it-if-need-be-and-a-cart-says-of-a-code-only-whether-it-applies)) | Product, collection and segment codes, automatic discounts, buy X get Y, tiers and combinations (05 §3.1) | V1's discounts |
| 53 | Couriers' statements come as CSV, not Excel files, and are matched by tracking number alone; a shortfall a courier pays in a later statement is not received, as a statement imported twice must not pay twice; tracking numbers Excel wrote as numbers (`1.23E+11`) match nothing; charges and tax are kept with each line, not posted to a ledger ([ADR-067](../architecture/13-decision-log.md#adr-067--couriers-remittance-statements-are-imported-whole-into-a-logistics-module-each-lines-cash-received-on-its-parcels-order-at-most-what-the-order-owes-and-a-parcels-cash-once)) | Excel files; couriers' APIs and their own formats where names are not enough; the ledger of fees and the tax credit report (06 §7); dispute sheets | Courier booking (spike 2); the finance reports |

## Next steps

1. **Observability, remaining:** Sentry for errors; Grafana dashboards and SLO burn-rate alerts
   (admin GraphQL p95 ≤ 500 ms, outbox lag, parked events, sign-in failures); the production
   collector with tail sampling, set up with the infrastructure.
2. **Environments and IaC:** after the latency bake-off, write Terraform/OpenTofu for one cell
   (managed Postgres, Valkey, Kubernetes), container images and a staging deploy from `main`.
3. **Spike 5 follow-ups:**
   * re-run the benchmark in the target cloud, with PgBouncer beside the API pods;
   * fold `set_config` into `BEGIN`, to save a round trip per transaction;
   * prepared statements for hot queries.
4. **Staff identity, remaining:** passkeys (`@simplewebauthn/server`), staff invitations,
   email verification and password reset once email delivery exists, and re-authentication for
   sensitive actions.
5. **Catalog and stock, remaining:** the media worker (fetch, check and resize images into R2,
   with the infrastructure), batched collection lookups for product lists, and low-stock alerts
   once messaging exists.
6. **Orders, next:** cancellation through the order's link within a window the merchant sets
   (05 §8); payment links once gateways exist (PAY-04).
   **Couriers, next:** booking parcels through couriers' APIs (spike 2, SHP-01), then their
   remittances and tracking through them.
   **Customers, later:** a customer's own data export (CUS-05), erasure requests that wait and
   can be cancelled, and other numbers in CSV.
7. **Spikes 2–4** (courier adapter SDK, WhatsApp confirmation, checkout sandboxes) build on these
   packages; they need partners' sandboxes (Phase 0's partnerships track).
8. **Checkout, next:** the shop's colours and trust badges on the checkout's page (CHK-14), its
   logo with the media worker, and the rest of the address (CHK-02): areas and landmarks.
   **Storefront, next:** the editor's screens with the admin app; the edge itself, with
   Cloudflare for SaaS for shops' domains and their certificates, with the infrastructure.
   Cash on delivery's rules and fee (CHK-07 and 08) come with online payment (PAY-01), when a
   shopper has another way to pay; the OTP (CHK-09) with messaging.
