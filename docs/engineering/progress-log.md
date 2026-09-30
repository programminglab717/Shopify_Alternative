# Engineering progress log

> Newest first. Every change that lands on the branch gets an entry, and so does the work in
> progress. The current state of each roadmap deliverable is on
> [Phase 0 status](./phase-0-status.md); this log records how it got there and what was learned.

## In progress

**The cart drawer** (CHK-22). Hatti Base's cart opening in a drawer when a product is added,
without leaving the page, through Shopify's Ajax cart with the sections it names rendered into
its answers, as Dawn's drawer asks.

## 2026-09-30

### Predictive search

* **Hatti Base's header suggests products as a shopper types**
  ([ADR-046](../architecture/13-decision-log.md#adr-046--storefront-search-asks-the-core-which-finds-products-in-postgres-as-the-admins-search-does-until-typesense)):
  its Search opens a box whose script asks, once typing pauses, for the theme's new
  predictive-search section, and shows up to four products with their prices and a search for
  all the words. The arrow keys choose and Enter goes, Escape closes it, and without scripts the
  box searches as a form. Tried in Chromium on the seeded shop, in English and Urdu.
* **Shopify's predictive search**: `/search/suggest.json` gives the products as Shopify's JSON
  does, amounts in rupees as "3200.00", and `/search/suggest?section_id=` renders a section of
  the theme's with `predictive_search`, reading `resources[type]`, `resources[limit]` and
  `resources[options][unavailable_products]` as Shopify does. Those that cannot be bought go last
  unless asked otherwise, so the storefront asks the core for twice as many as it shows.
* **A word still being typed is found by its start**: folding "kame" gives "kame", which is not
  in "kamiz", so the core's search takes `prefix=last` and matches the last word without a last
  vowel, which the rest of the word may fold away (`prefixKey` in `@hatti/pk`). The search page
  does the same for Shopify's `options[prefix]=last`, which Hatti Base's forms now send.
* **A section renders alone** (`PageRenderer.sections`), by its ID on the page or a file of the
  theme's by name, as Shopify's section rendering API does; the Ajax cart's sections, for the
  drawer, come next.
* **An address may search 240 times a minute**, suggestions included; more are refused with a
  429, as text or Shopify's JSON.
* 757 tests pass through PgBouncer, as CI runs them.

### 8fcfcda · Storefront search

* **Every storefront has search**
  ([ADR-046](../architecture/13-decision-log.md#adr-046--storefront-search-asks-the-core-which-finds-products-in-postgres-as-the-admins-search-does-until-typesense)):
  `/search?q=` finds the shop's active products that have every word typed in their title,
  vendor, type or tags, matches in titles first. Hatti Base's new search page shows them 24 at a
  time, and its header links to it. Words fold as the admin's search folds them, so "kameez",
  "qameez" and "kamiz" all find the Shalwar Qameez.
* **The core finds them.** Storefronts ask `GET /storefront/shops/{shop}/search?q=` with their
  key, and the catalog's `searchIdsOf` answers with the IDs of up to 250 products, best first,
  from the `search_text` the admin's search matches. The storefront reads only the page it shows
  from the products' documents. When Typesense comes, it answers the same request.
* **Liquid has Shopify's `search`**: `performed`, `terms`, `results_count`, `results`, each with
  its `object_type`, and `types`. `{% paginate %}` now pages any list whose owner says how long
  it is, and its links keep the page's query, so a search's second page is of the same words;
  `default_pagination` escapes them.
* Measured with a warm cache on a development machine, a search reads a shop of 10,000 products
  in about 3 ms and one of 100,000 in 25 to 30 ms: `LIKE '%word%'` has no index to use.
* When the core cannot be reached, the search page says so with a 503, as the cart does.
* Predictive search, as a shopper types, comes next.
* 744 tests pass through PgBouncer, as CI runs them.

### 00221c4 · Theme strings and titles escaped on the storefront

* **The `t` filter escaped nothing**: a theme string filled with a product's title or the shop's
  name put it on the page as HTML, and Hatti Base's `<title>` printed `page_title` and the shop's
  name as they were. A product titled `</title><script>…` ran its script on its own page, and
  search, which prints what a shopper typed, would have made it a link anyone could send.
* **Now, as on Shopify**, a theme string is text, escaped, unless its key ends in `_html`, and
  what fills it is escaped either way; Hatti Base escapes the title. `whatsapp_url` reads its
  message back as text, so "Lawn & Silk" reaches WhatsApp as it is written.
* Found while building storefront search; a test renders a product and a shop with such names.
* 738 tests pass through PgBouncer, as CI runs them.

### 6ebd4a7 · Unreadable API requests answered as the client's to fix

* **A request body the Admin API could not read got HTTP 200 and `INTERNAL_SERVER_ERROR`**, and
  was logged as a server error with its stack: a body that is not JSON, or none, as seen while
  trying pages live. The error formatter took every error but a GraphQL one for a fault of the
  server's. Fastify's errors for requests it cannot read carry a 4xx status: they now answer
  with that status and `BAD_REQUEST`, and are not logged as errors.
* The status page's count of the core's tests, which 1446dfe left at 109, is right again.
* 737 tests pass through PgBouncer, as CI runs them.

### 1446dfe · Shops' pages

* **Shops keep pages of their own** ([ADR-045](../architecture/13-decision-log.md#adr-045--a-shops-pages-keep-html-cleaned-of-anything-that-runs-when-saved-the-storefront-shows-it-as-it-is)): About us, Contact, and how they deliver and
  take returns. **Migration `0029`** adds `online_store.pages`: a title, a handle made from it as
  the catalog makes handles (`about-us`), a body of HTML, whether it is published, and the
  theme's page template it asks for, such as `page.contact.json`.
* **A body is cleaned when it is saved**, with `sanitize-html`, a new dependency: text and its
  formatting, headings, lists, links, images and tables stay; scripts, style sheets, frames,
  forms, event handlers, IDs and classes go, and so do `javascript:` links however they are
  written. The API gives back the body as kept, which is what the storefront shows.
* **The Admin API follows Shopify's**: `pages`, `page`, `pageCreate`, `pageUpdate` and
  `pageDelete`, under the new `read_online_store_pages` and `write_online_store_pages` scopes,
  which owners, managers and marketers have, as the design's permissions give marketers the
  online store's content. Page IDs start `pg_`.
* **The storefront shows published pages** at `/pages/{handle}`, in Hatti Base's new `page`
  template, from documents the publisher writes by handle, as it does products'. Liquid has
  `page`, `pages['about-us']` and settings of type `page`, and a page that names another
  template gets it when the theme has one.
* **Menus link to pages** (`PAGE`), following their handles and leaving out pages hidden or
  deleted.
* The seed gives the demo shop four pages, linked from its footer; the sample shop's footer
  links lead to pages too.
* Tried live on a seeded shop: `/pages/about-us` in Hatti Base with the footer linking to the
  four pages; hiding "Contact us" through the API took it and its footer link off the storefront
  a moment later; a body saved with a script, a handler and a `javascript:` link was kept, and
  shown, without them.
* **Cash on delivery's rules and fee wait for online payment.** With cash on delivery the only
  way to pay, a COD fee is a delivery charge by another name, and a COD rule can only turn an
  order away. They come with the first gateway (PAY-01), when a shopper has another way to pay.
* 736 tests pass through PgBouncer, as CI runs them.

### 0e31dd0 · Cash-on-delivery checkout

* **Shoppers check out on one page** ([ADR-044](../architecture/13-decision-log.md#adr-044--checkout-is-one-page-the-core-renders-and-storefronts-serve-on-the-shops-address-placing-a-cash-on-delivery-order-as-the-page-showed-it)): the cart
  page's **Check out** button saves the cart's changes and starts a checkout, as `/checkout`
  does for themes' links. **Migration `0028`** adds `checkout.checkouts`: a secret of the
  checkout's own, of which the core keeps the SHA-256, the cart it checks out and the order it
  placed. A checkout lasts a day, and a shop's new ones sweep its expired ones.
* **The page is the core's, on the shop's address.** The core renders it as customers' links'
  pages are, in English and Urdu, without scripts: the cart at today's prices, with the
  properties shoppers see, what delivery costs (exact once the city is known, the shop's charges
  by city before), and the name, mobile number, city (suggested from Pakistan's cities), house and
  street, area or landmark, and province. The storefront serves it at `/checkouts/{secret}`,
  fetching it from the core for its own shop's checkouts only; the core serves it at its own
  address too.
* **Placing the order is one transaction, as the page showed it**: a digest of the lines, their
  prices, the note and the charges comes with the form, and nothing is placed when the cart or
  charges changed since, or something sold out; the page says so, keeping what was typed. The
  order goes through the orders module: cash on delivery from the online store, at the prices
  shown, the city's delivery charge added, stock committed, the customer found by number, and the
  blocklist and risk score applied, so it waits to be confirmed as any other. Lines' properties
  go in its note. The cart is emptied, and the storefront sets its count to 0.
* **Placing twice places one order**: a second post finds the order and shows it, and another
  checkout of the same cart finds it empty. The post redirects to the page, which then thanks the
  shopper, says what they pay on delivery and masks their number.
* Tried live on a seeded shop: a cart of two, checked out from the cart page to a Lahore address
  ("lhr"), became order #1014 at Lahore's charge, with the cart's note, and the cart and its count
  went to zero.
* 714 tests pass through PgBouncer, as CI runs them.

### ef31b68 · Delivery charges

* **Shops set what delivery costs** ([ADR-043](../architecture/13-decision-log.md#adr-043--a-shop-charges-for-delivery-once-for-everywhere-by-zones-of-cities-and-not-at-all-from-a-subtotal)): one charge for
  everywhere, zones of cities with charges of their own (the shop's own city, say), and a
  subtotal from which delivery is free. The checkout module keeps them (**migration `0027`**
  adds `checkout.delivery_settings`), and the Admin API has `deliverySettings` and
  `deliverySettingsUpdate`, under the settings scopes.
* **Zones name cities as addresses do**, "khi" and "Pindi" included, each city in one zone, and
  `deliveryCharge` is the one rule checkout will add: nothing from the free subtotal, else the
  city's zone's charge, else everywhere's.
* **Each change reaches the storefront**: `delivery_settings.updated` puts the charges in the
  shop's document (**`DOCUMENTS_VERSION` 5**), and Hatti Base's product pages say "Free delivery
  on orders of Rs 5,000 or more" or where delivery starts, and its cart page what is left to
  spend for free delivery.
* The seed gives the demo shop charges: Rs 250, Rs 150 in Lahore, and free from Rs 5,000.
* 685 tests pass through PgBouncer, as CI runs them.

### a6b1b52 · A timing test that a busy runner failed

* **"Gives each section its time, data it waits for included" failed in CI** (run 56): it gave
  sections 30 ms against data taking 40 ms, and the banner, which waits for nothing, went over,
  since sections rendered side by side share one thread and the runner was busier with the new
  packages' tests. It failed the same way on one busy CPU before the cart, so the test, not the
  cart, was at fault.
* The test now gives 200 ms against data taking 400 ms: sections that wait still run out of
  time, and the banner's own work fits many times over. On the same busy CPU it failed 3 runs in
  3 before, and passed 5 in 5, with the whole storefront suite 3 times, after.

### d02c6c0 · The storefront's cart

* **Shoppers fill carts and change them** ([ADR-042](../architecture/13-decision-log.md#adr-042--carts-are-kept-by-the-core-and-priced-whenever-they-are-read-storefronts-change-them-with-a-key-of-their-own)): the
  storefront serves `/cart` and Shopify's cart forms and Ajax cart (`/cart/add`, `/cart/change`,
  `/cart/update`, `/cart/clear` and `/cart.js`, as forms or JSON) over the core's carts. A form
  comes back to the cart page, a script gets Shopify's JSON, and a refusal, such as more than is
  left, is said in the page's language.
* **Hatti Base has a cart page**, in English and Urdu: each line with its image, variant and what
  the shopper typed, its quantity to change or remove, a warning when fewer are left than it
  has, a note for the shop, the subtotal, and the whole cart as an "Order on WhatsApp" message.
* **Pages stay the same for everyone.** The cart's secret is an `HttpOnly` cookie, and its count
  another, which the header's script shows on every page without a request. Cookies naming a
  cart the core no longer has are dropped.
* **`routes` follow the page's language**, so Urdu pages' forms post to `/ur/cart/add` and come
  back in Urdu.
* Changes from other sites are refused, and an address may make 120 a minute.
* Tried live on the seeded shop, with the core: adding from a product page, the cart page, the
  Ajax cart, a refusal, the Urdu page and removing a line, each as expected.
* 678 tests pass through PgBouncer, as CI runs them.

### cb2d64e · Carts in the core

* **The core keeps shoppers' carts** ([ADR-042](../architecture/13-decision-log.md#adr-042--carts-are-kept-by-the-core-and-priced-whenever-they-are-read-storefronts-change-them-with-a-key-of-their-own)), in a new
  checkout module: each cart's variants, quantities and what the shopper typed for each line,
  with its note and attributes. **Migration `0026`** adds `checkout.carts`.
* **A cart holds no prices.** Whenever it is read or changed, the catalog prices its variants
  and inventory says how many can be sold online, in the same transaction, so a cart shows
  today's prices and leaves out a product taken off sale.
* **Carts change as Shopify's do**, so themes' cart code works as it is: `add`, `change`,
  `update` and `clear`, lines added to by variant and properties, changed by key, variant or
  place. A change that would put more of a variant in the cart than can be sold is refused, with
  how many can; a line whose stock ran out after it was added stays, saying so, and can go down.
  A cart has at most 100 lines and 10,000 units a line, as an order.
* **A cart is found by a secret** from the shopper's cookie, of which the core keeps only the
  digest, and lasts 14 days after its last change. Concurrent changes to a cart take turns.
* **Storefronts change carts through the core's routes under `/storefront/`**, which answer only
  the platform's storefront key (`STOREFRONT_SERVICE_KEY`, required in production).
  `@hatti/storefront-api` holds what the two say, and the client storefronts use.
* Inventory gains `sellableOf`, how many of each variant can be sold online, for carts.
* 668 tests pass through PgBouncer, as CI runs them.

### eafd0dc · Theme Check for shops' files

* **When a shop saves a theme file, the core reads it over Hatti Base as the storefront would**
  ([ADR-039](../architecture/13-decision-log.md#adr-039--a-shops-theme-is-a-platform-theme-with-the-shops-own-json-files-over-it)),
  and refuses it with what is wrong: sections, blocks and settings the theme does not have,
  blocks over their limit, and settings whose values are not of their type, such as a colour
  that is not one or a link that could end the attribute it is printed in. Each problem is a
  user error on the file's body, its message starting with the file's name, and none of the
  files is saved.
* **How the storefront reads a theme is now `@hatti/themes`**, which Theme Check shares: loading
  a theme, laying a shop's files over the platform theme, and holding settings to their types.
  The core and the storefront cannot disagree about a file.
* The storefront still leaves out a file it cannot use, for files saved before the platform
  theme changed.
* 645 tests pass through PgBouncer, as CI runs them.

### 195613a · Pages stream, the head first

* **The storefront sends a page as it is written** (04 §3.3): the layout starts as soon as the
  shop, its theme and the page's product or collection are known, and its head goes with the
  styles of the sections the page will have, taken from its plan, before those sections have
  their data. The rest follows as they finish, over a chunked response. At 1 ms a round trip, the
  bench's new section F has a page's first bytes ready in 1.4 ms at p50, and its last in 5 to
  9 ms, as before.
* **The layout's waits for its sections no longer count against its time**
  (`WorkLimiter.waitFor`): each section has 150 ms of its own, and a layout waiting as long would
  have gone over its limit and failed the page.
* The page's state is set before any section starts, not after the layout's have. Whole-page
  renders, for tests and the bench, cost what they did.
* 641 tests pass through PgBouncer, as CI runs them.

### 9554e17 · Shops' WhatsApp number

* **A shop sets the WhatsApp number its "Order on WhatsApp" links and WhatsApp section go to**
  ([ADR-041](../architecture/13-decision-log.md#adr-041--what-a-shop-sets-for-its-storefront-as-a-whole-is-the-online-stores-starting-with-its-whatsapp-number)),
  the first of its storefront preferences, which the online store keeps. **Migration `0025`**
  adds `online_store.preferences`.
* **The number is a Pakistani mobile in any common format, kept in E.164**; blank takes it
  away. The Admin API has `onlineStorePreferences` and `onlineStorePreferencesUpdate`, under the
  settings scopes owners and managers have.
* **Each change records `online_store_preferences.updated`**, and the publisher writes the
  number into the shop's document, so product pages offer "Order on WhatsApp" with the product
  and variant in the message, and the home page's WhatsApp section shows.
* **The seed gives the demo shop a number**, so its storefront shows both.
* 639 tests pass through PgBouncer, as CI runs them.

### 6138cf8 · Shops' own menus

* **Shops keep their own menus**
  ([ADR-040](../architecture/13-decision-log.md#adr-040--a-shops-menus-are-kept-whole-linking-to-collections-and-products-by-id)),
  through an Admin API that follows Shopify's: `menus`, `menu`, `menuCreate`, `menuUpdate` and
  `menuDelete`, under the new `read_online_store_navigation` and
  `write_online_store_navigation` scopes, which owners and managers have. **Migration `0024`**
  adds `online_store.menus`; menus' IDs start `mnu_`, their items' `mni_`.
* **A menu's items are saved whole**, three levels deep, 250 and 200 KB at most, linking to the home
  page, all products, a collection, a product or an address. Links to collections and products
  keep their IDs and take their handles when read, so a new handle needs no menu edit. An
  address that could end the attribute a theme prints it in is refused, and the storefront
  leaves such links out too. Shopify's other kinds of link are refused until pages, blogs and
  search exist.
* **Every shop has a main menu and a footer menu**, made the first time it looks at its menus
  from what its storefront showed: its first five collections with products, then all
  products. Until then its storefront's menus still follow its collections.
* **The storefront gets menus with their nested links**, `link.links`, `link.levels` and
  `link.type` as in Liquid, leaving out links to what it cannot show, gone or not active. A
  shop's menus are one hash in Valkey, written whole, so a deleted menu goes; `menu.*` events
  and a product's new handle rebuild them. `DOCUMENTS_VERSION` is now 4, so shops published
  before get theirs on their next event; until then their storefronts show no menus.
* **The seed gives the demo shop a main menu of its own**: home, its Eid edit and footwear, and
  all products. In development, a `menuUpdate` showed on the storefront about 60 ms later.
* 634 tests pass through PgBouncer, as CI runs them.

### ef79f34 · A storefront warms up before it serves

* **The storefront renders a page of each template, in English and Urdu, before it listens**,
  from the sample shop's documents in memory. Its first visitors' pages no longer parse the
  theme or run the renderer's code for the first time within their sections' 150 ms: cold,
  the home page took 35 ms here where warm it takes 10, and far longer on a busy machine, as
  CI showed.
* A test spies on LiquidJS's parser: after start, the pages served parse nothing.
* 03 §8 now describes shops' theme documents, which the change before this one added.
* 620 tests pass through PgBouncer, as CI runs them.

### 105e553 · Storefronts show each shop's theme

* **Each shop's storefront is rendered in its main theme**: its own templates, section groups
  and settings over Hatti Base
  ([ADR-039](../architecture/13-decision-log.md#adr-039--a-shops-theme-is-a-platform-theme-with-the-shops-own-json-files-over-it)).
  The publisher writes the main theme's files as a document, then the shop's document, which
  names the theme's version, from one read. `theme.updated` for the main theme and
  `theme.published` rebuild both. `DOCUMENTS_VERSION` is now 3, so shops published before get
  theirs on their next event.
* **The storefront lays each version over Hatti Base once**, and keeps it per shop and version,
  up to 64 MB of shops' files; it fetches a theme's document only when the shop's names a
  version not at hand. A file it cannot use, such as a template naming a section Hatti Base
  lacks, is left out and logged, and Hatti Base's shows; the shop's other files still apply. In
  development, a change through `themeFilesUpsert` showed on the storefront about 50 ms later.
* **A shop's settings reach templates only as their types in Hatti Base's schema**: a colour, a
  number within its range, true or false, a link that is a path or a web, mail or phone
  address, an image at a path or an https address. Anything else gives way to the setting's
  default, and settings the schema lacks are dropped, since the theme prints colours and links
  as they are into styles and attributes. Section and block IDs may have only letters, digits,
  `_` and `-`: the core refuses others when a file is saved, and the storefront leaves out a
  file with one.
* A page's shop and theme, and its product or collection, are now fetched side by side and
  awaited together. Before, a shop whose documents were missing could leave a failed fetch
  unwatched while the page waited for another.
* **The seed gives the demo shop a home page of its own**, with its Eid edit and footwear, and
  an announcement of its own.
* 619 tests pass through PgBouncer, as CI runs them.

### f714975 · Storefront tests on a busy runner

* **Tests that compare whole pages now give each render time enough.** CI failed the Valkey
  rendering test: its first render, which also parses the theme, took a featured collection past
  the 150 ms a section may take while turbo ran every package's tests at once, and the page was
  compared with a later render that showed it. The storefront keeps its 150 ms; the tests that
  check pages rather than limits allow 10 s, and the limits test sets its own. Run on one busy
  CPU, the old test failed as in CI, and the new ones pass.
* A storefront's first pages after it starts parse the theme within their sections' time, so a
  busy machine could leave a section out of them: parsing the theme at start is on the status
  page's next steps.

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
