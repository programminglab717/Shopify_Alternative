# Engineering progress log

> Newest first. Every change that lands on the branch gets an entry, and so does the work in
> progress. The current state of each roadmap deliverable is on
> [Phase 0 status](./phase-0-status.md); this log records how it got there and what was learned.

## In progress

**Storefronts show each shop's own theme.** The publisher writes the main theme's files as a
document, and its version in the shop's; the storefront lays them over Hatti Base, keeping a
copy per shop and version, and leaves out a file it cannot use. The seed gives the demo shop a
home page of its own.

## 2026-09-30

### 4dd8922 · Online store themes

* **A shop's theme is a platform theme with the shop's own JSON files over it**
  ([ADR-039](../architecture/13-decision-log.md#adr-039--a-shops-theme-is-a-platform-theme-with-the-shops-own-json-files-over-it)):
  its templates, alternates such as `product.unstitched` included, section groups and
  `config/settings_data.json`. Liquid, assets and translations stay the platform theme's.
  **Migration `0023`** adds `online_store.themes` and `online_store.theme_files`.
* **`@hatti/online-store`**, a new module: `ThemeService` makes a shop's main theme on first use,
  prepares others (up to 20), copies of the main one if asked, publishes one in its place and
  deletes the rest. Files are saved all or none and checked for their shape: JSON, sections in
  their order, blocks, at most 25 sections, 50 blocks a section and 256 KB a file; the message
  says what is wrong. Every change raises the theme's version and records `theme.updated` or
  `theme.published`.
* **The Admin API follows Shopify's**: `themes`, `theme` with its `files`, `themeCreate` (which
  takes an idempotency key), `themePublish`, `themeDelete`, `themeFilesUpsert` and
  `themeFilesDelete`, under the new `read_themes` and `write_themes` scopes, which owners and
  managers have. Themes' IDs start `thm_`.
* 611 tests, directly and through PgBouncer.

### 84e1bab · Order links that last

* **An order's link now works until 30 days after the order is closed or cancelled**
  ([ADR-038](../architecture/13-decision-log.md#adr-038--an-orders-link-lasts-until-30-days-after-the-order-ends)),
  instead of 72 hours: one link sent when the order is placed follows the parcel however long it
  takes. `expiresInHours` still makes one expire sooner, and even that one stops 30 days after
  the order ends. Confirming, cancelling and correcting the address keep their own windows.
  **Migration `0022`** lets a link have no expiry of its own; `orderLinkExpiry` works out when
  it stops.
* **The Admin API gives an order's `customerLink`**, whose `expiresAt` is null while a lasting
  link's order is open, in place of `linkExpiresAt`. The timeline says the link works until 30
  days after the order ends.
* **The page asks the customer to keep the link**, in English and Urdu, where it would have
  said when the link stops working. Drafts' links keep their 72 hours.
* 601 tests, directly and through PgBouncer.

### 2f01f92 · Storefronts found by hostname

* **Every shop has a handle** naming its storefront on the platform's domain, `{handle}.hatti.pk`
  ([ADR-037](../architecture/13-decision-log.md#adr-037--every-shop-has-a-handle-naming-its-storefront-on-the-platforms-domain-storefronts-find-shops-through-a-directory-in-valkey)).
  **Migration `0021`** adds `control.shops.handle`: a lowercase DNS label of up to 40
  characters, unique across the platform, and random (`shop-…`) for shops made without one,
  existing ones included. Request code may now only rename its shop; its handle, status, currency
  and time zone are the control plane's.
* **One storefront serves every shop.** The server reads the handle from the request's host and
  finds the shop in `ShopDirectory`, a hash of shops by handle in Valkey, remembering each answer
  for five seconds; `localhost` itself serves the sample shop, and hosts no shop has get a 404.
  `createStorefrontServer` holds what `serve.ts` did, so tests can call it. Browsers and curl send
  `*.localhost` to the machine, so `http://{handle}.localhost:4100/` works with nothing set up.
* **The publisher keeps the directory** as it writes the shop's settings: open shops answer at
  their handle, suspended and closed ones stop. Documents carry `DOCUMENTS_VERSION`, and a shop
  whose documents are of an older shape is published whole on its next event, so documents
  gaining a field reach every shop.
* **The Admin API gives a shop's handle and storefront address** (`shop { handle url }`), from
  `StorefrontSite` and `STOREFRONT_URL`, which production requires, as it does `PUBLIC_URL`.
* **The seed** gives its shop a handle (`hatti-demo-bazaar-…`) and prints its storefront's
  address; `STOREFRONT_SHOP_ID` is gone.
* Checked on the development database: the seed's shop at its subdomain in curl and in Chromium
  at phone width; an older shop, published before handles, answering at its new one after a
  product edit through the API had the worker publish it again.
* 600 tests, directly and through PgBouncer.

### 56f3760 · Storefront documents in Valkey

* **The storefront renders from documents in Valkey**
  ([ADR-036](../architecture/13-decision-log.md#adr-036--one-publisher-per-shop-rebuilds-storefront-documents-from-the-database-its-writes-fenced-by-its-lock)):
  one per active product, with its options, images, and each variant's price and whether it can
  be sold online; one per collection, its active products' IDs in its order; `/collections/all`,
  newest first, unless a collection has that handle; the default menus; and the shop.
  `@hatti/storefront-data` has their shapes and keys, and `RedisStore`, which reads each in one
  round trip: a product or collection by its handle through a script, a list's products with one
  `MGET`.
* **The worker publishes them** (`apps/core/src/storefront`). Catalog and stock events mark items
  stale in a sorted set per shop. One publisher per shop at a time, holding the shop's lock in
  Valkey, rebuilds them from the database 100 at a time, products before the listings naming
  them; others add their items and return, so a burst of edits is built about once. A failed
  batch is put back; a stalled publisher's batch is taken over, and its writes, scripts that check
  the lock first, are refused.
* **Handles are indexes of their own.** A document lets go of its old handle only if the handle
  still leads to it, so products that swap handles keep the right ones.
* **What an event makes stale** (`itemsFor`): a product edit rebuilds the product and, unless only
  its description, handle or images changed, the collections holding it, the smart collections,
  `/collections/all` and the menus. A deleted product rebuilds every listing; stock rebuilds its
  product; a location that starts or stops selling online rebuilds every product. A shop without
  documents gets all of them on its next event.
* **Reads in the caller's transaction** for read models: `ProductService.recordsOf` and `idsOf`,
  `CollectionService.recordsOf` and `activeProductIdsOf` (sharing the listing's `ORDER BY` with
  the Admin API's pages), and `InventoryService.availableOf`.
* **The seed publishes its shop's storefront** and prints how to serve it,
  `STOREFRONT_SHOP_ID=… pnpm dev:storefront`; without a shop, `pnpm dev:storefront` serves the
  sample shop. A featured collection the shop does not have shows nothing.
* **Found on the way:** a page's section styles came in the order its sections finished, so the
  same data could render two different pages. They now come in the order sections start. The
  test rendering the same pages from Valkey and from memory found it.
* Checked on the development database: the seed's storefront in Chromium at phone width, its
  menu, its Footwear listed by price and its draft shawl answering 404. With the worker running,
  a product renamed through the API showed on the storefront about 220 ms later, and the worker
  first published 19 older shops from their waiting events.
* 589 tests, directly and through PgBouncer.

### 0353c42 · Spike 1: Liquid rendering

* **Outcome: go** ([report](./spikes/01-liquid-rendering.md),
  [ADR-035](../architecture/13-decision-log.md#adr-035--the-storefront-renders-liquid-with-limits-of-its-own-fetching-lists-a-chunk-at-a-time)).
  Pages of a Dawn-class theme render in 2 to 6 ms at p50 and under 10 ms at p95; one process
  renders about 260 a second.
* **`apps/storefront`**: `PageRenderer` renders JSON templates, sections with schemas and blocks,
  section groups and snippets with LiquidJS 10.29. It adds Shopify's `section`, `sections`,
  `schema`, `style`, `stylesheet`, `javascript`, `form` and `paginate` tags, and `money`,
  `image_url`, `image_tag`, `t` and other filters, with Hatti's `money_pk`, `whatsapp_url`,
  `direction` and `cod`. Objects are made from read models; lists fetch their products 12 at a
  time, when a template first touches one.
* **Limits per render**: 50,000 template nodes, 150 ms, 2 MB of output, LiquidJS's memory limit and
  snippets 32 deep, through a limiter of Hatti's that LiquidJS checks before every node (its own
  `templateLimit` is typed but not enforced). A section over one is left out and reported.
* **`themes/hatti-base`**: the reference theme, in English and Urdu. It has a banner, featured
  collections, a product page that adds to the cart without JavaScript, and a paginated
  collection page; also "Order on WhatsApp", cash on delivery, and logical CSS so Urdu mirrors.
* `pnpm bench:storefront` measures it; `pnpm --filter @hatti/storefront serve` serves the sample
  shop.
* Checked in Chromium at phone width. The product form overflowed, sized to its longest variant
  name, and English descriptions on Urdu pages moved their full stops; both fixed. The first
  benchmark found a snippet rendering itself ran out the clock, so snippets now have a depth
  limit.
* 574 tests, directly and through PgBouncer.

### 3aaa14f · Draft links before the address

* **A cash-on-delivery draft gets a link with or without an address**
  ([ADR-034](../architecture/13-decision-log.md#adr-034--customers-add-a-drafts-address-and-their-number-while-it-has-none-through-its-link)):
  without one, its page shows the order and asks for the address before it can be confirmed, and
  the link's message asks the customer to add it. A draft that loses its address keeps its link.
  **Migration `0020`** lets a draft without a number have one.
* **The order links' address form serves drafts too** (`?address`, `action=address`), and asks
  for the customer's mobile number while the draft has none, with a hint that the courier calls
  it. Once the draft has a number, the form shows it masked and it stays the shop's.
  `draft_order.updated` then says `byCustomer`.
* **Once a draft is placed, its link corrects the order's address** until it is packed, through
  `changeAddressLocked`, which the order links share.
* `DraftLinkView`'s completed view carries the digest and any problem, as the open one does;
  confirming a draft that has no address shows the page asking for it. A link can look like a
  button (`a.button`).
* The seed sends its first draft before the address and prints its link beside the others;
  `draftOrderLinkCreate` says what the page does now.
* Checked in Chromium at phone width: the page asking for the address, the form with the number,
  the saved page with "isb" spelled Islamabad, order #1014 placed from it, and that order's
  address form through the draft's link.
* 564 tests, directly and through PgBouncer.

### 349777f · Address corrections through order links

* **Until an order is packed, its customer can correct the address** on their link's page
  ([ADR-033](../architecture/13-decision-log.md#adr-033--customers-correct-an-orders-address-through-its-link-until-it-is-packed-the-number-stays-the-shops)):
  "Change the address" opens a form (`?address`) filled in as the address is, and saving it
  (`action=address`) changes the order as `orderUpdate` would, then redirects to the page saying
  so (`?saved`). The order is scored again for its new address and may be held for review; a
  confirmed order stays confirmed. The timeline says the customer changed it through their link.
* **Everything but the number:** the page shows it masked, as before, and a new number is for
  staff, since it would make the order another customer's.
* **An address that does not check out comes back as typed**, with what is wrong under each
  field in English and Urdu, and the page is sent with `422`. The province is left to the city
  unless it differs from the city's, so that a new city brings its own. A form posted after the
  shop changed the order is shown again, filled in afresh; once the order is packed or
  cancelled, the page says to ask the shop.
* `OrderService.updateLocked` runs `orderUpdate`'s change inside another transaction, as
  `confirmLocked` and `cancelLocked` do; `addressChangeable` says whether a customer may still
  change the address. The link service's actions now compare what the customer saw themselves,
  and `too_late` says which action came too late.
* Customers' pages gain form styles: boxes at least 44 pixels high with borders of 3:1 or more,
  errors in the danger colour, light and dark. Status pages show where the order goes before it
  ships.
* Checked in Chromium at phone width, light and dark: the form, its errors, and the saved page
  with the province worked out from the new city.
* 562 tests, directly and through PgBouncer.

## 2026-09-29

### 1fa6eac · Order links

* **`orderLinkCreate`** gives an open order's customer a link, as draft orders have
  ([ADR-032](../architecture/13-decision-log.md#adr-032--customers-confirm-or-cancel-cash-on-delivery-orders-through-a-link-that-then-follows-the-order)):
  once, with a WhatsApp link carrying it, working for 72 hours unless set otherwise, and
  replacing the order's previous link. `Order.linkExpiresAt` says whether one works. Making one
  goes on the timeline and is an `order.updated` event.
* **The page, `/o/<secret>`**: while a cash-on-delivery order waits for its customer, they
  confirm it, or cancel it after a question. Cancelling records the reason `customer` and the
  confirmation as `rejected`, and releases the stock; both say on the timeline that the customer
  did it through their link. After that the page follows the order: confirmed, on its way with
  the courier's tracking link, delivered, not delivered or cancelled.
* **A post carries a digest of what the page showed** (`shownDigest`), for drafts too, rather
  than the draft's version: notes, tags and new links no longer send a customer back to look
  again, and a change they could see still does. The digest is made with the number masked, so it
  gives nothing away.
* `OrderService.confirmLocked` and `cancelLocked` run inside another transaction, as
  `orderConfirm` and `orderCancel` do; the link pages share one module (`link-pages.ts`), and
  the links their helpers (`links.ts`).
* Erasing a customer's details takes their orders' links. **Migration `0019`**; the seed makes
  a link for its first order and prints it beside the draft's.
* Checked in Chromium at phone width: submitting a form without its button posted no action, so
  the action moved into a hidden field.
* 560 tests, directly and through PgBouncer.

### 11cb6d0 · Draft orders and confirmation links

* **Draft orders** hold an order taken in a chat before it is placed
  ([ADR-031](../architecture/13-decision-log.md#adr-031--draft-orders-keep-agreed-prices-and-hold-no-stock-customers-confirm-them-through-a-secret-link)):
  `draftOrderCreate`, `draftOrderUpdate`, `draftOrderDelete`, `draftOrder` and `draftOrders`.
  They are numbered #D1 onwards, keep each line at the price agreed, take the customer's address
  when it comes, and hold no stock. Their source says where the chat was: `WHATSAPP`,
  `INSTAGRAM`, `FACEBOOK`, `MANUAL` or `API`, new values of `OrderSource`.
* **`draftOrderComplete`** places a draft as `orderCreate` would, at its prices, through
  `OrderService.placeIn`, which `orderCreate` now runs too. An order that cannot be placed, such
  as for an item sold out, leaves the draft open.
* **`draftOrderLinkCreate`** returns a link for the customer, once, and a WhatsApp link carrying
  it, to the customer's number for callers who see numbers whole. It works for 72 hours unless
  set otherwise, only a digest of its secret is kept, and a new link replaces the old one.
* **The customer's page, `/d/<secret>`**, served by the core API: the items, total and address,
  in English and Urdu, their number masked. Confirming places the order, already confirmed, or
  waiting for review if the number is blocked or the order risky. The page runs no scripts, sends
  a content security policy with its styles' hash, is never cached, indexed or framed, and sends
  no referrer. A confirmation from a page that is out of date shows the change instead; an item
  that sold out is named.
* **`@hatti/documents`** renders pages for phones (`renderPage`), light or dark; `@hatti/api`
  has `PublicSite`, which the new `PUBLIC_URL` setting feeds (required in production).
* **Erasure** deletes the customer's drafts. Handlers taking part now get the customer's numbers
  and email, since drafts name no customer.
* **Migration `0018`**; the seed adds four drafts at different points and prints the link of the
  one waiting for its customer.
* Checked in Chromium at phone width: the fix for an Urdu sentence that moved a date's day to its
  far end is in `ltr()` around numbers, amounts and dates in Urdu sentences.
* 554 tests, directly and through PgBouncer.

### 96c0f27 · Order exports

* **`ordersExport`** gives up to 10,000 orders as CSV, oldest first: a row per order, with its
  items in one cell, its amounts, statuses, courier and dates, or a row per line item with
  `layout: LINE_ITEMS`. The file is UTF-8 with a byte-order mark so that Excel shows Urdu;
  amounts are in major units and times in the shop's time zone.
* **The list's filters**, now shared by the list and the export (`orderConditions`): the search
  query, stage, risk level, and new `placedFrom` and `placedBefore` dates, which `orders` takes
  too.
* **Who may export:** owners, managers and accountants, besides apps with `read_orders`. Numbers
  are masked as the caller sees them, so an accountant's file has them masked. Marketers are
  refused: the security design wants their exports approved, and approvals do not exist yet.
* Every row carries a watermark naming who exported it and when, and each export is an
  `orders.exported` audit entry and an `order_export.created` event.
* 540 tests, directly and through PgBouncer.

### 5915b53 · Idempotency keys

* **An `Idempotency-Key` header makes a retry safe**
  ([ADR-030](../architecture/13-decision-log.md#adr-030--idempotency-keys-are-kept-in-postgres-per-caller-for-a-day)).
  Before GraphQL runs, the Admin API claims the key in `platform.idempotency_keys` (migration
  `0017`) and keeps the answer for 24 hours; a retry with the same key and request gets that
  answer back, marked `Idempotent-Replayed: true`, and nothing runs again.
* **Required where running twice would do harm:** `orderCreate`, `orderFulfill`, `orderRefund`
  and `inventoryAdjustQuantities` answer `IDEMPOTENCY_KEY_REQUIRED` (400) without one. Resolvers
  declare it with `@RequireIdempotencyKey()` from `@hatti/api`. Any other mutation may send a
  key; queries ignore it.
* Keys belong to one shop and one caller. The same key with a different request is refused
  (`IDEMPOTENCY_KEY_REUSED`, 422), and a retry while the first request runs is told to wait
  (`IDEMPOTENCY_KEY_IN_USE`, 409); a request that dies frees its key after a minute.
* **Changed:** clients placing, shipping or refunding orders or adjusting stock must now send the
  header. The API tests' helpers send a new key with every request, as a client should.
* 535 tests, directly and through PgBouncer.

### 3620bfb · Refunds

* **`orderRefund(id, input)`** records money given back on an order, once staff have sent it:
  an amount up to what was paid and not refunded yet, the method (bank transfer, mobile wallet,
  cash or other), and an optional reference and note
  ([ADR-029](../architecture/13-decision-log.md#adr-029--refunds-record-money-staff-sent-back-only-owners-and-managers-make-them)).
  `Order.refunds` lists them, and `Order.amountRefunded` sits beside `amountPaid`, which refunds
  never lower.
* **The financial status follows** (`partially_refunded`, `refunded`), and nothing else moves: a
  completed order stays completed and closed. An order is now complete once delivered and paid
  in full, whatever was refunded since, rather than while its status reads `paid`.
* **Only owners and managers refund**, besides apps: confirmation agents and packers, who have
  `write_orders` too, get `ACCESS_DENIED`. Each refund is an `order.refunded` event, a timeline
  entry and an audit entry.
* What a customer has spent (`amountSpent`, the `amount_spent` segment field) now counts refunds
  out; invoices show them beside what was paid. Erasing a customer clears their refunds' notes
  and references and keeps the amounts.
* **Migration `0016`**; the seed refunds the delivery charge of the completed order from
  Peshawar.
* 527 tests, directly and through PgBouncer.

### 094687d · Packing slips and invoices

* **`orderDocument(ids, kind, paper, language)`** returns packing slips or invoices for up to 250
  orders as one HTML page, an order to a sheet, which the admin opens and prints from the
  browser: A4, 4×6 inch thermal labels or 80 mm rolls, in English, Urdu (right to left) or both,
  English first
  ([ADR-028](../architecture/13-decision-log.md#adr-028--printable-documents-are-html-pages-with-print-styles-pdfs-will-render-the-same-pages)).
  PDFs will come from the same pages through the documents service.
* **Packing slips** list what is left to ship and the cash to collect, and warn across the top
  when an order is cancelled, not confirmed yet or already shipped. **Invoices** show prices,
  the discount, delivery charges, what was paid and the balance due.
* **`@hatti/documents`**, a new platform package: `html` tagged templates that escape every
  value that is not markup already, English and Urdu wording, and the page for each paper.
* Customers' numbers print as the caller sees them, masked for most staff; an erased customer's
  orders print without their details.
* **Found on the way,** by rendering the seed's documents in Chromium with their fonts: in
  bilingual tables the Urdu headings sat against the wrong side of their columns, because a
  block of Urdu takes its start and end from right to left. And Nastaliq's tall line height
  spread every line of an Urdu slip, which pushed a 4×6 slip onto a second label. Urdu wording
  now sits in its own spans, and pages are set in Inter.
* `shopProfile()` in `@hatti/api` reads the shop's entry in the shop directory, for the `shop`
  query and for documents; the catalog exports `DEFAULT_VARIANT_TITLE`. The decision log's table
  gains the ADRs 025 to 027 it was missing.
* 521 tests, directly and through PgBouncer.

### ecdf4c7 · Packing and bulk order actions

* **To pack and To book:** the `to_fulfill` stage splits in two, as in the
  [pipeline](../design/02-information-architecture.md#1-the-merchants-mental-model).
  A confirmed or paid order waits under `to_pack`; `orderMarkPacked` stamps `Order.packedAt` and
  moves it to `to_book`, ready for a courier, and `orderMarkUnpacked` takes a mistake back.
  Shipping does not need the step, and once something has shipped an order can be neither packed
  nor unpacked. Migration `0015` moves existing `to_fulfill` orders to `to_pack`.
* **Breaking:** `OrderStage.TO_FULFILL` is gone, replaced by `TO_PACK` and `TO_BOOK`. No client
  uses the API yet.
* **Bulk actions (most of ORD-05):** `orderBulkConfirm`, `orderBulkCancel`,
  `orderBulkMarkPacked`, `orderBulkAddTags` and `orderBulkRemoveTags` take up to 250 IDs. Each
  order changes in its own transaction, exactly as the single action does, with its own timeline
  entry and event, so one that fails leaves the rest done. The payload lists the orders changed
  and a user error for each that failed, at `["ids", index]`. An ID given twice counts once, and
  tags match ignoring case. Printing comes with invoices and packing slips; booking with the
  courier adapters.
* **Found on the way:** `updateOrder()` worked out the stage before the time stamps it was asked
  to set, so a stamp that decides the stage, as `packedAt` now does, would have been missed.
* **Migration tests** get a helper: `createTestDatabase(server, { before: '0015' })` stops before
  a migration, so a test can insert the data that migration must handle. The 0013 test uses it
  too.
* The seed packs Fatima's order, which waits under To book.
* 509 tests, directly and through PgBouncer.

## 2026-09-28

### f8e79f8 · Masked numbers and the audit log

* **Numbers are masked by role:** owners, managers and apps see customers' numbers whole; every
  other staff role sees "0300 ••••567" on orders, addresses, customers, their other numbers, the
  blocklist and consent history. Packers were masked before; confirmation agents, marketers and
  accountants are now too.
* **`orderPhoneReveal` and `customerPhoneReveal`** give a confirmation agent the whole number
  when they call. Packers, marketers and accountants are refused (`ACCESS_DENIED`).
* **Whole numbers only** in customer and blocklist searches for staff who see numbers masked:
  matching four digits anywhere would have let them rebuild a number digit by digit.
* **The audit log** (`platform.audit_log`, migration `0014`): who did what to which customer,
  order or shop, written in the same transaction and append-only for request code. It records
  reveals, customer exports, merges, erasures and risk policy changes. Owners and managers read
  it with `auditLog` (`read_settings`)
  ([ADR-027](../architecture/13-decision-log.md#adr-027--customers-numbers-are-masked-by-role-and-reveals-go-to-an-append-only-audit-log)).
* `maskPkMobile` in `@hatti/pk`, `ROLE_PHONE_ACCESS` and `shownPhone` in `@hatti/api`, and an
  `aud_` public ID for audit entries.
* 504 tests, directly and through PgBouncer.

### 4706e64 · Merging customers and erasure

* **Several numbers per customer** (`Customer.otherPhones`, up to 10), such as a second SIM.
  Every number is a row of `customers.customer_phones`, so each belongs to one customer. Orders,
  searches, the blocklist's `customer` and the `blocked` segment field go by any of them;
  marketing consent stays with the main number.
* **`customerMerge(customerId, duplicateId)`** makes a duplicate's numbers, orders, tags, note and
  consent history the customer's and deletes the duplicate. The customer's own name and email
  win; the duplicate's fill gaps, an email with its consent. A later order from the duplicate's
  number finds the customer, and its refusals count towards their risk.
* **`customerErase(id)`**, at the customer's request: refused while any order of theirs is open;
  otherwise the profile, numbers and consent history go, and orders keep items, amounts,
  statuses, dates, city and province without the name, number, email, street or note
  (`Order.customerErasedAt`, an `erased` timeline entry). Their next order starts afresh.
* **Other modules take part through handlers** registered at start-up, as orders do; the
  customers module never touches their tables
  ([ADR-026](../architecture/13-decision-log.md#adr-026--a-customer-can-have-several-numbers-modules-with-customer-data-join-merges-and-erasure)).
  The consent ledger stays append-only for request code: two functions, limited to the caller's
  shop, move it on a merge and delete it on an erasure.
* **Changed:** the blocklist's hold message no longer includes the number, so timelines hold no
  contact details; `Order.phone` and the address's name, phone and first line are nullable, for
  erased orders.
* **Found on the way:** migration 0013 failed on the development database. Its backfill left
  deferred checks pending, which stopped the next change to the same table; the test databases
  are empty, so they passed. The backfill now runs with checks at once, and a migration test
  runs 0013 over existing customers; it fails on the old version.
* **Migration `0013`**; the seed merges an order from a customer's second SIM into her profile.
* 494 tests, directly and through PgBouncer.

### 4c97109 · COD risk rules

* **Cash-on-delivery orders are scored (COD-06, MVP)** for how likely they are to come back
  unpaid, from transparent rules: the customer's refusals, cancellations and deliveries in this
  shop, another unshipped order from the number in the last 6 hours, the order's value and size,
  and whether the address has a house number, is long enough and names a city couriers know.
  Prepaid orders are not scored.
* **`Order.risk`:** a score from 0 to 1, a level (`LOW`, `MEDIUM`, `HIGH`) and the reasons,
  strongest first, such as "Refused 2 deliveries from this shop". `orders(riskLevel:)` filters
  by level, and `order.created` events carry it.
* **Holds:** orders at the shop's threshold or above (0.6 by default) wait for review
  (`NEEDS_REVIEW`), with the score and what raised it on the timeline. An address change scores
  the order again, and holds it only if the change is what makes it risky, so staff who reviewed
  a risky order can still correct it.
* **The policy:** `orderRiskSettings` and `orderRiskSettingsUpdate` set the threshold (or none)
  and what counts as high value (Rs 15,000 by default). New `read_settings` and
  `write_settings` scopes, for owners and managers; each change is an
  `order_risk_settings.updated` event naming who made it.
* **Fairness:** no rule looks at which city an order is for; no address rule alone reaches the
  medium level; merchants see every reason.
* **The score is a snapshot** taken when the order is placed or re-addressed, kept with its
  reasons ([ADR-025](../architecture/13-decision-log.md#adr-025--order-risk-is-a-snapshot-taken-when-an-order-is-placed-or-re-addressed)).
* **Changed:** a refused parcel now counts as returned in a customer's delivery history and the
  `returned_orders` segment field from when it starts coming back, not only once it is checked
  in. Return to origin takes days, and a customer can order again meanwhile.
* **Migration `0012`**; the seed adds a large order from the customer who refused a parcel, to a
  vaguer address, which waits for review at risk 0.70.
* 482 tests, directly and through PgBouncer.

### 8b08f21 · Customer import and export

* **`customersImport` (CUS-07)** takes CSV: Hatti's own export, Shopify's customer export, or a
  spreadsheet with a Phone column.
  * Headings are matched ignoring case, spaces and underscores. Shopify's First and Last Name,
    Default Address Phone and Accepts Email/SMS Marketing columns work.
  * Rows that fail are reported by row and column, such as a US number, a bad email, the same
    number twice or email consent without an address; the rest go in, in one transaction.
  * Customers already here are left as they are unless the import overwrites them. `dryRun`
    counts what would happen.
  * Consent columns go into the consent ledger with the source `import`.
* **`customersExport`** gives everyone, a saved segment or a segment query as CSV, with consent
  and every labelled segment field: orders, amount spent, first and last order, delivered,
  returned and cancelled orders, city and province.
  * For owners and managers only (`write_customers`), as the role design asks.
  * Every row carries a watermark: who exported it and when.
  * Each export is recorded as a `customer_export.created` event. What Hatti exports, Hatti
    imports.
* **`@hatti/csv`**, a new platform package: RFC 4180 reading and writing, a byte-order mark so
  Excel shows Urdu, and cells a spreadsheet would run as formulas made safe.
* **Limits:** 5,000 rows per import, 10,000 customers per export.
* **Found on the way:** four `\uFEFF` escapes had become invisible characters in source files;
  they are escapes again.
* 467 tests, directly and through PgBouncer.

### 70d07dd · Marketing consent

* **Consent per channel (CUS-04):** WhatsApp, SMS and email are each `not_subscribed`,
  `subscribed` or `unsubscribed`, on the customer as `whatsappMarketingConsent`,
  `smsMarketingConsent` and `emailMarketingConsent`, with when the customer said so.
* **`customerMarketingConsentUpdate`** records changes for several channels at once, and
  `customerCreate` takes consent too. Subscribing needs the wording the customer agreed to. A
  change can say where it came from (staff, an app, an import, checkout or a reply) and when, if
  earlier.
* **The consent ledger** (`Customer.consentHistory`) keeps every change: state, wording, source,
  when, the number or address it was for, and who recorded it. It is append-only: request code
  can add to it, not change or delete it.
* **Consent belongs to a contact:** a new number resets WhatsApp and SMS consent, and a new or
  removed email resets email consent, each as a ledger entry.
* **Segments** filter by `whatsapp_subscription_status`, `sms_subscription_status` and
  `email_subscription_status`, as broadcasts will need.
* **Events:** `customer.marketing_consent_updated`, one per channel changed.
* **Migration `0011`**; the seed records consent for three customers and saves a "WhatsApp
  subscribers" segment.
* 452 tests, directly and through PgBouncer.

### 7698b9f · Segments

[ADR-024](../architecture/13-decision-log.md#adr-024--segments-are-queries-evaluated-on-demand-over-fields-modules-contribute)

* **Segments (CUS-03):** saved customer filters, like "bought 2+ times, in Lahore, no order in 60
  days". `segmentCreate`, `segmentUpdate`, `segmentDelete`, `segment` and `segments`, with each
  segment's `memberCount` and `members`, found when asked for. `segmentPreview` tries a query
  before it is saved, and `segmentFilters` lists the fields.
* **A query language close to Shopify's:** `number_of_orders >= 2 AND city IN (Lahore,
  Islamabad) AND last_order_date < -60d`.
  * `AND`, `OR`, `NOT` and parentheses; comparisons, `BETWEEN`, `IN` and `CONTAINS`.
  * Dates as days or days, weeks, months or years ago, counted in Pakistan time.
  * Amounts in the shop's currency, and cities and provinces written any common way (`lhr`,
    `KPK`).
  * Mistakes say what and where: `Unknown field "orders". Did you mean number_of_orders? (at
    character 1)`.
  * It compiles to one SQL statement; every value is a parameter.
* **Fields modules contribute:** customers have tags, when they were added, and whether they are
  blocked. The orders module registers orders, amount spent, first and last order, delivered,
  returned and cancelled orders, city and province, from the same query as a customer's stats.
  Consent and behaviour fields will register the same way.
* **Scopes:** `read_segments` and `write_segments`; members also need `read_customers`. Marketers
  build segments without being able to change customers.
* **Events:** `segment.created`, `segment.updated` and `segment.deleted`.
* **Migration `0010`** adds segments. The seed saves four.
* **Fixed on the way:** segments were labelled CUS-02 in the status page; the feature catalog
  calls them CUS-03 (CUS-02 is customer accounts with OTP login).
* 446 tests, directly and through PgBouncer.

### efdba8e · Customers and the blocklist

[ADR-023](../architecture/13-decision-log.md#adr-023--customer-order-stats-are-worked-out-from-orders-when-read)

* **Customers, phone first (CUS-01).** A customer is whoever a mobile number belongs to, one per
  number per shop (ADR-011).
  * Orders find or create their customer in the transaction that places them. A new number
    becomes a customer with the order's name and email; a known one keeps its profile.
  * An order whose number is corrected moves to that number's customer. Two orders placed at the
    same moment by a new number get one customer.
* **What a customer's orders add up to**, on `Customer`: `numberOfOrders`, `amountSpent`,
  `deliveryHistory` (delivered, returned, cancelled, in progress), `lastOrderAt`, `orders` and
  `addresses`. The orders module adds these fields and works them out from the orders when they
  are asked for, one query per page of customers, so there is no second copy to drift (ADR-023).
  `Order.customer` goes the other way.
* **`customerCreate`**, **`customerUpdate`**, `customer` and `customers`. Search takes a number in
  any format, its last four or more digits, or words of the name or email.
* **The merchant's blocklist (COD-07):**
  * `blocklistAdd` blocks a number with a reason (fake orders, refused deliveries, abuse, fraud,
    other) and a note; blocking it again replaces them. Also `blocklistRemove` and `blocklist`.
  * A number can be blocked before it is ever a customer.
  * Orders from a blocked number, or whose number changes to one, wait for review at the
    `NEEDS_REVIEW` stage, with the reason on their timeline. `orderConfirm` lets one go ahead.
* **Scopes:** `read_customers` and `write_customers`. Owners and managers edit customers and the
  blocklist, confirmation agents and marketers view them, and packers and accountants see
  neither. An order's customer needs `read_customers`; a customer's orders need `read_orders`.
* **Shared input checks:** `InputChecker` in `@hatti/api` now checks tags, email addresses and
  Pakistani mobile numbers, replacing copies in the catalog and orders modules.
* **`OrderAddress` is now `MailingAddress`**, as in Shopify, since customers have addresses too.
* **Events:** `customer.created` (from an order, or added by staff or an app), `customer.updated`,
  and `blocklist_entry.created`, `.updated` and `.deleted`. `order.created` carries the customer.
* **Migrations `0008` and `0009`** create the `customers` schema and give every order its
  customer, including orders placed before customers existed.
* **Seed:** blocks two numbers, has one customer order twice, and places an order from a blocked
  number, which waits for review.
* 426 tests, directly and through PgBouncer.

### 1a41535 · Parcels: shipping, delivery and return to origin

* **`orderFulfill`** ships items of a confirmed or prepaid order in one parcel: everything left to
  ship, or the lines listed. It takes them out of stock, and records a courier and tracking
  number. Cash-on-delivery orders are never shipped unconfirmed, and nothing ships twice.
* **`fulfillmentMarkDelivered`**, **`fulfillmentMarkReturning`** for a parcel refused or
  undeliverable, and **`fulfillmentReceiveReturn`** for checking it back in. Checking in says how
  many of each line go back on the shelf; the rest are written off as damaged. Also
  **`fulfillmentTrackingInfoUpdate`**.
* **Stages follow the parcels:** partly shipped, in transit, returning, delivered, returned and
  completed. An order closes once it is delivered and paid, or every parcel came back. A
  cash-on-delivery order that came back unpaid is voided.
* **`StockService.restock`** puts returned items back on hand, recorded in the ledger as a
  restock, with the order as its reference.
* **Search** finds an order by a parcel's tracking number.
* **Events:** `fulfillment.created` and `fulfillment.updated`, with the order's stage and version.
* **Migration `0007`** adds the parcels. The seed's orders now cover every stage: in transit,
  delivered and paid, and refused and checked back in.
* 398 tests, directly and through PgBouncer.

### 88521ad · Orders: placing, confirming, cancelling and paying

* **`orderCreate`**, for orders staff take from chats and orders apps send:
  * lines priced from the catalog, or at a price agreed in chat;
  * shipping charge, discount, and cash on delivery (with an optional advance) or prepaid;
  * a Pakistani address: the city spelled the standard way, the province from the city, and a
    mobile number the courier can call.
  Its stock is committed at its location in the same transaction, so an order exists only if
  its stock does. Short stock is an `OUT_OF_STOCK` user error, and nothing is written.
* **Order numbers** from #1001 per shop, without gaps: an order takes its number last in its
  transaction. A test places 8 orders for 5 units at once and gets #1001 to #1005.
* **`orderConfirm`**, **`orderCancel`** (which releases the stock, with a reason and a note),
  **`orderUpdate`** (address, email, note, tags) and **`orderMarkAsPaid`**.
* **Four statuses and one stage**, the state merchants see, stored so that `orders(stage:)` and
  `orderStageCounts` are index lookups.
* **Search** by order number, by mobile number in any format, or by words of the name, city or
  email.
* **A timeline** per order (`Order.events`), in words for staff; request code can only add to it.
* **Events:** `order.created`, `order.updated`, `order.confirmed`, `order.cancelled` and
  `order.paid`, each with the stage and version.
* **Packers** see customers' mobile numbers only partly, as the role design asks.
* **Scopes:** `read_orders` and `write_orders`. Confirmation agents and packers can work on
  orders; marketers and accountants view them.
* **Found on the way:** raw queries return timestamps as text, because Drizzle turns off the
  driver's date parsing, and the GraphQL `DateTime` type turns such text into `null`. So asking
  for a product's `createdAt`, or the time of a stock change, failed. Timestamps are now converted
  with `toDate()` from `@hatti/db`, and the API tests ask for them.
* **Migration `0006`** creates the `orders` schema. The seed places four orders, at different
  stages.
* 389 tests, directly and through PgBouncer.

### 07e2ea0 · Inventory: locations, stock levels and the stock ledger

[ADR-022](../architecture/13-decision-log.md#adr-022--stock-changes-lock-levels-in-one-order-check-then-write)

* **Locations:** `locationAdd`, `locationEdit`, `locationDeactivate`, `locationActivate`,
  `locationDelete`, `location` and `locations`.
  * The first location is primary. A shop gets one, "Main location", the first time it needs one.
  * Addresses are Pakistani: the province by code, name or alias, known cities spelled the
    standard way, five-digit postcodes, and mobile numbers stored in E.164.
  * Deactivating needs an empty location, and waits for sales in progress there. Only a location
    that never held stock can be deleted.
* **Stock levels** per variant and location: on hand, committed, reserved and safety stock, and
  available, which is on hand less the other three. What sells online is what is available at
  active locations that fulfil online orders.
* **Stock counts and adjustments:**
  * `inventorySetQuantities`, where a `compareQuantity` makes a count fail as `STALE` if the level
    changed since it was read;
  * `inventoryAdjustQuantities`, with a reason from a fixed list;
  * `inventoryItemUpdate`, for tracking and for selling on at zero.
  Every request applies fully or not at all, and recording stock starts tracking a variant.
* **The ledger:** each change is an adjustment (why, what caused it, who) with a movement per
  quantity it changed. Request code can only add to it. `InventoryItem.changes` pages through it.
* **`StockService`**, for checkout and orders, runs in their transaction: reserve, release,
  commit (also from a reservation), release a commitment, and fulfil. Short stock comes back as
  shortages; nothing is oversold.
* **One write path:** lock the levels in (variant, location) order, check, then write the levels,
  the adjustment and its movements in one statement, and an `inventory_level.updated` per level.
  Tests run 20 buyers against 5 units, orders listing two variants in opposite orders, and a
  deactivation racing a sale.
* **Stock on the catalog's types:**
  * `ProductVariant.inventoryItem`, `inventoryQuantity` and `availableForSale`;
  * `Product.totalInventory` and `tracksInventory`.
  They need `read_inventory`, and load through per-request batch loaders, so a page of products
  reads its stock with one query.
* **Platform:**
  * scopes `read_inventory`, `write_inventory`, `read_locations` and `write_locations`: owners
    and managers edit, other roles view;
  * `InputChecker`, `MutationResult` and `UserErrorsRollback`, shared from `@hatti/api`;
  * `RequestLoaders` for batching, and `appendEvents` for many events in one statement;
  * Postgres error checks in `@hatti/db`;
  * scope guards on field resolvers.
* **Migration `0005`** creates the `inventory` schema. The seed stocks a Lahore warehouse and a
  Karachi store that sells only over the counter.
* **Found on the way:** IDs that order a list must come from the application. `platform.uuidv7()`
  is random within a millisecond, so two ledger entries written in the same millisecond could
  have shown in the wrong order.
* 369 tests, directly and through PgBouncer.

### 34f4c7e · Catalog depth: options, bulk variants, images and collections

* **Options and variants:**
  * products take up to three options, and every combination of their values becomes a variant
    unless variants are listed;
  * `productOptionsCreate`, `productOptionUpdate` (rename, move, add, rename or delete values)
    and `productOptionsDelete`, which refuses to leave two variants the same;
  * variants gain cost (for profit) and weight in grams (for shipping rates).
* **`productVariantsBulkCreate`, `…Update` and `…Delete`:** one statement per batch, so two
  variants can swap values. Values a variant names but its option lacks are added.
* **Images by URL** (`productCreateMedia`, update, delete, reorder), shown per variant if chosen.
  Fetching and resizing them waits for the media worker.
* **Collections:**
  * manual collections, with add, remove and reorder;
  * smart collections, whose rules on title, type, vendor, tag, variant title, price, compare-at
    price, weight or price reduction are kept up to date in the same transaction as every product
    change;
  * seven sort orders, with keyset pages.
* **Also:** `productDelete`, `productByHandle`, `productTags`, `productTypes` and
  `productVendors`.
* **One-statement reads:** each product loads with its options, variants and media in one
  statement, following spike 5.
* **Migration `0004`** adds the tables. It gives products that had several variants a "Title"
  option, as Shopify does, so the new uniqueness rule holds on existing data.
* 325 tests.

### 2834a8c · Spike 5: row-level security and PgBouncer, go

[Results](./spikes/05-rls-and-pooling.md) ·
[ADR-021](../architecture/13-decision-log.md#adr-021--pgbouncer-transaction-pooling-with-no-session-state)

* **Benchmark:** `tools/db-bench` (`pnpm bench:db`) loads 1,000 shops, with 460k products and 820k
  variants, in 22 seconds. It measures the products listing with pgbench and with the
  application's own code, directly and through PgBouncer.
* **Row-level security** keeps every listing plan. Queries also filter by shop explicitly, so
  Postgres reduces the policy to one check per query. It costs about 0.1 ms per transaction,
  mostly in planning.
* **Leakproof operators:** under row-level security, `LIKE`, array and jsonb operators cannot use
  indexes or statistics. A trigram or tag GIN index goes unused, and queries take 2–3 times
  longer. Text search stays with Typesense.
* **PgBouncer:**
  * adds about 0.03 ms per round trip on the same host;
  * served 1,024 clients on 20 server connections, where direct connections failed at 128;
  * showed no shop setting leaking in more than 50,000 interleaved transactions, while a
    deliberate session-level setting was caught.
* **Fixed:**
  * the app could not connect through PgBouncer at all (timeouts sent as startup parameters);
  * the relay's `LISTEN` would have silently gone deaf behind a pooler (now
    `DATABASE_LISTEN_URL`, checked at start-up).
* **Tests:** CI runs every database test through PgBouncer.
* **Timeouts** now come from login defaults and per-transaction limits; the Admin API allows 5 s
  per statement.
* 284 tests.

### a3e23ee · Progress log

This log, backfilled to the first commit, and spike 5 marked as in progress.

## 2026-09-27

### b965280 · Tracing and metrics end to end

* `@hatti/telemetry` starts OpenTelemetry before the app (`node --import`). It is switched off
  unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
* One trace follows a request from the API through GraphQL and Postgres into the outbox, then on
  to the worker that processes the event (migration `0003` stores the trace context with each
  event).
* Spans carry `hatti.shop_id`, and log lines carry `trace_id` and `span_id`.
* Metrics: outbox lag, parked events, published and rejected events, relay outages, event
  handling time and sign-in results, plus the standard HTTP metrics.
* An end-to-end test starts the built API with a stand-in collector and checks what arrives.
* Local Grafana stack: `docker compose --profile observability up -d`.
* 280 tests in total. CI green.

### 069df4d · Staff sign-in with two-step verification and shop roles

* New packages: `@hatti/crypto` (secret encryption with key rotation, TOTP), `@hatti/ratelimit`
  and `@hatti/identity`.
* Migration `0002` adds the identity schema with its own database login.
* Passwords use argon2id and are checked against Have I Been Pwned. Two-step verification uses an
  authenticator app, with recovery codes; a code cannot be used twice.
* Sessions: 15-minute access tokens and rotating refresh tokens with reuse detection. Staff can
  list their devices and sign any of them out.
* Rate limits on sign-in, sign-up and code attempts.
* Six role presets. Owners, managers and accountants must use two-step verification.
* The Admin API accepts staff (a bearer token plus `x-hatti-shop-id`) as well as apps.
* [ADR-020](../architecture/13-decision-log.md#adr-020--staff-identity-built-in-house-on-audited-primitives)
  records why we built this ourselves.

### abdd0a3 · One bad event no longer blocks the outbox relay

A batch the queue rejects is now retried one event at a time. An event that keeps failing while
others get through is parked after 10 attempts, with its last error, for someone to inspect. A
queue outage never counts against an event's attempts.

### 2a0cf4f · CI on every branch

CI runs on pushes to every branch, not only `main`.

### 58c2992 · Phase 0 foundation and the first vertical slice

* **Monorepo:** pnpm workspaces with a version catalog, Turborepo, TypeScript (ESM), ESLint,
  Prettier and GitHub Actions CI against real Postgres and Valkey.
* **Platform packages:** ids, money, Pakistan data (phones, CNIC, IBAN, cities, Urdu and Roman
  Urdu search keys), config, logger, design tokens, db, events and api.
* **Data layer:** migration `0001` creates the database roles, per-shop RLS, the shop directory,
  access tokens, products and variants, and the transactional outbox with its relay.
* **First vertical slice:** an Admin API request creates a product under RLS, and its event
  reaches a worker through the outbox.
* **Docs:** conventions, getting started and Phase 0 status.

### f49e79f · Research, product, design and architecture plan

* Market research, a Shopify benchmark and the local ecosystem.
* Product vision, feature catalog, pricing and roadmap.
* Design principles, the design system, information architecture and key user flows.
* Thirteen architecture documents with a decision log, plus the executive summary.
