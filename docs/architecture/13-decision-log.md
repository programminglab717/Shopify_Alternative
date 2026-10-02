# 13 · Architecture Decision Log

> **Status:** Living document · **Last updated:** 2026-10-02 (ADR-033 to ADR-156 added)
> Each decision records its context, the choice, the consequences and the alternatives considered.
> Status values: **Accepted** (build on it), **Proposed** (needs a spike or business input),
> **Superseded** (kept for history). Add new decisions at the end. Never rewrite history; supersede
> instead.

| ADR | Title | Status |
|---|---|---|
| 001 | Modular monolith deployed as process pools | Accepted |
| 002 | TypeScript as the primary language; NestJS for Core | Accepted |
| 003 | PostgreSQL, shared schema with `shop_id` + RLS; cells for scale-out | Accepted |
| 004 | UUIDv7 keys with type-prefixed public IDs | Accepted |
| 005 | Transactional outbox + BullMQ first; Kafka-compatible log later | Accepted |
| 006 | Liquid-compatible theme engine with JSON templates | Accepted |
| 007 | Cloudflare as the edge (CDN, custom hostnames, Workers, R2) | Accepted |
| 008 | GraphQL for public Admin and Storefront APIs | Accepted |
| 009 | Merchant-owned payment accounts first; partner-powered payments later | Accepted |
| 010 | Courier adapters with data-driven mappings; merchant-owned courier accounts first | Accepted |
| 011 | Phone-first shopper identity | Accepted |
| 012 | WhatsApp primary, SMS fallback; Hatti as a Meta Tech Provider | Accepted |
| 013 | Typesense for search with app-level Urdu/Roman Urdu normalisation | Accepted |
| 014 | ClickHouse for analytics | Accepted |
| 015 | Primary hosting in Singapore; Pakistan data-centre cell later; no Gulf primary | Proposed (pending latency bake-off) |
| 016 | AI through an internal gateway; Claude as the default provider | Accepted |
| 017 | Built-in essentials over app-marketplace dependency | Accepted |
| 018 | React Native (Expo) for merchant and POS apps | Accepted |
| 019 | Drop Mode inventory tokens in Valkey for flash sales | Proposed (spike) |
| 020 | Staff identity built in-house on audited primitives | Accepted |
| 021 | PgBouncer transaction pooling with no session state | Accepted (named prepared statements: see ADR-108) |
| 022 | Stock changes lock levels in one order, check, then write | Accepted |
| 023 | Customer order stats are worked out from orders when read | Accepted |
| 024 | Segments are queries evaluated on demand, over fields modules contribute | Accepted |
| 025 | Order risk is a snapshot taken when an order is placed or re-addressed | Accepted |
| 026 | A customer can have several numbers; modules with customer data join merges and erasure | Accepted |
| 027 | Customers' numbers are masked by role, and reveals go to an append-only audit log | Accepted |
| 028 | Printable documents are HTML pages with print styles; PDFs will render the same pages | Accepted |
| 029 | Refunds record money staff sent back; only owners and managers make them | Accepted |
| 030 | Idempotency keys are kept in Postgres, per caller, for a day | Accepted |
| 031 | Draft orders keep agreed prices and hold no stock; customers confirm them through a secret link | Accepted |
| 032 | Customers confirm or cancel cash-on-delivery orders through a link that then follows the order | Accepted |
| 033 | Customers correct an order's address through its link until it is packed; the number stays the shop's | Accepted |
| 034 | Customers add a draft's address, and their number while it has none, through its link | Accepted |
| 035 | The storefront renders Liquid with limits of its own, fetching lists a chunk at a time | Accepted |
| 036 | One publisher per shop rebuilds storefront documents from the database, its writes fenced by its lock | Accepted |
| 037 | Every shop has a handle naming its storefront on the platform's domain; storefronts find shops through a directory in Valkey | Accepted |
| 038 | An order's link lasts until 30 days after the order ends | Accepted |
| 039 | A shop's theme is a platform theme with the shop's own JSON files over it | Accepted |
| 040 | A shop's menus are kept whole, linking to collections and products by ID | Accepted |
| 041 | What a shop sets for its storefront as a whole is the online store's, starting with its WhatsApp number | Accepted |
| 042 | Carts are kept by the core and priced whenever they are read; storefronts change them with a key of their own | Accepted |
| 043 | A shop charges for delivery once for everywhere, by zones of cities, and not at all from a subtotal | Accepted |
| 044 | Checkout is one page the core renders and storefronts serve on the shop's address, placing a cash-on-delivery order as the page showed it | Accepted |
| 045 | A shop's pages keep HTML cleaned of anything that runs when saved; the storefront shows it as it is | Accepted |
| 046 | Storefront search asks the core, which finds products in Postgres as the admin's search does, until Typesense | Accepted |
| 047 | The edge keeps storefront pages by the handles they name before they stream, and forgets those whose documents change | Accepted |
| 048 | A shop's own domains are the online store's, one shop's each, served once DNS points them at the platform, the primary one where pages send shoppers | Accepted |
| 049 | A theme is previewed through a link the core seals, which storefronts keep in a cookie and render from the core's files, never kept | Accepted |
| 050 | The theme editor talks to its preview through postMessage: a framed preview is in design mode, and renders sections with the editor's unsaved files | Accepted |
| 051 | Search engines and link previews are told each page's address at the shop's own, in each language, and find pages through sitemaps of the storefront's documents | Accepted |
| 052 | A shop's URL redirects are the online store's, and the storefront follows one only where it has no page | Accepted |
| 053 | A handle change asks for its redirect, as Shopify's redirectNewHandle does, and the redirect leads to where the page is now | Accepted |
| 054 | A shop's storefront can be closed behind a password, which the storefront checks against a verifier in the shop's document | Accepted |
| 055 | A shop adds rules to its robots.txt as lines crawlers read, checked when saved, never Liquid | Accepted |
| 056 | A shop's policies are kept as Shopify keeps them, shown in Shopify's markup, and drafted from what the shop has set, never saved by themselves | Accepted |
| 057 | What a shopper agrees to in placing an order is kept with it: the versions of the shop's policies its checkout linked, and where it was placed from | Accepted |
| 058 | No order collects more cash on delivery than the law allows, whoever places it: the rest is paid in advance, or the order is not placed | Accepted |
| 059 | A Shopify product export is imported product by product, as productCreate makes them, keeping their handles; the core sets the stock | Accepted |
| 060 | COD health follows a period's cash-on-delivery orders, worked out from them when asked, its rates of those that turned out | Accepted |
| 061 | Sales are reported in Shopify's terms, from the orders when asked: an order counts on the day it was placed, cancelled ones aside, and so do its items that came back | Accepted |
| 062 | Discount codes are the pricing module's: a percentage or an amount off an order's items, or free delivery, matched in any letter case | Accepted |
| 063 | A shopper's discount code is kept with their cart and counted with the order placed with it, in the order's transaction | Accepted |
| 064 | Discount links keep their code with the shopper's cart, one begun for it if need be, and a cart says of a code only whether it applies | Accepted |
| 065 | A cart permalink begins a cart of its own and goes to its checkout, leaving the shopper's cart as it is | Accepted |
| 066 | What couriers owe is worked out from the orders when asked: delivered cash-on-delivery orders not yet paid, by courier and by days since delivery | Accepted |
| 067 | Couriers' remittance statements are imported whole into a logistics module, each line's cash received on its parcel's order, at most what the order owes, and a parcel's cash once | Accepted |
| 068 | A cash-on-delivery customer may cancel through the order's link until it is packed, though they confirmed it, unless the shop keeps that to before confirming | Accepted |
| 069 | The checkout's page takes the shop's accent colour from its published theme, on its buttons, and on its links where they stay readable | Accepted |
| 070 | An address keeps its area in its second line and its landmark in a field of its own; checkout and customers' links ask for each, suggesting the areas of the larger cities | Accepted |
| 071 | A parcel coming back is checked in by the tracking number on its label, matched as couriers' statements are; those on their way back are listed the longest first | Accepted |
| 072 | A parcel the courier lost is written off, and an order with nothing delivered or back ends at a stage of its own; lost before reaching the customer, it is never their refusal | Accepted |
| 073 | The Confirmation Desk deals orders waiting for their customers to agents one at a time, the most urgent due first, and keeps the calls that did not settle them | Accepted |
| 074 | A shop that gives its bank account offers bank transfer: the order waits for the money at a stage of its own, and keeps the account its customer was told to pay into | Accepted |
| 075 | A shop keeps cash on delivery to the orders it trusts: up to a total of its own, outside cities it names, and not for customers who refused parcels before; checkout offers transfer instead | Accepted |
| 076 | A shop's fee for cash on delivery is the order's own amount, apart from delivery: in its total and the cash collected, said beside the option where the shopper chooses | Accepted |
| 077 | Something off for paying by transfer is part of the order's discount, kept apart from the codes': off the items after any code, to the rupee, said where the shopper chooses | Accepted |
| 078 | A shop keeps cash on delivery from products by their tags: a cart holding one is offered bank transfer alone, the page naming the product | Accepted |
| 079 | Files are kept in object storage under each shop's prefix, uploaded straight there through URLs the Admin API signs, and shown only through short-lived signed URLs; a directory stands in for R2 in development | Accepted |
| 080 | A customer sends the receipt of their transfer through their order's page, in a form the core reads and keeps in storage by order; the shop sees it with the order | Accepted |
| 081 | A shop's logo is one of its files, chosen as its brand's; the checkout's page shows it in place of the shop's name, through a URL signed for an hour that the page's policy allows alone | Accepted |
| 082 | A shop's account takes its Raast ID beside its IBAN, kept with each order as the account is, and shown on its customers' pages to copy; a Raast QR waits for the partner's | Accepted |
| 083 | A cash-on-delivery order may ask for an advance, paid by transfer before it ships: it waits for it as a transfer waits for its money, and staff record it when it is in | Accepted |
| 084 | Checkout asks for the advance the shop's rules name: an amount, a share of the items or the delivery charge, on every order or above a total, said beside cash on delivery | Accepted |
| 085 | A draft may ask for an advance as an order does; once its customer confirms it, the draft's link shows where to pay and takes the receipt | Accepted |
| 086 | A shop chooses trust badges for its checkout from the platform's set, worded in English and Urdu and shown under the button where they hold | Accepted |
| 087 | Checkout takes at most three orders a day from one mobile number and twenty an hour from one internet address, counting the orders it placed, one at a time | Accepted |
| 088 | A parcel keeps what couriers' statements charged for it, which COD health adds up for those that came back; a statement with the lines of one imported before is refused | Accepted |
| 089 | A shop's advance may be asked only to cities it names and of customers who refused parcels before: checkout names every city and says of whom, and placing applies them to the city and number typed | Accepted |
| 090 | Agents' performance is worked out when asked from the calls the desk keeps and the confirmations and cancellations on orders' timelines, by who made them, with how the orders each agent confirmed turned out | Accepted |
| 091 | A shop's Confirmation Desk keeps calling hours, outside which it deals out no order and after which an unanswered one falls due; an order waiting longer for its first call than the shop's target, counting those hours, is overdue | Accepted |
| 092 | An order whose customer could not be reached is cancelled as many days after it was placed as the shop says, by a sweep in the worker, shop by shop and order by order | Accepted |
| 093 | A claim on the courier that lost a parcel is the parcel's, followed until the courier pays it or refuses it; a statement's cash for a lost parcel pays its claim, filed or not | Accepted |
| 094 | A shop's advance may be asked only of customers new to it, and of orders its risk rules score high: such an order is asked it instead of waiting for review | Accepted |
| 095 | The setup checklist is worked out when asked from what each module keeps, in one transaction: a step is done while what it asks for holds | Accepted |
| 096 | Sales tax is included in prices, at a rate the tax module keeps: each order keeps the tax in it as it was placed, line by line and in its delivery | Accepted |
| 097 | Tax categories are the shop's codes with rates of their own, which variants name by Shopify's tax code; every other variant it taxes is at the shop's rate | Accepted |
| 098 | A parcel that came back with items written off as damaged is claimed from its courier for their worth, as a lost parcel is for its own; every claim is listed, the oldest first, to follow up | Accepted |
| 099 | An order paid on delivery that the shop's risk rules score at its limit or above is not taken at checkout: placed, scored and undone, its page asks for a transfer instead | Accepted |
| 100 | Staff sign in with a passkey alone, which passes the second factor, or answer the second step after their password with one; once an account has a second factor, only a session that passed one adds another | Accepted |
| 101 | Owners and managers invite staff by a link they send themselves, accepted once by a signed-in account; the owner manages every role but its own, managers those below them, apps none | Accepted |
| 102 | A customer's own data is one JSON file of everything the shop keeps of them, which each module with their data adds to; the blocklist and risk scores stay out | Accepted |
| 103 | Sensitive actions need staff to have proved who they are in the last 15 minutes, by signing in or confirming with the strongest factor their account has; apps are not asked | Accepted |
| 104 | The owner hands the shop to one of its managers who has a second factor, and stays on as a manager; the shop has one owner throughout | Accepted |
| 105 | A refund keeps its share of its order's sales tax: the order's tax in all it has refunded, less what the refunds before it gave back; the sales report adds up the tax its sales include | Accepted |
| 106 | A draft says the sales tax its prices include: an open one's at the shop's rates now, as placing it would work it out; a completed one's as its order keeps it | Accepted |
| 107 | A tenant transaction begins with its shop and limits set, in one round trip: begin and set_config sent as one simple query, the values written in once checked | Accepted |
| 108 | Hot queries run as statements prepared by name, planned once per connection; every pooler in front of the application sets max_prepared_statements | Accepted |
| 109 | A customer's other numbers travel in a CSV column of their own: after the main number in exports, and in imports a new customer's or, on overwrite, in place of an existing one's | Accepted |
| 110 | A customer's erasure can be asked for ten days ahead, and cancelled until then; the worker's sweep carries it out as the system, naming who asked | Accepted |
| 111 | Orders and carts are read through prepared statements too, each checked by the benchmark against shops of every size; a prepared page writes its size into its text | Accepted |
| 112 | An order waiting to be confirmed is scored again when its customer's history changes, by the worker; a score that makes it risky holds it, and a held order stays held | Accepted |
| 113 | An erased customer's receipts leave storage too: the erasure records each order's receipt files in an event, and the worker removes them once it commits | Accepted |
| 114 | A draft its customer confirms through its link keeps what they agreed to, as checkout's orders do: the page names the shop's policies above its button, and the order keeps their versions and where it was confirmed from | Accepted |
| 115 | An order staff or an app placed keeps what its customer agreed to in confirming it through its link: the page names the shop's policies, and the order keeps their versions, where it was confirmed from and when | Accepted |
| 116 | The Admin API lists the erasures waiting, the soonest due first, with their customers; who asked stays in the audit log | Accepted |
| 117 | The sales report leaves out the sales tax its amounts include, as Shopify's does: worked out from the tax each order keeps, the tax said apart and added back in total sales | Accepted |
| 118 | An orders search takes filters among its words, as Shopify's search syntax writes them; a filter or value it doesn't know is refused, naming those it takes | Accepted |
| 119 | The shop keeps searches of its orders by name, for all its staff, as Shopify's saved searches: each a query the orders search takes, checked when saved | Accepted |
| 120 | A products search takes Shopify's filters among its words, in the syntax the orders search reads, which the admin's lists share | Accepted |
| 121 | The home says how the shop's day has gone, from midnight in its time zone: today's sales as the sales report works them out, and the parcels delivered and turned back today, at their worth | Accepted |
| 122 | An order's timeline is read through a prepared statement too, checked by the benchmark on orders with their timelines; its location's loader stays planned, as customers' statements do | Accepted |
| 123 | A drafts search finds a draft by its number, its customer's mobile or words of their name, city or email, with filters among them, as the orders search does; each draft keeps its words folded | Accepted |
| 124 | Saved searches take the shop's drafts and products as well as its orders, each query checked by its own list's search, names unique within a list, and keeping one needs the scope that changes its list | Accepted |
| 125 | Low stock is a variant of an active product with the shop's threshold or fewer units for sale online, five until it says otherwise, worked out from the levels when asked: counted on the home and listed the fewest first | Accepted |
| 126 | A customers search takes a tag and each channel's marketing consent among its number or words, in the syntax the lists share; segments stay the shop's saved views of customers | Accepted |
| 127 | An order is given to one member of staff at a time, to see it through: owners, managers and apps give it to anyone, other staff take one no one has; staff find theirs with `assignee:me`, and those who leave give their open orders back | Accepted |
| 128 | Staff and apps comment on an order's timeline: each comment its author's to change, kept apart from the events and read among them, every entry saying who made it, and comments going with the customer's details in an erasure | Accepted |
| 129 | Products leave as Shopify's product CSV, a file the import takes back whole: filtered as the products list is, each tracked variant's stock for callers who may read it, a larger catalog in parts; the import links variants to their images | Accepted |
| 130 | Told to overwrite, an import updates the shop's products from the file: fields from the columns it has, a blank cell clearing an optional one, variants matched by their option values and new ones added; options and stock stay the admin's and inventory's | Accepted |
| 131 | An order's items change while it waits to be packed: quantities set and variants added in one edit, the lines kept keeping their prices, its amounts and tax worked out again and the difference collected at the door, its stock committed and let go at once | Accepted |
| 132 | An order its customer placed twice is merged into the other while both wait to be packed: the other takes its items and discount and keeps its own delivery charge, as one parcel; the order merged is cancelled as merged, naming it, and counts for nothing in its customer's history | Accepted |
| 133 | Stock leaves and comes back as Shopify's inventory CSV: a row for each tracked variant at each active location, named by handle, options and location; a count sets on hand where On hand (new) says, and refuses a row whose on hand changed since the file was exported | Accepted |
| 134 | An order's delivery charge and discount change while it waits to be packed, as its items do, its totals, tax and cash at the door following; what was taken off for paying by transfer stays part of the discount, and the fee stays | Accepted |
| 135 | Items sent apart from an order paid on delivery become an order of their own, as its cash is collected by order: at their prices with their share of the discount, the rest of the order as it is and its stock where it was, both orders scored as the one their customer placed | Accepted |
| 136 | A customer's return of delivered items is recorded by staff, each item with its reason, and checked in when it arrives, each unit back in stock where it came back to or written off; money given back stays a refund, and the sales report counts what came back | Accepted |
| 137 | A return may send another size at once, as an order of its own, paid by what was paid for what comes back: credited from its order as a refund by exchange, in which no money moves, the door collecting the rest | Accepted |
| 138 | Customer returns on their way are listed the longest first, with their days and items, and counted on the home, as parcels coming back are | Accepted |
| 139 | A shopper's browser keeps the visits that brought them, the first and the last from elsewhere; checkout passes them on, and the order keeps them as Shopify's customer journey | Accepted |
| 140 | Sales and COD health are broken down by where orders came from: the source and the campaign of each order's last visit from elsewhere, orders without one together | Accepted |
| 141 | An order's lines keep what their variants cost when sold, and the sales report works out the cost of goods, gross profit and what orders made, less couriers' charges and write-offs, plus claims | Accepted |
| 142 | A shop's catalog feed is its storefront's, at its own address: an item for each variant of its products with an image, in Google's RSS, which Meta's catalogs read too, made from its documents a chunk at a time | Accepted |
| 143 | Orders placed through checkout go to Meta's conversions API from the worker as they are placed, confirmed and delivered, the shop choosing which is Purchase; each moment waits in Postgres until Meta takes it or its seven days are up | Accepted |
| 144 | A shop's storefront loads its Meta pixel while Meta is connected, for the steps shoppers take before checkout; orders go from the server alone, each keeping the pixel's browser and click IDs for them | Accepted |
| 145 | A signed-up user opens a shop of their own through the identity login: its name, a handle made from it or chosen and never the platform's, the user its owner, and shop.opened for its storefront, in one transaction | Accepted |
| 146 | A shop's customers hear of their orders from Hatti's shared WhatsApp number, or by SMS where the shop saves or WhatsApp cannot deliver; each message waits in Postgres, queued once from the order's events, until the worker sends it, and WhatsApp's webhook follows it and hears customers ask to stop | Accepted |
| 147 | A cash-on-delivery order waiting for its customer asks them on WhatsApp to confirm it, with Confirm, Cancel and Change address buttons and its link; their answer comes through the webhook as an event, and the worker confirms or cancels the order as their link would | Accepted |
| 148 | Checkout asks a shopper paying on delivery for a code sent to the number they typed, on WhatsApp or by SMS, where the shop's risk rules score the order at its mark; a digest of the code alone is kept, and the order keeps when its number was proved | Accepted |
| 149 | Shops book orders with their own courier accounts, their credentials sealed for each account; each booking waits in Postgres until the worker books it through the courier's adapter, keeps the courier's number before shipping the order with it, and follows the parcel by asking, the courier's words read through mappings kept as data | Accepted |
| 150 | Couriers' labels and load sheets are Hatti's own printed pages: a booked parcel's label carries the courier's tracking number as a Code 128 barcode and the cash the courier was asked to collect, one to a 4×6 inch label or four to a sheet of A4, and an account's load sheet lists its parcels waiting to be picked up, for the shop and the rider to sign | Accepted |
| 151 | Shops take payments online through their own gateway accounts, Safepay first, their credentials sealed for each account; an order waiting for its money offers to take it on its page, a session is recorded before the customer leaves for the gateway, and the gateway's signed return or webhook, whichever comes first, records it paid once and pays what the order owes of it; a sandbox's payments pay nothing | Accepted |
| 152 | Checkout offers paying online where the shop has a gateway: the order is placed to wait for its total, as a transfer's does, and its thank-you page sends the shopper to the shop's gateway, which sends them back to the checkout's address on the core | Accepted |
| 153 | Money paid online goes back through the gateway that took it, as far as its adapter can give it back, Safepay a payment whole: each refund is recorded before the gateway is asked and written on its order once the gateway says it is sent; a refusal is said, and a refund without an answer holds its amount until staff settle it from the gateway's dashboard | Accepted |
| 154 | Shops pay Hatti for a plan in rupees, by the month or the year, through Hatti's own payment gateway account: a bigger plan begins once its invoice is paid, less what is left of the period it cuts short, a smaller one when the period ends; each period is invoiced a week ahead and a week unpaid puts the shop on Free; other modules ask each plan's limits through a port | Accepted |
| 155 | A shop's messages are paid from credit in rupees it buys from Hatti with an invoice of its own: each is charged as it is sent, at what it costs Hatti and Hatti's fee, in a ledger kept beside the balance; a message the credit cannot pay for waits and a code is not sent, and what WhatsApp could not deliver is given back | Accepted |
| 156 | Hatti's support looks at a shop only while its owner allows it, 15 minutes to a day: its agents, Hatti's own people signed in with a second factor, come as a caller of their own with every read scope, numbers masked, change nothing, and each of their requests goes on the shop's audit log before it runs | Accepted |

---

## ADR-001 · Modular monolith deployed as process pools

* **Context:** a small team must deliver a very broad product (Shopify-scale scope) quickly while
  keeping transactional integrity across catalogue, inventory, orders and payments.
* **Decision:** one Core codebase with strictly enforced module boundaries (public facades,
  owned tables, domain events). It is deployed as separate pools (admin API, storefront API,
  checkout, workers) from the same image. Only components with a distinct runtime profile are
  separate services: storefront renderer, edge workers, webhook ingress, ML service.
* **Consequences:** in-process calls and local transactions; one deploy pipeline; boundaries must
  be policed by tooling (lint rules, schema ownership checks). A module can be extracted later
  if scale or team structure demands it.
* **Alternatives:** microservices from day one (distributed-transaction and ops cost too high for
  the team size); an unstructured monolith (fast now, unmaintainable later).

## ADR-002 · TypeScript as the primary language; NestJS for Core

* **Context:** hiring market, shared code across web, mobile and edge, and speed of delivery.
* **Decision:** TypeScript everywhere. NestJS (Fastify adapter) structures Core. Python only for
  ML. Rust only for the future Wasm Functions runner.
* **Consequences:** the largest local talent pool; shared Zod schemas and types; Node needs care for
  CPU-heavy work (templating limits, worker threads, caching).
* **Alternatives:** Go (efficient, but a second language and a smaller local pool); PHP/Laravel
  (big local pool, but splits the stack); Ruby on Rails (Shopify's choice, with a small local pool).

## ADR-003 · PostgreSQL shared schema with `shop_id` + RLS; cells for scale-out

* **Context:** 100k+ small tenants and a few large ones; cost per store must stay low.
* **Decision:** shared tables with `shop_id` on every row. Postgres Row-Level Security is a
  backstop behind application scoping. Scale out by adding **cells** (Postgres + Valkey + workers)
  and moving shops between them.
* **Consequences:** very low cost per tenant; the blast radius is limited to a cell; no cross-cell
  joins; a Shop Mover tool must be built (Growth phase) before cell 2 is needed.
* **Alternatives:** database per tenant (too costly and operationally heavy at 100k shops);
  Citus (elegant but operationally complex outside its managed offering); Vitess/MySQL (more ops).

## ADR-004 · UUIDv7 keys with type-prefixed public IDs

* **Decision:** internal UUIDv7 primary keys; public IDs are type prefix + base32 (`ord_…`);
  per-shop human numbers for orders and gapless series for tax invoices.
* **Consequences:** globally unique IDs make shop moves between cells trivial; index locality from
  time ordering; 16-byte keys (acceptable).
* **Alternatives:** bigint sequences (collisions across cells); Snowflake IDs (needs an ID
  service).

## ADR-005 · Transactional outbox + BullMQ first; Kafka-compatible log later

* **Decision:** domain events are written to an outbox table in the same transaction; a relay
  publishes them to BullMQ queues on Valkey. Introduce Redpanda (Kafka API) when analytics
  volume or independent consumers require a replayable log.
* **Consequences:** correctness (no lost or phantom events) with minimal infrastructure;
  consumers must be idempotent. The later migration changes transport only, not the event
  contract.
* **Alternatives:** Kafka from day one (ops cost); pg-boss (adds load to the primary DB); Temporal
  (powerful, heavy; revisit for complex long-running workflows).

## ADR-006 · Liquid-compatible theme engine with JSON templates

* **Context:** Pakistan has a very large pool of Shopify/Liquid developers and agencies. Merchants
  want no-code editing. Storefronts must be very light.
* **Decision:** LiquidJS-based engine implementing Shopify-compatible Liquid objects, filters and
  tags, plus OS 2.0-style JSON templates, sections and blocks, and Hatti extensions (RTL, COD,
  WhatsApp, delivery estimates). Server-rendered HTML with a tiny JS runtime.
* **Consequences:** developers are productive immediately; merchant-owned themes are portable; we
  must keep up with Liquid semantics and build strong sandboxing and limits.
* **Alternatives:** a React/RSC theme system (heavier pages, harder no-code editing); a proprietary
  template language (no ecosystem).

## ADR-007 · Cloudflare as the edge

* **Decision:** Cloudflare for DNS, CDN, WAF, bot management/Turnstile, Workers (routing, waiting
  room, event collection), KV, Durable Objects, R2 and Cloudflare for SaaS custom hostnames.
* **Consequences:** in-country PoPs; automatic TLS for thousands of merchant domains; zero-egress
  media storage; some vendor concentration, mitigated by keeping origin logic portable.
* **Alternatives:** Fastly (cost, local presence), CloudFront + ACM (per-certificate limits,
  egress cost).

## ADR-008 · GraphQL for public Admin and Storefront APIs

* **Decision:** date-versioned GraphQL APIs with cost-based rate limiting; REST only for OAuth,
  webhooks and file uploads.
* **Consequences:** efficient rich clients (admin, mobile, apps) and a familiar model for Shopify
  developers. Needs a query-cost engine, persisted queries and resolver-level authorisation.
* **Alternatives:** REST-first (simpler, chattier); both from the start (doubles the surface).

## ADR-009 · Merchant-owned payment accounts first; partner-powered payments later

* **Context:** licensed payment providers must not hold customer funds without the right licence.
  EMI/PSP licences need large paid-up capital and heavy compliance. Small merchants struggle to
  get gateway accounts.
* **Decision:** MVP integrates gateways with **merchant-owned credentials**, so funds never touch
  Hatti. The Growth phase launches partner-powered payments with a licensed PSP that onboards sub-merchants
  and settles directly to each merchant's IBAN. Our own licence is considered only at scale.
* **Consequences:** zero regulatory dependency at launch; slower onboarding for merchants without
  gateways until the Growth phase; a payments revenue line arrives in the Growth phase.
* **Alternatives:** obtain a licence first (years and capital); collect funds informally (illegal
  and unacceptable).

## ADR-010 · Courier adapters with data-driven mappings; merchant-owned courier accounts first

* **Decision:** one adapter per courier behind a common interface. Status and city mappings are
  data (editable without deploys). Merchants connect their own courier accounts at first, and
  couriers remit COD directly to them. A negotiated-rate programme follows, still without Hatti
  holding COD cash.
* **Consequences:** fast launch, no cash handling; mapping data needs ongoing curation; adapters
  need contract tests because courier APIs change without notice.

## ADR-011 · Phone-first shopper identity

* **Decision:** shopper identity is the verified mobile number (E.164); email is optional. OTP
  goes via WhatsApp first, then SMS.
* **Consequences:** matches local behaviour and COD operations; OTP costs and SIM-swap risks must
  be managed; email-dependent features (receipts, marketing) become channel-agnostic.

## ADR-012 · WhatsApp primary, SMS fallback; Hatti as a Meta Tech Provider

* **Decision:** WhatsApp Cloud API through Embedded Signup (merchant-owned WABAs), a shared
  platform number for small shops' utility messages, SMS failover through two aggregators, and IVR
  for high-value confirmations. Message credits are sold in PKR.
* **Consequences:** best reach and engagement; dependency on Meta policy and pricing; regional
  WhatsApp restrictions are handled by automatic fallback.

## ADR-013 · Typesense for search with app-level Urdu/Roman Urdu normalisation

* **Decision:** Typesense (HA) with per-cell collections and per-shop scoped keys; our own
  normalisation layer for Roman Urdu phonetics and Urdu script, applied at index and query time.
* **Alternatives:** OpenSearch (heavy), Meilisearch (similar; either is acceptable), Postgres FTS
  (admin only).

## ADR-014 · ClickHouse for analytics

* **Decision:** storefront events and order/shipment facts go to ClickHouse; merchants query it
  only through the Analytics module's parameterised, shop-scoped queries.
* **Alternatives:** BigQuery/Snowflake (query-based cost and USD exposure), Postgres (too slow at
  event scale).

## ADR-015 · Primary hosting in Singapore; Pakistan data-centre cell later; no Gulf primary *(Proposed)*

* **Context:** Pakistani users need low latency, and no hyperscaler has a region inside Pakistan.
  The closest regions (Gulf, 20–50 ms) carry demonstrated war risk: in March 2026 drone strikes
  reportedly impaired AWS's UAE and Bahrain regions for months, with reported permanent data loss.
  Revenue is in PKR and costs in USD. Startup credits matter. Measured 2026 latency: in-country
  hosting 2–40 ms, Singapore about 90–130 ms, Europe 130–200 ms. Submarine-cable faults
  (8 since 2024) multiply international latency 2–6× but do not affect in-country traffic.
* **Proposal:** launch cells in a **Singapore** hyperscaler region (managed Postgres, Valkey and
  Kubernetes; Multi-AZ), with backups and DR in a second non-Gulf region (e.g. Europe), behind
  Cloudflare. In the Growth phase, add a **Pakistan data-centre cell** (multi-homed Tier-III facility):
  first storefront renderers and read replicas, then full cells for Pakistani merchants. This cuts
  latency, removes cable-fault exposure, prepares us for data-residency rules and hedges FX with
  PKR-billed capacity. Do not run a Gulf region as primary. Keep everything portable (Kubernetes,
  Postgres, S3 API, OpenTelemetry, portable egress IPs for FBR/courier allow-lists).
* **To decide:** a latency bake-off from 5+ Pakistani networks, including which Cloudflare edge
  serves our custom hostnames; credits and pricing (AWS vs GCP vs others in Singapore); a shortlist
  of local DCs for the PK cell; a legal review of data-localisation direction. See
  [10 · Infrastructure & DevOps](./10-infrastructure-and-devops.md) and
  [Research · Local Ecosystem](../research/03-local-ecosystem.md).

## ADR-016 · AI through an internal gateway; Claude as the default provider

* **Decision:** every LLM call goes through the AI Gateway (routes, quotas, caching, batching,
  evals). The default is the flagship Claude model (Opus tier), with effort tuned per route. Cheaper tiers are
  adopted per route only with eval evidence and a product decision.
* **Consequences:** consistent cost control and safety; provider and model changes are
  configuration changes.

## ADR-017 · Built-in essentials over app-marketplace dependency

* **Context:** Pakistani merchants on Shopify pay in USD for many apps (COD forms, courier booking,
  WhatsApp, reviews, upsells, pixels). This is a large share of their total cost and a common
  frustration.
* **Decision:** ship these essentials as first-party, plan-gated features. The app platform serves
  integrations and specialised needs.
* **Consequences:** a larger core scope and team; a strong pricing advantage and a coherent UX;
  there are fewer ecosystem revenue opportunities for third parties in core areas, so we must
  still court partners for the long tail.

## ADR-018 · React Native (Expo) for merchant and POS apps

* **Decision:** one codebase for Android (priority) and iOS; shared TS packages; native modules for
  Bluetooth thermal printers and barcode scanning; offline-first storage for POS.
* **Alternatives:** Flutter (a second language), native apps (double the effort).

## ADR-019 · Drop Mode inventory tokens in Valkey *(Proposed, spike required)*

* **Decision:** during scheduled drops, checkout claims pre-loaded per-variant tokens atomically
  in Valkey. Orders are written without hot-row inventory locks, and a reconciler folds consumption
  back into Postgres.
* **Spike exit criteria:** 2,000 checkouts/min on one SKU with zero oversell under failure
  injection (Valkey failover, worker crash), and full reconciliation within 60 s.

## ADR-020 · Staff identity built in-house on audited primitives

* **Context:** [02 · Tech stack](./02-tech-stack.md) proposed better-auth for staff sign-in, to be
  confirmed by a Foundations spike. [11 · Security](./11-security-and-compliance.md) §2.1 requires
  argon2id passwords with a breached-password check, TOTP (and later passkeys), MFA for owners and
  finance roles, **short-lived access tokens with rotating refresh tokens**, and a device list with
  remote sign-out. Our data conventions are forward-only SQL migrations, separate database logins
  per concern, UUIDv7 keys and prefixed public IDs.
* **Spike finding (better-auth 1.7.6, package inspection):** first-party sessions are sliding
  session tokens (usually cookies); its refresh tokens belong to linked OAuth accounts, so the
  rotating-refresh model would be ours to build anyway. Its schema comes from its own CLI and
  adapters (it bundles adapters for Kysely, Drizzle, Prisma and MongoDB), which conflicts with our
  hand-written migrations and role separation. Its organisation plugin models roles differently
  from our per-shop presets.
* **Decision:** an Identity module (`@hatti/identity`) built on small, audited primitives:
  argon2id via `@node-rs/argon2` (OWASP parameters), `node:crypto` for AES-256-GCM secret
  encryption and RFC 6238 TOTP (tested against the RFC vectors), Pwned Passwords k-anonymity for
  breached passwords, and opaque random tokens stored only as SHA-256 digests. Identity tables sit
  behind their own database login; request-serving code reaches them only through one
  `SECURITY DEFINER` function. Passkeys will use `@simplewebauthn/server`; OAuth for apps stays with
  `oidc-provider`.
* **Consequences:** we own security-critical code, so it stays small, fully tested (reuse
  detection, replay protection, rate limits, role boundaries) and goes into the pre-launch
  penetration test. We avoid a large dependency tree and keep one data model for staff, shops and
  roles.
* **Alternatives:** better-auth (above); Keycloak, Zitadel or Ory (extra services to operate, as
  noted in the tech stack); Lucia (now a guide rather than a maintained library).

## ADR-021 · PgBouncer transaction pooling with no session state

* **Context:** [02 · Tech stack](./02-tech-stack.md) put PgBouncer in transaction mode in front of
  Postgres, relying on transaction-local settings for row-level security (ADR-003). Spike 5
  ([results](../engineering/spikes/05-rls-and-pooling.md)) measured this on the products listing
  (1,000 shops, 460k products). It found that the application could not connect through
  PgBouncer at all: the driver sent timeouts as startup parameters, which PgBouncer refuses. It
  also found that the outbox relay's `LISTEN` would silently stop receiving notifications.
* **Decision:**
  * Request-serving processes reach Postgres through PgBouncer in transaction mode. Nothing may
    outlive a transaction: settings go through `set_config(…, true)` or `SET LOCAL`, and code
    never uses session `SET`, `LISTEN`, session advisory locks, temporary tables or named
    prepared statements.
  * Timeouts are defaults on each login (15 s per statement, 30 s idle in a transaction). Each
    tenant transaction also sets its surface's budget, in the same statement as the shop.
  * Only migrations, setup, the relay's `LISTEN` (`DATABASE_LISTEN_URL`, checked at start-up)
    and operator tools connect directly.
  * CI runs every database test through PgBouncer.
  * Queries always filter by shop explicitly, and index only leakproof conditions. Text search
    and similar filters go to Typesense or to rows with B-tree indexes.
* **Consequences:**
  * Row-level security costs about 0.1 ms per transaction and keeps every listing plan.
  * The pooler adds about 0.03 ms per round trip on one host. Hot paths therefore keep round
    trips few: a product loads in one statement.
  * PgBouncer served 1,024 clients on 20 server connections, where direct connections failed
    above 100. Overload becomes queueing, which admission control at the edge must bound.
  * PgBouncer should run beside the API pods, on its own CPU. The spike's single machine
    understated pooled throughput for lack of it.
* **Alternatives:**
  * Session pooling: keeps session state, but gives each client its own server connection, so
    nothing is multiplexed.
  * RDS Proxy: pins a session on `SET`, which defeats pooling.
  * Application pools only: pods × pool size outgrows `max_connections`.
  * Supavisor, PgCat, Odyssey: multithreaded poolers. Revisit if PgBouncer's single thread
    becomes the limit; it used half a core in the spike.

## ADR-022 · Stock changes lock levels in one order, check, then write

* **Context:** [03 · Data](./03-multi-tenancy-and-data.md#62-inventory-quantities) protects
  against overselling with one conditional `UPDATE` per order line. Real changes touch many
  levels at once: an order has several lines and must take all or none, and a stock count sets up
  to 250 levels. Conditional updates run line by line can half-apply, and two orders that list
  the same variants in a different order lock rows in a different order, so they can deadlock.
  Deactivating a location also has to be sure no sale is adding stock there at the same moment.
* **Decision:** every stock change takes one path, for merchants and orders alike
  ([conventions](../engineering/conventions.md#inventory)):
  1. Create missing items and levels, in (variant, location) order (merchant changes only).
  2. Lock the levels with `SELECT … ORDER BY variant_id, location_id FOR UPDATE`, which also
     takes a key-share lock on each location.
  3. Check the whole change against the locked quantities in application code. Report shortages
     or user errors and write nothing if any line fails.
  4. Write the levels, the adjustment and one movement per quantity changed in one statement,
     then one `inventory_level.updated` per level.
  Deactivating a location takes an exclusive lock on it, so it waits for sales in progress there,
  and new sales wait for it. A variant whose stock was never recorded has no item: it is not
  tracked and sells freely, and its first stock starts tracking.
* **Consequences:**
  * Nothing sells a unit twice, and concurrent orders queue rather than deadlock. Tests run 20
    buyers against 5 units, 30 orders listing two variants in opposite orders, and a deactivation
    racing a sale, directly and through PgBouncer.
  * An order commit costs three round trips (lock, write, events) instead of one. A best-selling
    variant's level is a hot row: every order for it waits on the one before. Flash sales still
    need Drop Mode (ADR-019).
  * The ledger records why every quantity changed, and who changed it; request code can only
    add to it.
* **Alternatives:**
  * One conditional `UPDATE` per line, inside a savepoint to undo partial orders: more round trips
    on failure, and still deadlock-prone across lines.
  * `SERIALIZABLE` isolation: correct without explicit locks, but concurrent buyers of one
    variant abort and retry, which is worst exactly when demand peaks.
  * Optimistic version checks: the same retry storms on hot variants.

## ADR-023 · Customer order stats are worked out from orders when read

* **Context:** customer profiles (CUS-01) show what a customer's orders add up to: how many,
  what they paid, and how they turned out (delivered, refused, cancelled), which the Confirmation
  Desk reads before every call. [03 · Data](./03-multi-tenancy-and-data.md) sketched
  `orders_count` and `total_spent` columns on the customer. Kept there, they would be written by
  the orders module into another module's table on every stage change, parcel and payment, and
  would drift whenever one path forgot. Each write would also lock the customer row, adding a
  hot row for repeat buyers to the order, stock and counter locks an order already takes.
* **Decision:** customers store only their profile. The orders module works the numbers out from
  a customer's orders when they are asked for, with one grouped query per page of customers
  (batched per request, on an index of orders by customer), and adds them to the `Customer`
  GraphQL type. A customer's addresses are likewise the different addresses their orders went
  to. Orders find or create their customer by mobile number in the transaction that places them
  (ADR-011).
* **Consequences:**
  * The numbers are always right, including after an order moves to another customer because
    its number was corrected, and nothing needs backfilling.
  * Customers cannot be sorted or filtered by these numbers in SQL. Segments and "top customers"
    will read a customers search index fed by order events (ADR-013), which is where filtering at
    scale belongs anyway.
  * A customer with thousands of orders costs a larger aggregate per read; an index-only summary
    or cached counts can come later if profiles show up in latency profiles.
* **Alternatives:**
  * Counters on the customer, updated by the orders module through a facade: fast to sort by,
    but a second copy of the truth, with cross-module writes and extra locks in every order
    transaction.
  * A projection updated asynchronously from order events: no locks, but profiles lag the orders
    staff just changed, and it needs a consumer before there is anything else to consume.

## ADR-024 · Segments are queries evaluated on demand, over fields modules contribute

* **Context:** segments ([07 · Messaging §5.1](./07-messaging-and-marketing.md#51-segments)) filter
  customers by facts that belong to several modules: their tags (customers), what they ordered and
  how it turned out (orders), and later consent and storefront behaviour. The customers module
  owns segments but must not read other modules' tables, and the orders module already depends on
  customers, so customers cannot call into orders. Order facts are worked out when read, not
  stored (ADR-023).
* **Decision:**
  * A segment is a name and a query in a small language modelled on Shopify's segment queries
    (`number_of_orders >= 2 AND city IN (Lahore, Karachi) AND last_order_date < -60d`). The
    customers module parses it, type-checks it against the fields, and compiles it to one SQL
    statement with every value a parameter.
  * **Fields are contributed.** The customers module has a `SegmentFieldRegistry`. A module that
    owns facts about customers registers a source at start-up: SQL giving one row per customer,
    and fields that read its columns. The orders module registers its order facts, the same query
    behind a customer's stats. The customers module joins a source only when a query uses its
    fields, without knowing its tables.
  * **Members are found when asked for**, not stored, so a segment is always current and there is
    nothing to keep in step.
* **Consequences:**
  * Adding consent, behaviour or loyalty fields later means registering a source; the language,
    API and saved segments stay as they are.
  * A query using order fields aggregates the shop's orders each time it runs. That is fine for
    shops with tens of thousands of orders, but not for the largest. The customers search index
    fed by order events (ADR-013, ADR-023) is the route to scale, behind the same language.
  * Automations that react to someone entering a segment will need membership changes, which
    on-demand evaluation does not give; they will evaluate incrementally, per event.
* **Alternatives:**
  * Stored membership, refreshed by a job: fast to read, stale between runs, and every field
    change means a rebuild.
  * A generic JSON filter tree instead of a text language: easier to parse, harder for merchants
    and AI assistants to read and write, and unlike what merchants migrating from Shopify know.
  * The customers module querying orders' tables directly: simplest, but breaks the module
    boundary that lets modules move into services later.

## ADR-025 · Order risk is a snapshot taken when an order is placed or re-addressed

* **Context:** cash-on-delivery orders that come back unpaid cost the merchant shipping both ways
  and tie up stock. The MVP scores them with transparent rules (COD-06), and V1 with a model
  trained on delivery outcomes ([09 · AI §4.1](./09-ai-and-intelligence.md#41-rto--cod-risk-model-v1)).
  A risky order should wait for review before anyone confirms or ships it, and staff should see
  why. Customer stats, which the rules read, are worked out when read (ADR-023); the question was
  whether risk should be too.
* **Decision:**
  * The orders module scores cash-on-delivery orders with weighted rules: the customer's history
    in this shop (from the same query as their stats), another unshipped order from the number in
    the last 6 hours, the order's value and size, and how complete the address is. Points out of
    100 inside, 0 to 1 in the API, with the reasons strongest first.
  * **The score is taken when the order is placed and when its address changes, and stored on the
    order with its reasons.** The hold decision is made at those moments, and the order keeps what
    it was based on.
  * A shop's policy is a hold threshold and a high-value amount, with defaults in code. Orders at
    or above the threshold wait for review (`needs_review`), with the reasons on the timeline. An
    address change holds an order only if the change is what makes it risky, so staff who
    reviewed a risky order can still correct it.
  * Guardrails: no rule looks at which city an order is for, no address rule alone reaches the
    medium level, prepaid orders are not scored, and merchants see every reason.
* **Consequences:**
  * The order list filters by risk level with an index, and the Confirmation Desk can sort by
    score.
  * A score can go stale: an open order does not pick up a refusal of another order that happens
    after it was placed. The customer's delivery history, which staff see beside the order, is
    always current; re-scoring on such events can come with the Confirmation Desk.
  * The V1 model plugs in behind the same shape (score, level, reasons) and storage, and the
    stored reasons are a record of what each decision was based on.
* **Alternatives:**
  * Scoring when read, like customer stats: always current, but the basis of a hold would change
    after the decision, and filtering by level would need the rules in SQL.
  * A hold flag without a score: simpler, but nothing to rank a review queue by and no path to
    model thresholds.
  * Merchant-editable rule weights: flexible, but easy to misconfigure and hard to support. The
    MVP exposes the threshold and the high-value amount; weights can follow once there is data on
    what merchants change.

## ADR-026 · A customer can have several numbers; modules with customer data join merges and erasure

* **Context:** a customer is whoever a mobile number belongs to (ADR-011), but many shoppers in
  Pakistan carry two SIMs, so one person can become two customers, each with half the delivery
  history the risk rules read (ADR-025). Merging them has to keep working afterwards: an order
  from either number must find the merged customer. A customer can also ask for their data to be
  erased, while the shop must keep its order records for its accounts
  ([03 · Data §11](./03-multi-tenancy-and-data.md#11-data-lifecycle--privacy)). Customers own
  profiles; orders own orders, and depend on customers, not the other way round.
* **Decision:**
  * **Every number of every customer is a row** in `customers.customer_phones`, keyed by shop and
    number, so a number belongs to one customer at a time. The customer row keeps the main
    number, which marketing consent is for; a deferred foreign key keeps it one of theirs.
    Orders find their customer by any of the numbers, and hold a lock on it until they commit.
  * **Modules that keep data about customers register a handler** with the customers module at
    start-up, as they register segment fields (ADR-024): what stops an erasure, how to move data
    to the customer a duplicate is merged into, and how to erase it. The customers module runs
    them inside the merge's or erasure's transaction, without knowing their tables.
  * **Merging** moves the duplicate's data, then its numbers (which waits for orders being placed
    with them), then the data again, and deletes the duplicate. The customer's own name and email
    win; the duplicate's fill gaps, an email with its consent.
  * **Erasure** is refused while any order of the customer is open. Otherwise it deletes the
    profile, numbers and consent history, and orders keep their items, amounts, statuses and
    city, without the name, number, email, street or note. Timeline messages hold no contact
    details, so they need no rewriting.
  * The consent ledger stays append-only for request code: two narrow functions, limited to the
    caller's shop, move it on a merge and delete it on an erasure.
* **Consequences:**
  * A customer's history and risk score cover all their numbers, and a later order from a merged
    number needs no second merge.
  * A new module with customer data must register a handler, or merges and erasures leave its
    data behind; the registry makes that one line at start-up.
  * Erasure is immediate and cannot be undone. A waiting period with a cancel, as Shopify has,
    needs scheduled jobs, which the worker does not run yet.
* **Alternatives:**
  * One number per customer, with merging dropping the duplicate's number: simple, but every
    later order from the second SIM would make the duplicate again.
  * A `merged_into` pointer instead of moving data: nothing to move, but every read would follow
    pointers, and uniqueness of numbers would span two tables.
  * The orders module erasing when it sees a `customer.erased` event: no handler interface, but
    an erasure would leave personal data in orders until the event is handled, and could not be
    refused for open orders.

## ADR-027 · Customers' numbers are masked by role, and reveals go to an append-only audit log

* **Context:** a shop's customer list is its most valuable data, and its numbers are what a
  departing agent or a careless marketer could take. The role design gives confirmation agents a
  masked number with a logged reveal, and packers, marketers and accountants no numbers
  ([11 · Security §2.1](./11-security-and-compliance.md#21-merchant-staff),
  [IA §6](../design/02-information-architecture.md#6-permissions--navigation-matrix-presets)).
  A logged reveal needs somewhere lasting to log it; the outbox keeps events for days.
* **Decision:**
  * **Masking is decided by the caller's role, in the API layer.** Owners, managers and apps
    see numbers whole; every other role sees "0300 ••••567" wherever a number appears: orders,
    addresses, customers, other numbers, the blocklist and consent history. Services return
    whole numbers; only the GraphQL mappers mask, through one function in `@hatti/api`.
  * **Confirmation agents reveal a number** with `orderPhoneReveal` or `customerPhoneReveal`;
    roles that only see numbers masked are refused. Each reveal is an audit entry naming who, in
    what role, and which order or customer.
  * **The audit log** is a platform table beside the outbox (`platform.audit_log`), written in
    the transaction of what it records and append-only for request code. It also records
    exports, merges, erasures and policy changes, and owners and managers read it as the shop's
    activity log.
* **Consequences:**
  * A number a role should not see never reaches its screen, whichever screen asks.
  * Apps see numbers whole for now. Protected customer data scopes, as Shopify has, would let a
    shop grant an app orders without numbers.
  * The log grows with every reveal; it is one table until monthly partitions are needed.
* **Alternatives:**
  * Masking in the admin app only: simplest, but anyone with the role's token could ask the API
    for whole numbers.
  * A `read_customer_phones` scope: fits apps too, but every existing token and role would need
    it to keep working, and a reveal is not a scope.
  * Logging reveals as domain events only: consumers see them, but the outbox forgets after a
    week, and a log a merchant relies on must not depend on a consumer.

## ADR-028 · Printable documents are HTML pages with print styles; PDFs will render the same pages

* **Context:** packers print packing slips and invoices for dozens of orders at a time, on A4
  printers or on thermal label and receipt printers, in English and Urdu. Urdu is set in
  Nastaliq, which needs a full text-shaping engine; PDF libraries for Node shape it poorly, which
  is why the [tech stack](./02-tech-stack.md) plans Gotenberg (headless Chromium) for PDFs. That
  service comes with the infrastructure, which waits on the hosting decision (ADR-015).
* **Decision:**
  * **Documents are HTML pages** rendered on the server from TypeScript templates, with print
    styles for each paper: A4, 4×6 inch thermal labels and 80 mm receipt rolls. One page holds
    many orders, each on a sheet of its own. The admin opens it and prints it from the browser,
    which shapes Nastaliq correctly.
  * **Templates escape by default.** They are tagged templates (`html` in `@hatti/documents`)
    that escape every value unless it is markup the package built, so a customer's name cannot
    add a tag. Documents run no scripts.
  * **Wording is English, Urdu or both.** Urdu documents run right to left; names, addresses and
    products stay as typed, isolated so each reads in its own direction.
  * **A document shows what its caller may see**, as the API does: customers' numbers are masked
    for staff who see them masked (ADR-027).
  * **PDFs will come from the same pages:** the documents service will print them with Gotenberg,
    in bulk through the queue, to store, email or send on WhatsApp.
* **Consequences:**
  * Printing works now, with no new infrastructure, and PDFs will reuse the templates rather than
    a second layout.
  * The merchant prints through the browser's print dialog. The page sets the paper size and
    margins, but a thermal printer needs its paper size set once in its driver.
  * Fonts load from Google Fonts until the CDN serves them.
  * Merchants cannot edit the templates yet. Shopify lets them edit packing slips in Liquid;
    merchant-edited templates could render into the same page shell through the theme engine
    (ADR-006).
* **Alternatives:**
  * PDFs from a Node library (pdfmake, pdf-lib): weak Nastaliq shaping, and CPU-heavy work in
    request handlers.
  * Headless Chromium inside the API process: a browser's memory and patching in every API pod;
    a separate Gotenberg service is the plan.
  * A template language (Handlebars, Liquid) for these fixed documents: another syntax to learn
    and to escape correctly, where TypeScript templates are type-checked against the order
    records.
  * ESC/POS commands for thermal printers: exact control, but most printers cannot shape Urdu
    text themselves and there is no preview. ESC/POS stays the plan for POS receipts.

## ADR-029 · Refunds record money staff sent back; only owners and managers make them

* **Context:** merchants give money back when an item arrives damaged, a delivery charge is
  waived or a prepaid order is cancelled, by bank transfer, JazzCash or Easypaisa, or in cash.
  No payment gateway is integrated yet, so Hatti cannot send refunds itself. A refund is money
  leaving the shop, and the role design keeps money matters with owners and managers
  ([IA §6](../design/02-information-architecture.md#6-permissions--navigation-matrix-presets)),
  while confirmation agents and packers change orders all day.
* **Decision:**
  * **A refund is a record** of money staff already sent: amount, method, an optional reference
    and note, who and when (`orders.refunds`). The order keeps what was paid (`amount_paid`,
    which refunds never lower) and what was refunded since (`amount_refunded`, never more). Its
    financial status becomes `refunded` or `partially_refunded`.
  * **Refunds do not move orders.** An order is complete once it is delivered and was paid in
    full, even if some of it went back later: a completed order stays completed and closed, and
    closed and cancelled orders still take refunds.
  * **Refunds touch money only.** Items come back to stock through returns (the refused-parcel
    check-in now, customer returns with ORD-07), not through refunds.
  * **Only owners and managers refund**, besides apps with `write_orders`: the API refuses other
    staff roles, which have `write_orders` too, with `ACCESS_DENIED`. Every refund is also an
    audit entry (ADR-027).
  * What a customer has spent counts refunds out.
* **Consequences:**
  * Merchants keep one record of what was paid and given back, for their accounts and for
    customers' spending, before any gateway exists. Gateway refunds will create the same record
    once the provider confirms them.
  * A refund recorded by mistake cannot be undone yet; a correction would be a new kind of entry,
    as the ledger never edits money after the fact.
  * Store credit waits for a store-credit ledger.
* **Alternatives:**
  * Lowering `amount_paid` on a refund: simpler columns, but it loses what was received, and an
    order refunded in part would stop counting as paid in full.
  * A `write_refunds` scope: apps would need it too, and every existing role preset would change.
    Shopify gates refunds by staff permission, not by an app scope.
  * Refund lines with restocking, as Shopify has: needed with customer returns, which come later.

## ADR-030 · Idempotency keys are kept in Postgres, per caller, for a day

* **Context:** a client whose request times out cannot tell whether it ran. Retrying `orderCreate`
  could place the order twice, and retrying `orderRefund` could record a refund twice. The API plan
  makes an `Idempotency-Key` header mandatory for order, refund and fulfilment mutations ([08 · API
  §1.1](./08-api-and-app-platform.md#11-conventions)). A mutation's work can span several
  transactions (a bulk action runs one per order), so the key cannot share one transaction with the
  work.
* **Decision:**
  * **The Admin API honours `Idempotency-Key` on any mutation, before GraphQL runs.** The key is
    claimed in `platform.idempotency_keys`, the request runs, and its answer, the HTTP status and
    body, is kept for 24 hours. A retry with the same key and the same request (query, operation
    name and variables, in any key order) gets that answer back, marked
    `Idempotent-Replayed: true`, whether it held data, user errors or an error.
  * **Keys belong to one shop and one caller:** an app's access token, or a staff member.
  * **Mistakes are refused, not guessed at.** The same key with a different request gets `422`;
    a retry while the first request still runs gets `409`. A request that dies holds its key
    for a minute at most, then a retry runs it.
  * **Mutations that must not run twice need a key** (`400` without one): `orderCreate`,
    `orderFulfill`, `orderRefund` and `inventoryAdjustQuantities`. Resolvers say so with
    `@RequireIdempotencyKey()`. Mutations that are safe to repeat, such as confirming or
    cancelling, accept a key but need none; queries ignore it.
* **Consequences:**
  * A retry after a timeout never does the work twice while the answer is kept.
  * Each request with a key costs two small transactions, before and after it runs.
  * A kept answer can hold a customer's details for up to a day; erasing the customer does not
    reach it.
  * If the process dies after the work commits but before the answer is kept, a retry more than
    a minute later runs again. Closing that gap would need the key in the transaction of the
    work, which single-transaction mutations could do later.
* **Alternatives:**
  * Valkey with a time-to-live: fewer writes to Postgres, but tests and development would need
    it too, and a flush would forget keys whose work had happened.
  * An `idempotencyKey` argument on each mutation, as some newer Shopify mutations take: visible
    in the schema, but every service would repeat the check that one hook does here.
  * Keys per shop rather than per caller: two apps choosing the same key would collide, and one
    could read the other's answer.

## ADR-031 · Draft orders keep agreed prices and hold no stock; customers confirm them through a secret link

* **Context:** many Pakistani orders are agreed in Instagram and WhatsApp chats: the customer
  picks items, a price is agreed, and the address comes later. Staff type such orders in by hand
  and then call to confirm cash on delivery, and some customers never answer ([05 · Checkout
  §7](./05-checkout-and-payments.md#7-payment-links-draft-orders-and-social-selling), ORD-03).
  There is no storefront or checkout yet, no payment gateway (spike 4), and no WhatsApp or SMS
  sending (spike 3).
* **Decision:**
  * **A draft order keeps its items at the prices agreed, and holds no stock.** A line's price is
    fixed when it is added: the price given, or the variant's price then. Placing the draft
    commits its stock as any order does, so an item that sold out fails then, and the draft
    stays open.
  * **Staff place a draft** with `draftOrderComplete`, as `orderCreate` would place it: a
    cash-on-delivery order then waits for confirmation. **Or they send the customer a link**
    (`draftOrderLinkCreate`) to a page with the items, the total and the address, where the
    customer confirms: the draft becomes an order the customer confirmed, unless the number is
    blocked or the order risky, which waits for review as any order does.
  * **A link is a secret of 128 random bits, kept only as a SHA-256 digest.** It works for 72
    hours unless set otherwise (1 to 720), and a draft has one at a time: a new link replaces the
    old. A `SECURITY DEFINER` function finds a link's shop and draft, as access tokens are found.
    Only a cash-on-delivery draft with an address gets a link, and a draft that stops being one
    loses it (since [ADR-034](#adr-034--customers-add-a-drafts-address-and-their-number-while-it-has-none-through-its-link), any cash-on-delivery draft: its page asks for the
    address).
  * **The core API serves the page at `/d/<secret>`, under `PUBLIC_URL`**, until the storefront
    exists. A GET only shows it; a POST confirms, carrying the version of the draft the page
    showed (since [ADR-032](#adr-032--customers-confirm-or-cancel-cash-on-delivery-orders-through-a-link-that-then-follows-the-order),
    a digest of what the page showed), so a link preview never places an order, and a draft that
    changed after the customer opened the page is shown to them again. The page runs no scripts, and is sent with a
    content security policy that allows only its own styles (by hash) and Google Fonts, never
    cached, indexed or framed, and with `Referrer-Policy: no-referrer`, since its address is the
    secret. The customer's number is masked on it; the address is whole, for them to check.
  * **An order confirmed through a link is placed by the system**, as its timeline and the stock
    history record, with the draft named in its timeline.
  * **The page has no rate limit of its own.** Secrets cannot be guessed, an unknown one costs
    one indexed lookup, and limits per client address would misfire behind the carrier-grade NAT
    of Pakistani mobile networks. Floods are for the edge to stop.
* **Consequences:**
  * Staff stop retyping orders from chats, and a customer who confirms through the link needs no
    confirmation call.
  * Stock can sell out between sending a link and the customer confirming: the page names the
    item, the customer asks the shop, and the draft stays open.
  * Drafts hold customers' details without naming a customer, so erasure finds them by the
    customer's numbers and email, and through their orders; the customers module now hands
    those to modules taking part in erasure.
  * Anyone holding a link sees the customer's name and address until it expires.
* **Alternatives:**
  * Reserving stock for a draft, as Shopify offers: a chat can go quiet for days, and the units
    held would stop other sales. It could come later as an option, with an expiry.
  * Drafts as orders in a draft state: every order list, count, export and report would have to
    leave them out. Shopify keeps them apart too.
  * Payment links now: they need gateways (spike 4). A draft paid by bank transfer is completed
    by staff once the money is in.
  * The storefront serving the page: it does not exist yet. The page can move there, under the
    shop's own domain, with the same paths.

## ADR-032 · Customers confirm or cancel cash-on-delivery orders through a link that then follows the order

* **Context:** a cash-on-delivery order waits for its customer to confirm it before it ships, and
  the confirmation sequence ends in a tap-to-confirm link, sent by SMS when WhatsApp fails ([06 ·
  Orders §3](./06-orders-fulfillment-logistics.md#3-order-confirmation), COD-02). Draft orders
  have such a link already ([ADR-031](#adr-031--draft-orders-keep-agreed-prices-and-hold-no-stock-customers-confirm-them-through-a-secret-link)).
  Messaging, which would send it, is spike 3. Customers also change their minds, and hearing so
  before a parcel ships saves a return.
* **Decision:**
  * **Any open order can get a link** (`orderLinkCreate`), made and kept as a draft's is: a
    secret of 128 random bits, kept only as a digest, working for 72 hours unless set otherwise,
    one at a time. Staff send it themselves for now; the confirmation sequence will send it
    later. Making one goes on the order's timeline and is an `order.updated` event, since the
    link shows the customer's address.
  * **While a cash-on-delivery order waits for its customer** (pending or no response, nothing
    shipped), the page at `/o/<secret>` offers to **confirm** it or **cancel** it. Confirming
    confirms it. Cancelling asks first, on a page (`?cancel`) that changes nothing, then cancels
    it because the customer asked, records its confirmation as rejected, and releases its stock.
    Both go on the timeline as the customer's doing, through the system.
  * **After that, the page follows the order:** confirmed, on its way with the courier and
    tracking number, delivered, not delivered, or cancelled. An order held for review, or placed
    by staff and not confirmed yet, reads "the shop will be in touch", as for drafts. A customer
    who tries to cancel an order that has moved on is told to ask the shop.
  * **A post carries a digest of what the page showed**, not the record's version: the items,
    the amounts and the address, with the number masked. A change the customer could see still
    sends them back to look again; notes, tags or a new link no longer do. Drafts' links work the
    same way now.
* **Consequences:**
  * The tap-to-confirm step exists before messaging does; the confirmation sequence only has to
    send the link.
  * A customer who declines costs the shop a cancelled order rather than a parcel sent back, and
    the order's stock is free again at once.
  * Whoever holds a forwarded link can confirm or cancel the order until it expires; the timeline
    says it happened through the link.
  * Following a parcel for longer than the link works takes a new link, until the order status
    page (05 §8) gives orders a lasting one.
* **Alternatives:**
  * Links only for orders waiting to be confirmed: the page has to show what became of the order
    when the customer comes back anyway, and a page that follows the order is the start of the
    order status page.
  * Cancelling with one tap: a slip of the thumb would cancel an order; asking first costs one
    more tap.
  * Keeping the version in the form: staff noting or tagging orders while customers read their
    pages would send those customers back to confirm again.

## ADR-033 · Customers correct an order's address through its link until it is packed; the number stays the shop's

* **Context:** the confirmation message offers "Confirm / Cancel / Change address" ([06 · Orders
  §3.1](./06-orders-fulfillment-logistics.md#31-channels-and-policy)), and a wrong or incomplete
  address is a common reason parcels come back. Orders' links
  ([ADR-032](#adr-032--customers-confirm-or-cancel-cash-on-delivery-orders-through-a-link-that-then-follows-the-order))
  let customers confirm or cancel; correcting the address still took a message to the shop and
  staff retyping it.
* **Decision:**
  * **Until an order is packed, its link's page offers to change the address**, on a page of its
    own (`?address`) filled in as the address is: name, house and street, landmark, city,
    province and postcode. Saving it (`action=address`) runs the checks and the update behind
    staff's `orderUpdate`: the city spelled the standard way, the province from the city unless
    one is picked, and a cash-on-delivery order scored again for its new address, held for
    review if that makes it risky. The timeline says the customer changed it through their link,
    and the page then says the address is saved.
  * **Packed is the cutoff, not shipped:** a packed parcel may carry the old address on its slip.
    After that, and for a cancelled order, the page tells the customer to ask the shop.
  * **The number is not the customer's to change here.** The page shows it masked, as these pages
    do everywhere, since links get forwarded; a form holding it would show it whole. A new number
    would also make the order another customer's, perhaps a blocked one: that is for staff.
  * **The form carries the digest of what the page showed**, as confirming does, so a customer
    never saves over a change the shop made while they typed. An address that does not check out
    comes back as typed, with what is wrong under each field, in English and Urdu.
  * **Confirming is not undone:** a customer who confirmed and then corrects the address stays
    confirmed, since they have just said where the order goes.
* **Consequences:**
  * Customers fix their own addresses before anything ships, without a call, and the
    confirmation message's third button has its page.
  * Staff see the change on the timeline and as an `order.updated` event. A shop that prints
    slips before marking orders packed can still pack a parcel with the old address; marking
    orders packed as their slips print closes the gap.
  * Whoever holds a forwarded link can redirect the parcel until it is packed, as they could
    cancel the order before; the timeline says it happened through the link, and the number the
    courier calls stays the customer's.
* **Alternatives:**
  * Changes until the parcel ships, as staff can make them: by then it may be packed and
    labelled.
  * Letting the customer change the number too: the page would have to show it whole, and the
    order would move to another customer.
  * Asking the customer to confirm again after a change: they have just said where it goes.
  * A correction request for staff to apply: staff would retype it, which the link avoids.

## ADR-034 · Customers add a draft's address, and their number while it has none, through its link

* **Context:** in a chat the items often come first and the address later: customers type it in
  pieces, and staff copy it into the draft before they can send its link
  ([ADR-031](#adr-031--draft-orders-keep-agreed-prices-and-hold-no-stock-customers-confirm-them-through-a-secret-link)).
  Customers can now correct an order's address on its link ([ADR-033](#adr-033--customers-correct-an-orders-address-through-its-link-until-it-is-packed-the-number-stays-the-shops)).
* **Decision:**
  * **Any cash-on-delivery draft gets a link, with or without an address.** Without one, the page
    shows the order and asks for the address before it can be confirmed, and the link's message
    asks the customer to add it. A draft that loses its address keeps its link; one that stops
    being cash on delivery loses it, as before.
  * **The form is the order link's**: the same checks, sent back as typed with what is wrong, and
    carrying the digest of what the page showed. It also asks for the customer's **mobile number
    while the draft has none**: they type their own, so the page shows nothing they did not give.
    Once the draft has a number, from them or from staff, the form shows it masked and a new one
    is for the shop.
  * **The customer can correct the address until they confirm**, and after that, through the
    same link, the order's address until it is packed, as on an order's link.
  * **A draft records that the customer changed it:** its `draft_order.updated` event names the
    address and says `byCustomer`. Drafts have no timeline; the order placed from one does.
* **Consequences:**
  * Staff send the items and the total, and customers fill in the rest in fields a courier can
    use, with the city spelled the standard way: nobody copies addresses out of chats.
  * Whoever holds a link sent without an address can give any address and number. The order it
    places is checked when it is confirmed, as any order is: a blocked number or a risky order
    waits for review, and the courier calls that number before delivering.
  * One link serves the order taken in a chat from the items to the parcel's doorstep.
* **Alternatives:**
  * The address in the chat, as before: slower, and retyped by staff.
  * One form that saves the address and confirms at once: the customer would confirm an address
    before seeing it as the shop will, with the city spelled the standard way and the province
    worked out.
  * Customer accounts with saved addresses: they need sign-in by one-time code, which Hatti does
    not have yet; the link needs none.

## ADR-035 · The storefront renders Liquid with limits of its own, fetching lists a chunk at a time

* **Context:** themes are Liquid, with JSON templates
  ([ADR-006](#adr-006--liquid-compatible-theme-engine-with-json-templates)), rendered at origin
  in 250 ms or less at p95 on a cache miss, each render held to 150 ms of CPU, 5,000 loop
  iterations and 2 MB of output, with drops batching their fetches per request
  ([04 · Storefront §3.3](./04-storefront-and-themes.md#33-rendering-pipeline)). Spike 1 built a
  renderer and a Dawn-class reference theme to test it
  ([report](../engineering/spikes/01-liquid-rendering.md)).
* **Decision:**
  * **LiquidJS is the engine** (MIT, pure JavaScript), with Hatti's tags and filters for
    Shopify's (`section`, `sections`, `schema`, `style`, `form`, `paginate`; `money`,
    `image_url`, `image_tag`, `t` and more) and Hatti's extensions (`money_pk`, `whatsapp_url`,
    `direction`, `cod`).
  * **Every render has limits of Hatti's own:** a section's, and the layout's. A limiter LiquidJS
    consults before each template node counts nodes (50,000; they stand in for loop iterations,
    since a loop counts its body on every pass) and watches the clock (150 ms); an emitter caps
    output (2 MB); snippets go 32 deep; LiquidJS's own memory limit bounds ranges. A section over
    a limit, or failing, is left out and logged, and the page is sent without it.
  * **Templates get plain objects**, and LiquidJS runs with `ownPropertyOnly` and `strictFilters`.
    Drops only where lookups are by name (`collections['sale']`) or lists fetch on first touch.
  * **Lists fetch a chunk at a time**, 12 products when a template first touches one, not batched
    by the tick: LiquidJS evaluates one expression at a time, so DataLoader would fetch each
    product in its own round trip. What a page will certainly need (its product or collection,
    sections' resource settings, the shop) is asked for before rendering.
  * **A page's sections render side by side**, those its layout names too, and the layout last.
* **Consequences:**
  * Pages of the reference theme render in 2 to 6 ms at p50, and one process renders about 260
    a second: rendering is not what the storefront's latency will be made of.
  * The node count bounds CPU the same whatever renders beside a section; the clock includes
    waits for data and the work of sections rendering alongside, so it is the backstop.
  * The limiter goes in through LiquidJS's `Context`, which is public but little used: the
    version is pinned, and tests go over every limit.
  * Themes put `dir="auto"` on merchants' text, which may be English on an Urdu page.
* **Alternatives:**
  * Shopify's Liquid in Ruby, or a Rust or WebAssembly port: another runtime beside Node, for
    rendering that already takes a few milliseconds.
  * Handlebars or a template language of our own: faster to sandbox, but no Liquid developer or
    Shopify theme could use it, which is the point of ADR-006.
  * Worker threads or isolates per render, for a true CPU limit: they would cost more than the
    renders; to revisit if apps' Liquid, which merchants do not write, proves abusive.

## ADR-036 · One publisher per shop rebuilds storefront documents from the database, its writes fenced by its lock

* **Context:** the storefront renders from documents in Valkey, rebuilt on catalog and stock
  events ([03 §8](./03-multi-tenancy-and-data.md#8-read-models--caching)). Events arrive at
  least once and in no set order, several at a time in each worker process. A bulk edit of 500
  products sends 500 events, and a smart collection's listing may change with any product.
* **Decision:**
  * **Events say what is stale, not what it is now.** Each maps to items: `product:<id>`,
    `collection:<id>`, `all-products`, `menus` and `shop`, and items standing for many
    (`collections-with:<product>`, `smart-collections`, `every-collection`, `every-product`,
    `everything`). They wait in a sorted set per shop; adding one already waiting changes nothing.
  * **Documents are built from the database as it is then**, never from events' payloads, so
    order and repeats do not matter.
  * **One publisher per shop at a time**, holding the shop's lock in Valkey (15 seconds, kept while
    it works). It takes 100 items at a time, those standing for many first, then products and the
    shop, then listings, then menus, so a listing seldom names a product not written yet. Other
    publishers add their items and return; the holder builds them before it lets go, and looks
    once more after. A batch is kept aside until built: put back if its build fails, and by the
    next holder if its publisher stopped.
  * **Writes are fenced:** each is a script that first checks the lock is still the writer's, so
    a publisher that stalled past its lock cannot write over what its successor built from newer
    data.
  * **Handles are indexes of their own**, a hash of IDs by handle and one of handles by ID. A
    document lets go of its old handle only if the handle still leads to it, so products that
    swap handles, or one built before another gives its handle up, keep the right ones.
  * **A shop without documents gets all of them** on its next event; the seed publishes its shop
    at once. Building everything also takes off documents whose rows went without an event.
* **Consequences:**
  * An edit through the Admin API showed on the storefront about 220 ms later, locally, through
    the outbox, the queue and the worker.
  * A burst of edits is built about once, not once per event, and a shop's build holds one worker
    slot while others go on with other shops.
  * An edit that can move a product in or out of listings, or reorder them, rebuilds the shop's
    smart collections, the collections holding it, `/collections/all` and the menus. Changing only
    a description, handle or images rebuilds the product alone.
  * A listing keeps all its product IDs in one document, read whole for each page of it: fine for
    thousands of products, not a hundred thousand.
  * Documents are overwritten in place, each write atomic, without 03 §8's versioned keys; the
    edge cache will carry versions, per theme version and locale.
* **Alternatives:**
  * Rebuilding in each event's handler: a bulk edit would rebuild the shop's listings once per
    product, and handlers racing each other could leave older documents last.
  * A BullMQ job per shop, deduplicated by its ID: the ID stays taken while the job runs, so
    events arriving as it finishes would be dropped. BullMQ Pro's groups would serve, at a price.
  * Comparing versions per document: stock changes do not change a product's version, and
    listings have none.
  * Change data capture into the documents: another system to run before the outbox is
    outgrown ([ADR-005](#adr-005--transactional-outbox--bullmq-first-kafka-compatible-log-later)).

## ADR-037 · Every shop has a handle naming its storefront on the platform's domain; storefronts find shops through a directory in Valkey

* **Context:** one storefront process has to serve every shop in its cell, each at its own
  address: `{handle}.hatti.pk`, or a domain of the shop's own through Cloudflare for SaaS
  ([04 §2.1](./04-storefront-and-themes.md#21-hostname-routing)). In production the edge will look
  hosts up in a copy of the shop directory and tell the cell which shop a request is for. Until the
  edge and the control plane exist, the storefront has to find the shop itself, and it reads only
  Valkey ([ADR-036](#adr-036--one-publisher-per-shop-rebuilds-storefront-documents-from-the-database-its-writes-fenced-by-its-lock)).
* **Decision:**
  * **Every shop has a handle** in `control.shops`: a lowercase DNS label of up to 40 characters
    with no double hyphen, unique across the platform, given when the shop is made and not changed
    by the shop. Request code may rename its shop; the handle, status, currency and time zone are
    the control plane's. Until the control plane chooses handles with merchants, a shop made
    without one gets a random one (`shop-…`).
  * **The storefront reads the handle from the host**: `zari.hatti.pk` names `zari`. It finds the
    shop in a hash of shops by handle in Valkey, which the publisher writes with the shop's
    settings, for open shops only, and remembers each answer for a few seconds. The platform's
    domain itself shows the sample shop in development; any other host gets a 404 until shops
    have domains of their own.
  * **The Admin API gives a shop's handle and storefront address** (`shop { handle url }`), from
    `STOREFRONT_URL`, the address of the platform's storefronts, which production requires.
* **Consequences:**
  * `pnpm dev:storefront` serves every published shop at `http://{handle}.localhost:4100/`:
    browsers and curl send `*.localhost` to this machine without setting anything up.
  * A suspended or closed shop's storefront stops answering the next time its shop is published;
    nothing publishes it when its status changes yet, since the control plane has no events.
  * Every storefront request asks the directory, answered from memory for five seconds: a new
    shop can take that long to appear.
  * Handles are platform-wide, so two cells cannot give out the same one: the control plane, which
    spans cells, will own them.
* **Alternatives:**
  * The shop's ID in the host or path: stable, but no merchant would print it on a card.
  * The storefront reading `control.shops` from Postgres: a database connection per storefront
    process and a query per request, where Valkey already holds everything else it reads.
  * Resolving hosts only at the edge: right for production, but development and tests would need
    a Worker running before they could see a shop.

## ADR-038 · An order's link lasts until 30 days after the order ends

* **Context:** an order's link works for 72 hours unless staff choose otherwise
  ([ADR-032](#adr-032--customers-confirm-or-cancel-cash-on-delivery-orders-through-a-link-that-then-follows-the-order)),
  but a cash-on-delivery parcel can take a week to arrive, and longer to come back; the order status
  page (05 §8) is meant for following it the whole way. The link shows the customer's address, so
  it should not work for ever.
* **Decision:**
  * **By default an order's link has no expiry of its own**: it works while the order is open, and
    for 30 days after the order is closed or cancelled. Staff may still make one expire after 1 to
    720 hours; it then stops at that time, or 30 days after the order ends if that comes first.
  * **What the customer may do keeps its own window**: confirm or cancel while the order waits for
    them, correct the address until it is packed. Only watching lasts.
  * **The page tells the customer to keep the link** where it would have shown when it stops
    working. The Admin API gives an order's `customerLink`, whose `expiresAt` is null while a
    lasting link's order is open, replacing `linkExpiresAt`.
  * Drafts' links keep their 72 hours: a draft waits for a quick answer, and its order gets a link
    of its own.
* **Consequences:**
  * One link sent when the order is placed serves the customer from confirming to delivery, and a
    return after.
  * A forwarded link shows the order, with the address and a masked number, for as long; erasing
    the customer's details still takes it.
  * Orders that stay open for months keep their links working; closing or cancelling them ends
    that 30 days later.
* **Alternatives:**
  * A longer fixed expiry, such as 30 days from the link: still too short for an order held for
    review, and needlessly long for one delivered the next day.
  * A second, read-only link for following the order: two links for customers to tell apart,
    where one whose actions end on their own suffices.

## ADR-039 · A shop's theme is a platform theme with the shop's own JSON files over it

* **Context:** themes are Shopify's shape: Liquid layouts, sections and snippets, JSON templates
  and settings ([ADR-006](#adr-006--liquid-compatible-theme-engine-with-json-templates),
  [04 §3](./04-storefront-and-themes.md#3-theme-architecture)). Merchants change their home page,
  their colours and their announcement first; the visual editor (OS-02) saves exactly those. A
  code editor that lets them change Liquid comes later (OS-04, V1), after Theme Check.
* **Decision:**
  * **A shop's theme is a platform theme, Hatti Base for now, with the shop's own files over it**:
    JSON only, its templates (alternates such as `product.unstitched` too), section groups and
    `config/settings_data.json`. Liquid, assets and translations stay the platform theme's.
  * **The main theme is the one the storefront shows.** Others are prepared and then published in
    its place (`themeCreate` copying the main one, `themeFilesUpsert`, `themePublish`); a shop
    keeps up to 20. The main one is made on first use, with no files of the shop's own.
  * **Every change raises the theme's version**, and `theme.updated` or `theme.published` tells
    the storefront's publisher.
  * **The storefront reads the main theme from a document of its own**, which the publisher
    writes with the shop's document and before it, from one read
    ([ADR-036](#adr-036--one-publisher-per-shop-rebuilds-storefront-documents-from-the-database-its-writes-fenced-by-its-lock)).
    The shop's document names the theme's version; a storefront lays each version over the
    platform theme once, and keeps it for the pages after, up to 64 MB of shops' files a
    process.
  * **Files are checked when saved**: for their shape (JSON, sections listed in their order,
    blocks, IDs of letters, digits, `_` and `-`, at most 25 sections, 50 blocks a section and
    256 KB a file), then by Theme Check against the platform theme, as the storefront would read
    them: the sections, blocks and settings they name, blocks' limits, and each setting's value
    against its type. A file with a problem is refused, with what is wrong and where. Theme Check
    is in `@hatti/themes`, the code the storefront reads themes with, so the two cannot disagree.
    The storefront still leaves out a file it cannot use, and holds each setting to its type, the
    default taking the place of a value that is not, for files saved before a platform theme
    changed.
  * **The Admin API follows Shopify's**: `themes`, `theme`, `themeCreate`, `themePublish`,
    `themeDelete`, `themeFilesUpsert` and `themeFilesDelete`, under `read_themes` and
    `write_themes`, which owners and managers have.
* **Consequences:**
  * A fix or a new section in the platform theme reaches every shop at once; a shop keeps only
    what it changed.
  * Nothing a shop saves runs as code, so its storefront stays within the renderer's limits
    whatever it saves; and nothing it saves ends a style or an attribute the theme prints it in.
  * A change replaces the file before it: versions to roll back to and scheduled publishing
    (04 §3.4, OS-03) are to come.
  * A platform theme that drops a section or a setting leaves shops' files that name it: the
    storefront leaves those files out, and saving them again is refused until they no longer
    name it. The platform theme keeps what shops use, or moves their files on itself.
* **Alternatives:**
  * Copying the whole platform theme into each shop, as Shopify does: every fix to the platform
    theme would need merging into every shop's copy.
  * Settings only, without templates: the home page's sections are what merchants change most.
  * Checking files only in the storefront: a merchant would find a page no longer showing their
    change, and no reason.
  * Liquid from shops now: the renderer's limits would hold it, but Theme Check reads only JSON
    files so far, so nothing would tell a merchant what their Liquid broke.

## ADR-040 · A shop's menus are kept whole, linking to collections and products by ID

* **Context:** themes show menus by handle, as `linklists['main-menu']`. Merchants arrange them
  as in Shopify's navigation editor: items nested up to three levels, each linking to a
  collection, a product, a page or an address. Until now the storefront's menus were made from
  the shop's collections.
* **Decision:**
  * **A menu's items are one JSON tree, saved whole** (`online_store.menus.items`), as Shopify's
    `menuUpdate` replaces all of them: three levels deep, at most 250 items and 200 KB.
  * **Links to collections and products name them by ID**, and take their current handles when
    read. The Admin API gives each item's `url`; the storefront leaves out a link to what it
    cannot show, gone or not active, with the links under it.
  * **Every shop has a main menu and a footer menu**, which keep their handles and are not
    deleted. They are made the first time the shop looks at its menus, from what its storefront
    showed until then: its first five collections with products, by title, then all products.
    Until then the storefront's menus follow its collections as they change.
  * **Links go to the home page, all products, a collection, a product or an address**
    (Shopify's `FRONTPAGE`, `CATALOG`, `COLLECTION`, `PRODUCT` and `HTTP`); the other kinds come
    with pages, blogs and search. An address is a path on the storefront, or a web, mail or phone
    address, with nothing that could end the attribute a theme prints it in: checked when saved,
    and again by the storefront.
  * **The Admin API follows Shopify's**: `menus`, `menu`, `menuCreate`, `menuUpdate` and
    `menuDelete`, under `read_online_store_navigation` and `write_online_store_navigation`, which
    owners and managers have. `menu.created`, `menu.updated` and `menu.deleted` tell the
    storefront's publisher, which writes all of a shop's menus as one hash, so a deleted menu
    goes.
* **Consequences:**
  * Menus stay right as the catalog changes: a collection's new handle, or a product taken off
    sale, needs no menu edit. The publisher reads the collections and products menus link to
    when it builds them, and builds menus again when a product's handle changes.
  * Saving a menu replaces it: of two people editing one menu at once, the last save stands.
* **Alternatives:**
  * A row per menu item: Shopify's API edits a menu whole, and menus are small.
  * Links kept as addresses, as the storefront prints them: a collection's new handle would
    break every menu linking to it.
  * Default menus made with every shop: shops made before menus would need them too, and made on
    first use they come from what the shop's storefront already showed.

## ADR-041 · What a shop sets for its storefront as a whole is the online store's, starting with its WhatsApp number

* **Context:** Pakistani shoppers ask and order on WhatsApp, so Hatti Base's product pages offer
  "Order on WhatsApp" and its home page a WhatsApp section, both needing the shop's number. The
  shop directory (`control.shops`) belongs to the control plane, which replicates it read-only
  into cells, so settings a shop edits every day do not belong there.
* **Decision:**
  * **The online store module keeps a shop's storefront preferences**, a row per shop once it
    sets any (`online_store.preferences`), as the orders module keeps its risk settings. The
    first is the WhatsApp number; the storefront's title, description and password would join
    it.
  * **The number is a Pakistani mobile, kept in E.164**, given in any common format; blank takes
    it away.
  * **The Admin API has `onlineStorePreferences` and `onlineStorePreferencesUpdate`**, under the
    settings scopes owners and managers have. Only the preferences given change, and
    `online_store_preferences.updated` tells the storefront's publisher, which writes the number
    into the shop's document.
* **Consequences:**
  * The storefront shows a shop's number a moment after it is set, and nothing where it has none.
  * The number is the shop's to give: nothing checks that it is on WhatsApp until the shop
    connects its WhatsApp account (MSG-02).
* **Alternatives:**
  * A column in `control.shops`: request code would write to the control plane's copy.
  * A setting in the theme's settings: it would change with the theme, and apps and the admin
    would have to find it there.

## ADR-042 · Carts are kept by the core and priced whenever they are read; storefronts change them with a key of their own

* **Context:** carts are the first thing shoppers write; until now a storefront only read
  documents in Valkey
  ([ADR-036](#adr-036--one-publisher-per-shop-rebuilds-storefront-documents-from-the-database-its-writes-fenced-by-its-lock)).
  Themes change carts through Shopify's cart forms and Ajax cart (`/cart/add`, `/cart/change`,
  `/cart/update`, `/cart/clear`, `/cart.js`) on the shop's domain, the cart named by a cookie,
  and Dawn's cart drawer asks for sections rendered after each change. Checkout starts from a
  cart and prices everything again on the server
  ([05 §1](./05-checkout-and-payments.md#1-principles)).
* **Decision:**
  * **The core keeps carts**, in the checkout module's `checkout.carts`: a row per cart, its
    lines as JSON (a variant, a quantity and what the shopper typed), with the cart's note and
    attributes. A cart holds no prices or titles: the catalog and inventory are read whenever it
    is, in the same transaction, so it always shows today's prices.
  * **A cart is found by a secret**, 128 random bits in the shopper's cart cookie, of which the
    core keeps only the SHA-256, as for customers' links. A secret naming no cart, as once it
    expired, is never taken up: the next change makes a new cart with a secret of its own. A cart
    lasts 14 days after its last change; expired carts are deleted as the shop gets new ones.
  * **Carts behave as Shopify's do**: adding a variant with the same properties adds to its line;
    new lines go first; `change` names a line by its key, its variant or its place; `update` adds
    variants the cart lacks; `clear` keeps the note and attributes. A cart has at most 100 lines
    and 10,000 units a line, as an order. A change that would give the cart more of a variant
    than can be sold online is refused; a line whose stock ran out after it was added stays,
    saying how many can be bought, for checkout to deal with. Lines whose product is gone or no
    longer active are left out, and leave the cart at its next change.
  * **The storefront fronts carts; the core keeps them.** The storefront serves every path of a
    shop's domain, `/cart` too, since the cart page and the sections the Ajax cart asks for are
    the theme's: it turns Shopify's forms and Ajax calls into the core's actions, and renders the
    answers. The core's routes under `/storefront/` answer only storefronts, which present the
    platform's storefront key and name the shop they found by host. `@hatti/storefront-api`
    holds what the two say to each other, and the client.
  * **Refusals are codes with their facts**, such as `MAX_QUANTITY` with the most that can be
    bought: the storefront words them in the shopper's language.
* **Consequences:**
  * A cart change is one short transaction on the core, and a cart page one request to it;
    neither is cached. The edge (04 §2) sends cart paths to the storefront uncached, rather than
    to a storefront API pool.
  * Limits on how fast a shopper can change carts are the storefront's, which sees their
    address.
  * Pages stay the same for every shopper: the cart page alone shows the cart, and other pages
    show its count from a cookie the storefront sets beside the cart's secret, which scripts
    cannot read.
  * Lines kept as JSON cannot be searched across carts; abandoned checkouts, which will have rows
    of their own, carry what recovery needs (CHK-12).
* **Alternatives:**
  * Carts in Valkey, written by the storefront: it would need prices and stock, which its
    documents leave out on purpose, and a cart would be lost with the cache.
  * A row per line: more statements per change, for nothing a cart needs yet.
  * The edge sending the Ajax cart straight to the core: its answers' `sections` need the theme,
    which only the storefront renders.
  * Shopify's GraphQL Storefront API for carts now
    ([ADR-008](#adr-008--graphql-for-public-admin-and-storefront-apis)): a second schema in the
    core for one caller. It comes with headless storefronts (04 §7), on the same service.

## ADR-043 · A shop charges for delivery once for everywhere, by zones of cities, and not at all from a subtotal

* **Context:** most Pakistani shops charge shoppers a flat delivery fee, often less in their own
  city, and nothing above an order value, whatever the courier charges them. Checkout adds it
  ([05 §3](./05-checkout-and-payments.md#3-cart--pricing-calculation-pipeline), step 4), and
  shoppers should see it before checkout, not at the last step (05 §1). CHK-04's MVP half is
  city-group zones, a flat charge and a free threshold.
* **Decision:**
  * **The checkout module keeps what a shop charges for delivery**
    (`checkout.delivery_settings`, a row per shop once it sets any): one charge for everywhere,
    up to 20 zones of cities with charges of their own, and a subtotal from which delivery is
    free. Zones are saved whole, as a shop edits them together.
  * **Zones name cities as addresses do**, through `@hatti/pk`'s cities and their aliases
    ("khi", "Pindi"), each city in one zone. A city the list lacks takes the charge for
    everywhere.
  * **`deliveryCharge(settings, city, subtotal)` is the one rule**: nothing from the free
    subtotal, else the charge of the city's zone, else the charge for everywhere. Checkout adds it
    for the delivery address's city.
  * **The Admin API has `deliverySettings` and `deliverySettingsUpdate`**, under the settings
    scopes owners and managers have. `delivery_settings.updated` tells the storefront's
    publisher, which puts the charges in the shop's document, and themes show them (Liquid's
    `delivery`): "Free delivery on orders of Rs 5,000 or more", "Add Rs 500 more for free
    delivery".
* **Consequences:**
  * A shop that set nothing delivers free, and its storefront says nothing of charges.
  * Rates by weight or value, couriers' own rates, local delivery and pickup (CHK-04's V1 half)
    come with shipping profiles, in the fulfilment context, which may take these settings over.
* **Alternatives:**
  * Shopify's delivery profiles, with rates per product group, zone and condition: far more than
    shops here set, and a shop's profile can grow from these settings later.
  * A row per zone: more to keep consistent, for no query that needs it.
  * The charges in the online store's preferences: what an order costs is checkout's.

## ADR-044 · Checkout is one page the core renders and storefronts serve on the shop's address, placing a cash-on-delivery order as the page showed it

* **Context:** shoppers fill carts the core keeps
  ([ADR-042](#adr-042--carts-are-kept-by-the-core-and-priced-whenever-they-are-read-storefronts-change-them-with-a-key-of-their-own)),
  shops set what delivery costs
  ([ADR-043](#adr-043--a-shop-charges-for-delivery-once-for-everywhere-by-zones-of-cities-and-not-at-all-from-a-subtotal)),
  and the orders module places orders with their stock committed, their customer found by
  number, the blocklist and the COD risk score applied
  ([ADR-025](#adr-025--order-risk-is-a-snapshot-taken-when-an-order-is-placed-or-re-addressed)).
  Checkout joins them: one page, phone first, that works without scripts (CHK-01, CHK-19),
  recomputes everything on the server and never places an order twice
  ([05 §1](./05-checkout-and-payments.md#1-principles)). Shopify's checkout is its own
  application, not the theme's, on the shop's domain.
* **Decision:**
  * **A checkout is a row with a secret of its own** (`checkout.checkouts`): the cart form's
    `checkout` button, or `/checkout`, has the storefront ask the core for one
    (`POST /storefront/shops/{shop}/checkouts`, with the cart's secret). The core keeps the
    SHA-256 of 128 random bits, the cart it checks out and, once placed, the order. It lasts 24
    hours, its thank-you page with it; a shop's new checkout deletes up to 100 of its expired
    ones. Nothing the shopper types is kept until the order has it.
  * **The page is the core's**, rendered as customers' links' pages are: HTML without scripts,
    in English and Urdu, with a strict Content-Security-Policy, never cached, indexed or framed.
    It shows the cart's lines at the catalog's prices now, with the properties shoppers see, and
    what delivery costs: exact once a city is typed or when every city costs the same, otherwise
    the shop's charges by city. Its form asks for a name, a mobile number, a city (the cities
    suggested as the shopper types), the house and street, an area or landmark, and a province
    only when the city does not give it. Cash on delivery is the only way to pay yet.
  * **Storefronts serve it on the shop's address**, `/checkouts/{secret}`: they fetch it from the
    core (`GET` and `POST /storefront/shops/{shop}/checkouts/{secret}`, JSON with its status,
    headers and HTML), for their own shop's checkouts only, and send it. The core serves the same
    page at its own address too. The shopper stays on the shop's address from cart to thank-you
    page, and the storefront, which keeps the cart's cookies, sets the count to 0 once the order
    is placed.
  * **The order is placed as the page showed it**, in one transaction: the form carries a digest
    of what the page showed (the lines with their prices, the note, the delivery charges). The
    core locks the checkout and the cart, prices the cart again, and places nothing if the digest
    differs: the page shows the cart as it is now, what the shopper typed kept. Then it checks the
    address as orders do, refuses lines that cannot be bought now, and places the order through
    the orders module: source `online_store`, cash on delivery, at the prices shown, with the
    delivery charge for the address's city (`deliveryCharge`), stock committed, the customer found
    or created by number, and the blocklist and risk score applied as for any order. Lines'
    properties go in the order's note. The checkout records the order, and the cart is emptied.
  * **Placing twice places one order**: the lock makes a second post, as from a double tap, find
    the order and show it, and another checkout of the same cart find it empty. A post that
    places the order redirects (303) to the page, so reloading it posts nothing.
  * **The shop confirms it as any other** cash-on-delivery order; the thank-you page says the
    shop will call or message to confirm it.
* **Consequences:**
  * Checkout works on any phone, without scripts, on the shop's address. The storefront relays
    one more route, and the edge (04 §2) passes `/checkout` and `/checkouts/` through uncached.
  * Shops cannot brand the page yet (CHK-14), and its links back to the shop go to its
    platform subdomain.
  * Until the page has scripts, a shop with zones shows its charges by city until the shopper
    types a city (05 §1, principle 3, in part).
  * Not yet: the OTP (CHK-09), the COD fee (CHK-08), COD rules (CHK-07), discounts (CHK-06),
    online payment (PAY-01), stock held during checkout, and capturing abandoned checkouts
    (CHK-12). Each has its place in the flow (05 §2).
* **Alternatives:**
  * A Liquid template in the shop's theme, as Shopify's `checkout.liquid` was: a theme could break
    the page that matters most, and Shopify retired it.
  * The page on the core's address alone: shoppers would leave the shop's address to order, and
    the storefront could not reset the cart's count once they had.
  * A copy of the cart's lines in the checkout, as Shopify's checkout object keeps: a second copy
    to keep in step, where the digest already makes the order what the page showed.
  * Reserving stock when checkout starts: fairer during drops, but reservations need expiry.
    Committing when the order is placed never sells a unit twice, and the page says what sold
    out.

## ADR-045 · A shop's pages keep HTML cleaned of anything that runs when saved; the storefront shows it as it is

* **Context:** every shop needs pages of its own: About us, Contact, and how it delivers and
  takes returns, which shoppers here read before paying cash to a shop they do not know (OS-07).
  Shopify keeps a page's body as HTML, which its editor writes, apps send and shops moving from
  Shopify bring, and themes print `page.content` as it is. Until now a shop could put nothing on
  its storefront that runs: its theme's files are JSON over the platform theme's
  ([ADR-039](#adr-039--a-shops-theme-is-a-platform-theme-with-the-shops-own-json-files-over-it)),
  and product descriptions are text. Checkout is served on the same address
  ([ADR-044](#adr-044--checkout-is-one-page-the-core-renders-and-storefronts-serve-on-the-shops-address-placing-a-cash-on-delivery-order-as-the-page-showed-it)).
* **Decision:**
  * **The online store module keeps a shop's pages** (`online_store.pages`): a title, a handle
    unique in the shop that names it at `/pages/{handle}`, made from the title as the catalog
    makes handles when none is given, a body of HTML up to 512 KB, when it was published (or null
    while it is hidden), and the theme's page template it asks for, as `page.contact.json`.
  * **A body is cleaned when it is saved**, with `sanitize-html` and a list of what may stay:
    text and its formatting, headings, lists, links to web, mail and phone addresses and to the
    storefront, images over http(s), tables, and where text sits and its colour. Scripts, style
    sheets, frames, forms, event handlers, `id`, `name` and `class`, and every other address go;
    the text of what goes stays. The API gives back the body as kept, so a shop sees what its
    storefront will show.
  * **The storefront shows it as it is**: the publisher writes each published page as a document
    found by its handle, as products are, and Hatti Base's `page` template prints `page.content`,
    as Shopify's themes do. Liquid has `page` and `pages['about-us']`, and settings of type `page`.
  * **The Admin API follows Shopify's**: `pages`, `page`, `pageCreate`, `pageUpdate` and
    `pageDelete`, under `read_online_store_pages` and `write_online_store_pages`, which owners,
    managers and marketers have: pages are the content marketers edit
    ([design 02 §6](../design/02-information-architecture.md#6-permissions--navigation-matrix-presets)). `page.created`, `page.updated` (naming what changed) and `page.deleted` tell the
    storefront's publisher.
  * **Menus link to pages by ID** (`PAGE`), as to collections and products
    ([ADR-040](#adr-040--a-shops-menus-are-kept-whole-linking-to-collections-and-products-by-id)):
    a link follows the page's handle, and leaves the storefront while the page is hidden or gone.
* **Consequences:**
  * A page can show nothing that runs, even for staff or apps that can write pages, so the
    storefront and the checkout on its address stay as safe as the platform theme makes them.
    What may stay is a decision on security: a tag or attribute added to the list is reviewed as
    one.
  * Shops cannot embed maps, videos or forms in pages yet: those come as sections or blocks of
    the theme, whose markup is the platform's.
  * A page is shown or hidden now: publishing at a time set in advance waits for scheduled
    publishing (OS-03). Pages are in one language until translations come.
* **Alternatives:**
  * Bodies as text, as product descriptions are: no headings, lists, links or tables, which
    policies and contact pages need.
  * Keeping the body as sent and cleaning it on the storefront: every render would clean, and
    the API would show what the storefront does not.
  * A rich-text JSON document, as Shopify's rich text metafields: safe by construction, but
    nothing that writes pages today, Shopify's API included, sends it.

## ADR-046 · Storefront search asks the core, which finds products in Postgres as the admin's search does, until Typesense

* **Context:** every storefront needs search (SRC-01). Shoppers here type what they want, often
  in Roman Urdu spelled many ways ("kameez", "qameez", "kamiz"), rather than browse collections.
  Search is planned on Typesense, with typo tolerance, facets and synonyms
  ([ADR-013](#adr-013--typesense-for-search-with-app-level-urduroman-urdu-normalisation)), from
  V1. Until then, the only search index for products is the catalog's own `search_text`: title,
  vendor, type and tags, folded by `searchKey` (Roman Urdu spellings, Urdu script), which the
  admin's product search already matches. Storefronts read products as documents from Valkey
  ([ADR-036](#adr-036--one-publisher-per-shop-rebuilds-storefront-documents-from-the-database-its-writes-fenced-by-its-lock)),
  and ask the core, with a key of their own, for carts and checkouts
  ([ADR-042](#adr-042--carts-are-kept-by-the-core-and-priced-whenever-they-are-read-storefronts-change-them-with-a-key-of-their-own)).
* **Decision:**
  * **Storefronts ask the core** at `GET /storefront/shops/{shop}/search?q=`, with the storefront
    key. The core answers with the IDs of up to 250 of the shop's active products that have every
    word typed, best first. It finds them in `search_text` as the admin's search does, folding the
    words the same way, and reads the first 200 characters and 10 words. The answer is never
    cached (`no-store`).
  * **Best first is simple:** first the products whose search text has the first word earliest,
    which puts matches in titles before vendors, types and tags, then the newest.
  * **The storefront renders the search page from the IDs.** `/search?q=` (and `/ur/search`)
    renders the theme's `search` template with Shopify's `search` object: `performed`, `terms`,
    `results_count`, `results` (products, each with `object_type` `product`) and `types`.
    `{% paginate search.results by 24 %}` pages it, and its links keep `q`. The storefront reads
    only the page shown from the product documents, as it does for collections
    ([ADR-035](#adr-035--the-storefront-renders-liquid-with-limits-of-its-own-fetching-lists-a-chunk-at-a-time)).
  * **When Typesense comes, it answers the same request in the core.** Storefronts, themes and
    the API between them stay as they are.
* **Consequences:**
  * Every shop has search now, with Roman Urdu spellings and Urdu script, without another service
    to run.
  * Search has no typo tolerance beyond what folding gives, no filters or facets (SRC-03) and no
    synonyms, and finds products only: pages and articles join the results with Typesense.
    Predictive suggestions as a shopper types come next.
  * `LIKE '%word%'` can use no index, so every search reads all of a shop's products. Measured on
    a development machine with a warm cache, that took about 3 ms for a shop of 10,000 products
    and 25 to 30 ms for 100,000. A trigram index (`pg_trgm`) is the step to take before Typesense
    if shops outgrow that.
  * Every search is a request to the core, as a cart change is. When the core cannot answer, the
    search page says so with a 503, and the rest of the storefront works as before.
* **Alternatives:**
  * **Typesense now:** another service to run and keep in step with the catalog, before shops need
    what it adds.
  * **An index in the storefront, built from the documents in Valkey:** every storefront process
    would hold every shop's index, or Valkey would need a search module that managed Valkey may not
    offer.
  * **Postgres full-text search (`tsvector`):** it stems English words, and Roman Urdu is not
    English. The folded key already matches what the admin's search matches.

## ADR-047 · The edge keeps storefront pages by the handles they name before they stream, and forgets those whose documents change

* **Context:** storefront pages are the same for every shopper: the cart's count comes from a
  cookie and the drawer asks for its own section, so the edge can keep pages
  ([04 §2.2](./04-storefront-and-themes.md#22-cache-key-and-cacheability)), in front of an origin
  that may be 100 ms away from Pakistan. Pages stream: their head is written before their sections
  render ([ADR-035](#adr-035--the-storefront-renders-liquid-with-limits-of-its-own-fetching-lists-a-chunk-at-a-time)),
  so their headers go before the page knows every document it reads. The publisher rebuilds
  documents as events come
  ([ADR-036](#adr-036--one-publisher-per-shop-rebuilds-storefront-documents-from-the-database-its-writes-fenced-by-its-lock)),
  often to what was stored already: a sale rebuilds a product whose availability did not change,
  and most product edits rebuild the menus.
* **Decision:**
  * **Pages are kept five minutes**: `public, max-age=0, s-maxage=300`, then shown while fetched
    again for a day (`stale-while-revalidate`), and for a week while the storefront cannot answer
    (`stale-if-error`). Search results and suggestions are kept a minute. The cart, checkout, the
    Ajax cart and sections rendered with a shopper's cart are `private, no-store`, and so are
    refusals and errors. Theme assets, whose address names the theme's version, are kept a year.
  * **Pages are tagged** (`Cache-Tag`) with their shop's tag, and with the handles of the
    products, collections and pages they name before they render: the route's, found or not, and
    those the theme's, sections' and blocks' settings choose. Tagged by handle, a page at a handle
    nothing has yet is forgotten once something takes it.
  * **The publisher purges what changed**: it compares each document it writes with the one stored
    and purges the tags of those written differently or taken off, by their handles before and
    after. A product that changes also purges the collections that hold it and
    `/collections/all`, whose pages show its card. A changed shop document (settings, delivery,
    theme) or menus purge the shop's tag, which every page has. It purges after writing, outside
    the database transaction; a purge that fails is logged, not retried.
  * **The edge is Cloudflare** ([ADR-007](#adr-007--cloudflare-as-the-edge)),
    purged by tag through its API with the worker's `CLOUDFLARE_ZONE_ID` and
    `CLOUDFLARE_API_TOKEN`; without them nothing is purged, as in development.
* **Consequences:**
  * A page costs the origin nothing while what it shows stays as it was, and a sale that leaves a
    product for sale purges nothing.
  * What a page shows without naming it before it renders is kept up to five minutes: a
    product's card on a search page, or in a section that finds products some other way.
  * A render that read a document just before the publisher replaced it can put the old page back
    after the purge, for up to five minutes. A second purge a few seconds later closes that if it
    matters.
  * In a drop, stock running out purges the product's page and listings each time a product sells
    out; if purges reach Cloudflare's rate limits, gathering them for a second or two comes next.
* **Alternatives:**
  * **Tagging every document a page reads:** only known once the page is rendered, so its
    headers would wait for its last section, giving up the head first.
  * **Purging the whole shop on any change:** a busy shop's sales would empty its pages every few
    seconds.
  * **Short lives without purges:** a new price would show late on the product page itself.
  * **Purging by address:** needs a record of the addresses each document is shown at.

## ADR-048 · A shop's own domains are the online store's, one shop's each, served once DNS points them at the platform, the primary one where pages send shoppers

* **Context:** every shop answers at its handle's subdomain
  ([ADR-037](#adr-037--every-shop-has-a-handle-naming-its-storefront-on-the-platforms-domain-storefronts-find-shops-through-a-directory-in-valkey)).
  Shops want their own domains too (ONB-07): www.zarifashions.pk, where shoppers and links go. The
  architecture puts Cloudflare for SaaS custom hostnames at the edge, with certificates issued
  as domains are added, and a lookup of each host's shop and primary domain
  ([04 §2.1](./04-storefront-and-themes.md#21-hostname-routing)). The control plane is to own
  what spans shops; until it exists, the application database stands in for it.
* **Decision:**
  * **The online store keeps a shop's domains** (`online_store.domains`): each host as DNS has it,
    lowercase with internationalised names in their `xn--` form, one shop's across the platform
    by an index that sees every shop's rows; when DNS last pointed it at the platform; and
    whether it is primary. A shop connects ten at most, and never the platform's domain, its
    subdomains or the DNS target. `read_domains` and `write_domains` are owners' and managers',
    as the online store is ([design 02 §6](../design/02-information-architecture.md#6-permissions--navigation-matrix-presets)).
  * **A domain is pointed at the platform, and checked when the shop asks.** `domainCreate`
    connects it and names the DNS target, `STOREFRONT_DNS_TARGET` or shops.{storefront domain}:
    a CNAME record naming it, or at an apex, one the DNS provider flattens to its addresses.
    `domainVerify` asks DNS then, outside the database transaction: a CNAME naming the target, or
    addresses all among the target's, verifies it; otherwise `NOT_POINTED` says what DNS
    answered. A verified domain stays verified.
  * **One domain is primary**, and must be verified to be: making another primary makes the one
    before stop being. The storefront sends shoppers there, and the Admin API's `shop.url` names
    it; without one, the handle's subdomain is.
  * **The storefront answers at verified domains**: `domain.*` events rebuild the shop, whose
    document names its verified domains and its primary one, and the directory maps each of them
    to the shop, beside its handle. A page asked for at another of the shop's addresses is sent on
    to the same path at the primary domain, with a 301. Forms, scripts, cart changes and
    checkouts answer where they are asked, so a shopper's cart stays on the host it began on.
* **Consequences:**
  * A shop can use its own domain now, wherever it points at the storefront directly;
    certificates and the edge's routing come with Cloudflare for SaaS and the infrastructure.
  * Nothing checks a domain again: one that stops pointing at the platform stays connected until
    it is let go.
  * Carts are kept per host: a cart begun at the handle's subdomain before a domain became
    primary stays there.
  * A request naming a shop's domain in its `Host` reaches the shop wherever it is sent from, as
    with any host-routed service; the edge will answer only for hosts it has certificates for.
* **Alternatives:**
  * **Domains in the control plane:** where they belong at scale, with the edge's copy of the
    directory; the online store keeps them until that service exists.
  * **Verifying by a TXT record:** proves control of the domain's DNS, but the storefront needs
    the CNAME to be reached anyway; checking the CNAME proves both.
  * **Checking domains in the background, over and over:** a job to run and states to show; asked
    when the shop asks is enough to begin with.

## ADR-049 · A theme is previewed through a link the core seals, which storefronts keep in a cookie and render from the core's files, never kept

* **Context:** a shop prepares a theme before publishing it
  ([ADR-039](#adr-039--a-shops-theme-is-a-platform-theme-with-the-shops-own-json-files-over-it)),
  an Eid look, say, and wants to see it on its storefront before shoppers do, and to send it to
  a partner or a designer for a second opinion. The editor (OS-02) shows its preview the same
  way, in a frame of the storefront ([04 §3.4](./04-storefront-and-themes.md#34-theme-editor-no-code)).
  Storefronts have only main themes, which the worker publishes to Valkey.
* **Decision:**
  * **A theme's preview is a link:** `OnlineStoreTheme.previewUrl` (`read_themes`) is the shop's
    storefront at its handle's subdomain with `?preview=` and a token naming the theme and when
    the link ends, 14 days on, as Shopify's do. The token is sealed with the core's secret box,
    bound to the shop, so nothing is stored, and the keys rotate as the box's do.
  * **The storefront keeps it in a cookie**, `hatti_preview`, `HttpOnly` and `SameSite=Lax`, until
    the link ends, so every page, section, search and cart page shown on that host after it shows
    the theme, whatever links, forms or scripts lead there. A bar at the foot of each page, in its
    language, names the theme and ends the preview; `?preview=` with nothing ends it too.
  * **The storefront hands the token back to the core** for the theme, on each previewed request
    (`GET /storefront/shops/{shop}/theme-preview`, the token in `x-hatti-preview`, with the
    storefront key). The core opens it for the shop the host names, and gives the theme's files
    as saved at that moment, so a change shows on the next page, before the worker would publish
    it. The storefront lays them over the platform theme once per version, beside main themes.
    A token of another shop's, an ended link or a deleted theme gives nothing, and its cookie goes.
  * **Previewed answers are the shopper's own:** `private, no-store`, without cache tags, and
    `noindex`; they are not sent on to the shop's primary domain; and the edge is to pass requests
    with the cookie or the parameter to the storefront. Any answer that sets a cookie is kept by
    no one, whatever its route says.
* **Consequences:**
  * A previewed page costs a round trip to the core; pages without a preview cost nothing more.
  * A preview shows the files as saved. Settings the editor has not saved are the next step: the
    editor's protocol.
  * A link cannot be taken back short of deleting its theme or rotating the keys: anyone who has
    it sees the theme until it ends, which shows no more than a look.
  * A preview is per host: one opened at the shop's subdomain does not follow to its own domain.
  * Someone who opened a preview sees it on that host until it ends or they end it, as on
    Shopify, with the bar saying so.
* **Alternatives:**
  * **Every theme published to Valkey:** no round trip to the core, but a save would show only once
    the worker had published it, while the editor needs the save it just made.
  * **Tokens kept in the database:** they could be taken back one at a time, but it takes a table
    and a lookup for a link that shows only a look.
  * **The token in every link rather than a cookie:** forms, scripts and the cart's answers lose it,
    so a preview would fall back to the main theme a click later.

## ADR-050 · The theme editor talks to its preview through postMessage: a framed preview is in design mode, and renders sections with the editor's unsaved files

* **Context:** the editor (OS-02) is to show the theme it edits in a frame of the storefront, as
  Shopify's does ([04 §3.4](./04-storefront-and-themes.md#34-theme-editor-no-code)): the merchant
  chooses a section or block, in the editor or by tapping it in the page, changes its settings,
  and sees them before saving; and themes' scripts need to know when their sections are chosen or
  rendered again. Previews exist ([ADR-049](#adr-049--a-theme-is-previewed-through-a-link-the-core-seals-which-storefronts-keep-in-a-cookie-and-render-from-the-cores-files-never-kept)); the admin app the editor will be part of does not yet.
* **Decision:**
  * **A preview the editor frames is in design mode.** A previewed request the browser says is
    for a frame (`Sec-Fetch-Dest: iframe`), with the editor's origins configured
    (`STOREFRONT_EDITOR_ORIGINS`), renders with Liquid's `request.design_mode` true; each
    section's wrapper names its ID, type and where its settings are kept, the page's template, a
    section group, or `config/settings_data.json` for a static section; and blocks'
    `shopify_attributes` give their ID and type, as Shopify's do. The page carries the editor's
    script in place of the preview's bar. Previewed answers may be framed by those origins alone
    (`Content-Security-Policy: frame-ancestors`). Design mode follows the frame through links and
    forms, since every page opened in it is framed; there the preview's cookie is the frame's own
    (`SameSite=None; Secure; Partitioned`), so it holds even when the editor is another site.
  * **The script and the editor talk through `postMessage`**, the script hearing the editor's
    origins alone: the editor says hello each time the frame loads and learns the page's path,
    locale and template and its sections with their blocks; it chooses a section or block, which
    the script scrolls to and tells the theme's scripts of; a tap in the page, other than on a link
    or control, chooses too and tells the editor; and the editor asks for sections to be rendered
    again with the theme's files it has not saved.
  * **Unsaved files render through `POST /editor/sections`**, for the script alone (a preview, its
    header, from the page itself): the page's sections in design mode, with the unsaved files over
    the previewed theme as saved. What the storefront cannot use of them is said, and the saved
    file stands; nothing is kept. The script swaps the sections in and keeps them chosen.
  * **Themes hear Shopify's theme editor events**, `shopify:section:load`, `unload`, `select`
    and `deselect`, and `shopify:block:select` and `deselect`, with Shopify's `detail`, and see
    `Shopify.designMode`, so a theme written for Shopify's editor works in Hatti's. Hatti Base's
    cart drawer opens while chosen, and lets go of the page's listeners when rendered again.
* **Consequences:**
  * The editor needs only the Admin API and the storefront: a theme's `previewUrl` in a frame,
    these messages, and `themeFilesUpsert` to save.
  * Design mode needs Fetch Metadata, which browsers send over HTTPS and to `localhost`: in
    development, the editor and storefronts are tried on `*.localhost` hosts.
  * Sections render again one at a time: adding, removing or moving sections, and settings the
    layout reads, such as colours, show once saved and the frame reloaded. Themes' own requests,
    such as the drawer's, are not in design mode.
  * Each render of unsaved files asks the core for the preview once, and renders the sections.
* **Alternatives:**
  * **Design mode in the page's address**, kept by the script through links and forms: it works
    over plain HTTP, but forms that post, and redirects, lose it, and the script would rewrite the
    page's links.
  * **Unsaved files kept as drafts in the core**, which the preview reads: they would show after a
    link too, but each change would be a write and a round trip before it showed, and drafts would
    need storing and merging with saves.
  * **Events of Hatti's own**: nothing written for Shopify's editor would hear them.

## ADR-051 · Search engines and link previews are told each page's address at the shop's own, in each language, and find pages through sitemaps of the storefront's documents

* **Context:** a shop's pages answer at its handle's subdomain and at its own domains, the primary
  one where pages send shoppers ([ADR-048](#adr-048--a-shops-own-domains-are-the-online-stores-one-shops-each-served-once-dns-points-them-at-the-platform-the-primary-one-where-pages-send-shoppers)), and in English and Urdu. Search engines should rank one
  address for each page, and find every product; link previews, WhatsApp's above all, need a
  title, a description and an image at an address they can fetch (OS-09,
  [04 §6](./04-storefront-and-themes.md#6-seo--discoverability)).
* **Decision:**
  * **Every page has one address, at the shop's own:** Liquid's `shop.url` is the shop's primary
    domain, else its handle's subdomain, with the platform's scheme and port, and `canonical_url`
    is the page's path there, in its language (`/ur/…` in Urdu), keeping only `page` past the
    first. Hatti Base links it as canonical, and its link-preview tags use it, with the image at
    the shop's address.
  * **The storefront adds the page's address in each of the theme's languages** to the head, as
    Shopify does, `x-default` the default language's: for pages that are found, and not previews
    or the editor's.
  * **Sitemaps come from the storefront's documents:** `/sitemap.xml` indexes
    `/sitemaps/{products|collections|pages}-{n}.xml`, 5,000 addresses each, from the handles the
    storefront shows, each with its address in every language, the home page first among the
    pages'. `robots.txt` keeps crawlers from carts, checkouts, searches, the editor's routes,
    previews, other sort orders and sections alone, and names the sitemap at the shop's address.
    Both are kept at the edge for an hour, and forgotten with the shop's document ([ADR-047](#adr-047--the-edge-keeps-storefront-pages-by-the-handles-they-name-before-they-stream-and-forgets-those-whose-documents-change)).
  * **Products carry structured data**: Shopify's `structured_data` filter gives schema.org's
    `Product`, with an `Offer` for each variant in rupees and whether it can be bought, and its
    images, at the shop's address. Liquid's `json` escapes `<`, `>` and `&`, as the structured
    data does, so what a shop writes cannot end a script.
* **Consequences:**
  * A shop that makes a domain primary is ranked there: its pages' canonical addresses move with
    it, and the handle's subdomain sends its pages on.
  * A new product is in the sitemap within an hour; sitemaps have no `lastmod` and no images, and
    robots.txt cannot be edited yet.
  * Sitemaps answer at each of the shop's hosts, and list the canonical addresses.
* **Alternatives:**
  * **Sitemaps from the core's database:** always current, but a round trip to the core for each
    crawl, where the documents already hold what the storefront shows.
  * **Shopify's sitemap names** (`sitemap_products_1.xml?from=…`): only the index is ever submitted,
    and a fixed prefix routes apart from pages.
  * **The address asked for as canonical:** a page answering at a subdomain and a domain would
    split its ranking between them.

## ADR-052 · A shop's URL redirects are the online store's, and the storefront follows one only where it has no page

* **Context:** a shop moving to Hatti brings links to its old addresses with it: in search
  engines' results, WhatsApp chats, Instagram bios and ads. Shopify keeps a shop's URL redirects,
  and migration tools write them through its Admin API's `urlRedirect` mutations; a shop that
  moves without them loses its ranking and its customers' links (OS-09, ONB-05,
  [04 §6](./04-storefront-and-themes.md#6-seo--discoverability)).
* **Decision:**
  * **The online store keeps them, managed as Shopify's are:** `urlRedirects`, `urlRedirect`,
    `urlRedirectCreate`, `urlRedirectUpdate` and `urlRedirectDelete` in the Admin API, with the
    navigation scopes. Each change records `url_redirect.created`, `.updated` or `.deleted`. A
    shop keeps at most 20,000.
  * **A path is kept as the storefront compares addresses:** taken from a path or a whole address
    pasted in, without its query, fragment, trailing slash or `/ur`, decoded and lowercase; one
    redirect a path, and never the home page. A redirect sends both languages' pages on. Its
    target is a path on the shop, which may have a query, or an http(s) address; one that would
    send shoppers back to its own path is refused.
  * **The storefront follows one only where it would answer 404:** once it knows nothing is at a
    page's path, it looks the path up, in one round trip, and sends a 301 to the target: in the
    shopper's language when the target is on the shop, and with the query the page was asked
    with when the target has none, as a campaign's link has, but for a preview's token. A redirect never hides a page, so a
    product that takes an old address is shown there. A preview follows redirects, kept by no
    one; the theme editor's frame shows the 404 page, to change it.
  * **The publisher writes a shop's redirects to Valkey as a hash of targets by path**, from all
    of the shop's on any change, writing only what differs from the hash, 500 at a time: a
    migration's burst of changes is written once, a shop with thousands never holds Valkey up,
    and a hash that missed a change is put right by the next. The edge keeps 404 pages and
    redirects tagged with their path's tag, a hash of it: a change forgets what was answered at
    the paths it touched, or all the shop's pages past 25 paths, in one call
    ([ADR-047](#adr-047--the-edge-keeps-storefront-pages-by-the-handles-they-name-before-they-stream-and-forgets-those-whose-documents-change)).
* **Consequences:**
  * A shop moves its links with it: its old addresses can be written before its domain points at
    the platform.
  * A path with a query cannot be sent on apart from the path; a chain of redirects is followed a
    hop at a time, and a loop is the shop's to fix, as on Shopify.
  * A handle changed leaves no redirect behind yet.
  * Documents are version 7: each shop's are published whole once more.
* **Alternatives:**
  * **Looking the redirect up before rendering:** a round trip for every page, where only pages
    not found need it, and a redirect could hide a page.
  * **Writing each event's path and target alone:** less to write, but a changed path leaves its
    old one behind unless the event names both, and a missed event stays wrong until the shop is
    built again.
  * **The edge's own redirect rules** (Cloudflare's bulk redirects): answered before the
    storefront, but limited per account, and they would send on addresses that have pages.

## ADR-053 · A handle change asks for its redirect, as Shopify's redirectNewHandle does, and the redirect leads to where the page is now

* **Context:** a product renamed for a new season, `lawn-suit` to `lawn-suit-2026`, leaves its old
  address answering 404: in search results, WhatsApp chats and ads, where most of a shop's
  shoppers start. Shopify's admin offers a box, ticked, that redirects the old address, and its
  API takes `redirectNewHandle`; shops' URL redirects
  ([ADR-052](#adr-052--a-shops-url-redirects-are-the-online-stores-and-the-storefront-follows-one-only-where-it-has-no-page))
  can hold them.
* **Decision:**
  * **`productUpdate`, `collectionUpdate` and `pageUpdate` take `redirectNewHandle`**, false
    unless given, as Shopify's API does; the admin's screens will tick it by default, as Shopify's
    do. It needs only the change's own scope.
  * **A page's redirect is written with the change**, in its transaction. **A product's or
    collection's is written by the worker**: the catalog knows nothing of the online store, so
    `product.updated` and `collection.updated` name the old handle, and say whether the change
    asked. The worker writes the redirect to the handle the product or collection has when it
    runs, not the one the event names, so events handled late or out of order still send every
    old address to the current one; one deleted since gets none.
  * **A redirect written moves the others with it:** those that sent shoppers to the old address,
    with a query or a fragment or without, send them to the new one, so none goes the long way
    round; and a redirect from the new address goes, since the page is there now. A page back at
    an old address frees it.
  * **A shop with all the redirects it may keep gets none more**: the change stands, and the
    worker logs it.
* **Consequences:**
  * A renamed product's old links work again a moment after the change: the worker writes the
    redirect, then the publisher sends it to the storefront.
  * API clients must ask, as on Shopify: an importer that renames handles leaves no redirects.
  * Handles changed before this, or without asking, leave none, though the shop can add one.
* **Alternatives:**
  * **Always redirecting:** nothing to ask, but a client copying a catalog in would leave
    redirects nobody wanted, where Shopify's API leaves none.
  * **The catalog writing the redirect in its own transaction:** at once, but the catalog would
    write the online store's tables, or the two modules would depend on each other.
  * **The redirect to the new handle the event names:** two renames handled out of order could
    send the first address to the middle one, or drop the redirect a rename back needs.

## ADR-054 · A shop's storefront can be closed behind a password, which the storefront checks against a verifier in the shop's document

* **Context:** a new shop is built for days or weeks before it opens, its products, theme and
  delivery charges; meanwhile its storefront should show neither shoppers nor search engines half
  a shop, and a shop may close for a while, for a stock-take or before a drop. Shopify keeps a new
  store behind a password until it opens, on a password page from the theme's `password`
  template (OS-15).
* **Decision:**
  * **The online store keeps the password with the shop's preferences**
    ([ADR-041](#adr-041--what-a-shop-sets-for-its-storefront-as-a-whole-is-the-online-stores-starting-with-its-whatsapp-number)):
    whether the storefront is closed; the password, sealed with the platform's secret box so its
    staff can see it again, as Shopify shows it; a verifier of it; and what the password page
    tells shoppers. `onlineStorePreferencesUpdate` sets them, under the settings scopes. A
    password can be changed, never taken away, and closing needs one.
  * **The shop's document carries the verifier and the message, never the password:** scrypt
    with a salt of its own (`@hatti/crypto`), some 50 ms a check, and the message as HTML made
    from the text.
  * **The storefront sends shoppers without a pass to `/password`** (`/ur/password` in Urdu), the
    theme's `password` template, as Shopify's does; scripts and sections are told 401, and
    robots.txt disallows everything. The password page, theme assets and robots.txt stay open. The
    password is taken at `/password`, ten tries a minute from an address; the right one leaves a
    pass in a cookie (`storefront_digest`) for a month: an HMAC of the shop by the verifier, so a
    new password asks everyone again.
  * **Nothing of a closed shop is kept at the edge**, even for shoppers with the pass, since the
    edge keys on the address alone: every answer is `private, no-store` and `noindex`. Closing
    and opening change the shop's document, so the publisher purges its pages
    ([ADR-047](#adr-047--the-edge-keeps-storefront-pages-by-the-handles-they-name-before-they-stream-and-forgets-those-whose-documents-change)).
  * **Its staff see it as it will be through a preview**
    ([ADR-049](#adr-049--a-theme-is-previewed-through-a-link-the-core-seals-which-storefronts-keep-in-a-cookie-and-render-from-the-cores-files-never-kept)),
    the password page too, to design it.
* **Consequences:**
  * Every page of a closed shop is rendered for its visitor, as a preview is; closed shops have
    few visitors.
  * The password is shared, not a person's: whoever has it sees the shop, for a month or until it
    changes.
  * Nothing can be ordered from a closed shop but through its staff: carts and checkout are closed
    too.
  * New shops are open until their staff close them; the control plane will close them at sign-up.
* **Alternatives:**
  * **The core checking passwords for the storefront:** no verifier in Valkey, but a round trip
    to the core for each try, and passes signed with a key both would share.
  * **Keeping the password page at the edge, and the rest private:** the edge cannot tell a
    shopper with a pass from one without.
  * **A password for each person:** that is the admin's sign-in, not a storefront's; Shopify's is
    shared too.

## ADR-055 · A shop adds rules to its robots.txt as lines crawlers read, checked when saved, never Liquid

* **Context:** the storefront's robots.txt keeps crawlers from carts, checkouts, searches and
  the like ([ADR-051](#adr-051--search-engines-and-link-previews-are-told-each-pages-address-at-the-shops-own-in-each-language-and-find-pages-through-sitemaps-of-the-storefronts-documents)),
  but a shop may want more: a collection kept out of search results until it launches, an AI
  crawler shut out, a sitemap of its own. Shopify lets a theme's `robots.txt.liquid` change the
  file; Hatti's shops keep no Liquid of their own (OS-09).
* **Decision:**
  * **The rules are a preference of the shop's**
    ([ADR-041](#adr-041--what-a-shop-sets-for-its-storefront-as-a-whole-is-the-online-stores-starting-with-its-whatsapp-number)),
    `robotsTxtRules`, set through `onlineStorePreferencesUpdate`: lines of `User-agent`,
    `Allow`, `Disallow`, `Crawl-delay` or `Sitemap`, comments and blank lines, 200 at most.
  * **Each line is checked when saved**, as crawlers would read it: a directive they know, in its
    usual case, with a value of its kind, a crawler's name, a path pattern, a number or a web
    address. Lines that are not are said, by their number, and nothing is saved.
  * **The storefront serves them after the platform's rules:** those before any `User-agent` of
    the shop's own join the platform's `User-agent: *` group, so a shop can let crawlers into a
    path the platform keeps them from, or keep them from more; its groups come after; its
    sitemaps join the platform's at the end. A closed shop's robots.txt shuts everything out
    still ([ADR-054](#adr-054--a-shops-storefront-can-be-closed-behind-a-password-which-the-storefront-checks-against-a-verifier-in-the-shops-document)).
* **Consequences:**
  * A shop cannot remove the platform's rules, only add to them, or allow a path in its own group.
  * Rules reach the storefront with the shop's document, and the edge forgets robots.txt with it.
* **Alternatives:**
  * **A `robots.txt.liquid` of the shop's own**, as Shopify's: full control, but Liquid from shops
    is what Hatti keeps out ([ADR-039](#adr-039--a-shops-theme-is-a-platform-theme-with-the-shops-own-json-files-over-it)), and a mistake would
    shut crawlers out of the whole shop.
  * **Rules as data, a path and whether it is allowed:** simpler to check, but no groups for
    other crawlers, and not what SEO tools and guides write.

## ADR-056 · A shop's policies are kept as Shopify keeps them, shown in Shopify's markup, and drafted from what the shop has set, never saved by themselves

* **Context:** a shop needs a returns policy, a privacy policy, terms and a shipping policy before
  it sells: shoppers read them before paying cash to a courier, payment gateways ask for them,
  and most Pakistani shops have none written. Shopify keeps five, shows them at `/policies/…`
  and links them from themes' footers, and drafts them from templates; its API has
  `shop.shopPolicies` and `shopPolicyUpdate` (ONB-09).
* **Decision:**
  * **The online store keeps them as Shopify does:** refund, privacy, terms of service, shipping
    and contact information, one of each, HTML cleaned when saved as pages' bodies are
    ([ADR-045](#adr-045--a-shops-pages-keep-html-cleaned-of-anything-that-runs-when-saved-the-storefront-shows-it-as-it-is)); a
    blank body takes one away. `shop { shopPolicies }` and `shopPolicyUpdate` follow Shopify's,
    under new `read_legal_policies` and `write_legal_policies` scopes, owners' and managers'.
  * **Drafts are written from what the shop has set** (`shopPolicyDraft`): its name, address,
    WhatsApp number and delivery charges, in English or Urdu, for Pakistan: cash on delivery,
    refunds by bank transfer, Easypaisa or JazzCash, couriers, the law of Pakistan. A draft is
    returned, never saved: the shop reads it, changes it and saves it with `shopPolicyUpdate`.
    It is not legal advice, and says as much in the API.
  * **The storefront shows them in Shopify's markup** (`.shopify-policy__container`), inside the
    theme's layout, at `/policies/refund-policy` and the rest, and in Urdu at `/ur/policies/…`,
    as Shopify does: themes need no template for them. Liquid's `shop.policies`, and
    `shop.refund_policy` and the rest, give their titles and addresses in the page's language;
    Hatti Base's footer links them. The shop's document lists the policies it has; their bodies
    are kept apart, fetched for their own pages only, and a change forgets the shop's pages
    ([ADR-047](#adr-047--the-edge-keeps-storefront-pages-by-the-handles-they-name-before-they-stream-and-forgets-those-whose-documents-change)).
  * **Checkout links them**, as Shopify's does: the foot of its page, and of its thank-you page,
    lists those the shop has, in English and Urdu as the rest of the page, each opening in a new
    tab. Shopify shows them in a dialog over the checkout; the page runs no scripts
    ([ADR-044](#adr-044--checkout-is-one-page-the-core-renders-and-storefronts-serve-on-the-shops-address-placing-a-cash-on-delivery-order-as-the-page-showed-it)),
    and a shopper who left it could come back to an empty form.
* **Consequences:**
  * A new shop has no policies until it saves some, as on Shopify; the admin's onboarding will
    offer the drafts.
  * A draft's promises are the shop's to keep: 7 days to return, refunds within 7 working days,
    delivery times, until it changes them.
  * A policy is in one language, the one the shop wrote it in, whichever language the page is.
* **Alternatives:**
  * **Policies as pages:** no new table, but no fixed addresses for themes and checkouts to link,
    and no Shopify API to import them through.
  * **Saving drafts at sign-up:** every shop would publish promises it never read.
  * **Policies in the shop's document:** one fetch fewer on their pages, but every page would
    fetch every policy's body.

## ADR-057 · What a shopper agrees to in placing an order is kept with it: the versions of the shop's policies its checkout linked, and where it was placed from

* **Context:** Pakistan's Electronic Transactions Ordinance 2002 lets contracts made online stand,
  and the provinces' consumer protection laws hold shops to what they told shoppers. When a
  shopper disputes an order, a refused parcel's charges or a return after the window, the shop
  has to show what they agreed to, when, and from where: the clickwrap log that
  [11 §8](./11-security-and-compliance.md#8-compliance-map) lists, and TAX-06. Shopify keeps each order's client
  details, the browser's address and user agent, but not the terms it was placed under: a policy
  edited since shows its new words. Policies are the online store's
  ([ADR-056](#adr-056--a-shops-policies-are-kept-as-shopify-keeps-them-shown-in-shopifys-markup-and-drafted-from-what-the-shop-has-set-never-saved-by-themselves));
  orders are the orders module's, which checkout places them through
  ([ADR-044](#adr-044--checkout-is-one-page-the-core-renders-and-storefronts-serve-on-the-shops-address-placing-a-cash-on-delivery-order-as-the-page-showed-it)).
* **Decision:**
  * **Every body a policy is saved with is kept, as a version**, which request code can neither
    change nor delete (`online_store.policy_versions`); the policy names its current one, and
    one taken away leaves its versions.
  * **The checkout says what placing the order agrees to**, above its button, in English and
    Urdu: the shop's policies, each linked, but for its contact information, which promises
    nothing. Nothing when the shop has none.
  * **The order agrees only to what its page linked:** the page's digest covers the versions it
    linked, so a policy changed while the shopper was there shows the page again, as a changed
    price does.
  * **The order keeps it**, in the orders module: the versions agreed to, and the address and
    browser it was placed from, as Shopify's client details, which storefronts pass on with the
    form (`x-hatti-client-ip`, `x-hatti-client-user-agent`). When is when the order was placed.
    Only orders placed through checkout have one.
  * **The Admin API shows it as `Order.agreement`**: when, from where, and the policies as they
    were then, which the core joins from the online store. The address and browser are the
    customer's data: shown only to those who see customers' numbers whole
    ([ADR-027](#adr-027--customers-numbers-are-masked-by-role-and-reveals-go-to-an-append-only-audit-log)),
    and cleared when the customer is erased. The versions stay: they are the shop's words.
* **Consequences:**
  * An order shows what its customer read, whatever the policy says now; a shop that edits its
    policies keeps every version.
  * An order placed while a policy changes asks the shopper once more.
  * The address is the one the storefront sees: behind the edge, the edge's own, until the
    storefront trusts the address the edge forwards, as its rate limits need too.
  * Draft orders confirmed through their links, and orders from staff and apps, keep none yet
    (since [ADR-114](#adr-114--a-draft-its-customer-confirms-through-its-link-keeps-what-they-agreed-to-as-checkouts-orders-do-the-page-names-the-shops-policies-above-its-button-and-the-order-keeps-their-versions-and-where-it-was-confirmed-from), a draft's order
    keeps one, and since [ADR-115](#adr-115--an-order-staff-or-an-app-placed-keeps-what-its-customer-agreed-to-in-confirming-it-through-its-link-the-page-names-the-shops-policies-and-the-order-keeps-their-versions-where-it-was-confirmed-from-and-when) an order its customer confirms
    through its link).
* **Alternatives:**
  * **A box the shopper ticks:** stronger evidence of assent, but one more tap on a phone, at the
    step cash-on-delivery shoppers leave most; the sentence beside the button is how shops take
    assent already.
  * **The policies' text copied into each order:** no versions, but thousands of orders each
    carrying the same pages of text.
  * **The online store keeping the log:** it would have to know orders and take part in their
    customers' erasure, which the orders module does already.

## ADR-058 · No order collects more cash on delivery than the law allows, whoever places it: the rest is paid in advance, or the order is not placed

* **Context:** Income Tax Circular 02 of 2025-26 applies the Rs 200,000 cap on cash payments to
  cash-on-delivery orders
  ([research](../research/03-local-ecosystem.md#61-timeline), TAX-07), and a courier collecting
  more breaks it on the shop's behalf. [05 §4.4](./05-checkout-and-payments.md#44-method-rules-engine)
  puts the cap in the method rules engine, which comes with online payment (PAY-01); until then
  cash on delivery is how checkout's orders are paid, and staff, apps and drafts' links place
  cash-on-delivery orders too.
* **Decision:**
  * **The orders module refuses the order**, wherever it comes from: `placeIn` and saving a draft
    refuse a cash-on-delivery order whose cash at the door, its total less any advance, is more
    than the cap, with `COD_LIMIT` on its `advancePaid` and the advance it would need. An advance
    that brings the cash within the cap, or paying in full, places it.
  * **Checkout says so before the shopper types:** a cart whose items alone come to more shows
    the reason, without the form, and one taken past the cap by delivery shows it when placed.
    Nothing is placed either way.
  * **The cap is the law's, and binds orders in rupees:** `COD_CASH_LIMIT` in the orders module,
    changed with the law, not a setting a shop or the platform turns.
* **Consequences:**
  * A shopper whose cart comes to more than Rs 200,000 cannot check out until online payment
    exists; the page asks them to take items out, or to ask the shop about an advance, which
    staff take on a draft order.
  * Orders placed before a change of the cap keep what they collect.
* **Alternatives:**
  * **A warning, not a refusal:** leaves the shop and its courier to break the law.
  * **Splitting the order into parcels under the cap:** one sale split to avoid the cap is still
    over it.
  * **A platform setting:** the value belongs to the law, and a release carries a change to it
    with its tests.

## ADR-059 · A Shopify product export is imported product by product, as productCreate makes them, keeping their handles; the core sets the stock

* **Context:** the MVP half of ONB-05 is importing Shopify's CSV exports, and a shop's catalog is
  most of its move: Shopify's product CSV has a row for each variant and each image, grouped by
  handle, the first row of a product carrying its title, description, vendor, type, tags and
  status. A product's address, `/products/{handle}`, is what search engines and old links know
  ([F10](../design/03-key-user-flows.md#f10--migrate-from-shopify): no SEO lost). Customers'
  imports take Shopify's customer export already (CUS-07). Products are the catalog's; stock is
  the inventory module's, which depends on the catalog.
* **Decision:**
  * **`productsImport(csv, dryRun)` reads Shopify's product CSV as Shopify writes it:** rows
    grouped by handle; option values or a price make a row a variant; Title / Default Title is a
    product without options; Status, or Published, whether it is on sale; Body (HTML) becomes the
    plain text the catalog keeps, paragraphs and list items kept; SKU, barcode, grams,
    compare-at price and cost come with each variant, and images by position.
  * **Each product is made as `productCreate` makes it**, in a transaction of its own, with its
    checks and its events, then given its images. What the catalog would refuse is said by the
    row and column it came from, and the rest go in. A dry run makes the same checks and counts,
    writing nothing.
  * **Handles are kept**, so every product keeps its address. A handle the shop has already is
    left as it is: the same file can be imported again, and nothing is overwritten.
  * **The core sets the stock Shopify tracked**, on hand at the primary location, through the
    inventory module, a batch of 250 variants at a time, and keeps selling out-of-stock variants
    Shopify sold on; the catalog, which cannot reach inventory, returns what to set.
  * **Left out:** gift cards, images not at https addresses, SEO titles and descriptions,
    metafields, unit prices and tax codes; variants' own images are added to the product's.
* **Consequences:**
  * An import runs in its request: 300 products with 900 variants took six seconds on a laptop.
    The admin's import screen will run big files in the background, with progress, as F10 has it.
  * Images stay at Shopify's addresses until the media worker copies them; a shop that closes its
    Shopify store before then loses them.
  * Importing again after changes on Shopify leaves the products as they were imported.
  * A shop with several Shopify locations gets a variant's stock at its primary location: the
    product CSV has one quantity a variant.
* **Alternatives:**
  * **The whole file in one transaction,** as customers' imports go: one product's failure would
    stop the rest, and one long transaction would hold its locks while hundreds of products were
    made.
  * **Bulk inserts around `productCreate`:** faster, but a second way to make products, whose
    checks, events and handles would have to be kept in step with the first.
  * **Overwriting products with the same handle:** it would undo the shop's edits since, and
    replace variants whose IDs orders keep.

## ADR-060 · COD health follows a period's cash-on-delivery orders, worked out from them when asked, its rates of those that turned out

* **Context:** COD-12, the COD health dashboard, is in the MVP: confirmation, delivery and RTO
  rates by city, courier, product and source, as
  [06 §11](./06-orders-fulfillment-logistics.md#11-key-metrics-merchant-dashboard) defines
  them, and the beta's exit criteria measure each merchant's delivery success rate against their
  own baseline. Analytics are to be served from ClickHouse (ADR-014), which comes with V1. Until
  then the orders are in Postgres, each with its confirmation and each parcel with its outcome,
  and what a customer's orders add up to is worked out from them when read already (ADR-023).
* **Decision:**
  * **`codHealth(placedFrom, placedBefore, by)` follows the cash-on-delivery orders placed in a
    period** through confirmation and delivery: placed, confirmed (by the customer or staff,
    whatever came after), cancelled before anyone confirmed them, and awaiting; and their
    parcels: shipped, delivered, returned (on their way back, or back) and in transit. Prepaid
    orders are left out.
  * **Rates are of those that turned out:** confirmed of those confirmed or cancelled, and
    delivered and returned of the parcels delivered or returned, from 0 to 1, and null while
    there are none. What is still waiting is counted beside them, and counts once it turns out.
  * **It breaks down by city, product, source or courier**, most orders first: a city as orders
    keep it, in any letter case; a product by the lines sold, an order counting for each product
    in it and a parcel for each it carried, under the title it was last sold under; a source as
    `OrderSource` names it; and a courier as staff named it when shipping, for parcels alone.
  * **It is worked out from the orders and their parcels when asked**, by the orders module,
    whose they are, and stored nowhere. A period is a year at most. It needs `read_orders`.
* **Consequences:**
  * The numbers are always the orders' as they are now, with nothing to rebuild or keep in step.
    An order cancelled after it was confirmed counts as confirmed.
  * A year of 57,000 cash-on-delivery orders with 48,000 parcels took 0.1 to 0.45 seconds on a
    laptop, and a month of 4,700 of them 40 to 120 ms. No index covers when orders were placed;
    one halved a month's times and left a year's as they were.
  * Couriers are the names staff typed until courier booking (SHP-01) records them.
  * A recent period has many orders still waiting, and its rates settle as they turn out.
* **Alternatives:**
  * **ClickHouse now:** another store to run and keep in step, for a few hundred shops. It comes
    with V1, when the same report can read `orders_fact` and `shipments_fact`.
  * **Rates of everything placed or shipped**, as 06 §11's table writes them: a recent period
    would look worse than it is while its orders wait to turn out.
  * **Counters kept as orders change:** every change to an order or parcel would have to update
    them, and one missed would leave them wrong for good.

## ADR-061 · Sales are reported in Shopify's terms, from the orders when asked: an order counts on the day it was placed, cancelled ones aside, and so do its items that came back

* **Context:** ANL-02, sales analytics, is in the MVP: sales, orders, average order value and
  top products, with sessions, conversion and a live view, which need the storefront's events.
  Merchants moving from Shopify read its sales reports: gross sales, discounts, returns, net
  sales, shipping, taxes and total sales, and an average order value of gross sales less
  discounts over orders. Shopify books a return on the day it happens. A cash-on-delivery shop
  cancels many orders before anything moves, and 18 to 30% of its parcels come back unpaid
  ([market research](../research/01-market-research.md)). Analytics are to be served from
  ClickHouse with V1 (ADR-014); COD health is worked out from the orders when asked (ADR-060).
* **Decision:**
  * **`salesReport(placedFrom, placedBefore, interval, topProducts)` gives what a period's
    orders came to in Shopify's terms:** orders, gross sales (items at the prices sold),
    discounts, returns, net sales (gross less discounts and returns), shipping, total sales (net
    sales and shipping, with taxes when TAX-01 brings them) and average order value (since
    [ADR-117](#adr-117--the-sales-report-leaves-out-the-sales-tax-its-amounts-include-as-shopifys-does-worked-out-from-the-tax-each-order-keeps-the-tax-said-apart-and-added-back-in-total-sales), each without the tax prices include, but total sales); for the
    period, for every day, week from Monday or month of it in the shop's time zone, those
    without orders included, and for the products that sold most.
  * **An order counts on the day it was placed, and cancelled orders are left out:** most were
    never more than a phone call.
  * **Returns are the items in parcels that came back, refused or undeliverable, at the prices
    sold, counted on the day their order was placed**, not the day they came back. Refunds are
    money given back, which the finance reports will take; they are not taken off.
  * **It is worked out from the orders when asked**, by the orders module, and stored nowhere. A
    period is a year at most. It needs `read_orders`.
* **Consequences:**
  * A day's net sales fall as its parcels come back, and settle once they have all arrived
    somewhere: they say what that day really sold, where Shopify's would swing with the days
    returns arrive.
  * A year of 54,000 orders took 0.36 to 0.41 seconds on a laptop, and a month of them 73 to
    104 ms.
  * A product deleted since keeps its row, under the title it was last sold under.
* **Alternatives:**
  * **Returns on the day they came back, as Shopify books them:** a cash-on-delivery shop's
    days would swing with each batch of parcels a courier returns, and a day's sales would
    never show what came of them.
  * **Cancelled orders counted, then taken off as Shopify does when they are refunded:** for
    orders cancelled at confirmation, nothing was sold or paid.
  * **ClickHouse now:** as for COD health, it comes with V1, with the storefront's events for
    sessions and conversion.

## ADR-062 · Discount codes are the pricing module's: a percentage or an amount off an order's items, or free delivery, matched in any letter case

* **Context:** CHK-06's MVP half is codes for a percentage or an amount off, or free delivery;
  automatic discounts, buy X get Y, tiers, bundles and combining codes are V1's.
  [05 §3](./05-checkout-and-payments.md#3-cart--pricing-calculation-pipeline) prices a cart in
  steps, product, order and shipping discounts among them, and
  [01 §4](./01-system-overview.md) gives discounts to a Pricing & Promotions module. Shopify's
  admin has basic codes (a percentage or an amount, on everything or some products and
  collections, with a minimum, eligible customers, usage limits, combinations and dates) and
  free-shipping codes. Staff already give an order a discount of their own when they place it.
* **Decision:**
  * **`@hatti/pricing`, a new module, keeps discount codes**, as 01's Pricing & Promotions; price
    lists can join it later.
  * **A code gives one thing:** a percentage of the order's items (0.01 to 100, kept in
    hundredths of a percent), an amount off them, never more than they come to, or free
    delivery. It may need the items to come to a minimum, works between its dates, and may be
    limited to a number of orders in all and to one order a customer.
  * **Codes are letters, digits, hyphens and underscores, up to 64**, kept as the shop wrote them
    and matched in any letter case, so a shop cannot have both EID25 and eid25; 10,000 a shop.
  * **`discountOf` alone works out what a code takes off an order**, a percentage rounded half up
    to the paisa, so that every page and the order say the same.
  * **The Admin API** has `discountCodes`, `discountCode`, `discountCodeByCode`,
    `discountCodeCreate`, `discountCodeUpdate` and `discountCodeDelete`, under Shopify's
    `read_discounts` and `write_discounts`, which owners, managers and marketers have. One input
    makes or changes either kind: left out, a field stays as it is, and null clears it.
  * **Deleting a code stops it;** orders placed with it keep the code and what it took off.
* **Consequences:**
  * Codes apply to the whole order: none for some products or collections, and one code an order
    until codes combine in V1.
  * A code's status says only whether its dates have come and gone; its uses show beside it.
  * Shopify's API makes basic and free-shipping codes with mutations and inputs of their own; a
    Shopify app's discount calls need translating to Hatti's.
  * Shoppers cannot use codes until the cart and checkout take them, which comes next.
* **Alternatives:**
  * **Discounts in the checkout module:** draft orders and the admin's orders will take codes
    too, and price lists belong with them, not with carts.
  * **Shopify's input shapes,** `customerGets`, `customerSelection`, `minimumRequirement` and
    `combinesWith`: most of their fields would be for what is not built, refused when given.

## ADR-063 · A shopper's discount code is kept with their cart and counted with the order placed with it, in the order's transaction

* **Context:** codes are kept (ADR-062); shoppers need to use them, and shops need their limits
  kept. Checkout is one page the core renders, without scripts, that places a cash-on-delivery
  order as the page showed it (ADR-044). Shopify keeps codes on the cart, so that a `/discount/`
  link works before checkout, and counts a use when an order is placed. A customer is known only
  once the order is placed: placing finds or makes them by the number typed (ADR-023). Codes can
  be guessed, and the core's own checkout address has no rate limit of the storefront's.
* **Decision:**
  * **The cart keeps the code** (`discount_codes`, one for now), which checkout's page takes in
    a form of its own, above the address: a shopper applies a code before typing where it goes.
    A code that would take nothing off is refused with why, and not kept.
  * **The page shows what the code takes off**, worked out by `discountOf`: the items first,
    then delivery, whose free threshold the discounted items must reach, as Shopify's free
    shipping does; a free-delivery code makes delivery free wherever it goes. A code that
    stops applying while kept, as when the cart drops under its minimum, is shown with why, and
    the order is placed without it. The page's digest takes in the code, so the order is placed
    with the code only as the page showed it.
  * **A use is counted with the order, in its transaction:** once `placeIn` has placed it, the
    code's row is locked and its uses counted under the limit, and a redemption kept with the
    order, its customer and what the code took off. A code used up since, or one a customer may
    use once that the order's customer has used, undoes the order, and the page says why.
  * **Orders keep their codes** (`discountCodes`, as Shopify's orders do), with what they took
    off in `discount` and `shipping`. Uses are not given back when orders are cancelled.
  * **A checkout's page takes ten codes that take nothing off, then no more**, so that codes
    cannot be guessed through it.
  * **Merging customers moves their uses**, so a code they could use once stays used.
* **Consequences:**
  * A once-a-customer code is refused only as the order is placed, after the shopper has typed
    their number; the page keeps what they typed.
  * A cancelled order's use stays counted, so a code limited to 100 orders may see fewer
    delivered.
  * Staff's orders and drafts take discounts as amounts, not codes, for now.
* **Alternatives:**
  * **The code kept on the checkout:** a new checkout of the same cart would lose it, and a
    `/discount/` link has no checkout to keep it on.
  * **Uses counted from the outbox after the order:** two orders could both take a code's last
    use.
  * **A customer's use found by number in the redemption:** a number may change hands and
    customers merge; the customer the order belongs to is the one to ask about.

## ADR-064 · Discount links keep their code with the shopper's cart, one begun for it if need be, and a cart says of a code only whether it applies

* **Context:** the cart keeps a shopper's code, and checkout's page takes one (ADR-063). Shops
  share codes as links: Shopify's `/discount/CODE?redirect=/collections/eid` applies the code
  and sends the shopper on, from Instagram, WhatsApp or a text message, before anything is in
  their cart. Themes' scripts set codes with Shopify's Ajax cart (`discount` on
  `/cart/update.js`, codes separated by commas) and read them back in `discount_codes`, with
  what they take off in `total_discount` and `cart_level_discount_applications`; Liquid's `cart`
  has the same totals and applications. Carts change only from the shop's own pages (ADR-042), at most 120 times a
  minute from an address. Checkout counts the codes tried on its page so that they cannot be
  guessed there, and says why a code does not apply.
* **Decision:**
  * **`/discount/CODE` keeps the code with the shopper's cart**, beginning one that holds only
    the code when they have none, and sends them on with a 302 to `redirect`, else the home page,
    in the link's language. Links come from other sites, so unlike the cart's forms they are not
    refused for it: a link changes nothing but the code. Past the limit of cart changes, or with
    the core away, the shopper is still sent on, without the code; a HEAD request changes
    nothing.
  * **`redirect`, and a form's `return_to`, go only to paths on the shop, as a browser reads
    them** (`localPath`): parsed as a URL, so that `/%09/elsewhere.example`, which a browser
    reads as `//elsewhere.example` once it drops the tab, is refused like it.
  * **The cart takes Shopify's `discount`**: the first of the codes given that a shop could
    have, an empty one taking the code off. One code for now.
  * **A cart says of a code only whether it applies, as Shopify's does:** `discount_codes` has
    the code and `applicable`. One that applies is written as the shop wrote it, with what it
    takes off the items; one that does not is written as typed, with nothing else, whether or
    not the shop has it. Checkout's page says why.
  * **What it takes off is the cart's, not its lines'**: `total_price` and Liquid's
    `checkout_charge_amount` are the items after it, `total_discount` what it takes, and one
    cart-level discount application of type `discount_code` says so. A free-delivery code takes
    nothing off the cart: Liquid's `discount_applications` has it aimed at the shipping line
    checkout adds, and themes' lists of what is taken off do not.
  * **Hatti Base's cart page and drawer show the subtotal, the code and what it takes off, and
    the total**, free delivery by code, or a code that does not apply yet, in English and Urdu;
    the shop's free-delivery threshold is for the items after their discount, as at checkout.
* **Consequences:**
  * Every followed link that brings no cart begins one, link previews' fetches included; such
    carts hold nothing but the code, and expire as others do.
  * Codes put on carts by links or scripts are not among checkout's ten; the limit on cart
    changes bounds those, and a cart tells a guesser only of codes that apply to it.
  * A shopper sent on without the code, past the limit or with the core away, is not told; the
    cart and checkout show no code.
  * A closed shop's links lead to its password page, without the code.
* **Alternatives:**
  * **The code in a cookie of its own until something is added:** no cart for link previews,
    but every cart change would have to carry the cookie, and a script's `/cart.js` could not
    say what the code takes off.
  * **Saying why a code does not apply in the cart**, for themes to show: it would tell anyone
    which codes a shop has, with no count of the codes tried.
  * **Refusing links from other sites, as the cart's forms are:** the links are for sharing
    elsewhere.

## ADR-065 · A cart permalink begins a cart of its own and goes to its checkout, leaving the shopper's cart as it is

* **Context:** shops in Pakistan sell in chats: a shopper asks on WhatsApp or Instagram, and the
  shop sends a link to pay on delivery. Shopify's cart permalinks,
  `/cart/{variant}:{quantity},…`, are such links, with `discount`, `note` and `attributes` in
  their query; they take the shopper straight to checkout. Carts belong to shoppers, through a
  cookie (ADR-042), and checkout is a cart's (ADR-044). Drafts (ADR-031) are for orders agreed
  one by one, at prices of their own.
* **Decision:**
  * **A permalink begins a cart of its own**, of the items it names, with its `discount`,
    `note` and `attributes`, and sends the shopper to that cart's checkout. The shopper's own
    cart, in their cookie, stays as it was, so a link sent in a chat never empties or changes
    what they were choosing on the shop.
  * **Variants are named by their IDs**, as themes see them; quantities are whole numbers.
    Items that cannot be had, sold out or no longer for sale, show the shopper's own cart with
    why, as a refused cart form does. What the link adds to its items is not needed to go on:
    if the core refuses it, the items go to checkout without it.
  * **Links come from anywhere**, so one followed from another site is taken, as discount links
    are (ADR-064); each counts as a change to carts, under the same limit, past which the
    shopper is asked to wait a moment. A HEAD request changes nothing.
  * **Placing an order sets the cart count from the shopper's own cart**, which the order
    emptied if it was the cart ordered, rather than to 0.
* **Consequences:**
  * Every followed link begins a cart and a checkout, link previews' fetches included; they
    expire as others do.
  * The checkout's page does not take the shopper's name or address from the link, as
    Shopify's `checkout[shipping_address]` would; a shop that knows them sends a draft's link.
  * A link's items are priced and held to stock when it is followed, not when it was made.
* **Alternatives:**
  * **The link's items added to the shopper's cart:** a shopper would check out what they had
    chosen before as well, or lose it.
  * **A page that asks before beginning the cart:** a tap more on every link, for link previews'
    sake.

## ADR-066 · What couriers owe is worked out from the orders when asked: delivered cash-on-delivery orders not yet paid, by courier and by days since delivery

* **Context:** couriers collect cash on delivery and pay it over days or weeks later, less their
  charges, and a shop needs to know who owes what, and since when (COD-10, 06 §7). The home
  gives the cash still to come as one figure (ANL-01). Orders keep what was paid,
  `amount_paid`; parcels keep the courier staff named and when they were delivered. Couriers'
  remittance statements come next.
* **Decision:**
  * **Owed is `total - amount_paid` on cash-on-delivery orders at `delivered`**: what the order
    still owes, whatever was paid ahead or since, which marking the order paid, or a
    remittance, settles.
  * **Its age runs from the order's last delivered parcel**, in whole days, in four bands: up to
    a week, a fortnight, a month, and longer. **Its courier is that parcel's**, as staff named
    it, in any letter case, the spelling used most standing for the rest.
  * **On its way** is the same on orders `in_transit` or `partially_fulfilled`; with what is
    owed, it is the home's cash still to come.
  * **Worked out from the orders when asked**, as COD health is (ADR-060): orders waiting for
    their cash are few, and the stage index finds them.
* **Consequences:**
  * An order delivered in parcels by two couriers counts under the last; one paid in part shows
    what is left until the rest is paid.
  * Couriers are as staff typed them: "TCS" and "T.C.S." are two until parcels are booked
    through Hatti (SHP-01).
* **Alternatives:**
  * **A table of receivables kept as parcels are delivered and orders paid:** a second record of
    what the orders already say, to keep in step.
  * **Ages from when the order was placed:** a courier owes from delivery, and an order slow to
    confirm or ship would look overdue.

## ADR-067 · Couriers' remittance statements are imported whole into a logistics module, each line's cash received on its parcel's order, at most what the order owes, and a parcel's cash once

* **Context:** couriers pay a shop the cash they collected days or weeks later, less their
  charges and the tax they withhold, with a statement, usually a spreadsheet, of the parcels it
  is for (COD-10, 06 §7). Shops reconcile them by hand today: which parcels were paid, which
  short, which never. Each courier names its columns its own way. Parcels keep the tracking
  number staff typed, and orders what was paid (ADR-066). The architecture gives remittances to
  Fulfillment & Logistics, a module that did not exist; parcels are still the orders module's.
* **Decision:**
  * **A logistics module (`@hatti/logistics`) keeps statements** (`cod_remittances`) and their
    lines (`cod_remittance_lines`), each with the parcel and order it matched. It reaches orders
    only through functions of the orders module that take its transaction: parcels by tracking
    number, what their orders owe, locked, and cash received on an order.
  * **A statement is the CSV the courier sends**, its columns found by the names couriers use
    ("CN #", "Tracking Number", "COD Amount", "Delivery Charges", "WHT", "Net Payable" and their
    like), its amounts as they write them, a totals row passed over. Rows that cannot be read are
    reported; the rest are taken.
  * **Lines match parcels by tracking number without spaces, in capitals**, the courier's own
    parcel first when two share a number. Each line's cash is received on its parcel's order, at
    most what the order still owes: `received`, `short` or `over`. Lines that match no parcel
    (`unmatched`), name one whose cash a line has collected before (`repeated`), or an order
    that owes nothing (`not_owed`), receive nothing and are kept to look into; a line with no
    cash on a parcel sent back is the courier's charges (`charged`).
  * **A statement is taken whole, in one transaction**, its parcels' orders locked in turn, so
    that two statements naming a parcel at once receive its cash once. Orders take the cash as a
    payment, in full or in part, with a line on their timeline; the order's own events follow.
    A statement's reference from the same courier is taken once. A dry run says what would
    happen and writes nothing.
  * **Owners, managers and accountants reconcile**, and apps with `write_orders`: receiving cash
    marks orders paid.
* **Consequences:**
  * A parcel the courier pays for but staff never marked delivered is paid, and stays on its
    way until it is marked.
  * A shortfall paid in a later statement is `repeated`, not received: staff mark the rest paid,
    as a statement imported twice must not pay twice.
  * Charges and tax are kept with each line and statement, for the ledger and tax credits to
    come; they are not taken off what the order received.
  * Excel writes long tracking numbers as `1.23E+11` unless they are kept as text; such lines
    match nothing.
* **Alternatives:**
  * **Remittances in the orders module, beside parcels:** quicker, but courier bookings and
    tracking come next and belong together, and the orders module is already the largest.
  * **Each courier's format known by name:** exact, but every courier's file to learn and
    follow; column names cover them, and a format can be added where they do not.
  * **Lines received one by one, in transactions of their own:** a failure halfway would leave a
    statement half taken.

## ADR-068 · A cash-on-delivery customer may cancel through the order's link until it is packed, though they confirmed it, unless the shop keeps that to before confirming

* **Context:** a customer cancels through their order's link while it waits for them to confirm
  it (ADR-032), and corrects its address until it is packed (ADR-033). A customer who changes
  their mind after confirming has had to message the shop, which often learns too late: the
  parcel ships and comes back refused, costing the shop both ways (RTO). The order status page
  (05 §8) is to allow "cancellation within the merchant's window". Shops differ: some would
  rather call a customer who wavers.
* **Decision:**
  * **A shop's order settings** (`orders.order_settings`, `orderSettings`) **say how long its
    customers may cancel**: `until_packed`, the default, or `until_confirmed`, as before.
    Owners and managers change them (`write_settings`); the change is audited, and an
    `order_settings.updated` event.
  * **Until it is packed, a confirmed cash-on-delivery order can be cancelled through its
    link**, while nothing has been paid or shipped, the same cutoff as correcting its address.
    The page offers it below the order, and asks first (`?cancel`), as before confirming.
  * **The cancellation is the customer's**, its reason `customer`, its stock released; the
    order stays confirmed, and the timeline says they cancelled after confirming it, so the
    shop sees a customer who changed their mind, not one who declined.
* **Consequences:**
  * Fewer parcels refused at the door; a shop whose customers cancel often learns it from the
    timeline and the cancellations' reason.
  * A shop that prints slips before marking orders packed may pack an order its customer has
    cancelled; marking orders packed as slips print closes the gap, as for addresses.
  * Whoever holds a forwarded link can cancel the order until it is packed, as they could
    correct its address; the timeline says it happened through the link.
* **Alternatives:**
  * **A window of hours from placing:** easier to say, but an order may wait days to be packed,
    or be packed within the hour; packed is when cancelling starts to cost.
  * **Cancelling until shipped:** a packed parcel may already be labelled and booked.
  * **A cancellation request for staff to accept:** the shop would act on every one anyway, and
    a request the shop misses still ships.

## ADR-069 · The checkout's page takes the shop's accent colour from its published theme, on its buttons, and on its links where they stay readable

* **Context:** the checkout's page is the core's, not the theme's (ADR-044), and was in the
  platform's teal for every shop. A shopper who comes from a storefront in the shop's colours to
  a page in another's may wonder whether they are still with the shop, at the moment they give
  their name, number and address. CHK-14 asks for the shop's logo, colours and trust badges on
  it. Shops set their colours in their theme already: Hatti Base's `color_accent` is its buttons'
  and links' colour. The page allows no style but its own, by its hash, and no `style`
  attributes.
* **Decision:**
  * **The page takes the accent colour of the shop's published theme**, in its current settings
    or the preset they name, as its storefront pages have it (`shopAccentOf`): one colour, set in
    one place, not a checkout setting to keep in step with the theme.
  * **Hex colours alone** (`#rgb` or `#rrggbb`): the page works out from them what reads on them.
    A colour given in `rgb()` or with transparency, or none, leaves the platform's.
  * **Buttons take the colour, with white or dark text, whichever contrasts more with it; links
    and focus rings take it where it reads on white at 4.5 to 1**, as WCAG asks of text, and the
    platform's colour otherwise. On the few mid tones where neither white nor the dark text
    reads at 4.5 to 1, buttons' text is black, which always does then: no colour leaves a button
    hard to read. Colours that say what happened stay: a mistake's red, an order placed's green.
    Dark mode keeps the platform's colours, made for it.
  * **The colour comes as a style element of its own**, setting the page's variables and nothing
    else, its hash added to the page's content security policy: nothing the shop saved reaches
    the page but a hex colour.
  * A page with no shop to show, such as a checkout not found, keeps the platform's colours.
* **Consequences:**
  * The shopper sees the shop's colour from its storefront to its thank-you page, and a shop that
    changes its theme's colour changes its checkout with it, when the page is next shown: one
    more small read of the theme's settings each time.
  * A light colour gives buttons dark text, and links the platform's colour: readable rather
    than exactly the shop's.
  * `renderPage` takes an accent for any page; the orders' links' pages keep the platform's
    colours until they take the shop's too.
  * Not yet: the shop's logo, which Hatti Base does not have (its header shows the shop's name),
    and comes with images the shop uploads; trust badges the shop chooses, since what it
    promises is in its policies, which the page links and placing the order agrees to (ADR-057),
    and cash on delivery, which the page says; and custom fields (V1).
* **Alternatives:**
  * **A checkout colour of its own**, as Shopify's checkout branding has: another place to set
    the same colour. It can come later, over the theme's.
  * **The theme styling the page**, as Shopify's `checkout.liquid` did: refused in ADR-044.
  * **A colour for dark mode worked out from the shop's**: a shade guessed from it may clash with
    the shop's own, where the platform's dark colours were chosen for dark mode.
  * **`style` attributes**: the policy would need `'unsafe-inline'`, or `'unsafe-hashes'` with a
    hash for each.

## ADR-070 · An address keeps its area in its second line and its landmark in a field of its own; checkout and customers' links ask for each, suggesting the areas of the larger cities

* **Context:** a house in Pakistan is found by its area and a landmark near it more than by its
  number, and postcodes are rarely used: the pattern is a city, an area, a landmark and perhaps
  a map pin (research 03 §3.4). Couriers sort parcels by area; riders ask for the landmark.
  Checkout asked for both in one box, "Area or landmark", which orders kept as `address2`, and
  customers' links called it a landmark: given one box, a shopper gives one or the other.
  Shopify's addresses have no landmark: apps built for them read `address1`, `address2` and
  `formatted`. Daraz asks for the area, the address and a landmark apart.
* **Decision:**
  * **An address's second line is its area** (`address2`), as addresses are written here: the
    house and street, the area, then the city. Apps built for Shopify's addresses find it where
    they look.
  * **The landmark is a field of its own**, Hatti's (`landmark`), optional, up to 255
    characters: on orders and drafts, and on the Admin API's `MailingAddress` and
    `MailingAddressInput`. `formatted` gives it a line after the area, so that labels printed
    from it carry it; packing slips, invoices, exports and the pages customers see show it.
  * **Checkout and customers' links ask for each in a box of its own**, the landmark's saying
    what it is for. The area's box suggests well-known areas of the ten larger cities
    (`PK_CITY_AREAS` in `@hatti/pk`): the city's, once the form has one; while it has none, every
    listed city's, each by its city, since a page without scripts cannot change its suggestions
    as the city is typed. Suggestions only: any area may be typed, and none is required.
  * **Addresses kept before** are given no landmark (migration 0040): their second line stays as
    it was typed, often a landmark where the area now goes.
* **Consequences:**
  * Couriers' bookings (spike 2) can send the area and the landmark as each courier takes them;
    reports and risk can use areas once they are named alike.
  * An app built for Shopify misses the landmark unless it prints `formatted`.
  * While no city is typed, the checkout's page carries some 200 areas to suggest: about 11 KB,
    under 2 KB compressed.
  * The lists are the platform's, of well-known names, and far from whole; couriers' own lists
    (Call Courier books by area) will check and widen them.
* **Alternatives:**
  * **The landmark in `address2` and the area in a field of Hatti's:** apps built for Shopify
    would lose the area, which couriers sort by.
  * **Both in `address2`, joined:** neither could be suggested, printed or searched apart.
  * **The area picked from a required list,** as on Daraz: it needs every area of every town,
    which couriers' lists will give; a box with suggestions never turns away an address the list
    lacks.
  * **A map pin:** it needs scripts and the phone's location; it comes later, as an addition to
    the page.

## ADR-071 · A parcel coming back is checked in by the tracking number on its label, matched as couriers' statements are; those on their way back are listed the longest first

* **Context:** refused and undeliverable parcels (return to origin) are cash-on-delivery's
  largest loss. A parcel that comes back is checked in at the shop with each item restocked or
  written off (`fulfillmentReceiveReturn`), found by its ID, which no one at a packing table
  has: they hold a parcel with a courier's label, and often a scanner that types its tracking
  number. Couriers bring parcels back late, or not at all, and a shop learns which only by
  counting the days. Staff type tracking numbers as they see them ("LE 7001 234"); scanners
  read them without spaces; couriers' statements are already matched with spaces and letter
  case ignored (ADR-067).
* **Decision:**
  * **`fulfillmentReceiveReturn` takes the parcel's tracking number in place of its ID**,
    matched as statements are: spaces and letter case ignored, on the same index. It must name
    one parcel still out (in transit or coming back); a number on two still out names their
    orders and checks neither in, to be checked in from its order. A parcel already checked in,
    or delivered, says so as by its ID, at the tracking number's box. Everything is restocked
    unless `restock` says otherwise, as before.
  * **A parcel brought back before anyone marked it coming back is checked in all the same**:
    the parcel in hand is what counts.
  * **`returningParcels` lists the parcels on their way back, the longest on its way first**,
    with the days since each started back, its courier, tracking number, order and items, and
    one courier's alone if asked: those a courier is slow to bring back come to the top, to
    chase. A partial index keeps it to the parcels coming back (migration 0041).
  * **The orders list finds an order by its parcel's tracking number matched the same way.**
* **Consequences:**
  * A returns desk scans a parcel and is done; one with damaged items looks the order up by the
    same scan and says what goes back on the shelf.
  * A number staff typed twice by mistake stops a scan until one is checked in from its order;
    the message names both orders.
  * Not yet: parcels the courier lost, written off with their order closed and a claim on the
    courier; what a return cost the shop (06 §6, RTO cost); returns couriers report through
    their APIs (spike 2).
* **Alternatives:**
  * **A query to find the parcel, then the mutation by its ID:** two calls for the commonest
    case, an intact parcel; the query is there anyway, as the orders list.
  * **The latest parcel with the number when several are out:** a scan would check in a parcel
    still on its way, its items counted twice.
  * **Exact tracking numbers only:** scans of numbers typed with spaces would find nothing.

## ADR-072 · A parcel the courier lost is written off, and an order with nothing delivered or back ends at a stage of its own; lost before reaching the customer, it is never their refusal

* **Context:** couriers lose parcels: on their way out, before the customer ever sees them, and
  on their way back after a refusal ("RTO lost"), and shops claim the parcels' worth from them.
  A lost parcel could only be left in transit or coming back for good, its order never done and
  counted among those on their way, or be checked back in as if it had come, its items counted
  on a shelf they never reached. Whose doing it was matters: risk scores, the Confirmation Desk
  and COD health count customers' refusals, and a parcel lost before reaching a customer is
  none.
* **Decision:**
  * **`fulfillmentMarkLost` writes a parcel off**, in transit or coming back: it is `lost`, with
    `lostAt`, nothing of it restocked, and the timeline says so ("Lost by TCS 7790: 3 items
    written off", "on its way back" when it was coming back). Lost twice is still lost.
  * **An order whose parcels were neither delivered nor brought back ends at a stage of its
    own, `lost`**: done and closed as one returned is, an unpaid cash-on-delivery order voided;
    a prepaid one stays paid, for the shop to settle with its customer. One parcel of several
    lost leaves the order to the others: delivered and unpaid in part until it is paid.
  * **A lost parcel takes no more news from its courier** (delivered, coming back). If it turns
    up, it is checked back in as any parcel, by its ID or its tracking number, its items back on
    the shelf, and it stays counted as lost: the order stays `lost`.
  * **Lost before reaching the customer, it is never their refusal**: their delivery history
    counts it as lost, risk scores leave it out, and COD health counts it as lost, the courier's,
    in neither rate. **Refused first, it stays a refusal** everywhere, though the courier lost it
    on its way back. `returningAt` tells the two apart.
  * **Its items count as returns in sales reports**, as a refused parcel's do: neither was sold.
  * The customer's page says the courier lost the parcel, and that the shop will be in touch.
* **Consequences:**
  * Couriers' losses show beside their returns, courier by courier, and stop inflating the
    parcels on their way.
  * No claim on the courier is kept yet: what a courier pays for a lost parcel comes in its
    statement as a line to look into (`not_owed`, ADR-067).
  * A lost parcel found and delivered cannot be recorded: the order is done, and closed orders
    take no payments.
* **Alternatives:**
  * **Lost as returned:** stock counted that never came back, and a refusal held against a
    customer who never saw the parcel.
  * **A flag on parcels left in transit:** their orders would never be done.
  * **Claims now:** each courier has its own process for them, which their APIs (spike 2) will
    show.

## ADR-073 · The Confirmation Desk deals orders waiting for their customers to agents one at a time, the most urgent due first, and keeps the calls that did not settle them

* **Context:** most cash-on-delivery orders are confirmed by a call before they ship; shops with
  more than a handful a day have agents who call all day (06 §3.2, COD-04). Two agents working
  from one list call the same customer; an unanswered customer is forgotten or called every few
  minutes; a promise to call back after her shift lives on a scrap of paper. The order list
  shows what waits, not what to call next.
* **Decision:**
  * **The queue is the orders waiting for their customers to confirm them**
    (`needs_confirmation`), due for a call from when they are placed. Held orders are the shop's
    to decide, on their own tab: whoever reviews one may call and record it too, but it is not
    dealt out.
  * **The most urgent first:** orders of high value, as the shop's risk policy sets it, then
    those due longest, then the riskier. `confirmationQueue` lists them, with how many are due
    and how many wait for later.
  * **`confirmationQueueNext` deals an agent one order**, the most urgent no one else has taken,
    theirs for 15 minutes, so that no two agents call the same customer; asked again, they get
    the one they have. Taking an order is the queue's, not the order's: no version, timeline
    entry or event.
  * **`orderConfirmationCall` keeps a call that did not settle the order** and lets it go: no
    answer, due again in two hours or when the agent says, and after three the customer could
    not be reached (`no_response`), still called; asked to call back, due then, within a week;
    a wrong number, held for review. Confirming and cancelling stay `orderConfirm` and
    `orderCancel`. Each call is kept with its outcome and the agent's note, which erasure
    clears and the timeline leaves out.
* **Consequences:**
  * Agents work through orders without stepping on each other, and a shop sees what is due now
    and what waits for later; the calls are there for agents' performance (COD-11).
  * A claim runs out after 15 minutes: an agent on a long call takes the order again by asking
    for the next.
  * Not yet: SLA timers and the shop's confirmation policy (COD-05: channels, quiet hours,
    giving up), WhatsApp and IVR attempts (COD-01, COD-03), and the queue in the admin app.
* **Alternatives:**
  * **Held orders first, in the agents' queue** (06 §3.2): a held order waits for a decision
    agents may not take, such as a blocked number, and a wrong number would come straight back.
  * **Orders assigned to agents ahead of time:** a shop's agents come and go during the day; a
    queue each asks of keeps them all busy.
  * **By total, the largest first:** a small order would wait behind every larger one, however
    long; the shop's own line for high value is enough.

## ADR-074 · A shop that gives its bank account offers bank transfer: the order waits for the money at a stage of its own, and keeps the account its customer was told to pay into

* **Context:** most shops here without a gateway take bank transfers: the customer pays into
  the shop's account from their banking app, by IBAN, and sends the receipt in a chat (05 §6,
  PAY-02). Above Rs 200,000, the law's cap on cash at the door (ADR-058), it is how most
  shoppers can pay at all, and checkout turned them away. A transfer is not cash on delivery: no
  one need call to confirm an order its customer has paid for, and nothing should ship before the
  money is in.
* **Decision:**
  * **A shop gives one account** (`bankTransferSettingsUpdate`, `write_settings`): its title,
    its bank and a Pakistani IBAN, spaced or not, kept unspaced, its check digits checked; and
    what customers are told besides, such as where to send the receipt. Checkout offers bank
    transfer while the shop has it on; staff may place bank-transfer orders either way. A change
    is audited with the account before and after: diverting customers' money to another account
    is what a stolen staff login would do.
  * **A bank-transfer order is placed unpaid and waits at `awaiting_payment`** until staff see
    the money and mark it paid (`orderMarkAsPaid`), which moves it to To pack: it can't be packed
    or shipped before. It needs no confirming, as paying is the customer's say-so, and is not
    scored for risk, which is of cash refused at the door; a blocked number's is still held for
    review first. Nothing is collected at the door, and it takes no advance. Its customer may
    cancel it through its link until they pay.
  * **The order keeps the account its customer was told to pay into**, as it was when placed:
    an account changed later is for later orders.
  * **Checkout offers a choice**, cash on delivery unless the shopper picks transfer, and
    transfer alone for a cart above what cash on delivery may collect. The page names the bank;
    the thank-you page and the order's link show the account, its IBAN in groups of four and
    selected whole with a tap, the amount, and the order's number to give as the transfer's
    reference. Drafts may be paid by transfer too: their order waits the same way, and a draft's
    link stays for cash on delivery.
  * The admin's home counts the orders awaiting payment, and their packing slips say not to pack
    them.
* **Consequences:**
  * Shops take orders paid in advance without a gateway, and orders above the cash cap through
    checkout.
  * Staff match transfers to orders by hand, in their bank's app, by the reference and amount.
  * Not yet: the customer sending the receipt through the page (with file storage), the shop's
    Raast QR, reminders and cancelling orders never paid, more than one account, and reading
    receipts with AI (Growth).
* **Alternatives:**
  * **`prepaid`, marked paid later:** a prepaid order is paid when placed, and would say so of
    one that is not.
  * **Confirming transfers as cash-on-delivery orders are confirmed:** a customer who pays has
    confirmed; a call would only hold the order up.
  * **Showing the shop's account as it is now:** a customer who paid into the old account would
    see one they never used, and a stolen login changing it would reach orders placed before.
  * **The account in a payments module of its own:** there is none until online payment
    (PAY-01), and both orders' pages and checkout read it; the orders module keeps it, beside the
    shop's other order settings, until then.

## ADR-075 · A shop keeps cash on delivery to the orders it trusts: up to a total of its own, outside cities it names, and not for customers who refused parcels before; checkout offers transfer instead

* **Context:** every parcel refused at the door costs a shop a return (06, COD-06). Shops keep
  cash on delivery from the orders they don't trust: large ones, cities their couriers serve
  badly, customers who refused before (05 §4.4, CHK-07). Until bank transfer
  ([ADR-074](#adr-074--a-shop-that-gives-its-bank-account-offers-bank-transfer-the-order-waits-for-the-money-at-a-stage-of-its-own-and-keeps-the-account-its-customer-was-told-to-pay-into)),
  checkout had no other way to pay to offer them.
* **Decision:**
  * **A shop sets its rules** (`cashOnDeliverySettingsUpdate`, `write_settings`): a total above
    which it takes no cash on delivery, cities where it doesn't, as addresses name them, and how
    many refused parcels a customer may have had before, as their delivery history counts them.
    None applies until the shop sets it.
  * **Checkout keeps to them, and only checkout:** orders staff and apps place, and drafts their
    customers confirm, are the shop's own call, and keep to the law's cap alone (ADR-058).
  * **The page says what it can before the shopper types:** the total and the cities, with the
    cash-on-delivery option; a cart whose items alone come to more is offered transfer alone,
    or, without it, nothing to fill in. **Placing checks the rest:** the total with delivery, the
    city typed, and the history of the customer with the number typed, any number of theirs.
    Kept from cash on delivery, the page says why, keeping what the shopper typed, with transfer
    chosen for them where the shop takes it; a customer kept from it for their refusals is not
    told so.
  * The page's digest covers the rules it states, so a change while it is open shows it again.
* **Consequences:**
  * Shops that take transfers keep cash on delivery to the orders worth it; shops that don't
    lose online the orders their rules keep from it, whose shoppers the page sends to the shop.
  * Not yet: rules for products, such as pre-orders or stitching, which need settings of their
    own on products; a risk score's outcome at checkout; partial advances; and the fee for cash
    on delivery (CHK-08).
* **Alternatives:**
  * **Rules for every order, staff's too:** staff agree how a customer pays in the chat; a rule
    would only stand in their way.
  * **Holding refused customers' orders for review, as risky ones are:** the order would be
    placed for a shop that already said it won't take their cash.
  * **Telling a customer why:** the number typed may not be theirs; the shop can tell them in
    the chat.

## ADR-076 · A shop's fee for cash on delivery is the order's own amount, apart from delivery: in its total and the cash collected, said beside the option where the shopper chooses

* **Context:** many shops here charge for cash on delivery, Rs 50 to 150 an order, as their
  couriers charge them for collecting it (CHK-08; the pricing pipeline in 05 §3 puts payment
  adjustments, such as a COD fee, after delivery). Folded into delivery charges, a fee would show
  on a free-delivery order as a delivery charge, and no report could say what a shop charged for
  which.
* **Decision:**
  * **The shop sets its fee with its rules for cash on delivery** (`fee`, through
    `cashOnDeliverySettingsUpdate`); checkout adds it to orders paid on delivery, and none to
    transfers.
  * **The order keeps it as an amount of its own, `codFee`:** total = subtotal − discount +
    shipping + codFee, which a database check holds. It is cash collected at the door, so the
    law's cap counts it. Invoices, the thank-you page and the customer's link show it on a line
    of its own; exports have a column for it; sales reports count it as additional fees, in
    total sales, as Shopify's reports do.
  * **The page says it where the shopper chooses:** beside transfer, the option says it ("with a
    Rs 100 fee") and the summary's total, either way's, leaves it out; alone, the summary adds a
    line for it to what is paid at the door. The page's digest covers it.
  * Orders staff and apps place have none: a fee agreed in a chat goes in the delivery charge or
    the price.
* **Consequences:**
  * Shops recover what collecting cash costs them, and shoppers see the fee before they choose.
  * Not yet: something off for paying by transfer (the prepaid incentive), fees on staff's
    orders and drafts, and fees that depend on the total or the city.
* **Alternatives:**
  * **Adding it to the delivery charge:** a free-delivery code would leave the fee as a delivery
    charge, and neither the shop nor its reports could tell the two apart.
  * **A line item for the fee, as some of Shopify's apps add:** sales reports would count it as a
    product sold, and packing slips would list it.

## ADR-077 · Something off for paying by transfer is part of the order's discount, kept apart from the codes': off the items after any code, to the rupee, said where the shopper chooses

* **Context:** cash on delivery costs shops twice: the courier's fee for collecting it, and the
  parcels refused at the door. Shops here nudge shoppers to pay first with something off for it,
  5% or Rs 150 or so (CHK-08's prepaid incentive; the pricing pipeline in 05 §3 puts payment
  adjustments after delivery). Bank transfer is the way to pay first that checkout offers
  (ADR-074).
* **Decision:**
  * **The shop sets it with its bank account** (`discount`, through
    `bankTransferSettingsUpdate`): a percentage, 0.01 to 50, up to a cap if it sets one, or an
    amount. Checkout offers it while it offers bank transfer; a shop may set it before. A change
    is audited with the account, before and after.
  * **Off the items after any discount code, to the rupee:** a percentage of what the items come
    to once the code took its share, rounded half up to a whole rupee, so that what the shopper
    transfers stays whole; an amount, no more than they come to. Delivery is what it was: free
    delivery's threshold is reached, or not, before it, so paying by transfer never costs
    delivery.
  * **The order keeps it in its discount, and apart as `transferDiscount`:** total = subtotal −
    discount + shipping + codFee as before, and a database check keeps it within the discount,
    on transfers alone. Invoices, the thank-you page and the customer's link show the codes'
    discount and it on lines of their own; exports have a column for it; sales reports count it
    in discounts, as it is one. A code's use counts what the code took off, not it.
  * **The page says it where the shopper chooses:** beside cash on delivery, the transfer's
    option says what it takes off this cart ("Bank transfer, Rs 250 off") and the summary's
    total, either way's, leaves it out; alone, the summary takes it off. The page's digest
    covers it.
  * Orders staff and apps place have none: what staff agree in a chat goes in their discount.
* **Consequences:**
  * Shops can steer shoppers to pay first, and shoppers see what they save before they choose.
  * Not yet: something off for other ways to pay first (wallets and cards, with PAY-01),
    incentives that depend on the cart or the customer, and on staff's orders and drafts.
* **Alternatives:**
  * **A discount code for transfers:** shoppers would have to know it and type it, and nothing
    would keep it off orders paid on delivery.
  * **Folding it into the discount alone:** the thank-you page and the invoice could not say
    what the code took off and what paying by transfer did, and no report could say what the
    incentive cost the shop.
  * **To the paisa, as codes take theirs:** 5% of Rs 4,990 is Rs 249.50, and Rs 4,740.50 is not
    what anyone types into a banking app here.

## ADR-078 · A shop keeps cash on delivery from products by their tags: a cart holding one is offered bank transfer alone, the page naming the product

* **Context:** pre-orders, custom stitching and made-to-measure pieces cost a shop the most when
  they are refused at the door, as no one else wants them (CHK-07; availability by product, in
  05 §4.4). Shops mark such products already, with tags such as "pre-order", as on Shopify,
  whose cash-on-delivery apps go by tags.
* **Decision:**
  * **The shop names tags with its rules for cash on delivery** (`unavailableProductTags`,
    through `cashOnDeliverySettingsUpdate`), up to 50, each once in any letter case; a product
    with any of them, in any letter case, is paid another way.
  * **The page knows before the shopper types:** a cart holding such a product is offered bank
    transfer alone, where the shop takes it, the page naming the product; otherwise there is
    nothing to fill in, and the page says to remove it or ask the shop. Checkout reads the
    products' tags with the cart's variants, and only when the shop names any.
  * The catalog knows nothing of the rule: tags are the shop's, and checkout reads them through
    the variants' snapshots, as orders read titles and prices.
  * Orders staff and apps place are the shop's own call, as for its other rules.
* **Consequences:**
  * Shops keep cash on delivery from what they can't sell again, without a setting on each
    product.
  * Not yet: an advance for such products rather than the whole (partial advance), rules by
    collection, and the product's page saying so before the cart.
* **Alternatives:**
  * **A setting on each product:** the catalog would carry a rule for payments, and a shop would
    set it product by product rather than tag them, as it does for its collections.
  * **Collections:** a smart collection of pre-orders goes by tags anyway, and a rule by
    collection would have checkout read memberships for every cart.

## ADR-079 · Files are kept in object storage under each shop's prefix, uploaded straight there through URLs the Admin API signs, and shown only through short-lived signed URLs; a directory stands in for R2 in development

* **Context:** the platform kept no files until now: product images are URLs elsewhere. Shops
  need to upload their own, for their pages and the logo on their checkout (CHK-14), and their
  customers to send the receipts of their transfers (PAY-02). R2 is the platform's object storage
  (ADR-007, 02 §tech stack), and 03 §7 keeps each shop's objects under its own prefix, private,
  shown only through short-lived signed URLs.
* **Decision:**
  * **`@hatti/storage` keeps files by key:** R2 through the S3 API, its requests and URLs signed
    with Signature Version 4, written in the package and checked against AWS's own examples;
    and, for development and tests, a directory the core serves at /storage, signing its URLs
    with HMAC, so the whole flow runs without a cloud account. Production must use the bucket.
  * **Keys are `shops/{shopId}/files/{fileId}/{name}`**, the name cut to letters, digits,
    hyphens and underscores with its type's extension. Nothing is public: a file is shown through
    a URL signed for an hour, by its name.
  * **Uploads go straight to storage, as Shopify's staged uploads do:** `stagedUploadsCreate`
    signs a PUT for each file's exact size and type, for an hour; the client sends the bytes;
    `fileCreate` makes a file of each upload once it is in, of that size, its first bytes those
    of its type, or removes it. Uploads staged a day ago and never made files are swept as the
    shop stages more.
  * **The files module keeps the records** (`files.files`, staged then ready), with
    `file.created` and `file.deleted` events: JPEG, PNG, WebP, GIF and PDF, up to 20 MiB, ten at a
    time, under Shopify's `read_files` and `write_files`, which owners, managers and marketers
    hold.
* **Consequences:**
  * In production, files' bytes never pass through the core, and none of a shop's files is
    readable without a URL the platform signed.
  * Not yet: products' media from files, the checkout's logo, receipts sent through the order's
    page, which has no scripts and so sends its form through the core; images resized at the
    edge; an external URL as a file's source; quotas per shop; scanning PDFs.
* **Alternatives:**
  * **The AWS SDK:** dozens of packages, for four calls and two signed URLs.
  * **Uploads through the core:** every byte through the API's servers and its 2 MB requests,
    for no check that storage can't do with the size and type it signed for.
  * **Forms posted straight to storage, with a signed policy:** R2 takes no POST uploads.
  * **A public bucket:** receipts and images not yet published would be anyone's to read.

## ADR-080 · A customer sends the receipt of their transfer through their order's page, in a form the core reads and keeps in storage by order; the shop sees it with the order

* **Context:** a customer who pays by transfer sends the receipt in a chat, a screenshot from
  their bank's app, and staff match it to an order by hand ([ADR-074](#adr-074--a-shop-that-gives-its-bank-account-offers-bank-transfer-the-order-waits-for-the-money-at-a-stage-of-its-own-and-keeps-the-account-its-customer-was-told-to-pay-into)). Their order's page shows
  where to pay; it should take the receipt too, so the shop sees it with the order. The page runs
  no scripts, so it can't upload straight to storage as the Admin API's clients do
  ([ADR-079](#adr-079--files-are-kept-in-object-storage-under-each-shops-prefix-uploaded-straight-there-through-urls-the-admin-api-signs-and-shown-only-through-short-lived-signed-urls-a-directory-stands-in-for-r2-in-development)): a form posts the file, and R2 takes no posted forms.
* **Decision:**
  * **While the order waits for its transfer, its page has a form** for a photo, a screenshot or
    the PDF of the receipt (`multipart/form-data`, `action=receipt`), posted to the page itself.
    The page then says the shop has it, and how many the customer sent.
  * **The core reads forms with a file on orders' pages alone** (`/o/`): one file of up to
    10 MiB, in memory, and a few short fields. Past 10 MiB the rest is read and dropped, so the
    page can say the file is too large; a form with a file anywhere else is refused (415).
  * **A receipt is told by its first bytes**, not by what the browser says: JPEG, PNG, WebP or
    PDF. Storage keeps it at `shops/{shopId}/receipts/{orderId}/{receiptId}.{ext}` before any
    transaction, so none waits on storage; then the order, locked, takes it while it is open and
    waits for the transfer, five at most. A receipt the order does not take is removed.
  * **The orders module keeps them** (`orders.transfer_receipts`): its timeline says the customer
    sent one, through the system, and `order.updated` names `transferReceipt` as changed; the
    order's version stays, as nothing of the order changed. The Admin API shows them on the order
    (`Order.transferReceipts`, under `read_orders`), oldest first, each through a URL signed for
    an hour and named for the order: "Receipt #1023-1.jpg".
  * **Erasing the customer deletes their receipts' records**, which show their name and account:
    the order keeps what it was paid. Nothing signs a URL for their files after.
* **Consequences:**
  * Staff see the receipt beside the order they mark paid, rather than in a chat from a number
    that may not be the order's.
  * A receipt's bytes pass through the core, up to 10 MiB each, held in memory while storage
    takes them.
  * Not yet: a list of orders with receipts to check, telling staff when one comes, removing
    erased receipts' files from storage, and reading receipts with AI (Growth).
* **Alternatives:**
  * **A script on the page uploading straight to storage:** the page runs none, and works on
    any phone without.
  * **Receipts as the shop's files** (`files.files`): those are the shop's library, of its own
    uploads; a receipt is its customer's, found and erased by order.
  * **Trusting the browser's type:** a page renamed `.jpg` would be kept as one.
  * **Streaming the file to storage as it comes:** R2 needs its length before it takes it, and a
    receipt is small enough to hold.

## ADR-081 · A shop's logo is one of its files, chosen as its brand's; the checkout's page shows it in place of the shop's name, through a URL signed for an hour that the page's policy allows alone

* **Context:** CHK-14 asks for the shop's logo on its checkout's page, which shows the shop's
  name instead, in its colour since [ADR-069](#adr-069--the-checkouts-page-takes-the-shops-accent-colour-from-its-published-theme-on-its-buttons-and-on-its-links-where-they-stay-readable). Hatti Base has no logo either: its header shows the
  shop's name. Shops upload files now ([ADR-079](#adr-079--files-are-kept-in-object-storage-under-each-shops-prefix-uploaded-straight-there-through-urls-the-admin-api-signs-and-shown-only-through-short-lived-signed-urls-a-directory-stands-in-for-r2-in-development)), none of them public, each shown through a URL
  signed for an hour. The page runs no scripts, and its policy allows nothing it does not name.
* **Decision:**
  * **The shop's brand keeps its logo, one of its files**, as Shopify's `shop.brand.logo` is one
    of its images: `shopBrandUpdate` sets it, or takes it away, and `Shop.brand` shows it, under
    the files' scopes. A logo is an image the shop uploaded, JPEG, PNG, WebP or GIF, never a PDF.
    Deleting the file takes the logo with it. The files module keeps it (`files.brands`), beside
    the files themselves, and records `shop_brand.updated`.
  * **The checkout's page shows it in place of the shop's name**, its thank-you page and its other
    pages too, named by the shop's name for those who can't see it, at most 200 by 64 pixels. On a
    dark page it sits on a white ground: logos are made for light ones.
  * **Through a URL signed for an hour**, made with the page, straight to storage, as the shop's
    other files are shown.
  * **The page's policy allows that image alone**, by its address without the signature: the
    page names the images it shows (`renderPage`'s `images`), each https, or http on localhost.
* **Consequences:**
  * Shoppers see the shop's own mark from the cart to the thank-you page. Each page fetches the
    logo again, as its signed URL is new each time: a small image, from storage straight.
  * Not yet: the logo on orders' links' pages, which keep the platform's colours too, and on
    invoices and packing slips; `shop.brand.logo` for themes, and a logo in Hatti Base's header,
    once images are served from the edge at addresses that last; a square logo, a slogan and
    brand colours, which Shopify's brand has; trust badges.
* **Alternatives:**
  * **A logo setting in the theme**, as its colour is: the storefront could not show it yet, with
    no images served from the edge, while the checkout did.
  * **The page fetching the logo through the storefront, on the shop's address:** a route for the
    shop's images that the edge keeps, which is the work of serving images from the edge.
  * **A public bucket, or the logo inlined in the page:** every file of the shop's public, or each
    page carrying the image's bytes.
  * **Allowing any image from storage in the page's policy:** a page could then show anything of
    the platform's storage that it was given a URL to.

## ADR-082 · A shop's account takes its Raast ID beside its IBAN, kept with each order as the account is, and shown on its customers' pages to copy; a Raast QR waits for the partner's

* **Context:** PAY-02 asks for the merchant's Raast QR beside the bank transfer of
  [ADR-074](#adr-074--a-shop-that-gives-its-bank-account-offers-bank-transfer-the-order-waits-for-the-money-at-a-stage-of-its-own-and-keeps-the-account-its-customer-was-told-to-pay-into). Raast, the State Bank's instant payment system, is how most transfers between
  Pakistani banks now move: free, and to a Raast ID, the mobile number a bank registered for an
  account, as well as to an IBAN. Customers read their order's page on the phone they pay from,
  where a code on the screen can't be scanned; typing or pasting a number is what they do. A QR
  for merchants (P2M) carries the State Bank's payload, which a partner bank issues.
* **Decision:**
  * **The shop's account takes its Raast ID**, a Pakistani mobile number in any format, kept in
    E.164, or none: `raastId` on `bankTransferSettingsUpdate`'s account. It is where the money
    goes, so a change is audited as the account's is, before and after.
  * **An order keeps it with the account its customer was told**, as the IBAN; orders placed
    before have none.
  * **The thank-you page and the order's page show it under the IBAN**, as people write mobile
    numbers, "0300 1234567", selected whole with a tap, to copy into a banking app.
* **Consequences:**
  * A customer pays by IBAN or by Raast ID, whichever their app asks for, to the same account.
  * Not yet: a QR, which comes with the partner's Raast (PAY-03): dynamic, for the order's amount,
    on a page read on a computer; and checking that the ID is the account's, which only the bank
    can do.
* **Alternatives:**
  * **A QR image the shop uploads:** a code from its bank's app shows on a page read on the same
    phone that would scan it, and carries no amount.
  * **Writing the Raast QR's payload ourselves:** the State Bank's specification is for its
    participants, and a code no app reads would cost a sale.
  * **The Raast ID in the shop's instructions:** free text, not checked, and not kept as the
    account is.

## ADR-083 · A cash-on-delivery order may ask for an advance, paid by transfer before it ships: it waits for it as a transfer waits for its money, and staff record it when it is in

* **Context:** shops here often ask for part of a cash-on-delivery order before they send it,
  the delivery charge or a share of a costly or made-to-order piece, paid by transfer, to cut the
  parcels refused at the door (CHK-07). An order kept an advance only once paid (`advancePaid`,
  which staff record as they place it); one that asks for an advance and waits for it had no
  place, and staff tracked it by hand. A bank transfer already waits for its money, keeps the
  account its customer was told, shows it on the customer's pages and takes the receipt
  ([ADR-074](#adr-074--a-shop-that-gives-its-bank-account-offers-bank-transfer-the-order-waits-for-the-money-at-a-stage-of-its-own-and-keeps-the-account-its-customer-was-told-to-pay-into), [ADR-080](#adr-080--a-customer-sends-the-receipt-of-their-transfer-through-their-orders-page-in-a-form-the-core-reads-and-keeps-in-storage-by-order-the-shop-sees-it-with-the-order)).
* **Decision:**
  * **A cash-on-delivery order may ask for an advance** (`advanceDue`): staff ask for it as they
    place the order, and checkout will by the shop's rules. Not beside an advance paid already,
    never more than the total, and only from a shop with a bank account, which the order keeps
    as a transfer's to tell its customer where to pay.
  * **It waits for the advance at `awaiting_payment`**, as a transfer waits for its money: it
    can't be packed or shipped before. It needs no call to confirm and is not scored, as paying
    is the customer's say-so; a blocked number's is still held for review. Its customer may
    cancel it through its link until they pay.
  * **Its customer's pages say what to pay ahead and what at the door**: the account with the
    advance as the amount to transfer, and the rest, which the courier collects (`codAmount`);
    the receipt is taken as a transfer's. The law's cap on cash at the door ([ADR-058](#adr-058--no-order-collects-more-cash-on-delivery-than-the-law-allows-whoever-places-it-the-rest-is-paid-in-advance-or-the-order-is-not-placed)) counts
    only what the advance leaves.
  * **Staff record the advance by hand, as any payment:** `orderCreateManualPayment`, as
    Shopify's records a manual payment, takes an amount, or what the order waits for by transfer,
    else the rest; one that makes up the total marks the order paid. It needs an idempotency key,
    as recording twice would count twice.
* **Consequences:**
  * The home counts orders waiting for their advance among those awaiting payment, and those
    with receipts among the transfers to check; the order list finds them by stage.
  * Not yet: checkout asking for an advance by the shop's rules (next), drafts asking for one, an
    advance as a share of the total, and reminders or cancelling for advances never paid.
* **Alternatives:**
  * **A stage of its own, `awaiting_advance`:** the same wait, page and check of the money as a
    transfer's; one stage keeps the counts, filters and pages one.
  * **A call to confirm first, then the advance:** two steps where paying is one.
  * **Recording the advance with `orderMarkAsPaid`:** it marks the order paid in full, which the
    courier's cash would then contradict.

## ADR-084 · Checkout asks for the advance the shop's rules name: an amount, a share of the items or the delivery charge, on every order or above a total, said beside cash on delivery

* **Context:** an order may ask for an advance on cash on delivery, which staff set as they
  place it ([ADR-083](#adr-083--a-cash-on-delivery-order-may-ask-for-an-advance-paid-by-transfer-before-it-ships-it-waits-for-it-as-a-transfer-waits-for-its-money-and-staff-record-it-when-it-is-in)). Shops ask for one by
  rule: most often the delivery charge, which a refused parcel costs them twice; a share of a
  costly order; or a token amount, often only above a total (CHK-10's "delivery charge or a %
  upfront"). Checkout's page has no scripts, and with zones it knows the delivery charge only
  once a city is typed.
* **Decision:**
  * **The shop's rules for cash on delivery name one advance** (`advance` on
    `cashOnDeliverySettingsUpdate`): an amount, never more than the items; a percentage of the
    items after any code, to the rupee, half up, as what paying by transfer takes off is
    ([ADR-077](#adr-077--something-off-for-paying-by-transfer-is-part-of-the-orders-discount-kept-apart-from-the-codes-off-the-items-after-any-code-to-the-rupee-said-where-the-shopper-chooses)); or the order's delivery
    charge, nothing where delivery is free. On every order, or only on those whose items come to
    more than a total of its own (`above`).
  * **It is paid into the shop's bank account**, which the shop must give before it sets one,
    offering bank transfer at checkout or not. Without the account, checkout asks for none: an
    account taken away leaves the rule, asking for nothing, and the shop's other rules still
    change.
  * **Checkout says it beside cash on delivery:** "you pay Rs 500 in advance by bank transfer,
    and the rest when your order arrives", or "the delivery charge" where that is the advance,
    whose amount the summary gives once it is known. Where cash on delivery is the only way to
    pay, the summary shows the total, the advance by transfer and what the door collects. The
    page's digest holds the advance, so a page shown before it changed shows itself again.
  * **The order it places asks for it** (`advanceDue`), worked out once the city is known, and
    keeps the account: it waits at `awaiting_payment` without a call to confirm or a score, and
    its thank-you page says where to pay it and what the door collects. Once staff record it,
    the page says the shop will be in touch. A shopper paying by transfer pays it all, and is
    asked for no advance.
* **Consequences:**
  * Shops cover what refused parcels cost them without turning cash on delivery away, as the
    rules of [ADR-075](#adr-075--a-shop-keeps-cash-on-delivery-to-the-orders-it-trusts-up-to-a-total-of-its-own-outside-cities-it-names-and-not-for-customers-who-refused-parcels-before-checkout-offers-transfer-instead) do.
  * Not yet: an advance by city or by customer, as for those who refused parcels before, instead
    of turning cash on delivery away; something off an advance paid by transfer; drafts asking
    for one; reminders for advances never paid, with messaging.
* **Alternatives:**
  * **An amount and a total alone:** the simplest, but shops ask most for the delivery charge,
    which differs by city, and for a share of costly orders.
  * **A share of the order's total, delivery included:** with zones, unknown until the city is
    typed; the items are known from the start, and are what paying by transfer takes its
    percentage of.
  * **Asking for it only where bank transfer is offered:** a shop may take transfers for advances
    alone; the account is what the customer pays into.
  * **An amount capped at the order's total:** unknown before the city with zones; capped at the
    items, the page states what the order asks for.

## ADR-085 · A draft may ask for an advance as an order does; once its customer confirms it, the draft's link shows where to pay and takes the receipt

* **Context:** drafts are orders taken in chats ([ADR-031](#adr-031--draft-orders-keep-agreed-prices-and-hold-no-stock-customers-confirm-them-through-a-secret-link)),
  where shops most often agree an advance with their customer, for a costly or made-to-order
  piece; a draft kept one only once paid (`advancePaid`). An order may ask for one
  ([ADR-083](#adr-083--a-cash-on-delivery-order-may-ask-for-an-advance-paid-by-transfer-before-it-ships-it-waits-for-it-as-a-transfer-waits-for-its-money-and-staff-record-it-when-it-is-in)), and checkout does by the shop's
  rules ([ADR-084](#adr-084--checkout-asks-for-the-advance-the-shops-rules-name-an-amount-a-share-of-the-items-or-the-delivery-charge-on-every-order-or-above-a-total-said-beside-cash-on-delivery)). A draft's customer confirms it through its link (`/d/`), which then
  shows the order; receipts were taken on orders' links alone
  ([ADR-080](#adr-080--a-customer-sends-the-receipt-of-their-transfer-through-their-orders-page-in-a-form-the-core-reads-and-keeps-in-storage-by-order-the-shop-sees-it-with-the-order)), whose forms with a file were read on `/o/` only.
* **Decision:**
  * **A cash-on-delivery draft may ask for an advance** (`advanceDue` on `draftOrderCreate` and
    `draftOrderUpdate`), checked as an order's is: not beside one paid already, never more than
    the total, the law's cap on what it leaves, and asked for only by a shop with a bank account.
  * **Its link's page says it before the customer confirms:** the summary's advance by transfer
    and what the door collects, and above the button, that they pay it by transfer to the account
    the next page shows.
  * **Confirmed by its customer, or completed by staff, its order asks for it** and waits at
    `awaiting_payment`. The draft's link, which shows the order from then on, says where to pay
    and **takes the receipt**, as the order's own link does: forms with a file are read on `/d/`
    too, and a draft not yet an order takes none.
* **Consequences:**
  * A customer goes from the chat to the advance paid on one link; the shop sees the receipt with
    the order, among the transfers to check.
  * An advance's receipts show where a transfer's do, on its order's link and through the Admin
    API's `transferReceipts`, which counted and listed them as none.
  * Not yet: the draft link's WhatsApp message says nothing of the advance, and its customer
    can't cancel through it, as through an order's link.
* **Alternatives:**
  * **The order's own link, sent once the draft is confirmed:** a second link for one order, and
    the draft's would still show the order without taking the receipt.
  * **Sending the draft's link on to a new order link:** a link the shop never sent, whose secret
    it never sees.

## ADR-086 · A shop chooses trust badges for its checkout from the platform's set, worded in English and Urdu and shown under the button where they hold

* **Context:** CHK-14 asks for trust badges on the checkout's page, the last of its MVP half; the
  checkout flow's design shows them under the button ("✓ Verified store · 7-day exchange"). A
  badge is a promise, and what a shop promises is in its policies, which the page links and
  placing the order agrees to ([ADR-057](#adr-057--what-a-shopper-agrees-to-in-placing-an-order-is-kept-with-it-the-versions-of-the-shops-policies-its-checkout-linked-and-where-it-was-placed-from)), which is
  why [ADR-069](#adr-069--the-checkouts-page-takes-the-shops-accent-colour-from-its-published-theme-on-its-buttons-and-on-its-links-where-they-stay-readable)
  left them out. The page has no scripts and allows no image but the shop's logo, and says
  everything in English and Urdu.
* **Decision:**
  * **The platform words a fixed set of badges in English and Urdu:** cash on delivery; open your
    parcel before you pay; an exchange or returns within the shop's days, 1 to 90; 100% original
    products; and help on WhatsApp. The shop picks up to four, each once, in its order
    (`checkoutTrustBadgesUpdate`, `write_settings`); nothing it types reaches the page.
  * **Each shows only where it holds:** cash on delivery and opening the parcel where the page
    offers cash on delivery for the cart; help on WhatsApp with the shop's number, which the shop
    can't choose it without, as a link to a chat; an exchange or returns linked to the refund
    policy where the shop has one, so the promise leads to its terms.
  * **Under the button that places the order**, a tick before each and the Urdu under the
    English, aligned as the payment choices are: text and a tick in the page's own style, so its
    policy stays as it is.
  * **The order keeps none of them:** what its customer agreed to is the policies, whose versions
    it keeps.
* **Consequences:**
  * Shoppers see what the shop promises where they decide, each promise leading to its terms or
    to the shop on WhatsApp.
  * Not yet: "verified store", which waits for the platform to verify shops; badges on the
    storefront, which are its theme's to show; badges of the shop's own words or images.
* **Alternatives:**
  * **Images the shop uploads, as Shopify's apps add them:** promises in one language, unchecked,
    each image another address for the page's policy to allow.
  * **The shop's own text:** its words in one language, and anything a shop types on the page.
  * **Badges worked out from the settings,** such as an exchange from the refund policy: a
    policy's terms can't be read reliably; the shop chooses what it promises.

## ADR-087 · Checkout takes at most three orders a day from one mobile number and twenty an hour from one internet address, counting the orders it placed, one at a time

* **Context:** fake cash-on-delivery orders cost shops most: each holds its stock, takes a call to
  confirm and, once booked, two journeys of a parcel. Checkout's page has no scripts, so a bot,
  or a prankster with made-up names, can post its form again and again; the blocklist and the
  risk rules hold such orders for review, but they are placed, and hold their stock. CHK-18 asks
  for limits on how fast orders come, and for Turnstile, which is the edge's, with the
  infrastructure. An order placed through checkout keeps the number it goes to and the internet
  address it came from ([ADR-057](#adr-057--what-a-shopper-agrees-to-in-placing-an-order-is-kept-with-it-the-versions-of-the-shops-policies-its-checkout-linked-and-where-it-was-placed-from)).
  Mobile networks in Pakistan put many phones behind one public address.
* **Decision:**
  * **Checkout takes at most three orders a day from one mobile number**, however it is written,
    counting the orders it placed for the shop in the last 24 hours, cancelled ones too.
  * **And at most twenty an hour from one internet address**, many more than from a number, as a
    mobile network's phones share addresses; orders from an address not known, or not an address,
    are counted by their number alone.
  * **They are counted in the placement's transaction, under a lock** on the number, then on the
    address, held until it ends: orders from one number placed at once are counted one at a time.
    The lock is the transaction's (`pg_advisory_xact_lock`), as PgBouncer's transaction mode
    allows, and nothing else waits on it.
  * **Past a limit, the page places nothing and says why**, answering 429: a number's limit tells
    the shopper to message the shop in their chat to order more; an address's, to try again later.
  * **The limits are the platform's**, the same for every shop. Orders staff, apps and drafts
    place are the shop's own call, and aren't limited.
* **Consequences:**
  * A flood from one number stops at three orders, and one from one address at twenty an hour,
    their stock left for real shoppers. An index on the orders' addresses keeps the count to a few
    rows (migration 0057).
  * A bot that changes both its numbers and its addresses still gets through, to the blocklist and
    the risk rules: Turnstile at the edge and the OTP (CHK-09) come with the infrastructure and
    messaging.
  * Not yet: limits a shop sets, such as more for a wholesale customer's number.
* **Alternatives:**
  * **Counters in Redis, as sign-in's are:** they count attempts rather than orders, apart from
    the transaction that places them, so a burst slips past; orders keep the number and the
    address already.
  * **A limit by browser, through a cookie:** bots drop cookies, and the page has no scripts.
  * **Refusing addresses outright:** one address is many shoppers on a mobile network.

## ADR-088 · A parcel keeps what couriers' statements charged for it, which COD health adds up for those that came back; a statement with the lines of one imported before is refused

* **Context:** a parcel sent back costs the shop the courier's charges both ways, its packaging
  and, now and then, the stock (06 §6, the RTO cost). Couriers' statements carry their charges
  line by line and are imported whole ([ADR-067](#adr-067--couriers-remittance-statements-are-imported-whole-into-a-logistics-module-each-lines-cash-received-on-its-parcels-order-at-most-what-the-order-owes-and-a-parcels-cash-once)): a
  delivered parcel's line has its cash and the charges taken off it; a parcel sent back has its
  charges alone, out and back, on one statement or two. The charges were kept with the
  statements' lines, so no one could say what a parcel, or a city's returns, had cost; COD health
  counts the parcels that came back ([ADR-060](#adr-060--cod-health-follows-a-periods-cash-on-delivery-orders-worked-out-from-them-when-asked-its-rates-of-those-that-turned-out)),
  not what they cost. And a statement imported again without its reference was taken again: its
  cash `repeated`, received once, but its charges alone would count twice once parcels add them
  up.
* **Decision:**
  * **A parcel keeps what its courier's statements charged for it** (`courier_charges`,
    migration 0058), added to as each statement is imported, through a function of the orders
    module that takes the import's transaction: every line's charges but those of a line for
    cash collected before, whose charges came with the cash. It is null until a statement
    charges the parcel; each charge is a line on its order's timeline and changes the parcel and
    its order, with their events. Statements imported before charge their parcels in the
    migration, by the same rule.
  * **COD health adds up what returns cost**: `returnCharges`, what statements charged for the
    parcels that came back, both ways, for the shop and by city, product, source and courier, a
    parcel once however many of its lines hold the product; and `returnsCharged`, how many of
    those parcels statements have charged, so that a figure with statements still to come reads
    as such.
  * **A statement is imported once.** As well as its reference from the same courier, one with
    the same lines as one imported before is refused, its lines known by a SHA-256 of them as
    read: tracking numbers without spaces, in capitals, and amounts in paisa, in any order. A
    statement saved again, sorted, or with its columns named otherwise is the same one. A
    parcel's cash is collected once, so the same lines with cash are a statement imported
    before; charges alone can come twice alike, a parcel charged out and back on statements of
    its own, and two such with references that differ are both taken.
  * **A shop's statements are imported one at a time**, under a lock the transaction holds
    (`pg_advisory_xact_lock`), so that the same statement imported twice at once is refused the
    second time. A dry run takes no lock.
  * **What a return cost is the courier's charges**: the tax a statement withholds stays with its
    line, for tax credits, and is not counted.
* **Consequences:**
  * A shop sees what its returns cost, by city, product and courier, as far as statements have
    come: the cost to weigh a city's or a product's cash on delivery by, and ask for an advance
    there (CHK-10). It starts the shipping cost per order (SHP-07) from what couriers charged
    rather than their rate cards.
  * Packaging and the stock written off are not in it: they are the shop's own costs, for the
    true profit report (ANL-03, V1).
  * A statement of charges alone with the lines of one imported without a reference is refused,
    though it might be another: one parcel charged alike out and back, each time on a statement
    of its own with no reference, loses the second charge.
  * Statements imported before migration 0058 have no digest: imported again, they are taken,
    their cash `repeated` as before, and their charges counted again.
  * Not yet: claims on couriers for lost parcels; returns couriers report through their APIs
    (spike 2).
* **Alternatives:**
  * **What a return cost worked out from statements' lines when asked**, as COD health is from
    orders: the orders module would read the logistics module's tables, or COD health move to
    logistics, away from the orders it counts.
  * **A cost per return the shop sets:** quick, but couriers charge by weight, distance and their
    own rate cards, and statements say what they charged.
  * **A statement known by its file's bytes:** saved again, or sorted, it would be taken twice.
  * **Each line refused if a statement before had it:** a parcel's line for charges back can be
    the same as its line out.

## ADR-089 · A shop's advance may be asked only to cities it names and of customers who refused parcels before: checkout names every city and says of whom, and placing applies them to the city and number typed

* **Context:** checkout asks for the shop's advance on every order paid on delivery, or on those
  above a total ([ADR-084](#adr-084--checkout-asks-for-the-advance-the-shops-rules-name-an-amount-a-share-of-the-items-or-the-delivery-charge-on-every-order-or-above-a-total-said-beside-cash-on-delivery)).
  Shops ask it where returns cost them most: in cities their couriers serve badly or slowly, and
  of customers who refused parcels before (CHK-10, 05 §4.4: the delivery charge up front in
  high-RTO cities). COD health now says what returns cost by city
  ([ADR-088](#adr-088--a-parcel-keeps-what-couriers-statements-charged-for-it-which-cod-health-adds-up-for-those-that-came-back-a-statement-with-the-lines-of-one-imported-before-is-refused)).
  The rules that keep cash on delivery from a city or a customer
  ([ADR-075](#adr-075--a-shop-keeps-cash-on-delivery-to-the-orders-it-trusts-up-to-a-total-of-its-own-outside-cities-it-names-and-not-for-customers-who-refused-parcels-before-checkout-offers-transfer-instead))
  turn the shopper away where an advance would keep the order. Checkout's page has no scripts:
  it knows the city and the number once they are posted, and that post places the order.
* **Decision:**
  * **The advance may name cities and refusals**, each a condition that the orders it asks must
    meet, as its total is: only to the cities named, as addresses name them, fifty at most; only
    of customers who refused that many parcels before, or more, as their delivery history counts
    them, as the rule that keeps cash on delivery from them does. Without either, it asks every
    order, as before.
  * **The page names every city, and says of whom**, beside cash on delivery, before anything is
    typed: "On orders to Quetta or Gilgit, if you refused a delivery from this shop before, you
    pay Rs 500 in advance by bank transfer." A shopper knows before placing whether it asks
    them. Once the city typed is one of them, and the advance asks nothing of the customer, the
    summary takes it off what the door collects.
  * **Placing applies it to the city and the number typed**, as it does the delivery charge: the
    order asks for the advance, or for nothing, and waits for it as before. The refusals of the
    number typed, any number of the customer's, are counted as the order is placed, and only
    where the shop's rules ask; the page looks nobody up.
  * The page's digest covers the cities and the refusals, so a change while it is open shows it
    again.
* **Consequences:**
  * A shop keeps cash on delivery in a city it doubts, with the delivery charge or a share of the
    items ahead, rather than turning shoppers away; and asks it of a customer who refused before
    without refusing them.
  * A customer whose number refused before learns that the advance asks them once the order is
    placed, as a refused customer learns that cash on delivery isn't available (ADR-075); the page
    says only the rule.
  * One rule: an advance in some cities for everyone, and another of refusers everywhere, cannot
    both be had.
  * Not yet: an advance of customers new to the shop, or by a risk score's outcome (COD-06).
* **Alternatives:**
  * **Looking the number up as it is typed, to say the amount:** the page has no scripts, and
    saying it would tell anyone who types a number whether its owner refused parcels.
  * **Showing the page again for the shopper to accept the advance once the city is typed:** a
    second post on every order the advance asks, for what the page already said.
  * **Cities or refusals, either one:** a shop could not ask refusers in one city alone; a rule of
    "only … only …" reads as each.
  * **Some cities named and the rest counted, as the cities without cash on delivery are:** a
    shopper could not tell whether the advance asks them; hence fifty at most, every one named.

## ADR-090 · Agents' performance is worked out when asked from the calls the desk keeps and the confirmations and cancellations on orders' timelines, by who made them, with how the orders each agent confirmed turned out

* **Context:** a shop with a Confirmation Desk wants to know how each agent does: how many
  orders they confirm an hour, how many customers they reach, and whether the orders they
  confirm are delivered or come back, which stops an agent confirming everything (06 §3.2,
  COD-11). The desk keeps each call that did not settle an order, with who made it
  ([ADR-073](#adr-073--the-confirmation-desk-deals-orders-waiting-for-their-customers-to-agents-one-at-a-time-the-most-urgent-due-first-and-keeps-the-calls-that-did-not-settle-them)); orders'
  timelines keep each confirmation and cancellation with who made it; COD health counts parcels
  delivered and returned ([ADR-060](#adr-060--cod-health-follows-a-periods-cash-on-delivery-orders-worked-out-from-them-when-asked-its-rates-of-those-that-turned-out)).
  Staff names are the identity module's.
* **Decision:**
  * **`confirmationAgents` says, for each agent over a period of work**, a year at most: the
    orders they confirmed; those they cancelled while they waited to be confirmed, as when the
    customer declined; their calls that settled nothing, by how they went; the hours of the
    shop's day in which they did any of it, their hours on the desk as their work shows them;
    and how the parcels of the orders they confirmed went, as they stand now, counted as COD
    health counts them, so that its return rate is the RTO rate of the orders they confirmed.
    The API adds the confirmation rate and confirmations an active hour. Those who settled most
    orders come first.
  * **An agent is whoever did the work**: a staff member, or an app by its access token, as an
    app confirming by WhatsApp would. Customers confirming through their links are no one's
    work. Agents are named by their IDs, which the admin app names from the shop's staff.
  * **Worked out when asked**, from the calls and the timelines, as COD health is from the
    orders; partial indexes find the confirmations and cancellations, and the calls, by when
    they happened (migration 0060).
  * **Owners and managers see it**, and apps with `read_orders`; agents see their queue, not
    how each of them did.
* **Consequences:**
  * A manager sees who confirms most an hour and whose confirmed orders come back, and coaches
    them; an agent who confirms everything shows a high return rate.
  * Hours on the desk are the hours in which an agent did something: a short break inside an
    hour is not seen, and nor is time on a call that settled nothing until it is recorded.
  * Not yet: the time an order waited before its first call, against the shop's SLA (COD-05);
    calls made from the admin app, timed; agents' names from the staff list in the report.
* **Alternatives:**
  * **Counters kept as agents work:** a second record of what the timelines and calls already
    say, to keep in step through cancellations and corrections.
  * **Agents' hours from sign-ins:** staff stay signed in all day; their work shows when they
    were on the desk.
  * **The outcomes of every order an agent called:** an agent who called once and another who
    confirmed would share an order's outcome; the confirmation is what an agent answers for.

## ADR-091 · A shop's Confirmation Desk keeps calling hours, outside which it deals out no order and after which an unanswered one falls due; an order waiting longer for its first call than the shop's target, counting those hours, is overdue

* **Context:** the Confirmation Desk deals out the orders waiting for their customers, the most
  urgent first, at any hour, and an unanswered one falls due again two hours on
  ([ADR-073](#adr-073--the-confirmation-desk-deals-orders-waiting-for-their-customers-to-agents-one-at-a-time-the-most-urgent-due-first-and-keeps-the-calls-that-did-not-settle-them)):
  at 20:30 that is 22:30, when no shop calls a customer, and an app that calls for the shop would.
  A shop also wants every order called soon after it is placed, as a customer who ordered a
  minute ago answers and one who ordered yesterday may have bought elsewhere: COD-05 asks for
  timers on that, the shop's confirmation policy, and its quiet hours. Shops keep their times in
  their own time zone.
* **Decision:**
  * **A shop may keep calling hours** (`orderSettingsUpdate`: `callingHours`), the same day's
    clocks in its time zone, an hour apart at least: "10:00" to "21:00". Outside them
    `confirmationQueueNext` deals out no order, and says when they open; the queue lists what
    waits all the same, and says whether it is calling time.
  * **An unanswered order falls due again in two hours, or when calling hours next open** if
    that is outside them. A time the customer asked to be called back at stands, whatever the
    hours.
  * **A first-call target** (`firstCallMinutes`, 5 to 1440): an order not yet called that has
    waited longer, counting calling hours alone, is `overdue`, and the queue counts them. An
    order placed at night starts waiting when calling hours open.
  * **Worked out when asked**: each day's hours as instants, from the shop's time zone, by
    Postgres; how long an order has waited, counted back through them from now. Nothing is
    stored but the settings.
* **Consequences:**
  * Agents and apps calling for the shop call within its hours, and unanswered orders come back
    in the morning rather than at night; a manager sees how many orders waited too long for a
    first call.
  * Calling hours are the same every day: no hours of their own on Fridays or holidays, and no
    window across midnight.
  * Not yet: giving up on customers who can't be reached, cancelling their orders after some
    days (COD-05); alerts when orders go overdue, with messaging; WhatsApp and IVR attempts in
    the shop's sequence (COD-01, COD-03).
* **Alternatives:**
  * **Due times moved into calling hours when an order is placed:** an order placed at night
    would be due at opening as stored, but changing the hours would leave the old times behind.
  * **The target counted by the clock:** an order placed at 23:00 would be overdue before the
    desk opens.
  * **Hours for each day of the week:** most shops call the same hours daily; a week of hours
    can come when a shop asks for it.

## ADR-092 · An order whose customer could not be reached is cancelled as many days after it was placed as the shop says, by a sweep in the worker, shop by shop and order by order

* **Context:** after three unanswered calls an order's customer could not be reached
  (`no_response`), and the desk keeps calling
  ([ADR-073](#adr-073--the-confirmation-desk-deals-orders-waiting-for-their-customers-to-agents-one-at-a-time-the-most-urgent-due-first-and-keeps-the-calls-that-did-not-settle-them)).
  Most such orders were never meant, or were bought elsewhere; while they wait they hold their
  stock and fill the queue. COD-05 asks for the shop's rule to give up on them. Nothing in Hatti
  ran on a timer: work followed requests or events.
* **Decision:**
  * **A shop may say after how many days to give up** (`cancelUnreachableAfterDays`, 1 to 30):
    an order still waiting for a customer who could not be reached that long after it was
    placed is cancelled, as could not be reached (`no_response`), by the system, its stock let
    go, with a line on its timeline and the order's events. None is given up on until the shop
    says.
  * **A sweep in the worker does it**, every ten minutes by default (`SWEEP_INTERVAL_MS`), under
    a role of its own (`sweeps`), so that it can run in one process however many handle events.
    It finds the shops that give up with the system login, which sees every shop, then cancels
    each shop's orders, the oldest first and a hundred at most a sweep, each in the shop's own
    transaction, checking again under its lock that the customer is still unreachable and the
    order still waiting.
  * **Sweeps in two workers at once do no harm**: an order cancelled by one is passed over by the
    other, under the order's lock.
* **Consequences:**
  * Orders nobody will take go back to stock on their own, and the queue keeps to customers who
    may answer.
  * An order the desk never called is never given up on: the rule is about customers who did not
    answer.
  * The worker now runs jobs on a timer; the next ones, such as alerts for overdue orders, join
    the sweeps.
  * Not yet: a message to the customer before their order is cancelled, with messaging.
* **Alternatives:**
  * **Cancelling as the desk deals orders out:** a shop that stopped using the desk would keep its
    stock held for ever.
  * **BullMQ's repeating jobs:** a timer is enough for a sweep that is safe to run twice; a queue
    can come when sweeps need spreading across processes.
  * **One transaction for a shop's sweep:** a hundred orders' stock locked at once, and one
    failure undoing every cancellation.

## ADR-093 · A claim on the courier that lost a parcel is the parcel's, followed until the courier pays it or refuses it; a statement's cash for a lost parcel pays its claim, filed or not

* **Context:** couriers lose parcels, and shops claim their worth from them, each courier its own
  way: a complaint number, weeks of waiting, then a payment, often in the next remittance
  statement, sometimes by cheque or transfer, or a refusal. A lost parcel is written off
  ([ADR-072](#adr-072--a-parcel-the-courier-lost-is-written-off-and-an-order-with-nothing-delivered-or-back-ends-at-a-stage-of-its-own-lost-before-reaching-the-customer-it-is-never-their-refusal)),
  but no claim was kept: what a courier paid for one came in its statement as cash on an order
  that owed nothing (`not_owed`), a line to look into
  ([ADR-067](#adr-067--couriers-remittance-statements-are-imported-whole-into-a-logistics-module-each-lines-cash-received-on-its-parcels-order-at-most-what-the-order-owes-and-a-parcels-cash-once)),
  and nobody could say which lost parcels were still unpaid for. Claims were left for couriers'
  APIs (spike 2), but the shop's side of them, what it claimed and what came of it, needs none.
* **Decision:**
  * **A claim is its parcel's**: a parcel the courier lost has one at most, kept with the parcel
    in the orders module, beside its loss (migration 0063): what is claimed, what was paid, a
    note, and when it was filed and settled. `fulfillmentClaimCreate` files it, at the parcel's
    worth, its items at their prices on the order, unless the shop says otherwise, up to the
    order's total. It is `open` until the courier pays or refuses it, or the shop withdraws it;
    a claim refused may still be paid or withdrawn; one paid or withdrawn is done with, though
    one withdrawn may be filed again.
  * **A statement's cash for a lost parcel pays its claim** (`compensated`), filed or not: one
    the shop had not filed is filed at the parcel's worth, or what was paid if more, and paid at
    once. The cash is the claim's, not the order's: a lost parcel's order owes nothing, and closed
    orders take no payments. A claim paid otherwise, or withdrawn, leaves the line to look into
    (`not_owed`). The import reads the parcels again once their orders are locked, as claims
    change only under their orders' locks, so that a claim settled by hand meanwhile is not paid
    twice. A statement keeps what of its cash paid claims (`compensated`), as it keeps what was
    received on orders; statements imported before pay their claims in the migration, as an
    import now would.
  * **`fulfillmentClaimSettle` records the rest**: paid otherwise than in a statement, with the
    amount, refused, with why, or withdrawn. A lost parcel that turns up and is checked back in
    has its claim withdrawn, unless it was paid.
  * **Each step is a line on the order's timeline**, and the parcel's events follow, as for any
    change to a parcel.
  * **`lostParcels` lists the lost parcels**, the longest lost first, with their worth and their
    claims, by claim (none yet, open, paid, refused, withdrawn) and by courier; the home counts
    those not claimed yet, at their worth, and the claims still open.
  * **Owners, managers and accountants claim**, as they reconcile couriers' cash; apps need
    `write_orders`.
* **Consequences:**
  * A shop sees which lost parcels it has not claimed, which claims its couriers still owe, and
    what they paid; statements' cash for lost parcels is no longer to look into.
  * What a courier pays is the claim's alone: what lost parcels cost, less what was recovered, is
    for the true profit report (ANL-03).
  * Not yet: claims for parcels that came back damaged, couriers' own claim processes through
    their APIs (spike 2), and the time couriers allow for claiming.
* **Alternatives:**
  * **Claims in the logistics module, beside statements:** a claim is about one parcel and
    changes with it, lost or turned up, and listing the lost parcels with their claims would read
    across modules.
  * **A claim filed for every parcel marked lost:** shops that do not claim, or settle with their
    couriers otherwise, would see claims open for ever.
  * **A statement's cash for a lost parcel received on its order:** the order is closed and
    voided; paid, it would read as sold.

## ADR-094 · A shop's advance may be asked only of customers new to it, and of orders its risk rules score high: such an order is asked it instead of waiting for review

* **Context:** a shop's advance may be asked above a total, in cities it names and of customers
  who refused parcels before
  ([ADR-089](#adr-089--a-shops-advance-may-be-asked-only-to-cities-it-names-and-of-customers-who-refused-parcels-before-checkout-names-every-city-and-says-of-whom-and-placing-applies-them-to-the-city-and-number-typed)).
  Shops ask the delivery charge up front of first-time customers above all (05 §4.4), and the
  risk decision's middle outcome is a partial advance (05 §5); but an order its risk rules
  score high could only wait for review, for staff to call
  ([ADR-025](#adr-025--order-risk-is-a-snapshot-taken-when-an-order-is-placed-or-re-addressed)),
  and nothing asked an advance of a customer the shop had never delivered to. An order is scored
  as it is placed, in the orders module, from the customer's history and the address; checkout
  works out the advance before placing it, and an order asking one isn't scored, as the advance
  is the customer's say-so.
* **Decision:**
  * **Two more conditions on the advance**, each one more that the orders it asks must meet:
    only of customers new to the shop (`newCustomers`), none of whose orders it delivered
    before, by any of their numbers, as their delivery history counts them; only of orders the
    shop's risk rules score at least `riskScore` (0.01 to 1, kept as points from 1 to 100).
  * **An order scored that high is asked the advance instead of waiting for review**: checkout
    hands the orders module the advance with the score it needs (`riskAdvance`) rather than
    asking it outright; placing scores the order as any order paid on delivery, and if the score
    reaches it, the order asks the advance, waits for it, needs no call, and keeps its score and
    reasons, with a line on its timeline saying why ("Asks for Rs 500 in advance for its risk
    0.35 (medium). …"). Scored lower, it asks nothing, and the shop's hold for review applies as
    before; a blocked number is held whatever it asks.
  * **The page says of whom before anything is typed**, as it says the cities and refusals:
    "If no order from this shop has reached you before", "If the shop's checks on your order
    call for it", in English and Urdu. It looks nobody up and never takes such an advance off
    what the door collects before the order is placed. Placing counts the deliveries of the
    number typed with its refusals, in one look, only where the shop's rules ask.
  * The page's digest covers both conditions, so a change while it is open shows it again.
* **Consequences:**
  * Cash on delivery stays open to first-time and risky customers, with the delivery charge or a
    share ahead, rather than an order that waits for a call or is turned away; the score says
    why on the order.
  * An order asked an advance for its risk is not held for review: the advance is the check.
  * One advance still: of new customers in some cities and of risky orders everywhere cannot
    both be had, and drafts ask the advance staff set
    ([ADR-084](#adr-084--checkout-asks-for-the-advance-the-shops-rules-name-an-amount-a-share-of-the-items-or-the-delivery-charge-on-every-order-or-above-a-total-said-beside-cash-on-delivery)).
  * Not yet: prepaid alone above a higher score, and the OTP in the middle (05 §5), with
    messaging.
* **Alternatives:**
  * **Scoring the order in checkout, before placing it:** the customer may not exist yet, and the
    score would be worked out twice, once to decide and once to keep.
  * **The shop's hold threshold as the advance's:** a shop could not hold the riskiest orders
    for review and ask an advance of those a little less risky.
  * **"First order" as no order at all:** a customer whose earlier orders were cancelled or
    refused never received one; delivered is what trust follows.

## ADR-095 · The setup checklist is worked out when asked from what each module keeps, in one transaction: a step is done while what it asks for holds

* **Context:** a new shop's first half hour decides whether it sells (F1 in
  docs/design/03-key-user-flows.md: "Your store is 4/6 ready"). ONB-02 asks for a guided
  checklist: products, delivery, payments, going live. What each step asks for is already kept,
  module by module: products and their status, delivery settings, the bank account, policies, the
  brand's logo, the WhatsApp number and the storefront's password. Nothing records that a step
  was done, and a step done can be undone: the last product drafted, the store closed.
* **Decision:**
  * **The checklist is worked out when asked** (`setupChecklist`), in one transaction, from each
    module's own reads that take the caller's transaction: products on sale (`activeProductsIn`,
    new in the catalog), delivery settings saved, the bank account given (transfers, Raast and
    advances need it; cash on delivery needs nothing), the refund, privacy and shipping policies
    and terms of service written, a logo, a WhatsApp number, and the storefront open. Nothing is
    stored: a step is done while what it asks for holds, and undone when it no longer does.
  * **Steps are keys, in the order a shop is asked them**, each with whether it is done and, for
    a step of many things, how far along it is: products on sale, policies of the four written.
    The admin app words each in English and Urdu; the API says none.
  * **It lives in the core's API, beside the home**, as the home does
    ([ADR-060](#adr-060--cod-health-follows-a-periods-cash-on-delivery-orders-worked-out-from-them-when-asked-its-rates-of-those-that-turned-out)'s way of working things out when asked): it reads five modules and belongs
    to none. Owners and managers see it, and apps with `read_settings`.
* **Consequences:**
  * A shop sees what is left at a glance, and the checklist can never disagree with the shop.
  * A new step is a key and a read of its module's, through that module's public surface.
  * Not yet: connecting a courier and sharing the store (F1), with courier integrations and the
    admin app; and the admin app's words and the home's banner for new stores.
* **Alternatives:**
  * **Steps recorded as done by events:** a second account of state each module keeps, which a
    missed event or an undone step would put out of step.
  * **A checklist in each module:** no one place to ask, and the order of steps is the product's,
    not any module's.

## ADR-096 · Sales tax is included in prices, at a rate the tax module keeps: each order keeps the tax in it as it was placed, line by line and in its delivery

* **Context:** TAX-01 and CHK-17 ask for prices that include tax, and tax lines on receipts and
  invoices. Pakistan's consumer laws ask prices to be shown with their taxes, so the shelf price
  is what the customer pays ([03 §5](./03-multi-tenancy-and-data.md)). Sales tax on goods is 18%
  at the standard rate, less or none on some goods, and a registered seller's invoice says what
  of each price was tax. Shops on Hatti range from sellers not registered, who charge none, to
  registered ones. Nothing kept a rate, and orders said nothing of tax. The module map has a Tax &
  Compliance module for tax rules, FBR's invoicing and withholding
  ([01 §4](./01-system-overview.md)).
* **Decision:**
  * **A tax module keeps the shop's sales tax** (`@hatti/tax`, schema `tax`): a rate in
    hundredths of a percent, from 0.01% to 50%, or none, every shop's until it sets one; and
    whether its delivery charges and its fee for paying on delivery include it, as Shopify's
    `taxShipping`. `taxSettings` and `taxSettingsUpdate` need `read_settings` and
    `write_settings`; each change is an event and goes in the audit log. It is the start of the
    module map's Tax & Compliance: tax profiles, invoice series and FBR's digital invoicing join
    it.
  * **Prices include it, always.** A total is never more for the tax: the tax is what of it was
    tax. Shopify's `taxesIncluded` is always true, on the shop and on orders, and Liquid's
    `shop.taxes_included` and `cart.taxes_included` say so to themes. A variant is taxed unless
    the shop says otherwise, Shopify's `taxable` ("Charge tax on this variant"), which the product
    import reads from Shopify's "Variant Taxable".
  * **Each order keeps the tax in it as it was placed**, worked out in its transaction at the rate
    then (`orderTaxOf`): on each taxable line, what was paid for it after its share of the order's
    discount (a code's, staff's and paying by transfer's, shared by the largest remainder), amount
    × rate ÷ (100% + rate), rounded half up to the paisa line by line, as Shopify rounds; and on its
    delivery charge and fee where the shop's include them. Lines keep whether they were taxable,
    their rate and their tax; the order keeps the rate, the tax in all of it and the tax in its
    charges (migration 0065, whose checks keep them consistent). A new rate is for orders from
    then on.
  * **It is said where the total is.** Checkout's page says what of its total is tax once the
    total is known, worked out as placing will, and the placed page what the order kept; invoices
    and customers' order pages give a line per rate under the total, "Sales tax 18% (included)",
    in English and Urdu; the API gives Shopify's `taxLines` on orders and their lines, and
    `totalTax`; the export, Shopify's "Taxes", and each line's tax.
* **Consequences:**
  * A registered shop's receipts and invoices say the tax in them, and its totals stay what its
    prices say; a shop that charges none sees nothing of it.
  * Cash on delivery's cap, advances, fees and refunds keep their arithmetic: no total depends on
    the tax.
  * Not yet: rates by product beyond taxed or not (tax categories, the rest of TAX-01); prices
    that leave the tax out; drafts that show their tax before they are placed; refunds that say
    what of them was tax; reports that set it apart; and what FBR asks of registered sellers'
    invoices: their NTN and STRN, a series of numbers, and digital invoicing (TAX-02, TAX-04,
    TAX-05).
* **Alternatives:**
  * **Prices before tax, the tax added at checkout**, as Shopify does in the US: against the
    consumer laws' display rule, and a total that changes with the tax.
  * **The tax worked out when shown**, at the rate then: an invoice printed after a change of rate
    would disagree with the order agreed.
  * **The rate kept with the orders module's settings:** the tax rules, profiles and FBR's
    invoicing to come belong together, apart from orders.

## ADR-097 · Tax categories are the shop's codes with rates of their own, which variants name by Shopify's tax code; every other variant it taxes is at the shop's rate

* **Context:** TAX-01 asks for tax categories as well as prices that include tax
  ([ADR-096](#adr-096--sales-tax-is-included-in-prices-at-a-rate-the-tax-module-keeps-each-order-keeps-the-tax-in-it-as-it-was-placed-line-by-line-and-in-its-delivery)).
  Pakistan taxes some goods at reduced rates (the Sales Tax Act's Eighth Schedule) and some at
  none, so a shop that sells both needs each line at its own rate. Shopify sets other rates by
  overrides on collections, which its API doesn't expose, and keeps a tax code on each variant
  (`taxCode`, "Variant Tax Code" in its product CSV) for tax services to read.
* **Decision:**
  * **A category is a code, a name and a rate**, up to 20 a shop, kept with its tax settings and
    replaced whole through `taxSettingsUpdate` (migration 0066): codes of letters, digits, dots,
    dashes and underscores, each once in any letter case, and rates checked as the shop's is.
  * **Variants name categories by Shopify's tax code** (`ProductVariant.taxCode`, which the
    catalog keeps and the product import reads from "Variant Tax Code"). A taxable variant whose
    code is a category's is taxed at its rate, and any other at the shop's, as is a code that
    names no category. Categories apply only while the shop charges tax at all; delivery and the
    fee for paying on delivery stay at the shop's rate.
  * **Orders keep each line's rate** as they were placed, as they keep its tax: receipts,
    invoices and checkout's page give a line a rate, and the API's `taxLines` one a rate on the
    order and the line's own on each line.
* **Consequences:**
  * A shop that sells goods at two rates says so once, and every order and invoice follows.
  * The catalog doesn't know the tax module: a code is text to it, which the tax module reads as
    an order is placed. A category taken away leaves its code on variants, which are taxed at the
    shop's rate until it comes back.
  * Not yet: categories chosen on the admin's product screen, with the admin app; a rate of its
    own for delivery; exempt goods are variants not taxed, not a category at 0%.
* **Alternatives:**
  * **Rates by collection**, as Shopify's overrides: smart collections' members are worked out
    by rules, which placing every order would evaluate, and a product in two collections would
    have two rates.
  * **A category's ID on the product, kept by the catalog:** the catalog would depend on the tax
    module, and Shopify's exports bring codes, not IDs.

## ADR-098 · A parcel that came back with items written off as damaged is claimed from its courier for their worth, as a lost parcel is for its own; every claim is listed, the oldest first, to follow up

* **Context:** a parcel that comes back is checked in with each item restocked or written off as
  damaged ([ADR-071](#adr-071--a-parcel-coming-back-is-checked-in-by-the-tracking-number-on-its-label-matched-as-couriers-statements-are-those-on-their-way-back-are-listed-the-longest-first)):
  a torn seam, a wet box, a bottle broken on the way. Couriers pay for some of that damage, on
  their terms, as they pay for the parcels they lose, and shops claim it the same way: a
  complaint number, weeks of waiting, then a payment or a refusal. Claims were kept for lost
  parcels alone
  ([ADR-093](#adr-093--a-claim-on-the-courier-that-lost-a-parcel-is-the-parcels-followed-until-the-courier-pays-it-or-refuses-it-a-statements-cash-for-a-lost-parcel-pays-its-claim-filed-or-not)),
  and listed only with them (`lostParcels`): a damaged return had nowhere to keep its claim, and
  following claims up meant looking through the lost parcels.
* **Decision:**
  * **A parcel that came back with items written off is claimed as a lost parcel is**:
    `fulfillmentClaimCreate` takes it, at the worth of what was written off (its items not
    restocked, at their prices on the order) unless the shop says otherwise, up to the order's
    total. One that came back whole is refused: nothing of it was written off. The claim is the
    same as a lost parcel's, kept with the parcel and settled the same way
    (`fulfillmentClaimSettle`), each step on the order's timeline ("Claimed Rs 3,400 from PostEx
    for the damaged items of the returned parcel PX10293847"). A lost parcel that turned up, its
    claim withdrawn as it was checked in, may be claimed again for what of it was written off.
  * **Only a lost parcel, or one that came back, has a claim**, which the database checks
    (migration 0067): neither changes again, so a claim never has to follow its parcel anywhere.
  * **Couriers' statements pay lost parcels' claims alone.** Cash on a lost parcel is for its loss
    and nothing else; cash on a parcel that came back may be the courier's mistake, a charge
    given back or the claim, so it stays a line to look into (`not_owed`), and the shop records
    it on the claim once it knows (`fulfillmentClaimSettle`, PAID).
  * **`parcelClaims` lists every claim, the oldest first**, lost or come back damaged, by status
    and by courier: those still open, or refused, are the ones to follow up. Its cursor keeps when
    a claim was made to the microsecond, as the database does, and the parcel's ID: at the
    millisecond a JavaScript date keeps, claims made within one would come again on the next page.
    A partial index keeps it to the parcels with claims. The home's open claims count both kinds;
    lost parcels not claimed yet stay a count of their own.
* **Consequences:**
  * A shop claims what couriers damaged as it claims what they lost, and follows every claim up in
    one list, the oldest first.
  * The home doesn't count parcels that came back damaged as ones to claim, as it counts lost
    parcels: whether damage is the courier's to pay is the shop's call, parcel by parcel, by how
    it was packed and by the courier's terms, and the count would stand for work often not there.
  * Not yet: photos of the damage kept with its claim, couriers' own claim processes through their
    APIs (spike 2), and the time couriers allow for claiming.
* **Alternatives:**
  * **A claim for each damaged line, in a table of its own:** couriers take a claim a parcel,
    whatever was in it, and a second table would be a second way to settle the same thing.
  * **Statements paying claims on parcels that came back:** such cash is rare and may be for
    anything; paid to the claim, it would read as settled when it was not.
  * **`lostParcels` widened to the damaged returns:** it lists lost parcels with their worth,
    claimed or not; a parcel that came back belongs in a list only once claimed, and following
    claims up is a list of claims.

## ADR-099 · An order paid on delivery that the shop's risk rules score at its limit or above is not taken at checkout: placed, scored and undone, its page asks for a transfer instead

* **Context:** the risk decision's last outcome before blocking is prepaid alone (05 §5): above a
  high score, a shop takes an order only paid ahead. A shop may ask an advance of orders its risk
  rules score high
  ([ADR-094](#adr-094--a-shops-advance-may-be-asked-only-of-customers-new-to-it-and-of-orders-its-risk-rules-score-high-such-an-order-is-asked-it-instead-of-waiting-for-review)),
  but nothing kept cash on delivery from the riskiest, whose advance a refusal at the door would
  still cost. An order is scored as it is placed, in the orders module, from the customer's
  history, the address and the order itself
  ([ADR-025](#adr-025--order-risk-is-a-snapshot-taken-when-an-order-is-placed-or-re-addressed)):
  checkout cannot know the score before placing, and placing writes the order, its customer and
  its stock before the score is known.
* **Decision:**
  * **A limit for risk in the shop's rules for cash on delivery** (`riskScoreLimit`, 0.01 to 1,
    kept as points from 1 to 100; migration 0068): orders scored at it or above are paid another
    way, as orders above the shop's total or from customers who refused parcels are
    ([ADR-075](#adr-075--a-shop-keeps-cash-on-delivery-to-the-orders-it-trusts-up-to-a-total-of-its-own-outside-cities-it-names-and-not-for-customers-who-refused-parcels-before-checkout-offers-transfer-instead)).
    Where the shop asks an advance by risk, the limit is above its score, which the database
    checks too: from the advance's score up, an order is asked the advance; from the limit up, it
    pays ahead.
  * **Checkout places the order, reads its score and undoes it**: an order paid on delivery
    scored at the limit throws in the order's transaction, as a refused discount code does
    ([ADR-063](#adr-063--a-shoppers-discount-code-is-kept-with-their-cart-and-counted-with-the-order-placed-with-it-in-the-orders-transaction)),
    and nothing of it is left, its number and its customer included. The page comes back with
    a transfer chosen where the shop takes one, saying "The shop asks for this order to be paid in
    advance. Pay by bank transfer to place it."; without one, that cash on delivery isn't
    available for the order. The shopper is not told what the shop's checks found, as a customer
    who refused parcels is not told why.
  * **The page says nothing of it before the order is placed**, as of the limit on refused
    parcels: it costs no one anything until it applies, and the score is not known before.
  * An order asked an advance whatever its risk is not scored, as before
    ([ADR-094](#adr-094--a-shops-advance-may-be-asked-only-of-customers-new-to-it-and-of-orders-its-risk-rules-score-high-such-an-order-is-asked-it-instead-of-waiting-for-review)):
    the advance is its customer's say-so, and the limit never applies to it.
* **Consequences:**
  * A shop takes its riskiest orders paid ahead and the rest as before: none of them waits for a
    call that a transfer would have settled.
  * The scoring runs for an order that is then undone, its stock committed and rolled back with
    it: a cost of the rare order, not of every one.
  * The shop sees nothing of the orders turned to a transfer, nor of those never placed after;
    the order paid by transfer is not scored. Not yet: telling the shop of them, and how many
    shoppers left at that point, with the admin app's analytics.
* **Alternatives:**
  * **Scoring the order before placing it**, in checkout: the customer and the order may not
    exist yet, and the score would be worked out twice, as ADR-094 found for the advance.
  * **Placing the order as a transfer at once**: its total changes without the shopper seeing
    it, losing the fee for paying on delivery and gaining what the shop takes off for paying by
    transfer, and the page they agreed to would not be the order placed.
  * **An advance of the whole order, kept as cash on delivery:** an order paid on delivery with
    nothing to collect at the door, charged a fee for paying there.

## ADR-100 · Staff sign in with a passkey alone, which passes the second factor, or answer the second step after their password with one; once an account has a second factor, only a session that passed one adds another

* **Context:** staff sign in with a password and, for owners, managers and accountants, an
  authenticator app's code ([ADR-020](#adr-020--staff-identity-built-in-house-on-audited-primitives)),
  which planned passkeys through `@simplewebauthn/server`. Passwords are phished and reused, and
  six digits are phished too: a passkey is bound to the site that made it, signs a fresh
  challenge, and verifies its user with a fingerprint, a face or the device's PIN. Shops' staff
  sign in on phones that keep passkeys already, synced by Google's or Apple's password managers.
* **Decision:**
  * **A passkey signs in alone** (`POST /auth/sign-in/passkey/options`, then
    `POST /auth/sign-in/passkey`): any passkey the browser holds for the site, discoverable, its
    user verified. Its user handle is the account's UUID, nothing personal, and must match the
    passkey's owner. The session has passed the second factor, as one with an app's code has:
    the passkey is something the user holds, and its verification something they are or know.
  * **After a password, a passkey answers the second step** as a code or a recovery code does:
    an account with a passkey or an authenticator app is asked for one (`mfa_required`, with
    `methods` and `passkeyOptions` naming the account's passkeys), and the passkey must be that
    account's.
  * **Adding a passkey** (`POST /auth/passkeys/options`, then `POST /auth/passkeys`) takes a
    session that passed a second factor once the account has one, as replacing an app does, and
    adding an app beside a passkey does too; at most 10. The account's first second factor comes
    with recovery codes, shown once. Removing one takes such a session as well, so that a stolen
    session cannot take its owner's way in away.
  * **Each challenge answers once, within 5 minutes**: kept in the identity schema (migration
    0069) and spent as it is answered, wrongly or not; expired ones go as new ones come. A
    passkey's counter must move on where its authenticator keeps one, as a copied passkey's
    wouldn't; synced passkeys keep none.
  * **Where passkeys belong** is configuration: the relying party (`PASSKEY_RP_ID`) and the
    origins staff sign in from (`PASSKEY_ORIGINS`), each on the relying party or under it,
    `PUBLIC_URL`'s host and origin unless set; attestation is not asked for.
* **Consequences:**
  * Staff can sign in with no password at all, phishing-resistant, and owners pass their second
    factor in the same step.
  * A lost passkey is replaced with a recovery code, or another passkey or app, as a lost phone
    with an authenticator app is.
  * Not yet: passkeys in the merchant app, which needs its Android and iOS origins in
    `PASSKEY_ORIGINS`; renaming a passkey; alerts when one is added; re-authentication for
    sensitive actions; which authenticator made a passkey (its AAGUID).
* **Alternatives:**
  * **Passkeys as a second factor alone, after the password:** the password would still be the
    way in that gets phished, and staff would type it on every phone.
  * **Asking for attestation:** it says which make of authenticator made a passkey, which
    synced passkeys mostly don't, and no rule here depends on it.
  * **Challenges in Valkey, expiring by themselves:** sign-in would then depend on Valkey, where
    rate limits are allowed to fail open; the identity schema keeps them beside what they guard.

## ADR-101 · Owners and managers invite staff by a link they send themselves, accepted once by a signed-in account; the owner manages every role but its own, managers those below them, apps none

* **Context:** staff belong to shops through memberships, with a role each
  ([ADR-020](#adr-020--staff-identity-built-in-house-on-audited-primitives)),
  but only the seed made any: a shop could not take on a packer, change what an agent does or
  let anyone go. Shopify invites staff by email; there is no email delivery yet, and shops here
  hire through WhatsApp, where a link travels best. Roles carry very different powers: managers
  and accountants see the money, owners everything.
* **Decision:**
  * **An invitation is a link with a role**: `staffInvitationCreate` returns its secret once
    (`hsi_…`, kept as a SHA-256 digest, migration 0070), with a note of whom it is for, good for
    7 days, 50 waiting at most a shop. The inviter sends the link themselves. Before anyone signs
    in, `POST /auth/invitations/preview` says the shop, the role and who invited them; signed in,
    `POST /auth/invitations/accept` makes the account a member in that role, once. The secret
    goes in the body, never in an address a log keeps. An account that works there already keeps
    its role, and the invitation stays unspent.
  * **The owner manages every role but its own; managers, those below them; others none**:
    inviting, taking an invitation back (`staffInvitationRevoke`), changing a role
    (`staffMemberRoleUpdate`) and removing someone (`staffMemberRemove`) each need the acting
    member to manage both the role they have and the one given. Nobody is made the owner this
    way, nobody changes their own role or removes themselves, and each change reads the acting
    member's role again under a lock. Apps manage no staff, whatever their scopes.
  * **A change takes effect at the member's next request**: access is resolved per request
    (`identity.resolve_staff_access()`), so a removed member is turned away at once, with no
    session to end.
  * **Each change goes on the shop's audit log** (`staff.invited`, `staff.invitation_revoked`,
    `staff.role_changed`, `staff.removed`), once it stands in the identity schema, and on the
    acting account's own record; accepting goes on the joining account's.
  * `staffMembers` and `staffInvitations` list them for the owner and managers.
* **Consequences:**
  * A shop takes on staff and lets them go by itself; the role presets
    ([ADR-100](#adr-100--staff-sign-in-with-a-passkey-alone-which-passes-the-second-factor-or-answer-the-second-step-after-their-password-with-one-once-an-account-has-a-second-factor-only-a-session-that-passed-one-adds-another) for how they sign in)
    say what each may do from their first request.
  * A link forwarded to someone else lets them join: it is the inviter's to send to the right
    person, as a WhatsApp group invitation is, and to take back if it went astray.
  * Not yet: invitations by email, a page of the core's at the link for those without the admin
    app, handing ownership over, suspending a member without removing them, custom roles.
* **Alternatives:**
  * **Inviting by email address, joinable only by that account:** no email delivery yet, and
    staff here often sign up with numbers or new addresses the owner doesn't know.
  * **Managers managing other managers:** two managers could remove each other; the owner is the
    one who decides who manages.
  * **The changes in GraphQL resolved inside the identity module:** it serves `/auth` alone and
    keeps no tenant context; the core's resolver authorises by the shop's role and writes the
    audit log, the identity module keeps memberships.

## ADR-102 · A customer's own data is one JSON file of everything the shop keeps of them, which each module with their data adds to; the blocklist and risk scores stay out

* **Context:** a customer may ask a shop what it keeps of them, as they may ask it to erase it
  ([11 · Security §7](./11-security-and-compliance.md#7-privacy)). The feature catalog's CUS-05
  has both, and erasure came first
  ([ADR-026](#adr-026--a-customer-can-have-several-numbers-modules-with-customer-data-join-merges-and-erasure)).
  What a shop keeps of a customer is spread over modules: the customers module keeps the profile,
  numbers and consent ledger; orders keep orders, drafts, parcels, refunds, calls to confirm and
  receipts; discount codes keep their uses. Some of it is the shop's defence against fraud, the
  blocklist and orders' risk scores, which a ring placing fake orders would learn to get past if
  it were handed them.
* **Decision:**
  * **`customerDataExport(id)` returns the file**, `customer-cus_….json`, JSON indented to be
    read, in one response, for an owner or manager to give the customer. Its `format`,
    `hatti.customer-data/1`, says how to read it. It takes `write_customers`, which only owners,
    managers and apps hold, and `read_orders`, since it holds orders.
  * **Each module with customer data adds its sections**, through the `CustomerDataHandler`
    merges and erasure already use: the customers module writes the profile (name, main and
    other numbers, email, note, tags, marketing consent per channel) and the consent history;
    orders add `orders` (items, amounts in major units, contact details, address, note, tags,
    what the customer agreed to and from where, parcels, refunds, calls to confirm, and the
    receipts they sent) and `draftOrders`, found as erasure finds them; discount codes add
    `discountCodeUses`. A section two modules give is a programming error, and nothing is given
    out.
  * **What goes in:** everything erasure would take from the customer, and the records it would
    keep while they still name them. It is read in one transaction that holds the customer's row
    shared, so a merge or erasure of theirs under way finishes first.
  * **What stays out:** the shop's defences against fraud, the blocklist (which holds numbers,
    not customers) and orders' risk scores and reasons; orders' timelines, which hold the reasons
    for holds and repeat the rest; and which of the staff did what, which is theirs, not the
    customer's.
  * **Each export goes on the shop's audit log** as `customer.data_exported`, without its
    contents.
* **Consequences:**
  * A shop answers a customer's request with one call. A module that keeps customer data later
    implements `export` beside `erase`: the interface lets neither be left out.
  * The file is the shop's to read before sending: its staff's notes and tags are in it.
  * A customer with thousands of orders makes a file of megabytes in one response; a file kept
    in storage behind a link comes when one outgrows that.
  * Not yet: customers asking for it themselves, with customer accounts (CUS-02); request intake
    for those who ask Hatti; the files they uploaded, which are listed, not attached; the text of
    the policies they agreed to, whose versions are named by ID; and apps' data, which Shopify
    asks apps for with the `customers/data_request` webhook.
* **Alternatives:**
  * **Everything, the risk scores and blocklist included:** most privacy laws let a business keep
    back what would help someone get past its fraud checks, and a score's reasons do exactly that.
  * **CSV, as customer exports are:** a customer's data is nested, orders with lines, parcels and
    refunds, which CSV would flatten into several files or repeated rows.
  * **The core gathering the sections from each module's services:** the customers module would
    know nothing of a new module's data, and a new module could be left out without anyone
    noticing, as with merges and erasure before handlers.

## ADR-103 · Sensitive actions need staff to have proved who they are in the last 15 minutes, by signing in or confirming with the strongest factor their account has; apps are not asked

* **Context:** a staff session lasts up to 30 days, its access tokens refreshed all along
  ([ADR-020](#adr-020--staff-identity-built-in-house-on-audited-primitives)).
  Whoever holds one, at a phone left unlocked by the counter, a laptop left signed in or through
  malware that copied its tokens, can do all its role may, including what would hurt most and is
  hardest to undo: taking staff on or letting them go, changing the account customers pay into,
  carrying customers' data off, erasing a customer. GitHub's "sudo mode" and Shopify ask for
  proof again before such things.
* **Decision:**
  * **A session keeps when its user last proved who they are** (`authenticated_at`, migration
    0071): when they signed in, or re-authenticated since. Refreshing tokens leaves it. The Admin
    API gets it from `identity.resolve_staff_access()` as the staff actor's `authenticatedAt`,
    and `/auth/me` and every token response show it.
  * **Sensitive actions need it within 15 minutes** (`REAUTHENTICATION_WINDOW_MS`): the
    mutations marked `@RequireRecentAuthentication()` (`staffInvitationCreate`,
    `staffMemberRoleUpdate`, `staffMemberRemove`, `bankTransferSettingsUpdate`,
    `customersExport`, `ordersExport`, `customerDataExport`, `customerErase`) and, in `/auth`,
    setting up an authenticator app and adding or removing a passkey. Staff past it are refused
    with `REAUTHENTICATION_REQUIRED` (403): the whole request, before it runs and before its
    Idempotency-Key is spent, so the same request goes through with the same key once they have
    confirmed ([ADR-030](#adr-030--idempotency-keys-are-kept-in-postgres-per-caller-for-a-day)).
    The resolvers' guard refuses such mutations too, after scopes. Apps are not asked: there is
    no one at an app to ask, and its scopes are the shop's grant.
  * **Staff confirm with the strongest factor their account has**: `POST
    /auth/reauthenticate/options` says which, a passkey (with what `navigator.credentials.get()`
    takes, for their own), a code from their authenticator app, or the password of an account
    with neither, and `POST /auth/reauthenticate` takes one. A password is refused where the
    account has a second factor, and recovery codes are for a lost phone, not this. Confirming
    with a second factor marks the session as having passed one. Attempts are limited to 10 a
    user in 15 minutes, and each is on the account's activity (`reauthenticated`,
    `reauthentication_failed`).
* **Consequences:**
  * A session stolen or left open no longer takes a shop's staff, money or customers' data
    without its user's factor, and everyday work (orders, products, the Confirmation Desk) never
    asks.
  * The admin app reads `authenticatedAt` to ask before it sends, and meets
    `REAUTHENTICATION_REQUIRED` by asking and sending the same request again.
  * Staff whose role is refused an action outright, such as a marketer exporting orders, may be
    asked to confirm first and refused after.
  * Not yet: more actions on the list as their risks are weighed, such as domains; a window the
    shop sets; a second person's approval for the riskiest, such as payouts once money moves
    through the platform.
* **Alternatives:**
  * **The password every time:** safe, and tiresome for an owner doing several things in a row,
    who would stop using the features or keep the password on a note.
  * **The password beside a second factor:** a phished password with a stolen session would get
    through; the factor is what the thief lacks.
  * **Short sessions for everyone:** agents would be signed out mid-shift, though the risk is in a
    few actions, not in the session.
  * **A separate elevated token:** another secret to keep and send; the session's own time does
    the same with nothing new to carry.

## ADR-104 · The owner hands the shop to one of its managers who has a second factor, and stays on as a manager; the shop has one owner throughout

* **Context:** a shop has one owner, the membership a unique index allows one of, and the owner
  alone manages its managers; no invitation or change of role makes anyone the owner
  ([ADR-101](#adr-101--owners-and-managers-invite-staff-by-a-link-they-send-themselves-accepted-once-by-a-signed-in-account-the-owner-manages-every-role-but-its-own-managers-those-below-them-apps-none)).
  Yet shops change hands: a business is sold, a founder hands it to a partner or a relative, or
  the person who set it up was an employee. Shopify lets the owner transfer ownership to a staff
  member, confirming with their password.
* **Decision:**
  * **`shopOwnershipTransfer(staffMemberId)`**: the owner alone, never other staff or apps,
    having proved who they are in the last 15 minutes
    ([ADR-103](#adr-103--sensitive-actions-need-staff-to-have-proved-who-they-are-in-the-last-15-minutes-by-signing-in-or-confirming-with-the-strongest-factor-their-account-has-apps-are-not-asked)),
    hands the shop to one of its managers. The old owner becomes a manager and the new one the
    owner, from their next requests.
  * **Only to a manager with a second factor**: owners must pass one to open the shop, so a shop
    handed to someone without one would be shut to its owner; and a manager has been trusted
    with the shop's settings already.
  * **One owner throughout**: in one transaction, both memberships locked, the owner's first, the
    old owner steps down before the new one steps up.
  * **On the shop's audit log** as `shop.ownership_transferred`, from whom to whom, and on both
    accounts' activity.
* **Consequences:**
  * A shop changes hands without asking support. To hand it to someone new, the owner invites
    them as a manager first; the new owner decides whether the old one stays.
  * Not yet: a handover by support when the owner is gone for good, which needs Hatti to verify
    who is asking; the shop's plan, billing and payouts moving with it, once they exist.
* **Alternatives:**
  * **To any staff member:** a packer made the owner would meet the second-factor wall at once,
    and roles below manager have not been trusted with the shop's settings.
  * **An offer the new owner accepts:** safer against picking the wrong manager, but a shop with
    one waiting has two people who think it is theirs; the old owner stays on as a manager, and
    the new one can hand it back.
  * **The old owner leaving the shop:** the new owner can remove them in one step if that is the
    deal, while a mistaken handover with the old owner gone would need support.

## ADR-105 · A refund keeps its share of its order's sales tax: the order's tax in all it has refunded, less what the refunds before it gave back; the sales report adds up the tax its sales include

* **Context:** each order keeps the sales tax its prices include, as it was placed
  ([ADR-096](#adr-096--sales-tax-is-included-in-prices-at-a-rate-the-tax-module-keeps-each-order-keeps-the-tax-in-it-as-it-was-placed-line-by-line-and-in-its-delivery)),
  but refunds were amounts alone, and the sales report said nothing of tax: ADR-096 left both
  for later. A registered seller files its sales tax return each month from what it sold and
  what it gave back. Refunds here are money staff send back by hand, an amount and a method
  ([ADR-029](#adr-029--refunds-record-money-staff-sent-back-only-owners-and-managers-make-them)),
  not items returned, so nothing said what of a refund was tax.
* **Decision:**
  * **Each refund keeps the tax in it** (migration 0072): the order's tax in all it has refunded,
    this refund included, in proportion to its total and rounded half up, less what the refunds
    before it gave back; never less than nothing, nor more than the refund. Refunds that give
    back a whole order give back all its tax, however many there are. Refunds made before were
    worked out the same way, in the order they were made.
  * **The API gives `Refund.totalTax`, and `Order.currentTotalTax`**, what the order keeps after
    its refunds, as Shopify's `currentTotalTaxSet`. The refund's event and audit entry carry it.
  * **The sales report's `taxes`**: the tax its orders include, less that of the items that came
    back, each line's tax shared by its items, period by period. Prices include it, so it is part
    of the report's other amounts, never added to them (since [ADR-117](#adr-117--the-sales-report-leaves-out-the-sales-tax-its-amounts-include-as-shopifys-does-worked-out-from-the-tax-each-order-keeps-the-tax-said-apart-and-added-back-in-total-sales), taken
    out of them, and added back in total sales).
* **Consequences:**
  * A registered shop reads the tax its sales took in a period, and what its refunds gave back,
    from the API.
  * The proportion is exact for an order at one rate, and close for one mixing rates or with
    untaxed delivery: a refund doesn't say which items it was for.
  * The report counts the items that came back, as before, not refunds; refunds' tax is on the
    refunds.
  * Not yet: drafts' tax before they are placed; refunds by item, each with its line's tax; the
    credit notes FBR asks registered sellers for (TAX-05).
* **Alternatives:**
  * **Refunds by item, as Shopify's:** exact, but staff here refund amounts, often a delivery
    charge or part of a price, not items.
  * **Each refund's share rounded on its own:** partial refunds of a whole order could give back
    a paisa more or less than its tax.
  * **Gross sales without the tax, as Shopify reports included taxes:** every other amount here
    includes it, and one report without it would disagree with the orders it adds up (chosen
    since, in [ADR-117](#adr-117--the-sales-report-leaves-out-the-sales-tax-its-amounts-include-as-shopifys-does-worked-out-from-the-tax-each-order-keeps-the-tax-said-apart-and-added-back-in-total-sales), with total sales adding the tax back).

## ADR-106 · A draft says the sales tax its prices include: an open one's at the shop's rates now, as placing it would work it out; a completed one's as its order keeps it

* **Context:** orders keep the sales tax their prices include as they were placed, and checkout's
  page says it before the order is placed, worked out as placing will
  ([ADR-096](#adr-096--sales-tax-is-included-in-prices-at-a-rate-the-tax-module-keeps-each-order-keeps-the-tax-in-it-as-it-was-placed-line-by-line-and-in-its-delivery)).
  Drafts said none until they were placed: staff putting one together in a chat, and the
  customer confirming it through its link
  ([ADR-031](#adr-031--draft-orders-keep-agreed-prices-and-hold-no-stock-customers-confirm-them-through-a-secret-link)),
  saw a total without the tax in it, and the order then kept a tax neither had seen. ADR-096 left
  drafts' tax for later.
* **Decision:**
  * **An open draft's tax is worked out whenever it is read, as placing it then would**: at the
    shop's rates and its variants' taxable flag and tax code now, on each line after its share of
    the discount, and on its delivery charge where the shop's include it. A draft keeps no tax of
    its own, so a change of rate, or of a variant's tax code, is in it at once, as it will be in
    its order. A variant gone since is taxed at the shop's rate; placing the draft fails on it.
  * **A completed draft's is its order's**, as it was placed: an order's lines and charges don't
    change, so it stays what the order kept, whatever the shop's rate since.
  * **The API gives Shopify's `taxesIncluded`, `totalTax` and `taxLines` on drafts**, by rate,
    the lines' and the delivery charge's together. A page of drafts works theirs out at once,
    through the request's loaders: the shop's settings and the open drafts' variants read once,
    and the completed drafts' orders once.
  * **The link's page gives a line a rate under the total**, in English and Urdu, as orders'
    pages do. What the page showed includes the tax, so a page opened before the shop's tax
    changed shows the draft again, with the tax it includes now, rather than placing an order
    whose tax the customer did not see.
* **Consequences:**
  * Staff see in the chat, and the customer on the link, the tax the order will keep.
  * A draft's tax costs a read or two that the draft alone doesn't, only when asked for.
  * A page opened before this change and sent after it, a draft's or an order's, is shown once
    more, since what a page showed now includes the tax.
  * Not yet: each line's own tax on drafts, which their order's lines give once it is placed; a
    draft exempt from tax, as Shopify's `taxExempt`.
* **Alternatives:**
  * **The tax kept on the draft when it is saved:** a change of the shop's rate would leave open
    drafts saying a tax their orders won't keep, unless every change of rate rewrote them.
  * **Completed drafts' tax at today's rates too:** one way of working it out, but a completed
    draft would disagree with its own order once the rate changed.

## ADR-107 · A tenant transaction begins with its shop and limits set, in one round trip: begin and set_config sent as one simple query, the values written in once checked

* **Context:** request code does its work in tenant transactions (`db.tenant`), which began with
  drizzle's `begin`, then set the shop and the limits in a `set_config` statement of its own: two
  round trips before any work, each a hop through PgBouncer in production
  ([ADR-021](#adr-021--pgbouncer-transaction-pooling-with-no-session-state)). Spike 5 counted
  four round trips around a `select 1`, and listed folding the two as a follow-up. A statement
  with parameters goes on its own, in the extended protocol; only a simple query, which takes
  none, carries several statements.
* **Decision:**
  * **`db.tenant` begins its transaction itself**: it takes a connection from the pool and sends
    `begin; select set_config('app.shop_id', …, true), set_config('statement_timeout', …, true),
    set_config('idle_in_transaction_session_timeout', …, true)` as one simple query. The work then
    runs on drizzle's own transaction object over that connection, so savepoints and
    `tx.rollback()` work as before, and it ends with `commit`, or `rollback` if anything threw, as
    drizzle's transactions end.
  * **Values are written into that statement only once checked** (`tenantBegin`): the shop's ID
    must be a UUID, nothing but hex digits and hyphens, and the limits whole milliseconds.
    Everything else in the code base stays a parameter.
  * **A connection that fails while a transaction holds it is closed**, not handed to the next
    caller. Its errors between statements go to the transaction: the pool listens for idle
    connections' errors only, so with drizzle's transactions such an error went unheard and ended
    the process.
* **Consequences:**
  * A round trip less in every request's transactions. Around a `select 1`, the median fell from
    0.26 to 0.19 ms direct and from 0.40 to 0.30–0.32 ms through PgBouncer; the products page's
    from 2.93 to 2.86 ms direct and from 3.12 to 3.00 ms through PgBouncer, on the spike's dataset
    and machine. Across a network the saving is a network round trip.
  * No shop leaked across 34,965 interleaved transactions direct and 52,587 through PgBouncer, a
    tenth of them rolled back, while the control run still caught a session-level setting.
  * The code builds drizzle's `NodePgSession` and `NodePgTransaction` itself, through their
    public constructors. A drizzle upgrade that changes them fails the build, or the database
    tests, which count the round trips.
  * Cell-wide jobs' transactions (`db.system`) set nothing, and keep drizzle's own.
* **Alternatives:**
  * **`set_config` after `begin`, as before:** the extra round trip.
  * **The settings in the first statement of each transaction's work:** every first statement
    would need them, and one without would see no rows.
  * **Settings once per connection:** unsafe behind PgBouncer in transaction mode (ADR-021); the
    spike's control run shows them leaking to other callers.
  * **A function that begins the transaction:** functions can't.

## ADR-108 · Hot queries run as statements prepared by name, planned once per connection; every pooler in front of the application sets max_prepared_statements

* **Context:** every statement the application sends is parsed, rewritten under row-level
  security and planned each time it runs. Spike 5 found planning to be most of what RLS costs,
  and left prepared statements as a follow-up; ADR-021 ruled named prepared statements out, as
  session state that PgBouncer in transaction mode could not carry. PgBouncer 1.21 and later can,
  with `max_prepared_statements`: it prepares a client's statement on whichever server connection
  runs it. On spike 5's dataset, a products page's two statements in a transaction, through
  pgbench, took 1.50 ms over the extended protocol, as node-postgres sends them, and 0.98 ms
  prepared, directly; 1.66 and 1.09 ms through PgBouncer, with 30% to 49% more throughput at 8
  clients. Their generic plans, which Postgres may keep after five runs, are the same as the
  custom ones for shops of every size.
* **Decision:**
  * **`executePrepared(tx, sql)` runs a statement prepared by name** (`@hatti/db`): the name is
    a digest of its text, so each connection prepares it once and afterwards only binds and runs
    it. Values stay parameters, never written into the text.
  * **For hot queries only**, each checked first: its text takes a bounded number of shapes, and
    its generic plan suits every shop (`EXPLAIN (GENERIC_PLAN)` as `hatti_app` in a tenant
    transaction). First, the products statement (`loadProducts`): the admin's products list,
    newest first, and a product by ID, IDs or handle, as product pages and the storefront's read
    models load them. A collection's pages, sorted by price, position or title, are planned each
    time until their plans are checked.
  * **Every PgBouncer in front of the application sets `max_prepared_statements`** (200 per
    server connection, `db/pgbouncer/pgbouncer.ini`, and infrastructure code when it exists).
    Without it, a statement prepared on one server connection collides with or misses on
    another. A database test runs one from four callers at once through the pooler, which CI
    runs every test through, and fails without the setting. This amends ADR-021 for these
    statements alone.
* **Consequences:**
  * The products list's median fell from 2.81 to 2.23 ms directly and from 3.05 to 2.48 ms
    through PgBouncer, a fifth of the page, in the application's own code with one caller.
  * Each server connection keeps up to 200 prepared statements, and the driver the text of each
    it prepared on its connection: memory bounded by the hot queries' few shapes.
  * A query whose best plan depends on the shop must not be prepared: Postgres would keep one
    plan for all of them once it judged the generic plan no worse than the custom ones.
  * Next: the orders, customers and carts that requests read most, each checked the same way.
* **Alternatives:**
  * **Every statement prepared:** shapes without bound, such as lists of values and batch
    inserts, and generic plans for queries whose plan should depend on the shop.
  * **SQL `PREPARE` and `EXECUTE`:** session state, which transaction pooling cannot carry
    (ADR-021).
  * **`plan_cache_mode = force_custom_plan`:** would save parsing alone, not planning.

## ADR-109 · A customer's other numbers travel in a CSV column of their own: after the main number in exports, and in imports a new customer's or, on overwrite, in place of an existing one's

* **Context:** a customer can have up to ten other numbers, such as a second SIM, each theirs
  alone in the shop
  ([ADR-026](#adr-026--a-customer-can-have-several-numbers-modules-with-customer-data-join-merges-and-erasure)).
  Customer exports and imports carried main numbers only, so a shop moving its customers through a
  spreadsheet, or into another shop, lost the others. Shopify's customer export has no such
  column.
* **Decision:**
  * **Exports list them in an Other phones column**, after Phone: the customer's other numbers,
    oldest first, as people write them, separated by commas.
  * **Imports read the same column** (also Other numbers, Other phone numbers or Alternate
    phones), split at commas, semicolons or slashes. Each number is checked as a customer's other
    numbers are, as `customerUpdate` checks them: a Pakistani mobile, not the main number, at most
    ten. Within the file each number is in one row; in the shop it is no other customer's. A row
    that fails is reported at that column and left out, as other rows that fail are.
  * **A new customer gets the file's.** A customer already here keeps theirs unless the import
    overwrites, when a list takes the place of theirs, the numbers it leaves out no longer theirs.
    A blank cell, or one of nothing but separators, leaves a customer's as they are, as blank
    cells leave every field.
* **Consequences:**
  * Hatti's export imports into another shop with every number, each still one customer's.
  * A number moving between two customers in one file is refused the first time, since it is the
    other customer's until their row is taken; importing the file again moves it.
  * Not yet: a way to clear a customer's other numbers through a file.
* **Alternatives:**
  * **A column per number** (Other phone 1, 2 and so on): ten columns, mostly empty, and an
    order to each that people don't keep.
  * **Adding the file's numbers to a customer's on overwrite:** a number the shop removed would
    never go.

## ADR-110 · A customer's erasure can be asked for ten days ahead, and cancelled until then; the worker's sweep carries it out as the system, naming who asked

* **Context:** erasing a customer happened at once and could not be undone, and was refused while
  any of their orders was open
  ([ADR-026](#adr-026--a-customer-can-have-several-numbers-modules-with-customer-data-join-merges-and-erasure)).
  A shop answering a customer who asked to be forgotten had to come back once their orders had
  closed, and nothing could take back an erasure asked for in error, or by someone pretending to
  be the customer. ADR-026 left a waiting period with a cancel, as Shopify has, until the worker
  ran scheduled jobs; its sweeps now do
  ([ADR-092](#adr-092--an-order-whose-customer-could-not-be-reached-is-cancelled-as-many-days-after-it-was-placed-as-the-shop-says-by-a-sweep-in-the-worker-shop-by-shop-and-order-by-order)).
  [03 · Data §11](./03-multi-tenancy-and-data.md#11-data-lifecycle--privacy) asks for a
  customer's personal data to go within 30 days of their request.
* **Decision:**
  * **`customerErasureRequest(id)` asks for the customer's erasure in ten days**
    (`ERASURE_WAIT_DAYS`) and says when, as `erasureScheduledAt`. It takes `write_customers` and,
    from staff, a recent sign-in, as `customerErase` does
    ([ADR-103](#adr-103--sensitive-actions-need-staff-to-have-proved-who-they-are-in-the-last-15-minutes-by-signing-in-or-confirming-with-the-strongest-factor-their-account-has-apps-are-not-asked)).
    Asking again changes nothing: the first request's time stands.
  * **`customerErasureCancel(id)` cancels it** until then, with `write_customers` alone, and the
    customer stays. A customer's `erasureScheduledAt` says when theirs is due, or is null.
  * **A table, `customers.erasure_requests`**, holds one row per customer whose erasure waits:
    when it was asked for, when it is due, and who asked. The row goes with its customer, so an
    erasure at once takes it too.
  * **The worker's sweep carries out those due** (`CustomerErasures`, under the `sweeps` role,
    every `SWEEP_INTERVAL_MS`): it finds the shops with any as the system, then erases each
    customer in a transaction of their shop, once it holds them locked and their request is still
    there and due. It erases them as `customerErase` would. One with an order still open waits,
    and is tried again at each sweep until the order closes.
  * **The system erases, and the record names who asked.** Orders' timelines say the system
    erased the customer's details, since no one did at that moment; the `customer.erased` event
    and audit entry name whoever asked, and when (`requestedAt`). Asking and cancelling are
    events (`customer.erasure_requested`, `customer.erasure_cancelled`) and audit entries of
    their own.
  * **A duplicate whose erasure waits cannot be merged away**: its request would go with it, and
    the erasure never happen. Staff cancel it first, or keep that customer and merge the other
    into them.
* **Consequences:**
  * A shop answers a request to be forgotten once, whatever the state of the customer's orders,
    and has ten days to take back one made in error.
  * The customer's data goes within the 30 days unless an order of theirs stays open longer: a
    parcel still on its way, or coming back, holds it until it ends.
  * Merging a duplicate into a customer whose erasure waits adds the duplicate's data to what
    will go: the same person's.
  * The worker builds its own registry of the modules' customer data handlers, as the API's
    modules register theirs; a test holds the two lists equal, so a new module with customer data
    joins both.
  * Not yet: a list of the erasures waiting (since [ADR-116](#adr-116--the-admin-api-lists-the-erasures-waiting-the-soonest-due-first-with-their-customers-who-asked-stays-in-the-audit-log), listed), and a
    message to the customer when theirs is done, with messaging.
* **Alternatives:**
  * **Erasure at once alone, as before:** nothing to take back, and a second request once the
    customer's orders close.
  * **Erasing now what open orders don't need, and the rest when they close:** the courier still
    needs the customer's number and address, and the shop would have two erasures of one customer
    to follow.
  * **A delayed job per request in a queue:** the worker has no queue, and a table a sweep reads
    survives restarts, shows what waits and is cancelled by deleting a row.
  * **A column on the customer** (`erasure_due_at`): one table fewer, but who asked would sit on
    every customer's row.

## ADR-111 · Orders and carts are read through prepared statements too, each checked by the benchmark against shops of every size; a prepared page writes its size into its text

* **Context:** ADR-108 prepared the products statement, checked by hand, and left the orders,
  customers and carts that requests read most for next. Measured first, an order spends more
  time being planned than run: 0.35–0.6 ms planning against 0.2 ms running, and every change to
  an order answers with it; a page of 50 orders, 0.4 ms against 1.5 ms. Spike 5's dataset had no
  orders, customers or carts to check plans on, and Postgres keeps a generic plan only when it
  judges it no dearer than a shop's own, which no hand check showed.
* **Decision:**
  * **The benchmark's shops sell**: each gets a location with stock of most variants, about
    three customers for every four orders, orders over the last year at every stage with their
    lines and parcels, and shoppers' carts. Spike 5's 1,000 shops hold 724,204 orders, 543,267
    customers and 46,385 carts; their catalog is as spike 5 loaded it.
  * **`pnpm bench:db prepared` is the check**, run before preparing a statement and after
    changing one: it captures the statements the application prepares as the driver is asked to
    run them, then compares each one's generic plan (`EXPLAIN (GENERIC_PLAN)`, as `hatti_app` in
    a tenant transaction) with the plan Postgres makes for a small, a medium and a large shop's
    values, and shows how Postgres ran it over ten calls on one connection.
  * **Prepared now**, as each passed: an order by ID, orders by ID for loaders, and pages of the
    newest orders or of one stage's, risk level's or customer's, with or without a cursor; a cart
    by its secret, its variants (`snapshotsOf`, which placing an order reads too) and their stock.
    Searches, dates, filters together, exports and the Confirmation Desk's queries are planned
    each time.
  * **A prepared page writes its size into its text** (`literalLimit`), a whole number. Postgres
    plans a `LIMIT` it cannot see as a tenth of the rows, so it judged the generic plan of a
    shop's newest orders dearer than the shop's own, and planned every call. A page size is then
    a statement of its own: the API takes 1 to 250 rows, and the admin asks for one or two sizes.
    This amends ADR-108's rule that values go in as parameters, for page sizes alone.
  * **`runPrepared` prepares a Drizzle query** as `executePrepared` does SQL. A list of values goes
    in as one array parameter (`= ANY(…)`): `inArray` writes a parameter per value, a new text
    for every length.
  * **Customers' statements stay unprepared.** They plan in about 0.1 ms, Postgres went on
    planning them every call, and prepared, the customers page took 1.16 ms instead of 0.95.
* **Consequences:**
  * Medium shops, one caller, median, directly and through PgBouncer: an order went from 1.65
    to 0.49 ms and from 2.16 to 0.60 ms; the newest 50 orders from 3.66 to 2.69 and from 4.03
    to 2.84 (3.27 and 3.58 while the limit was a parameter); a cart from 2.44 to 2.26 and from
    3.23 to 3.00. Products and customers pages are as they were.
  * Every generic plan is the plan Postgres makes for small, medium and large shops alike. Postgres
    still chooses per connection, after five calls: it keeps the generic plan of an order and of
    the newest orders, and goes on planning some pages of smaller shops, such as their orders to
    confirm and the page after the first, whose own plans read fewer rows, and a cart's variants
    and stock, whose lists it cannot see the length of. Those still skip parsing and rewriting,
    most of what a cart saves.
  * A statement whose plan check fails is not prepared; a plan check is the benchmark's command,
    not a judgement made by hand.
  * Next: the loaders an order's page runs beside it, such as its customer and timeline, each
    checked the same way.
* **Alternatives:**
  * **`plan_cache_mode = force_generic_plan`:** it would apply to every statement with
    parameters, unnamed ones too, whose plans should depend on their values.
  * **Pages in a few sizes, rounded up:** fewer statements, but rows read only to be dropped.
  * **Customers' statements prepared as well:** slower, as measured.

## ADR-112 · An order waiting to be confirmed is scored again when its customer's history changes, by the worker; a score that makes it risky holds it, and a held order stays held

* **Context:** an order's risk is taken when it is placed and when its address changes
  ([ADR-025](#adr-025--order-risk-is-a-snapshot-taken-when-an-order-is-placed-or-re-addressed)),
  so an order waiting for its call does not pick up a refusal of the customer's parcel that
  happens meanwhile. ADR-025 left re-scoring for the Confirmation Desk
  ([ADR-073](#adr-073--the-confirmation-desk-deals-orders-waiting-for-their-customers-to-agents-one-at-a-time-the-most-urgent-due-first-and-keeps-the-calls-that-did-not-settle-them)),
  which now deals such orders to agents: the agent should call about the customer as they are,
  and a shop that holds risky orders should hold one that a refusal makes risky.
* **Decision:**
  * **What changes a customer's history:** a parcel of theirs delivered, refused (starting back),
    back or lost; an order of theirs cancelled; another customer merged into them. The worker's
    `RiskRescoring` handles those events (`fulfillment.updated` with its status changed,
    `order.cancelled`, `customer.merged`) and asks the orders module to score that customer's
    waiting orders again (`rescoreRisk`).
  * **Which orders:** the customer's cash-on-delivery orders that are open, not yet shipped and
    scored, and still waiting to be confirmed or reviewed (`pending` or `needs_review`). A
    confirmed order keeps the score it was confirmed on, and one that asked for an advance waits
    for its money rather than a call.
  * **How:** by the same rules as at placement, on the history as it is now. The rule for a
    possible duplicate counts the customer's unshipped orders placed in the 6 hours before this
    one, as it did when it was placed.
  * **What follows:** a different score is kept with its reasons, the timeline says so as the
    system ("Scored again as the customer's history changed: risk 0.60 (high), was 0.25. …"),
    and `order.updated` names `risk`. A waiting order that the new score makes risky under the
    shop's policy, as the old one did not, waits for review as it would have when placed, the
    reasons on its timeline. An order held already stays held, whatever its new score: staff
    decide.
  * **Safe to repeat:** it reads the history as it is, locks the customer's waiting orders in one
    order, and changes nothing that is already so, so an event handled twice or late does no
    more.
* **Consequences:**
  * A refusal holds the customer's later order it makes risky, before an agent confirms it, and
    the agent who calls sees the score the customer has now.
  * It follows its event through the queue, so an order confirmed in the moment between keeps the
    score it was confirmed on.
  * Not covered: an order whose number moves to another customer leaves the first customer's
    waiting orders as they were until something else changes their history.
  * Not yet: a history across shops (COD-07's network tier), and confirmed orders not yet shipped
    flagged to staff when their customer refuses another parcel.
* **Alternatives:**
  * **In the transaction of the change:** every path that ends an order would lock and change the
    customer's other orders, and a refusal recorded at the door would wait on them.
  * **Scoring when read:** the basis of a hold would change after the decision (ADR-025).
  * **A sweep over open orders:** work for every customer every time, and late by its interval.

## ADR-113 · An erased customer's receipts leave storage too: the erasure records each order's receipt files in an event, and the worker removes them once it commits

* **Context:** a receipt for a transfer shows the customer's name and account, so erasing the
  customer deletes their receipts' records
  ([ADR-080](#adr-080--a-customer-sends-the-receipt-of-their-transfer-through-their-orders-page-in-a-form-the-core-reads-and-keeps-in-storage-by-order-the-shop-sees-it-with-the-order)).
  Storage kept their files: nothing signed a URL for them after, but the customer's data was
  still there, in R2, for as long as the shop lasted. The erasure runs in one database
  transaction, which storage can't join: a file deleted before the commit could be gone from an
  erasure that rolled back, and one deleted after could be missed if the process died between.
* **Decision:**
  * **The erasure records what to remove, in its transaction**: deleting an order's receipts, it
    appends an `order.receipts_erased` event naming their files' keys, one event per order.
    Nothing is recorded unless the erasure commits, and the outbox delivers what is recorded at
    least once.
  * **The worker removes them** (`ErasedReceipts`): each key under that order's receipts in that
    shop (`shops/{shop}/receipts/{order}/`), which every receipt's key is; a key elsewhere is left
    and logged. Removing a file already gone changes nothing, so a repeated or late event does no
    harm.
  * **The worker reads the API's storage settings** (`STORAGE_DRIVER`, the directory or the
    bucket and its keys), with the same checks, so the two name the same place.
* **Consequences:**
  * An erased customer's receipts are gone from storage moments after the erasure, by the worker,
    as their records went with it; an erasure that waited (ADR-110) does the same when the sweep
    carries it out.
  * The worker needs storage credentials that may delete. Locally both processes run from the
    core's directory, so `.storage` is one place.
  * A receipt can't be read while its file is going: its record is gone first.
  * Not yet: receipts customers send in a chat (with messaging), and a sweep that finds files no
    record names, such as an upload whose order refused it after a crash.
* **Alternatives:**
  * **Deleting the files in the erasure itself:** before the commit, an erasure that failed
    would leave records of files that are gone; after it, a crash would leave files no one
    removes.
  * **A table of files to remove, swept by the worker:** the same guarantee, with a table and a
    sweep where the outbox already delivers.
  * **A storage lifecycle rule:** R2 deletes by age or prefix, not by whose data a file holds.

## ADR-114 · A draft its customer confirms through its link keeps what they agreed to, as checkout's orders do: the page names the shop's policies above its button, and the order keeps their versions and where it was confirmed from

* **Context:** an order placed through checkout keeps what its customer agreed to: the versions
  of the shop's policies its page linked, and the address and browser it was placed from
  ([ADR-057](#adr-057--what-a-shopper-agrees-to-in-placing-an-order-is-kept-with-it-the-versions-of-the-shops-policies-its-checkout-linked-and-where-it-was-placed-from)). An order taken in a chat is placed when its customer confirms the draft
  through its link ([ADR-031](#adr-031--draft-orders-keep-agreed-prices-and-hold-no-stock-customers-confirm-them-through-a-secret-link)), as surely their own doing, but it kept nothing: the page
  named no policies, so a shop whose customer refused the parcel, or asked for a return after
  the window, could show nothing they had agreed to.
* **Decision:**
  * **The draft's page says what confirming agrees to**, above its button, in English and Urdu,
    as checkout says it: the shop's policies, each linked where its storefront shows it and
    opening beside the page, but for its contact information, which promises nothing. Nothing
    when the shop has none.
  * **The order agrees only to what the page linked:** the page's digest covers the versions it
    linked, so a policy changed while the customer was there shows the page again, as a changed
    draft does.
  * **The order keeps it**, as checkout's orders do: the versions of the policies the page
    named, and the address and browser the confirmation came from, as the core sees them
    (`TRUST_PROXY` behind a proxy, as for staff sign-in). When is when the order was placed,
    which confirming does. Without policies, it keeps where it was confirmed from alone.
  * **A draft staff complete keeps none:** its customer agreed in the chat, not on a page.
* **Consequences:**
  * `Order.agreement` shows a draft's order's as it shows checkout's, the policies as they were
    then. The address and browser are the customer's data, as checkout's are: in the file of
    their own data, and cleared when they are erased.
  * The policies are linked at the shop's storefront on the platform's domain, as checkout
    links them; the storefront sends the customer on to the shop's own domain if it has one.
  * A policy saved while a customer fills in their address shows the form again, without what
    they typed, as a draft changed then does.
  * Checkout's limit on orders from one internet address
    ([ADR-087](#adr-087--checkout-takes-at-most-three-orders-a-day-from-one-mobile-number-and-twenty-an-hour-from-one-internet-address-counting-the-orders-it-placed-one-at-a-time))
    counts its own orders alone, as it does by number, now that drafts' orders keep addresses too.
  * Not yet: orders staff and apps place whose customers confirm them through the order's link
    ([ADR-032](#adr-032--customers-confirm-or-cancel-cash-on-delivery-orders-through-a-link-that-then-follows-the-order)). The order is placed before they agree, so when they agreed would be a
    time of its own to keep (since [ADR-115](#adr-115--an-order-staff-or-an-app-placed-keeps-what-its-customer-agreed-to-in-confirming-it-through-its-link-the-page-names-the-shops-policies-and-the-order-keeps-their-versions-where-it-was-confirmed-from-and-when), kept).
* **Alternatives:**
  * **A box to tick:** stronger evidence of assent, but one more tap at the step customers
    leave most, as for checkout.
  * **The policies as they were when staff made the link:** the customer reads them when they
    open the page, so a policy changed in between would be kept but never shown.
  * **The policies at the foot of the page, as checkout's are:** the sentence links those that
    bind; a footer would add the contact information alone.

## ADR-115 · An order staff or an app placed keeps what its customer agreed to in confirming it through its link: the page names the shop's policies, and the order keeps their versions, where it was confirmed from and when

* **Context:** an order its customer places through checkout, or by confirming its draft through
  the draft's link, keeps what they agreed to ([ADR-057](#adr-057--what-a-shopper-agrees-to-in-placing-an-order-is-kept-with-it-the-versions-of-the-shops-policies-its-checkout-linked-and-where-it-was-placed-from), [ADR-114](#adr-114--a-draft-its-customer-confirms-through-its-link-keeps-what-they-agreed-to-as-checkouts-orders-do-the-page-names-the-shops-policies-above-its-button-and-the-order-keeps-their-versions-and-where-it-was-confirmed-from)). An order
  staff or an app place, as from a phone call, is confirmed by its customer through the order's
  own link ([ADR-032](#adr-032--customers-confirm-or-cancel-cash-on-delivery-orders-through-a-link-that-then-follows-the-order)), and kept nothing: its page named no policies. Unlike a draft's,
  this order exists before its customer agrees, so the time it was placed is not when they did.
* **Decision:**
  * **The order's page says what confirming agrees to** while the order waits for its customer
    and keeps nothing they agreed to, as a draft's page says it: the shop's policies but its
    contact information, each linked at its storefront, in the page's digest.
  * **Confirming keeps it**, in the same transaction: the versions the page named, the address
    and browser the confirmation came from, and when (`agreed_at`, which orders placed through
    checkout or a draft's link take as they are placed). Migration 0074 dates the agreements
    kept before by when their orders were placed, and a check keeps the versions and the time
    together.
  * **An order that kept what its customer agreed to keeps it as it was:** one placed through
    checkout and waiting to be confirmed names nothing on its page, and confirming changes
    nothing of it. Cancelling through the link agrees to nothing.
* **Consequences:**
  * Every order a customer placed or confirmed themselves keeps what they agreed to, and
    `OrderAgreement.agreedAt` says when, which for these is when they confirmed it.
  * Staff who confirm an order themselves, after a call, record no agreement: the customer
    agreed to whatever the call said, which the order cannot show.
  * The customer's file of their own data carries when they agreed, beside where from.
* **Alternatives:**
  * **When as the order's confirmation:** the same moment for these orders, but not for an order
    placed through checkout and confirmed later, which agreed when it was placed.
  * **Asking at the first view of the page:** seeing the page agrees to nothing; confirming the
    order does.

## ADR-116 · The Admin API lists the erasures waiting, the soonest due first, with their customers; who asked stays in the audit log

* **Context:** a customer's erasure can wait ten days, which staff may cancel until then
  ([ADR-110](#adr-110--a-customers-erasure-can-be-asked-for-ten-days-ahead-and-cancelled-until-then-the-workers-sweep-carries-it-out-as-the-system-naming-who-asked)), and each customer says when theirs is due (`erasureScheduledAt`). Nothing
  listed them: staff could not see who would be erased this week, or find a request made in
  error, without opening every customer.
* **Decision:**
  * **`customerErasureRequests` lists them**, the soonest due first and then by customer, each
    with its customer, when it was asked for and when it is due, with `read_customers`, as the
    customer's own field is. The customer is shown as everywhere else, its number masked by role.
  * **Its pages carry the due time to the microsecond**, as the parcels' lists do: the platform's
    `exactTime` writes it in SQL and `decodeTimeCursor` refuses a cursor whose time is not exact
    or on no real day; the parcels' lists now use the same two.
  * **Who asked stays in the audit log**, as `customer.erasure_requested`, which only owners and
    managers read; the list names no staff.
* **Consequences:**
  * The admin's privacy screen can show what is coming and cancel what should not happen.
  * An erasure carried out or cancelled leaves the list at once; one that waits for an order to
    close stays on it, past its time, until the sweep carries it out.
* **Alternatives:**
  * **A filter on `customers`:** it pages newest first by ID; ordered by when they are due, the
    list is the one staff need.
  * **The requester on each entry:** a staff member's identity in a list read with
    `read_customers` alone, where the audit log keeps it for those who read it.

## ADR-117 · The sales report leaves out the sales tax its amounts include, as Shopify's does: worked out from the tax each order keeps, the tax said apart and added back in total sales

* **Context:** prices include the shop's sales tax ([ADR-096](#adr-096--sales-tax-is-included-in-prices-at-a-rate-the-tax-module-keeps-each-order-keeps-the-tax-in-it-as-it-was-placed-line-by-line-and-in-its-delivery)), and the sales report
  added it up apart (`taxes`, [ADR-105](#adr-105--a-refund-keeps-its-share-of-its-orders-sales-tax-the-orders-tax-in-all-it-has-refunded-less-what-the-refunds-before-it-gave-back-the-sales-report-adds-up-the-tax-its-sales-include)) but left it inside every other amount: gross
  sales, discounts, returns, net sales, shipping and fees. ADR-105 kept it so, for every amount
  to agree with the orders it adds up. But the report gives sales in Shopify's terms
  ([ADR-061](#adr-061--sales-are-reported-in-shopifys-terms-from-the-orders-when-asked-an-order-counts-on-the-day-it-was-placed-cancelled-ones-aside-and-so-do-its-items-that-came-back)), and Shopify's gross sales are prices before taxes, its net sales without
  them; a shop moving from Shopify, or its accountant, reads a net sales that includes tax as
  that much more sold. A sales tax return asks for the value of supplies without the tax too.
* **Decision:**
  * **Every amount but `taxes` leaves the tax out**, worked out from what each order keeps of it,
    never again from a rate:
    * gross sales: each line's total less the tax it includes at the rate the line was taxed at,
      rounded half up as the tax module rounds;
    * discounts: gross sales less what was paid for the items without their tax, the subtotal
      less the discount less the lines' tax, so that net sales are exactly what the items were
      paid without tax;
    * returns: the items that came back at the prices sold, less the tax that went back with
      them, as `taxes` leaves it out;
    * shipping and fees: less the tax of the charges, shared between the two in proportion.
  * **Total sales add the tax back**: net sales, shipping, additional fees and taxes, which come
    to what the orders were paid less the items that came back, as before.
  * The products that sold most are ranked by their sales without tax, and the average order
    value is gross sales less discounts without it, as Shopify's is.
* **Consequences:**
  * A shop that charges no tax sees the same report as before.
  * For one that does, gross and net sales are lower by the tax, and total sales the same.
  * Every amount but total sales differs from what the orders and the receipts show by their
    tax, which `taxes` says.
  * Discounts and returns carry a paisa's rounding each way against a rate applied to them
    alone: they are differences of kept amounts.
* **Alternatives:**
  * **Keeping the tax in, as ADR-105 did:** simpler, but not Shopify's terms, which the report
    promises.
  * **Each amount less the tax at the shop's rate now:** wrong for orders taxed at another rate,
    lines in categories, and orders placed before the rate changed.

## ADR-118 · An orders search takes filters among its words, as Shopify's search syntax writes them; a filter or value it doesn't know is refused, naming those it takes

* **Context:** `orders(query:)` looked for words alone: an order number, a mobile number, a
  tracking number, or words of the customer's name, city or email. Its other filters were
  arguments of their own (`stage`, `riskLevel`, dates, `hasTransferReceipt`), so a view of the
  orders list, such as the VIP orders still to pack, could not be kept as one string. Shopify's
  lists take filters in the search itself (`status:open tag:vip`), and its saved searches keep
  that string; the admin's saved views (ORD-01) need the same.
* **Decision:**
  * **The search takes filters among its words**, `key:value` as Shopify's syntax writes them, a
    value in double quotes if it has spaces, and a leading minus for the orders a filter does not
    match: an order's `stage`, `status`, `confirmation_status`, `financial_status`,
    `fulfillment_status`, `payment_method`, `source`, `risk_level`, a `tag` in any letter case,
    and `has_transfer_receipt`. Values are their fields' own, in lowercase. All hold together,
    with the arguments too; the words left search as before.
  * **A filter it doesn't know, or a value its filter doesn't take, is refused**, naming those it
    takes: a query's `BAD_USER_INPUT`, and an export's error on `query`. A word with a colon in
    it that isn't a filter's name, such as `10:30`, stays a word.
  * **Leaving out an order without a value** (a minus on `risk_level` for an order never scored)
    keeps it: it is not at the level left out.
* **Consequences:**
  * A view of the orders list is one string, which the admin keeps as a saved search and passes
    back to `orders(query:)` as Shopify's admin does.
  * Searches with filters are planned each time, as searches were.
  * Not yet: dates in the search (`created_at:>…`), which the arguments take; several values in
    one filter; filters for drafts' and customers' searches.
* **Alternatives:**
  * **Saved views as the arguments' values, kept apart from the search:** no syntax to parse,
    but nothing a client written for Shopify's saved searches could read.
  * **Unknown filters as words:** a mistyped filter would quietly find nothing, and a saved view
    keep it for ever.

## ADR-119 · The shop keeps searches of its orders by name, for all its staff, as Shopify's saved searches: each a query the orders search takes, checked when saved

* **Context:** the orders list is where staff spend their day, each role in its own views: an
  agent the orders waiting to be confirmed, a packer those to pack, an owner the VIP orders still
  open (ORD-01). Its search takes filters among its words ([ADR-118](#adr-118--an-orders-search-takes-filters-among-its-words-as-shopifys-search-syntax-writes-them-a-filter-or-value-it-doesnt-know-is-refused-naming-those-it-takes)), so a view is one
  string, but typing it each time is no view. Shopify's admin keeps such searches as saved
  searches, tabs over its lists, which its Admin API gives as `orderSavedSearches` and
  `savedSearchCreate`, `savedSearchUpdate` and `savedSearchDelete`.
* **Decision:**
  * **The orders module keeps saved searches of the orders** (`orders.saved_searches`, migration
    0075): a name and a query, shop-wide, for every member of staff, oldest first as tabs are
    added. Names are up to 40 characters and unique in the shop in any letter case; queries up
    to 1,000 characters; a shop keeps up to 100, counted under a lock.
  * **A query is checked when saved as the orders search checks it**, so a saved search never
    names a filter or value the list doesn't take; the list reads it as it is.
  * **The Admin API gives them as Shopify's do**, for orders alone (`resourceType: ORDER`):
    `orderSavedSearches` with `read_orders`, and creating, changing and deleting them with
    `write_orders`; each with its query, its words (`searchTerms`) and its filters, a left-out
    filter's key with its minus. Each change is an event (`saved_search.created`, …).
* **Consequences:**
  * The admin shows the shop's views as tabs over the orders list, each opened by passing its
    query to `orders(query:)`.
  * Every member of staff sees every view: there are no views of one's own yet, nor an order
    among them but the order they were added in.
  * Not yet: saved searches of drafts, customers and products, which wait for their searches to
    take filters.
* **Alternatives:**
  * **Views of each member of staff:** what someone wants of their own list, but the views a
    shop works by are the shop's, as Shopify's are.
  * **Keeping the arguments' values instead of a query:** no parsing, but nothing a client
    written for Shopify's saved searches could read.

## ADR-120 · A products search takes Shopify's filters among its words, in the syntax the orders search reads, which the admin's lists share

* **Context:** `products(query:)` looked for words alone, in the title, vendor, type and tags.
  The admin's products list needs Shopify's tabs and filters: the active, draft and archived
  products, a vendor's or a type's, those with a tag or without it, and the product a SKU or
  barcode belongs to, as a packer scans or types it (CAT-04). The orders search already reads
  filters among its words ([ADR-118](#adr-118--an-orders-search-takes-filters-among-its-words-as-shopifys-search-syntax-writes-them-a-filter-or-value-it-doesnt-know-is-refused-naming-those-it-takes)), and saved searches of other lists wait for their
  searches to read them ([ADR-119](#adr-119--the-shop-keeps-searches-of-its-orders-by-name-for-all-its-staff-as-shopifys-saved-searches-each-a-query-the-orders-search-takes-checked-when-saved)).
* **Decision:**
  * **The search syntax is the admin's lists' own**, in `@hatti/api` (`parseSearch`): each list
    gives what it holds, its filters, the values each takes, and an example for those that take
    any. The orders search is one of them, unchanged.
  * **The products search takes `status`** (`active`, `draft` or `archived`), **`vendor`,
    `product_type` and `tag`**, each matched whole in any letter case, **`sku` and `barcode`** of
    any of its variants, and **`handle`**, among the words it looked for, which still fold Roman
    Urdu spellings. A minus leaves out the products a filter matches, and keeps those without a
    value: `-vendor:Khaadi` keeps the products with no vendor.
  * **A filter it doesn't know, or a status there isn't, is refused** as the orders search
    refuses one, with `BAD_USER_INPUT` naming what it takes.
* **Consequences:**
  * The admin's tabs over its products are searches (`status:active`, `status:draft`,
    `status:archived`), and its filters pass the values `productVendors`, `productTypes` and
    `productTags` give as they are.
  * A product's SKU or barcode finds it, which its words never did.
  * Not yet: stock in the search (`inventory_total:<5`, `out_of_stock_somewhere`), which the
    inventory module keeps; dates; collections; and saved searches of products.
* **Alternatives:**
  * **Arguments of their own:** Shopify's `products` has none for these, so a client written for
    its search would find nothing it could pass.
  * **A parser for each list:** the same syntax read, and refused, in as many ways as there are
    lists.

## ADR-121 · The home says how the shop's day has gone, from midnight in its time zone: today's sales as the sales report works them out, and the parcels delivered and turned back today, at their worth

* **Context:** the admin's home says what waits for the shop (ANL-01): orders to confirm, pack
  and book, parcels coming back, the cash still to come. The design's home also says how the day
  is going, today's sales, what was delivered and what came back (RTO): the figures an owner looks
  at first each evening. The sales report already works out a day's sales in the shop's time
  ([ADR-061](#adr-061--sales-are-reported-in-shopifys-terms-from-the-orders-when-asked-an-order-counts-on-the-day-it-was-placed-cancelled-ones-aside-and-so-do-its-items-that-came-back), [ADR-117](#adr-117--the-sales-report-leaves-out-the-sales-tax-its-amounts-include-as-shopifys-does-worked-out-from-the-tax-each-order-keeps-the-tax-said-apart-and-added-back-in-total-sales)), and parcels keep when they were delivered and when
  their couriers turned them back.
* **Decision:**
  * **`home.today` is the day so far, from midnight in the shop's time zone** (`since`), worked
    out when asked for: a field of its own, so the home's other tallies never wait on it.
  * **Today's sales are the sales report's for today**: the orders placed since midnight,
    cancelled ones aside, and their total sales, read by the same statement (`salesPeriodsIn`), so
    the home and the report never disagree. An item of today's orders that came back today is
    today's return, as the report counts it.
  * **The parcels delivered today, and those their couriers turned back today, refused or
    undeliverable (RTO)**, each counted with its worth, its items at the prices sold, as lost
    parcels are ([ADR-093](#adr-093--a-claim-on-the-courier-that-lost-a-parcel-is-the-parcels-followed-until-the-courier-pays-it-or-refuses-it-a-statements-cash-for-a-lost-parcel-pays-its-claim-filed-or-not)), whenever their orders were placed. A parcel turned back today
    stays counted once checked in.
  * **Each over an index of its own** (migration 0076): orders by when they were placed, and
    parcels by when they were delivered and when they were turned back, as the home is read often
    and a shop's history only grows.
* **Consequences:**
  * The admin's home can say "today: 12 orders, Rs 48,000; 9 delivered; 2 RTO" beside what waits.
  * The orders' new index serves sales reports and COD health over short periods too.
  * Not yet: today beside yesterday or the same day last week; sessions and conversion, with the
    storefront's analytics; figures for each role.
* **Alternatives:**
  * **Today's sales as the orders' totals added up:** simpler, but a figure that would differ from
    the sales report's for the same day.
  * **The cash of the orders delivered today, rather than their parcels' worth:** an order's cash
    is not split among its parcels, so a parcel's share of it could not be said.

## ADR-122 · An order's timeline is read through a prepared statement too, checked by the benchmark on orders with their timelines; its location's loader stays planned, as customers' statements do

* **Context:** [ADR-111](#adr-111--orders-and-carts-are-read-through-prepared-statements-too-each-checked-by-the-benchmark-against-shops-of-every-size-a-prepared-page-writes-its-size-into-its-text) prepared an order and the pages of orders, and left for next
  the loaders an order's page runs beside it: its timeline (`OrderService.timeline`), its
  location (`LocationService.getMany`, through the page's loader), its customer and its transfer
  receipts. The benchmark's orders had no timelines, so the timeline's plan could not be checked
  on a shop of any size.
* **Decision:**
  * **The benchmark's orders keep timelines**: each the events its stage implies, from placed to
    paid, oldest first, drawn from what the order is rather than from the dataset's random draws,
    so the rest of the dataset stays as it was: 3,390,948 events, 4.68 an order.
  * **An order's timeline is prepared**, its page size written into its text as orders' pages
    are (`literalLimit`): one statement for each size, with a cursor or without. `pnpm bench:db
    prepared` showed one plan for small, medium and large shops, an index scan of
    `order_events_order_idx`, which Postgres kept after five calls. An order's newest 50 events
    went from 0.37 to 0.27 ms (median) directly, and from 0.48 to 0.39 ms through PgBouncer.
  * **The location's loader stays planned**, as customers' statements do: it plans in under
    0.1 ms, and prepared, its plan passed the check but its median did not move (0.51 to 0.50 ms
    directly, 0.64 to 0.68 ms through PgBouncer, within a run's noise).
  * **The transfer receipts' loader stays planned until there is a plan to check**: the
    benchmark's shops have no receipts.
* **Consequences:**
  * An order's page reads the order and its timeline through prepared statements; its location,
    customer and receipts are planned each time, each in about a tenth of a millisecond.
  * The benchmark's seed takes 151 s instead of 109 s, and its database 0.9 GB more.
  * Next: the benchmark re-run in the target cloud; a statement prepared only when traces show its
    planning, checked the same way.
* **Alternatives:**
  * **The location prepared anyway:** one more statement on every connection, for nothing
    measured.
  * **The timeline left planned:** a tenth of a millisecond more on every order's page.

## ADR-123 · A drafts search finds a draft by its number, its customer's mobile or words of their name, city or email, with filters among them, as the orders search does; each draft keeps its words folded

* **Context:** staff take orders in chats as drafts ([ADR-031](#adr-031--draft-orders-keep-agreed-prices-and-hold-no-stock-customers-confirm-them-through-a-secret-link)), and come back to one
  when its customer writes again: "the one for Bilal", "#D12", a number pasted from WhatsApp. The
  drafts list took a status alone, so finding one meant scrolling. Shopify's
  `draftOrders(query:)` takes words and filters, and the orders and products searches read
  Shopify's syntax already ([ADR-118](#adr-118--an-orders-search-takes-filters-among-its-words-as-shopifys-search-syntax-writes-them-a-filter-or-value-it-doesnt-know-is-refused-naming-those-it-takes), [ADR-120](#adr-120--a-products-search-takes-shopifys-filters-among-its-words-in-the-syntax-the-orders-search-reads-which-the-admins-lists-share)).
* **Decision:**
  * **`draftOrders(query:)` finds a draft by its number** ("#D12", "D12" or "12"), **its
    customer's mobile** in any format, **or words of their name, city or email**, folded as the
    orders' are, every word needed.
  * **Filters among the words, in the syntax the lists share**: `status`, `source`,
    `payment_method`, and a `tag` in any letter case, a minus to leave matches out; a filter or
    value the search doesn't know is refused with `BAD_USER_INPUT`, naming those it takes. The
    `status` argument still holds beside them.
  * **Each draft keeps its words** (`search_text`, migration 0077), written whenever its address
    or email changes, by staff or by its customer through the link, as each order keeps its own.
    Drafts kept before the migration have theirs in lowercase, unfolded, until they next change.
* **Consequences:**
  * The admin finds a draft as it finds an order, and the same words do for both.
  * A shop's drafts are few, so a search reads them all; no index serves it.
  * Not yet: saved searches of drafts, which wait for saved searches to take more than orders.
* **Alternatives:**
  * **Words matched against the address as stored:** no column to keep, but no folding, so
    "Bilaal" would never find "Bilal" as it does among orders.
  * **Drafts found through their customers:** a draft without a customer yet, the usual one, would
    never be found.

## ADR-124 · Saved searches take the shop's drafts and products as well as its orders, each query checked by its own list's search, names unique within a list, and keeping one needs the scope that changes its list

* **Context:** saved searches kept the orders' alone ([ADR-119](#adr-119--the-shop-keeps-searches-of-its-orders-by-name-for-all-its-staff-as-shopifys-saved-searches-each-a-query-the-orders-search-takes-checked-when-saved)), waiting for the other
  lists' searches to take filters. The products search does now ([ADR-120](#adr-120--a-products-search-takes-shopifys-filters-among-its-words-in-the-syntax-the-orders-search-reads-which-the-admins-lists-share)), and so does
  the drafts' ([ADR-123](#adr-123--a-drafts-search-finds-a-draft-by-its-number-its-customers-mobile-or-words-of-their-name-city-or-email-with-filters-among-them-as-the-orders-search-does-each-draft-keeps-its-words-folded)); the admin's products and drafts want tabs of their own, as
  Shopify's do (`productSavedSearches`, `draftOrderSavedSearches`).
* **Decision:**
  * **A saved search names the list it searches**, as Shopify's `resourceType`: `ORDER`,
    `DRAFT_ORDER` or `PRODUCT` (`resource_type`, migration 0078). Saved searches stay in the orders
    module, which reads the catalog already; the catalog gives its search's parser
    (`parseProductSearch`) as it gives its services.
  * **Each query is checked by its own list's search**, when saved and when changed, so a product's
    tab can never name an order's stage; its words and filters are given back as that search
    reads them.
  * **Names are unique within a list**, in any letter case, and a shop keeps up to 100 of each
    list's: the orders and the products may both have a "Drafts" tab. This amends ADR-119's names
    unique in the shop.
  * **Keeping one needs the scope that changes its list**: `write_orders` for orders and drafts,
    `write_products` for products, checked for the list named when saving and the saved search's
    own when changing or deleting it; reading them, the scope that reads the list.
  * **`orderSavedSearches`, `draftOrderSavedSearches` and `productSavedSearches`** list each
    list's, oldest first; `saved_search.created` says which list.
* **Consequences:**
  * The admin's orders, drafts and products each show the shop's tabs, opened by passing a tab's
    query to its list's search.
  * A new list with a search joins by giving its parser and its scopes.
  * Not yet: saved searches of customers, whose views are segments (CUS-03), nor of collections
    and files, whose lists take no filters.
* **Alternatives:**
  * **A table of each module's own:** products' tabs in the catalog, but the same service and API
    written twice, and `savedSearchCreate`, one mutation for every list, answering from two places.
  * **One scope for every list:** an app that keeps orders could have changed the products' tabs.

## ADR-125 · Low stock is a variant of an active product with the shop's threshold or fewer units for sale online, five until it says otherwise, worked out from the levels when asked: counted on the home and listed the fewest first

* **Context:** INV-01 is stock tracking and low-stock alerts. The alerts need messaging, but the
  admin's home, which says what waits and how the day went ([ADR-121](#adr-121--the-home-says-how-the-shops-day-has-gone-from-midnight-in-its-time-zone-todays-sales-as-the-sales-report-works-them-out-and-the-parcels-delivered-and-turned-back-today-at-their-worth)), can say now
  what is running out, and staff need a list to reorder from. Shopify keeps no threshold of its
  own; apps that alert on low stock ask the shop for one.
* **Decision:**
  * **A shop sets what it calls low**: one threshold for all its variants, five units until it
    says otherwise, 0 to 10,000 (`inventory.settings`, migration 0079; `inventorySettings` and
    `inventorySettingsUpdate`, an `inventory_settings.updated` event).
  * **A variant is low with the threshold or fewer units for sale online, and out with none**:
    available at the shop's active locations that fulfil online orders, as its
    `inventoryQuantity` counts them, none where it was never stocked; tracked variants alone, of
    active products alone, which the catalog's own facade says (`snapshotsOf`), as stock never
    reads the catalog's tables.
  * **The home counts them** (`home.lowStock`: the threshold, how many are low, how many are
    out), a field resolved apart with `read_inventory`; **`inventoryLowStock` lists them**, the
    fewest for sale first, then by variant, with the product's and variant's titles and SKU.
  * **Worked out from the levels when asked**, as the home's other tallies are: nothing but the
    threshold is stored.
* **Consequences:**
  * Staff see "3 low, 2 out" on the home and the list to reorder from; alerts on WhatsApp and push
    follow with messaging, from the same definition.
  * A shop's levels are read whole for each count: about as many rows as its tracked variants.
  * Not yet: a threshold of a variant's own, stock at a location that sells in person counted
    apart, and how fast a variant sells, which would say when it will run out.
* **Alternatives:**
  * **A threshold for each variant:** what large catalogs want in time, but a setting to keep for
    every variant before the first count means anything.
  * **The products search filtering by stock (`inventory_total:<5`):** Shopify's way, but the
    catalog would read stock's tables.

## ADR-126 · A customers search takes a tag and each channel's marketing consent among its number or words, in the syntax the lists share; segments stay the shop's saved views of customers

* **Context:** the customers list found a number, the end of one, or words of the name or email,
  and nothing else. Its everyday views, such as the shop's VIPs or those who take offers on
  WhatsApp, are a filter each; segments (CUS-03) answer the larger questions, those that count
  orders and spend. The orders, products and drafts searches read Shopify's syntax already
  ([ADR-120](#adr-120--a-products-search-takes-shopifys-filters-among-its-words-in-the-syntax-the-orders-search-reads-which-the-admins-lists-share)), and Shopify's customers search takes filters the same way.
* **Decision:**
  * **`customers(query:)` takes filters among its number or words**: a `tag` in any letter case,
    and `whatsapp_marketing_state`, `sms_marketing_state` and `email_marketing_state`, each
    `subscribed`, `not_subscribed` or `unsubscribed`, a minus to leave matches out; a filter or
    value it doesn't know is refused with `BAD_USER_INPUT`, naming those it takes. The number or
    words left match as before, partly for staff who see numbers whole.
  * **No saved searches of customers**: segments are the shop's saved views of them, as Shopify's
    are now, so a customers tab is a segment ([ADR-124](#adr-124--saved-searches-take-the-shops-drafts-and-products-as-well-as-its-orders-each-query-checked-by-its-own-lists-search-names-unique-within-a-list-and-keeping-one-needs-the-scope-that-changes-its-list) keeps the other lists').
* **Consequences:**
  * The admin's customers list filters as the other lists do, with the same words for a tag.
  * Orders counted and money spent stay the segments' to ask, over their own language.
* **Alternatives:**
  * **Segments' language in the customers search:** one language fewer, but a search box that
    takes `number_of_orders > 3 AND …` is a segment editor, not a search.
  * **Saved searches of customers beside segments:** two kinds of view of the same list, which
    Shopify has moved away from.

## ADR-127 · An order is given to one member of staff at a time, to see it through: owners, managers and apps give it to anyone, other staff take one no one has; staff find theirs with `assignee:me`, and those who leave give their open orders back

* **Context:** ORD-10 is tags, notes and assignment. Orders keep tags and notes; who sees an order
  through was nowhere. The Confirmation Desk deals out the orders waiting for their customers one
  call at a time ([ADR-073](#adr-073--the-confirmation-desk-deals-orders-waiting-for-their-customers-to-agents-one-at-a-time-the-most-urgent-due-first-and-keeps-the-calls-that-did-not-settle-them)), which says who calls now, not who answers for an order from
  confirming it to its delivery: a manager hands a difficult customer, a large order or a
  complaint to one person. Shopify gives orders to no one; its shops' staff tag them with names,
  which check no one and anyone may take off.
* **Decision:**
  * **An order is given to one member of staff at a time, or to no one** (`assignee_id` and
    `assigned_at` on the order, migration 0080), by `orderAssign(id, staffMemberId)` with
    `write_orders`; without `staffMemberId`, to no one. The core checks that they work in the
    shop, as the identity module says (`StaffService.staffOf`); the orders module keeps whom and
    since when, puts it on the timeline ("Assigned to Ayesha Khan", "No longer assigned to
    anyone") and says `order.updated` with `assignee` changed. Giving it to whoever has it already
    changes nothing.
  * **Owners, managers and apps give an order to anyone, and take it from whoever has it; other
    staff take an order no one has for themselves, and give back their own.** Giving one to
    someone else is refused as their role's (`ACCESS_DENIED`), and an order someone else has
    stays theirs (`INVALID`) until an owner or manager moves it, so no one takes a colleague's
    customer behind their back.
  * **Staff find theirs with `assignee:me`** in the orders search ([ADR-118](#adr-118--an-orders-search-takes-filters-among-its-words-as-shopifys-search-syntax-writes-them-a-filter-or-value-it-doesnt-know-is-refused-naming-those-it-takes)), anyone's
    with `assignee:usr_…`, and those no one has with `assignee:none`; an app is no member of
    staff, so `assignee:me` finds it nothing. A saved search takes it, so "Mine" is a tab
    ([ADR-119](#adr-119--the-shop-keeps-searches-of-its-orders-by-name-for-all-its-staff-as-shopifys-saved-searches-each-a-query-the-orders-search-takes-checked-when-saved)), and exports filter as the list does.
  * **`Order.assignee` says who, by their account and name, not how they sign in**, read once for
    a page of orders: staff who may not list the shop's staff still see who has an order.
    `assignedAt` says since when.
  * **Those who leave give their open orders back**: removing a member of staff gives each of
    their open orders to no one, on its timeline and with an event. Closed and cancelled orders
    keep whom they were given to, found by `assignee:usr_…`, though `assignee` reads null once
    they have gone.
* **Consequences:**
  * The admin's orders say who has each, and each member of staff has a tab of their own.
  * Removing a member and giving their orders back are two transactions, the identity module's
    and the orders'; should the second fail, the orders keep a member who left, `assignee` reads
    null, and an owner or manager moves them.
  * The Confirmation Desk deals out orders as it did, whoever has them: an assignment says who
    answers for an order, the desk who calls now.
  * Not yet: telling a member of staff an order was given to them, which waits for messaging;
    giving many at once among the bulk actions; the desk dealing agents their own orders first.
* **Alternatives:**
  * **Tags naming people (`tag:ayesha`):** what Shopify's shops do, but a tag checks no one works
    in the shop, outlives them leaving, and anyone may take it off.
  * **Anyone with `write_orders` taking any order:** fewer rules, but an agent could take a
    colleague's customer, and no one would have moved it.
  * **The Confirmation Desk's claim as the assignment:** it lasts minutes, for one call, and only
    while an order waits to be confirmed.
  * **Several members of staff on one order:** a packer and an agent both, but "whose is it" with
    two answers has none.

## ADR-128 · Staff and apps comment on an order's timeline: each comment its author's to change, kept apart from the events and read among them, every entry saying who made it, and comments going with the customer's details in an erasure

* **Context:** ORD-02 is the order's timeline: everything that happened to it, from calls and
  courier scans to payments and edits. The timeline says what happened, and the order keeps who
  did it, but staff wrote on an order only through its one note, which the next edit replaces,
  signed by no one. Shopify's timeline takes comments from staff, signed, which their authors
  edit or delete. The timeline's events are append-only for request code and never hold contact
  details, so an erasure leaves them as they are ([ADR-026](#adr-026--a-customer-can-have-several-numbers-modules-with-customer-data-join-merges-and-erasure)).
* **Decision:**
  * **Staff and apps comment on an order's timeline** with `write_orders`
    (`orderCommentCreate(orderId, message)`, up to 2,000 characters), signed by the caller: a
    member of staff's account, or an app's access token.
  * **A comment is its author's**: they change its words (`orderCommentUpdate`; `editedAt` says
    when) or delete it (`orderCommentDelete`). Owners and managers delete anyone's, as they may
    anything on an order, but change no one's words.
  * **Comments are kept apart from the events** (`orders.order_comments`, migration 0081): the
    events stay append-only and free of contact details, while a comment, which may say anything
    of the customer, can change and go.
  * **`Order.events` reads both**, newest first, by their IDs, which both take in the order they
    were made: one prepared statement ([ADR-122](#adr-122--an-orders-timeline-is-read-through-a-prepared-statement-too-checked-by-the-benchmark-on-orders-with-their-timelines-its-locations-loader-stays-planned-as-customers-statements-do)), each table read backwards along its
    index and the two merged. A comment is an entry of kind `comment`, with an ID of its own
    (`ocm_…`).
  * **Every entry says who made it** (`OrderEvent.author`): a member of staff by account and name,
    as their account has it now, though they may have left the shop; an app by its token; nobody
    for what customers did through their links and what the platform did by itself. The core
    asks the identity module the names, once for a page of entries.
  * **An erasure deletes the comments on the customer's orders**, as it clears the orders' notes.
    A customer's own file leaves them out with the rest of the timeline, which records the shop's
    work ([ADR-102](#adr-102--a-customers-own-data-is-one-json-file-of-everything-the-shop-keeps-of-them-which-each-module-with-their-data-adds-to-the-blocklist-and-risk-scores-stay-out)).
  * **A comment changes nothing of the order**: no version, no event.
* **Consequences:**
  * The admin's order page shows one timeline: what happened, what staff said about it, and who
    did and said each.
  * The benchmark's orders carry comments, one on every fourth and a second on every twelfth
    (240,560 beside 3,390,948 events): the timeline's statement kept one plan for every size of
    shop, each table read along its index, and an order's newest 50 entries took 0.28 ms
    (median) directly and 0.40 ms through PgBouncer, as its events alone had (0.27 and 0.39).
  * Not yet: mentions that tell a member of staff they were named, which wait for messaging,
    as telling them an order was given to them does ([ADR-127](#adr-127--an-order-is-given-to-one-member-of-staff-at-a-time-to-see-it-through-owners-managers-and-apps-give-it-to-anyone-other-staff-take-one-no-one-has-staff-find-theirs-with-assigneeme-and-those-who-leave-give-their-open-orders-back)); files on comments; comments on drafts
    and customers.
* **Alternatives:**
  * **Comments as events (`kind: 'comment'` in `order_events`):** one table, but the timeline
    would no longer be append-only, and an erasure could clear a comment only if request code
    could change events.
  * **A list of comments beside the timeline (`Order.comments`):** a simpler query, but the
    admin would merge two lists by time, paging each apart.
  * **Authors' names copied onto their comments:** no lookup, but a name changed later would
    stay wrong on every comment, and the timeline's other entries would still need one.
  * **Owners and managers changing anyone's words:** moderation, but a comment would no longer be
    its author's words; deleting one is enough.

## ADR-129 · Products leave as Shopify's product CSV, a file the import takes back whole: filtered as the products list is, each tracked variant's stock for callers who may read it, a larger catalog in parts; the import links variants to their images

* **Context:** CAT-05 is the bulk editor and CSV import and export, CSV at the MVP. Products come
  in from Shopify's product CSV ([ADR-059](#adr-059--a-shopify-product-export-is-imported-product-by-product-as-productcreate-makes-them-keeping-their-handles-the-core-sets-the-stock)), but nothing let them out: a shop wants a
  backup, its prices in a spreadsheet, or its catalog moved to another shop, or back to Shopify.
  Shopify's product CSV is the file merchants, their tools and Shopify's import know.
* **Decision:**
  * **`productsExport(query)` gives the shop's products as Shopify's product CSV**, filtered as
    `products(query:)` is ([ADR-120](#adr-120--a-products-search-takes-shopifys-filters-among-its-words-in-the-syntax-the-orders-search-reads-which-the-admins-lists-share)), oldest first, with `read_products`.
  * **Shopify's headings, in its order**: those the import reads, and those Shopify asks of a
    product shipped by hand (Variant Fulfillment Service `manual`, Variant Requires Shipping
    `TRUE`). Rows as Shopify writes them: a product's share its handle, the first gives the
    product and its option names, one row for each variant and each image, the n-th image on the
    n-th row; Title / Default Title for a product without options. Prices in major units with no
    separators (`4500.00`); a description as HTML paragraphs and line breaks, which the import
    reads back as the same text.
  * **Stock for callers who may read it**: each tracked variant's quantity for sale online and
    whether it sells on at zero, with `read_inventory`; without it no variant's is tracked in the
    file, and an import leaves stock alone. The inventory module gives it and the core passes it
    in, as it sets the stock an import brings.
  * **A file is one the import takes back whole**: at most 5,000 rows and 1,500,000 characters,
    the rows counted before any product is read. A larger catalog is refused, saying how many
    rows or characters it would take, and exported in parts, by status, vendor, type or tag.
  * **The import links each variant to its image** (Variant Image), as Shopify's does, once the
    product's images are made, so that a round trip keeps them. This amends ADR-059, which added
    variants' images to the product's alone.
* **Consequences:**
  * A shop backs up its catalog, or moves it to another shop, with two calls, and Shopify's
    import takes the same file.
  * An export runs in its request: on the benchmark's shops, 127 products took 9 ms and 1,307
    products, 2,444 rows and 1.4 million characters, 80 ms; a shop of 2,498 products with long
    descriptions, 4,451 rows, is past the characters and goes in parts.
  * Importing a file into the shop it came from changes nothing, as the import leaves handles the
    shop has alone: prices edited in a spreadsheet do not come back that way yet.
  * Not yet: updating products from a file, collections, SEO fields and metafields, and stock by
    location, which Shopify keeps in a file of its own.
* **Alternatives:**
  * **Hatti's own columns:** simpler to read, but no tool or Shopify would take the file.
  * **A file of any size:** a backup of every catalog, but a file the import could not take back
    whole, split by hand where a product's rows must stay together.
  * **Exports as background jobs, to a file in storage:** for catalogs of any size, but storage and
    jobs wait for the infrastructure, as the import's do.

## ADR-130 · Told to overwrite, an import updates the shop's products from the file: fields from the columns it has, a blank cell clearing an optional one, variants matched by their option values and new ones added; options and stock stay the admin's and inventory's

* **Context:** products go out as Shopify's product CSV ([ADR-129](#adr-129--products-leave-as-shopifys-product-csv-a-file-the-import-takes-back-whole-filtered-as-the-products-list-is-each-tracked-variants-stock-for-callers-who-may-read-it-a-larger-catalog-in-parts-the-import-links-variants-to-their-images)), but the import
  leaves the products a shop has as they are ([ADR-059](#adr-059--a-shopify-product-export-is-imported-product-by-product-as-productcreate-makes-them-keeping-their-handles-the-core-sets-the-stock)), so a file edited in a
  spreadsheet, the prices of a sale, new SKUs or a sale ended, could not come back. Shopify's
  import can overwrite the products whose handles a store has.
* **Decision:**
  * **`productsImport(csv, overwrite: true)` updates each product whose handle the shop has**;
    without `overwrite` they stay as they are, as before.
  * **Fields come from the columns the file has**: a column it lacks leaves the field as it is,
    and a blank cell clears an optional field, a vendor, type, compare-at price, cost, SKU,
    barcode or tax code, as Shopify's import does. A blank price or weight leaves the variant's;
    a title is needed, as for a new product.
  * **Variants are matched by their option values**, in any letter case, and keep their IDs,
    which orders, carts and stock refer to; the file's other combinations become new variants,
    new values added to their options. Variants the file leaves out stay.
  * **The product's options must be the file's**, the same names in the same order: options are
    changed in the admin, and a product whose options differ is left as it is and said.
  * **Images the product lacks are added**, by address, and each variant is shown with its own;
    images the file leaves out stay.
  * **The shop's variants keep their stock**: stock is counted and adjusted in its ledger, with
    reasons, and a file exported earlier would undo the sales since. New variants get the stock
    the file tracks, as new products do.
  * **Every change to a product is checked before the first is made**, its fields, its variants'
    and the count of variants, so the catalog's checks leave a product whole or untouched; the
    changes are then made as the admin makes them, through the catalog's services, with their
    events. A dry run counts what would be updated.
* **Consequences:**
  * A shop exports, changes its prices in a spreadsheet and imports with `overwrite`: a sale set
    up, or ended, in minutes.
  * A product's update is a few transactions, its fields, its variants, its new variants and its
    images: a later one failing, which the checks make rare, leaves the earlier ones made, said
    at the product's row.
  * Not yet: deleting the variants or images a file leaves out, changing options from a file, and
    stock from a file, which waits for an inventory file of its own.
* **Alternatives:**
  * **Replacing each product whole:** simpler, but it would delete the variants orders and carts
    refer to, and with them their stock.
  * **Blank cells leaving fields as they are:** safer for a careless edit, but no sale could be
    ended from a spreadsheet, nor a SKU removed.
  * **Stock from the file:** one file for everything, but what sold between the export and the
    import would be counted again.

## ADR-131 · An order's items change while it waits to be packed: quantities set and variants added in one edit, the lines kept keeping their prices, its amounts and tax worked out again and the difference collected at the door, its stock committed and let go at once

* **Context:** a cash-on-delivery customer often changes their mind on the confirmation call:
  another size, two instead of one, a dupatta to go with the suit. Orders took a new address,
  note and tags, but not new items, so staff cancelled the order and placed it again, losing its
  number, link, timeline and whom it was given to. Shopify edits an order through a calculated
  order: changes staged one by one, then committed.
* **Decision:**
  * **`orderEditLineItems(id, input)` changes an order's items in one call**: `setQuantities`
    gives its lines new quantities, 0 taking one off, and `addVariants` adds variants, a line
    each, at their prices now or a price given, as `orderCreate` takes them. Lines are named by
    their IDs, since an order may hold a variant on two lines; a variant on the order already
    changes by its line instead. An edit that changes nothing leaves the order as it is.
  * **Only while it waits to be packed**: open, nothing shipped and not packed. A packed order is
    marked unpacked first, since its parcel changes too. An order with refunds keeps its items,
    as its refunds' tax was worked out from them.
  * **The lines kept keep the prices they were sold at**, and a variant added is sold at its
    price now. A variant gone or archived sells no more: its line may go down or come off, not
    up.
  * **Its amounts are worked out again as when it was placed**: subtotal, total, and the sales
    tax at the shop's rates now, line by line after each line's share of the discount; its
    discount, delivery charge, fee and advance stay as they were. A discount more than the items
    now cost is refused, and so is a total below what was paid on it.
  * **Cash on delivery takes the difference**: what was paid or asked for in advance stays, and
    the cash collected at the door rises or falls with the total, within the law's cap. A
    bank-transfer order paid in full that now costs more waits for the rest by transfer; one
    paid in advance owes it, as Shopify's balance due.
  * **Its stock follows at its location, by variant**: the units added committed and those taken
    off let go in one call of the inventory module, `StockService.recommit`, which locks all
    their levels at once, in the order every writer locks them, so that an edit and an order
    taking the same stock the other way round never wait on each other. Too few in stock
    refuses the edit, at the line short.
  * **An order scored when it was placed is scored again** for what it holds now, and waits for
    review if the edit is what makes it risky, as a new address does.
  * **The timeline says what changed and who changed it**, "Changed the items: 2 × Kurta instead
    of 1, removed Dupatta, added 1 × Chappal (8); Rs 7,970 instead of Rs 3,610", and
    `order.updated` names `lineItems`. It needs `write_orders`.
* **Consequences:**
  * An agent changes the order on the call and reads the new total back; the order keeps its
    number, link, timeline and assignee.
  * The lines are written again, those kept keeping their IDs: safe only while nothing has
    shipped, as parcels name lines.
  * An order's items may differ from what its customer agreed to at checkout or through its
    link; its timeline says who changed them, and when.
  * Not yet: a new price for a line kept; changing the order's discount, delivery charge or fee;
    splitting an order or merging two; customers changing items through their links.
* **Alternatives:**
  * **Shopify's calculated order** (`orderEditBegin`, staged changes, `orderEditCommit`): a
    preview before committing, but sessions to keep and expire; the admin holds the changes and
    sends them in one call.
  * **The whole list of items in each edit:** simpler for a form, but an order may hold one
    variant on two lines at different prices, which only their IDs tell apart.
  * **Each kept line keeping its tax as placed:** but each line's share of the discount changes
    with the items, and the shop's rates apply to an order not yet sent.
  * **Committing the units added, then releasing those taken off, in two calls:** an edit holding
    one level while it waited for another could deadlock with an order taking them the other way
    round.

## ADR-132 · An order its customer placed twice is merged into the other while both wait to be packed: the other takes its items and discount and keeps its own delivery charge, as one parcel; the order merged is cancelled as merged, naming it, and counts for nothing in its customer's history

* **Context:** a cash-on-delivery customer places an order, then another an hour later for
  something to go with it, or the same order twice; the risk rules flag the second as another
  order from the number. Shipped apart, the two cost two parcels and two delivery charges, and
  cancelling one and editing the other ([ADR-131](#adr-131--an-orders-items-change-while-it-waits-to-be-packed-quantities-set-and-variants-added-in-one-edit-the-lines-kept-keeping-their-prices-its-amounts-and-tax-worked-out-again-and-the-difference-collected-at-the-door-its-stock-committed-and-let-go-at-once))
  would count a cancellation against the customer and lose the second order's discount and note.
  Shopify has no merge: apps cancel the duplicates and edit the order they keep.
* **Decision:**
  * **`orderMerge(id, intoId)` merges one order into another of the same customer's**, both
    waiting to be packed and paid the same way. The order merged into takes the other's items,
    at the prices they were sold at, a line of the same variant at the same price taking its
    units; its discount, transfer discount and discount codes; and its note and tags where they
    fit. It keeps its own address, delivery charge and fee: one parcel.
  * **The order merged has nothing paid or asked for in advance**, so that what a customer paid
    stays with the order they paid it for; the other way round, the order with the advance takes
    the one without.
  * **Its amounts, stock and risk follow as an edit's do**: subtotal, total, tax and cash at the
    door worked out again, the COD cap checked, and the order scored again, held if that makes
    it risky. Units already committed stay committed, at the same location; from another
    location they move, let go there and committed here in one call.
  * **The order merged is cancelled as `merged`**, a cancel reason only merging gives, and names
    the order it joined (`merged_into_id`, `Order.mergedInto`); it keeps its own lines, as a
    record. Its customer's link says which order it joined, in English and Urdu, and both
    timelines say what happened, as kind `merged`.
  * **It counts for nothing in the customer's history**: the customer placed one order, not
    two, so a merged order is left out of their facts (risk, segments, stats), of COD health,
    and of agents' cancellations; the other order is scored again without it.
* **Consequences:**
  * The Confirmation Desk's agent, calling about the second order, merges it into the first,
    and the customer pays one delivery charge, on one parcel.
  * Every count of a customer's orders leaves merged ones out, and a new one must too.
  * Not yet: merging more than two at once, an order with money paid merged with its payment,
    choosing the address or the larger delivery charge, and splitting an order.
* **Alternatives:**
  * **Cancelling the second and editing the first:** two steps, the second's discount, codes
    and note lost, and a cancellation against the customer and the agent.
  * **Moving the lines to the order merged into:** the order merged would be left with none,
    and its invoice, link and exports with nothing to show.
  * **Deleting the order merged:** its number, link and timeline gone, a gap in the shop's
    numbers.

## ADR-133 · Stock leaves and comes back as Shopify's inventory CSV: a row for each tracked variant at each active location, named by handle, options and location; a count sets on hand where On hand (new) says, and refuses a row whose on hand changed since the file was exported

* **Context:** a shop counts its stock in a spreadsheet: before Eid, at the end of a month, or
  when a warehouse is set up. Products come and go as Shopify's product CSV
  ([ADR-129](#adr-129--products-leave-as-shopifys-product-csv-a-file-the-import-takes-back-whole-filtered-as-the-products-list-is-each-tracked-variants-stock-for-callers-who-may-read-it-a-larger-catalog-in-parts-the-import-links-variants-to-their-images)),
  but stock stays inventory's, which an import of products leaves alone
  ([ADR-130](#adr-130--told-to-overwrite-an-import-updates-the-shops-products-from-the-file-fields-from-the-columns-it-has-a-blank-cell-clearing-an-optional-one-variants-matched-by-their-option-values-and-new-ones-added-options-and-stock-stay-the-admins-and-inventorys)).
  Shopify keeps stock in a file of its own, its inventory CSV: a row for each variant at each
  location, with On hand (current) as exported and On hand (new) to set, refusing a row whose
  stock changed since.
* **Decision:**
  * **`inventoryExport(query, locationId)` writes Shopify's inventory CSV with all its states**:
    a row for each tracked variant at each active location, or one, of the products a search
    matches, oldest first, named by handle, title, options and SKU; Incoming 0, Unavailable
    what checkouts hold and safety stock keeps back, Committed, Available and On hand (current)
    as they are; On hand (new) blank. It needs `read_products` and `read_inventory`, and is as
    much as one import takes, a larger shop's in parts.
  * **`inventoryImport(csv, dryRun)` sets on hand where On hand (new) says**, a stock count
    (`cycle_count_available`) in the ledger with the file as its reference, 250 levels a change;
    a blank cell, or what is on hand already, changes nothing. It needs `write_inventory` and
    `read_products`.
  * **Rows name a variant by its product's handle and its option values**, in any letter case,
    a product without options by its handle alone, and a location by its name: never by IDs,
    which a spreadsheet would lose, nor by SKU, which a shop need not keep.
  * **A row whose On hand (current) is not what is on hand now is refused**, as when stock sold
    between the export and the import: counting it would undo the sale. Without the column, a
    row sets what it says.
  * **The catalog writes and reads the file; the core finds the stock and sets it** through the
    inventory module, as for products ([ADR-129](#adr-129--products-leave-as-shopifys-product-csv-a-file-the-import-takes-back-whole-filtered-as-the-products-list-is-each-tracked-variants-stock-for-callers-who-may-read-it-a-larger-catalog-in-parts-the-import-links-variants-to-their-images)).
* **Consequences:**
  * A shop exports its stock, counts it, and imports the file back: a count in minutes, its
    sales since kept.
  * A count starts tracking a variant whose stock was never recorded, as any count does.
  * Not yet: Incoming, bins, HS codes and countries of origin, which Hatti does not keep;
    Excel files; and counts that adjust rather than set.
* **Alternatives:**
  * **Stock in the product CSV:** one file for both, but Shopify's has stock at one location,
    and an import of products leaves stock alone, rightly.
  * **Variants by SKU:** shorter rows, but SKUs are optional, and a shop may repeat one.
  * **Available rather than on hand:** what is for sale, but what a count finds on the shelf
    is on hand, committed units among it.

## ADR-134 · An order's delivery charge and discount change while it waits to be packed, as its items do, its totals, tax and cash at the door following; what was taken off for paying by transfer stays part of the discount, and the fee stays

* **Context:** on the confirmation call a customer may balk at the delivery charge, or ask for
  something off before they agree, and a shop would rather waive Rs 250 than lose the sale. An
  order's items change while it waits to be packed
  ([ADR-131](#adr-131--an-orders-items-change-while-it-waits-to-be-packed-quantities-set-and-variants-added-in-one-edit-the-lines-kept-keeping-their-prices-its-amounts-and-tax-worked-out-again-and-the-difference-collected-at-the-door-its-stock-committed-and-let-go-at-once)),
  but its delivery charge and discount stayed as it was placed: staff cancelled it and placed it
  again, or the courier collected more than the customer agreed to. Shopify's order editing adds
  a shipping line, or a discount on a line, to its calculated order.
* **Decision:**
  * **`orderEditCharges(id, input)` sets an order's delivery charge, its discount, or both**, as
    amounts: `shippingPrice` "0" waives delivery, and `discount` is what is taken off its items
    in all, as the agent says it on the call. One that changes nothing leaves the order as it is.
    It needs `write_orders`.
  * **When its items may change, and only then**: open, nothing shipped, not packed and without
    refunds. It shares an item edit's checks and writing.
  * **Its amounts follow as an edit's do**: its total; the sales tax again, each line after its
    share of the new discount, and the delivery charge's with it; the cash collected at the door
    taking the difference, what was paid or asked for in advance staying. A discount more than its
    items cost is refused, and so is a total below what was paid or below its advance. A
    cash-on-delivery order scored when it was placed is scored again, and waits for review if
    that makes it risky.
  * **What was taken off for paying by transfer stays part of the discount**
    ([ADR-077](#adr-077--something-off-for-paying-by-transfer-is-part-of-the-orders-discount-kept-apart-from-the-codes-off-the-items-after-any-code-to-the-rupee-said-where-the-shopper-chooses)):
    the discount can't go below it, since the customer paid by transfer for it. The codes the
    order was placed with stay on it, as used; the discount is what it takes off now.
  * **Its fee stays**: it is what paying on delivery costs by the shop's rule
    ([ADR-076](#adr-076--a-shops-fee-for-cash-on-delivery-is-the-orders-own-amount-apart-from-delivery-in-its-total-and-the-cash-collected-said-beside-the-option-where-the-shopper-chooses)),
    not something to give on the call.
  * **The timeline says what changed and who changed it**, "Changed the delivery charge to Rs 0
    from Rs 250, and the discount to Rs 360 from Rs 0; Rs 3,000 instead of Rs 3,610", and
    `order.updated` names `shipping`, `discount`, or both.
* **Consequences:**
  * The agent waives delivery or gives something off on the call and reads the new total back;
    the courier collects what the customer agreed to, and the order keeps its number and link.
  * What an agent takes off is the order's discount, which the sales report counts among
    discounts, as a code's.
  * Not yet: a discount on one line, or a new price for one; the fee; why something was taken
    off, apart from the timeline; and a limit on what each member of staff may give.
* **Alternatives:**
  * **Shopify's discounts on lines and shipping lines** in a calculated order: a discount for
    each line, but an order here keeps one discount, spread over its lines as at checkout, and
    one delivery charge.
  * **A percentage off:** what codes give, but on the call an agent says an amount, "Rs 500
    off", and the order keeps the amount.
  * **Part of `orderEditLineItems`:** one call for both, but an edit of items need not name its
    charges, and each says what it changed on its own.

## ADR-135 · Items sent apart from an order paid on delivery become an order of their own, as its cash is collected by order: at their prices with their share of the discount, the rest of the order as it is and its stock where it was, both orders scored as the one their customer placed

* **Context:** part of an order may wait for stock, a size coming back next week, while its
  customer wants the rest now; or they want one piece sooner, for a wedding. Shopify splits
  fulfillment orders, not orders: one payment, shipped in parts. Here a courier collects cash on
  delivery by booking, one amount a parcel, and couriers' statements are matched to parcels, so an
  order paid on delivery shipped in two parcels can't say what each collects. Staff cancelled the
  order and placed its parts again, losing its discount, confirmation and link, and counting a
  cancellation against the customer and the agent.
* **Decision:**
  * **`orderSplit(id, input)` sends units of an order's lines apart as an order of their own**,
    with the shop's next number: `lineItems` names the lines and how many of each go. At least one
    item stays.
  * **Only an order paid on delivery, while it waits to be packed**: open, nothing shipped, not
    packed, no refunds, and nothing paid or asked for in advance, which is for all of it. A prepaid
    or transfer order ships in parts instead, its money not collected at the door.
  * **The part takes the units at the prices they were sold at, and its share of the discount** by
    what they cost, by the largest remainder, in whole rupees when the discount is whole, so that
    the cash each collects stays whole. Its delivery charge is what staff give, nothing if left
    out, the shop sending it at its own cost; the order keeps its own, and its fee.
  * **Both orders' amounts are worked out again as an edit's**
    ([ADR-131](#adr-131--an-orders-items-change-while-it-waits-to-be-packed-quantities-set-and-variants-added-in-one-edit-the-lines-kept-keeping-their-prices-its-amounts-and-tax-worked-out-again-and-the-difference-collected-at-the-door-its-stock-committed-and-let-go-at-once)):
    totals, sales tax at the shop's rates now, and cash to collect, within the law's cap.
  * **The part takes the rest of the order as it is**: its customer and address, note, tags and
    discount codes, its confirmation and calls, the member of staff it is given to, the policies
    agreed, and when it was placed, so that the sales report keeps its sales on that day. Not the
    order's link: the part has its own once one is sent, saying which order it is part of, in
    English and Urdu. It names the order it was split from (`Order.splitFrom`), the first one
    when a part is split again.
  * **Its stock stays committed where it was**: the same units, at the same location.
  * **Both are scored as the one order their customer placed**: neither counts in the other's
    history, nor as another order from the number in the last hours, whenever either is scored
    again. Elsewhere each is an order of its own, a parcel delivered or refused on its own: in the
    customer's stats and segments, COD health and the sales report.
  * **The timelines say what happened**, "Split off 1 × Kurta, 1 × Dupatta as #1002; Rs 2,486
    instead of Rs 5,670" and "Split from #1001: 1 × Kurta, 1 × Dupatta; Rs 3,334";
    `order.created` tells of the part and `order.updated` of the order. It needs `write_orders`.
* **Consequences:**
  * The agent sends what is in stock now and the rest when it comes, each parcel collecting its
    own cash, and couriers' statements match parcels as before.
  * A customer's order count and the sales report's orders count the part; risk does not.
  * Merging a part back into the order
    ([ADR-132](#adr-132--an-order-its-customer-placed-twice-is-merged-into-the-other-while-both-wait-to-be-packed-the-other-takes-its-items-and-discount-and-keeps-its-own-delivery-charge-as-one-parcel-the-order-merged-is-cancelled-as-merged-naming-it-and-counts-for-nothing-in-its-customers-history))
    undoes a split.
  * Not yet: the order listing its parts, which its timeline names; splitting an order with money
    paid or asked for in advance; splitting by location without staff; and a customer choosing,
    through their link, to wait for all of it.
* **Alternatives:**
  * **Shopify's fulfillment orders, an order shipped in parts:** one order, but a courier's
    booking states one amount to collect, which an order shipped in parcels could not divide.
  * **The part keeping the order's risk score:** simpler, but its total and units are its own,
    and scoring both as the one placement keeps the customer's history as it was.
  * **A delivery charge for the part by the shop's rates:** what a new order would be charged, but
    the customer paid for delivery once, and staff charge again only when the shop says so.

## ADR-136 · A customer's return of delivered items is recorded by staff, each item with its reason, and checked in when it arrives, each unit back in stock where it came back to or written off; money given back stays a refund, and the sales report counts what came back

* **Context:** items of a delivered parcel come back: a size too small, a colour unlike the
  photo, a fault. The customer sends them back by courier, or brings them to the shop, which
  sends another size or gives the money back. Hatti took back only parcels refused at the door
  ([ADR-071](#adr-071--a-parcel-coming-back-is-checked-in-by-the-tracking-number-on-its-label-matched-as-couriers-statements-are-those-on-their-way-back-are-listed-the-longest-first)):
  a delivered parcel could not come back, so staff kept returns on paper and the stock never
  went back on the shelf. Shopify records a return against an order's delivered items, each with
  a reason, and processes it when it arrives, restocking or not; refunds are apart.
* **Decision:**
  * **`returnCreate(input)` records a customer's return**: units of an order's delivered lines,
    each no more than were delivered and are not on another return already, each with Shopify's
    reason (too small, too large, unwanted, not as described, the wrong item, defective, other);
    where it comes back to, the order's location unless another is given; the courier and
    tracking number it comes by, if any; and a note. It is named as Shopify names returns,
    #1001-R1, and open until it arrives.
  * **`returnReceive(id, restock)` checks it in** as a refused parcel is checked in: each unit
    back in stock where it came back to, or written off, all of it restocked if nothing is said.
    It is then closed.
  * **`returnCancel(id)` cancels an open one**, as when the customer keeps the items after all;
    they may come back on another return later.
  * **Only delivered units come back**: a parcel refused at the door comes back as itself, and an
    order's items not yet shipped are edited or cancelled, not returned.
  * **Money given back is a refund** ([ADR-029](#adr-029--refunds-record-money-staff-sent-back-only-owners-and-managers-make-them)),
    recorded apart, as Shopify's are: a return says what came back, a refund what was paid back,
    which for a cash-on-delivery customer is often a transfer days later, or nothing, another size
    being sent instead.
  * **The sales report counts what came back as returns**, on the order's day, as it counts
    refused parcels: from when the return is recorded, unless it is cancelled.
  * **A customer's return is not a refusal**: the history their risk is scored on, and COD
    health, count refused parcels, not returns.
  * **The order's timeline says what happened**, "Return #1005-R1 recorded: 1 × Shalwar Qameez,
    Wash & Wear (M), too small; coming back by Leopards KHI 5512 to Lahore warehouse", and
    `return.created`, `return.closed` and `return.cancelled` tell apps, with the order's stage
    and version. `Order.returns` lists them and `Order.returnStatus` sums them up. They need
    `write_orders`.
  * **A return's note goes with its customer's details in an erasure**; what came back, and why,
    stays.
* **Consequences:**
  * A wrong size comes back and goes back on the shelf, its stock right again, and the sales
    report shows it.
  * Not yet: exchanges, a new size sent as the old one comes back; customers asking for a return
    through their link (ORD-08); reverse pickups booked with couriers; return windows and fees;
    refunds worked out from what came back; and a list of returns on their way.
* **Alternatives:**
  * **Shopify's return requests, approved or declined:** for returns customers ask for
    themselves (ORD-08); staff recording one have agreed to it already.
  * **Returns by parcel:** what a refused parcel is, but a customer sends back some items of a
    parcel, or of two.
  * **A refund with every return:** one step, but most cash-on-delivery returns are exchanges,
    and the money, when it goes back, goes later and by hand.

## ADR-137 · A return may send another size at once, as an order of its own, paid by what was paid for what comes back: credited from its order as a refund by exchange, in which no money moves, the door collecting the rest

* **Context:** most fashion returns are exchanges: a size too small for the next one up. The
  customer wants the new one soon, and some couriers deliver it and take the old one back in the
  same visit. Shopify adds the exchange's items to the original order, applies what the returned
  items were worth to them, and asks for the balance. Here cash on delivery is collected by order
  ([ADR-135](#adr-135--items-sent-apart-from-an-order-paid-on-delivery-become-an-order-of-their-own-as-its-cash-is-collected-by-order-at-their-prices-with-their-share-of-the-discount-the-rest-of-the-order-as-it-is-and-its-stock-where-it-was-both-orders-scored-as-the-one-their-customer-placed)),
  and an order delivered and paid is closed, so an exchange shipped on it would open it again and
  give its parcels different cash to collect. Returns are recorded already
  ([ADR-136](#adr-136--a-customers-return-of-delivered-items-is-recorded-by-staff-each-item-with-its-reason-and-checked-in-when-it-arrives-each-unit-back-in-stock-where-it-came-back-to-or-written-off-money-given-back-stays-a-refund-and-the-sales-report-counts-what-came-back)).
* **Decision:**
  * **`returnCreate` takes `exchangeLineItems`, and `exchangeShippingPrice`**: the exchange is
    placed at once, before the return arrives, as any order is placed: the variants at their
    prices now or a price given, its stock committed at the order's location, confirmed, at the
    order's address, paid on delivery, from the order's source. The return names it
    (`Return.exchangeOrder`), and its timeline the return.
  * **What was paid for the items coming back pays for it, as far as it goes**: their prices less
    their share of the order's discount. On the order this is a refund by exchange (method
    `EXCHANGE`, its reference the exchange's number), in which no money moves
    ([ADR-029](#adr-029--refunds-record-money-staff-sent-back-only-owners-and-managers-make-them));
    on the exchange it is paid in advance; the rest is collected at the door. What was paid
    beyond the exchange is for the shop to refund, as the timeline says.
  * **What pays for it must be in**: an order whose cash has not been recorded yet pays for no
    exchange, and staff record its payment first.
  * **So every report stays right**: the sales report counts the items coming back as returns and
    the exchange as a sale, with the tax of each; what a customer has spent counts what they paid
    once.
  * **A return whose exchange was sent is not cancelled**: what comes back paid for it.
    `orderRefund` never refunds by exchange.
* **Consequences:**
  * The agent sends the right size the day the customer calls, and the courier collects only the
    difference, if any.
  * Not yet: an exchange for an order not paid yet; one after the return arrives, which staff
    place as an order; cancelling an exchange, by hand for now; a reverse pickup in the same
    visit; and customers choosing an exchange through their link (ORD-08).
* **Alternatives:**
  * **Shopify's exchange items on the original order:** one order, but a closed, paid order
    would open again, and its parcels would collect different cash.
  * **The exchange priced at the difference:** simpler, but the sales report would count the old
    item as sold and the new one at a fraction of its price, its tax with it.
  * **What was paid as the exchange's discount:** the exchange's tax would be on what the door
    collects, and the sales report would show a discount nobody gave.

## ADR-138 · Customer returns on their way are listed the longest first, with their days and items, and counted on the home, as parcels coming back are

* **Context:** a customer says they sent the wrong size back, and a week later nothing has come:
  the return was recorded ([ADR-136](#adr-136--a-customers-return-of-delivered-items-is-recorded-by-staff-each-item-with-its-reason-and-checked-in-when-it-arrives-each-unit-back-in-stock-where-it-came-back-to-or-written-off-money-given-back-stays-a-refund-and-the-sales-report-counts-what-came-back)),
  but nothing showed it still waiting. Parcels coming back are listed the longest on their way
  first, and counted on the home
  ([ADR-071](#adr-071--a-parcel-coming-back-is-checked-in-by-the-tracking-number-on-its-label-matched-as-couriers-statements-are-those-on-their-way-back-are-listed-the-longest-first)).
* **Decision:**
  * **`openReturns(first, after)` lists returns still on their way**, the longest first: each
    with its name, its order, how it comes back, the exchange sent for it, the whole days since
    it was recorded and the items coming back, on pages with exact cursors, as the lists of
    parcels have. It needs `read_orders`.
  * **The home counts them**, `home.returnsToReceive`: how many, and what their items sold for.
  * **A partial index on the open returns** keeps both quick, whatever the shop's history.
* **Consequences:**
  * Staff chase the customer, or the courier bringing it, before an exchange paid for by what
    comes back is forgotten.
  * Not yet: finding a return by the tracking number on its label, as parcels are, and a
    customer's returns on their link.
* **Alternatives:**
  * **Orders filtered by their return status:** one list fewer, but the order does not say how
    long a return has been on its way, nor how many items.
  * **Returns in the list of parcels coming back:** one list, but a return is no parcel the shop
    shipped, and its courier may not be the shop's.

## ADR-139 · A shopper's browser keeps the visits that brought them, the first and the last from elsewhere; checkout passes them on, and the order keeps them as Shopify's customer journey

* **Context:** shops in Pakistan sell through ads on Facebook, Instagram and TikTok, links in
  bios and WhatsApp broadcasts, and influencers' discount codes. Orders said which channel they
  came through (the online store, WhatsApp, a draft), but not which campaign or ad, so a shop
  could not tell which of its ads brought sales, still less sales delivered. Shopify keeps a
  customer's first and last visits with each order, its customer journey: the landing page, the
  site that linked to it, where it came from and its UTM parameters. Storefront pages are kept
  at the edge, the same for every shopper, their cache key leaving out campaign tags
  ([ADR-047](#adr-047--the-edge-keeps-storefront-pages-by-the-handles-they-name-before-they-stream-and-forgets-those-whose-documents-change)): a page the edge serves never reaches the storefront, and an answer
  that sets a cookie is not kept.
* **Decision:**
  * **The shopper's browser keeps the visits**, in a cookie of the shop's, `hatti_visits`,
    which a small script in every shopper's page head writes, so pages stay the same for
    everyone, kept at the edge. It keeps two visits at most, each with when it began, the path
    it landed on with its query, and the page of another site's that linked to it, without its
    query: the first, and the last from elsewhere. A visit from elsewhere is one whose address
    has UTM tags or an ad's click ID (`fbclid`, `gclid`, `gbraid`, `wbraid`, `ttclid`,
    `msclkid`), or that another site linked to; moving between the shop's pages, or coming back
    to it straight, changes nothing, as last non-direct click counts. A visit counts for 30
    days. Staff previewing a theme keep none.
  * **The storefront passes them when checkout starts**, adding the request itself by the same
    rules in its own code, as when a cart permalink in an ad brings the shopper straight there
    ([ADR-065](#adr-065--a-cart-permalink-begins-a-cart-of-its-own-and-goes-to-its-checkout-leaving-the-shoppers-cart-as-it-is)), whose visit it keeps in the cookie too. A discount link
    ([ADR-064](#adr-064--discount-links-keep-their-code-with-the-shoppers-cart-one-begun-for-it-if-need-be-and-a-cart-says-of-a-code-only-whether-it-applies)) sends its campaign tags on to the page it leads to.
  * **The core checks them and keeps them with the checkout**, and the order placed copies
    them: each visit's time, landing page (2,048 characters at most), referring page (512),
    where it came from, and its landing page's UTM parameters (255 each). Where it came from
    is its `utm_source`, in lower case, as the shop tagged its link; else, for an ad's click,
    the platform of the site linking to it, or the ad's; else that site's platform by name,
    such as `instagram`, or its domain; else `direct`. Visits older than 30 days, ahead of the
    clock, or with no web address are dropped.
  * **`Order.customerJourneySummary`** gives them as Shopify does: `firstVisit` and `lastVisit`,
    each with `occurredAt`, `source`, `landingPage`, `referrerUrl` and `utmParameters`, and
    `daysToConversion`; one visit is both, and orders placed otherwise have none. A request's
    loader reads them apart from the order, so lists of orders do not carry them.
  * **A part split from an order keeps its visits**; an exchange sent for a return has none.
  * **Erasing a customer's data clears the pages** their visits landed on and came from, which
    may carry an ad's click ID or what they searched for; where each came from and its UTM
    parameters stay, the shop's own words for its campaigns, for its sales by campaign. A
    customer's own export ([ADR-102](#adr-102--a-customers-own-data-is-one-json-file-of-everything-the-shop-keeps-of-them-which-each-module-with-their-data-adds-to-the-blocklist-and-risk-scores-stay-out)) gives their orders' visits.
* **Consequences:**
  * Sales, and sales delivered, can be counted by where they came from and by campaign: the
    sales report's next step.
  * The click IDs on landing pages are there for the conversions sent to ad platforms later,
    as orders are confirmed and delivered.
  * Safari keeps a cookie a script wrote for seven days, so visits there count for a week, and
    browsers that block cookies keep none. Shoppers' browsers alone say where they came from,
    so a visit can be made up, as any analytics' can.
  * Not yet: a consent banner the cookie waits for, visits given with orders apps place, and
    influencers' own links beyond the discount codes orders keep.
* **Alternatives:**
  * **The storefront setting the cookie on the landing page:** no script, but a page that sets
    a cookie is not kept at the edge, and one the edge serves never reaches the storefront: ads'
    landing pages, the busiest, would lose either their cache or their visits.
  * **Every visit recorded in the core:** the whole journey, as Shopify's moments, but a write
    for every landing, kept for shoppers who never order. The first and last visits answer what
    shops ask: what brought them, and what brought them back to buy.
  * **The visits kept with the cart:** a cart begins with the first item added, after the
    landing, and the cookie keeps them until checkout anyway.
  * **UTM parameters read from the landing page when asked for:** nothing derived kept, but
    reports by campaign would take URLs apart in SQL.

## ADR-140 · Sales and COD health are broken down by where orders came from: the source and the campaign of each order's last visit from elsewhere, orders without one together

* **Context:** orders placed through checkout keep the visits that brought their customers
  ([ADR-139](#adr-139--a-shoppers-browser-keeps-the-visits-that-brought-them-the-first-and-the-last-from-elsewhere-checkout-passes-them-on-and-the-order-keeps-them-as-shopifys-customer-journey)), but a shop wants them added up: which sources and campaigns sell, and
  which bring orders refused at the door. The sales report gave a period's sales by day and by
  product ([ADR-061](#adr-061--sales-are-reported-in-shopifys-terms-from-the-orders-when-asked-an-order-counts-on-the-day-it-was-placed-cancelled-ones-aside-and-so-do-its-items-that-came-back)); COD health gave its confirmation and delivery rates by city,
  product, channel and courier ([ADR-060](#adr-060--cod-health-follows-a-periods-cash-on-delivery-orders-worked-out-from-them-when-asked-its-rates-of-those-that-turned-out)).
* **Decision:**
  * **`salesReport(by:, first:)` gives `rows`**: the sales of each channel (`SOURCE`), of each
    place the orders' last visits came from (`VISIT_SOURCE`), or of each campaign (`CAMPAIGN`),
    in Shopify's terms as the totals are, items that came back taken off, most total sales
    first. Its days and its rows share one statement, grouped by an expression of the order.
  * **`codHealth(by: VISIT_SOURCE | CAMPAIGN)`** gives their confirmation and delivery rates
    the same way.
  * **Each order counts for its last visit from elsewhere**, as checkout kept it, its source
    and campaign worked out then, so nothing takes addresses apart in SQL. Orders without a
    visit, as staff's and apps' are, are one row, "No visit known", and visits without a
    campaign "No campaign". Campaigns spelt in other letter cases are one, named by the
    spelling most orders have, as cities are; platforms go by their names, as "Instagram".
* **Consequences:**
  * A shop sees which ads and links sell, and which bring orders that are refused; what each
    returned when it cost something waits for ad spend (MKT-12's Growth half).
  * The rows of a sales report add up to its totals, whatever they are broken down by.
  * Not yet: by first visit, by medium or by ad (`utm_content`), and sales delivered.
* **Alternatives:**
  * **A report of its own for campaigns:** another query and shape, where the sales report's
    and COD health's rows answer what a shop asks.
  * **First visits, or shares between visits:** Shopify's reports and ad platforms count the last
    click; first visits are kept, for a breakdown by them later.
  * **Grouping by `utm_source` as written:** a row for each spelling (`fb`, `Facebook`), where the
    source already names the platform.

## ADR-141 · An order's lines keep what their variants cost when sold, and the sales report works out the cost of goods, gross profit and what orders made, less couriers' charges and write-offs, plus claims

* **Context:** a shop selling on cash on delivery loses money where its sales report sees none:
  couriers charge for parcels out and back, refused parcels come back damaged, and some are lost.
  What it made is its sales less what its goods cost and what delivering them cost, the true
  profit report (ANL-03). Variants keep what a unit costs the shop; couriers' statements keep
  what they charged for each parcel ([ADR-088](#adr-088--a-parcel-keeps-what-couriers-statements-charged-for-it-which-cod-health-adds-up-for-those-that-came-back-a-statement-with-the-lines-of-one-imported-before-is-refused)); parcels lost or damaged keep their
  write-offs and the claims couriers paid ([ADR-072](#adr-072--a-parcel-the-courier-lost-is-written-off-and-an-order-with-nothing-delivered-or-back-ends-at-a-stage-of-its-own-lost-before-reaching-the-customer-it-is-never-their-refusal), [ADR-093](#adr-093--a-claim-on-the-courier-that-lost-a-parcel-is-the-parcels-followed-until-the-courier-pays-it-or-refuses-it-a-statements-cash-for-a-lost-parcel-pays-its-claim-filed-or-not),
  [ADR-098](#adr-098--a-parcel-that-came-back-with-items-written-off-as-damaged-is-claimed-from-its-courier-for-their-worth-as-a-lost-parcel-is-for-its-own-every-claim-is-listed-the-oldest-first-to-follow-up)). Shopify records a unit's cost on the line when it is sold, and reports
  gross profit as net sales less that cost.
* **Decision:**
  * **Each line keeps `unit_cost`**, what one unit of its variant cost the shop when it was
    sold; null when the variant had none. A line added in an edit takes its variant's cost then;
    lines kept, split or merged keep theirs, and a merge joins two lines only of the same price
    and cost.
  * **The sales report's tally adds what the orders cost**, for its totals, every day, week or
    month, and every row by channel, source or campaign ([ADR-140](#adr-140--sales-and-cod-health-are-broken-down-by-where-orders-came-from-the-source-and-the-campaign-of-each-orders-last-visit-from-elsewhere-orders-without-one-together)):
    `costOfGoods`, the units kept at their cost, those that came back aside, units without a
    cost counting nothing, and how many there were (`unitsWithoutCost`); `shippingCosts`, what
    couriers' statements charged for the orders' parcels; `writeOffs`, what the units written off
    cost: those of parcels checked back in and not restocked, of parcels lost, and of customers'
    returns checked in and not restocked, those still on their way back being neither; and
    `claimsRecovered`, what couriers paid of claims.
  * **The Admin API adds `grossProfit`**, net sales less the cost of goods, as Shopify's, its
    `grossMargin`, and **`profit`**: total sales less taxes, the cost of goods, couriers'
    charges and write-offs, plus claims recovered. The products that sold most give their cost
    of goods too. It all comes from one statement, as the report's sales do
    ([ADR-061](#adr-061--sales-are-reported-in-shopifys-terms-from-the-orders-when-asked-an-order-counts-on-the-day-it-was-placed-cancelled-ones-aside-and-so-do-its-items-that-came-back)).
  * **Lines sold before keep no cost**, as on Shopify: a cost counts from the sales after it.
* **Consequences:**
  * A shop sees what each day, channel, source and campaign made after returns and couriers,
    the profit an ad brought rather than its sales.
  * A cost given or changed later never changes what earlier sales cost; a shop that gives
    none sees its units without a cost counted, and its profit before their cost.
  * Not yet: payment fees, with gateways; packaging and the shop's other costs; tax withheld
    (V1); ad spend (Growth); and refunds given without anything coming back, which stay the
    money side, as in the sales report.
* **Alternatives:**
  * **The variant's cost now:** no column, but a cost changed with new stock would change every
    sale before it, and a variant deleted would take its cost with it.
  * **Cost from what stock was bought at** (a weighted average over receipts): truer, with
    purchase orders (INV-05, Growth); a line's cost then comes from there instead of the variant.
  * **A profit report apart from sales:** the same periods and rows again, where one tally gives
    both.

## ADR-142 · A shop's catalog feed is its storefront's, at its own address: an item for each variant of its products with an image, in Google's RSS, which Meta's catalogs read too, made from its documents a chunk at a time

* **Context:** Pakistan's online shops find most of their customers through ads, on Instagram
  and Facebook above all, and on Google. Catalog ads, Meta's Advantage+ catalog ads and Google's
  Shopping ads and Performance Max, and Google's free listings are made from a catalog of the
  shop's products. Google Merchant Center and Meta's Commerce Manager fill it from a feed they
  fetch on a schedule, or through their APIs (MKT-11). Shopify's Google & YouTube and Facebook &
  Instagram channels sync products through those APIs, each an app the platform reviews and
  every shop connects. The storefront's documents already hold every product it shows, with each
  variant's price, whether it can be sold online, its options and its images, as product pages
  show them. And the storefront answers at the shop's own address, which Merchant Center checks
  items' links against.
* **Decision:**
  * **Each storefront answers `/feeds/products.xml`** at the shop's own address, its primary
    domain or its handle's subdomain, in the RSS 2.0 of Google's product data specification
    with its `g:` namespace, which Meta's catalogs read too. The Admin API gives the address as
    `Shop.productFeedUrl`, for the shop to give each platform's scheduled fetch.
  * **An item for each variant**, as Google asks for each size and colour:
    * its ID is the variant's, the same one carts and checkout name;
    * `item_group_id` is its product's, when the product has more than one variant;
    * its title, with the variant's after it;
    * its description, as text;
    * a link to its product page with it chosen;
    * its own image, else its product's first, and up to ten more;
    * in stock or not, as the storefront sells it;
    * its price; on sale, the price it was, with `sale_price` what it is now;
    * its vendor as its brand, else the shop's name;
    * `condition` new, and `identifier_exists` no, as shops make most of what they sell;
    * its product type;
    * its size and colour, from options so named in any letter case, Colour or Color.

    Text is clipped to Google's limits, which are within Meta's.
  * **Products without an image are left out**, as both platforms refuse them.
  * **Made from the storefront's documents** as its pages are: every product's ID in one round
    trip, then a hundred products a round trip. They go in the order of their IDs, so the feed
    reads alike each time, and each chunk is sent as it is made. A feed of any size streams in
    the memory of one chunk.
  * **Kept at the edge for an hour**, as sitemaps are, and forgotten with the shop's document
    ([ADR-047](#adr-047--the-edge-keeps-storefront-pages-by-the-handles-they-name-before-they-stream-and-forgets-those-whose-documents-change), [ADR-051](#adr-051--search-engines-and-link-previews-are-told-each-pages-address-at-the-shops-own-in-each-language-and-find-pages-through-sitemaps-of-the-storefronts-documents)). A shop closed behind its password sends
    its feed to the password page, as it does its sitemaps ([ADR-054](#adr-054--a-shops-storefront-can-be-closed-behind-a-password-which-the-storefront-checks-against-a-verifier-in-the-shops-document)).
  * **Images by URL**, as from a Shopify export ([ADR-059](#adr-059--a-shopify-product-export-is-imported-product-by-product-as-productcreate-makes-them-keeping-their-handles-the-core-sets-the-stock)), are at their own
    address in the feed, link previews and structured data, which had put the shop's address
    before them. A width goes after any query they have.
* **Consequences:**
  * A shop connects its catalog to Google Merchant Center and Meta's Commerce Manager by giving
    each one address. Free listings, Shopping and catalog ads are made from its products, with
    their prices, stock and images as its storefront shows them, kept up to date by the
    platforms' scheduled fetches.
  * There is no app to have reviewed, no account to connect and nothing to keep in step from the
    core: the feed is the storefront's documents, read as pages read them.
  * A change reaches the platforms when they next fetch, at most an hour after the storefront has
    it, not in the minutes an API push takes.
  * The pixels and conversion APIs to come (MKT-10) name variants by the same IDs, so ads can
    show shoppers what they looked at.
  * Not yet:
    * Google's product categories, gender and age group;
    * shipping and tax by item, which each platform's account settings give;
    * Urdu titles, which would be a second feed;
    * feeds of chosen products or collections;
    * TikTok's catalog (Growth);
    * pushes through the platforms' APIs.
* **Alternatives:**
  * **Pushes through Google's Merchant API and Meta's catalog batch API:** changes in minutes,
    but each is an app its platform reviews, an account each shop connects, and a sync to keep.
    They come with the conversion APIs (MKT-10), which need the same connections.
  * **Delimited text:** Meta takes CSV and Google tab-separated text; RSS is one file both read.
  * **An item a product:** fewer items, but the platforms would show one price and one stock for
    every size and colour.
  * **Built by the core from Postgres:** the core has every product. But the storefront's
    documents already say what its pages show, and the storefront answers at the shop's own
    address and keeps the file at the edge.

## ADR-143 · Orders placed through checkout go to Meta's conversions API from the worker as they are placed, confirmed and delivered, the shop choosing which is Purchase; each moment waits in Postgres until Meta takes it or its seven days are up

* **Context:** Pakistan's online shops pay Meta for most of their customers, and Meta learns
  whom to show their ads to from the purchases it hears of. Its pixel hears of them from
  shoppers' browsers, which ad blockers, iOS and lost connections cut short; its conversions API
  hears of them from the shop's server (MKT-10). A shop selling on cash on delivery has a
  second problem: an order placed is not a sale, and Meta, told of placed orders, learns to find
  people who order and then refuse the parcel. Shopify's Facebook & Instagram channel sends
  orders as they are placed; apps for delivered orders send them again as delivered. Hatti
  already keeps each order's confirmation and delivery, and the visits that brought its customer,
  an ad's click among them ([ADR-139](#adr-139--a-shoppers-browser-keeps-the-visits-that-brought-them-the-first-and-the-last-from-elsewhere-checkout-passes-them-on-and-the-order-keeps-them-as-shopifys-customer-journey)). A request to Meta can fail, and when one of
  the outbox's handlers fails, every handler of the event runs again.
* **Decision:**
  * **A shop connects its Meta dataset through the Admin API** (`metaConversionsUpdate`):
    * its pixel's ID, and an access token Events Manager made for the conversions API, sealed
      for the shop alone and never shown again, its last four characters to tell it by;
    * a code for test events, while the shop tries it out;
    * which moment of an order is Meta's `Purchase`: placed, the default, confirmed or
      delivered.

    Changing it needs `write_pixels`, which owners, managers and marketers have, and staff who
    signed in lately ([ADR-103](#adr-103--sensitive-actions-need-staff-to-have-proved-who-they-are-in-the-last-15-minutes-by-signing-in-or-confirming-with-the-strongest-factor-their-account-has-apps-are-not-asked)). It is audited, the token never.
  * **An order placed through checkout has three moments**: placed; confirmed, by its customer
    or staff, or, for an order paid ahead, as its money comes in; and delivered. The worker
    records each once, in `marketing.conversions`, from the order's events, for the platforms
    the shop had connected when the order was placed. Orders staff and apps place, orders placed
    before the shop connected, and parts split from an order
    ([ADR-135](#adr-135--items-sent-apart-from-an-order-paid-on-delivery-become-an-order-of-their-own-as-its-cash-is-collected-by-order-at-their-prices-with-their-share-of-the-discount-the-rest-of-the-order-as-it-is-and-its-stock-where-it-was-both-orders-scored-as-the-one-their-customer-placed)) have none.
  * **A sender in the worker sends the moments due** every fifteen seconds, a shop at a time and
    up to a hundred to a request. Each goes as a server event:
    * named `Purchase` at the shop's chosen moment, and `OrderPlaced`, `OrderConfirmed` or
      `OrderDelivered` otherwise;
    * its ID the order's number and the moment, so that Meta keeps one however often it goes;
    * with the order as it is when sent: its total, and its items by variant, as the catalog
      feed names them ([ADR-142](#adr-142--a-shops-catalog-feed-is-its-storefronts-at-its-own-address-an-item-for-each-variant-of-its-products-with-an-image-in-googles-rss-which-metas-catalogs-read-too-made-from-its-documents-a-chunk-at-a-time));
    * with its customer's mobile number, email, names, city and postcode, normalised and hashed
      with SHA-256 as Meta asks, and their ID with the shop, hashed too;
    * with the address and browser they placed it from ([ADR-057](#adr-057--what-a-shopper-agrees-to-in-placing-an-order-is-kept-with-it-the-versions-of-the-shops-policies-its-checkout-linked-and-where-it-was-placed-from)), and Meta's
      click ID from the latest visit that had one.
  * **Each moment is sent until Meta takes it, or until it is too old.** The sender takes a
    moment for five minutes, so no two send it, and one that stops has it sent again.
    * Meta busy, the shop over its limits, or a token Meta no longer takes: tried again a minute
      later, doubling to six hours.
    * Anything else Meta refuses fails, with what it said.
    * A moment more than seven days old expires unsent: Meta refuses such a website event, and
      the request with it.
    * One whose customer's data was erased, or whose shop disconnected Meta, is skipped.
  * **The Admin API lists the moments** (`conversionEvents`), the latest first, by status or by
    order, with what Meta said of each and its trace.
* **Consequences:**
  * A shop can have Meta optimise its ads on the orders that turned out: Purchase at delivery
    counts only the parcels customers took, and the other moments go as events of their own, for
    custom conversions.
  * Meta hears of an order whatever the shopper's browser did.
  * Sending is the worker's alone, apart from the outbox's handlers: Meta failing delays its
    events, and nothing else.
  * The customer's details leave hashed, and an erased customer's not at all.
  * Not yet:
    * the pixel in the storefront's pages, which the same IDs will deduplicate against;
    * TikTok's Events API and Google's conversions;
    * a consent banner the events wait for;
    * orders placed from chats and by staff;
    * values net of what came back.
* **Alternatives:**
  * **Sending from the outbox's handlers:** no table, but a failing request would run every
    handler of the event again, and their retries last minutes, not Meta's seven days.
  * **Purchase at placing alone, as Shopify's channel sends it:** Meta would learn to find
    people who order and refuse.
  * **The browser pixel alone:** lost to ad blockers and iOS, and it never sees a delivery.
  * **Sending from the request that changed the order:** a slow or failing Meta would slow or
    fail placing, confirming and delivering.

## ADR-144 · A shop's storefront loads its Meta pixel while Meta is connected, for the steps shoppers take before checkout; orders go from the server alone, each keeping the pixel's browser and click IDs for them

* **Context:** The server tells Meta of each order placed through checkout
  ([ADR-143](#adr-143--orders-placed-through-checkout-go-to-metas-conversions-api-from-the-worker-as-they-are-placed-confirmed-and-delivered-the-shop-choosing-which-is-purchase-each-moment-waits-in-postgres-until-meta-takes-it-or-its-seven-days-are-up)).
  Meta's ads also learn from what shoppers do before they order: the pages they see, the products
  they look at, what they add to their carts, and when they set out to pay. Only the shopper's
  browser sees those, through Meta's pixel, which also names the browser in cookies on the shop's
  address: `_fbp`, its browser ID, and `_fbc`, the click on an ad that brought it. Meta matches
  the server's events to its people by both. Pakistan's shops moving from Shopify had the pixel
  pasted into their themes, but a Hatti shop's theme is JSON over the platform's
  ([ADR-039](#adr-039--a-shops-theme-is-a-platform-theme-with-the-shops-own-json-files-over-it)),
  so the platform must load it. Storefront pages are the same for every shopper, kept at the edge
  ([ADR-047](#adr-047--the-edge-keeps-storefront-pages-by-the-handles-they-name-before-they-stream-and-forgets-those-whose-documents-change)),
  and checkout's page runs no scripts
  ([ADR-044](#adr-044--checkout-is-one-page-the-core-renders-and-storefronts-serve-on-the-shops-address-placing-a-cash-on-delivery-order-as-the-page-showed-it)).
  ADR-143 expected the pixel to send the orders' events too, Meta keeping one of each by its ID.
* **Decision:**
  * **The shop's storefront document names its pixel** (`metaPixelId`) while it has Meta
    connected. The publisher writes it again when the pixel's ID changes or Meta is disconnected,
    and the edge forgets the shop's pages. A shop without one keeps its document as it was.
  * **Shoppers' pages load the pixel**, in their head beside the visits' script
    ([ADR-139](#adr-139--a-shoppers-browser-keeps-the-visits-that-brought-them-the-first-and-the-last-from-elsewhere-checkout-passes-them-on-and-the-order-keeps-them-as-shopifys-customer-journey)):
    Meta's own base code, then `init` and `PageView`. Previews and the theme editor's frame do not
    ([ADR-049](#adr-049--a-theme-is-previewed-through-a-link-the-core-seals-which-storefronts-keep-in-a-cookie-and-render-from-the-cores-files-never-kept),
    [ADR-050](#adr-050--the-theme-editor-talks-to-its-preview-through-postmessage-a-framed-preview-is-in-design-mode-and-renders-sections-with-the-editors-unsaved-files)).
  * **A product's page sends `ViewContent`** for its product, by the IDs the catalog feed gives
    it ([ADR-142](#adr-142--a-shops-catalog-feed-is-its-storefronts-at-its-own-address-an-item-for-each-variant-of-its-products-with-an-image-in-googles-rss-which-metas-catalogs-read-too-made-from-its-documents-a-chunk-at-a-time)):
    a product of one variant by that variant's ID, as `product`; one of several by its own ID, as
    `product_group`, the feed's `item_group_id`. It is valued at the variant the page shows first,
    in rupees.
  * **The script hears what shoppers send**, listening before the theme's own scripts do, so the
    cart drawer's Ajax adds count too:
    * a form adding to the cart, `/cart/add` in any of the shop's languages: `AddToCart`, with its
      variant and quantity, valued when the variant is the page's product's;
    * the cart's checkout button, a form to checkout, or a link to it: `InitiateCheckout`.
  * **Orders go from the server alone.** Checkout's page keeps running no scripts, and `Purchase`
    and the other moments of ADR-143 go only through the conversions API: there is nothing to
    deduplicate.
  * **The order keeps the pixel's IDs.** As an order is placed through checkout, the storefront
    reads `_fbp` and `_fbc` from the shopper's cookies on the shop's address and passes them with
    the address and browser it was placed from
    ([ADR-057](#adr-057--what-a-shopper-agrees-to-in-placing-an-order-is-kept-with-it-the-versions-of-the-shops-policies-its-checkout-linked-and-where-it-was-placed-from)),
    in `x-hatti-client-browser-ids`. The order keeps those in Meta's format
    (`orders.browser_ids`, migration 0090). Its conversions send `fbp`, and as `fbc` the later
    click of the cookie's and the visits'. Erasing the customer's data clears them; the
    customer's own export includes them
    ([ADR-102](#adr-102--a-customers-own-data-is-one-json-file-of-everything-the-shop-keeps-of-them-which-each-module-with-their-data-adds-to-the-blocklist-and-risk-scores-stay-out)).
* **Consequences:**
  * Meta hears of shoppers' steps before they order, and matches the orders the server sends to
    the browsers that took them.
  * Pages stay the same for every shopper and kept at the edge: the script reads the shopper's
    steps from the forms they send, not from the page.
  * `AddToCart` goes as the form is sent, before the cart takes it: an add the cart refuses, as
    when stock ran out, counts all the same.
  * `InitiateCheckout` carries no value or items: pages do not know the shopper's cart.
  * The shops at the platform's subdomains share a registrable domain, where Meta's script keeps
    its cookies for all of them at once. Before shops use the pixel there, the storefronts' domain
    goes on the Public Suffix List, as Shopify's `myshopify.com` is. Shops at their own domains
    are apart already.
  * Not yet:
    * a consent banner the pixel waits for;
    * TikTok's pixel and Google's tag;
    * keeping Meta connected without the pixel on the shop's pages.
* **Alternatives:**
  * **`Purchase` from the browser too, as ADR-143 expected:** checkout's page would need scripts,
    Meta's among them, where shoppers type their addresses; the server's event has everything the
    browser's would.
  * **`AddToCart` and `InitiateCheckout` from the server:** the cart knows what was added but not
    who added it; the browser's events carry Meta's cookies and Meta's own matching.
  * **The pixel's cookies taken as checkout starts, with the visits:** the order is placed later,
    with the cookies as they are then.
  * **A shop's own pixel code in its theme:** shops' themes hold no scripts, and the platform's
    script knows the page's product by the catalog's IDs.

## ADR-145 · A signed-up user opens a shop of their own through the identity login: its name, a handle made from it or chosen and never the platform's, the user its owner, and shop.opened for its storefront, in one transaction

* **Context:** Merchants sign up for an account ([ADR-020](#adr-020--staff-identity-built-in-house-on-audited-primitives)),
  but nothing let an account open a shop: shops came from the seed and tests, inserted as the
  control plane would (ONB-01). The control plane is to own the shop directory, with
  subscriptions and cells, and is not built yet; the identity login already keeps accounts and
  their memberships, and reads `control.shops`. A new shop's storefront must answer at its
  handle's subdomain at once, and the publisher builds a shop's documents only as its events
  come. Handles name storefronts on the platform's domain, as `zari.hatti.pk`, where the
  platform's own subdomains live too.
* **Decision:**
  * **`POST /auth/shops`** opens a shop for the signed-in user: its name, and a handle, which the
    user may choose. Without one, the handle is made from the name: its Latin letters and digits
    in lower case, words joined by hyphens, at most 40 characters, numbered `-2`, `-3` … while
    another shop has it. A name without Latin letters, as one in Urdu, gives `shop-store`. A
    handle asked for and taken is refused (`HANDLE_TAKEN`). Handles the platform keeps, such as
    `admin`, `api`, `checkout` and `www`, are never a shop's.
  * **One transaction of the identity login** inserts the shop's ID, name and handle into
    `control.shops`, the rest taking the table's defaults, Pakistan's currency and time zone
    among them (ONB-10); makes the user its owner; records `shop.opened` in the outbox; and adds
    `shop_opened` to the account's activity. Migration 0091 grants the login those three columns
    and, in the outbox, that one event: nothing else of shops, and no other event.
  * **The publisher builds an opened shop whole** (`Items.everything`), so its storefront answers
    at its handle's subdomain once the worker hears it opened. Its theme, primary location and
    menus are made as they are first read, as for any shop.
  * **An account owns five shops at most**, each to have a subscription of its own, and opens
    ten a day at most. The owner uses the shop's Admin API once their session passed a second
    factor, as owners always do.
* **Consequences:**
  * A merchant goes from signing up to a live storefront without the platform's staff.
  * Shops are opened where accounts live. When the control plane is built, opening a shop moves
    to it, the API staying the same.
  * Not yet: signing up with a phone's OTP or Google (with messaging and OAuth), a plan chosen
    as the shop opens (with billing), and an invitation to the setup checklist's first steps.
* **Alternatives:**
  * **A `SECURITY DEFINER` function that opens a shop:** one more privileged path to keep
    reviewed, for what three granted columns and a policy do.
  * **A shop opened by the core's app login:** its `control.shops` stays read-only to request
    code, as it should; the identity login has the accounts and memberships the shop needs.
  * **Handles chosen always:** a step more before a merchant sees their shop; they can still
    choose one.

## ADR-146 · A shop's customers hear of their orders from Hatti's shared WhatsApp number, or by SMS where the shop saves or WhatsApp cannot deliver; each message waits in Postgres, queued once from the order's events, until the worker sends it, and WhatsApp's webhook follows it and hears customers ask to stop

* **Context:** Every MVP flow after a shop opens speaks to its customers: their order placed,
  shipped, delivered or cancelled (MSG-01), and soon confirmations of cash-on-delivery orders
  (COD-01) and checkout's one-time codes (CHK-09). [ADR-012](#adr-012--whatsapp-primary-sms-fallback-hatti-as-a-meta-tech-provider)
  chose WhatsApp first and SMS behind it, with a shared Hatti number for shops without their own
  (MSG-03), and [07 §1](./07-messaging-and-marketing.md) a pipeline from events through templates
  and a router to each channel, an SMS when WhatsApp has not delivered within 15 minutes. Shops
  choose WhatsApp for everything or SMS for updates that need no answer (07 §2.3). Customers must
  be able to say stop (MSG-09). WhatsApp's webhooks name a message by its ID alone, and a reply
  by its sender's number, before any shop is known, while the API works as one shop at a time.
* **Decision:**
  * **A messaging module, its messages in Postgres** (migration 0092): each of a shop's messages
    in `messaging.messages`, with its kind, channel, number, language and words, its order and
    customer, and how sending it went: pending, then sent, delivered and read, or failed, or
    skipped. Each is queued once by a key, as `order_placed:<order>` or `order_shipped:<parcel>`,
    however often its event comes.
  * **What customers are told:** the worker's `OrderNotifications` reads the orders' events.
    An order placed, though not a part split from one, which was placed as that order; each
    parcel shipped with its tracking number, when it is shipped with one or when it is given one
    while on its way; each parcel delivered; and an order cancelled, though not one merged into
    another. Nothing for an erased customer's order. The words: the customer's first name, the
    shop's name, the order's number and total, the courier, the tracking number and its link.
  * **Words for each channel:** each kind is a WhatsApp template of Hatti's (`hatti_order_placed`
    and so on), its body's variables in order, and an SMS's text in English and Urdu with the
    tracking link after it. A value missing is a dash.
  * **The shop's settings** (`messaging.settings`): rich, every update on WhatsApp, or economy,
    updates by SMS; English or Urdu; and the notifications turned off. `messagingSettings` and
    `messagingSettingsUpdate` (`read_settings`, `write_settings`), audited, with
    `messaging_settings.updated`. They apply from the next message queued.
  * **The worker sends** every five seconds: for each shop with messages due, fifty at a time,
    taken with `SKIP LOCKED` for five minutes, each a try. A customer who asked the shop to stop
    on that channel is skipped; a message queued more than a day ago fails, too late to help.
    Each goes through its channel's provider and is recorded at once. WhatsApp's is the Cloud
    API from Hatti's number; SMS's an aggregator's HTTP gateway, a POST of the number, words and
    shared sender ID; in development, the log. What a provider cannot take yet (5xx, 429,
    WhatsApp's throttling and passing errors, a provider not reached) is tried again a minute
    on, doubling to an hour. What WhatsApp refuses for good, such as a number not on WhatsApp,
    fails and goes by SMS instead, once; an SMS the gateway refuses fails.
  * **An SMS after 15 minutes** (07 §1): a WhatsApp message sent and not delivered 15 minutes
    later goes by SMS too, once, while it is less than a day old.
  * **WhatsApp's webhook** at `/webhooks/whatsapp` on the API answers Meta's subscription check
    with the token agreed, and takes only bodies signed with the app's secret: the
    `X-Hub-Signature-256` HMAC of the raw body, which the API keeps for `/webhooks/`. Each
    status moves its message forward alone: sent, delivered, read; failed only before delivery,
    an SMS going in its place. `messaging.resolve_provider_messages`, a `SECURITY DEFINER`
    function as order links' is, finds each message across shops, and the change is made as its
    shop. A status for a message not found that is less than ten minutes old came before the
    sender recorded the message: the webhook answers 503, and Meta sends it again.
  * **Stop** (MSG-09): a customer's "STOP", "unsubscribe", "band karo" and its spellings, or
    "بند کرو", and nothing more, stops the shop whose message they replied to, or else the shop
    that last wrote to them (`messaging.resolve_last_sender`), on that channel: the opt-out is
    kept with what they said, and their messages still to go are skipped. Other replies wait for
    the inbox.
  * **`messages`** (`read_orders`) lists the shop's messages, the latest first, by status or
    order: each with its status, tries, error and the message it went in place of, the number
    masked by role as everywhere.
  * **Customers' data:** a merged duplicate's messages become the customer's; erasure deletes
    the customer's messages, found by them or their numbers, and keeps their opt-outs, so the
    shop never writes to them again by mistake; their file has both.
* **Consequences:**
  * Every order flow can speak to its customer. Confirmations of cash-on-delivery orders
    (COD-01) and one-time codes (CHK-09) add kinds, templates and buttons to the same queue, and
    their replies come through the same webhook.
  * Hatti's templates must be approved for the shared number before it sends; one that is not
    fails and goes by SMS. Without the webhook, every WhatsApp message goes by SMS too after 15
    minutes.
  * Each message is recorded as it is sent, so a sweep of fifty does fifty small transactions.
    That is the price of statuses that come within seconds.
  * Not yet: shops' own WhatsApp accounts (Embedded Signup), message credits in PKR (MSG-04),
    email and push, Roman Urdu SMS, a second SMS aggregator and routing by channel health, SMS
    delivery reports and replies, and the inbox.
* **Alternatives:**
  * **A BullMQ job for each message:** Postgres keeps the message, how it went and the shop's
    list together, queued in the transaction that read the order, as the conversions sender's
    moments are ([ADR-143](#adr-143--orders-placed-through-checkout-go-to-metas-conversions-api-from-the-worker-as-they-are-placed-confirmed-and-delivered-the-shop-choosing-which-is-purchase-each-moment-waits-in-postgres-until-meta-takes-it-or-its-seven-days-are-up)). A job lost with Redis is a message never sent.
  * **Sending from the event handler:** a slow provider would hold the event queue, and a retry
    would run the whole handler again.
  * **The system role in the API for the webhook:** the API stays one shop at a time; two narrow
    functions find what the webhook names.
  * **The webhook queued for the worker:** one hop more, for work the API does in a few queries.
  * **Provider IDs unique:** an SMS gateway's IDs are its own; one given twice would undo the
    recording of a message sent, and send it again.

## ADR-147 · A cash-on-delivery order waiting for its customer asks them on WhatsApp to confirm it, with Confirm, Cancel and Change address buttons and its link; their answer comes through the webhook as an event, and the worker confirms or cancels the order as their link would

* **Context:** A cash-on-delivery order is shipped only once its customer confirms it, and most
  are confirmed by staff on the phone, at their cost (COD-01, [06 §3](./06-orders-fulfillment-logistics.md)).
  The sequence's first step is a WhatsApp template with Confirm, Cancel and Change address
  buttons; its second, an SMS with a tap-to-confirm link, the order's link
  ([ADR-032](#adr-032--customers-confirm-or-cancel-cash-on-delivery-orders-through-a-link-that-then-follows-the-order)), whose page also changes the address
  ([ADR-033](#adr-033--customers-correct-an-orders-address-through-its-link-until-it-is-packed-the-number-stays-the-shops)). The messaging engine
  ([ADR-146](#adr-146--a-shops-customers-hear-of-their-orders-from-hattis-shared-whatsapp-number-or-by-sms-where-the-shop-saves-or-whatsapp-cannot-deliver-each-message-waits-in-postgres-queued-once-from-the-orders-events-until-the-worker-sends-it-and-whatsapps-webhook-follows-it-and-hears-customers-ask-to-stop)) sends templates from Hatti's number and hears WhatsApp's
  webhook, which gives a button's payload with the ID of the message it was under. An order keeps
  one link: a new one replaces the last. The webhook runs in the API; confirming and cancelling
  belong to the orders module.
* **Decision:**
  * **The question in place of the news:** an order placed that waits for its customer (cash on
    delivery, its confirmation pending) is sent `order_confirmation` rather than `order_placed`,
    unless the shop turned it off. Hatti's template `hatti_order_confirmation` has the customer's
    name, the shop, the order and its total, and three quick replies, their payloads set as it is
    sent: `confirm`, `cancel` and `address`. It stays on WhatsApp whatever the shop's routing:
    its buttons are the point.
  * **The message carries the order's link,** made by the worker once the message is queued, in
    the same transaction, so an event heard twice makes one (`messageLinkIn`): on the timeline as
    sent with the message, and an `order.updated` event as `orderLinkCreate` makes. The SMS that
    goes in its place, when WhatsApp cannot deliver it, has the link after its words: the
    tap-to-confirm step. The link is kept with the message's words, for that SMS and for the
    Change address answer.
  * **An answer is an event:** the webhook finds the message a button was under through
    `messaging.resolve_provider_messages`, checks the answer came from its recipient, and records
    `message.replied` in its shop, with its kind, order and payload. The API does nothing else
    with it.
  * **The worker acts on it** (`OrderNotifications`, `CustomerAnswers` in the orders module):
    `confirm` confirms the order while it waits for its customer, and `cancel` cancels it while
    they may, as through their link: "Confirmed by the customer on WhatsApp" on the timeline,
    with the order's events. A cancellation asked for too late, once packed or as the shop's
    settings say, goes on the timeline for the shop to see. `address` sends `order_address`, the
    template `hatti_order_address` with a button to the order's page, its URL ending with the
    link's secret, and notes on the timeline that the customer asked. Each happens once, however
    often the answer is heard.
  * **Confirmed is news:** an order confirmed, by its customer or the shop, sends
    `order_confirmed`, by SMS where the shop saves.
  * **The worker reads `PUBLIC_URL`**, as the API does, for the links; required in production.
* **Consequences:**
  * A customer confirms or cancels with one tap, and the order leaves the Confirmation Desk's
    queue as they do ([ADR-073](#adr-073--the-confirmation-desk-deals-orders-waiting-for-their-customers-to-agents-one-at-a-time-the-most-urgent-due-first-and-keeps-the-calls-that-did-not-settle-them)). The desk still deals an order at once: letting the
    answer come before the first call is the sequence's timers' to do.
  * The orders module stays unaware of messaging, and messaging of orders: the worker joins them.
  * A link staff make for the order afterwards replaces the one the message carried, which then
    answers as gone; the buttons still work.
  * Not yet: the sequence's timers, a reminder and IVR when no one answers and the desk's first
    call after them (06 §3), the "Confirm on WhatsApp" link on the thank-you page, quiet hours,
    and a reply to a cancellation asked for too late.
* **Alternatives:**
  * **Acting on the answer in the API:** the webhook's request would hold order locks and fail
    with them; an event is durable, retried, and done once by the worker.
  * **A URL button for the link in the question:** a template of three answers says more than a
    link; the link is one tap away through Change address.
  * **A second link for messages:** an order has one link (ADR-032); a second would need a table
    of links and their own expiry, for an edge the buttons cover.

## ADR-148 · Checkout asks a shopper paying on delivery for a code sent to the number they typed, on WhatsApp or by SMS, where the shop's risk rules score the order at its mark; a digest of the code alone is kept, and the order keeps when its number was proved

* **Context:** A fake cash-on-delivery order costs a shop a parcel's round trip, and a number
  nobody answers is the commonest sign of one (CHK-09). [05 §5](./05-checkout-and-payments.md)
  lets an order of middling risk through once its number is proved with a code: a WhatsApp
  authentication template first, SMS beside it, limited per number. Checkout scores an order as it
  places it, and undoes one scored at the shop's limit to ask for a transfer instead
  ([ADR-099](#adr-099--an-order-paid-on-delivery-that-the-shops-risk-rules-score-at-its-limit-or-above-is-not-taken-at-checkout-placed-scored-and-undone-its-page-asks-for-a-transfer-instead)). The messaging engine sends what the worker takes from Postgres
  ([ADR-146](#adr-146--a-shops-customers-hear-of-their-orders-from-hattis-shared-whatsapp-number-or-by-sms-where-the-shop-saves-or-whatsapp-cannot-deliver-each-message-waits-in-postgres-queued-once-from-the-orders-events-until-the-worker-sends-it-and-whatsapps-webhook-follows-it-and-hears-customers-ask-to-stop)).
* **Decision:**
  * **The shop's mark:** its cash-on-delivery rules keep `verifyFromScore`, 0 to 1, 0 for every
    order paid on delivery. Checkout places such an order, scores it, and when the score reaches
    the mark and the number typed has not been proved in this checkout, undoes it as it undoes
    one at the limit, and sends a code. The page asks for it, keeping what was typed.
  * **A code** is six random digits, sent as the messaging engine's `one_time_code`: on WhatsApp,
    Hatti's authentication template with its copy button, whatever the shop's routing; by SMS
    when the shopper asks for it there. `checkout.number_codes` (migration 0093) keeps the
    SHA-256 of the code with its row's ID, the number, the channel, its tries and its ten
    minutes. Only the newest a checkout sent to a number works, for five tries. A checkout sends
    five at most, and a number is sent ten a day at most across the shop's checkouts. The message
    drops the code once it is sent, or will never be, after an SMS in its place has taken it, and
    no SMS goes for it after: a new code does.
  * **Proved:** the right code marks the number proved for the checkout, and the order is placed
    with `orders.phone_verified_at`, its timeline saying the number was proved. Another number
    typed after needs its own code.
  * **The page:** "type the code we sent on WhatsApp to 0300 ••••567", a box filled from the
    phone's messages where it can be (`autocomplete="one-time-code"`), the Place order button,
    and below it "Send the code by SMS instead", or a new code on WhatsApp after an SMS. A wrong
    or late code is said, 422; too many, 429. Enter in the box places the order.
  * **Shops cannot turn codes off** in their messaging settings: a shopper asked for each.
* **Consequences:**
  * A shop that wants it keeps out the orders of numbers nobody answers, at the cost of a few
    seconds to real customers: a code waits for the worker's next round, five seconds at most by
    default.
  * Codes and the numbers they went to go with their checkout, within a day; the order keeps
    only when its number was proved.
  * Not yet: skipping the code for a browser proved lately (a signed cookie), lowering a proved
    order's risk, `phoneVerifiedAt` in the Admin API, and signing up with a phone's code
    (ONB-01), on the same messages.
* **Alternatives:**
  * **Codes in Valkey:** a code's tries and its proof belong with the checkout's transaction;
    Postgres keeps them together, for a day.
  * **A code before placing, without the score:** the shop's mark is a score, known only as the
    order is placed, as the limit's is.
  * **A verification provider's API:** another vendor and its price, for what WhatsApp's
    authentication templates and the gateway already send.

## ADR-149 · Shops book orders with their own courier accounts, their credentials sealed for each account; each booking waits in Postgres until the worker books it through the courier's adapter, keeps the courier's number before shipping the order with it, and follows the parcel by asking, the courier's words read through mappings kept as data

* **Context:** Booking parcels is the chore that decides whether a cash-on-delivery shop can grow
  (SHP-01, SHP-02): staff copy each order into the courier's portal, and its tracking number back
  into Hatti's `orderFulfill`. [ADR-010](#adr-010--courier-adapters-with-data-driven-mappings-merchant-owned-courier-accounts-first) chose an adapter per courier behind one
  interface, with mappings kept as data and the merchant's own accounts;
  [06 §5](./06-orders-fulfillment-logistics.md) sets the contract: polling first, as few
  couriers here send webhooks, and bookings queued through a courier's outage. PostEx, the first
  of the MVP's couriers, documents its merchant API in public: an order created with
  `v3/create-order`, followed with `v1/track-order/{number}` and cancelled with
  `v1/cancel-order`, its token in a header. Meta's tokens are sealed for their shop
  ([ADR-143](#adr-143--orders-placed-through-checkout-go-to-metas-conversions-api-from-the-worker-as-they-are-placed-confirmed-and-delivered-the-shop-choosing-which-is-purchase-each-moment-waits-in-postgres-until-meta-takes-it-or-its-seven-days-are-up)), and the worker sends what waits in Postgres
  ([ADR-146](#adr-146--a-shops-customers-hear-of-their-orders-from-hattis-shared-whatsapp-number-or-by-sms-where-the-shop-saves-or-whatsapp-cannot-deliver-each-message-waits-in-postgres-queued-once-from-the-orders-events-until-the-worker-sends-it-and-whatsapps-webhook-follows-it-and-hears-customers-ask-to-stop)).
* **Decision:**
  * **Accounts (SHP-01):** `logistics.courier_accounts` (migration 0094) keeps the shop's
    accounts: the courier, a name, the credentials its portal gives, sealed with the API's keys
    for that account alone (`courier-account:{shop}:{account}`, so that none opens copied onto
    another) and never shown again, their last four characters for staff, the courier's code for
    the shop's pickup address, and one default. Owners and managers, and apps with
    `write_settings`, connect them; an account is archived, never deleted: no bookings with it
    since, those waiting cancelled, its parcels still followed. Changes are audited, the
    credentials never.
  * **Bookings (SHP-02):** `ordersBook` takes up to 250 orders and an account, the default unless
    given, each order on its own. One that could not ship now, in the words `orderFulfill` would
    use, one with part shipped, as couriers collect an order's cash whole, or one being booked
    already, is refused with why; the rest wait in `logistics.bookings`, an order once at a time.
    A booking waiting can be cancelled.
  * **The worker books** what is due, each try leased for five minutes: what the orders module
    says of the order (who receives it where, what is left to ship, and the cash it still owes
    when paid on delivery, in whole rupees, paisa rounding up) goes to the courier's adapter. The
    courier's tracking number is kept at once, then the order ships as a parcel with it, the
    system shipping it (`FulfillmentService` takes a `ParcelCaller`), so that a try after a crash
    ships what was booked rather than booking it twice. A courier that cannot take it for now
    (unreachable, a 5xx, a 429) is asked again after a minute, doubling to an hour, for a day;
    what it refuses fails, in its words. An order that changed meanwhile, or a booking cancelled
    while the courier booked it, has the courier's booking cancelled.
  * **Following (SHP-04):** booked parcels are asked about as 06 §5.3 says: every 6 hours while
    waiting to be picked up, 3 on their way, 30 minutes out for delivery, an hour after a failed
    attempt and 6 coming back; never again once delivered, back, lost or cancelled, nor sixty
    days after booking. What the courier says is kept as it said it, and read through
    `logistics.courier_statuses`, each courier's words for Hatti's statuses, seeded with PostEx's,
    else as Hatti's own words (`Out For Delivery`); words neither knows leave the parcel where it
    was. A change publishes `shipment.status_changed`; delivered marks the parcel delivered, and
    coming back marks it returning, which tells the customer and the shop as staff's marks do.
  * **Cities (SHP-03):** `logistics.courier_cities` keeps a courier's name for a city where it is
    not Hatti's; the city as the address has it otherwise.
  * **Adapters:** `CourierAdapter` (`book`, `track`, `cancel`), `PostExCourier`, and outside
    production a test courier that books nothing.
* **Consequences:**
  * Packers book a day's orders in one call, and the couriers' numbers land on the orders with
    nobody typing them; a courier's outage delays bookings and never fails the request.
  * The worker needs `ENCRYPTION_KEYS`, as conversions do: without them nothing is booked.
  * A courier's answer lost after it booked, as a timeout, may book the order twice; the first
    stays unpicked at the courier, which expires it.
  * The courier keeps what it was sent of the customer, as the shop's processor; erasing the
    customer here does not reach it.
  * Not yet: labels and load sheets (SHP-02); Leopards, TCS and Trax; a courier's own cities to
    suggest names from (SHP-03); the parcel's progress on its order's page for the customer
    (SHP-05); messages when a parcel is out for delivery or a delivery failed; cancelling a booked
    parcel through Hatti; contract tests against the couriers' sandboxes, and limits on how fast
    each courier is asked.
* **Alternatives:**
  * **Booking in the request:** a courier slow or down would fail staff's click, and 250 orders
    would take minutes.
  * **Shipping first and setting the tracking number after:** a courier's refusal would leave a
    parcel shipped with no courier, and its stock gone.
  * **BullMQ jobs in Valkey:** a booking's state belongs beside its order's, in the database the
    shop reads, and the sweep is the one messages and conversions use.
  * **Couriers' webhooks:** few couriers here send them, unsigned (06 §5.1); a webhook can be a
    hint to ask sooner later.

## ADR-150 · Couriers' labels and load sheets are Hatti's own printed pages: a booked parcel's label carries the courier's tracking number as a Code 128 barcode and the cash the courier was asked to collect, one to a 4×6 inch label or four to a sheet of A4, and an account's load sheet lists its parcels waiting to be picked up, for the shop and the rider to sign

* **Context:** Packers print a label for each parcel and hand the courier's rider a load sheet to
  sign at pickup (SHP-02: A4 and thermal labels, load sheets). The worker books parcels and keeps
  each courier's tracking number and the cash it was asked to collect
  ([ADR-149](#adr-149--shops-book-orders-with-their-own-courier-accounts-their-credentials-sealed-for-each-account-each-booking-waits-in-postgres-until-the-worker-books-it-through-the-couriers-adapter-keeps-the-couriers-number-before-shipping-the-order-with-it-and-follows-the-parcel-by-asking-the-couriers-words-read-through-mappings-kept-as-data)). Packing slips and invoices are HTML pages the browser prints, on A4 or
  thermal paper, in English and Urdu ([ADR-028](#adr-028--printable-documents-are-html-pages-with-print-styles-pdfs-will-render-the-same-pages)). Couriers' riders and hubs scan
  tracking numbers as Code 128 barcodes; each courier's own airway bill comes as a PDF in its
  own layout, PostEx's from an API of its own, ten parcels at a time.
* **Decision:**
  * **A label** is Hatti's own page for a booked parcel: the courier, its tracking number as a
    Code 128 barcode and in figures, the order, who it goes to (their number as the caller sees
    numbers elsewhere), their address and their city large, the cash the courier was asked to
    collect or that nothing is, the parcel's pieces, weight and contents, and the shop and the
    location it ships from. `courierLabels` prints up to 250 bookings, one to a 4×6 inch label
    or four to a sheet of A4, leaving out bookings not yet booked and parcels whose customer's
    details were erased.
  * **A load sheet** is a courier account's, the default unless named: its parcels booked and not
    yet picked up, as the courier last said, the longest waiting first, up to 1,000, each with
    its tracking number, order, customer, city, pieces and cash, their totals, and boxes for the
    shop and the rider to sign as the parcels change hands. On A4.
  * **The barcode** is drawn in `@hatti/documents` (`code128`): code set B, the check symbol as
    ISO/IEC 15417 works it out, bars at whole modules in an SVG with the quiet zones scanners
    need. Its table of symbols is checked against a table of their bits, written apart.
  * **The parcel's own items** come from the orders module (`parcelShipmentFactsIn`), with its
    address and where it shipped from; the cash, from the booking.
* **Consequences:**
  * A day's labels and the rider's sheet print from the admin with nothing from the courier's
    portal, alike for every courier.
  * A courier that insists on its own airway bill needs it printed from its portal until its
    adapter fetches it; Hatti's label carries the number its scanners read.
  * Not yet: couriers' own airway bills through their adapters, pickups asked for through their
    APIs, a load sheet recorded as handed over, and label printers' own languages (ZPL).
* **Alternatives:**
  * **Couriers' airway bills alone:** each courier's PDF in its own layout and size, fetched ten
    at a time and merged, and none for a courier without the API.
  * **PDFs made on the server:** the browser prints these pages as it prints packing slips; PDFs
    render the same pages later, as ADR-028 says.
  * **QR codes:** couriers' scanners here read tracking numbers as Code 128.

## ADR-151 · Shops take payments online through their own gateway accounts, Safepay first, their credentials sealed for each account; an order waiting for its money offers to take it on its page, a session is recorded before the customer leaves for the gateway, and the gateway's signed return or webhook, whichever comes first, records it paid once and pays what the order owes of it; a sandbox's payments pay nothing

* **Context:** Shops take money ahead of shipping by bank transfer: a bank-transfer order waits
  for its total, and a cash-on-delivery order for the advance it asks for, until staff record it
  ([ADR-074](#adr-074--a-shop-that-gives-its-bank-account-offers-bank-transfer-the-order-waits-for-the-money-at-a-stage-of-its-own-and-keeps-the-account-its-customer-was-told-to-pay-into), [ADR-083](#adr-083--a-cash-on-delivery-order-may-ask-for-an-advance-paid-by-transfer-before-it-ships-it-waits-for-it-as-a-transfer-waits-for-its-money-and-staff-record-it-when-it-is-in)). Customers who would rather pay by card or
  wallet cannot, and staff check every transfer by hand (PAY-01, PAY-04). Money must reach the
  shop without passing through Hatti, which holds no licence to hold it ([ADR-009](#adr-009--merchant-owned-payment-accounts-first-partner-powered-payments-later)).
  Safepay is the first gateway on the shortlist (05 §4.5): its SDKs start a *tracker* for an
  amount, send the customer to its checkout page, send them back with the tracker signed with
  the merchant's secret key (HMAC-SHA256), and sign each webhook with a webhook secret
  (HMAC-SHA512 of the body, `X-SFPY-SIGNATURE`), a payment's saying it is `PAID` and how much.
  Its sandbox takes test cards and moves no money. Courier accounts already keep their
  credentials sealed for each account ([ADR-149](#adr-149--shops-book-orders-with-their-own-courier-accounts-their-credentials-sealed-for-each-account-each-booking-waits-in-postgres-until-the-worker-books-it-through-the-couriers-adapter-keeps-the-couriers-number-before-shipping-the-order-with-it-and-follows-the-parcel-by-asking-the-couriers-words-read-through-mappings-kept-as-data)).
* **Decision:**
  * **The shop connects its own gateway account** (`paymentGatewayAccountConnect`, owners and
    managers having signed in lately, as changing where money goes is sensitive
    ([ADR-103](#adr-103--sensitive-actions-need-staff-to-have-proved-who-they-are-in-the-last-15-minutes-by-signing-in-or-confirming-with-the-strongest-factor-their-account-has-apps-are-not-asked))): the credentials its dashboard gives, sealed for that account alone
    and never shown again, its last four characters for staff, in the gateway's sandbox or its real
    environment. One live account a gateway; an archived one takes no new payments, and payments
    started through it still count. Each account has a webhook address of its own,
    `/webhooks/payments/{id}`, to add in the gateway's dashboard (`payments.gateway_accounts`,
    migration 0095, in a new `@hatti/payments` module).
  * **Gateways sit behind one interface** (`PaymentGateway`: start a checkout, read a return,
    read a webhook), as couriers do. Safepay is the first; outside production, a test gateway takes
    nothing, its page being the return address signed.
  * **An order waiting for its money offers to take it online** on its page: what it waits for,
    the transfer's total or the advance, through the shop's oldest live account, beside the
    transfer's details. The orders module defines the port (`OnlinePayments`) and the payments
    module provides it, so orders' pages know nothing of gateways, and the payments module reads
    and pays orders only through the orders module's functions (`orderPaymentFactsIn`,
    `receiveOnlinePaymentIn`).
  * **A session is recorded before the customer leaves** (`payments.sessions`): the account, the
    order, the amount and the gateway's name for it (Safepay's tracker), or why the gateway would
    not start it. Asked again within half an hour for the same amount, the page sends the customer
    to the same checkout; an order starts 50 at most.
  * **The gateway's signed return or webhook, whichever comes first, records it paid**, once
    (`UPDATE … WHERE status = 'open'`), with how Hatti heard: the amount the webhook signed, or the
    session's own on a return, which signs the tracker alone. What the order owes of it is paid on
    the order as staff record a payment, "paid online through Safepay, reference …" on its
    timeline, by the system; anything beyond, on an order paid meanwhile or no longer open, goes
    on its timeline for the shop to give back.
  * **A sandbox's payments pay nothing.** Its session is recorded paid, the order's timeline says
    it was a test, and the page tells the customer the order still waits; the page names the
    gateway "(test)". Anyone who knows a sandbox's test cards could otherwise pay for goods with
    them.
* **Consequences:**
  * Customers pay what an order waits for by card or wallet from the link they already have, and
    the order moves on to packing without anyone checking a transfer.
  * The money settles to the shop's own account, and its fees are the shop's agreement with the
    gateway; Hatti never holds funds.
  * A payment whose return and webhook both go astray stays open until staff record it from the
    gateway's dashboard: there is no inquiry of the gateway yet, nor a daily reconciliation
    against its settlements (05 §4.2).
  * Not yet: checkout's own "pay online" method, so a shopper pays before the order is placed;
    a draft's link offering it once its order waits for an advance, as the order's own link
    does; refunds through the gateway (PAY-06); JazzCash, Easypaisa and other gateways'
    adapters; and a customer choosing among the shop's gateways.
* **Alternatives:**
  * **Hatti's own merchant account taking money for shops:** holding customers' funds needs a
    licence ADR-009 leaves for later.
  * **Trusting the return alone:** the webhook records payments when customers close the tab
    before coming back, and it signs the amount.
  * **Inquiring the gateway before marking paid, as 05 §4.2 sketches:** both signals are signed
    with secrets only the gateway and the shop hold; an inquiry, and reconciliation, come with
    the gateway APIs that document them reliably.
  * **Sandbox payments paying orders:** convenient for trying the flow out, and an open door for
    anyone with the sandbox's test cards.

## ADR-152 · Checkout offers paying online where the shop has a gateway: the order is placed to wait for its total, as a transfer's does, and its thank-you page sends the shopper to the shop's gateway, which sends them back to the checkout's address on the core

* **Context:** Shops take payments online through their own gateway accounts, from the page of
  an order waiting for its money ([ADR-151](#adr-151--shops-take-payments-online-through-their-own-gateway-accounts-safepay-first-their-credentials-sealed-for-each-account-an-order-waiting-for-its-money-offers-to-take-it-on-its-page-a-session-is-recorded-before-the-customer-leaves-for-the-gateway-and-the-gateways-signed-return-or-webhook-whichever-comes-first-records-it-paid-once-and-pays-what-the-order-owes-of-it-a-sandboxs-payments-pay-nothing)). Checkout itself offers cash on delivery
  and, where the shop gives its account, bank transfer ([ADR-044](#adr-044--checkout-is-one-page-the-core-renders-and-storefronts-serve-on-the-shops-address-placing-a-cash-on-delivery-order-as-the-page-showed-it),
  [ADR-074](#adr-074--a-shop-that-gives-its-bank-account-offers-bank-transfer-the-order-waits-for-the-money-at-a-stage-of-its-own-and-keeps-the-account-its-customer-was-told-to-pay-into)), and offers a transfer in place of cash on delivery when the law, the
  shop's rules or its risk score keep cash on delivery from an order ([ADR-058](#adr-058--no-order-collects-more-cash-on-delivery-than-the-law-allows-whoever-places-it-the-rest-is-paid-in-advance-or-the-order-is-not-placed),
  [ADR-075](#adr-075--a-shop-keeps-cash-on-delivery-to-the-orders-it-trusts-up-to-a-total-of-its-own-outside-cities-it-names-and-not-for-customers-who-refused-parcels-before-checkout-offers-transfer-instead), [ADR-099](#adr-099--an-order-paid-on-delivery-that-the-shops-risk-rules-score-at-its-limit-or-above-is-not-taken-at-checkout-placed-scored-and-undone-its-page-asks-for-a-transfer-instead)). A shopper who would rather pay by card or wallet must
  place a transfer order and find its link. Checkout's pages send `form-action 'self'` in their
  content security policy, which browsers apply to the redirects after a form's post too, and
  storefronts refuse posts from other sites; Safepay sends the shopper back with a post or a
  redirect to the address the session gave it.
* **Decision:**
  * **Paying online is a payment method of its own**, `online` (`orders.payment_method`,
    migration 0096; `OrderPaymentMethod.ONLINE` in the Admin API). Its order waits at
    `AWAITING_PAYMENT` for its total, as a bank transfer's does: it needs no confirming, is not
    scored for risk, pays no cash-on-delivery fee, takes no transfer discount and asks no
    advance. Only a shop with a live gateway account taking its currency places one: the API
    refuses `ONLINE` otherwise (`INVALID` on `paymentMethod`), and a draft never takes it, since
    its order's own page takes payments online once it waits for them.
  * **Checkout offers it beside cash on delivery and transfer** where the shop's gateway takes
    the shop's currency: "Pay online, by card or wallet", saying the shopper pays through the
    gateway, named, once the order is placed. Where cash on delivery cannot take the order,
    paying online is offered in its place, as a transfer is, and the page chooses a transfer
    for the shopper's next post where the shop takes one. The gateway's name is part of what the
    page showed (`shown`), so a gateway connected or archived since makes the page stale.
  * **The order is placed first and paid from its thank-you page.** The page offers to pay what
    the order waits for, the same button and words as the order's own page (shared by the orders
    module); its post (`action=pay`) records a session for the amount
    ([ADR-151](#adr-151--shops-take-payments-online-through-their-own-gateway-accounts-safepay-first-their-credentials-sealed-for-each-account-an-order-waiting-for-its-money-offers-to-take-it-on-its-page-a-session-is-recorded-before-the-customer-leaves-for-the-gateway-and-the-gateways-signed-return-or-webhook-whichever-comes-first-records-it-paid-once-and-pays-what-the-order-owes-of-it-a-sandboxs-payments-pay-nothing)) and answers with a 303 to the gateway's page. A storefront relays it
    (`{ placed: false, redirect }`) and sends no referrer, so the checkout's secret stays
    off the gateway's logs. The page's policy names the gateway's checkout among its form
    targets.
  * **The gateway sends the shopper back to the checkout's address on the core**
    (`/checkouts/{secret}/paid` on the public site), whichever address the page was on,
    since its post comes from another site. The return is read as on the order's page: its
    signature checked, recorded once, paying the order. A paid return answers with a 303 to the
    thank-you page (`?paid`), which says the payment is in; otherwise the page says the payment
    waits to hear from the gateway, or was a test. Giving up at the gateway returns to the
    thank-you page, which still offers to pay.
* **Consequences:**
  * Shoppers pay by card or wallet as they check out, and the order goes on to packing once
    the gateway says it is paid, without anyone checking a transfer.
  * An order placed to be paid online keeps its stock while it waits, as a transfer's does: one
    never paid waits at `AWAITING_PAYMENT` until staff cancel it, or the shopper does from its
    page. Its page and its link offer to pay it whenever they come back.
  * After paying, the shopper finishes on the core's address rather than the shop's, as the
    order's own link is.
  * Not yet: paying before the order is placed; cancelling an order never paid after a time;
    a choice among the shop's gateways; refunds through the gateway (PAY-06).
* **Alternatives:**
  * **Paying before placing, as Shopify's checkout does:** the cart and its stock would be held
    across the gateway, and the return or the webhook would place the order, a second way to
    place one, for a payment whose cart may have changed meanwhile.
  * **The gateway returning to the storefront:** a storefront refuses posts from other sites,
    which keeps other sites from placing orders in a shopper's name; the core's address has no
    cart to protect, and the return is signed.
  * **Paying online through a transfer order's page alone:** works without checkout knowing of
    gateways, but leaves the shopper to find the order's link and offers no way in where cash on
    delivery is refused and the shop gives no account.

## ADR-153 · Money paid online goes back through the gateway that took it, as far as its adapter can give it back, Safepay a payment whole: each refund is recorded before the gateway is asked and written on its order once the gateway says it is sent; a refusal is said, and a refund without an answer holds its amount until staff settle it from the gateway's dashboard

* **Context:** Refunds are records of money staff sent back by hand, with how and a reference,
  owners and managers alone making them ([ADR-029](#adr-029--refunds-record-money-staff-sent-back-only-owners-and-managers-make-them)). Orders paid online went through the
  shop's own gateway ([ADR-151](#adr-151--shops-take-payments-online-through-their-own-gateway-accounts-safepay-first-their-credentials-sealed-for-each-account-an-order-waiting-for-its-money-offers-to-take-it-on-its-page-a-session-is-recorded-before-the-customer-leaves-for-the-gateway-and-the-gateways-signed-return-or-webhook-whichever-comes-first-records-it-paid-once-and-pays-what-the-order-owes-of-it-a-sandboxs-payments-pay-nothing), [ADR-152](#adr-152--checkout-offers-paying-online-where-the-shop-has-a-gateway-the-order-is-placed-to-wait-for-its-total-as-a-transfers-does-and-its-thank-you-page-sends-the-shopper-to-the-shops-gateway-which-sends-them-back-to-the-checkouts-address-on-the-core)), which can send money back to the
  card or wallet that paid, without asking the customer for an account. PAY-06 asks for refunds
  through the gateway's API where it has one, and by hand with proof otherwise. Safepay's own
  SDKs ask it for a refund with `POST /order/payments/v3/{tracker}/refund`, the merchant's secret
  key in `X-SFPY-MERCHANT-SECRET`, and its v3 API takes amounts in the currency's smallest unit;
  the refund's body and answer are documented in its API reference alone, which could not be
  read while building this. A call to a gateway may time out after the gateway acted.
* **Decision:**
  * **`orderRefund` takes a method of its own, `ONLINE`:** Hatti asks the gateway the customer
    paid through to send it back, on the latest of the order's payments online that can take
    it, never a sandbox's, and writes it on the order as any refund, by `online`, with the
    gateway's reference (the payment's tracker when the gateway gives none), its note and who
    asked. A reference of the caller's is refused. Owners and managers alone, with an
    Idempotency-Key, as every refund.
  * **Each gateway's adapter says what of a payment it gives back** (`PaymentGateway.refunds`):
    nothing, a payment whole, or any part. **Safepay gives a payment back whole:** asked for all
    of it, in paisa as its v3 API takes amounts, so that however it reads the amount it gives
    back the payment or refuses; part of one is given back in its dashboard and recorded by
    hand. The test gateway gives back any part.
  * **Recorded before the gateway is asked** (`payments.refunds`, migration 0097), with the order
    locked, so that two refunds never give the same money back twice: pending refunds, and those
    without an answer, hold what they asked for. The gateway is called outside the transaction.
    Given back, the refund is written on its order through the orders module's function
    (`refundOnlinePaymentIn`), at most what was paid on it and not refunded yet, anything beyond,
    as when a refund by hand came meanwhile, on its timeline. Refused (a 4xx, or the gateway never
    reached): recorded with why, nothing on the order, and the reason said. No answer (a timeout,
    a 5xx, a connection lost after sending): `unknown`, holding its amount, and the caller told to
    check the gateway's dashboard.
  * **Staff settle a refund without an answer** (`paymentRefundSettle`) as the gateway's dashboard
    shows it: given back, which writes it on the order with the dashboard's reference, or not,
    which frees its amount. Only one left unknown, or pending past five minutes; audited.
* **Consequences:**
  * A payment online goes back to the card or wallet that paid it in one step, recorded on the
    order as staff record any refund, and on the payment it came from (`paymentSessions`).
  * Safepay's partial refunds, as for a few items returned, stay in its dashboard, recorded by
    hand. Its call follows its SDKs and its v3 API's amounts, not yet tried against its sandbox
    (spike 4): asking for a whole payment means a misread amount gives back the payment or
    nothing, never another amount.
  * Proof of a refund by hand stays its reference and note; a receipt's picture comes with the
    admin app's uploads.
  * Not yet: hearing of refunds from gateways' webhooks, asking a gateway what became of one,
    giving back what was paid beyond what an order owed, and JazzCash's and Easypaisa's
    refunds.
* **Alternatives:**
  * **Partial refunds through Safepay, in paisa:** right if Safepay reads amounts so, and a wrong
    amount given back if it does not; a whole payment cannot go wrong either way.
  * **No calls to Safepay until its refund API is tried against its sandbox:** leaves every refund
    of a payment online to its dashboard and a record by hand, as before.
  * **Retrying a refund without an answer by itself:** a whole one asked again is refused if the
    first went through, but a part could be given back twice; staff settle it from the dashboard.
  * **Re-authentication for refunds online ([ADR-103](#adr-103--sensitive-actions-need-staff-to-have-proved-who-they-are-in-the-last-15-minutes-by-signing-in-or-confirming-with-the-strongest-factor-their-account-has-apps-are-not-asked)):** the money goes back only to the
    card or wallet that paid, not wherever staff say; owners and managers alone refund, each with
    an Idempotency-Key.

## ADR-154 · Shops pay Hatti for a plan in rupees, by the month or the year, through Hatti's own payment gateway account: a bigger plan begins once its invoice is paid, less what is left of the period it cuts short, a smaller one when the period ends; each period is invoiced a week ahead and a week unpaid puts the shop on Free; other modules ask each plan's limits through a port

* **Context:** Shops pay Hatti in rupees for a plan (BIL-01): Free, Starter at Rs 2,499 a month,
  Growth at Rs 6,999 and Pro at Rs 17,999, a year at ten months' price, Enterprise agreed apart;
  plans differ in the staff and locations they have room for, Free in orders a month too
  (docs/product/03-pricing-and-business-model.md). Platform billing belongs to the control plane
  (01 §3), which is one database with the cells' for now. Payments online already have gateway
  adapters, a session recorded before the redirect, and a signed return or webhook paying once
  ([ADR-151](#adr-151--shops-take-payments-online-through-their-own-gateway-accounts-safepay-first-their-credentials-sealed-for-each-account-an-order-waiting-for-its-money-offers-to-take-it-on-its-page-a-session-is-recorded-before-the-customer-leaves-for-the-gateway-and-the-gateways-signed-return-or-webhook-whichever-comes-first-records-it-paid-once-and-pays-what-the-order-owes-of-it-a-sandboxs-payments-pay-nothing)). There is no admin app yet: staff use the Admin API.
* **Decision:**
  * **Plans are the billing module's constants** (`PLANS`), and a shop without a subscription is
    on Free (`billing.subscriptions`, migration 0098, in a new `@hatti/billing` module).
  * **The owner alone chooses the plan** (`billingPlanChange`), having signed in lately, as it
    spends the shop's money ([ADR-103](#adr-103--sensitive-actions-need-staff-to-have-proved-who-they-are-in-the-last-15-minutes-by-signing-in-or-confirming-with-the-strongest-factor-their-account-has-apps-are-not-asked)); owners and managers see it, and apps with
    `read_settings`. A bigger plan, or any from Free, is invoiced now and begins once paid, less
    what was left of the current period at its price, in whole rupees; a yearly plan stays yearly
    until its year ends, so what is left is always less. A smaller plan, or Free, begins when the
    period ends; choosing the current plan again drops it. Each choice is audited, and the
    invoice waiting gives way to a new choice.
  * **Invoices are numbered across Hatti** (`HB-000123`), one open at a time, and paid through
    Hatti's own gateway account (`BILLING_SAFEPAY_*`; the test gateway outside production; none in
    production without it), as orders are paid: each try recorded first (`billing.payments`),
    then Hatti's signed return to the invoice's page (`/billing/invoices/<id>/paid`) or its
    webhook (`/webhooks/billing`), whichever comes first, pays it once. A payment that comes for
    an invoice set aside meanwhile still pays it: the shop paid.
  * **The worker renews:** a paid period's next is invoiced a week before it ends, and paid early
    follows on from its end; a smaller plan chosen for later is invoiced once the period ends, so
    paying it never cuts the bigger one short. A period that ended with Free chosen, or a week
    unpaid, puts the shop on Free; its invoice stays open, and paid later begins the plan again.
  * **Other modules ask a plan's limits through a port** (`PlanAllowance` in `@hatti/api`, which
    the billing module provides): staff, members and invitations waiting together, and locations,
    each refused past the limit with the plan named. Nothing already there is taken away when a
    plan gets smaller.
* **Consequences:**
  * Hatti takes its revenue in rupees through a gateway shops know, with no bank transfer to
    check, and Free shops are held to what Free offers.
  * Not yet: provincial sales tax on services on invoices (BIL-02); JazzCash and Easypaisa
    auto-debit, Raast and bank transfer to Hatti; extra staff, locations and AI credits bought
    apart; telling owners an invoice waits or a plan lapsed, by email or WhatsApp; gating plans'
    other features; and Free's order limit, counted in its plan but not enforced.
* **Alternatives:**
  * **Proration on the next invoice, as card subscriptions do:** a credit now is the same money,
    simpler to read on one invoice.
  * **Smaller plans at once, refunding the rest:** money back costs Hatti and the shop more than a
    few days of the bigger plan.
  * **Holding Free shops to 50 orders a month at checkout:** it would cost them their customers'
    orders; how to hold the limit is a product decision.
  * **The control plane's own database:** there is one database for now; the `billing` schema,
    by shop under RLS, moves with the control plane when it moves out.

## ADR-155 · A shop's messages are paid from credit in rupees it buys from Hatti with an invoice of its own: each is charged as it is sent, at what it costs Hatti and Hatti's fee, in a ledger kept beside the balance; a message the credit cannot pay for waits and a code is not sent, and what WhatsApp could not deliver is given back

* **Context:** Messages to a shop's customers ([ADR-146](#adr-146--a-shops-customers-hear-of-their-orders-from-hattis-shared-whatsapp-number-or-by-sms-where-the-shop-saves-or-whatsapp-cannot-deliver-each-message-waits-in-postgres-queued-once-from-the-orders-events-until-the-worker-sends-it-and-whatsapps-webhook-follows-it-and-hears-customers-ask-to-stop)) cost Hatti money: Meta charges
  for each message it delivers, by its template's category, in dollars, and SMS gateways charge by
  the part. Most shops cannot pay Meta in dollars, so Hatti sells message credit in rupees (07
  §2.3, MSG-04, BIL-03) at the provider's cost and a published fee, 10% on WhatsApp and about 15%
  on SMS (docs/product/03-pricing-and-business-model.md). Shops already pay Hatti for plans
  through Hatti's own gateway account ([ADR-154](#adr-154--shops-pay-hatti-for-a-plan-in-rupees-by-the-month-or-the-year-through-hattis-own-payment-gateway-account-a-bigger-plan-begins-once-its-invoice-is-paid-less-what-is-left-of-the-period-it-cuts-short-a-smaller-one-when-the-period-ends-each-period-is-invoiced-a-week-ahead-and-a-week-unpaid-puts-the-shop-on-free-other-modules-ask-each-plans-limits-through-a-port)), and the worker records each message sent as it goes.
* **Decision:**
  * **Credit is bought with an invoice of its own** (`billingCreditsBuy`): Rs 500 to Rs 100,000
    in whole rupees, chosen by the owner alone, having signed in lately, and paid with
    `billingInvoicePay` as a plan is (migration 0099: an invoice's reason may be `credits`, with
    no plan or period). One waits at a time beside the plan's: credit chosen again sets the last
    aside, and choosing or renewing a plan never touches it. Paid, through the signed return or
    the webhook, once, its credit is the shop's.
  * **The credit is a balance kept beside its ledger** (`billing.wallets`,
    `billing.wallet_entries`): each entry, never changed after, says what it added or took and
    what the wallet held after it, written under a lock on the balance. A message is charged once
    and given back once, and an invoice adds its credit once. Hatti may give credit, saying why:
    the seed's shop has Rs 1,000.
  * **Prices are the billing module's constants** (`MESSAGE_RATES`, `MESSAGE_FEES`): what a
    message costs Hatti, WhatsApp's by Meta's category of its template at Rs 280 to the dollar
    (utility and authentication Rs 4.20, marketing Rs 13.25) and an SMS's by the part (Rs 1.50),
    with Hatti's fee on top, rounded up to the paisa: Rs 4.62, Rs 14.58, and Rs 1.73 a part.
    `billingMessagePrices` lists them. A rate changed is a deploy, and prices what is sent after
    it.
  * **Messaging asks through a port** (`MessageCharges`, which the messaging module defines and
    the billing module provides, as it does `PlanAllowance`): each template has Meta's category, a
    code's authentication and an order's news utility, and an SMS has the parts gateways count, 160
    characters in GSM's alphabet or 153 a part, and 70 or 67 a part in UCS-2, which Urdu needs. A
    message is charged in the transaction that records it sent, so none is sent unpaid or paid
    for twice.
  * **The worker sends what the credit pays for**, reading it once a round and spending it as it
    sends: a message it cannot pay for waits as one its channel could not take, tried again a
    minute on and doubling to an hour, for a day; a code, which works for ten minutes, fails at
    once, and the shopper asks for another once there is credit.
  * **What WhatsApp could not deliver is given back** when its webhook says so, as Meta charges
    only what it delivers; the SMS sent in its place is charged as itself.
  * **Credit may go below nothing** when two senders spend it at once: the next credit bought pays
    for that first.
* **Consequences:**
  * Shops pay for messages in rupees, each one's price known, with every message in their
    statement (`billingWalletEntries`); Hatti's margin on messaging is its fee.
  * A shop without credit sends no notifications: its customers' news waits a day, and codes are
    not sent, so an order whose risk asks for one is paid another way meanwhile. A new shop has no
    credit until it buys some or Hatti gives it. `BillingInvoice.plan` and `interval` are null for
    credit.
  * Not yet: telling owners their credit runs low; credit for new shops to try messages with;
    topping up by itself from a saved card or wallet; sales tax on services on credit (BIL-02);
    replies in WhatsApp's 24-hour window, charged from 1 October 2026 past 1,000 a number a month;
    AI credits (BIL-03's other half). A WhatsApp message still undelivered when its SMS goes is
    paid for both, as WhatsApp may yet deliver it.
* **Alternatives:**
  * **Billing messages on the next invoice:** shops would owe Hatti, and Hatti would carry Meta's
    dollars for them; prepaid credit is what the product promised, and needs no collecting.
  * **Charging a message when it is queued:** what is skipped, refused or never sent would need
    giving back; charging it sent is exact.
  * **Holding a message's price when a sender takes it:** it would spare the rare overdraft at the
    cost of letting go of everything not sent; a little below nothing is simpler.
  * **Rates from the environment:** Meta changes them at the start of a quarter; a deploy is as
    quick, and keeps them reviewed with the code.
  * **Codes sent on credit:** a shop could run up debt without limit through codes; failing the
    code leaves checkout's other ways to pay.

## ADR-156 · Hatti's support looks at a shop only while its owner allows it, 15 minutes to a day: its agents, Hatti's own people signed in with a second factor, come as a caller of their own with every read scope, numbers masked, change nothing, and each of their requests goes on the shop's audit log before it runs

* **Context:** Support helps a merchant best by seeing what they see (ADM-08), and 11 §2.2 sets
  the terms: the merchant's consent in the app, for a while (for example 60 minutes), read-only by
  default, and shown in the shop's activity log. Staff sign in through the identity module and act
  in a shop by their membership's role
  ([ADR-020](#adr-020--staff-identity-built-in-house-on-audited-primitives)), and the shop's
  audit log records what it may need to account for
  ([ADR-027](#adr-027--customers-numbers-are-masked-by-role-and-reveals-go-to-an-append-only-audit-log)).
  Hatti has no console of its own for its people yet.
* **Decision:**
  * **Hatti's agents are identity accounts Hatti marks** (`identity.support_agents`, migration
    0100), with a command whoever runs Hatti runs (`support-agent add|remove <email>`), never
    through the Admin API. They sign in as staff do, and look at nothing without a second factor.
  * **The owner alone lets support look** (`supportAccessGrant`), having signed in lately, for 15
    minutes to a day, an hour unless said, with a note of what it is for; a new grant ends the one
    open, the owner or a manager ends it at any time (`supportAccessEnd`), and each is audited.
    `supportAccess` and `supportAccessGrants` show it to owners and managers
    (`identity.support_grants`, one open a shop).
  * **An agent comes as staff do**, with their session and the shop's header: the access check
    (`identity.resolve_staff_access`) finds the owner's grant open now for an agent who does not
    work in the shop, and the caller is Hatti's support, a kind of its own (`support`) with every
    read scope and no write. Someone who works in the shop is its staff there. An agent finds the
    shops open to them at `GET /auth/support/shops`.
  * **Support changes nothing:** before anything runs, a request of theirs that is not one query
    is refused (`SUPPORT_READ_ONLY`), and the resolvers' guard refuses their mutations however
    they come. Customers' numbers are masked, as most staff see them, and what owners or managers
    alone may see stays theirs.
  * **Every look is logged:** each query goes on the shop's audit log before it runs
    (`support.looked`), as support, with its grant, its name and the fields it asked for, which
    the shop's `auditLog` shows.
* **Consequences:**
  * Merchants get help with what they see without sharing a password, for as long as they choose,
    and see each look; Hatti's people never change anything in a shop.
  * Not yet: write access the owner chooses (a grant's `access` is `read` alone); Hatti's own
    console with single sign-on and hardware keys, and alerts on each grant (11 §2.2); telling the
    owner by email or WhatsApp while support looks; break-glass access without consent.
  * The audit log takes an entry for each of support's requests, which its volume allows.
* **Alternatives:**
  * **Support invited as staff:** it would hold a role's writes until someone removed it; a grant
    ends by itself.
  * **Signing in as the owner:** what support did would read as the owner's doing, and it could
    change anything.
  * **Logging after the query:** a failure between the read and the log would hide a look; logged
    first, a query refused later is logged too, which errs the right way.
