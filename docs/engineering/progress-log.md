# Engineering progress log

> Newest first. Every change that lands on the branch gets an entry, and so does the work in
> progress. The current state of each roadmap deliverable is on
> [Phase 0 status](./phase-0-status.md); this log records how it got there and what was learned.

## In progress

**Next, product types and vendors suggested, and a redirect changed in place, in the admin**
(CAT-01, OS-09): a product's type and vendor offered from those the shop already uses as they are
typed, and a redirect's path or target changed without deleting it; then section by section as the
alpha's shops need them.
Urdu handles wait, as decided.
Alerts for orders waiting too long are V1's confirmation policies (COD-05).
The rest of the merchant's tax profile and a series of invoices of their own are V1's (TAX-02,
TAX-05), and FBR's digital invoicing Growth's (TAX-04).
Checkout's own fields are V1's (CHK-14); TCS and Trax wait for their API documents, which come
with merchants' accounts; TikTok's and Google's conversions (MKT-10) are V1's; a message when a
delivery was tried is V1's failed-delivery rescue (COD-08).

## 2026-10-10

### What is left to put in Urdu, in the admin

* **In Urdu, kind by kind** ([ADR-340](../architecture/13-decision-log.md#adr-340--the-online-stores-in-urdu-tab-lists-the-shops-products-collections-pages-blogs-articles-menus-and-home-page-kind-by-kind-the-newest-first-each-with-how-much-of-its-own-words-is-in-urdu-and-how-much-is-out-of-date-at-first-only-what-is-left-each-opens-its-own-urdu-page)): the online store's In Urdu tab lists the shop's products,
  collections, pages, blogs, articles and menus, and its home page, the newest first, each with
  how much of its own words is in Urdu and how much was written for words since changed; at
  first only what is left to write or check, with how many are all in Urdu above; each opening
  its own Urdu page. Those who write the shop's Urdu see it: owners, managers and marketers.
* **Tried in Chromium against the core:** on the seed's shop, at a phone's width, each kind's
  count matched the core's own answer, none of the seed's in Urdu: 11 products, 4 collections,
  6 pages, 4 blogs, 4 articles, 2 menus and the home page. A test product, Ajrak Shawl Test, was
  given an Urdu title on its Urdu page and was then listed all in Urdu; its own title changed
  through the Admin API put it to check, and changed back cleared that; its Urdu taken away
  listed it not in Urdu again, as before. No errors in the browser.
* 2396 tests: what is left listed by kind with its badges, all of it shown when asked, a kind
  with nothing in it and one all in Urdu, each opening its Urdu page; more of a long list up to
  250; the tab kept from those who do not write Urdu; and only words of their own counted.

### 37fba00 · A gateway's credentials changed, and what changed the message credit, in the admin

* **A gateway's credentials** ([ADR-339](../architecture/13-decision-log.md#adr-339--a-gateway-accounts-credentials-are-changed-in-place-every-one-or-the-account-moved-between-its-test-environment-and-the-real-one-with-that-ones-credentials-once-the-member-confirms-who-they-are-and-the-billing-page-lists-what-changed-the-message-credit-the-newest-first-with-the-balance-after-each)): each of the shop's online payment accounts offers to
  change its credentials, every one its gateway asks for, which replace those it has once the
  member confirms who they are; the same form moves it between its test environment and the real
  one, saying first what that means. It keeps its webhook address and its place among the
  gateways.
* **What changed the credit:** under the message credit's balance on the billing page, credit
  bought or given by Hatti, each message paid for by its channel and kind, an SMS's parts, and a
  WhatsApp message's price given back, each with when and the balance after, the newest first:
  20, then up to 100.
* **Tried in Chromium against the core:** on the seed's shop, at a phone's width, the test
  gateway's account was moved to its test environment with a new secret, which the page and the
  core's row then showed, ending in 5678, and back to the real one with another, ending in 1234
  as the one before did; its secret is now the check's own, which the test gateway signs with as
  it would any. No confirmation was asked, as the owner had signed in minutes before. The billing
  page listed the latest 20 of the credit's 60 changes, WhatsApp messages at Rs 4.62 each with the
  balance after each, then all 60 down to the Rs 1,000 Hatti gave to try messages with. No errors
  in the browser.
* 2392 tests: a gateway's credentials changed once the owner confirms who they are and moved
  to its real environment after its warning, credentials the core refused said, and optional
  ones sent when given; the credit's changes listed, a message, one given back, an SMS in parts,
  credit bought and given, then more; and nothing yet.

### b136f57 · Online payments on an order's page, and what paying online takes off, in the admin

* **An order's payments online** ([ADR-338](../architecture/13-decision-log.md#adr-338--an-orders-page-lists-the-payments-its-customer-started-online-and-the-refunds-asked-of-their-gateway-and-owners-and-managers-settle-a-refund-whose-answer-never-came-as-the-gateways-dashboard-shows-it-what-paying-online-takes-off-is-set-beside-the-shops-gateways-in-the-fields-the-transfers-uses)): the money section lists the payments its customer
  started online, the latest first, with the gateway, a test one marked, what was asked and
  paid, how and the gateway's reference; one not finished, or that the gateway would not start,
  says so; what of a paid one the order did not take is said to be on its timeline to give back,
  and a test one paid nothing on it.
* **Refunds through the gateway:** each under its payment, given back with its reference,
  refused with why, being asked, or late; one whose answer never came, unknown or asked over
  five minutes before, is settled by owners and managers as the gateway's dashboard shows it:
  given back with its reference, which records the order's refund, or not, once they say they
  are sure, which frees what it held.
* **What paying online takes off:** set beside the shop's gateways once one is connected, or while
  something is taken off: nothing, a percentage up to a cap, or an amount, for orders placed
  from then on, in the bank transfer's fields, now shared by both pages.
* **Tried in Chromium against the core:** on the seed's shop, at a phone's width: 5% up to Rs 300
  saved for paying online and read back, 75% refused with the core's words, then nothing off
  again, as before. An order placed through the Admin API for Live Check, #1025, by bank
  transfer for Rs 1,850, tagged live-check, was paid from its link through the test gateway,
  which its page then showed with the gateway's reference; Rs 500 was refunded through the
  gateway, which gave it back at once. The test gateway answers every refund, so two whose
  answer never came, Rs 300 and Rs 200, were written into the database as unknown, asked 20
  minutes before: the first was settled as given back with a reference, which recorded the
  order's refund, the second as not, and the core's rows said so. The page was seen in Urdu
  too. #1025 was then cancelled with Rs 1,050 of its payment not given back: the test gateway
  takes no money. No errors in the browser.
* 2387 tests: an order's payments online, paid, open, failed, a test one's and one the order owed
  none of, with their refunds given back, refused, being asked and late; a refund settled as given
  back with its reference and one as not, once sure; settling kept from packers, and when an
  answer is late; and what paying online takes off saved, refused before sending, taken away, and
  not asked while no gateway is connected.

### 711efc8 · Payments recorded by hand, and an order's link made again, in the admin

* **What an order waits for** ([ADR-337](../architecture/13-decision-log.md#adr-337--an-order-waiting-for-its-money-says-on-its-page-what-it-waits-for-its-advance-or-its-transfer-and-shows-the-receipts-its-customer-sent-owners-and-managers-record-money-received-by-hand-what-it-waits-for-unless-they-say-otherwise-and-an-order-waiting-for-an-advance-is-not-marked-paid-in-full-and-those-who-speak-with-customers-make-a-new-link-for-the-order-shown-once-to-copy-or-send-on-whatsapp-the-one-before-stopping)): an order awaiting payment says what it waits for, its
  advance or its transfer, and shows the receipts its customer sent through their link, a
  picture small and opening whole, a PDF as a link.
* **A payment recorded by hand:** owners and managers record an amount received, what the order
  waits for unless they say otherwise, never more than it owes; an order waiting for its advance
  is not offered Mark as paid, which would leave the courier nothing to collect.
* **The customer's link:** the customer card says whether the order has a link and until when;
  owners, managers and confirmation agents make a new one, told first that the one before stops
  working, and it is shown once, to copy or send on WhatsApp.
* **Tried in Chromium against the core:** on the seed's shop, at a phone's width, two orders
  were placed through the Admin API for a customer not in the seed, Live Check, on
  +92 300 9876543, cash on delivery with an advance of Rs 500, tagged live-check: #1023 and
  #1024. Each page said it waited for its advance; a new link was made, copied and offered to
  WhatsApp at the customer's number; on #1024 the link was opened as the customer, who sent a
  receipt, which the order's page then showed. Recording the Rs 500 offered moved each order on
  to be packed, Rs 1,350 left to collect. Both were then cancelled. No errors in the browser.
* 2380 tests: an advance waited for with its receipts, recorded and moving the order on, without
  Mark as paid; part of a transfer recorded, more than it owes refused; a new link after its
  warning, shown once, copied and sent; links kept from packers; and what a transfer waits for.

### 6daaf59 · A booking that failed for its city, in the admin

* **Put right from the bookings list** ([ADR-336](../architecture/13-decision-log.md#adr-336--a-booking-that-failed-is-put-right-from-the-bookings-list-where-it-is-its-orders-latest-the-city-its-orders-address-writes-matched-against-the-couriers-names-where-the-courier-has-none-one-of-its-nearest-chosen-or-another-typed-kept-as-the-shops-own-and-the-order-booked-again-with-the-same-account-and-each-courier-accounts-own-names-listed-in-settings-looked-up-named-and-forgotten)): a failed booking that is its order's latest
  has Fix and book again. The admin asks for the order's city and how the courier knows it;
  where the courier has no name for it, its nearest names are offered, or another typed, which
  the core checks, and the name is kept as the shop's own before the order is booked again with
  the same account. Where it knows the city, the order is booked again as it is. An order
  without a city is sent to its page.
* **The shop's own names, in settings:** each courier account has City names: the names kept,
  the latest first, each forgotten when wrong, and a city looked up and named.
* **Tried in Chromium against the core:** on the seed's shop, at a phone's width, a failed
  booking was put in the database for #1016, to Peshawar, as the test courier, which has no list
  of cities, never fails one. Its fix said the test courier knows Peshawar as Peshawar, and Book
  again booked it: the core books orders confirmed but not yet packed, so #1016, which waited to
  be packed, is now in transit as HT1574386001. The list then showed the new booking above
  the failed one, which offered no fix, and the failed booking put in was deleted afterwards.
  In settings, Pindi was looked up (Rawalpindi, the city's usual name), named Rawalpindi
  Cantt, found again as the shop's own name when looked up as "pindi", and forgotten, leaving
  the shop's names as they were. No errors in the browser.
* 2374 tests: a failed booking's nearest names, one refused by the core and nothing booked, then
  one kept and the order booked again with its account; a city the courier knows booked again
  without a name; an order without a city sent to its page; no fix for a booking superseded;
  and an account's names listed, forgotten, looked up and named.

### 172a750 · Agents' performance, in the admin

* **A page of the desk's** ([ADR-335](../architecture/13-decision-log.md#adr-335--owners-and-managers-see-how-each-agent-of-the-confirmation-desk-did-on-a-page-of-the-desks-that-analytics-links-to-over-the-last-7-30-or-90-whole-days-the-orders-each-confirmed-and-cancelled-how-many-an-hour-on-the-desk-their-calls-that-settled-nothing-and-how-many-parcels-of-the-orders-they-confirmed-came-back-staff-by-name-those-who-left-as-former-staff-and-apps-by-the-end-of-their-token)): owners and managers open Agents' performance from the
  Confirmation Desk, or from analytics under COD health, and see each agent of the last 7, 30
  or 90 days: the orders they confirmed, with their share of those they decided, those they
  cancelled, how many an hour on the desk, how many parcels of the orders they confirmed came
  back, in red from 30%, and their calls that settled nothing. Staff by name, those who left as
  former staff, apps by the end of their token. Analytics' period tabs are shared with it.
* **Tried in Chromium against the core:** on the seed's shop, at a phone's width, the page
  showed what the Admin API's `confirmationAgents` gave for the same days, figure for figure:
  an app with 5 confirmed, 83% of those it decided, 3 of 4 parcels back and one on its way;
  the owner with 3 of 3 parcels back, from the orders an earlier check returned; and Sana Agent
  with one call not answered. It read the same over 7 days, and right to left in Urdu; the
  desk's and analytics' links led to it. No errors in the browser.
* 2367 tests: an owner's agents, each figure, a high share of returns in red, a parcel's count
  singular, former staff and an app by its token, and the days chosen; a manager taken there
  from the desk, told no one worked it; other staff told only owners and managers see it, the
  core not asked; and the desk's and analytics' links for owners and managers alone.

## 2026-10-09

### 814926d · A draft changed while it is open, in the admin

* **The form it was made with** ([ADR-334](../architecture/13-decision-log.md#adr-334--an-open-draft-is-changed-in-the-admin-on-the-form-it-was-made-with-started-from-the-draft-as-it-is-every-line-sent-at-its-price-and-every-charge-as-it-stands-so-an-emptied-one-is-cleared-and-the-address-only-if-it-changed-its-area-landmark-and-pin-kept)): an open draft's page has Change the draft, which opens
  the new draft's form at the draft as it is. Saved, every line goes at its price, so prices
  agreed in the chat stay; every charge as it stands, so an emptied one is cleared; and the
  address only if it changed, its area, landmark and pin kept, or taken away when unticked.
* **Tried in Chromium against the core:** on the seed's shop, draft #D2's form opened at its two
  lines and its delivery charge of Rs 200; the charge was made Rs 150 with a note, and the
  draft's page showed Rs 6,500, its items' Rs 6,350 as before. It was then changed back, Rs 200
  and no note, and the draft is as the seed made it. No errors in the browser.
* 2363 tests: a draft's lines and charges changed, each line at its price, an emptied charge
  as nothing, the address not sent; its city changed, its area, landmark and pin sent with it,
  and the address taken away; a refusal said by the form's field; and a placed draft left as it
  is.

### 7de2641 · Orders tagged and cancelled many at once, in the admin

* **The rest of ORD-05's bulk actions** ([ADR-333](../architecture/13-decision-log.md#adr-333--the-orders-list-tags-the-orders-chosen-on-any-tab-and-cancels-those-not-yet-shipped-for-one-reason-from-the-bar-that-confirms-packs-and-prints-them-for-those-who-change-orders-a-refusal-names-its-order)): those who change orders choose orders on any
  tab and tag them, a comma between each tag, or take tags off; on the tabs of orders not yet
  shipped, they cancel the orders chosen for one reason, with a note for each timeline. Confirm,
  Mark packed, Print, Tag and Cancel share the bar the orders chosen open, and a refusal names
  its order, for confirming and packing too.
* **Tried in Chromium against the core:** on the seed's shop, the orders tagged live-check were
  found by `tag:live-check`; two of them, the last check's returned order #1019 and a new order
  #1022 placed for this one, were chosen, the bar offering Tag alone there, and tagged checked,
  given twice in two cases and kept once; the tag was then taken off both. From the tab of
  orders to confirm, #1022 was cancelled as out of stock with a note, and is cancelled for
  INVENTORY. No errors in the browser.
* 2358 tests: tags added to the orders chosen on every order's tab, once each, and taken off
  one; orders to pack cancelled for a reason and a note, one refused named by its order; and
  neither offered to a marketer, who prints, nor any choosing to an accountant.

### 98555d0 · The shop's blocked numbers, in the admin

* **Blocked numbers under customers** ([ADR-332](../architecture/13-decision-log.md#adr-332--the-admin-lists-the-shops-blocked-numbers-for-owners-and-managers-the-latest-blocked-first-each-with-its-customer-why-and-since-when-found-by-four-or-more-of-a-numbers-digits-a-number-blocked-before-it-ever-orders-and-one-unblocked)): owners and managers see every number the shop
  blocked, the latest first, each with its customer linked, why and since when, and the shop's
  note; find one by four or more of its digits; block a number before it ever orders, as sellers
  warn each other of them, with why and a note; and unblock one, orders already held staying
  held.
* **Tried in Chromium against the core:** on the seed's shop, the page listed its two blocked
  numbers, Kamran's for prank orders and another for refused parcels, each with its note. A
  number too short was refused in the core's words; 0345 0000123 was then blocked for fake
  orders with a note, listed first, found by 0123, and unblocked, the list then as it was. No
  errors in the browser.
* 2352 tests: the numbers with why and since when in the shop's time zone, a customer's
  linked, and one unblocked; a number blocked before it orders, a refusal said; one found by its
  last digits, and none said; the page kept to owners and managers, the list not asked for.

### 4c13271 · Packing slips and invoices, in the admin

* **Printed as the core makes them** ([ADR-331](../architecture/13-decision-log.md#adr-331--the-admin-prints-packing-slips-and-invoices-as-the-core-makes-them-from-an-orders-page-and-for-the-orders-chosen-to-pack-or-to-book-at-once-the-document-paper-and-language-chosen-in-one-panel-and-kept-in-the-browser-for-the-next-print)): an order's page has Print beside its name, and
  the orders list's tabs to pack and to book let their orders be chosen and printed at once,
  beside Mark packed. One panel asks for a packing slip or an invoice, the paper, A4, a 4×6
  label printer or an 80 mm receipt printer, and the language, both, English or Urdu, and keeps
  the choice in the browser for the next print. The page opens in a tab of its own and prints
  once its fonts are in; a tab the browser blocks is said.
* **Tried in Chromium against the core:** on the seed's shop, the two orders to pack were chosen
  and printed: one tab of packing slips for both on A4, each in English with its Urdu, without
  prices. Order #1016's invoice was printed from its page on 80 mm paper, its items, total, what
  was paid and the balance in both languages, and the panel kept the invoice and the paper for
  next time. Printing reads and changes nothing. No errors in the browser.
* 2347 tests: an order's invoice on the paper and in the language chosen, the choice kept for
  the next print; the packing slips of the orders chosen to pack at once, beside Mark packed; and
  a tab the browser blocks said, the core not asked.

### 5b1489b · Orders shipped by hand, in the admin

* **A courier Hatti does not book with yet, or the shop's own rider** ([ADR-330](../architecture/13-decision-log.md#adr-330--the-admin-ships-an-order-by-hand-with-a-courier-hatti-does-not-book-with-yet-or-the-shops-own-rider-from-its-page-or-many-packed-orders-at-once-from-shipping-the-courier-named-once-and-each-parcels-tracking-number-beside-its-order)): a packed order's
  page, or a partly shipped one's, has Mark as shipped: the courier, offered from Pakistan's as
  it is typed, and the parcel's tracking number and link, any of them left out. From shipping,
  the packed orders chosen are marked shipped at once, the courier named once and each parcel's
  number beside its order, those refused named with the core's reason. The parcel is then
  followed on the order's page as a booked one is. Shipping by hand and correcting a parcel's
  tracking share one form.
* **Tried in Chromium against the core:** three orders of the seed's Sindhi Ajrak were placed
  through the Admin API for the check, confirmed and packed. From shipping, two were marked
  shipped at once with TCS, the first by its number and the second with none; the first order's
  page showed its parcel as TCS · 7712345678, in transit, with delivered, refused and the rest,
  and its timeline Shipped 1 item with TCS 7712345678. The third was marked shipped from its own
  page with Own rider and no number. Each parcel was then refused and checked back in, so the
  three orders ended returned; the Sindhi Ajrak's stock is not tracked in the seed, so none
  moved. They stay in the shop, tagged live-check, on the seed's customer of that number. No
  errors in the browser.
* 2343 tests: a packed order shipped by hand from its page, a part refused named and the
  number trimmed; the form offered where something is left to ship and to those who work orders,
  not before packing; and packed orders shipped at once from shipping without a courier account,
  each with its own number and key, one refused named.

### f348ae2 · Visits in the admin's analytics

* **The online store's visits beside its sales** ([ADR-329](../architecture/13-decision-log.md#adr-329--the-admins-analytics-show-the-online-stores-visits-beside-its-sales-who-is-on-it-now-asked-again-every-half-minute-and-the-periods-sessions-against-the-period-as-long-before-asked-in-one-document-with-how-far-they-went-towards-an-order)): the analytics page opens on who is on
  the store now, sessions that saw a page in the last five minutes, and today's sessions, those
  that added to the cart and those that ordered, asked again every half minute. Below its sales,
  the period's sessions and conversion rate against the period as long before, asked in the same
  document; how far the sessions went, each step's share of them; and sessions day by day. What a
  session is, and that orders taken on WhatsApp count in sales and not here, said beside them.
* **Tried in Chromium against the core, the storefront and the worker:** three shoppers on a
  phone's browser came to the seed's shop: one looked, one added the Multani Khussa to the cart,
  one went on to checkout. The admin's card said three were on the store now, three sessions
  today and two added to the cart; a minute later, once the worker kept the day's counts, the
  month's visits said three sessions, two of them added to the cart and one reached checkout, a
  conversion rate of 0.0%, and the day's bar three sessions. On a phone, in one column; in Urdu,
  right to left, its bars filling from the right. No errors in the browser.
* 2339 tests: the period's sessions and conversion rate against the period before, the steps
  each with its share, the day's bars, the periods asked for, weeks over 90 days; who is on the
  store now and today's counts, asked again after half a minute; and a period with no visits.

### 7474458 · Blogs, articles, menus and the home page in Urdu, in the admin

* **The rest of the shop's words in Urdu** ([ADR-328](../architecture/13-decision-log.md#adr-328--the-admins-urdu-page-serves-blogs-articles-menus-and-the-home-pages-words-too-a-menus-links-each-a-level-in-under-the-link-they-sit-under-the-home-pages-words-the-shops-own-and-a-menus-urdu-for-those-who-change-menus)): a blog's, an article's and a menu's pages,
  and the storefront's preferences beside the home page's words for search engines, say how much
  is in Urdu and open the same page of its Urdu as a product's: an article's text and summary
  written as a page's text is, a menu's links each by its own words, one under another a level in,
  and the home page's title and description, which the shop keeps itself. A menu's Urdu is for the
  owners and managers who change menus.
* **Tried in Chromium against the core and the storefront:** on the seed's shop, the main menu's
  card said it was not in Urdu yet; its page listed its five links, Chappals a level in under the
  Eid edit; Home was put in Urdu and saved, and the storefront's Urdu pages showed it in their
  header a moment later. The home page's title for search engines was put in Urdu from the
  storefront's preferences, and the Urdu home page's title showed it. Every box was then emptied
  and saved, and both showed the shop's own words again; the shop keeps no Urdu of either. No
  errors in the browser.
* 2334 tests: a menu's title and a link a level in put in Urdu, an article's text and summary
  as their blocks and its blog's title, the home page's words by the shop's own ID, and a menu's
  Urdu kept to those who change menus, its menus not even read for others.

### e22647e · Products, collections and pages in Urdu, in the admin

* **The shop's words in Urdu** ([ADR-327](../architecture/13-decision-log.md#adr-327--the-admin-puts-a-products-collections-or-pages-words-in-urdu-on-a-page-of-its-own-each-field-of-the-shops-own-above-its-urdu-and-a-products-options-and-values-with-it-read-in-one-ask-through-shopifys-translatableresourcesbyids-and-saved-as-its-translations)): a product's, collection's and page's own pages say how
  much of it is in Urdu and open a page of its Urdu: each field with words of the shop's above a
  box for its Urdu, written right to left in Nastaliq, a product's options and each of their
  values with it. Saved together as the shop's translations, for its words as they are now; a box
  emptied puts the shop's own words back on the Urdu pages. Urdu written for words since changed
  says so, and can be kept as still right. The core gains Shopify's `translatableResourcesByIds`,
  so a product and its options and values are read in one ask.
* **Tried in Chromium against the core and the storefront:** on the seed's shop, the Multani
  Khussa's card said it was not in Urdu yet; its title, its options Size and Colour and their values
  Gold and Silver were put in Urdu, saved, and its Urdu page on the storefront showed them a moment later,
  its English page as before, and the card then counted five of eight; on a phone, the page in
  one column. Every box was then emptied and saved, and the Urdu page showed the shop's own words
  again; the shop keeps no Urdu of the product. No errors in the browser.
* 2330 tests: the core giving things of any kinds by their IDs, in the order asked, a page at a
  time, another shop's left out, and refusing what may not be translated, more than 250, and a
  caller without the scope; the admin putting a product's description, option and value in Urdu,
  each for its digest, keeping an outdated title as still right and forgetting an emptied type,
  saying when the words changed while the Urdu was written, a collection's title and a page's text
  as its blocks, the card's count, and the page for those who write the shop's Urdu alone.

### 447b684 · Pictures of a theme's own

* **A theme's pictures from the phone** ([ADR-326](../architecture/13-decision-log.md#adr-326--a-themes-pictures-are-the-shops-own-files-uploaded-in-the-theme-editor-and-served-by-the-storefront-at-an-address-of-the-shops-own-while-one-of-its-themes-names-them-a-preview-shows-any-of-the-shops-pictures)): a picture setting in the theme editor, such
  as the banner's, takes a photo uploaded from the phone, kept among the shop's files, and shows
  it at once, in the editor and on the page beside it, before it is saved; its words for those
  who cannot see it are asked for beside it, and it can be taken away. The storefront serves it
  at `/theme-images/{file}/{name}` on the shop's own address, from the core, which gives a
  picture only while one of the shop's themes names it, and any of the shop's pictures to a
  preview.
* **Tried in Chromium against the core and the storefront:** on the seed's shop, a photo
  uploaded to the home page's banner showed in the editor at once and on the page in the preview,
  while its address gave shoppers nothing; its words typed in; saved, the address gave shoppers
  the photo, kept an hour, and the home page named it. The home page was then put back through
  the API, its files as before, after which the address gave nothing again, and the photos
  uploaded were deleted. No errors in the browser.
* 2321 tests: the core giving a picture no theme names only to a preview, giving it once a
  theme names it, and never another shop's, a PDF, an ID that is no file's or a storefront
  without its key; the storefront asking with the preview's mark and keeping the answer as long
  as it may; the storefront API's client; the editor uploading a picture, showing it from the
  phone, saving it with its words, and taking it away.

### 2dd08c3 · The theme editor's live preview

* **The page beside the editor** ([ADR-325](../architecture/13-decision-log.md#adr-325--the-theme-editors-preview-frames-the-storefront-beside-the-editor-and-shows-changes-as-they-are-made-the-pages-sections-following-the-editors-files-the-themes-settings-show-once-saved)): on a computer the storefront's page sits beside the
  theme editor, at full width or a phone's, and on a phone Edit and Preview are two tabs. Changes
  show there as they are made, before they are saved: the sections a change touches rendered
  again, and the page's sections moved, hidden and shown again as the editor has them, which the
  storefront's script now does from the files it is sent. A section opened in the editor is
  chosen in the page, and one tapped in the page opens in the editor. Each template opens a page
  of the shop's that shows it, and the editor follows the merchant through the preview. The
  theme's settings show once saved, as the preview says.
* **Tried in Chromium against the core and the storefront:** on the seed's shop, the home page
  framed in design mode with its eight sections; the Footwear section chosen in the page as it
  opened in the editor, its heading changed and shown on the page before saving, moved above the
  Eid edit, and the WhatsApp section hidden and shown again in its place; the announcement bar
  tapped in the page and opened in the editor; the Products page opening a product; the merchant
  going home through the page's own link, the editor following, the changes shown there too; the
  colour changed and the preview saying it shows once saved; discarded, the page as saved again;
  on a phone, the Edit and Preview tabs; in Urdu, right to left. A first run left a product's page
  before it said it was ready, and the editor then missed the way home: it now compares the page
  with the one it opened. A heading saved at the end, and the page, already as saved, was not
  opened again; the home page was then put back through the API, its files as before. No errors
  in the browser.
* 2317 tests: the page's sections put in a file's order, those hidden taken away, those shown
  again put back even where a group had none on the page, a section rendered again in its place,
  answers with their render's id, and the comment that starts each list in design mode; the
  editor's renders, choices both ways, a page for each template, following the merchant, the
  settings' note and the page opened again once saved, a failure and what the storefront left
  out, and only the page in the preview heard; sample pages, section IDs and what to render.

### b54d06c · The theme editor, in the admin

* **"Customise"** ([ADR-324](../architecture/13-decision-log.md#adr-324--the-admins-theme-editor-changes-a-pages-sections-and-blocks-and-the-themes-settings-in-place-kept-until-saved-together-as-theme-check-passes-them-pictures-wait-for-an-address-of-their-own)) on each theme opens its editor: a page of the storefront at a time,
  its sections from the header to the footer with their settings and blocks, hidden, moved or
  removed, and the theme's own settings, saved together as Theme Check passes them; a part the
  shop changed started again from the theme as it came. Pictures show as they are, to be
  changed once a theme's pictures have an address of their own.
* **Tried against the core:** on the seed's shop, its main theme's home page showed its header,
  banner, two featured collections, WhatsApp section and footer; the Footwear collection renamed,
  shown six at a time by its slider, moved above the Eid edit, and the WhatsApp section hidden,
  saved at once, and the storefront's home page then showed the new heading; a javascript: link
  refused in Theme Check's words; the theme's colour saved, then its settings started again and
  the shop's own file gone; in Urdu, the cards, sections and labels in Urdu, right to left. The
  rows first crowded the names out on a phone, so moving and removing went inside each open
  section. The home page was put back as it was through the API, its files as before. No
  errors in the browser.
* 2305 tests: a page's sections changed, moved, hidden and saved together; blocks added
  within their limits and removed; the theme's settings; a refusal, then the same saved; a part
  started again; a page without the groups its layout lacks; changes discarded; the themes tab's
  link; no editor for those who do not change themes; and the files' own rules.

### 057fa20 · The theme editor's data, in the core

* **`OnlineStoreTheme.editor(locale)`** ([ADR-323](../architecture/13-decision-log.md#adr-323--the-theme-editor-reads-a-theme-through-the-admin-api-the-platform-themes-settings-and-sections-their-words-in-english-or-urdu-through-shopifys-t-keys-and-every-json-file-the-shop-may-keep-as-the-storefront-reads-it)): the platform theme's settings and sections,
  their names and labels in the language asked for, and every JSON file the shop may keep in the
  theme as the storefront reads it, the shop's own with what Theme Check finds wrong with it.
  Hatti Base's names and labels are Shopify's `t:` keys now, with English and Urdu.
* **Tried against the core:** on the seed's shop, its main theme gave its groups of settings,
  رنگ among them in Urdu, its 18 sections, image-banner as تصویری بینر, and its 13 files, the
  home page and header group the shop's own, none with problems; 0.6 s the first time after the
  core started, then 19 ms.
* 2292 tests: Hatti Base's words in English and Urdu, every key with its words in both, a
  language it lacks in English, the default language for a missing word and defaults as written;
  the files as the storefront reads them, the shop's own over the platform theme's and one Theme
  Check no longer passes; and the field through the API, in Urdu and in English.

### 69f1d17 · A parcel's tracking corrected, in the admin

* **"Change tracking"** ([ADR-322](../architecture/13-decision-log.md#adr-322--the-admin-corrects-a-parcels-courier-tracking-number-and-link-on-its-orders-page-whatever-the-parcels-state-its-link-checked-as-https-before-it-is-sent)) on each parcel of an order's page, for those who work orders,
  in any state: its courier, number and https link set anew, the link checked as typed.
* **Tried against the core:** on the seed's shop, order #1014's parcel, Test courier
  HT2560410001, set to TCS 779012345679 with its tracking link; an http link held back; the
  parcel then linked to TCS's page, the core holding the same, and the timeline saying "Tracking
  set to TCS 779012345679". The parcel and its order were put back as they were. No errors in the
  browser.
* 2288 tests: the form starting from the parcel's tracking, an http link held back, a refusal
  named by its field, an empty courier cleared, and no form for those who only view orders.

### 16ea427 · The drafts list searched, in the admin

* **A search** ([ADR-321](../architecture/13-decision-log.md#adr-321--the-admin-searches-the-drafts-list-with-its-saved-searches-as-on-orders-and-products-and-shows-a-search-the-core-refuses-in-the-cores-words-at-once-without-trying-it-again)) on the drafts list, with its saved searches; a search the core refuses
  shown in its words at once, on every page, and not tried again.
* **Tried against the core:** on the seed's shop, its three open drafts narrowed by
  source:instagram to #D1; colour:red refused at first after seconds, as a lost connection, and
  now at once, in the core's words naming the filters; source:whatsapp saved as "WhatsApp
  drafts", which on the Placed tab found #D6 and #D3, and then deleted. No errors in the browser.
* 2286 tests: a saved search run, a search finding nothing, a filter refused in the core's
  words, and the search shown saved.

### 97e6d2f · The online store's themes, in the admin

* **Themes** ([ADR-320](../architecture/13-decision-log.md#adr-320--the-admin-lists-the-shops-themes-in-the-online-store-the-live-one-first-each-previewed-through-its-link-and-adds-a-copy-of-one-or-the-platform-theme-afresh-publishes-one-once-asked-and-deletes-those-not-live)), a tab of the online store: the live theme first, each previewed through
  its link; a copy of one, or the platform theme, added; one published once asked; those not
  live deleted.
* **Tried against the core:** on the seed's shop, a copy of its live Hatti Base was added under
  the same name, which the core allows, and another as "Eid check", each with the live theme's
  two files; "Eid check" was published, the storefront's theme with it, and Hatti Base
  published back; the two copies were then deleted, leaving the shop's one theme live. Two
  themes of one name looked the same, so each row now says when it was added. No errors in the
  browser.
* 2284 tests: the live theme first with each one's preview; a copy added after a refusal
  named, and one on the platform theme; one published once asked and another deleted; none of it
  for a marketer.

### 62f0d55 · The shop's domains, in the admin

* **Domains** ([ADR-319](../architecture/13-decision-log.md#adr-319--the-admin-connects-the-shops-own-domains-in-settings-saying-which-record-to-add-where-it-was-bought-checks-them-again-makes-a-connected-one-primary-or-not-and-lets-one-go-once-asked-the-hatti-address-is-always-shown)) in settings: the shop's own domains connected, with the record to add where
  each was bought, checked again, made primary or not, and let go; the Hatti address shown.
* **Tried against the core**, once the local servers ran again: on the seed's shop, on Pro,
  https://Shop.Hatti-Check.pk/ was connected as shop.hatti-check.pk and told to point a CNAME
  at the platform's host; checking it was refused, the core naming the record to add. Marked
  verified in the database for the check, it was made primary, the store's address following
  it, then primary no more and removed, leaving the shop with no domains. The store's address
  had shown with its http:// on the local servers; it is now shown without its scheme. No
  errors in the browser.
* 2277 tests: a domain connected and told where to point; a check refused with what the domain
  points at; one made primary no more; one let go once asked; a plan without domains told why.

### 8d54eb6 · Photos' descriptions, in the admin

* **Each photo** ([ADR-318](../architecture/13-decision-log.md#adr-318--the-admin-describes-each-product-photo-for-screen-readers-and-search-engines-from-a-pencil-on-its-tile-the-description-shown-beneath-it)) described from a pencil on its tile, for screen readers and search
  engines, the description shown beneath it.
* **Tried against the core:** on the seed's Ajrak Shawl Test, its second photo was described as
  a red and indigo shawl; the core kept it and the photo's alt said it; then its description was
  put back. No errors in the browser.
* 2269 tests: a photo described after a refusal named, its words trimmed and shown.

### a18fe86 · Stock rules, in the admin

* **Stock rules** ([ADR-317](../architecture/13-decision-log.md#adr-317--the-admin-sets-on-the-product-page-whether-each-variants-stock-is-counted-and-whether-it-keeps-selling-when-out-of-stock-each-change-saved-at-once-and-shown-at-once-put-back-if-the-core-refuses)) on the product page: each variant's stock counted or not, and kept
  selling when out of stock or not; each change saved and shown at once.
* **Tried against the core:** a kurta added in S, with stock counted, and M, without; S set to
  keep selling when out of stock, M counted and then no longer, its selling box going with it;
  the inventory items read back each time as chosen; then the kurta deleted. No errors in the
  browser.
* 2267 tests: a size kept selling; a refusal named and its box put back; a size no longer
  counted; a product sold as it is counted; none of it for a packer.

### 3b7d879 · Saved searches, in the admin

* **Saved searches** ([ADR-316](../architecture/13-decision-log.md#adr-316--the-admin-shows-the-saved-searches-of-the-orders-and-products-lists-above-them-each-run-in-a-tap-those-who-change-a-list-save-the-search-shown-by-a-name-and-rename-change-and-delete-those-saved-the-cores-refusals-named-by-their-field)) above the orders and products lists: each run in a tap; the
  search shown saved by a name; those saved renamed, changed and deleted by those who change the
  list.
* **Tried against the core:** on the seed's shop, a search by city was refused, as orders take no
  city filter, and its words shown; risk_level:high saved as "Risky orders" ran to the one risky
  order; its search changed to a colour was refused, then to payment_method:cash_on_delivery as
  "COD orders", and deleted; status:active saved on products and deleted. No saved search was
  left. No errors in the browser.
* 2263 tests: one run and cleared; the search shown saved after a refusal named; one renamed
  after a refusal named, one deleted; a marketer kept from saving and changing them.

### 1780593 · Invitations sent again and the shop handed over, in the admin

* **Send again** ([ADR-315](../architecture/13-decision-log.md#adr-315--the-admin-sends-an-emailed-invitation-still-waiting-again-showing-its-new-link-and-the-owner-hands-the-shop-to-one-of-its-managers-once-asked-the-cores-refusal-named-and-the-owners-own-role-read-again-after)) on an emailed invitation, its new link shown; **Hand the shop over**
  for the owner, to a manager once asked, the account's roles read again after.
* **Tried against the core:** on the seed's shop, the owner invited a packer by email and sent
  it again: Hatti emailed a new link and the first opened nothing more. With the shop's agent
  made a manager for the check, handing the shop to them was refused, as they have no second
  factor, and the owner stayed the owner. The agent's role and the invitations were then put
  back. No errors in the browser.
* 2255 tests: an emailed invitation sent again after the member confirmed who they are; the
  shop handed to a manager once asked, after a refusal named; an owner without managers told to
  make one first.

### adc364d · Courier pickups, in the admin

* **Pickups** ([ADR-314](../architecture/13-decision-log.md#adr-314--the-admin-asks-a-courier-whose-api-takes-pickups-to-collect-the-parcels-waiting-naming-its-rider-where-it-asks-and-lists-the-pickups-asked-for-with-their-parcels-the-couriers-number-or-load-sheet-and-why-one-was-refused-our-load-sheet-of-a-pickup-is-printed-for-the-rider)), a tab of shipping: a courier whose API takes pickups asked for a rider,
  its rider named where it asks; the pickups asked for listed with their parcels, the courier's
  number or load sheet, and why one was refused; our load sheet of a pickup printed.
* **Tried against the core:** on the seed's shop, its test courier account was asked for a
  pickup, which took five parcels with load sheet HTL000001; the load sheet printed those five
  with their cash; asking again, and the Karachi account, was refused as nothing waited. The
  pickup was then removed. No errors in the browser.
* 2250 tests: pickups listed, one's load sheet printed, one refused with why; a courier asked,
  refused, then another asked with its rider and its answer read again; a shop with no courier
  taking pickups told so.

### 8f05713 · A product's options and variants, in the admin

* **Options and variants** ([ADR-313](../architecture/13-decision-log.md#adr-313--the-admin-changes-a-products-options-and-variants-after-it-was-made-an-option-renamed-values-added-and-deleted-where-no-variant-uses-them-an-option-added-with-a-variant-for-every-new-combination-if-asked-or-taken-away-where-its-variants-stay-apart-variants-added-for-combinations-it-lacks-and-deleted-one-always-kept)) on the product page: options renamed, given values and
  values removed, added and taken away; variants added for combinations the product lacks and
  deleted, one kept. Each change is saved at once.
* **Tried against the core:** a kurta added in S and M; Size renamed Length and given L; M
  refused removal while variants used it; Colour added in Maroon and Black with every
  combination, making six variants; taking Colour away refused, as two variants would be the
  same; S / Black deleted and added again at Rs 3,400; then the kurta deleted. No errors in the
  browser.
* 2245 tests: an option renamed and given values, a value in use refused, an option added
  without new combinations and refused being taken away; a variant added and variants deleted
  down to the last; none of it for a packer.

### 7893e59 · Locations, in the admin

* **Locations** ([ADR-312](../architecture/13-decision-log.md#adr-312--the-admin-lists-the-shops-locations-in-settings-those-out-of-use-too-and-adds-one-with-its-address-and-the-number-couriers-call-for-pickups-changes-it-and-whether-it-fulfils-online-orders-takes-it-out-of-use-and-puts-it-back-and-deletes-one-that-never-held-stock-the-primary-one-stays)) in settings: the shop's warehouses and shops, with their addresses and
  pickup numbers, added, changed, taken out of use and put back, and deleted while they never
  held stock; the primary one stays.
* **Tried against the core:** on the seed's shop, with its Lahore warehouse and Karachi store, a
  stockroom in "isb" with a two-digit postcode was refused, named on the page; with 44000 it was
  added in Islamabad, renamed, set not to fulfil online orders, taken out of use, put back, and
  deleted, leaving the shop's two locations as they were. No errors in the browser.
* 2237 tests: locations listed with the primary one kept; one added after a refusal named;
  one changed and no longer fulfilling online orders; why one cannot be taken out of use; one
  deleted once asked.

### f07b9c2 · Products and stock by file, in the admin

* **Import and export** ([ADR-311](../architecture/13-decision-log.md#adr-311--the-admin-brings-products-in-from-shopifys-product-csv-and-exports-them-to-it-and-counts-stock-by-shopifys-inventory-csv-each-file-checked-first-and-taken-in-at-a-tap-on-a-page-of-its-own-beside-the-products-list-and-the-stock-page)), beside the products list and the stock page: products from
  Shopify's product CSV, checked first; products exported to it; and stock exported as
  Shopify's inventory CSV and counted back from it, checked first.
* **Tried against the core:** on the seed's shop, its 12 products came as 26 rows of Shopify's
  CSV, and the same file read back would leave all 12; a file of two products, one with a price
  of "abc", was checked as one to add and that row refused, named; imported, its product came
  as a draft with its stock tracked. The primary location's 21 rows of stock came as Shopify's
  inventory CSV; with On hand (new) filled in for one, it was checked as one to count and
  counted, the variant then holding 7. The first try's messages read "1 products" and "1
  variants"; they now read as counts, for one or many. The products tried with were then
  deleted. No errors in the browser.
* 2229 tests: a product CSV checked, checked again to update, and imported; products a
  search finds and one location's stock downloaded; a count checked and counted; a packer is
  told it is for owners and managers.

### 95b72b2 · The checkout page, in the admin

* **Checkout page** ([ADR-310](../architecture/13-decision-log.md#adr-310--the-admin-sets-the-checkout-page-in-settings-up-to-four-badges-under-its-button-in-the-shops-order-with-the-days-for-exchanges-and-returns-help-on-whatsapp-offered-only-with-the-shops-number-and-the-boxes-it-offers-for-the-shops-offers-by-channel)) in settings: up to four badges under its button, in the shop's
  order, with the days for exchanges and returns; and the boxes for the shop's offers, by
  channel.
* **Tried against the core:** on the seed's shop, with its four badges, 100% original products
  was removed, the exchange given 14 days, returns added and Help on WhatsApp moved up; returns
  at 0 days were refused, named on the page; at 10 they were kept as cash on delivery,
  WhatsApp, a 14-day exchange and 10-day returns, with boxes for WhatsApp and SMS. The shop's
  badges and boxes were then put back as they were. No errors in the browser.
* 2221 tests: badges added, put in order and given days, with days out of range refused
  before anything is sent; a box added; Help on WhatsApp offered only with a number; a badge
  removed alone.

### c5fdeba · Customers' care, in the admin

* **Customers' care** ([ADR-309](../architecture/13-decision-log.md#adr-309--the-admin-adds-a-customer-by-hand-records-the-marketing-they-agreed-to-in-their-words-merges-a-duplicate-into-them-once-asked-and-at-their-request-downloads-their-data-and-erases-them-ten-days-on-once-the-member-confirms-who-they-are-the-erasures-waiting-are-listed-and-each-cancelled-from-its-customer)): a customer added by hand from the customers list, with the
  marketing they agreed to in their words; their consent changed by channel on their page; a
  duplicate merged into them; their data downloaded and their erasure asked for, ten days on,
  and cancelled; and the erasures waiting listed.
* **Tried against the core:** on the seed's shop, a mobile of five digits was refused, named on
  the page; Sara Malik was added with WhatsApp consent in the words asked, and Sara M. under a
  second number; SMS consent was added; Sara M. was merged in, leaving one Sara; her data came
  as customer-cus_….json in the hatti.customer-data/1 format, with her consent history, orders
  and messages; her erasure was set for 19 October and listed among those waiting, then
  cancelled. Sara Malik stays in the seed's shop. No errors in the browser.
* 2216 tests: a customer added once the words and a valid number are given, their page then
  opened; consent changed by channel; a duplicate merged, never the customer themselves; the
  data downloaded and erasure asked for after confirming, then kept; the erasures waiting; an
  agent sees none of it.

### adeaf4f · Order policies, in the admin

* **Order policies** ([ADR-308](../architecture/13-decision-log.md#adr-308--the-admin-sets-the-shops-order-policies-in-settings-the-confirmation-desks-calling-hours-its-target-for-the-first-call-and-whether-it-waits-for-whatsapp-after-how-many-days-unpaid-and-unreachable-orders-are-cancelled-until-when-customers-may-cancel-and-the-high-value-amount-and-the-risk-score-that-holds-an-order-for-review)) in settings: the Confirmation Desk's calling hours, its first
  call's target and waiting for WhatsApp; the days after which unpaid orders and unreachable
  customers' orders are cancelled; until when customers may cancel; and the high-value amount
  and the score that holds an order for review.
* **Tried against the core:** on the seed's shop, on the defaults, calling hours from ten at
  night to nine in the morning were refused, named on the page; ten to eight were kept as 600
  and 1200 minutes, with unreachable customers cancelled after four days and the desk waiting
  for WhatsApp; high value of Rs 25,000 and a hold at 70 were kept as 2500000 and 70, the hint
  then reading "Now Rs 25,000". The shop was then put back on the defaults. On a phone, the
  first call's field was narrow enough to squeeze its hint into a column, and now takes the
  width. No errors in the browser.
* 2205 tests: calling hours refused then kept, with the desk and cancelling sent as changed
  and nothing sent for risk; high value and the hold score alone; a target that is not a number
  refused before anything is sent.

### 7e4337e · Customer messages, in the admin

* **Customer messages** ([ADR-307](../architecture/13-decision-log.md#adr-307--the-admin-sets-how-the-shops-customers-are-told-of-their-orders-in-settings-whatsapp-for-everything-or-sms-for-updates-each-with-its-price-the-messages-language-which-messages-go-to-customers-and-to-the-shop-and-the-alerts-number-it-lists-the-messages-sent-by-status-and-an-orders-page-shows-its-own-once-asked)) in settings: WhatsApp for everything or SMS for updates, each
  with its price; the messages' language; which go to customers and to the shop; the alerts
  number; and the messages sent, by status. An order's page shows its own, once asked.
* **Tried against the core:** on the seed's shop, the prices read Rs 4.62 a WhatsApp message
  and Rs 1.73 an SMS part; an alerts number of five digits was refused, named on the page; SMS
  for updates, Order shipped turned off and 0300 1234567 were kept as economy, order_shipped
  and +923001234567. The 42 messages sent were listed, and an order's three shown on its page.
  The shop's settings were then taken back to the defaults it had. No errors in the browser.
* 2200 tests: each way with its price, what changed sent alone, a refused number named; the
  messages listed by status with their orders; an order's asked for only once tapped. The Meta
  form now keeps its saved notice, as this one does.

### 7e0a3a5 · Meta and the catalog feed, in the admin

* **Meta & catalog** ([ADR-306](../architecture/13-decision-log.md#adr-306--the-admin-gives-the-shops-catalog-feed-and-its-meta-dataset-a-tab-of-the-online-store-the-feeds-address-to-copy-meta-connected-with-its-datasets-id-and-a-token-sealed-which-moment-of-an-order-is-purchase-and-a-code-for-test-events-once-the-member-confirms-who-they-are-disconnected-once-asked-and-the-moments-sent-by-status)), a tab of the online store for owners, managers and marketers: the
  catalog feed's address to copy or open; Meta's dataset connected, changed and disconnected;
  and the moments sent to it, by status, with their orders.
* **Tried against the core:** on the seed's shop, a dataset ID of letters was refused, named on
  the page; then connected with Purchase at delivery, kept with the token's last four, and a
  test code added alone, the token kept; the audit log held each change, the token never.
  Nothing was sent yet. It was then disconnected, as it was before. The feed's address served
  Google's RSS. No errors in the browser.
* 2194 tests: the feed and Meta connected after confirming, a refused ID named; a test code
  sent alone and the moments listed by status; disconnected once asked; none for an accountant.

### 26f6aff · The shop's sales tax, in the admin

* **Sales tax** ([ADR-305](../architecture/13-decision-log.md#adr-305--the-admin-sets-the-shops-sales-tax-in-settings-whether-it-charges-it-and-at-what-rate-included-in-its-prices-with-an-example-of-what-a-price-holds-on-delivery-too-the-ntn-and-strn-its-invoices-name-and-categories-with-rates-of-their-own-which-a-products-page-gives-its-variants)) in settings: whether the shop charges it, its rate with an example of
  what a price holds, delivery taxed too, its NTN and STRN, and categories with rates of their
  own; a product's page gives its variants the shop's rate or a category.
* **Tried against the core:** on the seed's shop, 18% was kept as 1800 hundredths, and a
  category REDUCED at 10% beside it; an STRN of a few digits was refused as "STRN must be 13
  digits", named on the page; a product's three variants were given REDUCED. All of it was then
  put back as it was: no rate, no categories, no numbers, the variants on the shop's rate. No
  errors in the browser.
* 2186 tests: a rate, delivery, numbers and a category sent as changed alone; a refusal
  named by its row; the rate taken away; a product's variants given a category, all at once.

### 2975d49 · Order exports, in the admin

* **Export** ([ADR-304](../architecture/13-decision-log.md#adr-304--the-admin-exports-the-orders-the-list-shows-its-tab-and-search-between-two-days-in-the-shops-time-zone-as-excel-or-csv-a-row-per-order-or-per-item-once-the-member-has-confirmed-who-they-are-and-schedules-the-same-of-each-day-week-or-month-emailed-at-an-hour-listed-and-stopped)) from the orders list, for owners, managers and accountants: the orders
  of its tab and search, between two days if asked, as Excel or CSV, a row per order or per
  item, saved at once after confirming who they are; and the same of each day, week or month
  emailed at an hour, listed and stopped.
* **Tried against the core:** on the seed's shop, the orders needing confirmation came as an
  Excel workbook of three rows, and as a CSV of their items with the byte-order mark Excel needs.
  The owner's email was not proved, so the page asked for it in place of a schedule; proved for
  the try, a weekly export at nine read "Next on 12 Oct 2026, 9:00 am, with 5 Oct 2026 to 11 Oct
  2026", and was stopped; the email was then put back as it was. No errors in the browser.
* 2181 tests: the list as the search language reads it; a download between two days in
  Pakistan after confirming; schedules listed, made and stopped; a proved email asked for; no
  link for a packer.

### 9af1731 · Support access, in the admin

* **Support access** ([ADR-303](../architecture/13-decision-log.md#adr-303--the-admins-settings-show-whether-hattis-support-may-look-at-the-shop-and-until-when-let-the-owner-let-it-in-for-15-minutes-to-a-day-and-a-reason-having-confirmed-who-they-are-let-the-owner-or-a-manager-end-it-and-list-each-time-it-was-let-in-and-the-discounts-page-takes-a-codes-days-in-the-shops-time-zone)) in settings: whether Hatti's support may look at the shop, until
  when, as who allowed and why; the owner lets it in for a quarter of an hour to a day, with a
  reason, confirming who they are where they signed in a while ago; the owner or a manager ends
  it; each time it was let in is listed. And the discounts page takes a code's days in the shop's
  time zone.
* **Tried against the core:** on the seed's shop, the owner let support in for an hour, "Order
  #1017 won't book with the courier", and the page said until when; ended, it was listed with who
  ended it. A code made to end on 31 December was kept to 18:59:59 UTC, the day's end in
  Pakistan. No errors in the browser. In the tests, the first try let support in twice: the
  confirming form sat inside the asking one, and its Confirm sent both; it now sits beside it.
  The duration's label, "For", matched "What it is for" too; it is "How long" now.
* 2173 tests: support let in once after confirming, ended, and the times before listed; a
  manager ending it and not letting it in; a discount's end in Pakistan.

### 5060864 · Payment links, in the admin

* **Payment links** ([ADR-302](../architecture/13-decision-log.md#adr-302--the-admin-keeps-the-shops-payment-links-what-each-sells-and-how-many-orders-it-took-whether-it-is-open-and-why-not-copied-or-sent-on-whatsapp-closed-and-opened-again-made-of-items-found-by-name-with-a-discount-code-a-limit-a-day-it-closes-in-the-shops-time-zone-and-prepaid-alone-if-the-shop-likes)), a section for owners and managers: what each link sells and how
  many orders it took, open or why not, copied or sent on WhatsApp, closed and opened again;
  made of items found by name, with a discount code, a limit, a day it closes and prepaid alone.
* **Tried against the core:** on the seed's shop, a code of another shop was turned down by the
  core, named as the discount code's problem; a link of one khussa, size 38, closing on 31
  December, opened a checkout of its own with the item and the shop's delivery charges; one of
  two of a size with one in stock said it was sold out, as it should. Closed, the link said it no
  longer takes orders; opened again, it was open. A link closed by staff first read "closed 31
  Dec 2026" of its future day; the day now says "closes" until it has passed. No errors in the
  browser.
* 2168 tests: links listed with what they sell and took, sent on WhatsApp and closed; one made
  of items found by name, a code turned down and then made, closing at the day's end in
  Pakistan; none for a marketer.
* **Seen on the way:** the discounts page takes a code's first and last days in the phone's own
  time, as store credit's expiry first did; it is next, with support access.

### ddf191f · Store credit, in the admin

* **Store credit** ([ADR-301](../architecture/13-decision-log.md#adr-301--the-admin-shows-a-customers-store-credit-on-their-page-its-ledger-to-those-who-keep-it-and-owners-and-managers-give-credit-by-hand-to-expire-at-the-end-of-a-day-in-the-shops-time-zone-and-take-it-back-an-order-not-yet-shipped-is-paid-with-it-from-its-page)) on a customer's page: what they have, for owners, managers,
  confirmation agents and accountants; its ledger in words for all but agents; credit given by
  owners and managers, with a reason and a day it expires, and taken back. An order still to
  ship is paid with it from its page.
* **Tried against the core:** on the seed's shop, Rs 1,000 given to a customer with a reason,
  then paying Rs 1,000 of their Rs 3,699 order, whose cash to collect at the door fell to Rs
  2,699; the ledger read "Paid for an order" with a link to it. Credit given to expire on 31
  December first read "expires 1 Jan 2027": the day's end was taken in the browser's own zone,
  UTC, not the shop's; it is now taken in the shop's, and read 31 Dec 2026. Taking back more than
  they had was refused before it was sent; no errors in the browser.
* 2162 tests: the balance and ledger; credit given to expire at the day's end in Pakistan,
  and taken back; an order to pack paid with credit, and none offered in transit; what an agent
  and a marketer see.

### 21b2f5b · The link page, in the admin

* **Link page** ([ADR-300](../architecture/13-decision-log.md#adr-300--the-admin-keeps-the-shops-link-page-in-the-online-store-where-it-is-to-copy-and-open-its-bio-links-and-products-edited-and-saved-together-each-products-variant-chosen-where-it-has-several-the-cores-reason-given-by-the-link-or-product-it-is-about-and-its-taps-over-the-last-week-month-or-three-months)), a tab of the online store for owners and managers: the page's address
  to copy and open, and its WhatsApp chat; its bio, links and products edited and saved together,
  each product's variant chosen where it has several; the core's reason named by the link or
  product it is about; and its taps over the last week, month or three months.
* **Tried against the core:** on the seed's shop, an address without https was turned down as
  link 3; a link to a search was added and moved up, a size of the chappal chosen, and the bio
  changed; the storefront's /links showed all of it at once. Two taps from a phone's browser
  were counted within the minute, the most tapped first; the headless browser's own tap was not,
  as the storefront leaves robots out. The Urdu page read right to left, with no errors in the
  browser. Adding a product already on the page as a whole first did nothing to see; the page now
  says it is there, and to choose one of its variants first.
* 2154 tests: the page's bio, links and products changed and saved together; a product not
  added twice; the core's reason named by its link; taps over a month and a week; and no tab for
  a marketer.

### 5866c63 · Customers in and out, in the admin

* **Import and export** ([ADR-299](../architecture/13-decision-log.md#adr-299--the-admin-imports-customers-from-a-csv-after-the-core-has-checked-it-saying-what-it-would-add-update-and-leave-and-the-rows-it-could-not-read-updating-those-already-here-only-when-asked-and-exports-everyone-or-a-segments-customers-as-a-csv-once-the-member-has-confirmed-who-they-are)), from the customers list for owners and managers: a CSV checked
  by the core first, saying what it would add, update and leave and the rows it could not read,
  then imported, updating customers already here only when asked; and everyone or a segment's
  customers exported as `customers.csv` once the member has confirmed who they are.
* **Tried against the core:** on the seed's shop, a file of two new customers and a bad number
  was checked, its bad row named, and imported; the same file with a name changed, checked again
  to update, updated one and left one; the WhatsApp subscribers' segment, after the session's
  confirmation was set an hour back, asked for the authenticator's code and downloaded a file of
  two customers; with no errors in the browser beyond the core's 403 that asks for the code.
* 2147 tests: a file checked, checked again to update, and imported; a segment exported after
  confirming with a password; and neither for a marketer.
* **The admin's tests have 20 seconds each:** with the whole monorepo's tests running, the menus
  test, which walks three levels of a menu, ran past vitest's 5 seconds, though no one wait in
  it passed the 5 seconds each may take (ADR-294's entry).

### b43a9d2 · Customer segments, in the admin

* **Segments** ([ADR-298](../architecture/13-decision-log.md#adr-298--the-admins-segments-are-built-from-conditions-in-words-joined-so-customers-match-all-or-any-and-written-in-the-cores-query-language-a-query-the-builder-cannot-show-is-kept-and-edited-as-text-what-the-conditions-match-is-counted-and-its-newest-customers-shown-as-they-change-the-cores-reason-shown-where-a-query-does-not-read)), from the customers list for owners, managers and marketers: each with
  how many customers it holds; built from conditions in words, joined as all or any, written in
  the core's query language and read back from it; counted, with the newest customers, as the
  conditions change; a query the builder cannot show kept as its text.
* **Tried against the core:** on the seed's shop, a segment of customers with an order in Lahore
  or Karachi counted five as it was built and was kept; as text, a query cut short said the
  core's reason; one of orders or spending went back to the builder and was saved; and the
  segment was deleted; with no errors in the browser. The first try started a new condition on
  tags, the core's first field; it starts on the number of orders now.
* 2142 tests: conditions written and read back; a segment built, counted and kept; one changed,
  one kept as text with its problem said, and one deleted; and none for an agent.

### da14865 · The storefront's preferences and redirects, in the admin

* **A Storefront tab** ([ADR-297](../architecture/13-decision-log.md#adr-297--the-admins-online-store-keeps-the-storefront-behind-its-password-while-the-shop-gets-ready-pauses-it-while-open-until-a-time-or-until-told-and-sets-its-home-page-for-search-engines-and-sends-old-addresses-on-redirects-found-added-deleted-imported-from-shopifys-csv-once-checked-and-exported-to-it)): the storefront kept behind its password with a message, or open;
  paused with a message until a time or until told; and its home page's title and description for
  search engines.
* **A Redirects tab:** redirects found as one types, added, deleted after asking, imported from
  Shopify's CSV once checked, and downloaded as it.
* **Tried against the core:** the seed's shop kept behind a password and opened again, paused
  until tomorrow and opened again, and given a home page title; a redirect added, a CSV of three
  rows checked (two to add, one with no target said by its row) and imported, all three
  downloaded as Shopify's CSV, and one deleted; with no errors in the browser.
* 2131 tests: the password, the pause and search engines saved part by part; redirects found,
  added, deleted, imported after checking and exported; and neither tab for a marketer.

### 6c8b42a · The shop's blogs, in the admin

* **A Blogs tab** ([ADR-296](../architecture/13-decision-log.md#adr-296--the-admins-online-store-writes-the-shops-blogs-a-blog-started-by-its-title-its-comments-closed-approved-or-shown-at-once-its-articles-written-as-text-like-pages-with-an-author-tags-and-an-image-from-the-phone-shown-now-from-a-time-ahead-or-hidden-and-their-comments-approved-marked-as-spam-or-not-and-deleted)): blogs started by their title, their comments closed, approved or shown
  at once, and deleted; articles written as text, with an author, tags and an image from the
  phone, shown now, from a time ahead or hidden; and their comments approved, marked as spam or
  not, and deleted. Logos and articles' images share one upload.
* **Tried against the core:** a blog started on the seed's shop; an article written with a
  heading and a list, an author, tags and an image, to show tomorrow at 09:30, kept as such; two
  comments left on it, one approved and one marked as spam; with no errors in the browser. The
  first try found the article scheduled for tomorrow shown as hidden, as were pages scheduled
  ahead: the core says `isPublished` of one shown now alone, and the admin now reads the date.
* 2121 tests: a blog started and an article written with an image to show from a time ahead;
  an article changed and hidden, its comments moderated, and deleted; a blog's comments closed
  and the blog deleted; and none for a packer.

### 2b350b7 · The admin installed on a phone, and offline

* **Installing** ([ADR-295](../architecture/13-decision-log.md#adr-295--the-admin-installs-on-a-phone-from-a-manifest-in-its-language-with-png-and-maskable-icons-and-a-service-worker-built-with-it-keeps-the-admins-own-files-its-page-from-the-network-and-offline-from-the-cache-its-files-from-the-cache-the-shops-data-never-it-says-when-the-phone-is-offline-and-offers-a-new-version-once-it-has-installed)): the manifest in English or Urdu as the admin is, with PNG and
  maskable icons, and an icon for iOS's home screen.
* **A service worker** built with the admin to /sw.js, keeping its page, scripts, styles,
  manifests and icons, never the shop's data; the page from the network, and from the cache
  offline. Every page says when the phone is offline, and a new version, once installed, is
  offered with a Reload that has it take over.
* **Tried in Chromium** on the build served by `vite preview`: the worker took the page over and
  kept its ten files; the manifest had no errors, and Chromium's only reason not to offer to
  install it was the test's incognito window; offline, the admin reopened from its cache to say
  it is offline, and the notice went once it was back; in Urdu, the browser read ہٹی's manifest.
* 2104 tests: what the worker keeps and never keeps; a build's files to keep; offline said and
  unsaid; a new version offered and told to take over; and the manifest in each language.

### a246a83 · Passkeys and Google, signing in to the admin

* **Signing in** ([ADR-294](../architecture/13-decision-log.md#adr-294--the-admin-signs-in-with-a-passkey-alone-a-passkey-as-the-second-step-or-googles-own-button-loaded-only-when-asked-for-and-confirms-who-is-there-the-same-ways-a-passkeys-challenge-and-googles-nonce-are-good-once-so-each-try-starts-from-the-cores-options-again)): with a passkey alone, or as the second step; or with Google's own
  button, loaded from Google only when asked for, a new Google account going on to open a shop.
* **Confirming who you are** with a passkey or Google too, a new challenge or nonce for each
  try; and Google connected from your account.
* **Tried against the core:** the seed's owner added a passkey in Chromium's virtual
  authenticator, signed out, and signed in with it alone; then by email and password with the
  passkey as the second step; then, the session's proof made an hour old, removed the passkey
  after confirming with it. Google, with no client ID set here, said it is not set up.
* 2101 tests: a passkey signing in alone, turned away and then used; a passkey as the second
  step; Google's button and a new account; Google not set up; confirming with a passkey, turned
  away, then with Google; and Google connected from the account.

### d40b1f1 · Your own account, in the admin

* **An Account page** ([ADR-293](../architecture/13-decision-log.md#adr-293--the-admins-account-page-keeps-your-email-number-and-language-the-google-account-and-passkeys-you-sign-in-with-and-the-browsers-you-are-signed-in-on-each-change-proved-again-when-the-core-asks-passkeys-are-made-by-the-browser-from-the-cores-options-as-webauthns-json)), from the header on every page: your email and number, each
  proved or not and changed by a link or a code; the language Hatti writes to you in; Google;
  passkeys added and removed; and the browsers you are signed in on, any other signed out.
* **Tried against the core:** the seed's owner chose Urdu and English again; a passkey was made
  by Chromium's virtual authenticator, named, listed and removed; with no errors in the browser.
  The first try found the language's choice waiting for the core before it showed; it shows at
  once now, and goes back if the core refuses. The passkey was refused at first because the core
  took passkeys from its own origin alone: `.env.example` now names the admin's.
* 2098 tests: the account shown as it is; the language chosen; a new email sent its link and
  a new number proved; a passkey made from WebAuthn's JSON and removed; another browser signed
  out; the number and Google taken off; and an account with no email offered one.

### 49cff6e · The shop's policies, in the admin

* **A Policies tab** ([ADR-292](../architecture/13-decision-log.md#adr-292--the-admins-policies-start-from-hattis-drafts-and-are-written-as-text-with-headings-lists-and-links-kept-or-taken-away-by-owners-and-managers-each-policys-urdu-is-kept-as-a-translation-of-its-words-said-to-be-out-of-date-once-they-change)): the five policies, each started from Hatti's draft
  and written as text with headings, lists and links, saved or taken away; its Urdu kept as a
  translation of its words, said to be out of date once they change. Pages write the same way.
* **Tried against the core:** the seed's shop had no policies; its delivery policy's draft opened
  as text, its zones and free-delivery total filled in, and was saved; its Urdu draft opened as
  text with "Rs 200" and "Rs 5,000" in it, and was saved as the translation; the returns policy
  saved from its draft too; with no errors in the browser. The first try found a new policy's
  form remade by its own save, losing "Saved."; it is now kept by the policy's kind.
* 2094 tests: drafts to text and back to the same HTML, English and Urdu; the five listed and
  one written from its draft; the Urdu kept against its words' digest and said out of date;
  one taken away; and none for a marketer.

### c806d77 · The online store's pages and menus, in the admin

* **An Online store section** ([ADR-291](../architecture/13-decision-log.md#adr-291--the-admins-online-store-writes-the-shops-pages-as-plain-text-paragraphs-a-blank-line-apart-shown-or-hidden-keeping-html-from-elsewhere-as-html-and-changes-its-menus-links-three-levels-deep-to-the-home-page-all-products-a-collection-a-product-a-page-or-an-address-saved-whole-marketers-write-pages-owners-and-managers-both)): pages written as plain text, shown or hidden,
  their HTML kept where it is more than paragraphs; menus' links three levels deep, to the home
  page, all products, a collection, a product, a page or an address, put in order and saved
  whole; marketers writing pages, owners and managers menus too.
* **Tried against the core:** the seed's four pages listed as shown; "How to order" written in
  two paragraphs, saved at /pages/how-to-order, then hidden; the main menu's four links read, a
  "Chappals" collection put under "Eid edit" and still there after a reload; a "Help links" menu
  made with a link to a page, then deleted; with no errors in the browser. The first try found
  the page's form remade by its own save, losing "Saved."; it is now kept by the page's ID.
* 2085 tests: text to paragraphs and back, and HTML kept; pages listed by whether they show,
  one written hidden, one changed sending only what changed, one deleted; a menu changed three
  levels deep and saved with its links' IDs; one made with a product link; one deleted, never
  the main menu; and a marketer kept to pages.

### ed70e5b · Collections, in the admin

* **Collections from the products page** ([ADR-290](../architecture/13-decision-log.md#adr-290--the-admins-collections-reached-from-the-products-are-listed-and-made-by-hand-or-by-rules-one-made-by-hand-has-its-products-found-and-added-taken-out-and-moved-up-or-down-while-sorted-by-hand-one-made-by-rules-has-its-rules-changed-owners-and-managers-change-them-every-role-reads-them)): listed by title, made by hand or
  by rules; one made by hand with its products found and added, taken out and moved up or
  down; one made by rules with its rules changed; details saved and the collection deleted.
* **Tried against the core:** the seed's two collections listed; "Eid picks" made by hand, a
  khussa and a chappal added and the chappal moved first; "Chappals" made by a rule, title
  contains Chappal, finding the Peshawari Chappal by itself; with no errors in the browser.
* 2068 tests: a collection made by rules with a second rule whose relation follows its
  column; one made by hand put in order, a product taken out and another added; details changed
  and the collection deleted after asking; and a packer reading one made by rules with nothing
  to change.

### a7b03d3 · Stock, in the admin

* **A Stock section** ([ADR-289](../architecture/13-decision-log.md#adr-289--the-admins-stock-lists-what-runs-low-the-fewest-for-sale-first-and-finds-any-products-each-variants-stock-at-each-location-added-to-or-taken-from-with-a-reason-and-counted-against-what-was-on-hand-when-read-by-owners-and-managers-every-role-sees-it-and-home-says-how-many-run-low)): what runs low, the fewest for sale first, and any
  product's found; each variant's stock at each location with its latest changes, added to or
  taken from with a reason and counted by owners and managers; the threshold changed there;
  Home saying how many run low and how many are out.
* **Tried against the core:** Home said "5 running low · 2 out of stock"; the list put the
  seed's chappal in size 9, out of stock, first; 3 received at the Lahore warehouse made it 3 for
  sale, then a count of 2 made it 2, its changes saying "+3 on hand · received" and "-1 on
  hand · counted"; with no errors in the browser.
* 2055 tests: what runs low listed with its product linked; damaged stock taken away, never
  more than on hand; a shelf counted against what was on hand when read; the threshold changed;
  a product found whose stock is not counted, then counted at the primary location; and a
  packer seeing stock without changing it, and Home's count.

### cb41088 · Orders merged and split, in the admin

* **Merging and sending apart on the order's page** ([ADR-288](../architecture/13-decision-log.md#adr-288--an-orders-page-merges-it-into-another-of-its-customers-orders-waiting-to-be-packed-and-paid-the-same-way-chosen-from-their-orders-and-opens-that-one-and-sends-units-of-it-apart-as-an-order-of-their-own-with-its-delivery-charge-always-leaving-something-each-order-links-the-one-it-went-to-or-came-from)): an order merged into
  another of its customer's waiting orders, chosen from their orders, and that one opened;
  units sent apart as an order of their own with its delivery charge; each order linking the
  one it went to or came from.
* **Tried against the core:** a second order for #1015's customer, #1017, 2 chappals, one
  sent apart with a Rs 150 delivery charge as #1018, "Sent apart from #1017" on its page;
  #1018 then merged into #1015, chosen over #1017, and #1015's page opened with the chappal
  added, Rs 9,949 in all, its timeline saying "Merged #1018 into this order"; with no errors in
  the browser.
* 2045 tests: an order merged into the customer's one other order waiting and paid the same
  way, that order then opened; a customer with none to merge into; units sent apart with their
  delivery charge, never all of them; and an order merged away linking where its items went.

### 43d7dc4 · An order's items changed, in the admin

* **Items, delivery charge and discount changed on the order's page** ([ADR-287](../architecture/13-decision-log.md#adr-287--an-orders-page-changes-its-items-while-it-waits-to-be-packed-quantities-stepped-and-lines-taken-off-or-put-back-products-found-and-added-at-a-price-agreed-and-its-delivery-charge-waived-or-discount-given-saying-back-the-new-total-and-cash-at-the-door-a-packed-order-is-unpacked-first)):
  lines stepped, taken off and put back, products found and added at a price agreed, delivery
  waived and a discount given, the new total and cash at the door said back; a packed order
  unpacked first, and the order's actions shown only to those who work orders.
* **Tried against the core:** the seed's #1015, waiting to be confirmed, its khussa stepped up
  and the same variant found and added, which went to its line: 3 at Rs 2,250, "Rs 6,950, with
  Rs 6,950 to collect at the door"; then delivery waived and Rs 300 taken off, Rs 6,450; the
  timeline said "Changed the items" and "Changed the delivery charge"; with no errors in the
  browser.
* 2038 tests: a line stepped up, another taken off and a variant added at a price agreed,
  sent as only what changed; every item taken off refused; a discount below the transfer's
  refused and delivery waived, with a review said back; a packed order unpacked; and nothing to
  change, confirm or cancel for an accountant.

### 503f71c · An order's everyday edits, in the admin

* **Assignment, comments, note, tags and address on the order's page** ([ADR-286](../architecture/13-decision-log.md#adr-286--an-orders-page-gives-it-to-a-member-of-staff-comments-on-its-timeline-with-their-authors-edits-and-deletes-keeps-its-note-and-tags-and-corrects-its-address-while-nothing-has-shipped-each-for-the-roles-the-core-lets-do-it)):
  the order given to staff or taken, comments for whoever picks it up next with their authors'
  edits and deletes, its note and tags, and its address corrected while nothing has shipped.
* **Tried against the core:** the seed's #1001, waiting to be confirmed, given to its owner from
  a list of three staff, a comment written and changed (marked edited), its note and two tags
  saved, and a landmark added to its address; the timeline said "Assigned to", "Changed the
  note, tags" and "Changed the shipping address"; with no errors in the browser. The tests
  found an accountant who once wrote a comment offered to change it, which the core refuses;
  only those who work orders now are.
* 2031 tests: an agent taking an order, commenting and changing only their own comment; an
  owner giving it to anyone or no one and deleting another's comment; note, tags and address
  sent as the core takes them; and nothing to change for an accountant or once a parcel ships.

### 349255e · Refunds and payments, in the admin

* **Payments and refunds on the order's page** ([ADR-285](../architecture/13-decision-log.md#adr-285--an-orders-page-shows-what-was-paid-and-given-back-each-refund-with-how-its-reference-why-and-its-receipt-owners-and-managers-record-a-refund-at-most-what-is-left-by-hand-with-its-receipt-uploaded-through-the-gateway-or-as-store-credit-and-mark-an-order-paid-after-saying-how-much-it-records)):
  what was paid and given back, each refund with how, its reference, why and its receipt; a
  refund recorded, at most what is left, by hand with its receipt uploaded, through the gateway
  or as store credit; and an order marked paid after saying how much.
* **Tried against the core:** the seed's #1006, Rs 3,999 paid and Rs 3,799 given back already
  (a wallet refund, and the exchange #1016), refused Rs 500 as more than was left; took Rs 150
  back by bank transfer with its reference and a receipt image, whose link served it, and the
  last Rs 50 as store credit; and #1013, nothing paid, was marked paid for Rs 3,749; with no
  errors in the browser. Store credit's refund first showed its transaction's ID as its
  reference; it no longer does.
* 2022 tests: a transfer refund with its reference and receipt uploaded, past what is left
  refused, store credit with no reference or receipt, an order marked paid after asking, what
  was paid shown to a packer without buttons, and what is left worked out.

### 299f348 · Customer returns, in the admin

* **Returns on the order's page** ([ADR-284](../architecture/13-decision-log.md#adr-284--an-orders-page-records-its-customers-return-of-delivered-items-each-with-why-another-variant-sent-at-once-in-exchange-if-asked-checks-it-in-with-what-is-damaged-written-off-or-cancels-it-customer-returns-on-their-way-have-a-tab-of-their-own-and-a-parcel-back-damaged-is-claimed-from-its-courier)):
  a return of delivered items recorded with why, another size sent at once in exchange, and the
  courier bringing it; checked in with what is damaged written off, or cancelled; customer
  returns on their way as a tab of the Returns section, which the home opens; and a parcel back
  damaged claimed from its courier.
* **Tried against the core:** the seed's #1006, delivered by TCS, had one Peshawari Chappal in
  size 10 sent back as too small, size 8 sent in exchange as #1016 (size 9, out of stock,
  said so), the return listed on its way, then received with the pair written off; and #1005's
  parcel, back with both suits written off, claimed from Leopards; with no errors in the
  browser.
* 2016 tests: a return with its exchange and tracking, too many refused, the size coming
  back not offered, a return checked in with a write-off and cancelled, a damage claim by an
  accountant, what can still come back, and returns on their way with the home's link.

### 2f79e06 · An order's parcels, in the admin

* **Parcels on the order's page** ([ADR-283](../architecture/13-decision-log.md#adr-283--an-orders-page-shows-its-parcels-courier-and-tracking-number-items-and-the-latest-steps-of-their-way-those-who-work-orders-mark-one-delivered-or-refused-add-a-step-told-of-a-courier-hatti-does-not-follow-mark-it-lost-after-asking-or-check-it-back-in-with-what-came-back-damaged-written-off)):
  each parcel's courier and tracking number, its items and the latest steps of its way; marked
  delivered or refused, a step added for a courier Hatti does not follow, marked lost after
  asking, or checked back in with so many of each line back in stock and the rest written off.
* **Tried against the core:** the seed's Leopards parcel for #1005 given an "out for delivery"
  step with the rider's name, marked refused, and checked back in with both suits written off
  as damaged; the order's timeline said each; with no errors in the browser. The parcel first
  read "Coming back" under the order's "Returning"; it now uses the order stages' words.
* 2006 tests: the parcel's tracking link, items and latest steps then all of them, delivered
  and refused, a step added with the courier's words, a check-in with an item written off and
  too many refused, and no buttons for an accountant.

### e3a8d8b · Parcels coming back, in the admin

* **Returns, a section of its own** ([ADR-282](../architecture/13-decision-log.md#adr-282--the-admins-returns-section-lists-parcels-on-their-way-back-the-longest-first-checked-in-by-the-tracking-number-on-their-label-or-from-the-list-or-marked-lost-lost-parcels-with-their-worth-claimed-from-the-courier-and-the-claims-to-follow-up-settled-as-paid-refused-or-withdrawn)):
  parcels on their way back, the longest first, a slow courier's in red, checked in by the
  tracking number on their label or from the list, or marked lost; lost parcels with their
  worth, claimed from the courier; and the claims to follow up, settled as paid, refused or
  withdrawn. The home's lost parcels, claims and cash to come open their pages.
* **Tried against the core:** two of the seed's parcels refused at the door; one checked in by
  its tracking number typed in lower case with spaces round it, the other marked lost, claimed
  for its worth of Rs 4,990 with the courier's claim number, and settled as Rs 4,000 paid; with
  no errors in the browser. The first try showed "0 days on its way back", a per-parcel button
  reading "Checked in" like a state, and the tracking field half the card's width on a phone;
  they now read "Coming back since today" and "Check it in", and the field takes the width.
* 1998 tests: checking in by number and from the list, a slow return in red, marking lost
  after asking, a lost parcel claimed with its worth filled in, a claim refused with why,
  settled claims shown when asked, the home's links, and who sees the section and its tabs.

## 2026-10-08

### a637b22 · The cash couriers hold, in the admin

* **Cash, a section of its own** ([ADR-281](../architecture/13-decision-log.md#adr-281--the-admins-cash-section-shows-what-couriers-owe-on-delivered-cash-on-delivery-orders-and-what-is-on-its-way-by-how-long-it-has-been-owed-and-by-courier-cash-held-15-days-or-more-in-red-and-imports-a-couriers-statement-only-once-a-check-of-it-reads-right-its-lines-to-look-into-first)):
  what couriers owe and what is on its way; how long it has been owed and by which courier,
  cash held 15 days or more in red; their statements, those with lines to look into marked;
  and a statement checked, then imported and opened, its lines to look into first.
* **Tried against the core:** the seed's owner saw Rs 27,969 on its way on five parcels, then
  checked a Leopards statement of three rows (one paid short, one for a parcel the shop has
  not, one for an order paid already), imported it, and saw its three lines, #1005 linked, and
  Rs 3,000 come off what was on its way; with no errors in the browser. Its heading first read
  "Leopards's statement"; it now reads "Statement from Leopards".
* 1987 tests: what is owed with late cash and its courier in red, a statement checked and
  then imported, its page's lines to look into and all of them, ages in words, Excel read as
  base64, and the section for those who reconcile alone.

### f35fb86 · COD health in the admin

* **COD health under the sales** ([ADR-280](../architecture/13-decision-log.md#adr-280--the-admins-analytics-show-the-periods-cod-health-under-its-sales-how-many-cash-on-delivery-orders-were-confirmed-delivered-and-came-back-of-those-that-turned-out-what-returns-cost-and-the-rates-by-city-product-source-or-courier-a-return-rate-of-30-or-more-in-red)):
  confirmed, delivered and came back as rates of those that turned out, each with what it is
  of; what returns cost and the parcels on their way; and the rates by city, product, source or
  courier, a return rate of 30% or more in red.
* **Tried against the core:** the seed's owner saw 88% confirmed, 7 of 8 decided, half of two
  finished parcels back, Multani Khussa's returns in red, and four couriers, with no errors in
  the browser. The first try showed "7 of 12 placed" beside 88%, which is why each rate now
  says what it is of.
* 1981 tests: the cards and their counts, a city's high returns in red, the courier
  breakdown asked for.

### 8e0e02e · Sales over time in the admin

* **Analytics, a section of its own** ([ADR-279](../architecture/13-decision-log.md#adr-279--the-admins-analytics-show-sales-over-the-last-7-30-or-90-whole-days-in-the-shops-time-zone-against-the-days-as-many-before-net-sales-orders-the-average-order-and-profit-with-how-each-changed-bars-by-day-by-week-over-90-what-sold-most-and-where-orders-came-from)):
  the last 7, 30 or 90 days against the days before: net sales, orders, the average order and
  profit with how each changed; net sales as bars by day, or week; the five products that sold
  most; and where orders came from.
* **Tried against the core:** the seed's owner saw 30 days of Rs 77,717 from 14 orders, thirty
  bars, the lawn suit selling most; and fourteen weekly bars over 90 days; with no errors in the
  browser.
* 1979 tests: the figures with their changes, the bars, products and sources, weeks over 90
  days, and whole days in the shop's time zone.

### 21a9803 · The activity log in the admin

* **Activity, in settings** ([ADR-278](../architecture/13-decision-log.md#adr-278--the-admins-activity-says-in-words-what-changed-in-the-shop-by-whom-and-when-linking-to-what-changed-where-it-has-a-page-and-apart-what-the-shop-may-need-to-account-for-numbers-seen-exports-erasures-and-hattis-supports-looks-owners-and-managers)):
  what changed in the shop in words, by whom and when, linking to the product, order, customer or
  draft it changed; and on a tab of its own, the numbers seen, exports, erasures and support's
  looks the shop may need to account for.
* **Tried against the core:** the seed's owner saw the day's fifty latest changes, from the drafts
  placed to the stock they took, each named and timed, and the audit log's plan and credit
  choices; with no errors in the browser.
* 1976 tests: entries in words with who and links, older ones, the audit tab, and events
  without words.

### 5758fe3 · Draft orders in the admin

* **Orders taken in a chat or on a call** ([ADR-277](../architecture/13-decision-log.md#adr-277--staff-take-orders-over-the-phone-or-in-a-chat-as-drafts-in-the-admin-products-found-and-added-at-the-price-agreed-where-it-was-taken-and-how-it-is-paid-its-link-sent-on-whatsapp-for-the-customer-to-give-the-address-and-confirm-or-the-draft-placed-at-once-and-tertiary-buttons-that-take-something-away-are-red)):
  drafts listed open and placed; a new one with products found and added at the price agreed,
  where it was taken, how it is paid, delivery and an amount off, and the address where staff
  have it; its page with its link to copy or send on WhatsApp, placed as an order, or deleted.
* **Fixed:** archive, remove and delete buttons showed green, their red losing to the button's
  own colour; they are a `danger` button now, in eleven places.
* **Tried against the core:** the seed's owner made #D5 from a search for "khussa" with a Rs 200
  delivery charge, sent its link (WhatsApp's too), and was told to add the address first when
  placing it; made #D6 with the address and placed it, which opened order #1015; with no errors
  in the browser.
* 1972 tests: making a draft at the price agreed, sending its link and placing it, and the list.

### 61e2fd5 · Discount codes in the admin

* **Discounts, a section of their own** ([ADR-276](../architecture/13-decision-log.md#adr-276--the-admins-discount-codes-are-a-section-of-their-own-for-those-who-make-them-each-with-what-it-gives-in-a-line-whether-it-works-now-and-how-often-it-was-used-made-for-a-percentage-an-amount-or-free-delivery-limited-and-dated-ended-at-once-or-deleted)):
  the codes with what each gives, whether it works now and how often it was used; a new one for a
  percentage, an amount or free delivery, limited and dated, its code typed or made up to be read
  out; one ended at once, or deleted. Owners, managers and marketers see it.
* **Tried against the core:** the seed's owner made a 10% code for orders from Rs 2,000, which the
  core summed up in a line; the same code again was refused in the core's words; it was ended, then
  deleted; with no errors in the browser.
* 1962 tests: making a code as a marketer, ending and deleting, and who sees the section.

### a87c011 · Plan and billing in the admin

* **The shop's plan with Hatti and what it pays** ([ADR-275](../architecture/13-decision-log.md#adr-275--the-admins-billing-shows-the-shops-plan-with-hatti-and-what-it-pays-the-plans-side-by-side-monthly-or-yearly-one-chosen-or-kept-by-the-owner-once-they-confirm-who-they-are-an-invoice-paid-through-hattis-gateway-or-by-transfer-or-raast-with-its-reference-given-and-message-credit-bought-managers-read-it)):
  the plan and its period, the plans side by side monthly or yearly, one chosen or the current one
  kept by the owner once they confirm who they are; invoices paid by card through Hatti's gateway,
  or by transfer or Raast with the reference given; message credit bought; managers read it.
* **Tried against the core:** the seed's owner, on Pro, chose Growth, which waited for the
  period's end, then kept Pro, which dropped it; bought Rs 1,000 of credit and was sent through
  Hatti's gateway to its invoice's page; with no errors in the admin.
* 1955 tests: choosing and paying, a transfer said, credit bought, and a manager's view.

### 5a5ea05 · Online payments and the shop's brand in the admin's settings

* **Two more sections of settings** ([ADR-274](../architecture/13-decision-log.md#adr-274--the-admins-settings-take-the-shops-online-payments-and-its-brand-a-gateway-connected-once-the-member-confirms-who-they-are-its-webhook-address-given-to-copy-into-the-gateways-dashboard-the-gateways-put-in-the-order-customers-are-offered-them-or-archived-the-shops-logo-and-square-logo-uploaded-from-the-phone-and-its-whatsapp-number)):
  online payments, each gateway account with its webhook address to copy, put in the order
  customers are offered them, archived, or another connected once the member confirms who they
  are; and the shop's logo, square logo and WhatsApp number.
* **Tried against the core:** the seed's owner uploaded a logo from a file, which the page then
  showed from storage; saved a WhatsApp number, a wrong one refused in the core's words; and
  connected the test gateway, its webhook address shown; with no errors in the browser.
* 1946 tests: connecting after confirming, reordering and archiving, and the logo and number.

### bfbf924 · The pages email links open

* **Four pages of the admin's own** ([ADR-273](../architecture/13-decision-log.md#adr-273--the-pages-the-cores-emails-link-to-are-the-admins-a-new-password-set-from-a-reset-link-signing-every-session-out-this-tabs-too-an-email-proved-or-changed-with-a-tap-rather-than-as-the-page-opens-and-a-link-to-set-a-new-password-asked-for-from-signing-in-the-admin-reads-auths-field-errors-as-the-core-names-them)):
  asking for a reset link from signing in by email; setting a new password from it, which signs
  every session out, this tab's too; proving an email, and changing it, with a tap rather than as
  the page opens.
* **Fixed:** `/auth` names a refused field as an object, which the admin's client read as a list
  and threw on, so signing up never showed which field was wrong; it reads both now.
* **Tried against the core**, with tokens made as its emails' are: the agent's email proved, the
  link refused when opened again; a reset refusing "password" in the core's words, then setting
  another, signing in with it, and a reset while signed in signing the tab out; asking for a link
  from signing in; with no errors in the browser.
* 1935 tests: the four pages through the real screens, and a link without its token.

### f70a05c · Delivery and payments in the admin's settings

* **Three more sections of settings** ([ADR-272](../architecture/13-decision-log.md#adr-272--the-admins-settings-take-delivery-charges-cash-on-deliverys-rules-and-bank-transfer-each-a-form-of-everything-it-sets-saved-at-once-as-checkout-will-use-it-risk-scores-are-shown-out-of-100-for-the-cores-0-to-1-and-the-bank-account-is-given-once-the-member-confirms-who-they-are)):
  delivery charges, free delivery and working days, with zones of cities; cash on delivery's fee,
  most, cities and tags it is not offered for, refusals, risk scores and the advance; and bank
  transfer's account, whether checkout offers it and what paying so takes off, saved after the
  member confirms who they are.
* **Fixed:** the order page showed the risk score rounded to 0 or 1; it is out of 100 now, as in
  settings.
* **Tried against the core:** the seed's owner saved delivery's charge, free delivery and days,
  gave the bank account (refused first for a mistyped IBAN, named as such), turned transfer on
  with 5% off up to Rs 500, and set cash on delivery's fee, cities, a code from score 40 and a 20%
  advance of new customers; each was there after a reload, with no errors in the browser.
* 1930 tests: delivery with a zone, a problem named by its zone, cash on delivery's rules and
  advance, and the bank account after confirming who one is.

### a44fc88 · Settings in the admin: courier accounts and staff

* **Settings' first sections** ([ADR-271](../architecture/13-decision-log.md#adr-271--the-admins-settings-begin-with-courier-accounts-and-staff-an-account-connected-with-the-credentials-its-courier-asks-for-made-the-default-or-archived-staffs-roles-changed-and-staff-let-go-by-those-who-manage-them-and-people-invited-by-a-link-to-send-on-whatsapp-which-opens-a-page-of-the-admins-own-a-sensitive-change-asks-the-member-to-confirm-who-they-are-then-goes-ahead)):
  courier accounts connected with the credentials each courier asks for, made the default or
  archived; staff's roles changed and staff let go; people invited by a link to copy or send on
  WhatsApp; invitations taken back; a refused sensitive change confirmed with the authenticator,
  the password or a WhatsApp code, then made.
* **The invitation's page:** who invited whom to which shop as what; joined with a tap signed
  in, or after signing in or opening an account, which come back to it.
* **Tried against the core:** the seed's owner connected a second courier account and made it the
  default, invited a packer, and a new person opened the link, opened an account, came back to the
  invitation and joined, their bottom bar a packer's; with the owner's session aged past 15
  minutes, changing a role asked for the authenticator's code and then changed it; with no errors
  in the browser.
* **For it:** the fake core of the screen tests answers `/auth` paths and GraphQL errors.
* 1920 tests: connecting, inviting after confirming, and joining through the real screens.

### dcb7d73 · Shipping in the admin

* **The shipping section** ([ADR-270](../architecture/13-decision-log.md#adr-270--the-admins-shipping-packed-orders-booked-with-the-shops-courier-account-in-a-tap-each-booking-shown-as-the-worker-books-it-and-its-courier-carries-it-booked-parcels-labels-and-the-accounts-load-sheet-printed-from-a-tab-of-their-own-and-on-a-phone-the-bottom-bars-five-slots-kept-for-the-busiest-sections-the-rest-under-more)):
  packed orders booked with the shop's courier in a tap, those refused said with why; bookings
  followed as the worker books them and their couriers carry them; booked parcels' labels and
  the load sheet printed from a tab of their own; and a phone's bottom bar kept to five, the rest
  under More.
* **Tried against the core and its worker:** with the development's test courier connected, the
  seed's owner booked two packed orders, which the worker booked within seconds, printed a
  parcel's label with its barcode and the cash to collect, and printed the load sheet; with no
  errors in the browser.
* 1908 tests: booking, bookings' states and printing through the real screens.

### 488d439 · Customers in the admin

* **The customers section** ([ADR-269](../architecture/13-decision-log.md#adr-269--the-admins-customers-a-list-searched-by-any-part-of-a-number-a-name-or-an-email-and-a-customers-page-with-how-to-reach-them-how-their-parcels-went-their-orders-addresses-and-the-shops-note-and-tags-agents-see-the-number-when-they-ask-which-is-logged-and-owners-and-managers-block-it-from-there)):
  the list searched by any part of a number, a name or an email; a customer's page with how to
  reach them, how their parcels went, their latest orders and addresses, and the shop's note and
  tags; a number blocked for a reason and unblocked; an order's page linking its customer.
* **Tried against the core:** the seed's owner searched by four digits, read a customer who had
  sent back the one parcel they were sent, blocked and unblocked their number and went from their
  order back to them; an agent saw a masked number and revealed it; in English and Urdu, on a
  phone and a desktop, with no errors in the browser.
* 1900 tests: searching, revealing, noting and blocking through the real screens.

### 69fba69 · Products' photos in the admin

* **Photos from the phone** ([ADR-268](../architecture/13-decision-log.md#adr-268--merchants-add-a-products-photos-from-its-page-taken-with-the-phones-camera-or-chosen-from-its-gallery-a-large-photo-is-made-2048-pixels-a-side-in-the-browser-before-it-goes-up-straight-to-storage-through-a-signed-url-any-origin-may-use-and-each-is-shown-as-the-core-makes-it-ready-or-says-why-it-could-not)):
  taken with the camera or chosen from the gallery on a product's page, a large one made 2,048
  pixels a side in the browser, uploaded straight to storage and added to the product; each shown
  as the core makes it ready or says why not; another made the main one, or removed.
* **Tried against the core and its worker:** a 5.3 MB photo went up as 1.6 MB, it and a PNG were
  made ready within seconds, a HEIC that could not be read was refused, another photo was made the
  main one and one removed, and the list showed the product's photo; with no errors in the browser.
* **For it:** the development API's storage answers CORS for its signed URLs, as R2's bucket rule
  will; the product's form keeps what was typed while photos are made ready.
* 1891 tests: uploading, refusing and reordering photos through the real screens.

### 15795d9 · Products in the admin

* **The products section** ([ADR-267](../architecture/13-decision-log.md#adr-267--the-admins-products-a-list-by-status-and-search-a-products-page-that-owners-and-managers-change-and-every-other-role-reads-and-adding-a-product-with-its-options-variants-each-with-its-price-and-stock-stock-is-counted-at-the-shops-primary-location-set-where-the-merchant-typed-it-and-refused-if-it-changed-since-it-was-read)):
  the list by status and search, with each product's stock and price; adding a product, with
  options that make a variant of each combination, each with its price and stock; a product's
  page that saves only what changed, its counts refused if they changed since they were read;
  deleting one; and the same pages read alone by roles that do not change products.
* **Tried against the core:** the seed's owner added a kurta in three sizes with their prices and
  stock, changed a size's price and a count and made it a draft, added a shawl with a price before
  its discount, and had a price that was not one caught; an agent saw the products with nothing
  to change; in English and Urdu, on a phone and a desktop, with no errors in the browser.
* **For it:** the admin's screen tests share a fake core and a signed-in member
  (`src/test-support.tsx`); a status shown as a pill is the shared `Badge`; the Confirmation
  Desk's name is shorter in the phone's bottom bar.
* 1884 tests: adding, checking and saving products through the real screens and router.

### a459501 · The Confirmation Desk in the admin

* **Agents' own screen** ([ADR-266](../architecture/13-decision-log.md#adr-266--the-admins-confirmation-desk-deals-an-agent-one-order-at-a-time-when-they-ask-and-the-next-as-soon-as-a-calls-outcome-is-recorded-the-customers-number-stays-masked-until-the-agent-asks-to-see-it-which-is-logged-and-then-can-be-called-or-messaged-on-whatsapp-with-a-tap-an-order-whose-call-is-recorded-leaves-the-agents-queue-at-once)):
  an order dealt to the agent when they ask; the customer, the risk's reasons, the items, the
  address and the cash to collect; the number shown when they ask, which is logged, then a tap
  from a call or a WhatsApp chat; the call's outcome in a tap, with a note, and the next order
  dealt at once; below, every order due now.
* **Tried against the core:** a confirmation agent signed in by email, took the next order,
  showed its number, recorded no answer, was dealt the next and confirmed it, leaving the desk
  empty; in English and Urdu, on a phone and a desktop, with no errors in the browser.
* 1872 tests: the desk through the real screens and router, against a fake core.

### 0055f01 · Signing in, a shop's Home and its orders in the admin

* **The merchant admin's first loop** ([ADR-265](../architecture/13-decision-log.md#adr-265--the-merchant-admin-is-a-react-app-on-an-origin-of-its-own-that-sends-auth-and-the-admin-api-on-to-the-core-staff-sign-in-by-a-code-to-their-mobile-or-by-email-with-the-second-step-their-role-needs-the-sessions-opaque-tokens-are-kept-in-the-browsers-storage-and-refreshed-by-one-tab-at-a-time-the-shop-is-in-each-pages-address-and-every-graphql-document-it-sends-is-checked-against-the-cores-schema)):
  signing in by a code to the mobile or by email, the second factor, a new account's name and
  first shop, and the second step set up where the role needs it; Home's next actions in rupees,
  today's numbers and the setup checklist; the orders list by stage, searched, with orders
  confirmed or packed at once; an order's page, confirmed, packed or cancelled for a reason.
* **Tried against the core:** the seed's owner signed in with the second step, confirmed an
  order from its page on a phone-sized screen, switched to Urdu and back, kept the session
  through a reload and signed out, with no errors in the browser.
* **For it:** the session store, sharing and refreshing tokens across tabs; the router and the
  shell; `pnpm dev:admin`.
* 1867 tests: signing up by mobile through the real screens, the session's refreshes, every
  GraphQL document against the schema, and the words.

### 933a536 · The merchant admin's scaffold

* **`apps/admin-web`**: React 19 and Vite, TanStack Router and Query to come, Tailwind CSS v4 over
  Hatti UI's tokens (`themeStylesheet()` as a virtual stylesheet, light and dark), Inter and Noto
  Nastaliq Urdu, English and Urdu with the page right to left in Urdu, and the design system's
  formats for money, phones and dates. In development Vite sends `/auth` and `/admin/api` on to
  the core, so the browser sees one origin.
* **Every GraphQL document it sends is checked against `apps/core/schema.graphql`**, so a field
  renamed in the API fails the admin's tests.

### c63d154 · Free's domains and gateways

* **Free connects no domain of the shop's own nor payment gateways** ([ADR-264](../architecture/13-decision-log.md#adr-264--a-plan-says-whether-it-includes-a-domain-of-the-shops-own-and-accounts-with-payment-gateways-and-free-includes-neither-connecting-one-on-a-plan-without-it-is-refused-with-the-plan-named-through-the-port-other-modules-ask-a-plans-limits-through-and-those-connected-before-are-kept-checked-changed-and-used-as-before)):
  `domainCreate` and `paymentGatewayAccountConnect` refuse, naming the plan; those connected
  before are kept, checked, changed and used as before.
* **For it:** `PlanAllowance.excludes` and `planFeatureMessage`; `customDomains` and
  `onlineGateways` on each plan and `BillingPlan`.
* 1845 tests: each refusal, through HTTP too, what was connected before, and Growth connecting
  both.

### a4664e4 · Free's orders a month

* **Orders past Free's 50 a month are taken but locked** ([ADR-263](../architecture/13-decision-log.md#adr-263--a-shop-on-a-plan-that-limits-its-orders-a-month-frees-50-takes-every-order-all-the-same-one-past-the-limit-counted-in-the-shops-time-zone-without-those-cancelled-comes-in-with-its-customer-hidden-from-staff-and-cannot-be-confirmed-packed-booked-or-shipped-until-a-plan-without-the-limit-frees-it-or-a-counted-order-of-its-month-is-cancelled-the-owner-is-told-at-four-fifths-of-the-limit-and-at-it)):
  counted by the month in the shop's time zone, cancelled ones not; one past the limit comes in
  with its customer hidden from staff, and cannot be confirmed, packed, booked or shipped until a
  counted order of its month is cancelled or the shop chooses a plan without the limit. The owner
  is told at 40 and at 50.
* **For it:** migration 0166; `PlanAllowance.limitIn` and `ordersPerMonth`; `Order.overPlanLimit`;
  `OrderService.releaseOverLimit`; the `orders_limit_near` and `orders_limit_reached` notices; the
  worker's `PlanOrders`.
* **Urdu handles** are not wanted for now, as decided on 2026-10-07; simplification 113 says so.
* 1843 tests: the count, the notices, what staff see and may do, and orders freed.

## 2026-10-07

### 3f3a65b · Shops' domains checked again

* **The worker checks verified domains every six hours** ([ADR-262](../architecture/13-decision-log.md#adr-262--shops-verified-domains-are-checked-again-every-six-hours-by-the-worker-one-dns-points-elsewhere-is-noted-and-its-shop-told-once-at-its-alerts-number-and-its-owners-email-and-three-days-on-it-is-disconnected-verified-no-more-nor-primary-the-shops-address-on-the-platforms-domain-primary-in-its-place)):
  one DNS points elsewhere is noted, still served but never made primary, and its shop is told
  once at its alerts number and its owner's email; three days on it is disconnected, and the
  shop's address on the platform's domain is primary in its place.
* **For it:** migration 0165; `DomainService.recheck` and `domainsToCheck`; `Domain.unpointedSince`;
  the `domain_unpointed` notice; the worker's `DomainChecks` and `DomainNotices`, and `tellShop`,
  which Hatti's notices of bills share.
* 1841 tests: each way a check ends, the sweep's batches, and the notice.

### cd67743 · Translations deleted with what they translate

* **A translation goes with what it translates** ([ADR-261](../architecture/13-decision-log.md#adr-261--a-translation-is-deleted-with-what-it-translates-whichever-way-that-goes-by-triggers-on-the-tables-of-what-may-be-translated-as-a-foreign-key-would-if-one-column-could-name-ten-kinds-a-menus-items-as-the-menu-goes-or-an-update-drops-them)):
  triggers on the catalog's and the online store's tables delete the translations of the rows a
  statement deletes, alone or by a cascade, and a menu's items' as the menu goes or an update
  drops them, in the same transaction.
* **What went before:** migration 0164 deletes the translations of what was deleted before it,
  all but the shop's own.
* **For it:** migration 0164; simplification 113 narrowed.
* 1837 tests: each way a translated thing goes, and the migration.

### 1d6092b · Couriers' city names shared across shops

* **A name three shops gave a city alike is every shop's** ([ADR-260](../architecture/13-decision-log.md#adr-260--a-name-for-a-city-with-a-courier-that-three-shops-gave-alike-which-no-shop-gave-otherwise-is-every-shops-after-the-shops-own-and-hattis-hattis-people-keep-hattis-names-with-a-command-which-settles-a-city-shops-named-wrong)):
  where three shops or more gave a city the same name with a courier, and none gave another, a
  parcel to it books by that name for every shop, after the shop's own and Hatti's. A system
  function reads the names across shops and returns the agreed one alone.
* **Hatti's people keep Hatti's names:** `courier-cities list|keep|forget` shows shops' names by
  city, how many gave each, and whether shared or disputed, and keeps Hatti's, which settles a city
  shops named wrong.
* **For it:** migration 0163; `CourierCityReview` in `@hatti/logistics`; `CourierCitySource`'s
  `SHOPS`.
* 1835 tests: names shared at three shops, withdrawn and shared again, Hatti's first, and
  shops refused Hatti's.

### 68e83dd · A map pin for the address

* **Where the customer's phone is, at the delivery address** ([ADR-259](../architecture/13-decision-log.md#adr-259--a-delivery-address-may-carry-a-pin-where-the-customers-phone-is-at-the-address-checkouts-and-customers-links-address-forms-add-it-by-the-pages-first-script-allowed-by-its-hash-it-is-kept-in-pakistan-and-near-the-city-typed-as-shopifys-latitude-and-longitude)):
  checkout's page and the address forms of orders' and drafts' links offer "Add my location",
  the pages' first script, allowed by its hash. The pin is kept with the address when it is in
  Pakistan and within 80 km of the city typed; the page says how far one is otherwise. The Admin
  API has Shopify's `latitude` and `longitude`; customers' pages link the pin on the map, and
  order exports have it in a column of its own.
* **For it:** `renderPage` takes scripts; `@hatti/pk` has its cities' centres and how far a pin
  is from them; migration 0162 gives addresses kept before none.
* 1834 tests: pins read, placed, refused and taken off through checkout, links and the API;
  the pages' script allowed by its hash alone; exports and erasure with the pin.

### 9b88acf · Products' videos

* **Videos among a product's media** ([ADR-258](../architecture/13-decision-log.md#adr-258--products-videos-an-mp4-or-quicktime-file-the-shop-uploads-h264-and-aac-as-phones-record-them-read-box-by-box-and-kept-as-it-is-but-for-where-it-was-taken-served-a-range-at-a-time-with-the-preview-image-its-uploader-gives-or-a-youtube-or-vimeo-video-by-its-address-its-hosts-image-its-preview-themes-have-them-as-shopifys-media)):
  `productCreateMedia` takes `VIDEO`, a staged upload of an MP4 or QuickTime file with its
  `previewImageSource`, and `EXTERNAL_VIDEO`, a YouTube or Vimeo address. The worker checks an
  uploaded one box by box, H.264 and AAC, and keeps it without where it was taken; the API serves
  it at `/videos` a range at a time. Themes have them in `product.media`, with Shopify's video
  filters, and Hatti Base plays them in its gallery.
* **For it:** migration 0161; `cleanVideo` in `@hatti/images`; video uploads up to 100 MiB, and
  `ObjectStorage.stream`, in `@hatti/storage`.
* 1826 tests: videos read and refused as phones make them; previews from their hosts; served
  whole and in ranges through the API; documents and themes showing them.

### 4f38c98 · Products' images cropped

* **A crop and a focal point for each image** ([ADR-257](../architecture/13-decision-log.md#adr-257--the-merchant-crops-a-products-image-and-marks-what-matters-in-it-a-crops-clean-copy-is-made-from-the-whole-images-as-it-is-set-and-kept-beside-it-each-size-and-format-made-from-it-at-an-address-naming-the-crop-the-whole-kept-to-crop-again-the-focal-point-in-percent-of-the-image-shown-is-shopifys-for-themes-and-image_tag)):
  `productUpdateMedia` takes `crop` and `focalPoint`; the crop's clean copy is made from the whole
  image's as it is set, and served at an address of its own at every size and in every format;
  `ProductMedia.image` is the crop, `wholeImage` the whole, to crop again. Themes have the focal
  point as Shopify's `image.presentation`, and `image_tag` keeps it in sight.
* **For it:** migration 0160; `cropImage` in `@hatti/images`, which the catalog now uses.
* 1816 tests: crops checked and made, the whole kept, a new one clearing the focal point;
  served through the API at their own addresses, no other crop made; focal points in Liquid.

### 6d0b1c7 · The shop's activity log

* **What staff and apps change, by whom** ([ADR-256](../architecture/13-decision-log.md#adr-256--what-the-shops-staff-and-apps-change-goes-on-its-activity-log-each-event-a-request-of-the-admin-api-records-written-in-the-same-statement-as-the-outboxs-by-whom-and-to-what-never-what-it-recorded-in-a-table-of-its-own-kept-as-long-as-the-audit-log)):
  `activityLog(first, after, subjectId, type)` lists each change made through the Admin API, the
  latest first: the event it recorded, what it happened to and who made it, a member of staff
  with their role or an app; never what it recorded. Owners and managers, and apps with
  `read_settings`.
* **For it:** migration 0159, `platform.activity_log`, written in the same statement as the
  outbox's events while a request runs as its caller (`actingAs`).
* **Learned:** the log was read from the outbox first, through a function of the database's,
  then given a table of its own: the outbox is to keep its events for days, and the log must
  last as long as the audit log.
* 1812 tests: a request's events on it by whom and the worker's not, none of a transaction
  rolled back, a page at a time, by subject and by type, another shop seeing none; through the
  API, a manager's and an app's changes, a packer refused.

### da3dc64 · JazzCash's refunds

* **What a card or a JazzCash wallet paid goes back from the order** ([ADR-255](../architecture/13-decision-log.md#adr-255--what-a-card-or-a-jazzcash-wallet-paid-goes-back-through-jazzcashs-refunds-a-wallets-with-the-mpin-the-shop-gives-a-payment-keeps-how-its-customer-paid-as-its-gateway-said-and-a-voucher-paid-at-a-shop-goes-back-another-way-claimed-whole-until-tried-against-its-sandbox)):
  `orderRefund` by `ONLINE` asks JazzCash's card refund, or its wallet refund with the MPIN the
  shop gave, by how the payment says its customer paid; a voucher paid at a shop, or a wallet's
  payment without the MPIN, is refused before JazzCash is asked, saying how to give it back.
  Claimed whole until tried against its sandbox.
* **For it:** migration 0158, how each payment was made, as its gateway said; `PaymentSession.method`;
  credentials an account may go without, `PaymentGatewayCredentialField.optional`, as JazzCash's
  wallet MPIN.
* 1810 tests: each refund asked as JazzCash takes it, its refusals and what may have gone
  through; the method kept and passed on; the MPIN checked; through the API.

### a724913 · Hatti's invoices paid by transfer or Raast

* **Paid into Hatti's own account** ([ADR-254](../architecture/13-decision-log.md#adr-254--a-shop-pays-hattis-invoice-by-transfer-or-raast-into-hattis-own-bank-account-its-owner-giving-the-transfers-reference-hattis-people-confirm-it-once-they-find-it-which-pays-the-invoice-as-a-gateways-payment-does-with-what-its-other-payments-brought-or-refuse-it-saying-why-and-the-owner-hears-either-way)): an open
  invoice's page and `billingBankAccount` show Hatti's account and Raast ID; the owner says they
  paid with `billingInvoiceTransferReport` and the transfer's reference; Hatti's people list the
  transfers waiting and confirm or refuse each with `pnpm --filter @hatti/core
  billing-transfers`, which pays the invoice as a gateway's payment does. The owner hears either
  way, on WhatsApp and by email.
* **An invoice is paid by its payments together:** one short of it waits for the rest, which a
  second transfer brings.
* **For it:** migration 0157, a transfer's reference and who checked it on `billing.payments`;
  `BILLING_BANK_TITLE`, `BILLING_BANK_NAME`, `BILLING_BANK_IBAN` and `BILLING_RAAST_ID`;
  `BillingInvoice.transfers`; the `transfer_confirmed` and `transfer_refused` notices; public
  IDs `btr_…`.
* 1807 tests: said, refused, confirmed short and then in full, and confirmed for an invoice
  paid online; the notices; the settings; through the API end to end.
* **Before it, b0a6cbe:** the test of staff's alerts of a transfer's receipt sorts them by
  number: queued in one transaction, they came out in no order of their own, which failed the
  full suite once.

### b4aa0ea · Courier pickups through couriers' APIs

* **A pickup hands an account's parcels to its courier** ([ADR-253](../architecture/13-decision-log.md#adr-253--a-courier-accounts-parcels-waiting-to-be-picked-up-are-handed-to-its-courier-through-its-api-postexs-load-sheet-for-its-pickup-address-and-leopards-naming-the-rider-who-takes-them-each-pickup-keeps-its-parcels-and-the-couriers-sheet-and-a-parcel-its-rider-missed-goes-in-the-next-a-day-later)): `courierPickupRequest`
  asks PostEx for its load sheet of the parcels waiting, for the account's pickup address, and
  keeps the PDF it sends; Leopards for its own, naming the rider who takes them, and keeps its
  number. The parcels are claimed before the courier is asked, so none goes twice; one its rider
  missed goes in the next a day later; a refusal leaves them for the next.
* **For it:** migration 0156, `logistics.pickups` and the parcels each handed over; the
  adapters' `pickup`; `courierPickups`, `courierPickup`, and `courierLoadSheet` of a pickup;
  public IDs `pkp_…`.
* 1802 tests: handed over, refused and asked again; Leopards' rider; PostEx's and Leopards'
  requests and refusals; through the API end to end.

### 865d6de · Maintenance mode for an open shop

* **A storefront paused for a while** ([ADR-252](../architecture/13-decision-log.md#adr-252--an-open-shop-can-pause-its-storefront-for-a-while-every-page-answers-503-with-a-page-saying-when-it-is-back-and-checkout-takes-no-orders-until-its-staff-open-it-again-or-the-time-they-set-comes)): staff pause it through the Admin API with a
  message and, if they like, a time it opens again by itself; every page then answers 503 with a
  page saying when it is back, its WhatsApp and its tracking page, and `Retry-After`, so search
  engines keep its pages; checkout takes no orders, at the storefront or the core's address,
  while orders placed before, their links and the tracking page carry on.
* **For it:** migration 0155, the pause kept with the online store's preferences; the shop's
  document carries it; the storefront's page in the platform's markup, `@hatti/documents`; the
  checkout's paused page.
* 1797 tests: paused, refused and opened again, by staff or at its time; published; the
  storefront's pages, scripts and open routes; checkouts paused and taking orders again; through
  the API end to end.
* **Before it, cfbaacf:** the sales report's end-to-end test reads the clock once for its
  period, which a millisecond passing between two readings made fail now and then.

### 7a2d2e3 · A tracking page found by tracking number

* **`/track` on the shop's storefront** ([ADR-251](../architecture/13-decision-log.md#adr-251--the-shops-storefront-has-a-tracking-page-where-a-customer-finds-their-order-by-its-number-or-a-tracking-number-with-the-mobile-number-they-ordered-with-and-sees-its-parcels-steps-but-nothing-of-its-address-or-items)): a customer finds their order by its number or a
  parcel's tracking number with the mobile number they ordered with, and sees how it is doing
  and each parcel's steps, but nothing of its address or items; a wrong number finds nothing,
  as an order the shop lacks does.
* **For it:** the orders module's `OrderTrackingService` and page, the core's route for
  storefronts, the storefront API's `trackingPage`, and the storefront's `/track`, ten lookups a
  minute from an address.
* 1790 tests: found by number or tracking number, not by another number or shop, nothing of
  the address shown; the storefront's route and limit; through the API end to end.

### 03c7f0d · Sales beside the period before, and refunds

* **The period before** ([ADR-250](../architecture/13-decision-log.md#adr-250--the-sales-report-says-what-the-period-as-long-just-before-came-to-and-the-home-what-yesterday-came-to-by-this-time-of-day-refunds-are-said-beside-sales-not-taken-off-them)): the sales report gives what the period as long just before
  came to, and the home's today what yesterday came to by this time of day.
* **Refunds beside sales:** each tally gives the money given back on its orders, not taken off
  net sales, which take off the items that came back already.
* 1785 tests: the period before and refunds in it, yesterday by this time of day, through the
  API too.

### 4f787e7 · Checkout's codes limited by internet address

* **20 codes an hour from one address** ([ADR-249](../architecture/13-decision-log.md#adr-249--checkout-sends-one-internet-address-at-most-20-codes-an-hour-across-a-shops-checkouts-each-code-keeping-the-address-it-was-asked-from-until-its-checkout-goes)): each code checkout sends keeps the internet
  address it was asked from, and the shop's checkouts send one address at most 20 an hour,
  whatever numbers it types; past it the page says so, as past the other limits.
* **For it:** migration 0154, `checkout.number_codes.ip`, gone with its checkout a day on.
* 1784 tests: the limit across checkouts and numbers, another address and an hour on, and
  what isn't an address.
* **The storefront's tests given 30 seconds each**, as the core's and the modules' are: two that
  make a hundred requests, or check passwords with a slow hash, ran past the default five under
  the whole suite's load, though under a second alone; and the one render test left on the
  renderer's own budget of 150 ms, which the load ran past, cutting its page short, given the
  10 seconds the others have.

### f0b4750 · Payment links for many customers

* **A link the shop shares once** ([ADR-248](../architecture/13-decision-log.md#adr-248--a-payment-link-the-shop-shares-once-opens-a-checkout-of-each-customers-own-with-its-items-and-discount-code-until-staff-close-it-its-time-passes-or-its-orders-run-out-one-taken-prepaid-alone-offers-no-cash-on-delivery)): staff make it through
  the Admin API with items, a code, a limit of orders, a time it closes, and prepaid alone if
  they like; each customer who opens `/pay/<token>` on the storefront gets a checkout of their
  own and places an order of their own, until staff close it, its time passes or its orders run
  out, its open checkouts then placing nothing.
* **For it:** migration 0153, `checkout.payment_links` and the link a checkout names; the
  checkout's page says why a link opens nothing, and why one prepaid alone takes no cash on
  delivery; the storefront API opens links; public IDs `plnk_…`.
* 1783 tests: links made, refused, changed and listed; checkouts of their own, counted,
  closed and used up; prepaid alone; the storefront's route; through the API end to end.

## 2026-10-06

### 53dba13 · Telling staff a transfer receipt came

* **A receipt tells staff on WhatsApp** ([ADR-247](../architecture/13-decision-log.md#adr-247--staff-hear-on-whatsapp-the-moment-a-customer-sends-the-receipt-of-their-transfer-for-an-order-still-waiting-for-it-whoever-has-the-order-else-the-shops-owners-and-managers-once-a-receipt)): the moment a customer sends
  the receipt of their transfer through their link, whoever has the order is told, else the
  shop's owners and managers, once a receipt each, in their own language; nothing once the
  order is paid or cancelled.
* **For it:** `staffPhonesIn` gives each member's role, `staffAlertFactsIn` whether the order
  still waits for its transfer, and messaging the `order_receipt_sent` alert, which the shop may
  turn off.
* 1769 tests: told by role and by whom the order is given to, not when paid since, nor for
  other changes; the alert's words in English and Urdu.

### a64747d · Couriers' statements from Excel files

* **The workbook a courier sends** ([ADR-246](../architecture/13-decision-log.md#adr-246--a-couriers-statement-may-come-as-the-excel-workbook-it-was-sent-as-read-from-its-first-sheet-shown-by-a-reader-of-hattis-own-under-a-header-found-below-the-couriers-title-rows-and-other-cash-on-a-parcel-paid-short-before-pays-what-its-order-still-owes)): `codRemittanceImport` takes `xlsx`,
  the workbook in base64, read by a reader of Hatti's own in `@hatti/xlsx`: the first sheet
  shown, its numbers whole, so long tracking numbers keep their digits; .xls and locked
  workbooks are refused, saying how to save them.
* **Read as a CSV is:** the header found under a courier's title rows, empty rows passed over,
  the sheet's own row numbers; a CSV's tracking number Excel shortened is reported.
* **A shortfall paid later:** other cash on a parcel whose order the courier paid short is
  received; the same cash again, or an order owing nothing since, stays `repeated`.
* 1768 tests: workbooks as Excel, Google Sheets and LibreOffice keep them, and those refused;
  statements from them, the same as their CSV; shortfalls across statements, through the API too.

### 697e791 · The home page's words in Urdu

* **The shop translated as Shopify's `SHOP`** ([ADR-245](../architecture/13-decision-log.md#adr-245--the-shops-own-words-for-its-home-page-may-be-translated-into-urdu-the-shop-a-translatable-resource-of-its-own-by-its-own-id-as-shopifys-shop-is-its-document-carries-them-beside-its-own-words-and-its-urdu-pages-show-them)): its home page's SEO title
  and description, by the shop's own ID, through the translations API; no migration, as
  translations are kept by what they translate's ID.
* **On the storefront:** the shop's document carries them beside its own words; its Urdu pages
  show them as the home page's title and description, `shop.description` and the website's
  structured data, and the edge forgets all the shop's pages when they change.
* 1760 tests: listed, kept and refused, another shop's not found, through the Admin API too;
  published and removed; shown on Urdu pages and not on English ones.

### 27f1015 · A blog for search engines

* **A blog's own words for search engines** ([ADR-244](../architecture/13-decision-log.md#adr-244--a-blog-may-be-given-a-title-and-description-of-its-own-for-search-engines-as-its-articles-may-its-pages-give-them-in-place-of-its-title-and-of-the-shops-description-its-articles-keep-their-own-and-the-shop-may-translate-them-into-urdu)): a title and description,
  as its articles have ([ADR-231](../architecture/13-decision-log.md#adr-231--products-collections-pages-and-articles-may-be-given-a-title-and-description-of-their-own-for-search-engines-as-shopifys-seo-has-them-themes-are-given-them-as-page_title-and-page_description-the-description-made-from-the-pages-own-text-where-the-shop-wrote-none-and-shopifys-product-csv-carries-a-products)); migration 0152
  keeps them, through `blogCreate` and `blogUpdate`, and the shop may translate them into Urdu.
* **On the storefront:** a blog's page and its tags' pages give them as `page_title` and
  `page_description`, the shop's description standing where it wrote none; its articles keep
  their own.
* 1756 tests: kept, cleared and refused, through the Admin API too; translatable and
  published beside its own; shown in English and Urdu, and not on its articles.

### b1683ae · The home page for search engines

* **The shop's own words for its home page** ([ADR-243](../architecture/13-decision-log.md#adr-243--a-shops-home-page-has-a-title-and-description-of-its-own-for-search-engines-as-shopifys-preferences-keep-them-and-a-social-sharing-image-one-of-its-files-which-link-previews-show-of-pages-without-an-image-of-their-own-through-shopifys-page_image)): a title and description
  for search engines, as Shopify's preferences keep them, and a social sharing image, one of its
  files; migration 0151 keeps them, through `onlineStorePreferencesUpdate`.
* **On the storefront:** the home page's title and description, `shop.description`, the website's
  structured data with it, and `page_image`, a page's own image else the sharing image, which
  Hatti Base's link-preview tags read as Dawn's do; the API serves the image at
  `/sharing-images/{shop}`.
* 1753 tests: kept, cleared and refused; published in the shop's document and gone with the
  file; shown on the home page and elsewhere; and served while the shop has it.

### e247033 · A refund's receipt

* **Money staff sent keeps its receipt** ([ADR-242](../architecture/13-decision-log.md#adr-242--a-refund-staff-sent-by-hand-may-keep-its-receipt-staged-as-any-upload-is-and-given-with-the-refund-its-order-keeps-it-among-its-receipts-never-as-one-of-the-shops-files-and-it-goes-with-the-customers-erasure-as-their-own-receipts-do)): a photo or a PDF of the
  transfer, staged as any upload is and given with the refund by its `resourceUrl`, for refunds
  by bank transfer, mobile wallet, cash or another way.
* **The order's, never the shop's files:** copied among the order's receipts, the staged upload
  taken from the files module in the refund's transaction; a refund refused leaves the upload
  for the next try. Migration 0150 keeps it on the refund.
* **Shown and erased with its order:** `Refund.receipt` gives a URL signed for an hour; the
  customer's erasure clears it and the worker removes its file, as their own receipts'.
* 1749 tests: a receipt kept, its upload taken, refused for what is no receipt or no money sent
  by hand, kept for the next try, shown through the Admin API, and gone with the customer's data.

### 06ad1c4 · Options in Urdu

* **A product's options and their values in Urdu** ([ADR-241](../architecture/13-decision-log.md#adr-241--a-products-options-and-their-values-may-have-the-shops-urdu-as-shopifys-translations-keep-them-each-by-its-own-id-the-products-document-carries-its-options-in-urdu-and-its-urdu-pages-show-each-variants-values-and-title-in-them-the-variant-chosen-by-its-id-the-same-in-either-language)), as Shopify's
  translations keep them, `PRODUCT_OPTION` and `PRODUCT_OPTION_VALUE`, by their own IDs, their
  `name` on one line; migration 0149 allows the key.
* **In the product's document:** each translation names its product, whose document holds its
  options in Urdu in their own order; values no variant has are left out, and an option whose
  values would read the same keeps its own words for them.
* **On Urdu pages:** each variant's values and title in its options' Urdu, its ID its own, so the
  variant a shopper chooses is the same in either language; themes need nothing new.
* 1748 tests: options and values kept, refused, listed and told to their product; published in
  their product's document and removed; shown on an Urdu page with the variant chosen; and
  through the Admin API.

### 8b463b0 · Search in Urdu

* **Found by the shop's Urdu** ([ADR-240](../architecture/13-decision-log.md#adr-240--a-storefronts-search-finds-products-pages-and-articles-by-the-shops-urdu-for-them-as-by-its-own-words-from-words-of-each-translation-kept-folded-beside-its-own-as-its-translations-change-its-own-words-first)): products by their Urdu titles and
  types, pages and articles by their Urdu titles and text, as by their own words, on the search
  page and in its suggestions, a typo in Urdu forgiven as in English.
* **Kept beside the own words:** migration 0148 gives products, pages and articles
  `translated_text`, which the online store writes as their translations change, a product's
  through the catalog; a search reads both, the own words first.
* 1744 tests: found by Urdu titles, types and text, a typo forgiven, by the own words still, and
  not once the Urdu is removed.

### ca2fcb6 · Policies in Urdu

* **A policy's Urdu** ([ADR-239](../architecture/13-decision-log.md#adr-239--a-shops-policies-may-have-its-own-urdu-as-its-other-content-may-and-the-storefront-shows-a-policys-urdu-only-while-it-translates-the-policy-as-it-is-its-own-words-once-they-change-the-checkouts-urdu-links-the-urdu-pages)), through the translations API as Shopify's
  `SHOP_POLICY`, its body cleaned as the policy's is; migration 0147 allows the key.
* **Only while it translates the policy as it is:** a policy's words are the terms customers
  agree to, so once the shop changes them, Urdu pages show its own words until the Urdu is
  written again.
* **On the storefront and at checkout:** the publisher keeps it beside the policy's body, an Urdu
  policy page reads both in one round trip, and the checkout's Urdu sentence on what placing the
  order agrees to links the Urdu pages.
* 1743 tests: a policy's Urdu kept, cleaned, outdated and written again; given while current
  and published beside the policy; shown on its Urdu page; and linked from the checkout.

### d51738e · Content in Urdu

* **A shop's own Urdu for its content** ([ADR-238](../architecture/13-decision-log.md#adr-238--a-shops-products-collections-pages-blogs-articles-and-menus-may-have-its-own-urdu-as-shopifys-translations-keep-a-field-each-written-for-the-digest-of-the-shops-own-words-their-documents-carry-it-beside-those-words-and-the-storefronts-urdu-pages-show-it-in-their-place)), as Shopify's
  translations keep it: a product's title, description, type and SEO; a collection's, page's and
  article's title, body and SEO, and an article's summary; a blog's, menu's and menu item's
  title. Migration 0146 keeps a field each, with the digest of the shop's words it was written
  for.
* **Shopify's API:** `translatableResource(s)` gives each field with words and its digest;
  `translationsRegister` refuses a translation written for words since changed (STALE), and
  `translationsRemove` forgets one. A translation whose words changed is `outdated`, and still
  shown. New scopes, `read_translations` and `write_translations`, for owners, managers and
  marketers.
* **On the storefront:** documents carry their Urdu beside the shop's own words, and Urdu pages
  show it in their place, a menu's links and an SEO description among them; themes need nothing
  new.
* 1741 tests: translations kept, refused, replaced, outdated and removed; listed a page at a
  time; written into documents and shown on Urdu pages; and the API's scopes.

### 424177e · Structured data beyond products

* **Articles as schema.org's `BlogPosting`** ([ADR-237](../architecture/13-decision-log.md#adr-237--search-engines-are-told-an-articles-page-is-schemaorgs-blogposting-through-shopifys-structured_data-and-a-shops-home-page-the-shops-organization-and-website-through-the-same-filter-given-the-shop)), through Shopify's
  `structured_data`, as Dawn's article page prints it: the headline, the address, when it was
  published and last changed, its image whole at the shop's address, and its author, else the
  shop, with the shop as its publisher.
* **The shop on its home page,** as its `Organization` and `WebSite`, through the same filter
  given `shop`: its name, address and logo, else its square logo, and the site's name, which
  Google shows beside its results. Hatti Base prints it on the home page alone, in both languages.
* **Left out, as Google doesn't read them:** an article's description, and Dawn's `SearchAction`.
* 1730 tests: an article's data with and without an author, an image and a change, and the
  shop's on its home page alone, with its logo, its square logo or none.

### 0f42997 · Sitemaps that say when pages changed

* **Each address's `lastmod` and image** ([ADR-236](../architecture/13-decision-log.md#adr-236--a-shops-sitemaps-say-when-each-page-last-changed-and-give-its-image-from-an-entry-kept-beside-each-documents-handle-as-the-document-is-written-so-a-sitemap-reads-no-documents)), as Shopify's sitemaps
  give them: when a product, collection, page, blog or article last changed, to the second, else
  when it was published; a product's first image and an article's own, whole at the shop's address.
* **Kept beside the handles:** as the publisher writes a document, the same script keeps its
  sitemap entry in a hash by ID, so a sitemap page reads two hashes in one round trip rather than
  5,000 documents. Collections, pages and blogs now carry `updatedAt`; the documents' shape goes
  to 15.
* 1729 tests: entries kept, moved with a handle and gone with their document in Valkey, and
  the sitemaps' `lastmod` and images.

### 040dada · Delivery estimates

* **How many working days delivery takes** ([ADR-235](../architecture/13-decision-log.md#adr-235--a-shop-may-say-how-many-working-days-delivery-takes-everywhere-and-in-each-of-its-delivery-zones-the-cart-and-product-pages-say-it-wherever-delivery-goes-from-the-fewest-days-anywhere-to-the-most-and-checkout-says-it-for-the-shoppers-city)), everywhere and in each
  delivery zone, through `deliverySettingsUpdate`'s `days`; a zone without its own takes
  everywhere's. Migration 0145 adds everywhere's to `checkout.delivery_settings`, and a zone's sits
  in its JSON.
* **Checkout says it for the shopper's city**, under the delivery charge, in English and Urdu;
  before a city is typed, the fewest days anywhere to the most.
* **The cart and product pages say it too:** Hatti's `delivery` gains `min_days` and
  `max_days`, and Hatti Base's cart, drawer and product page phrase them through a
  `delivery-days` snippet, in place of its own "2 to 5 days" where the shop said. The documents'
  shape goes to 14.
* 1728 tests: the days kept, refused and read for a city or wherever delivery goes, said at
  checkout and on the storefront, and published in the shop's document.

### 0275a9d · Search that forgives a typo

* **A search that finds nothing as typed is read again** ([ADR-234](../architecture/13-decision-log.md#adr-234--a-storefront-search-that-finds-no-product-with-every-word-as-typed-reads-each-word-none-of-the-shops-products-holds-as-the-shops-own-words-a-typo-or-two-from-it-a-typo-being-a-letter-added-taken-away-or-changed-or-two-swapped-and-shows-those-with-the-fewest-typos-first)): each word
  none of the shop's products holds is corrected to the shop's own words a typo or two from it.
  A typo is a letter added, taken away or changed, or two swapped. "kirta" finds kurtas, and
  "peshwari chapal" Peshawari chappals; a search that worked finds what it did.
* **One typo for words of four to seven letters, two for longer ones,** and none in shorter
  words or numbers. Every word must still be there, and those with the fewest typos come first.
  Suggestions match the word still being typed against the starts of the shop's words.
* **No extension:** `@hatti/pk`'s `typoDistance` and `correctionsOf` compare the shop's words in
  the core, and the courier city names' nearest names now count typos the same way. A corrected
  search took about 35 ms for a shop of 10,000 products.
* 1724 tests: typos counted and words corrected, and the catalog's search forgiving them, the
  storefront's API included.

### b4d7760 · Couriers' city names

* **Booked as the courier names the city** ([ADR-233](../architecture/13-decision-log.md#adr-233--a-parcels-city-is-booked-as-its-courier-names-it-the-shops-own-name-for-it-else-hattis-else-the-couriers-lists-matched-through-pakistans-names-for-the-city-and-their-aliases-a-city-the-list-names-none-of-fails-its-booking-with-the-couriers-nearest-names-and-the-name-staff-give-is-kept-for-the-shops-next-parcel)): a parcel's city is the
  shop's own name for it with the courier, else Hatti's, else the courier's list's, matched
  through Pakistan's names for the city and their aliases. A customer's "Pindi" reaches Leopards
  as Rawalpindi.
* **Couriers' lists of cities:** Leopards' is the list its bookings already use, and PostEx's is
  its operational cities. Each is kept a day, and PostEx's last list stands while it can't give
  one.
* **A city the list doesn't name fails its booking** with the courier's nearest names. Staff
  choose one with `courierCityNameSet`, the shop keeps it for its next parcel to the city, and
  they book the order again. `courierCityMatch` shows how a city matches, and
  `courierCityNames` lists the shop's names. Migration 0144 adds
  `logistics.shop_courier_cities`.
* 1720 tests: the names matched and suggested, both couriers' lists against stand-ins, the
  shop's names kept, forgotten and kept from other shops, and the worker failing a city its
  courier doesn't list until staff name it.

### 1b48b67 · The setup checklist's couriers and online payments

* **A step for couriers** ([ADR-232](../architecture/13-decision-log.md#adr-232--the-setup-checklist-asks-for-a-courier-account-the-test-couriers-aside-and-counts-a-payment-gateways-account-in-its-production-as-a-way-to-be-paid-ahead-as-it-counts-a-bank-account)), after delivery: done while the shop has a
  courier account not archived, the test courier's aside.
* **Payments done by a gateway too:** a gateway's account in its production takes real money,
  so a shop paid online alone is ready to be paid ahead, as one with a bank account for
  transfers is. Sandboxes and the test gateway count for nothing.
* 1709 tests: the checklist's test takes eight steps, couriers and gateways among them.

### f189127 · Titles and descriptions for search engines

* **Products, collections, pages and articles take `seo`** ([ADR-231](../architecture/13-decision-log.md#adr-231--products-collections-pages-and-articles-may-be-given-a-title-and-description-of-their-own-for-search-engines-as-shopifys-seo-has-them-themes-are-given-them-as-page_title-and-page_description-the-description-made-from-the-pages-own-text-where-the-shop-wrote-none-and-shopifys-product-csv-carries-a-products)), as
  Shopify's: a title and a description of their own for search engines, each kept on one line,
  through the Admin API's `SEOInput`, a field left out as it was and null or blank clearing it.
  Migration 0143 adds the columns.
* **Shopify's product CSV carries a product's** as SEO Title and SEO Description, both ways: a
  shop leaving Shopify brings what it wrote there, and an update from a file sets them or clears
  one.
* **Themes get `page_title` and `page_description`:** the SEO title and description, else the
  page's own title and the start of its text, cut at a word at 160 characters. Hatti Base's
  link-preview tags read `page_description`. Documents carry `seo` (version 13).
* 1709 tests (6 new): products', pages' and articles' SEO kept, changed and cleared; the CSV's
  columns both ways; the storefront's head with and without them; and the Admin API's.

### 14115ee · Expired carts and checkouts swept

* **The worker deletes carts, checkouts and browsers' proofs of a number past their time**
  ([ADR-230](../architecture/13-decision-log.md#adr-230--carts-checkouts-and-browsers-proofs-of-a-number-are-deleted-once-past-their-time-by-a-sweep-in-the-worker-across-shops-and-the-longest-expired-first-each-shops-in-its-own-transaction-rather-than-by-shoppers-requests-as-their-shop-gets-new-ones)), across shops, every sweep: found with the system role, the longest
  expired first, a thousand of each kind at a time; each shop's deleted in its own transaction
  if still expired, so a cart changed since is kept; one shop's failure logged while the others
  go on.
* **Shoppers' requests no longer sweep.** Making a cart, starting a checkout and proving a
  number each lose a statement, and a shop that gets no new carts keeps no old ones, nor its
  customers' numbers in lapsed proofs. Migration 0142 indexes the three tables by expiry alone,
  in place of by shop and expiry (simplification 37).
* 1703 tests (2 new): the sweep across two shops, the longest expired first, a checkout's codes
  with it and one outlasting its cart going on without it; and the worker's batches, its count
  and a shop's failure logged.

### 2003922 · HBL

* **HBL's payment gateway, HBLPay** ([ADR-229](../architecture/13-decision-log.md#adr-229--hbls-payment-gateway-is-one-shops-take-payments-through-a-session-asked-for-with-the-order-encrypted-under-a-key-of-the-requests-own-which-hbls-public-key-wraps-with-the-password-its-return-encrypted-to-the-shops-own-public-key-believed-once-the-shops-private-key-opens-it-to-a-reference-of-hattis)), by its session API's second
  version: the order, its items where they add up and whom to bill, as JSON under AES-256-CBC
  with a key made for the request, the password and the key under HBL's public key; the customer
  sent to its page with the session.
* **Its return, encrypted to the shop's own public key,** opened block by block with its private
  key, and believed when it opens to a reference of Hatti's: 100, 0 or 00 a payment made, at the
  session's own amount. Keys may be pasted as PEM or XML: a credential field may now normalize
  what staff paste and allow a longer value. HBL publishes no status or refunds and sends no word
  but the return (simplification 109).
* 1701 tests (4 new): the session opened again by a stand-in with HBL's private key, refusals,
  the return opened with the shop's key, and an order paid through it from its page, its keys
  pasted as PEM.
* With this, shops take Safepay, JazzCash, Easypaisa, PayFast, Bank Alfalah, HBL and Baadmay.

### c405cd0 · Bank Alfalah

* **Bank Alfalah's page redirection** ([ADR-228](../architecture/13-decision-log.md#adr-228--bank-alfalahs-payment-gateway-is-one-shops-take-payments-through-a-handshake-whose-request-is-hashed-with-the-accounts-two-keys-then-a-form-with-its-token-hashed-the-same-way-posted-to-its-page-its-return-which-it-does-not-sign-believed-only-once-its-order-status-asked-at-once-says-the-payment-is-made)): a handshake, server to
  server, for a reference of Hatti's, its request hashed with AES under the account's two keys
  over its pairs in the bank's sample's order; then a form with its token, hashed the same way,
  posted to its page, which offers every way the account takes. The keys never leave Hatti.
* **Its return is not signed:** a return with a code of 00 names the payment, and its order
  status is asked at once, as it is hourly for a customer who never came back. Its answer, JSON
  perhaps written into a JSON string, is believed only naming the account's merchant, its store
  and the payment, and saying Paid. Its listener is not followed, and nothing is given back
  through its API (simplification 108).
* 1697 tests (6 new): the handshake and form opened again to their pairs, refusals, the return,
  the status against a stand-in, and an order paid through it from its page.

### 20aa5d7 · PayFast

* **PayFast's hosted checkout** ([ADR-227](../architecture/13-decision-log.md#adr-227--payfast-is-a-gateway-shops-take-payments-through-an-access-token-asked-for-the-basket-and-its-amount-with-the-secured-key-then-a-form-with-the-token-posted-to-its-page-its-return-and-its-word-at-the-webhook-which-may-come-in-the-address-believed-by-their-validation-hash)): an access token asked for, server
  to server, for a basket of Hatti's and its amount in rupees with the secured key, then a form
  with the token posted to its page; back to the return address on success and to the page it
  came from on failure, and its word to the account's webhook address. The secured key never
  leaves Hatti.
* **Believed by its validation hash**, SHA-256 of the basket, the secured key, the merchant ID
  and the code: 000 or 00 a payment made, at the session's own amount, which the token held
  PayFast to. The webhook's address answers a GET too, its query read as a form, as PayFast may
  send its word there. Its status API is not asked, and nothing is given back through its API
  (simplification 107).
* 1691 tests (5 new): the token and form against a stand-in, refusals, the return and its word
  by their hash, an order paid by its word from its page, and through HTTP the word in the
  webhook's address. A test that took `payfast` for a gateway nobody knows takes `paypal` now.

### 0915f6a · Baadmay's buy now, pay later

* **Gateways that ask are given the buyer** ([ADR-226](../architecture/13-decision-log.md#adr-226--baadmays-buy-now-pay-later-is-a-gateway-shops-take-payments-through-the-order-its-items-and-its-customer-go-to-its-page-in-the-address-and-its-return-which-it-does-not-sign-is-believed-only-once-its-order-status-asked-at-once-names-the-order-and-the-amount-paid)): the order's
  customer, number, email, address, items and delivery charge (`orderBuyerIn`), and the account's
  webhook address, with each checkout.
* **Baadmay** (PAY-11), from its integration document, which publishes no API reference: the
  order goes to its page in the address as Base64 JSON, its items where they come to what is
  asked, Hatti's reference in the return address. Its return is unsigned and it sends no webhook,
  so its order status is asked at once, by the ID the customer came back with (`inquire` now
  takes the return), and believed only naming the order with the amount paid. Nothing is given
  back through its API. Its answer's fields are to be tried against its sandbox (simplification
  106).
* 1686 tests (5 new): the order in its page's address, its return and its status against a
  stand-in, and an order paid through it from its page.

### 3952dee · Storefronts left waiting swept

* **The build queue lists its shops** ([ADR-225](../architecture/13-decision-log.md#adr-225--a-shop-with-storefront-items-waiting-is-listed-in-valkey-until-a-drain-finds-none-left-and-the-worker-builds-the-shops-quiet-ten-minutes-what-their-events-tries-gave-up-on)) in `s:sf:waiting` while their items
  wait: adding lists a shop after its items are in, a drain that finds nothing left takes it off
  unless it was listed again since, and one that fails lists it again.
* **The worker builds the shops quiet ten minutes**, every minute (`STOREFRONTS_INTERVAL_MS`), a
  hundred at a time and the longest waiting first, each listed again from now so that one
  failing again is tried ten minutes on. What an event's ten tries gave up on, as through an
  outage of Postgres or Valkey, is built without waiting for the shop's next change.
* 1681 tests (3 new): the list kept by adds and drains, built or failed, and taken in order once
  quiet and not again at once; the sweep's batches and one shop's failure; and a product an
  event's publisher gave up on built by the sweep.

### 7740474 · An advance for products the shop tags

* **The shop's advance may name products' tags** ([ADR-224](../architecture/13-decision-log.md#adr-224--a-shops-advance-may-be-asked-only-of-orders-holding-a-product-it-tags-checkout-knows-the-carts-products-before-anything-is-typed-names-the-product-beside-cash-on-delivery-and-asks-a-cart-holding-none-for-nothing)) (migration 0141):
  asked only of orders holding a product tagged with one of them, in any letter case, its other
  conditions holding too; fifty at most, each once, through `cashOnDeliverySettingsUpdate`.
* **Checkout knows the cart's products before anything is typed:** a cart holding none is asked
  for no advance and told of none; one holding a tagged product names it beside the option, "With
  Bridal lehnga in your cart, you pay Rs 500 in advance by bank transfer", and takes it off what
  the door collects where nothing else waits on what is typed. Placing asks it as the page said.
* 1678 tests (4 new): the tags checked and the product found, in any letter case; the page's
  words in English and Urdu; carts with and without one, through checkout to their orders; and
  through the Admin API.

### 52bd0b8 · Migration tests given the time their databases take

* CI timed out customers' test of migration 0013 (run 272): it makes its database before 0013 in
  the test itself, every migration before it run from nothing, which took nine seconds here under
  the whole suite and more than the test's 30 on CI's runner. The orders module's five such tests
  took 82 seconds together here. Each `describe` that makes such a database now takes
  `MIGRATION_TEST_TIMEOUT`, two minutes, from `@hatti/db/testing`; the rest keep 30 seconds.

### 9175b68 · A draft paid by transfer through its link

* **A transfer's draft gets a link** ([ADR-223](../architecture/13-decision-log.md#adr-223--a-draft-paid-by-transfer-gets-a-link-too-its-customer-confirms-it-as-one-paid-on-delivery-its-order-waits-for-the-money-and-the-link-becomes-the-orders-whose-page-shows-where-to-pay-and-takes-the-payment-online)) while the shop gives its bank account
  (migration 0140): its page asks for the address as a cash-on-delivery draft's does, and says
  what to pay, by transfer or online once confirmed.
* **Confirming places the order to wait for its money, and the link becomes the order's:** the
  same secret, lasting as an order's link does, on its timeline; the draft's page, and its
  confirming and address, go on to `/o/<secret>`, whose page shows the account, takes the
  receipt and takes the payment online.
* 1674 tests (1 new, 1 rewritten): the link refused without the account, confirmed and handed to
  the order, past its own hours and taken back by a new one; and through HTTP, the address, the
  confirmation and the order's page. The core's row on the status page counts the last entry's
  HTTP test too, which it had missed.

### 9ff5600 · Something off for paying online

* **The shop's own discount for paying online** ([ADR-222](../architecture/13-decision-log.md#adr-222--a-shop-may-take-something-off-orders-paid-online-as-it-may-off-those-paid-by-transfer-a-percentage-up-to-a-cap-or-an-amount-of-its-own-which-checkout-takes-off-the-items-after-any-code-and-the-order-keeps-apart)), a percentage up to a cap or an
  amount, through `onlinePaymentSettings` and `onlinePaymentSettingsUpdate`, checked as a
  transfer's and audited before and after.
* **Taken off at checkout:** said beside paying online, Rs 300 off, and off the summary where it
  is the only way; in the page's digest; off the items after any code as the order is placed
  online, the gateway asked for the total less it.
* **Kept apart on the order:** `online_discount` (migration 0139), on its thank-you page, its
  page, the invoice and the export, and `Order.onlineDiscount`; an edit takes no less off. The
  transfer's helpers became the prepaid discount's, `prepaidDiscountOf` for both.
* 1673 tests (4 new): the settings kept and refused, checkout's option, summary and order, the
  invoice and export, and through HTTP, the settings and an order placed online.

### f1e8298 · The order the shop's gateways are offered in

* **The shop's own order** ([ADR-221](../architecture/13-decision-log.md#adr-221--a-shop-puts-its-gateways-in-the-order-its-customers-are-offered-them-the-admin-api-takes-all-its-live-accounts-at-once-those-connected-before-keep-the-order-they-were-connected-in-and-one-connected-later-goes-last)) for its live gateway accounts on an order's page and
  checkout's thank-you page, in place of the order it connected them in, which those connected
  before keep; one connected later goes last.
* **`paymentGatewayAccountsReorder(ids)`** takes each live account once, the first offered first,
  with `write_settings`: one listed twice, archived or another shop's refused, one left out
  named; recorded as `payment_gateway_accounts.reordered` and audited before and after.
* 1669 tests (1 new): the order kept, given and refused, and through HTTP, Safepay put first and
  the order's page offering it first.

### 1c2cbe4 · Comments on articles

* **A blog's comment policy**, as Shopify's: closed for a new blog, moderated, or published at
  once ([ADR-220](../architecture/13-decision-log.md#adr-220--articles-take-comments-as-their-blogs-shopify-comment-policy-says-posted-from-an-articles-page-through-the-storefront-held-for-the-shops-approval-where-the-blog-moderates-them-shown-escaped-as-text-in-the-articles-document-and-approved-marked-as-spam-or-deleted-through-the-admin-api)).
* **Comments from an article's page:** the storefront takes Shopify's `new_comment` form, from
  the shop's own pages and five a minute an address, and sends it to the core, which keeps it as
  plain text, pending or published; then back to the article saying how it went.
* **In the article's document:** its latest 100 published, escaped once by `commentHtml`, and how
  many; Liquid's `article.comments`, `comments_count`, `comments_enabled?` and `moderated?`, and
  Hatti Base shows them with the form, in English and Urdu.
* **Moderated through the Admin API:** `comments`, `Article.comments` and `commentsCount`, and
  `commentApprove`, `commentSpam`, `commentNotSpam` and `commentDelete`.
* 1668 tests (9 new): comments taken, refused and moderated; their HTML; the publisher following
  them; the storefront's form, page and route; and through HTTP.

### 3c551e8 · The customer choosing among the shop's gateways

* **Each of the shop's live accounts offered**
  ([ADR-219](../architecture/13-decision-log.md#adr-219--customers-choose-among-the-shops-gateways-each-live-account-that-takes-the-orders-currency-is-offered-on-its-page-and-checkouts-thank-you-page-in-the-order-the-shop-added-them-and-the-payment-starts-through-the-one-chosen)), in the order it connected them, on
  an order's page and checkout's thank-you page: a button each, Pay with JazzCash, in place of
  the oldest account alone; one gateway keeps its one Pay online button.
* **The payment starts through the one chosen:** `gatewaysOf` and `start`'s `gateway`, the first
  where a page from before names none, and one the shop does not take refused with a 503.
  Checkout's option names them all, and its digest keeps one gateway's as before.
* 1659 tests (3 new): the order's page and checkout's offering each, the choice started, and
  through HTTP, Safepay's page or JazzCash's form as the customer chose.

### 346fb25 · A blog's articles redirected with it

* **`redirectArticles` on `blogUpdate`**, as Shopify's
  ([ADR-218](../architecture/13-decision-log.md#adr-218--a-blog-whose-handle-changes-sends-its-articles-old-addresses-to-their-new-ones-when-asked-as-shopifys-redirectarticles-does-a-redirect-for-each-made-all-at-once-with-one-event-the-storefront-follows)):
  with a new handle, each of the blog's articles' old addresses sends shoppers to its new one,
  beside `redirectNewHandle`'s redirect of the blog's own.
* **Made all at once:** `redirectsMoved` keeps `redirectMoved`'s rules for many pages in five
  statements, redirects that sent shoppers to an old address following it, the latest published
  articles first where the shop has room for only some, and one `url_redirects.moved` event has
  the publisher write the shop's redirects again.
* 1656 tests (2 new): many moved at once, chains followed, room for only some, and nothing to do
  saying nothing; a blog's articles redirected with it, again and with its own; and through the
  API.

### d6f0eb5 · Pages published at a time ahead

* **A page's publish date may be ahead**, a year at most, through Shopify's `publishDate` on
  pages' inputs, as an article's may ([ADR-217](../architecture/13-decision-log.md#adr-217--a-page-is-published-at-a-time-ahead-as-an-article-is-through-shopifys-publishdate-hidden-until-then-wherever-it-would-show-and-shown-by-the-workers-same-sweep-with-the-pageupdated-the-storefront-follows)):
  hidden until then from the storefront, its search and menus' links, `isPublished` false and
  `publishedAt` the time ahead in the Admin API.
* **The worker's sweep shows pages too:** `scheduled` marks them (migration 0136), and the sweep,
  `ScheduledContent` now, every `SCHEDULED_INTERVAL_MS`, clears the mark and records
  `page.updated`, which the publisher follows.
* Articles and pages share the rules for a publish date and for what a change of one says
  (`checkPublishDate`, `publicationOf`).
* 1654 tests (2 new): a page scheduled, hidden, shown once, moved and what each change says; the
  storefront following; and a date more than a year ahead refused through the API.

### 611249a · A collection's Atom feed

* **Each collection has Shopify's Atom feed** at its address with .atom
  ([ADR-216](../architecture/13-decision-log.md#adr-216--a-collection-has-shopifys-atom-feed-at-its-address-with-atom-its-first-50-products-in-its-order-each-with-its-type-vendor-and-variants-in-shopifys-own-namespace-under-ids-of-their-own-and-products-documents-say-when-each-was-made-and-last-changed)):
  its first 50 products in its order, each with its type, vendor, tags and variants in Shopify's
  own namespace, and a summary of its picture, description and price; kept at the edge with the
  collection and the listing of all products, and linked from Hatti Base's collection pages.
* **Products' documents say when each was made and last changed** (`DOCUMENTS_VERSION` 11), and
  themes get Shopify's `product.created_at`, `published_at` and `updated_at`.
* 1652 tests (5 new): the feed whole, its 50 products and their dates, an empty collection, the
  route and its tags, and the dates in Liquid.

### 73fd722 · Articles published at a time ahead

* **An article's publish date may be ahead**, a year at most, as Shopify's `publishDate`
  schedules one ([ADR-215](../architecture/13-decision-log.md#adr-215--an-article-is-published-at-a-time-ahead-as-shopifys-publishdate-schedules-one-hidden-until-then-wherever-it-would-show-and-the-worker-shows-it-once-its-time-comes-with-the-articleupdated-the-storefront-follows)):
  hidden until then from the storefront, its blog's page, its search, its image's address and
  menus' links, `isPublished` false and `publishedAt` the time ahead in the Admin API.
* **The worker shows it when its time comes:** `scheduled` marks it (migration 0135), and a sweep
  every minute (`ARTICLES_INTERVAL_MS`) clears the mark and records `article.updated`, which the
  publisher follows.
* Marking a payment failed when its gateway says so waits: which answers are final differs by
  gateway, and JazzCash's and Safepay's are not known well enough to cancel an order on.
* 1647 tests (3 new): scheduled, hidden, shown once, and what each change says; the worker's
  sweep; and the storefront following.

### 26f59e7 · Easypaisa

* **Easypaisa is the third gateway shops take payments through**
  ([ADR-214](../architecture/13-decision-log.md#adr-214--easypaisa-is-the-third-gateway-shops-take-payments-through-by-its-hosted-checkout-the-customers-browser-posts-a-form-encrypted-with-the-stores-hash-key-to-its-page-and-the-token-it-comes-back-with-to-its-next-and-its-return-which-it-does-not-sign-is-believed-only-once-its-inquiry-asked-at-once-with-the-accounts-api-credentials-says-the-payment-is-made)):
  by its hosted checkout, the customer's browser posting a form encrypted with the store's hash
  key (AES in ECB mode, `easypaisaHash`) to its page, and the token it comes back with to its
  next page, from a page of Hatti's with a button each time, on an order's page and checkout's.
* **Its return is not signed, so it is believed only as its inquiry agrees:** a gateway may name
  the payment a return says is made (`returnRef`), and the service asks its inquiry at once, at
  most once a minute a session. Easypaisa's inquiry is asked with the API's username and
  password, and believed as it comes from its own API, naming the account's store and the order.
* **Credentials in one shape alone** are checked when an account is connected: Easypaisa's hash
  key is 16, 24 or 32 characters.
* 1644 tests (7 new): the form and its hash as OpenSSL makes it, the token's page, the return
  asked after and its throttle, the inquiry's answers; and through HTTP, its two pages and its
  return paying the order.

### 7071db6 · An article's image

* **An article has Shopify's image**, one of the shop's images ready to show, with its alt text
  ([ADR-213](../architecture/13-decision-log.md#adr-213--an-article-has-shopifys-image-one-of-the-shops-files-with-its-alt-text-the-api-serves-it-at-an-address-of-its-own-while-the-article-is-published-the-address-naming-its-file-the-articles-document-names-that-address-and-hatti-base-shows-it-in-its-blog-and-on-the-articles-page)):
  `articleCreate` and `articleUpdate` take `image { fileId altText }`, null for none, checked
  through the files module's `readyImagesIn` (migration 0134), and `article.updated` names
  `image`.
* **Served by the API** at `/article-images/{shop}/{article}` while the article is published,
  its address naming its file (`?v=`); the article's document names that address, with the
  file's alt text when the article gives none, and a file deleted rebuilds the shop's articles
  (`DOCUMENTS_VERSION` 10).
* **Themes get Shopify's `article.image`**; Hatti Base shows it above each article in its blog
  and at the top of the article's page. The blog's feed leaves it out for now, as how Shopify's
  feeds carry one is not known.
* 1637 tests (4 new): the image checked, kept, changed and taken off, and served while its
  article is published; its document's address, alt text and its file deleted; Hatti Base's blog
  and article pages, and `article.image` in themes.

### 4e6a306 · Articles and pages in the storefront's search

* **A storefront's search finds the shop's published pages and articles** beside its products
  ([ADR-212](../architecture/13-decision-log.md#adr-212--a-storefronts-search-finds-the-shops-published-pages-and-articles-beside-its-products-as-shopifys-does-by-the-words-each-keeps-folded-through-the-online-stores-own-search-in-the-core-products-then-pages-then-articles-the-kinds-shopifys-type-names-and-suggested-as-a-shopper-types)):
  each keeps the words it is found by, folded as products' are (`search_text`, migration 0133),
  and the online store searches them at `/storefront/shops/{shop}/search/content`.
* **On the storefront:** products, then pages, then articles, the kinds Shopify's `type` names,
  pages fetched by ID; suggestions of pages and articles as JSON and in the theme's section.
  Hatti Base shows them with their first words and speaks of results.
* 1633 tests (4 new): the words kept and folded, found and kept as they change, hidden and other
  shops' left out, the kinds and limits asked; the storefront's results in order, `type`, and
  suggestions.

### 6fefbd8 · Dates in the shop's own time zone, and Shopify's `time_tag`

* **Storefront dates in the shop's time zone and the page's language**
  ([ADR-211](../architecture/13-decision-log.md#adr-211--storefront-dates-print-in-the-shops-own-time-zone-and-the-pages-language-and-themes-get-shopifys-time_tag-and-its-date-formats-by-name-a-themes-own-date_formats-first)):
  LiquidJS's date filters each given their page's options, the time zone the shop's document
  names and month names in Urdu on Urdu pages; Pakistan's time for a zone Intl does not know.
* **Shopify's `time_tag`**, and its date formats by name for `date` and `time_tag`, a theme's own
  `date_formats` first. Hatti Base prints its blog's dates through it, day first.
* 1629 tests (1 new): a shop abroad, an Urdu page and an unknown zone; formats by name, the
  theme's, strftime's and `datetime:`; and no date.

### c1bc956 · Asking Safepay after its trackers

* **Safepay's trackers are asked after** as JazzCash's payments are
  ([ADR-210](../architecture/13-decision-log.md#adr-210--safepays-trackers-are-asked-after-as-jazzcashs-payments-are-through-its-reporter-with-the-accounts-secret-key-its-answer-which-safepay-does-not-sign-is-believed-as-it-comes-from-safepays-own-api-and-only-naming-the-accounts-api-key-and-the-tracker-asked-about)):
  its reporter, with the account's secret key; its answer, which Safepay does not sign, believed
  as it comes from Safepay's own API, and only naming the account's API key and the tracker asked
  about. Paid once the tracker ended, at the amount it was started for. Not yet tried against its
  sandbox.
* 1628 tests (2 new): the reporter asked with the secret key, believed for this account and
  tracker alone, a tracker not ended unpaid, and what it could not learn unknown.

### 16e8ae5 · A blog's Atom feed, and the articles before and after

* **Each blog's Atom feed** at `/blogs/{handle}.atom`, as Shopify serves it
  ([ADR-209](../architecture/13-decision-log.md#adr-209--a-blog-has-shopifys-atom-feed-at-its-address-with-atom-its-30-latest-articles-whole-under-ids-of-their-own-and-an-articles-page-gives-themes-the-newer-and-the-older-article-beside-it-fetched-together-when-a-theme-first-asks-for-either)):
  its 30 latest articles whole, with their summaries, authors and tags, under IDs of their own
  (`urn:uuid:`), linking to their pages at the shop's address; kept at the edge with the blog's
  page. Hatti Base's layout names it on the blog's pages and its articles'.
* **Articles' documents say when each last changed** (`updatedAt`, documents' version 9), for the
  feed and Liquid's `article.updated_at`.
* **`blog.previous_article` and `blog.next_article`** on an article's page, the newer and the
  older, fetched in one round trip when a theme first asks; printed, their addresses. Hatti Base
  links both, in English and Urdu.
* 1626 tests (5 new): the feed's markup, escaping, its 30 and when it changed, one gone and a blog
  without articles; the route, its caching and its 404s; and an article's page linking those
  beside it, in one round trip.

### 87132d9 · Asking JazzCash what became of a payment

* **A payment whose customer never came back is asked after**
  ([ADR-208](../architecture/13-decision-log.md#adr-208--a-payment-started-online-whose-customer-never-came-back-is-asked-after-the-worker-asks-the-gateways-status-inquiry-jazzcashs-first-from-a-quarter-of-an-hour-after-it-began-at-most-once-an-hour-for-two-days-and-records-one-the-gateway-vouches-for-paid-through-the-inquiry)):
  JazzCash's status inquiry, signed with the account's salt as its forms are, its answer believed
  signed alone; paid at 000 or 121 completed, unpaid at another code, unknown otherwise. Not yet
  tried against its sandbox.
* **The worker asks** after sessions still open from a quarter of an hour after they began, once
  an hour for two days (`inquired_at`, migration 0132), and records one found paid as its return
  would have been, paid through the inquiry (`INQUIRY` in the Admin API).
* 1621 tests (4 new): JazzCash's inquiry signed, believed, paid, unpaid and unknown; the sweep
  asking when due and recording one paid; and the worker going on past a shop that fails.

### a28340f · The shop's brand in its themes

* **Themes get Shopify's `shop.brand`**
  ([ADR-207](../architecture/13-decision-log.md#adr-207--themes-get-shopifys-shopbrand-its-logo-and-square-logo-as-images-from-where-the-api-serves-them-nil-for-what-hatti-does-not-keep-and-hatti-bases-header-shows-the-logo-in-place-of-the-shops-name)):
  its `logo` and `square_logo` as images, at the addresses the shop's document names, nil for
  none; the brand's colours, cover image, slogan and short description nil, as Hatti keeps none.
* **Hatti Base's header shows the shop's logo** in place of its name, the name as before for a
  shop without one.
* 1617 tests (1 new): `shop.brand`'s logos, sized and not, and nil without; and the header with
  the logo, else the name.

### 7124b35 · A product on the link page with its variant chosen

* **Each product a link page shows may name one of its variants**
  ([ADR-206](../architecture/13-decision-log.md#adr-206--each-product-a-shops-link-page-shows-may-name-one-of-its-variants-kept-beside-it-by-its-place-the-page-shows-that-variants-title-image-and-price-and-buy-now-goes-straight-to-checkout-with-it-a-variant-deleted-since-is-as-none-chosen)):
  `products` beside `productIds` in the Admin API's link page, each a product and one of its
  variants or none, kept by their place in `link_variants` (migration 0131) and checked to be the
  product's own. A variant deleted since is as none chosen; a product may be there twice with two
  of its variants.
* **The storefront shows the variant chosen**: its title under the product's, its image, its price
  and the price before a sale, and "Buy now" to its cart permalink, or "Sold out"; the card opens
  the product's page with it chosen.
* 1616 tests (3 new): variants kept, checked and dropped when deleted; the shop's document naming
  them; the page showing one chosen, sold out and gone; and over GraphQL.

### 57cf640 · The link page's image of its own

* **Shopify's square logo in the shop's brand, beside its logo**
  ([ADR-205](../architecture/13-decision-log.md#adr-205--a-shops-brand-has-shopifys-square-logo-beside-its-logo-one-of-its-files-served-by-the-api-at-an-address-of-its-own-the-shops-document-names-where-each-logo-is-served-each-address-naming-its-file-and-the-link-page-shows-the-square-logo-else-the-logo-at-its-top)):
  one of the shop's files, an image, checked as the logo is and gone with its file (migration
  0130); `shopBrandUpdate` sets either or both. The API serves it at `/logos/{shop}/square`, as
  the logo at `/logos/{shop}`.
* **The shop's document names where both are served**, each address naming its file, so another
  image is another address; the publisher rebuilds it when the brand changes or a file goes.
* **The link page shows the square logo in a circle, else the logo whole**, at its top, styled by
  Hatti Base. Its code came in 4bd1f7c, before the day's break.
* 1613 tests (4 new): the square logo kept, checked and gone with its file; the shop's document
  naming both logos, rebuilt as they change; the link page's image; and over HTTP, the square logo
  set through GraphQL and served.

## 2026-10-05

### bfaa137 · Counting the link page's taps

* **The link page's links go through the storefront, which counts each tap**
  ([ADR-204](../architecture/13-decision-log.md#adr-204--the-link-pages-links-go-through-the-storefront-which-counts-each-tap-a-day-at-a-time-by-where-the-link-goes-beside-the-sessions-and-sends-the-shopper-on-it-follows-only-the-pages-own-links-and-the-worker-keeps-each-days-taps-in-postgres-for-a-report-of-a-periods-by-link)):
  `/links/to/{key}`, its key from the SHA-256 of where the link goes, counted a day at a time in
  Valkey beside the sessions, then a 302 to where it goes, in the page's language. Only the page's
  own links and its chat on WhatsApp are followed; any other key goes back to `/links`. Robots, a
  browser's prefetch, `HEAD` requests, staff's previews and the sample shop are not counted, nor
  past 120 taps a minute from an address.
* **The worker keeps each day's taps** with the sessions, in `online_store.link_taps`
  (migration 0129), keyed by the address's SHA-256; `linkPageTaps(from, before)` reports a
  period's by link, under `read_orders`.
* 1609 tests (9 new): the page's links through the storefront, the redirect in each language, a
  key of no link back to the page; taps counted, but not a robot's, a prefetch's or a `HEAD`
  request's; the day's taps in Valkey; kept by the worker and reported by link; and over GraphQL.

### ddb72a1 · The desk waiting for the reminder's answer

* **Where the shop asks, its Confirmation Desk waits for its customers to answer on WhatsApp**
  ([ADR-203](../architecture/13-decision-log.md#adr-203--a-shops-confirmation-desk-may-wait-for-its-customers-to-answer-on-whatsapp-where-the-shop-asks-an-ordinary-cash-on-delivery-order-is-dealt-for-its-first-call-an-hour-after-its-reminder-to-confirm-or-three-days-after-it-was-placed-when-none-will-go-one-of-high-value-is-dealt-at-once-and-an-order-is-overdue-counting-from-when-it-fell-due)):
  `deskWaitsForReminder`, a new order setting (migration 0128). An ordinary cash-on-delivery
  order, pending and not of high value, is dealt for its first call an hour after its reminder to
  confirm went, or three days after it was placed when none will go; until then the queue counts
  it for later. One of high value is dealt at once, and an order is overdue counting from when it
  fell due.
* 1600 tests (1 new): ordinary, high-value and old orders dealt as the setting says, overdue from
  when they fell due; and the setting over GraphQL.

### a9108e5 · Removing a number

* **An account's owner takes its number off it** (`DELETE /auth/phone`,
  [ADR-202](../architecture/13-decision-log.md#adr-202--an-accounts-owner-takes-its-number-off-it-from-a-session-proved-lately-and-past-its-second-factor-where-it-has-one-while-a-password-a-passkey-or-google-still-signs-it-in-the-number-signs-in-to-nothing-from-then-on-may-be-proved-for-another-account-and-is-told-on-whatsapp-else-by-sms)):
  from a session proved lately and past its second factor where it has one; a proved number only
  while a password, a passkey or Google still signs the account in. The number signs in to nothing
  then, may be proved for another account, and is told at once on WhatsApp, else by SMS, in the
  account's language: `number_removed`, a new message of Hatti's own.
* WhatsApp's templates with no variables go with no body component, which WhatsApp would refuse
  empty.
* 1599 tests (3 new): a number taken off, only from a session proved lately, told, then free for
  another account, nothing left after, and kept where it alone signs in; the message's words and
  its template without a body; the core's sender; and over HTTP.

### 5fdba48 · Google or a code to the number confirms who is at an account

* **An account with no second factor confirms who is at it with any way it signs in**
  ([ADR-201](../architecture/13-decision-log.md#adr-201--an-account-with-no-second-factor-confirms-who-is-at-it-with-any-way-it-signs-in-its-password-a-sign-in-with-the-google-account-connected-to-it-carrying-a-nonce-the-options-gave-or-a-code-sent-to-its-proved-number-neither-of-the-last-two-passes-a-second-factor)):
  its password; a sign-in with the Google account connected to it, carrying the nonce
  `POST /auth/reauthenticate/options` now gives in `googleOptions`; or a code sent to its proved
  number by the new `POST /auth/reauthenticate/code`, masked in the options' `phone`. Accounts
  opened by phone or with Google were told to add a second factor first. Neither way passes a
  second factor, and where the account has one, that alone confirms it, as before.
* A wrong code, another Google account or a spent nonce is refused as 422, never 401, so the
  session holds; a confirmation with Google lifts a bounce as a sign-in does (ADR-200).
* 1596 tests (2 new): a phone account's code and its Google sign-in confirming it, once each,
  refused for another Google account, a nonce not the API's or a wrong code, and neither once it
  has a second factor; a Google account's confirming with Google; and over HTTP, the code sent
  after the number's wait and the session confirmed.

### 9073391 · The catalog's migration test applies 0004 alone

* CI timed out catalog's test of migration 0004 once (run 246): it was the one test of how a
  migration treats old data that `fd7e86d` missed, still making its database by hand and then
  applying every migration after 0004, 123 of them now. It makes its database with
  `createTestDatabase(server, { before: '0004' })` and applies 0004 alone with `migrateThrough`,
  as the others do, and takes under a second, however many migrations follow.

### de6bf24 · A suppressed address lifted

* **An address Hatti stopped emailing for a bounce is emailed again once Google, where it answers
  for the address, confirms it in a sign-in**
  ([ADR-200](../architecture/13-decision-log.md#adr-200--an-address-hatti-stopped-emailing-for-a-bounce-is-emailed-again-once-google-where-it-answers-for-the-address-confirms-it-in-a-sign-in-sess-own-list-is-asked-first-and-both-are-lifted-a-complaint-stays-on-either-list-and-hattis-operators-lift-either-from-the-command-line)):
  a Gmail address, or one of a Google Workspace organisation (the token's `hd`), as Google's own
  guidance has it. Signing in, opening an account or connecting Google lifts it, from SES's own
  list first, which would drop Hatti's emails otherwise, then from Hatti's; SES out of reach, it
  stays until the next. A complaint stays, on either list, and a bounce heard after one leaves it
  a complaint.
* **Hatti's operators see and lift either** with
  `pnpm --filter @hatti/core email-suppression show|lift <email>`, never through the Admin API.
* `@hatti/storage`'s signer encodes the path once more for services other than S3, as SES's
  paths with an address in them need; SES's IAM user is allowed `ses:GetSuppressedDestination`
  and `ses:DeleteSuppressedDestination`.
* 1594 tests (5 new): Google's word lifting a bounce, kept for an address it doesn't answer for
  and for a complaint, SES asked first and nothing lifted when it can't be; the operators' lift;
  SES's list asked and taken from; a complaint outlasting a later bounce over HTTP; and the
  signer's paths.

### 878ddc8 · Checkout spares a browser proved lately its code

* **A browser that proved a number with a code at a shop's checkout is not asked for another for
  it there for 30 days, where the shop's risk rules would ask**
  ([ADR-199](../architecture/13-decision-log.md#adr-199--a-browser-that-proved-a-number-with-a-code-at-a-shops-checkout-is-not-asked-for-another-for-it-there-for-30-days-where-the-shops-risk-rules-would-ask-it-keeps-a-random-token-in-a-cookie-for-checkouts-the-shop-a-digest-of-it-with-the-number-and-when-it-was-proved-spending-store-credit-still-asks-each-time)):
  the order placed gives it a random token, kept as a digest in `checkout.number_proofs`
  (migration 0127) with the number and when it was proved. The core sets it as a cookie for
  `/checkouts` on its own address, and the storefront on the shop's, sending it back with each
  order. Spending store credit still asks for a code each time.
* Proofs are customers' data: checkout's handler for customers' data erases them by number and
  lists them in a customer's own file, in the API and the worker alike.
* 1589 tests (1 new): the proof given, spared and placed as proved then, refused for another
  number, a token that is none or one lapsed, and never for store credit; erased and exported;
  and over HTTP, on the core's address and through the storefront.

### 90571d4 · Orders' emails in the shop's look

* **An email of an order's news is laid out as its shop's own**
  ([ADR-198](../architecture/13-decision-log.md#adr-198--an-email-of-an-orders-news-is-laid-out-as-its-shops-own-under-its-logo-served-at-an-address-of-the-apis-that-lasts-as-an-email-does-or-its-name-in-its-themes-accent-colour-with-the-orders-first-ten-lines-and-its-total)):
  under its logo, or its name, in its theme's accent colour, with the order's first ten lines
  and its total in a table, right to left in Urdu. The worker gives the email what it shows; the
  order's notification facts read its first ten lines; and the API serves each shop's logo at
  `/logos/{shop}`, an address that lasts as an email does, where the pages' signed ones lapse
  in an hour. Hatti's notices of bills keep Hatti's look.
* 1588 tests (1 new): the layout, its logo or name, colour, lines and total, in both languages,
  and what is not used; the worker's lines and logo; and the logo served over HTTP.

### 74c878e · SES's word on the emails sent for shops

* **An email Hatti sends for a shop is delivered, or failed for good, as SES's notifications say**
  ([ADR-197](../architecture/13-decision-log.md#adr-197--an-email-hatti-sends-for-a-shop-is-delivered-or-failed-for-good-as-sess-notifications-on-hattis-sns-topic-say-identity-hears-the-topic-and-passes-each-notification-on-and-messaging-moves-the-emails-message-by-the-id-ses-gave-it-as-whatsapps-statuses-move-its-messages)):
  identity's feedback service passes each notification of Hatti's SNS topic on, once its
  signature is checked, and the core hands it to messaging, which moves the email's message by
  the ID SES gave it: a delivery to `delivered`, a bounce for good or SES refusing it to
  `failed`, with why. Forward only, as WhatsApp's statuses move its messages; Hatti's own emails
  find no message and change nothing. Should messaging fail, SNS is answered 503 and sends the
  notification again.
* 1587 tests (4 new): SES's word read, delivered or failed, from notifications and events alike,
  and what it says nothing of; the notification passed on and sent again when that fails; and
  over HTTP, an order's email delivered and another bounced.

### 76ba41e · Invitations emailed again

* **An invitation still waiting is emailed again as a new one in its place**
  ([ADR-196](../architecture/13-decision-log.md#adr-196--an-invitation-still-waiting-is-emailed-again-as-a-new-one-in-its-place-of-the-same-role-note-and-address-by-a-new-link-good-for-7-days-the-one-before-is-taken-back-its-link-opening-nothing-and-the-new-one-is-held-to-the-limits-any-invitation-is-20-emailed-a-day-for-a-shop-among-them)):
  `staffInvitationResend` takes it back and makes another of the same role, note and address,
  by a new link good for 7 days, in one transaction, and emails the link in the language asked
  or the asking member's own. The link before opens nothing. The new one is held to the limits
  any invitation is, 20 emailed a day for a shop among them, and a refusal rolls back, leaving
  the one before as it was. It is on the audit log, naming the one it replaced.
* 1583 tests (1 new): sending again, by a new link, in the member's language; refusals for those
  gone, accepted, expired, without an address, or of a role the member doesn't manage; the 20 a
  day; and, over GraphQL, the new link emailed in the language asked and audited.

### 9363e0d · Invitations through the API in their inviter's language

* `staffInvitationCreate` passed English to the staff service when the request named no
  language, so an invitation made through the API never went in its inviter's own, as ADR-194
  has it. It now passes none, and the staff service reads the inviter's. The staff end-to-end
  test keeps Hatti's emails in an outbox, and finds an invitation emailed in Urdu as asked, and
  another, asked in no language, in its inviter's Urdu.
* 1582 tests, as before.

### 0342cbf · Owners told of their bills by email too

* **A shop's owner hears of its bills by email too, at the address their account proved, in
  their own language, from Hatti's own address**
  ([ADR-195](../architecture/13-decision-log.md#adr-195--a-shops-owner-hears-of-its-bills-with-hatti-by-email-too-at-the-address-their-account-proved-and-in-their-own-language-from-hattis-own-address-the-worker-finds-them-through-identitys-functions-for-the-shop-alone-and-queues-each-email-with-the-shops-messages-at-hattis-cost-with-an-alerts-number-or-without)):
  `BillingNotices` queues each notice, a renewal's invoice, a plan ended unpaid and credit
  running low, as an email to the owner beside the WhatsApp message at the alerts number, and
  without one where the shop gives none. `ownerEmailIn` finds the owner and their email through
  identity's functions for the shop of the transaction alone, as staff's are read (ADR-193).
* The three kinds have email subjects in English and Urdu; `messageEmail` says why the email
  came, to the owner about the shop's bills, and marks it Hatti's, which SES sends from
  `EMAIL_FROM` itself rather than under the shop's name. Emails are never charged.
* 1582 tests (4 new): the owner's email given to the shop's own transactions alone, and only
  while proved and taking mail; the emails' words; SES sending them from Hatti; and the worker
  emailing the owner with an alerts number and without, and not once the email is unproved.

### 0c3970c · An account's own language

* **An account keeps its own language, English or Urdu, which Hatti's emails and messages to
  them use** ([ADR-194](../architecture/13-decision-log.md#adr-194--an-account-keeps-its-own-language-english-or-urdu-as-its-owner-signs-up-in-or-chooses-since-and-hattis-emails-and-messages-to-them-use-it-sign-in-alerts-links-and-codes-invitations-they-send-emailed-exports-and-staffs-alerts)):
  `identity.users.language` (migration 0126), set at sign-up by email, by number or with Google
  from the request's `language`, changed with `POST /auth/language` and said on the user.
  Sign-in alerts, which were in English, use it, the device they name too; so do the worker's
  emails of scheduled exports, now in Urdu as well, right to left; and staff's alerts of their
  own work, which were in the shop's language. Links, codes and a replaced number's message use
  it where the request names no language, and an invitation goes in its inviter's.
* The worker learns a member's language with their email or number, from `identity.staff_email`
  and `identity.staff_phones`, for the shop of its transaction alone (ADR-193);
  `MessageToQueue.language` queues a message in a person's language in place of the shop's.
* 1578 tests (2 new): an owner who signed up in Urdu alerted in it, then in English once they
  chose it, and at their number in Urdu; a scheduled export's email in Urdu, right to left.

### b659fb0 · A courier test no longer races the clock

* CI run 238 failed in logistics' courier test, which nothing in that push touched: it made a
  booking due at Postgres's `now()` and asked what was due at a JavaScript `Date` made just
  after. Postgres keeps microseconds and a `Date` only milliseconds, so the two made in one
  millisecond put the booking a fraction of a millisecond in the future. The test now makes it
  due a second before.

### db44d72 · Staff's numbers read as their emails are

* **The worker reads staff's numbers through a function of identity's that answers for the shop
  of its transaction alone, never identity's tables**
  ([ADR-193](../architecture/13-decision-log.md#adr-193--the-worker-reads-staffs-numbers-as-it-reads-their-emails-through-a-function-of-identitys-that-answers-for-the-shop-of-its-transaction-alone-never-identitys-tables-staffs-alerts-need-no-identity-login)):
  `identity.staff_phones` (migration 0125), read by `staffPhonesIn` in the transaction that
  queues the alerts, as scheduled exports read staff's emails (ADR-183). ADR-191 had given the
  worker the identity login, which could read every account: it is gone from the worker's
  settings again.
* 1576 tests, as before: identity's test of staff's numbers reads them as the worker does, and
  finds another shop's transaction learns nothing and the app's login is refused identity's
  tables.

### 4c85afc · Customers told of their store credit

* **A customer hears of store credit the shop gives them, with what they have in all, and a week
  before a credit of theirs expires, with when**
  ([ADR-192](../architecture/13-decision-log.md#adr-192--a-customer-hears-of-store-credit-the-shop-gives-them-with-what-they-have-in-all-and-a-week-before-a-credit-of-theirs-expires-with-when-each-credit-is-an-event-the-workers-sweep-marks-each-credit-it-reminds-of-once-and-both-go-as-their-orders-news-does)):
  `store_credit_given` and `store_credit_expiring`, from Hatti's number or by SMS where the shop
  saves, as their orders' news goes, each of which the shop turns off.
* Each credit, by hand or a refund, records `store_credit.credited`; the store credit sweep marks
  each credit with something left that expires within the week, once (migration 0124), with
  `store_credit.expiring`. The worker's `StoreCreditNotices` tells the customer at their main
  number, nothing for a credit spent before it heard.
* 1576 tests: customers' 64, messaging's 37 and the core's 324.

### febebac · Staff told of their own work

* **A member of staff hears on WhatsApp, at the number their account signs in with, of an order
  someone else gives them and of a comment that names them as `@` and their name**
  ([ADR-191](../architecture/13-decision-log.md#adr-191--a-member-of-staff-hears-on-whatsapp-at-the-number-their-account-signs-in-with-of-an-order-someone-else-gives-them-and-of-a-comment-that-names-them-as--and-their-name-the-orders-events-say-which-the-worker-finds-whom-through-the-identity-login-and-each-is-one-of-the-shops-alerts-paid-from-its-credit)):
  two alerts of the shop's own, `order_assigned` and `order_mentioned`, naming the shop and the
  order, which the shop turns off as it does its others and pays for from its credit.
* The orders module records `order.assigned`, and comments record events of their own that never
  say what a comment says; the worker's `StaffAlerts` reads the shop's staff and their proved
  numbers through the identity login, finds whom a comment names, the longest name that fits, and
  tells each once a comment, never its author nor whoever took an order themselves.
* 1573 tests: orders' 225, messaging's 36, identity's 74 and the core's 323.

### 95603ca · The shop's tax registration on its invoices

* **A shop's NTN and sales tax registration number are kept with its tax settings, and its
  invoices name them**
  ([ADR-190](../architecture/13-decision-log.md#adr-190--a-shops-ntn-and-sales-tax-registration-number-are-kept-with-its-tax-settings-as-fbr-writes-them-and-its-invoices-name-them-with-a-sales-tax-registration-number-they-are-sales-tax-invoices-which-say-their-value-without-the-tax-too)):
  typed as anyone writes them and kept as FBR does, an NTN as `1234567-8` or a CNIC, an STRN as
  its thirteen digits (migration 0123), set through `taxSettingsUpdate` and audited.
* With an STRN, an invoice is a sales tax invoice, in English and Urdu, and says its value
  without the tax under the tax its total includes, as section 23 of the Sales Tax Act asks.
  Packing slips name neither number.
* 1569 tests: tax's 16, orders' 224 and the core's 322.

### 392d3c0 · Sign-ups on the storefront

* **Shoppers sign up for a shop's news and offers on WhatsApp through its online store's form**
  ([ADR-189](../architecture/13-decision-log.md#adr-189--shoppers-sign-up-for-a-shops-news-and-offers-on-whatsapp-through-its-online-stores-form-as-shopifys-customer-form-posts-it-the-storefront-sends-the-number-on-to-the-core-which-keeps-it-as-consent-from-the-storefront-in-the-words-the-form-showed-for-the-customers-main-number-and-the-form-comes-back-to-its-page-saying-how-it-went)): Shopify's customer form posts to `/contact`, in the page's
  language, and the storefront sends the number, the form's tags and the words beside it on to
  the core's storefront API. The core finds or makes the customer and subscribes their main
  number on WhatsApp, from the `storefront`, a consent source of its own (migration 0122), by
  the system, in the form's words or the platform's, which checkout's boxes share.
* The form comes back to its page: `customer_posted=true` gives `form.posted_successfully?`, and
  `customer_error` the fields that were wrong, as `form.errors`. A closed shop takes sign-ups
  too, and Hatti Base's home page has a newsletter section in English and Urdu.
* 1566 tests: customers' 63, the core's 321 and the storefront's 92.

### ce420c3 · An advance for what passes the cash cap

* **A cart past the law's cap is still taken on delivery where the shop has its account**
  ([ADR-188](../architecture/13-decision-log.md#adr-188--a-cart-past-the-laws-cap-on-cash-on-delivery-is-still-taken-on-delivery-where-the-shop-has-its-account-checkout-asks-in-advance-what-the-order-comes-to-past-rs-200000-or-the-shops-own-advance-where-that-is-more-says-so-wherever-the-order-may-pass-the-cap-and-the-cart-says-so-too)): placing asks in advance what the order comes to past Rs 200,000, with
  delivery and the fee, rounded up to a rupee, or the shop's own advance where that is more; the
  door collects the rest. Without the account, checkout refuses cash on delivery as before.
* The page says so wherever the order may pass the cap, with the dearest delivery the shop
  charges: by amount once the total is known, as a rule before. Its digest covers it, so a page
  shown before the shop gave its account is shown again first. Hatti Base's cart and drawer say
  so past the cap.
* 1559 tests, checkout's 119.

### 274656c · Marketing consent at checkout

* **Checkout offers a box for the shop's news and offers on each channel it chooses**
  ([ADR-187](../architecture/13-decision-log.md#adr-187--a-shops-checkout-offers-a-box-for-its-news-and-offers-on-each-channel-it-chooses-whatsapp-until-it-does-unticked-until-the-shopper-ticks-it-a-box-ticked-records-the-customers-consent-as-the-order-is-placed-in-the-words-beside-it-where-the-number-or-email-typed-is-the-customers-own)): WhatsApp until the shop chooses, through `checkoutMarketingChannelsUpdate`,
  any of WhatsApp, SMS and email, or none. The boxes sit under the email, in English and Urdu,
  naming the shop, and are never ticked beforehand.
* **A box ticked is the customer's consent, recorded as the order is placed:** in the order's
  transaction, the customer is subscribed on that channel in the consent ledger, from
  `checkout`, by the system, in the box's words. It counts only for the customer's own contact:
  their main number for WhatsApp and SMS, their email for email, as a new customer's is.
  Another of their numbers, or an email the shop does not have for them, records nothing.
* Migration 0121 keeps each shop's channels. 1557 tests, checkout's 117.

### c7f51f1 · Store credit at checkout

* **A shopper pays at checkout with their store credit** ([ADR-186](../architecture/13-decision-log.md#adr-186--a-shopper-pays-at-checkout-with-the-store-credit-their-number-has-once-they-prove-it-with-a-code-the-page-offers-it-once-the-shop-has-given-any-says-so-when-the-number-has-none-and-spends-what-the-credit-covers-of-the-order-as-it-is-placed-in-the-same-transaction)):
  once the shop has given any credit, checkout's page offers a box to pay with it. Ticked,
  placing sends a code to the number typed, as the shop's own codes do, and places nothing until
  it is typed; then the order is placed paid by as much of the number's credit as it takes, the
  credits that expire soonest first, in the same transaction. The cash at the door, the transfer
  or the payment online is less by that much, and a code, a rule or stock that undoes the order
  undoes the debit too.
* A number with no credit is told so, the box unticked, and nothing is placed. The order is
  placed as one whose number was proved, and its thank-you page says what store credit paid,
  beside the total, as the checkout's page does when it is opened again.
* Staff's payments with store credit and checkout's share `OrderService.payWithStoreCreditIn`.
  1553 tests, checkout's 114.

### fd7e86d · Migration tests apply only the migration they test

* CI timed out the customers module's test of migration 0013 once migration 0120 came: each test
  of how a migration treats old data made a database from before it, then applied every
  migration after it too, a little slower with each one added. `migrateThrough(adminUrl,
  migration)` in `@hatti/db/testing` applies the one under test and none after, and the ten
  such tests use it: each takes a second or two, however many migrations follow.

### de0db67 · Orders paid with store credit

* **Staff pay an order with its customer's store credit** ([ADR-185](../architecture/13-decision-log.md#adr-185--staff-pay-an-order-with-its-customers-store-credit-while-it-is-open-and-nothing-of-it-has-shipped-the-credits-that-expire-soonest-first-an-advance-still-owed-is-paid-first-and-the-cash-at-the-door-drops-by-the-rest-cancelled-the-order-gives-the-credit-back-to-the-credits-it-came-from-its-payment-void)):
  `orderPayWithStoreCredit` debits the customer's account, the credits that expire soonest
  first, and records the payment on the order in one transaction, as much as it owes and the
  credit covers unless an amount is given, while it is open and nothing of it has shipped. On
  cash on delivery, an advance still owed is paid first and the rest comes off the cash at the
  door. It needs both `write_orders` and `write_store_credit_account_transactions`.
* **A cancelled order gives its store credit back**, whoever cancels it: each debit is reverted
  to the credits it came from, which expire as they would have, and the order's payment is void,
  `VOIDED` once nothing paid is left. Where refunds already took more than the rest, the credit
  stays spent and the timeline asks staff to refund it.

### ef6ce45 · Store credit

* **A shop owes its customers store credit as Shopify keeps it** ([ADR-184](../architecture/13-decision-log.md#adr-184--a-shop-owes-its-customers-store-credit-as-shopify-keeps-it-an-account-for-each-customer-and-currency-credited-by-refunds-given-as-store-credit-or-by-hand-and-debited-by-hand-the-credits-that-expire-soonest-spent-first-its-balance-is-what-its-credits-have-left-unexpired-worked-out-when-asked-from-a-ledger-written-holding-the-accounts-lock-and-never-rewritten)):
  an account for each customer and currency (migration 0120), whose ledger keeps every credit,
  debit, debit given back and expiry in the order they were made, each written holding the
  account's lock. A debit spends the credits that expire soonest first, keeping what it took from
  each; the balance is what the credits have left unexpired, worked out when asked. The app's
  database role can rewrite and delete none of it.
* `orderRefund(method: STORE_CREDIT)` gives a refund as store credit, credited to the order's
  customer in the refund's transaction, the credit's ID the refund's reference, with an expiry if
  given. Staff and apps credit and debit by hand with Shopify's `storeCreditAccountCredit` and
  `storeCreditAccountDebit`, audited, and read accounts and ledgers through
  `storeCreditAccount` and `Customer.storeCreditAccounts`, under Shopify's three scopes:
  owners and managers change it, accountants read its ledgers, and confirmation agents see
  balances.
* A merged duplicate's credit moves with them, an erasure waits while credit is owed, the
  customer's own file has it, and the worker writes expired credits' ends into the ledger.

### d4aea0b · Scheduled order exports

* **Staff schedule exports of the shop's orders** ([ADR-183](../architecture/13-decision-log.md#adr-183--staff-schedule-exports-of-the-shops-orders-every-day-week-or-month-the-worker-emails-each-the-orders-placed-in-the-period-that-ended-as-an-attachment-at-the-hour-they-chose-in-the-shops-time-zone-exported-as-them-asking-identity-as-it-sends-whether-they-still-export-the-shops-orders-and-at-which-proved-email)):
  owners, managers and accountants schedule one for themselves (`orderExportScheduleCreate`),
  daily, weekly from Monday or monthly, at an hour in the shop's time zone, in either layout and
  format, filtered as the order list is. A shop keeps up to 20, listed and deleted through the
  Admin API, each change audited (migration 0119).
* The worker sends each period's orders once it ends, attached to an email to the member's proved
  address, through Amazon SES as a raw MIME message from Hatti's address. It exports as the member,
  in their role then: numbers masked as they would see them, and the export in the audit log as
  theirs, naming the schedule. Identity says whom each goes to as it is sent
  (`identity.staff_email`), so a member who left the shop, lost the role or their proved email
  gets nothing. What SES can't take yet is tried again for a day.
* Tried on the dev worker: it wrote the demo shop's workbook for 4 October to the log, for its
  owner, and moved the schedule on to the next day at 08:00 in Karachi.

### 02ff2c5 · Orders as an Excel file

* **An order export may be an Excel workbook** ([ADR-182](../architecture/13-decision-log.md#adr-182--an-order-export-may-be-an-excel-workbook-as-well-as-csv-one-sheet-written-by-a-package-of-hattis-own-its-amounts-and-counts-numbers-and-its-times-dates-as-a-spreadsheet-keeps-them-and-numbers-that-begin-with-0-kept-as-text-given-in-base64-in-the-mutations-answer-as-the-csv-is-given-in-it)):
  `ordersExport(format: XLSX)` gives the CSV's rows in one sheet, its header bold, in view and
  filtered, its amounts and counts numbers and its times dates, while numbers, postcodes and SKUs
  stay text as typed. Every export's answer gives `file`, named for the day it was exported, its
  bytes in base64, and the audit log says which format it was.
* `@hatti/xlsx` writes the workbook with no dependency: its six XML parts zipped with Node's own
  zlib, text never written as a formula and what XML cannot carry left out. openpyxl and ExcelJS
  read it back as written; its `testing` entry reads it back for tests.

### 8f9b2ee · Order emails to customers

* **A shop's customers hear of their orders by email too**
  ([ADR-181](../architecture/13-decision-log.md#adr-181--a-shops-customers-hear-of-their-orders-by-email-too-where-they-gave-one-at-checkout-each-message-about-an-order-queues-a-copy-for-the-address-with-the-same-words-and-link-which-the-worker-sends-through-amazon-ses-from-hattis-address-under-the-shops-name-emails-cost-the-shop-nothing)):
  checkout asks for an email, which may be left empty, after the mobile number, and keeps it,
  lowercased, with the order and the customer it makes. Each message about the order, placed or
  asked to confirm, confirmed, shipped, out for delivery, delivered, cancelled, paid or reminded,
  queues a copy for the address with the same words and the order's link, once by its key
  (migration 0118 lets a message go by email).
* The worker sends them through Amazon SES, with the settings the API sends accounts' emails
  with, which it reads now too: from Hatti's address under the shop's name, a subject of its own
  in English or Urdu, the order's page as a button, and why the email came. What SES refuses for a
  while is tried again, and what it refuses outright fails. Emails cost the shop nothing, and the
  Admin API lists them among its messages, as `EMAIL`.
* A customer's erasure deletes what went to their email, and their own file has it. Checkout's
  codes go by `PhoneChannel`, WhatsApp or SMS, and billing prices those alone.

### 794bcd1 · Sessions, conversion and the live view

* **The online store counts its sessions as Shopify does**
  ([ADR-180](../architecture/13-decision-log.md#adr-180--the-online-store-counts-its-sessions-as-shopify-does-a-browsers-pages-with-no-half-hour-between-them-a-script-in-each-page-keeps-a-sessions-id-in-a-cookie-of-the-shops-and-tells-the-storefront-of-each-page-which-counts-each-days-sessions-in-the-shops-time-zone-and-those-that-added-to-the-cart-reached-checkout-and-placed-an-order-as-hyperloglogs-in-valkey-with-who-saw-a-page-in-the-last-five-minutes-the-worker-keeps-each-days-counts-in-postgres-every-minute)):
  a script in each shopper's page keeps a session's ID in a cookie for half an hour from each
  page and tells the storefront of it (`POST /.hatti/visit`), and the storefront counts each
  day's sessions in the shop's time zone, now in its document, with those that added to the cart,
  reached checkout and placed an order, as HyperLogLogs in Valkey, and who saw a page in the last
  five minutes. Robots, staff's previews and the sample shop are not counted.
* The worker keeps each day's counts in Postgres every minute (migration 0117), and the Admin
  API gives `storefrontSessions`, a period's day by day, week by week or month by month with the
  conversion rate, and `storefrontLiveView`, who is on the shop now and today's counts, both
  under `read_orders`, as the sales report.

### 7d62950 · Sign-in alerts

* **An owner hears of a sign-in from a device new to their account**
  ([ADR-179](../architecture/13-decision-log.md#adr-179--a-sign-in-from-a-device-none-of-an-accounts-sessions-was-used-from-in-90-days-tells-its-owner-what-signed-in-when-and-from-where-a-device-is-the-random-id-its-client-keeps-or-for-a-client-that-keeps-none-its-user-agent-version-numbers-aside-by-email-where-the-accounts-email-is-proved-else-on-whatsapp-or-by-sms-to-its-proved-number-five-a-day-at-most-never-failing-the-sign-in)):
  what signed in ("Chrome on Android"), when, in Pakistan, and from which address, by email where
  the account's email is proved, else on WhatsApp or by SMS to its number, from Hatti's own
  (`sign_in_alert`, at Hatti's cost); five a day at most, and never failing the sign-in. A
  device is new when none of the account's sessions was used from it in 90 days.
* **A device is the random ID its client keeps for it,** sent in `X-Hatti-Device` with each
  sign-in, since browsers of a make now say the same of themselves: every Chrome on Android reads
  alike. Sessions keep a digest of it with the account's ID (migration 0116). A client that sends
  none is its user agent, version numbers aside, compared only with sessions that sent none
  either, so leaving the ID out never passes for the owner's phone.
* The device list names each session's browser and system in the same words. Alerts are in
  English for now, accounts keeping no language.

### 003e36b · Menus that link to blogs

* **A shop's menus link to its blogs and articles** ([ADR-178](../architecture/13-decision-log.md#adr-178--menus-link-to-a-shops-blogs-and-articles-as-they-do-to-its-pages-by-id-a-blogs-link-leads-to-it-an-articles-to-its-blogs-address-and-its-own-and-an-article-not-published-is-left-out)) as they do to its
  pages: `BLOG` and `ARTICLE` items name them by ID, a blog's link leads to `/blogs/news` and an
  article's to its blog's address and its own, so a blog's new handle moves both, and an article
  not published or deleted is left out. The storefront's menus are published again as they
  change. The seed's footer links to its blog.

### 3bc71da · Blogs on the storefront

* **A shop's blogs show on its storefront** ([ADR-177](../architecture/13-decision-log.md#adr-177--a-shops-blogs-show-on-its-storefront-as-shopifys-do-a-blogs-document-lists-its-published-articles-the-latest-first-with-their-tags-and-each-articles-is-found-by-its-blogs-handle-and-its-own-a-blogs-page-lists-a-page-of-them-at-a-time-those-with-a-tag-apart-and-the-sitemaps-list-both)):
  `/blogs/news` lists its published articles, the latest first, a page at a time, each with its
  date, author and summary; `/blogs/news/tagged/eid` those with a tag; and
  `/blogs/news/eid-lawn-is-here` an article, with its blog. Hatti Base has `blog` and `article`
  templates in English and Urdu, and themes get Shopify's `blog`, `article`, `current_tags`,
  `blogs['news']` and `articles['news/eid-lawn-is-here']`, and blog and article settings.
* The publisher writes a document for each blog, listing its published articles with their tags,
  and one for each article, found by its blog's handle and its own, so an article's page is one
  round trip and the sitemaps list articles as paths. A blog's new handle moves its articles'
  addresses, and a blog deleted takes its articles off. The edge forgets an article's blog's
  page with it. Dates print in Pakistan's time. The seed's shop has a blog of two articles.

## 2026-10-03

### c1a8b98 · Blogs and their articles in the core

* **A shop keeps blogs, and articles in them, as Shopify does**
  ([ADR-176](../architecture/13-decision-log.md#adr-176--a-shops-blogs-and-their-articles-are-the-online-stores-through-the-admin-api-as-shopifys-and-under-its-content-scopes-an-article-has-html-cleaned-as-a-pages-its-authors-name-tags-a-handle-unique-in-its-blog-and-when-it-was-published-never-in-the-future-and-goes-when-its-blog-is-deleted)):
  `blogCreate`, `articleCreate` and their kin through the Admin API, under new `read_content`
  and `write_content` scopes that owners, managers and marketers have. An article's body and
  summary are cleaned as a page's body is; it has its author's name, tags, a handle unique in its
  blog, and when it was published, an earlier date kept for one brought from another platform but
  never one ahead. Deleting a blog deletes its articles (migration 0115).
* New handles and an article moved to another blog leave redirects when asked, in the same
  transaction, and events name what changed for the storefront, which shows blogs next. Pages,
  blogs and articles now take handles, HTML and templates through the same helpers.

### 22782b6 · A reminder to confirm

* **A customer who has not answered is asked once more**
  ([ADR-175](../architecture/13-decision-log.md#adr-175--a-cash-on-delivery-order-whose-customer-has-not-answered-three-hours-after-it-was-placed-asks-them-once-more-with-the-same-buttons-and-link-in-the-shops-calling-hours-a-sweep-in-the-worker-finds-them-and-an-order-placed-more-than-three-days-before-is-left-to-the-desk)) to
  confirm their cash-on-delivery order, three hours after it was placed, in the shop's calling
  hours or from 9 to 9 without them: `order_confirmation_reminder`, with the question's Confirm,
  Cancel and Change address buttons and the link its messages carried, its answers heard as the
  question's. A sweep in the worker finds the shops with orders to ask; each order is asked once
  (`confirmation_reminded_at`, migration 0114), and `order.confirmation_reminded` asks the
  worker's notifications to send it.
* Orders placed more than three days before are left to the desk, so a first sweep asks no
  backlog. The wait is three hours, 06 §3's, rather than the six first written. A test that asked
  at a fixed date found orders other tests had placed: its time is now days ahead of the clock.

### 8b28b0c · A reminder before an unpaid order is cancelled

* **A customer is reminded to pay** ([ADR-174](../architecture/13-decision-log.md#adr-174--an-order-still-waiting-for-its-payment-in-a-shop-that-cancels-such-orders-reminds-its-customer-once-a-day-before-its-days-run-out-and-no-sooner-than-half-a-day-after-it-was-placed-what-it-waits-for-by-when-in-the-shops-time-and-its-page-which-says-how-to-pay)) once, a day before a shop
  that cancels unpaid orders cancels theirs, and no sooner than half a day after it was placed:
  `order_payment_reminder`, with what the order waits for, by when in the shop's own time, and a
  button to its page, which says how to pay. The worker's unpaid sweep reminds before it cancels,
  each order once (`payment_reminded_at`, migration 0113), and `order.payment_reminded` says when
  the order is cancelled.
* Not one with a receipt waiting or a payment started online in the last day, as for cancelling,
  and nothing for one paid meanwhile. The sweep says how many it reminded and cancelled.

### 3e1cbb1 · Telling a number it was replaced

* **A number an account had proved is told when another takes its place**
  ([ADR-173](../architecture/13-decision-log.md#adr-173--a-number-an-account-had-proved-is-told-on-whatsapp-from-hattis-own-number-or-else-by-sms-when-another-takes-its-place-which-number-signs-in-now-masked-and-to-contact-support-if-its-owner-did-not-change-it-a-number-only-typed-is-told-nothing)): `number_replaced`, a message of Hatti's own sent at once on
  WhatsApp, else by SMS, says which number signs in now, masked, and to contact support if its
  owner did not change it, in the language `POST /auth/phone` gives.
* A number only typed signed in to nothing and is told nothing; proving the same number again
  tells nothing. `PhoneCodeSender.tellReplaced` says it, as the sender sends codes.

### bbccd26 · Changing an account's email

* **An account's owner changes its email** ([ADR-172](../architecture/13-decision-log.md#adr-172--an-accounts-owner-changes-its-email-or-gives-one-to-an-account-opened-with-a-phone-from-a-session-proved-lately-and-past-its-second-factor-a-link-to-the-new-address-good-once-for-a-day-proves-it-before-it-counts-an-address-another-account-has-is-refused-and-the-address-before-is-told)), or gives one to an
  account opened with a phone: `POST /auth/email/change` from a session proved lately and past its
  second factor sends a link to the new address (`hce_`, `/change-email`), good once for a day,
  and `POST /auth/email/change/confirm` makes it the account's, proved. Nothing changes until it is
  opened; an address another account has is refused, then as before.
* **The address before is told,** in the link's language, which each email token now keeps
  (migration 0112), and its links work no more. An address that bounced or complained is sent
  none.

## 2026-10-02

### 6596df3 · Customers told their payment came

* **A customer paying ahead hears the shop has their payment** ([ADR-171](../architecture/13-decision-log.md#adr-171--a-customer-hears-on-whatsapp-or-by-sms-where-the-shop-saves-that-the-shop-has-their-payment-while-the-order-waits-to-ship-once-it-is-paid-in-full-by-transfer-online-or-as-staff-record-it-and-paying-on-delivery-once-its-advance-is-in-with-what-is-left-for-the-rider-cash-paid-at-the-door-is-no-news-to-whoever-paid-it)),
  while the order waits to ship: `order_paid` once it is paid in full, by transfer, online or as
  staff record it, and `order_advance_paid` once a cash-on-delivery order's advance is in, with
  what is left for the rider. News alone, so by SMS where the shop routes news economically; the
  shop may turn either off.
* Cash paid at the door is no news to whoever paid it: an order already shipped is told nothing,
  nor one paid part of its advance or transfer. The worker reads the order as it is when it hears
  the payment, so one heard late says what is paid by then.

### 73c1eb2 · Bounces and complaints from SES

* **Hatti hears SES's bounces and complaints** ([ADR-170](../architecture/13-decision-log.md#adr-170--hatti-hears-amazon-sess-bounces-and-complaints-through-an-sns-topic-of-its-own-posted-to-its-webhook-and-checked-against-the-certificate-sns-signs-with-served-from-snss-own-host-an-address-that-bounced-for-good-or-whose-recipient-marked-an-email-as-spam-is-sent-none-of-hattis-emails-again-and-the-webhook-confirms-its-topics-subscription-itself)) through an SNS topic
  of its own, `SES_FEEDBACK_TOPIC_ARN`, which SNS posts to `/webhooks/ses`. Each message is checked
  as SNS signs it, against the certificate it names on SNS's own host, fetched and kept a day; the
  webhook confirms the topic's subscription itself.
* **An address that bounced for good, or complained, is sent no more** (migration 0111): another
  link proving it is refused as `EMAIL_UNDELIVERABLE`, a forgotten password is answered as ever and
  nothing sent, and a sign-up's link and an invitation are not sent. A full mailbox changes
  nothing.
* Tests sign as SNS does with `SnsTestTopic`, a key of its own in place of SNS's certificates. Not
  yet: lifting a suppression, and changing an account's email.

### 5e81715 · Owners told of their bills

* **The owner hears on WhatsApp of the shop's bills with Hatti** ([ADR-169](../architecture/13-decision-log.md#adr-169--hatti-tells-a-shop-on-whatsapp-at-the-number-it-gives-for-hattis-alerts-when-its-plans-next-period-is-invoiced-when-its-plan-ends-unpaid-and-when-its-message-credit-falls-below-rs-100-each-once-queued-with-its-messages-from-billings-events-at-hattis-cost-whatever-its-credit-and-never-turned-off)),
  at the number it gives for Hatti's alerts: `invoice_due` when a plan's next period is invoiced, a
  week before the period ends, with the invoice's number, the plan and the amount; `plan_ended`
  when the plan lapses unpaid and the shop is on Free; and `credit_low` when its message credit
  falls below Rs 100, with what is left. The worker's `BillingNotices` queues them from billing's
  events, once each; nothing goes without a number.
* **The credit falling low is billing's event,** `billing_credit.low`, appended by the wallet
  entry that takes it from Rs 100 or more to below it; told again only after it is above Rs 100
  once more.
* **Hatti pays for them**, whatever the shop's credit, below nothing too: their templates say
  `hattiPays`, which messaging reads both as it charges what it sent and as the sender checks the
  credit. Writing the worker's test caught the sender still holding them back once the credit was
  below nothing, where even a price of nothing was more than it held. The shop cannot turn them off.
* Not yet: email to owners, as the worker reads no accounts; a reminder once a period ends unpaid,
  with humane dunning (BIL-04).

### b1daa9e · Orders never paid

* **An order never paid is cancelled** in the days its shop allows ([ADR-168](../architecture/13-decision-log.md#adr-168--an-order-still-waiting-for-its-payment-by-transfer-online-or-its-advance-as-many-days-after-it-was-placed-as-its-shop-says-is-cancelled-by-a-sweep-in-the-worker-its-stock-let-go-and-its-customer-told-one-with-a-receipt-waiting-to-be-checked-is-left-to-staff-and-one-with-a-payment-started-online-in-the-last-day-waits-for-it)):
  `cancelUnpaidAfterDays`, 1 to 30, in the order settings, none by default. A sweep in the worker
  cancels the orders still waiting for their transfer, their payment online or their advance that
  long after they were placed, as `UNPAID`, their stock let go and their customers told as for any
  cancellation (migration 0110).
* Not one with a transfer receipt waiting for staff to check it, nor one with a payment started
  online in the last day, which the payments module names: a JazzCash voucher may still be paid.

### f60d929 · Invitations by email

* **Hatti emails an invitation** where its inviter gives an address ([ADR-167](../architecture/13-decision-log.md#adr-167--hatti-emails-an-invitation-to-work-in-a-shop-to-the-address-its-inviter-gives-beside-the-link-the-inviter-shares-themselves-in-english-or-urdu-20-a-day-for-a-shop-at-most-the-invitation-keeps-the-address-and-its-link-is-still-whoever-holds-its-to-accept)):
  `staffInvitationCreate(email, language)` sends the link through the same sender as accounts'
  emails, in English or Urdu, and still returns it for the inviter to share; `emailed` says whether
  it went.
* The invitation keeps the address (migration 0109) and `staffInvitations` shows it. A shop has 20
  invitations by email a day; the link stays whoever holds it's to accept, whatever their email.

### f48dc00 · A number for accounts opened with an email

* **Every account reaches the WhatsApp sign-in** ([ADR-166](../architecture/13-decision-log.md#adr-166--an-account-opened-with-an-email-or-with-google-proves-a-mobile-number-with-the-same-codes-from-a-session-proved-lately-and-past-its-second-factor-where-it-has-one-the-number-signs-it-in-from-then-on-in-place-of-any-it-typed-or-proved-before-and-a-number-another-account-proved-stays-that-accounts)):
  one opened with an email, or with Google, proves a Pakistani mobile with the same codes,
  `POST /auth/phone/code` and then `POST /auth/phone` with its access token, and the number signs
  it in from then on, in place of any it typed or proved before (ONB-01).
* Taken from a session proved in the last 15 minutes that passed the account's second factor
  where it has one, as connecting Google is; a number another account proved stays its own.
* The code is checked as signing in checks it, by one method both now share.

### 01684e2 · Email for accounts

* **Hatti sends its own email** ([ADR-165](../architecture/13-decision-log.md#adr-165--hatti-sends-its-own-email-about-accounts-through-amazon-ses-a-link-proving-an-accounts-email-good-once-for-a-day-and-one-resetting-a-forgotten-password-good-once-for-an-hour-each-carrying-a-token-of-its-own-in-the-links-fragment-kept-as-a-digest-the-last-of-its-kind-alone-working-a-reset-ends-every-session-and-proves-the-email-and-the-accounts-second-factor-is-still-asked)),
  through Amazon SES's v2 API, each request signed by the storage package's own Signature Version
  4 signer, with no AWS SDK. The identity module writes the emails, in English or Urdu, as text
  and HTML; locally the log stands in (`SES_REGION`, `SES_ACCESS_KEY_ID`,
  `SES_SECRET_ACCESS_KEY`, `EMAIL_FROM`).
* **An account proves its email** by a link sent at sign-up or asked for, good once for a day;
  profiles say `emailVerified`, and Google's emails count as proved.
* **A forgotten password is reset** by a link good once for an hour (`/auth/password/forgot`,
  `/auth/password/reset`): the answer the same whether or not an account has the email, the new
  password checked as at sign-up, every session ended and the second factor still asked. An
  account opened by phone or with Google gets its first password the same way.
* Each link opens the admin at `ADMIN_URL` with its token in the fragment, kept as a digest
  (migration 0108): the last of its kind alone works, a minute apart and five an hour at most.

### 4d61ce9 · Google sign-in

* **Merchants sign up and in with Google** ([ADR-164](../architecture/13-decision-log.md#adr-164--merchants-sign-up-and-in-with-google-through-googles-own-sign-in-its-id-token-checked-against-the-keys-google-publishes-for-one-of-hattis-client-ids-and-carrying-a-nonce-hatti-gave-out-once-names-the-account-by-googles-id-a-google-account-new-to-hatti-opens-an-account-with-the-email-google-confirmed-an-email-alike-never-connects-one-and-an-accounts-owner-connects-or-disconnects-google-from-a-session-that-proved-who-is-at-it)),
  the last of ONB-01's ways in, beside an email's password and a code to their number. The admin
  and the apps start Google's own sign-in with the client ID and nonce `POST /auth/google/options`
  gives, and send the ID token Google gives them to `POST /auth/google/sign-in`.
* **Checked against Google's keys** with `jose`, the library oidc-provider is built on, new in the
  catalog: RS256 alone, Google's issuer, for one of Hatti's client IDs (`GOOGLE_CLIENT_IDS`, the
  admin's first), unexpired, and carrying a nonce the API gave out, spent once. No client secret
  is kept.
* **A Google account new to Hatti opens an account at once,** with Google's name and the email
  Google confirmed, the first email Hatti knows is its account's own; one connected signs in as a
  password does, the account's second factor still asked. An account with the same email is never
  joined to it: its owner signs in their usual way and connects Google, or disconnects it, from a
  session proved lately (migration 0107). `/auth/me` names the Google account connected.
* Tests stand in for Google with keys of their own (`GoogleTestIssuer`, in the identity module's
  testing entry).

### 79a3bb4 · JazzCash

* **Shops take payments through JazzCash** ([ADR-163](../architecture/13-decision-log.md#adr-163--jazzcash-is-the-second-gateway-shops-take-payments-through-by-its-hosted-checkout-the-customers-browser-posts-a-form-signed-with-the-accounts-integrity-salt-to-jazzcashs-page-from-a-page-of-hattis-with-a-button-as-these-pages-run-no-scripts-and-jazzcash-posts-the-outcome-back-signed-the-same-way-the-form-is-never-kept-and-nothing-is-given-back-through-its-api)),
  the MVP's second gateway beside Safepay (PAY-01), by its hosted checkout: wallets, cards and
  vouchers paid at shops. An account gives its merchant ID, password and integrity salt, sealed as
  Safepay's are.
* **Its page takes a form:** a gateway's checkout may now carry the fields the customer's browser
  posts to its page (`GatewayCheckout.form`). JazzCash's are signed with the account's salt: the
  amount in paisa, a reference of Hatti's, the order's number, a day to pay and the return
  address. Asked to pay, the order's page and checkout's thank-you page answer with a page that
  carries the form and a "Continue to JazzCash" button, as they run no scripts, its policy letting
  the form go to JazzCash alone. The form is never kept: each time is a new session.
* **JazzCash posts the outcome back**, signed the same way, and its notification does too: a
  payment at response code 000, recorded once as Safepay's are.
* A test's stand-in for WhatsApp gave two messages one ID once its list of requests was emptied,
  so a customer's reply could be taken for another's, now and then under load: its IDs never
  repeat now.

### 7165297 · Leopards

* **Shops book with Leopards** ([ADR-162](../architecture/13-decision-log.md#adr-162--leopards-is-the-second-courier-shops-book-with-through-the-same-adapter-the-accounts-key-and-password-in-each-requests-body-a-parcels-city-by-leopards-own-id-from-its-list-of-cities-kept-a-day-the-accounts-own-shipper-unless-a-shipper-id-is-given-its-parcels-asked-about-fifty-at-a-time-and-its-words-read-through-rows-of-data)),
  the second of the MVP's couriers, through the same adapter as PostEx (SHP-01): an account's
  API key and password, in each request's body; a booking to Leopards' ID for the parcel's city,
  from its list of cities, kept a day and matched however the city is spelt; the account's own
  shipper unless a shipper ID is given as its pickup code; half a kilo for a parcel without a
  weight. Cities Leopards does not deliver to are refused with why.
* **Its parcels are followed fifty a request**: a refused batch is asked about a parcel at a time,
  those Leopards does not know left out, and every one refused stops the round, as the account's
  doing. Its words are rows of data (migration 0106), as PostEx's are.
* `LEOPARDS_URL` points the worker at Leopards' staging API or a stand-in. Its calls follow the
  public wrappers of its API; the first account checks them against its staging API.

### ff97b1c · Link-in-bio pages

* **A link page for each shop's bios and chats** ([ADR-161](../architecture/13-decision-log.md#adr-161--a-shops-link-page-at-links-is-a-line-about-it-up-to-ten-links-and-up-to-24-of-its-products-kept-with-what-it-sets-for-its-storefront-the-storefront-shows-it-in-the-platforms-markup-inside-the-shops-theme-in-the-pages-language-a-product-with-nothing-to-choose-a-tap-from-checkout-and-the-edge-keeps-it-until-the-shop-or-any-of-its-products-changes)):
  `/links` on its storefront, and `/ur/links`, shows the shop's name, a line about it, up to ten
  links of its own and a chat on WhatsApp, and up to 24 of its products, each with its price
  (CH-07). One with a single variant has "Buy now", its cart permalink, straight to checkout; one
  with more, "Choose options" on its page; one with nothing to sell, "Sold out". It is the
  platform's markup inside the shop's theme, as policies are, which Hatti Base styles, and its
  paths on the shop keep the page's language. A shop that set nothing has the page too.
* **Kept with the storefront's preferences** (migration 0105):
  `onlineStorePreferencesUpdate(input: { linkPage })` sets its line, links and products, each
  part given replacing what it had: links to paths on the shop or https addresses alone, and the
  shop's own products, of any status; one deleted since is left out. It goes out with the shop's
  document, whose shape is now version 8.
* **Kept at the edge** until the shop or any of its products changes: the page names
  `/collections/all`, whose tag every product's change purges.
* The seed's shop has one.

### baaf41c · Branded tracking page

* **Each parcel's way, step by step** ([ADR-160](../architecture/13-decision-log.md#adr-160--each-parcels-way-is-kept-step-by-step-as-shopifys-fulfillmentevent-its-couriers-changes-recorded-once-from-the-workers-tracking-and-staffs-for-couriers-hatti-does-not-follow-the-orders-page-shows-them-the-latest-first-in-english-and-urdu-the-shipped-message-links-that-page-and-a-parcel-out-for-delivery-with-cash-to-collect-tells-its-customer-what-to-keep-ready)):
  `orders.fulfillment_events` (migration 0104) keeps a parcel's steps as Shopify's
  FulfillmentEvent names them, with Hatti's own returning and returned. The worker records what
  couriers say, once for each `shipment.status_changed` however often it comes (`ParcelSteps`);
  staff and apps record what couriers Hatti does not follow tell them, through
  `fulfillmentEventCreate`, and read every step through `Fulfillment.events` (SHP-05).
* **The order's page tracks its parcels:** each parcel's way, the latest step first, with times in
  the shop's time zone and the courier's words, in English and Urdu, in the shop's colours; "Out
  for delivery today" at the top, with what to pay.
* **Messages bring customers to it:** the shipped message carries the order's page, by SMS after
  its words and on WhatsApp behind a button; and a parcel with cash to collect tells its customer
  each time it goes out for delivery what to keep ready for the rider (`order_out_for_delivery`).
  A message carries the link the order's messages carried before, while it works, so earlier
  messages' links keep working.
* Erasure clears the words on the customer's parcels' steps.

### a82699e · Phone sign-up

* **Merchants open an account and sign in with their mobile number** ([ADR-159](../architecture/13-decision-log.md#adr-159--merchants-open-an-account-and-sign-in-with-their-mobile-number-and-a-code-sent-to-it-on-whatsapp-or-by-sms-from-hattis-own-number-at-hattis-cost-six-digits-for-ten-minutes-and-five-tries-a-number-sent-five-an-hour-and-ten-a-day-a-number-proved-is-one-accounts-alone-one-only-typed-never-signs-in-and-an-accounts-second-factor-is-still-asked)):
  `POST /auth/phone/code` sends six digits to a Pakistani mobile on WhatsApp from Hatti's own
  number, or by SMS when asked or when WhatsApp cannot deliver it, in English or Urdu (ONB-01).
  `POST /auth/phone/sign-in` with the code signs in to the account whose number it proves, its
  second factor asked where it has one; for a number no account has, it gives a sign-up token,
  and `POST /auth/phone/sign-up` with it and the merchant's name, and an email if they give one,
  opens the account and signs it in. Migration 0103.
* **At Hatti's cost, against SMS pumping:** the API sends codes itself, as `sign_in_code`, a
  message of Hatti's own that no shop's credit pays for. A code works ten minutes and five tries,
  the last one sent alone; a number waits 30 seconds between codes and is sent five an hour and
  ten a day, one address asks for 30 an hour, and only Pakistani mobiles are sent any. Requests
  for one number take turns, so many at once get one code. Codes are kept as digests, for 30 days.
* **A number is one account's:** proved numbers are unique, and a number typed at an email
  sign-up stays unproved and never signs in. An account opened by phone has no password and no
  email unless it gives one; the API's `StaffMember.email` can be null now.
* The API reads the WhatsApp and SMS settings the worker reads; `messageProvidersOf` moved to
  `apps/core/src/messaging.ts` for both.

### 1e78d18 · Product images

* **Hatti keeps products' images itself** ([ADR-158](../architecture/13-decision-log.md#adr-158--hatti-keeps-products-images-itself-the-worker-reads-each-from-the-shops-upload-or-fetches-it-from-its-url-never-reaching-a-private-network-checks-it-and-keeps-a-clean-copy-without-its-metadata-at-most-4096-pixels-a-side-the-api-serves-it-at-nine-widths-in-avif-webp-or-its-own-format-each-made-the-first-time-it-is-asked-for-and-kept-and-an-image-goes-from-storage-and-the-edge-with-its-media)):
  `productCreateMedia` takes a staged upload's `resourceUrl` as well as an https URL, and the
  worker reads the upload from storage or fetches the URL, checks it is an image to show, and
  keeps a clean copy (CAT-02): turned as the camera was held, at most 4,096 pixels a side, in sRGB
  and without the metadata a phone adds, where the photo was taken among it; JPEG, or PNG when
  some of it is see-through. Migration 0102.
* **Served at the sizes and formats browsers ask for:** `/images/{shop}/{media}/{handle}.jpg` on the
  API's public site, `?width=` made at the next of nine widths from 96 to 2,048 pixels, in AVIF or
  WebP as the browser's Accept header allows, else the clean copy's own format. Each is made the
  first time it is asked for, kept beside the clean copy, and kept by browsers and the edge for a
  year. The Admin API's media have `image { url width height altText }` and `mediaErrors`, in
  Shopify's codes; storefront documents show ready images from there, with their sizes.
* **Fetched without reaching a private network:** https alone; every address the host has must
  be public, and the connection is made to the addresses checked; each redirect is checked again;
  20 MB and 30 seconds at most. A source that does not answer is tried again for about half an
  hour; an image that is not one to show fails at once, saying why, HEIC photos among them.
* **Gone with its media:** deleting a media, or its product, queues its images' removal
  (`catalog.media_removals`, by a trigger); the worker removes them from storage and purges their
  tag from the edge.
* A new platform package, `@hatti/images`, holds the checks, the clean copy, the sizes and formats
  (on sharp, libvips) and the fetcher; storage gained `read` and `deletePrefix`. Exports give
  ready images' own addresses as their Image Src, and imports know them, so a file imported again
  adds no image twice.

### 6d68bf8 · Low-stock alerts

* **The shop hears on WhatsApp when a variant runs low, and again when it runs out** ([ADR-157](../architecture/13-decision-log.md#adr-157--the-shop-hears-on-whatsapp-when-a-variant-runs-low-on-stock-and-again-when-it-runs-out-at-the-number-it-gives-for-hattis-alerts-once-for-each-spell-of-low-stock-which-inventory-keeps-until-the-variant-is-stocked-above-the-threshold-again-the-worker-hears-each-levels-change-and-queues-the-alert-as-a-message-the-shops-credit-pays-for)):
  at the number it gives for Hatti's alerts (`messagingSettings.alertsPhone`, migration 0101), in
  two new messages from Hatti's number, `stock_low` and `stock_out`, which name the product and
  its variant and what is left for sale online (INV-01). The shop turns either off as it does
  its customers' notifications, and its credit pays for them as for any message.
* **Once a spell:** inventory keeps each variant low on stock (`inventory.low_stock_spells`) from
  when it falls to the shop's threshold until it is stocked above it, so a variant selling unit
  by unit alerts once, and once more when it runs out. The worker hears each level's change
  (`LowStockAlerts`), asks inventory whether an alert is due, and queues it once by its key.
* The alerts number is never written to the audit log, which keeps no contact details.

### 6138271 · Support access

* **Hatti's support looks at a shop only while its owner allows it** ([ADR-156](../architecture/13-decision-log.md#adr-156--hattis-support-looks-at-a-shop-only-while-its-owner-allows-it-15-minutes-to-a-day-its-agents-hattis-own-people-signed-in-with-a-second-factor-come-as-a-caller-of-their-own-with-every-read-scope-numbers-masked-change-nothing-and-each-of-their-requests-goes-on-the-shops-audit-log-before-it-runs)):
  the owner, having signed in lately, lets it look for 15 minutes to a day (`supportAccessGrant`),
  and the owner or a manager ends it at any time (`supportAccessEnd`), each on the audit log
  (ADM-08). Migration 0100.
* **Its agents are Hatti's own accounts**, marked with `pnpm --filter @hatti/core support-agent
  add <email>` and signed in with a second factor: `GET /auth/support/shops` lists the shops open
  to them, and the Admin API takes their session for those as a caller of its own kind,
  `support`, with every read scope and no write.
* **It reads alone**: a request that is not one query is refused before it runs
  (`SUPPORT_READ_ONLY`), and the scope guard refuses its mutations however they come; customers'
  numbers are masked. Each query goes on the shop's audit log first (`support.looked`), with its
  grant and what it asked for.

### 5bcd5ae · Message credits

* **A shop's messages are paid from credit in rupees** ([ADR-155](../architecture/13-decision-log.md#adr-155--a-shops-messages-are-paid-from-credit-in-rupees-it-buys-from-hatti-with-an-invoice-of-its-own-each-is-charged-as-it-is-sent-at-what-it-costs-hatti-and-hattis-fee-in-a-ledger-kept-beside-the-balance-a-message-the-credit-cannot-pay-for-waits-and-a-code-is-not-sent-and-what-whatsapp-could-not-deliver-is-given-back)):
  bought from Hatti with an invoice of its own (`billingCreditsBuy`, Rs 500 to Rs 100,000, the
  owner alone), paid through Hatti's gateway as a plan is, and spent as each message goes (BIL-03,
  MSG-04). Migration 0099 lets an invoice be for credit, waiting beside the plan's.
* **Each message costs what it costs Hatti and Hatti's fee**: WhatsApp's by Meta's category of
  its template, Rs 4.62 for an order's news or a code, and an SMS's by the part, Rs 1.73, Urdu
  taking 70 characters a part; `billingMessagePrices` lists them. The messaging module asks
  through a port (`MessageCharges`) the billing module provides, and charges a message in the
  transaction that records it sent.
* **A message the credit can't pay for waits**, tried again as one its channel could not take,
  for a day; a one-time code fails at once. What WhatsApp says it could not deliver is given back.
  Every change is an entry with the balance after (`billingWallet`, `billingWalletEntries`); the
  seed's shop has Rs 1,000.
* ADR-154's path of an invoice's page, garbled in its commit, reads `/billing/invoices/<id>/paid`
  again.

### c34f7e8 · Plans and billing of shops

* **Shops pay Hatti for a plan** ([ADR-154](../architecture/13-decision-log.md#adr-154--shops-pay-hatti-for-a-plan-in-rupees-by-the-month-or-the-year-through-hattis-own-payment-gateway-account-a-bigger-plan-begins-once-its-invoice-is-paid-less-what-is-left-of-the-period-it-cuts-short-a-smaller-one-when-the-period-ends-each-period-is-invoiced-a-week-ahead-and-a-week-unpaid-puts-the-shop-on-free-other-modules-ask-each-plans-limits-through-a-port)): Free, or Starter, Growth or Pro in
  rupees, by the month or by the year at ten months' price, in a new `@hatti/billing` module
  (migration 0098). A shop without a subscription is on Free (BIL-01).
* **The owner alone chooses**, having signed in lately (`billingPlanChange`): a bigger plan is
  invoiced now, less what is left of the period it cuts short in whole rupees, and begins once
  paid; a smaller plan, or Free, begins when the period ends, and choosing the current plan again
  drops that. Each choice is audited.
* **Invoices are paid through Hatti's own Safepay account** (`billingInvoicePay`,
  `BILLING_SAFEPAY_*`; the test gateway locally), numbered across Hatti (`HB-000123`): each try
  recorded before the owner leaves, then the signed return to the invoice's page or the webhook
  (`/webhooks/billing`) pays it once. The worker invoices each period a week ahead, and a week
  unpaid puts the shop on Free, its invoice still payable.
* **Plans' limits hold staff and locations** through a port in `@hatti/api` (`PlanAllowance`) the
  billing module provides: inviting one more member than the plan has room for, or adding one
  more location, is refused with the plan named. The seed's shop is on Pro.

### 823014e · Refunds online

* **Money paid online goes back through the gateway that took it** ([ADR-153](../architecture/13-decision-log.md#adr-153--money-paid-online-goes-back-through-the-gateway-that-took-it-as-far-as-its-adapter-can-give-it-back-safepay-a-payment-whole-each-refund-is-recorded-before-the-gateway-is-asked-and-written-on-its-order-once-the-gateway-says-it-is-sent-a-refusal-is-said-and-a-refund-without-an-answer-holds-its-amount-until-staff-settle-it-from-the-gateways-dashboard)):
  `orderRefund` by `ONLINE` asks the shop's gateway to send it, on the latest of the order's
  payments online that can take it, and writes it on the order as any refund once the gateway says
  it is sent, with the gateway's reference (PAY-06).
* **Each gateway says what it gives back** (`PaymentGateway.refunds`): Safepay a payment whole,
  asked for in paisa through its v3 API with the account's secret key, as its SDKs ask, so that a
  misread amount gives back the payment or nothing; the test gateway any part. Part of a Safepay
  payment is given back in its dashboard and recorded by hand.
* **Recorded before the gateway is asked** (`payments.refunds`, migration 0097), with the order
  locked, so nothing is given back twice; a refusal is said, and a refund without an answer holds
  its amount until staff settle it from the dashboard (`paymentRefundSettle`, audited). A refund
  by hand that came meanwhile leaves the gateway's no more than what was left, the rest on the
  timeline. `paymentSessions` shows each payment's refunds.

### 1465ad9 · Paying online at checkout

* **Checkout offers paying online** ([ADR-152](../architecture/13-decision-log.md#adr-152--checkout-offers-paying-online-where-the-shop-has-a-gateway-the-order-is-placed-to-wait-for-its-total-as-a-transfers-does-and-its-thank-you-page-sends-the-shopper-to-the-shops-gateway-which-sends-them-back-to-the-checkouts-address-on-the-core)) where the shop's gateway takes its
  currency: "Pay online, by card or wallet" beside cash on delivery and transfer, and in its
  place where the law, the shop's rules or its risk score refuse cash on delivery. The gateway's
  name is part of what the page showed, so one connected or archived since makes the page stale.
* **The order is placed first**, a new payment method, `online` (migration 0096, `ONLINE` in the
  Admin API): it waits at `AWAITING_PAYMENT` for its total, as a transfer's does, with no
  confirming, risk score, cash-on-delivery fee, transfer discount or advance. The API takes it
  only from a shop with a gateway, and drafts never.
* **Its thank-you page sends the shopper to the gateway**: **Pay online** records a session and
  answers with a 303 to the gateway's page, which storefronts relay without a referrer. The
  gateway sends the shopper back to the checkout's address on the core
  (`/checkouts/{secret}/paid`), since storefronts refuse posts from other sites; a signed return
  pays the order and the thank-you page says the payment is in, or that it waits to hear, or was
  a test.
* The order's page and the thank-you page share the words for paying online
  (`online-payment-page.ts`), and an order paid online alone offers no transfer or receipt.

### 39ad0b6 · The order's page lets its form go on to the gateway

* **Pay online went nowhere in Chrome.** Customers' pages send `form-action 'self'`, and Chrome
  holds a form's redirects to it: the order's page posting **Pay online** and answered with
  Safepay's checkout was refused. The page now names the gateway's checkout in its policy, by
  origin alone (`https://getsafepay.com`, or Safepay's sandbox), and nowhere else; the test
  gateway, whose page is the order's own, needs none.
* `renderPage` takes `formTargets`, origins over https or on this machine, and each gateway says
  where its checkout pages are (`checkoutOrigin`), which the orders module's port passes to the
  page with the gateway's name (`OnlineGateway`).

### 4d59c41 · Paying online through the shop's gateway

* **Shops connect their own payment gateway account** ([ADR-151](../architecture/13-decision-log.md#adr-151--shops-take-payments-online-through-their-own-gateway-accounts-safepay-first-their-credentials-sealed-for-each-account-an-order-waiting-for-its-money-offers-to-take-it-on-its-page-a-session-is-recorded-before-the-customer-leaves-for-the-gateway-and-the-gateways-signed-return-or-webhook-whichever-comes-first-records-it-paid-once-and-pays-what-the-order-owes-of-it-a-sandboxs-payments-pay-nothing)),
  Safepay first: `paymentGatewayAccountConnect` takes the API key, secret key and webhook secret
  Safepay's dashboard gives, sealed for that account alone and never shown again, in Safepay's
  sandbox or its real environment. Staff need to have proved who they are lately, as it changes
  where customers' money goes. One live account a gateway, each with a webhook address of its own
  to add in the gateway's dashboard (`payments.gateway_accounts`, migration 0095, in a new
  `@hatti/payments` module).
* **An order waiting for its money offers to take it online** on its page (PAY-04), a bank
  transfer's total or a cash-on-delivery order's advance, beside the transfer's details: **Pay
  online** records a session, starts Safepay's tracker for the amount and sends the customer to
  Safepay's checkout, the same one again if they ask within half an hour.
* **Safepay's signed return or webhook, whichever comes first, records it paid**, once however
  often heard: the customer back with the tracker signed with the secret key, or the webhook's
  body signed with the webhook secret, with the amount. What the order owes of it is paid on the
  order, "paid online through Safepay, reference …" on its timeline, and anything beyond goes
  there for the shop to give back. A sandbox's payments pay nothing, and say so on the page and
  the timeline, as anyone may hold its test cards.
* The orders module defines the port its pages use (`OnlinePayments`) and the functions that read
  and pay an order (`orderPaymentFactsIn`, `receiveOnlinePaymentIn`), which the payments module,
  global, provides and calls; `paymentSessions` lists an order's payments. Outside production, a
  test gateway takes nothing, its page sending the customer straight back.

### ed65862 · Labels and load sheets

* **Booked parcels print labels** ([ADR-150](../architecture/13-decision-log.md#adr-150--couriers-labels-and-load-sheets-are-hattis-own-printed-pages-a-booked-parcels-label-carries-the-couriers-tracking-number-as-a-code-128-barcode-and-the-cash-the-courier-was-asked-to-collect-one-to-a-46-inch-label-or-four-to-a-sheet-of-a4-and-an-accounts-load-sheet-lists-its-parcels-waiting-to-be-picked-up-for-the-shop-and-the-rider-to-sign)): `courierLabels` gives
  an HTML page to print, as packing slips are, with each parcel's courier, its tracking number as
  a Code 128 barcode, the order, who it goes to and where, the cash the courier was asked to
  collect, its pieces and contents, and where it came from; one to a 4×6 inch label, or four to
  a sheet of A4. Packers see the customer's number masked, as on packing slips.
* **A courier account's load sheet** (`courierLoadSheet`) lists its parcels waiting to be picked
  up, with their cash and totals, and boxes for the shop and the rider to sign.
* `@hatti/documents` draws Code 128 barcodes, its table checked against an independent table of
  bits, and formats days for every document; the orders module gives a parcel's own items for its
  label (`parcelShipmentFactsIn`).

### 82ca5a5 · Courier bookings

* **Shops connect their own courier accounts** ([ADR-149](../architecture/13-decision-log.md#adr-149--shops-book-orders-with-their-own-courier-accounts-their-credentials-sealed-for-each-account-each-booking-waits-in-postgres-until-the-worker-books-it-through-the-couriers-adapter-keeps-the-couriers-number-before-shipping-the-order-with-it-and-follows-the-parcel-by-asking-the-couriers-words-read-through-mappings-kept-as-data)), PostEx
  first: `courierAccountConnect` takes what the courier's portal gives, sealed for that account
  alone and never shown again, its last four characters for staff. One account is the default;
  an archived one books no more, its bookings waiting cancelled, and its parcels are still
  followed (`logistics.courier_accounts`, migration 0094).
* **`ordersBook` books up to 250 orders** with the default account or one named, each on its own:
  one that cannot ship now, has part shipped or is being booked already comes back with why; the
  rest wait in `logistics.bookings`, which `courierBookings` lists, and a booking waiting can be
  cancelled.
* **The worker books them** every half a minute: it tells the courier who receives the parcel
  where, what is in it and the cash the order owes, keeps the courier's tracking number at once,
  and ships the order as a parcel with it. A courier that cannot take it is asked again, a minute
  on and doubling, for a day; one that refuses it fails the booking in its words, and an order
  that changed meanwhile has the courier's booking cancelled.
* **Booked parcels are followed** as often as where they are calls for, PostEx's words read
  through `logistics.courier_statuses`: delivered and coming back are marked on the parcel, which
  tells the customer, and each change publishes `shipment.status_changed`. A courier's names for
  cities that are not Hatti's are in `logistics.courier_cities`.
* The orders module tells a courier's booking what it needs of an order (`orderShipmentFactsIn`)
  and lets the system change parcels (`ParcelCaller`). The worker reads `POSTEX_URL` and
  `COURIER_BOOKINGS_INTERVAL_MS`; outside production, shops can connect a test courier that books
  nothing.

### efd025a · Codes at checkout

* **Checkout asks for a code sent to the number typed** ([ADR-148](../architecture/13-decision-log.md#adr-148--checkout-asks-a-shopper-paying-on-delivery-for-a-code-sent-to-the-number-they-typed-on-whatsapp-or-by-sms-where-the-shops-risk-rules-score-the-order-at-its-mark-a-digest-of-the-code-alone-is-kept-and-the-order-keeps-when-its-number-was-proved)),
  where the shop's risk rules score an order paid on delivery at its mark,
  `verifyFromScore`, 0 for every such order: it places the order, reads its score and undoes it,
  then sends six digits on WhatsApp, through the messages engine's `one_time_code`, and asks for
  them, keeping what was typed. "Send the code by SMS instead" sends another; the newest alone
  works, for ten minutes and five tries.
* **Only a digest of each code is kept** (`checkout.number_codes`, migration 0093), with its number
  and tries, until its checkout goes. A checkout sends five codes at most, and a number is sent ten
  a day at most. The message drops the code once it is sent, and no SMS goes for it later.
* **The order placed keeps when its number was proved** (`orders.phone_verified_at`), and its
  timeline says so. Shops cannot turn codes off in their messaging settings.

### d8ee4dd · WhatsApp confirmations of cash-on-delivery orders

* **A cash-on-delivery order waiting for its customer asks them on WhatsApp to confirm it**
  ([ADR-147](../architecture/13-decision-log.md#adr-147--a-cash-on-delivery-order-waiting-for-its-customer-asks-them-on-whatsapp-to-confirm-it-with-confirm-cancel-and-change-address-buttons-and-its-link-their-answer-comes-through-the-webhook-as-an-event-and-the-worker-confirms-or-cancels-the-order-as-their-link-would)), in place of
  telling them it was placed: Hatti's template with the order and its total, and Confirm, Cancel
  and Change address buttons. The message carries the order's link, made once it is queued, so
  the SMS that goes in its place when WhatsApp cannot deliver it is the tap-to-confirm step.
* **Their answer comes back through WhatsApp's webhook**, which records it as `message.replied`
  in the message's shop, once it checks the answer came from the number the message went to.
  The worker acts on it: Confirm and Cancel confirm or cancel the order as the link does, "on
  WhatsApp" on its timeline, and a cancellation asked for too late stays there for the shop to
  see; Change address sends the order's page and notes that the customer asked.
* **An order confirmed, by its customer or the shop, says so** (`order_confirmed`). Shops turn
  any of these off as they turn off the others.
* The worker now reads `PUBLIC_URL`, as the API does, for the links; required in production.

### b2cf8aa · The messaging engine

* **Customers hear of their orders** ([ADR-146](../architecture/13-decision-log.md#adr-146--a-shops-customers-hear-of-their-orders-from-hattis-shared-whatsapp-number-or-by-sms-where-the-shop-saves-or-whatsapp-cannot-deliver-each-message-waits-in-postgres-queued-once-from-the-orders-events-until-the-worker-sends-it-and-whatsapps-webhook-follows-it-and-hears-customers-ask-to-stop)): the
  order placed, each parcel shipped once it has a tracking number and delivered, and the order
  cancelled, on WhatsApp from Hatti's shared number or by SMS. A new messaging module keeps each
  message in `messaging.messages` (migration 0092), queued by the worker from the order's events,
  once by a key however often the event comes. A part split from an order, an order merged into
  another and an erased customer's order get none.
* **The worker sends them** every five seconds, a shop at a time: WhatsApp's as Hatti's templates
  through the Cloud API, SMS as their words in English or Urdu through an aggregator's gateway,
  and in development to its log. What a channel cannot take yet is tried again a minute on,
  doubling to an hour, for a day. What WhatsApp refuses for good, or has not delivered within 15
  minutes, goes by SMS, once. Each message is recorded as soon as it is sent.
* **WhatsApp's webhook** (`/webhooks/whatsapp`) checks Meta's signature over the raw body, which
  the API now keeps for `/webhooks/`, and moves each message forward to delivered and read. Two
  `SECURITY DEFINER` functions find what it names across shops, and it changes them as their
  shop. A status come before its message was recorded is answered 503, so Meta sends it again.
  "STOP", "band karo" or "بند کرو" stops the shop the customer answered, or else the one that
  last wrote to them (MSG-09).
* **Shops choose** WhatsApp for everything or SMS for news, English or Urdu, and the
  notifications to turn off (`messagingSettingsUpdate`); `messages` lists what was sent and how
  it went. Erasure deletes a customer's messages and keeps their opt-outs, the worker's erasures
  that were asked for ahead of time among them.
* Found on the way: a second word on a message already settled still queued an SMS in its place;
  only a message settled now gets one. And the worker's own list of the modules that keep
  customers' data, for erasures asked for ahead of time, needed messaging too: the test that holds
  it to the API's caught it.

### 7b8f8d3 · The Meta event time's test on any second

* **The test of an order sent to Meta compares its event's time with the moment's own**, which
  the order's event gives: written a moment after the order, it fell in the next second once in
  CI, and the test failed with nothing wrong. It now checks the event against the time it was
  recorded, and that this is the order's second or the next.

### 2daf4d7 · Opening a shop

* **A signed-up user opens a shop of their own** (`POST /auth/shops`, [ADR-145](../architecture/13-decision-log.md#adr-145--a-signed-up-user-opens-a-shop-of-their-own-through-the-identity-login-its-name-a-handle-made-from-it-or-chosen-and-never-the-platforms-the-user-its-owner-and-shopopened-for-its-storefront-in-one-transaction)),
  and becomes its owner. They give its name, and a handle for its storefront's subdomain if they
  choose one. Otherwise the handle is made from the name, its words joined by hyphens and
  numbered while another shop has it, `shop-store` for a name written in Urdu. A handle asked
  for and taken is refused, and so are the platform's own subdomains, such as `admin`, `api`
  and `www`.
* **One transaction of the identity login** adds the shop to `control.shops`, with Pakistan's
  currency and time zone, makes the user its owner and records `shop.opened` in the outbox.
  Migration 0091 grants the login a shop's ID, name and handle and that one event, nothing more.
  The publisher builds the opened shop whole, so its storefront answers at its subdomain once the
  worker hears of it.
* An account owns five shops at most and opens ten a day at most. As always, the owner uses the
  shop's Admin API once their session has passed a second factor.

### 57b9d26 · The Meta pixel in the storefront

* **Shoppers' pages load the shop's Meta pixel while it has Meta connected**
  ([ADR-144](../architecture/13-decision-log.md#adr-144--a-shops-storefront-loads-its-meta-pixel-while-meta-is-connected-for-the-steps-shoppers-take-before-checkout-orders-go-from-the-server-alone-each-keeping-the-pixels-browser-and-click-ids-for-them)),
  in their head beside the visits' script: Meta's own base code, then `PageView`. A product's page
  sends `ViewContent` for its product by the catalog feed's IDs: a lone variant's, or the
  product's as the feed's group of its variants, valued at the variant the page shows first.
  Previews and the theme editor's frame load none.
* **The script reads what shoppers send**, listening before the theme's own scripts, so the cart
  drawer's Ajax adds count too: a form adding to the cart sends `AddToCart`, valued when the page
  knows the variant's price; the cart's checkout button, a form to checkout or a link to it send
  `InitiateCheckout`. Pages stay the same for every shopper and kept at the edge.
* **The shop's storefront document names its pixel** (`metaPixelId`). The publisher writes it
  again when the pixel's ID changes or Meta is disconnected, and the edge forgets the shop's
  pages; a shop without one keeps its document byte for byte, and its pages stay kept.
* **Orders go from the server alone**: checkout's page runs no scripts, so `Purchase` is the
  conversions API's, and nothing needs deduplicating.
* **An order keeps the pixel's browser and click IDs** (`orders.browser_ids`, migration 0090).
  The storefront reads `_fbp` and `_fbc` as the order is placed and passes them to the core with
  the address and browser, in `x-hatti-client-browser-ids`; the order keeps those in Meta's
  format. Its conversions send `fbp`, and as `fbc` whichever click was later, the cookie's or the
  visits'. Erasure clears them, and the customer's own file has them.
* Shops at the platform's subdomains share Meta's cookies until the storefronts' domain is on the
  Public Suffix List, as Shopify's `myshopify.com` is: a step for the infrastructure, before
  those shops use the pixel.

### 25fe3f4 · Meta's conversions API

* **Orders placed through checkout go to Meta's conversions API**
  ([ADR-143](../architecture/13-decision-log.md#adr-143--orders-placed-through-checkout-go-to-metas-conversions-api-from-the-worker-as-they-are-placed-confirmed-and-delivered-the-shop-choosing-which-is-purchase-each-moment-waits-in-postgres-until-meta-takes-it-or-its-seven-days-are-up)),
  from the worker, as they are placed, confirmed and delivered, once each. The shop chooses
  which moment is Meta's `Purchase`: delivered counts only the parcels customers took. The others
  go as `OrderPlaced`, `OrderConfirmed` and `OrderDelivered`, for custom conversions. Each carries
  the order's total and its items by variant, as the catalog feed names them, its customer's
  details hashed with SHA-256 as Meta normalises them, the address and browser they placed it
  from, and Meta's click ID from the visit that brought them.
* **Each moment waits in Postgres** (`marketing.conversions`) until a sender in the worker takes
  it, every fifteen seconds, a shop at a time and up to a hundred to a request.
  * Meta busy, or the token wrong: tried again a minute later, doubling to six hours.
  * Refused for good: failed, with what Meta said.
  * Older than Meta's seven days: expired, unsent.
  * An erased customer's, or a disconnected shop's: skipped.

  A sender takes a shop's moments through a materialized CTE: as a subquery in `UPDATE … FROM`,
  Postgres took more than were asked for.
* **The Admin API connects the shop's dataset** (`metaConversionsUpdate`): its pixel's ID, an
  access token sealed for the shop and never shown again, a code for Meta's test events, and the
  moment that is Purchase. Changing it needs `write_pixels`, which owners, managers and marketers
  have, and recent authentication. `conversionEvents` lists every moment with how sending went.
* A new marketing module keeps them, in migration 0089's tables. The worker reads
  `ENCRYPTION_KEYS`, `STOREFRONT_URL` and Meta's Graph API address and version (`v26.0`), and a
  split order's created event names the order it came from.

### 1a63f2e · The calling hours' test on any day

* **The Confirmation Desk's test of calling hours places its order now**, and looked at the queue
  at fixed times on 2 October 2026: from 08:00 that morning in Karachi, the order was placed
  after the first of them, and the test failed whatever changed. It now looks at the days after
  the one it runs on.

### 449f265 · Catalog feeds

* **Each shop's storefront gives its catalog feed at `/feeds/products.xml`**
  ([ADR-142](../architecture/13-decision-log.md#adr-142--a-shops-catalog-feed-is-its-storefronts-at-its-own-address-an-item-for-each-variant-of-its-products-with-an-image-in-googles-rss-which-metas-catalogs-read-too-made-from-its-documents-a-chunk-at-a-time)),
  the file Google Merchant Center and Meta's Commerce Manager fetch to make free listings,
  Shopping and catalog ads: an item for each variant of its products with an image, grouped by
  product, with its price and sale price, stock, images, brand, product type, size and colour,
  in Google's RSS, which Meta's catalogs read too. The Admin API gives its address,
  `Shop.productFeedUrl`, on the shop's own domain.
* **It is made from the storefront's documents** as pages are: every product's ID in one round
  trip, then a hundred products at a time, in the same order each time, each chunk sent as it is
  made. It is kept at the edge for an hour, as sitemaps are. The sample shop's whole feed, 2,860
  items, parses in Chromium's XML parser, with titles' markup, ampersands and Urdu as written.
* **Images by URL keep their own address** in link previews and structured data, which had put
  the shop's address before them, and a width goes after any query they have.

### ee6de02 · True profit

* **Each order line keeps what its variant cost when it was sold** ([ADR-141](../architecture/13-decision-log.md#adr-141--an-orders-lines-keep-what-their-variants-cost-when-sold-and-the-sales-report-works-out-the-cost-of-goods-gross-profit-and-what-orders-made-less-couriers-charges-and-write-offs-plus-claims)), `unit_cost`, as
  Shopify records costs: lines added in an edit take their variant's cost then, and lines kept,
  split or merged keep theirs. Lines sold before keep none.
* **The sales report works out what orders made**, for its totals, days and rows: the cost of
  the goods kept, couriers' charges for the orders' parcels, what was written off of parcels
  refused and not restocked, parcels lost and customers' returns, and what couriers paid of
  claims. The Admin API adds `grossProfit` and `grossMargin`, as Shopify gives them, and
  `profit`, with `unitsWithoutCost` saying what has no cost; the products that sold most give
  their cost of goods.
* Migration 0088 adds the lines' cost. The variants' snapshots that carts, checkout and orders
  read carry each variant's cost now, checked again by the benchmark: the same plan for every
  shop size.


### 5361ab5 · Sales by where orders came from

* **`salesReport(by:, first:)` breaks a period's sales down** ([ADR-140](../architecture/13-decision-log.md#adr-140--sales-and-cod-health-are-broken-down-by-where-orders-came-from-the-source-and-the-campaign-of-each-orders-last-visit-from-elsewhere-orders-without-one-together)): by channel
  (`SOURCE`), by where the orders' last visits from elsewhere came from (`VISIT_SOURCE`), or by
  campaign (`CAMPAIGN`), each row with its key, its title and its sales in Shopify's terms, items
  that came back taken off, most total sales first. The rows add up to the totals.
* **`codHealth(by: VISIT_SOURCE | CAMPAIGN)`** gives their confirmation and delivery rates the
  same way, so a shop sees which ads bring orders refused at the door.
* Orders without a visit, as staff's and apps' are, are one row, and visits without a campaign
  another; campaigns spelt in other letter cases are one, by the spelling most orders have;
  platforms go by their names, as "Instagram".
* The sales report's days and rows are one statement, grouped by an expression of the order.


### 5919fab · Order attribution

* **Orders placed through checkout keep the visits that brought their customers**
  ([ADR-139](../architecture/13-decision-log.md#adr-139--a-shoppers-browser-keeps-the-visits-that-brought-them-the-first-and-the-last-from-elsewhere-checkout-passes-them-on-and-the-order-keeps-them-as-shopifys-customer-journey)): the first, and the last from elsewhere in the 30 days before, each with when it
  began, the page it landed on, the site that linked to it, where it came from and its UTM
  parameters. The Admin API gives them as Shopify's `Order.customerJourneySummary`, with
  `daysToConversion`, read apart from the order so lists of orders do not carry them.
* **The shopper's browser keeps them**, in the `hatti_visits` cookie that a small script in each
  shopper's page head writes, so pages stay the same for everyone and kept at the edge. A visit
  from elsewhere has UTM tags or an ad's click ID in its address, or another site linked to it;
  moving between the shop's pages, or coming back to it straight, changes nothing. Staff
  previewing a theme keep none. Checked in Chromium as well as in the tests.
* **The storefront passes them when checkout starts**, counting a cart permalink's request by
  the same rules, and a discount link carries its campaign on to the page it leads to.
* **The core checks them** (`attributionOf`): visits older than 30 days, ahead of the clock or
  with no web address are dropped, pages and tags are cut to their limits, and each visit's source
  is worked out once: its `utm_source`, the platform of its ad or of the site linking to it, that
  site's domain, or `direct`.
* A part split from an order keeps its visits. An erasure clears their pages and keeps where they
  came from; a customer's own export gives them.
* Migration 0087 adds `attribution` to checkouts and orders.


### c45ac27 · Returns on their way

* **`openReturns(first, after)` lists customer returns still on their way**, the longest first
  ([ADR-138](../architecture/13-decision-log.md#adr-138--customer-returns-on-their-way-are-listed-the-longest-first-with-their-days-and-items-and-counted-on-the-home-as-parcels-coming-back-are)):
  each with its name, its order, how it comes back, the exchange sent for it, the days since it
  was recorded and the items coming back, on pages with exact cursors, as the parcels coming
  back are listed.
* **The home counts them**, `home.returnsToReceive`, with what their items sold for.
* Migration 0086 adds a partial index on the open returns, which both read.


### ad1093c · Exchanges

* **`returnCreate` sends another size at once, as an order of its own**, when given
  `exchangeLineItems`
  ([ADR-137](../architecture/13-decision-log.md#adr-137--a-return-may-send-another-size-at-once-as-an-order-of-its-own-paid-by-what-was-paid-for-what-comes-back-credited-from-its-order-as-a-refund-by-exchange-in-which-no-money-moves-the-door-collecting-the-rest)):
  placed as any order is, at the variants' prices now or a price given, its stock committed at
  the order's location, confirmed, at the order's address, paid on delivery; the return names it.
* **What was paid for what comes back pays for it, as far as it goes**: the items' prices less
  their share of the discount. It leaves the order as a refund by exchange, in which no money
  moves, and the exchange takes it as paid in advance; the courier collects the rest. What was
  paid beyond a cheaper exchange is said, for the shop to refund.
* So the sales report counts the old item as returned and the new one as sold, each with its
  tax, and what the customer spent counts their money once.
* An order whose payment is not recorded pays for no exchange; a return whose exchange was sent
  is not cancelled; `orderRefund` never refunds by exchange.
* Migration 0085 adds `returns.exchange_order_id` and the `exchange` refund method. Refunds are
  written by one function, `writeRefund`, which `orderRefund` and exchanges share. The order
  statement's plans stay the same for every size of shop.


### 06c7ac1 · Customer returns

* **`returnCreate(input)` records what a customer sends back of a delivered parcel**
  ([ADR-136](../architecture/13-decision-log.md#adr-136--a-customers-return-of-delivered-items-is-recorded-by-staff-each-item-with-its-reason-and-checked-in-when-it-arrives-each-unit-back-in-stock-where-it-came-back-to-or-written-off-money-given-back-stays-a-refund-and-the-sales-report-counts-what-came-back)):
  units of the order's lines, each no more than were delivered and are not coming back already,
  each with Shopify's reason; where it comes back to, the order's location unless another is
  given; the courier and tracking number it comes by; a note. It is named as Shopify names
  returns, #1001-R1.
* **`returnReceive(id, restock)` checks it in** as a refused parcel is checked in: each unit back
  in stock where it came back to or written off, all of it restocked if nothing is said.
  `returnCancel(id)` cancels one still on its way, as when the customer keeps the items.
* **Money given back stays a refund**, recorded apart; and a return is no refusal: the customer's
  risk and COD health count refused parcels alone. The sales report counts what came back among
  returns, on the order's day.
* `Order.returns` and `Order.returnStatus` show them; `return.created`, `return.closed` and
  `return.cancelled` tell apps; a return's note is erased with its customer's details.
* Migration 0084 adds `orders.returns` and `orders.return_lines`. The order statement reads each
  order's returns through their unique index: its plans stay the same for every size of shop, 50
  orders about 0.07 ms slower
  ([output](./spikes/05-prepared-output.md#an-order-and-its-returns-adr-136)).
* Tried on the demo shop: one of #1005's two shalwar qameez recorded coming back by Leopards to
  the Lahore warehouse in 62 ms, as #1005-R1, then cancelled in 35 ms.

## 2026-10-01

### d9ca8c6 · Splitting an order

* **`orderSplit(id, input)` sends units of an order's lines apart as an order of their own**
  ([ADR-135](../architecture/13-decision-log.md#adr-135--items-sent-apart-from-an-order-paid-on-delivery-become-an-order-of-their-own-as-its-cash-is-collected-by-order-at-their-prices-with-their-share-of-the-discount-the-rest-of-the-order-as-it-is-and-its-stock-where-it-was-both-orders-scored-as-the-one-their-customer-placed)),
  while it waits to be packed, as when part of it waits for stock or its customer wants part
  sooner: a courier collects cash on delivery by parcel, so a part sent apart is an order, with
  the shop's next number.
* **The part takes the units at the prices they were sold at, and its share of the discount** by
  what they cost, to the rupee when the discount is whole; a delivery charge only if staff give
  one; and the rest of the order as it is: customer, address, note, tags, confirmation, calls,
  assignee, agreement, and when it was placed. Both orders' totals, tax and cash to collect are
  worked out again, and the stock stays committed where it was.
* **An order and its parts are scored as the one order their customer placed**:
  `assessOrderRisk` takes the order a part was split from, and leaves that order and its parts
  out of the customer's history and of recent orders whenever any of them is scored again.
  Elsewhere each part is an order of its own.
* Only an order paid on delivery, with nothing paid or asked for in advance, is split: a prepaid
  or transfer order ships in parts instead. A part split again names the first order, and one
  merged back returns its items.
* A part's link says which order it is part of, in English and Urdu.
* Migration 0083 adds `split_from_id`. The order statement looks up the number of the order
  split from by its primary key: its plans stay the same for every size of shop, 50 orders about
  0.06 ms slower.
* Tried on the demo shop: one of #1010's three lawn suits split off as #1060 in 62 ms, Rs 4,990
  sent at the shop's cost and Rs 10,230 left, waiting for review as #1010 was; then merged back
  in 43 ms.

### 8a2cb27 · An order's delivery charge and discount changed

* **`orderEditCharges(id, input)` sets an order's delivery charge, its discount, or both**
  ([ADR-134](../architecture/13-decision-log.md#adr-134--an-orders-delivery-charge-and-discount-change-while-it-waits-to-be-packed-as-its-items-do-its-totals-tax-and-cash-at-the-door-following-what-was-taken-off-for-paying-by-transfer-stays-part-of-the-discount-and-the-fee-stays)),
  while it waits to be packed, as an agent waives the one or gives the other on the call to keep
  the sale: `shippingPrice` "0" waives delivery, and `discount` is what is taken off its items in
  all.
* **Its amounts follow as an item edit's do**, through the same checks and writing: its total;
  the sales tax, each line after its share of the new discount, and the delivery charge's; and
  the cash collected at the door, what was paid or asked for in advance staying. A
  cash-on-delivery order is scored again. A discount more than its items cost, or a total below
  what was paid or below its advance, is refused.
* **What was taken off for paying by transfer stays part of the discount**, which can't go below
  it; the fee stays, and so do the codes the order was placed with.
* Its timeline says "Changed the delivery charge to Rs 0 from Rs 250, and the discount to Rs 360
  from Rs 0; Rs 3,000 instead of Rs 3,610", and `order.updated` names what changed.
* Tried on the demo shop: #1032's delivery waived and Rs 250 taken off in 53 ms, Rs 2,000 instead
  of Rs 2,400, Rs 1,500 to collect after its Rs 500 advance; Rs 2,000 off refused, as its total
  would fall below its advance; then changed back.

### 72bcdc4 · Stock from a file

* **`inventoryExport(query, locationId)` gives the shop's stock as Shopify's inventory CSV**
  ([ADR-133](../architecture/13-decision-log.md#adr-133--stock-leaves-and-comes-back-as-shopifys-inventory-csv-a-row-for-each-tracked-variant-at-each-active-location-named-by-handle-options-and-location-a-count-sets-on-hand-where-on-hand-new-says-and-refuses-a-row-whose-on-hand-changed-since-the-file-was-exported)),
  all its states: a row for each tracked variant at each active location, or one, named by
  handle, title, options and SKU, with what is on hand, committed, available and not, and On
  hand (new) blank for a count. Filtered as the products list is, as much as one import takes.
* **`inventoryImport(csv, dryRun)` counts stock from such a file**, Shopify's or Hatti's: each
  row whose On hand (new) is filled in sets what is on hand, a stock count in the ledger with
  the file as its reference, 250 levels a change; a dry run counts first.
* **A row whose stock sold since the file was exported is refused**: its On hand (current) is
  not what is on hand now, and counting it would undo the sale. A location the shop does not
  have, a variant named twice, and a product or variant it cannot find are said by row.
* Rows name what a spreadsheet keeps, the product's handle, its option values in any case and
  the location's name, never IDs; the catalog writes and reads the file, the core gives and sets
  the stock, as for products.
* **Fixed: a product export of stock sold past zero** wrote it as text, "'-2", which its own
  import refused; quantities now go in as numbers, and a reader of numbers strips a
  spreadsheet's apostrophe.
* Tried on the demo shop: its 13 rows in 36 ms; Peshawari Chappal size 9 counted at three at
  the Lahore warehouse, dry run and import 33 ms each, then counted back to none.

### 586f64b · Merging orders

* **`orderMerge(id, intoId)` merges an order its customer placed twice into the other**
  ([ADR-132](../architecture/13-decision-log.md#adr-132--an-order-its-customer-placed-twice-is-merged-into-the-other-while-both-wait-to-be-packed-the-other-takes-its-items-and-discount-and-keeps-its-own-delivery-charge-as-one-parcel-the-order-merged-is-cancelled-as-merged-naming-it-and-counts-for-nothing-in-its-customers-history)),
  while both wait to be packed and are paid the same way: the other takes its items at the prices
  they were sold at, a line of the same variant and price taking the units, its discount and
  discount codes, and its note and tags where they fit, and keeps its own address, delivery
  charge and fee, as one parcel.
* **The order merged is cancelled as `merged`** and names the one it joined
  (`Order.mergedInto`); its customer's link says so in English and Urdu, and both timelines say
  what happened. Only merging gives that reason: `orderCancel` and bulk cancel refuse it.
* **Its stock stays committed where it was**, or moves in one call from another location; the
  order merged into is worked out and scored again as an edit is, after the other is cancelled.
* **A merged order counts for nothing in its customer's history**, which risk, segments and stats
  read, nor in COD health or agents' cancellations: the customer placed one order, not two. A
  test shows a second order scored 0.25 for the first, then 0.10 once the first joins it.
* An order with money paid or asked for in advance is not merged into another: what was paid
  stays with its order, which takes the other instead.
* Migration 0082 adds the reason and `merged_into_id`, with a check keeping them together. The
  order page's prepared statement looks up the number of the order merged into: its plans stay
  the same for every size of shop, and as quick.
* The edit's work is shared: both check and move stock first (`#prepare`), then write
  (`#write`), so that nothing is written when either is refused.
* Tried on the demo shop: #1011, a Sindhi Ajrak, merged into #1008, the same customer's lawn suit,
  in 84 ms: one parcel of Rs 7,090 instead of Rs 5,240 and Rs 2,100, #1011 cancelled as merged.

### a8d0136 · Editing an order's items

* **`orderEditLineItems(id, input)` changes an order's items while it waits to be packed**
  ([ADR-131](../architecture/13-decision-log.md#adr-131--an-orders-items-change-while-it-waits-to-be-packed-quantities-set-and-variants-added-in-one-edit-the-lines-kept-keeping-their-prices-its-amounts-and-tax-worked-out-again-and-the-difference-collected-at-the-door-its-stock-committed-and-let-go-at-once)):
  `setQuantities` gives its lines new quantities, 0 taking one off, and `addVariants` adds
  variants at their prices now, or a price given. The lines kept keep their IDs and the prices
  they were sold at.
* **Its amounts are worked out again**: subtotal, total, and sales tax at the shop's rates now;
  its discount, delivery charge, fee and advance stay, and cash on delivery collects the
  difference, within the law's cap. A paid bank-transfer order that now costs more waits for the
  rest.
* **Its stock follows in one call**: the inventory module's new `StockService.recommit` commits
  the units added and lets go of those taken off, locking every level at once, in the order
  every writer locks them, so an edit never deadlocks with an order taking the same stock the
  other way round; a test runs thirty of both at once.
* **An order scored when it was placed is scored again**, and held for review if the edit makes
  it risky. The timeline says what changed: "Changed the items: 2 × Kurta instead of 1, removed
  Dupatta, added 1 × Chappal (8); Rs 7,970 instead of Rs 3,610".
* Refused for an order packed (unpack it first), shipped, cancelled or refunded, a total below
  what was paid, a discount above what the items cost, a variant gone or archived, or too few in
  stock, said at the line short.
* `orderReference`, `riskColumns` and `itemName` moved to where the new service shares them.
* Tried on the demo shop: #1011's Sindhi Ajrak went to two, with a lawn suit added, Rs 8,940
  instead of Rs 2,100 and the suit's stock committed; then back as it was, its stock let go.

### 639cd9a · Products updated from a file

* **`productsImport(csv, overwrite: true)` updates the products a shop has from the file**
  ([ADR-130](../architecture/13-decision-log.md#adr-130--told-to-overwrite-an-import-updates-the-shops-products-from-the-file-fields-from-the-columns-it-has-a-blank-cell-clearing-an-optional-one-variants-matched-by-their-option-values-and-new-ones-added-options-and-stock-stay-the-admins-and-inventorys)); without `overwrite` they stay as they are, as before. A dry run counts them.
* **Fields come from the columns the file has**: a missing column leaves a field alone, a blank
  cell clears an optional one, as Shopify's import does, so a sale ends by emptying its
  compare-at prices; a blank price or weight leaves the variant's.
* **Variants are matched by their option values** and keep their IDs and images; the file's other
  combinations become new variants, with their images and the stock the file tracks. Images the
  product lacks are added; nothing the file leaves out is deleted.
* **Options and stock are not the file's**: a product whose options differ from the file's is left
  and said, and the shop's variants keep their stock, which a file exported earlier would undo.
* Every change to a product is checked before the first is made: an edited price the catalog
  won't take leaves the whole product as it was, said at its row.
* Tried on the demo shop: the Peshawari Chappal's export, its size 8 at Rs 3,599 instead of
  3,499, was skipped without `overwrite`, counted by a dry run, then updated, its stock of four
  untouched.

### 5203069 · Products to a Shopify CSV

* **`productsExport(query)` gives the shop's products as Shopify's product CSV** ([ADR-129](../architecture/13-decision-log.md#adr-129--products-leave-as-shopifys-product-csv-a-file-the-import-takes-back-whole-filtered-as-the-products-list-is-each-tracked-variants-stock-for-callers-who-may-read-it-a-larger-catalog-in-parts-the-import-links-variants-to-their-images)),
  filtered as `products(query:)` is, oldest first, with `read_products`: Shopify's headings in
  its order, a row for each variant and image, the product's fields on its first row, Title /
  Default Title without options, prices as `4500.00`, descriptions as HTML that reads back the
  same.
* **Each tracked variant's stock comes with `read_inventory`**: what is for sale online, and
  whether it sells on at zero. Without it, no stock is in the file, and an import leaves stock
  alone.
* **A file is one the import takes back whole**: at most 5,000 rows and 1,500,000 characters,
  the rows counted before any product is read; a larger catalog goes in parts, by status,
  vendor, type or tag.
* **The import links each variant to its image** (Variant Image), as Shopify's does, so a file
  moves a catalog to another shop whole: tested product by product, IDs aside.
* On the benchmark's shops, 127 products exported in 9 ms and 1,307 products (2,444 rows, 1.4
  million characters) in 80 ms; a shop of 2,498 products with long descriptions is past the
  characters and goes in parts.
* Tried on the demo shop: its six products came out as twelve rows in 7 ms (median), and
  `status:active` gave the five on sale.

### 45749c9 · Comments on an order's timeline

* **Staff and apps comment on an order's timeline** ([ADR-128](../architecture/13-decision-log.md#adr-128--staff-and-apps-comment-on-an-orders-timeline-each-comment-its-authors-to-change-kept-apart-from-the-events-and-read-among-them-every-entry-saying-who-made-it-and-comments-going-with-the-customers-details-in-an-erasure)):
  `orderCommentCreate(orderId, message)`, up to 2,000 characters, signed by whoever wrote it.
  Its author changes it (`orderCommentUpdate`, `editedAt`) or deletes it
  (`orderCommentDelete`); owners and managers delete anyone's, but change no one's words.
* **`Order.events` reads comments among what happened**, newest first and a page at a time
  across both, with one prepared statement that merges the two tables by ID; a comment is an
  entry of kind `comment`, `ocm_…`.
* **Every entry says who made it** (`author`): a member of staff by account and name, an app by
  its token, nobody for what customers did through their links and what the platform did by
  itself.
* **Comments are kept apart from the events** (migration 0081), which stay append-only and free of
  contact details: an erasure deletes the comments on the customer's orders, and their own file
  leaves them out with the rest of the timeline.
* A comment changes nothing of the order: no version, no event.
* Tried on the demo shop: a comment on #1058 came back first in its timeline, signed by the
  demo's app, its edit stamped, and a blank one was refused.
* **The benchmark's orders carry comments**, one on every fourth and a second on every twelfth,
  240,560 in all: `pnpm bench:db prepared` showed the timeline's one plan for small, medium and
  large shops, each table read along its index, and an order's newest 50 entries took 0.28 ms
  (median) directly and 0.40 ms through PgBouncer, against 0.27 and 0.39 for its events alone
  ([output](./spikes/05-prepared-output.md#an-orders-timeline-with-its-comments-adr-128)).

### 843b9e8 · Order assignment

* **An order is given to one member of staff at a time, to see it through** ([ADR-127](../architecture/13-decision-log.md#adr-127--an-order-is-given-to-one-member-of-staff-at-a-time-to-see-it-through-owners-managers-and-apps-give-it-to-anyone-other-staff-take-one-no-one-has-staff-find-theirs-with-assigneeme-and-those-who-leave-give-their-open-orders-back)):
  `orderAssign(id, staffMemberId)`, or without `staffMemberId` to no one. The order keeps whom
  and since when (`assignee`, `assignedAt`, migration 0080), on its timeline ("Assigned to Ayesha
  Khan") and as `order.updated` with `assignee` changed.
* **Owners, managers and apps give orders to anyone, and take them from whoever has them; other
  staff take an order no one has for themselves, and give back their own.** Giving one to
  someone else is refused as their role's, and taking someone else's is a user error.
* **Staff find theirs with `assignee:me`**, anyone's with `assignee:usr_…`, and those no one has
  with `assignee:none`, in the list, its saved searches and its exports; an app is no one, so
  `assignee:me` finds it nothing.
* **`Order.assignee` says who by account and name, not how they sign in**, read once for a page
  of orders from the identity module, which the core asks whether the member works in the shop.
* **Removing a member gives their open orders back**, each with a timeline entry and an event;
  closed and cancelled orders keep whom they were given to.
* ORD-10 is whole: tags, notes and assignment. The Confirmation Desk deals out orders as before,
  whoever has them.
* The orders' prepared statements read the two new columns, and `pnpm bench:db prepared` showed
  the plans they had, on the same indexes, for small, medium and large shops.
* Tried on the demo shop: #1059 given to Demo Owner showed them on the order and under
  `assignee:usr_…`, its timeline said "Assigned to Demo Owner", an app's `assignee:me` found
  none, and `assignee:Ayesha` was refused, naming what the filter takes.

### 74c2ee8 · Filters in the customers search

* **`customers(query:)` takes filters among its number or words** ([ADR-126](../architecture/13-decision-log.md#adr-126--a-customers-search-takes-a-tag-and-each-channels-marketing-consent-among-its-number-or-words-in-the-syntax-the-lists-share-segments-stay-the-shops-saved-views-of-customers)): `tag:vip`,
  and `whatsapp_marketing_state`, `sms_marketing_state` and `email_marketing_state`, each
  `subscribed`, `not_subscribed` or `unsubscribed`, a minus to leave matches out; one the search
  doesn't know is refused with `BAD_USER_INPUT`. A number, its last digits or words match as
  before.
* **Segments stay the shop's saved views of customers**, as Shopify's are, so there are no saved
  searches of customers; orders counted and money spent stay the segments' to ask.
* Every list of the admin now reads one search syntax: orders, drafts, products and customers.
* Tried on the demo shop: `whatsapp_marketing_state:subscribed` found its two customers who take
  offers on WhatsApp, Usman Ali and Ayesha Khan, a minus the other thirty, and `city:lahore` was
  refused with the filters customers take.

### ffcd579 · Low stock on the home

* **The shop sets what it calls low stock** ([ADR-125](../architecture/13-decision-log.md#adr-125--low-stock-is-a-variant-of-an-active-product-with-the-shops-threshold-or-fewer-units-for-sale-online-five-until-it-says-otherwise-worked-out-from-the-levels-when-asked-counted-on-the-home-and-listed-the-fewest-first)): one threshold for all its
  variants, five units until it says otherwise (`inventorySettings`, `inventorySettingsUpdate`,
  migration 0079), each change an `inventory_settings.updated` event.
* **A variant is low with the threshold or fewer units for sale online, and out with none**, as
  its `inventoryQuantity` counts them: tracked variants of active products alone, stock at a store
  that sells in person and drafts' stock left aside.
* **The home counts them** (`home.lowStock`: the threshold, how many are low, how many are out),
  and **`inventoryLowStock` lists them**, the fewest for sale first, with the product's and
  variant's titles and SKU, for staff to reorder. Both are worked out from the levels when asked.
* The in-app half of INV-01: alerts on WhatsApp and push follow with messaging, from the same
  definition.
* Tried on the demo shop: at five, five variants low and two out, the Peshawari Chappal's size 9
  and a Multani Khussa first at none; at ten, seven low; set back to five.

### ae10605 · Saved searches of products and drafts

* **Saved searches take the shop's drafts and products as well as its orders** ([ADR-124](../architecture/13-decision-log.md#adr-124--saved-searches-take-the-shops-drafts-and-products-as-well-as-its-orders-each-query-checked-by-its-own-lists-search-names-unique-within-a-list-and-keeping-one-needs-the-scope-that-changes-its-list)),
  as Shopify's `resourceType` names them: `savedSearchCreate` with `ORDER`, `DRAFT_ORDER` or
  `PRODUCT`, and `orderSavedSearches`, `draftOrderSavedSearches` and `productSavedSearches` to list
  each list's, oldest first.
* **Each query is checked by its own list's search**, when saved and when changed: a products
  tab can't name an order's stage, and a drafts tab takes `status:open` but not `status:active`.
* **Names are unique within a list** (migration 0078), so the orders and the products may both
  have a "Drafts" tab, with room for 100 of each list's.
* **Keeping one needs the scope that changes its list**: `write_orders` for orders and drafts,
  `write_products` for products; an orders token is refused a products tab, and the other way.
* Tried on the demo shop: a products tab "Drafts" (`status:draft`) opened the Kashmiri Pashmina
  Shawl, "Bazaar Textiles" that vendor's two active products, and a drafts tab also called
  "Drafts" (`status:open`) #D1; `stage:to_pack` was refused for products, naming their filters.

### 01d953f · Searching drafts

* **`draftOrders(query:)` finds a draft** ([ADR-123](../architecture/13-decision-log.md#adr-123--a-drafts-search-finds-a-draft-by-its-number-its-customers-mobile-or-words-of-their-name-city-or-email-with-filters-among-them-as-the-orders-search-does-each-draft-keeps-its-words-folded)) by its number ("#D12", "D12" or
  "12"), its customer's mobile in any format, or words of their name, city or email, folded as the
  orders' are: "Bilaal" finds Bilal. Staff coming back to a chat's draft find it as they find an
  order.
* **Filters among the words, in the syntax the lists share**: `status`, `source`,
  `payment_method` and `tag`, a minus to leave matches out; one the search doesn't know is
  refused with `BAD_USER_INPUT`, naming those it takes. The `status` argument still holds.
* **Each draft keeps its words** (`search_text`, migration 0077), written whenever its address or
  email changes, by staff or by its customer through the link; drafts from before have theirs in
  lowercase until they next change.
* Tried on the demo shop after the migration: `#D3` found Adeel Qureshi's draft, `anwar` the two
  Anwars' and `anwar lahore` Rabia's alone; `-source:whatsapp status:completed` found Nadia
  Iqbal's from Facebook, and `stage:open` was refused with the filters drafts take.

### f765f69 · The order page's timeline prepared

* **An order's timeline is read through a prepared statement** ([ADR-122](../architecture/13-decision-log.md#adr-122--an-orders-timeline-is-read-through-a-prepared-statement-too-checked-by-the-benchmark-on-orders-with-their-timelines-its-locations-loader-stays-planned-as-customers-statements-do)), its page
  size written into its text as orders' pages are: its newest 50 events went from 0.37 to
  0.27 ms (median) directly, and from 0.48 to 0.39 ms through PgBouncer. `pnpm bench:db prepared`
  showed one plan for small, medium and large shops, which Postgres kept after five calls.
* **The location's loader stays planned**: prepared, its plan passed the check but its median
  did not move (0.51 to 0.50 ms directly, 0.64 to 0.68 ms through PgBouncer), as customers'
  statements did not. The transfer receipts' loader waits for receipts in the benchmark to be
  checked at all.
* **The benchmark's orders keep timelines**, each the events its stage implies from placed to
  paid, drawn from what the order is so the rest of the dataset stays as it was: 3,390,948
  events, 4.68 an order, loaded in 151 s. The benchmark times an order's timeline and its
  location's loader beside the order ([output](./spikes/05-prepared-output.md#the-order-pages-loaders-adr-122)).

### bad05aa · Today on the home

* **The home says how the shop's day has gone** ([ADR-121](../architecture/13-decision-log.md#adr-121--the-home-says-how-the-shops-day-has-gone-from-midnight-in-its-time-zone-todays-sales-as-the-sales-report-works-them-out-and-the-parcels-delivered-and-turned-back-today-at-their-worth)): `home.today` gives
  when today began, midnight in the shop's time zone, the orders placed since with their total
  sales, the parcels delivered today and those their couriers turned back today, refused or
  undeliverable, each with what it comes to. It is worked out only when asked for, so the
  home's other tallies never wait on it.
* **Today's sales are the sales report's for today**, read through the report's own statement
  (`salesPeriodsIn`): cancelled orders aside, without the tax but in total sales, and less what
  came back, so the home and the report never disagree.
* **Parcels count on the day they were delivered or turned back**, whenever their orders were
  placed, at their worth, their items at the prices sold, as lost parcels are.
* Migration 0076 indexes orders by when they were placed, and parcels by when they were
  delivered and turned back, as the home is read often; the orders' index serves short sales
  reports and COD health too.
* Tried on the demo shop just after midnight in Karachi (19:00 UTC): today began empty; two
  Peshawari Chappals placed made two orders and Rs 6,998; one delivered and the other refused
  made one delivered and one RTO at Rs 3,499 each, and today's sales Rs 3,499, as the sales
  report counts what came back. The orders, #1058 and #1059, were then paid and checked back in,
  and their test customer erased.

### cb8e717 · Filters in the products search

* **`products(query:)` takes Shopify's filters among its words** ([ADR-120](../architecture/13-decision-log.md#adr-120--a-products-search-takes-shopifys-filters-among-its-words-in-the-syntax-the-orders-search-reads-which-the-admins-lists-share)):
  `status:draft`, `vendor:"Gul Ahmed"`, `product_type:Kurta`, `tag:eid`, `sku:KRT-001`,
  `barcode:`, `handle:`, and `-tag:sale` to leave matches out. A vendor, type or tag matches whole
  in any letter case, a SKU or barcode any of the product's variants', and the words left search
  as before, Roman Urdu spellings folded. The admin's All, Active, Draft and Archived tabs are
  searches, and its filters pass the values `productVendors`, `productTypes` and `productTags`
  give.
* **A filter the search doesn't know, or a status there isn't, is refused** with
  `BAD_USER_INPUT`, naming those it takes, as the orders search refuses one.
* **One search syntax for the admin's lists**: `parseSearch` in `@hatti/api` reads what each list
  says it takes (its `SearchSyntax`), and the orders search now reads through it, unchanged.
* Tried on the demo shop: `status:active` found its five active products and `status:draft` the
  shawl; `sku:pc-08` the Peshawari Chappal; `vendor:"multan craft house"` the Multani Khussa, and
  with a minus and `status:active` the other four; `status:live` and `colour:red` were refused,
  naming what the search takes.

### 5c53361 · Saved order searches

* **The shop keeps searches of its orders by name**, as Shopify's saved searches
  ([ADR-119](../architecture/13-decision-log.md#adr-119--the-shop-keeps-searches-of-its-orders-by-name-for-all-its-staff-as-shopifys-saved-searches-each-a-query-the-orders-search-takes-checked-when-saved)): the admin's tabs over the orders list, each opened by passing its query to
  `orders(query:)`. `orderSavedSearches` lists them with `read_orders`, and `savedSearchCreate`,
  `savedSearchUpdate` and `savedSearchDelete` keep them with `write_orders`, for orders alone
  (`resourceType: ORDER`). Each gives its query, its words (`searchTerms`) and its filters, a
  left-out filter's key with its minus.
* **Shop-wide, for every member of staff**, oldest first as tabs are added
  (`orders.saved_searches`, migration 0075). Names are up to 40 characters and unique in the
  shop in any letter case; queries up to 1,000 characters; a shop keeps up to 100, counted under
  a lock so that two saved at once can't both pass the limit.
* **A query is checked when saved as the orders search checks it**, so a saved search never
  names a filter or value the list doesn't take: `INVALID` on `query`, with the search's own
  words. A name already kept is `TAKEN`, and another shop's saved search `NOT_FOUND`.
* Each change is an event: `saved_search.created`, `saved_search.updated` with the fields that
  changed, and `saved_search.deleted`.
* Tried on the demo shop: "To pack" (`stage:to_pack`) opened its four orders and "Staff and apps
  cancelled" (`status:cancelled -source:online_store`) its sixteen, the latter's filters given back
  with `-source`; "to PACK" was refused as taken, and `stage:packed` with the stages there are.

### 213b2f5 · Filters in the orders search

* **`orders(query:)` takes filters among its words**, as Shopify's search syntax writes them
  ([ADR-118](../architecture/13-decision-log.md#adr-118--an-orders-search-takes-filters-among-its-words-as-shopifys-search-syntax-writes-them-a-filter-or-value-it-doesnt-know-is-refused-naming-those-it-takes)): `stage:to_pack`, `risk_level:high`,
  `tag:"gift wrap"`, `-source:online_store` to leave matches out. The filters are an order's
  stage, status, confirmation, financial and fulfillment statuses, payment method, source, risk
  level, a tag in any letter case, and whether its customer sent a receipt; all hold together,
  with the arguments, and the words left search as before. Exports take the same.
* **A filter or value the search doesn't know is refused**, naming those it takes, so a
  mistyped filter never quietly finds nothing: `BAD_USER_INPUT` from the list, an error on
  `query` from the export. A word with a colon that isn't a filter's name, such as `10:30`, stays
  a word.
* `parseOrderSearch` splits a search into filters and words, from the schema's value sets, and
  `orderConditions` turns each filter into a condition on its own column.
* The groundwork for saved order views, which keep such a string as Shopify's saved searches do.
* Tried on the demo shop: `stage:to_pack` found its four orders to pack, `status:cancelled
  -source:online_store` the sixteen cancelled ones staff and apps placed, and `stage:packed` was
  refused with the stages there are.

### d806a9b · Sales without their tax

* **The sales report leaves out the sales tax its amounts include**, as Shopify's reports do
  ([ADR-117](../architecture/13-decision-log.md#adr-117--the-sales-report-leaves-out-the-sales-tax-its-amounts-include-as-shopifys-does-worked-out-from-the-tax-each-order-keeps-the-tax-said-apart-and-added-back-in-total-sales)): gross sales are prices before the tax,
  and so are discounts, returns, net sales, shipping and fees. `taxes` says it apart, and total
  sales add it back, so they are still what the orders were paid less what came back.
* **Worked out from what each order keeps of its tax**, never from the shop's rate now: gross
  sales line by line at each line's rate, rounded as the tax module rounds; discounts as gross
  sales less what was paid for the items without their kept tax, so net sales are exactly that;
  returns less the tax that went back with them; and shipping and the fee less the charges' tax,
  shared between them in proportion. The products that sold most are ranked without it, and the
  average order value is without it, as Shopify's is.
* This reverses the choice ADR-105 made, to keep the tax in for every amount to agree with the
  orders, and lifts the tax from simplification 50.
* The orders module's test works three orders out by hand at 18%: two kurtas with Rs 500 off,
  one refused, and a shawl through checkout with its delivery charge and fee taxed. Each amount
  comes out to the paisa, and total sales to the Rs 9,100 paid less what came back.
* Tried on the demo shop at 18% with delivery taxed: an order of Rs 4,990 with Rs 200 off and Rs
  250 for delivery came to gross sales of Rs 4,228.81, discounts of Rs 169.49, net sales of Rs
  4,059.32, shipping of Rs 211.86 and taxes of Rs 768.82, total sales Rs 5,040, what it was paid.
  The order was then cancelled, its customer erased and the shop's tax set back to none.

### 706839a · The erasures waiting

* **`customerErasureRequests` lists the erasures waiting**
  ([ADR-116](../architecture/13-decision-log.md#adr-116--the-admin-api-lists-the-erasures-waiting-the-soonest-due-first-with-their-customers-who-asked-stays-in-the-audit-log)), the soonest due first and then by
  customer: each with its customer, numbers masked by role as everywhere, when it was asked for
  and when it is due, with `read_customers`, as each customer's `erasureScheduledAt` is. Who asked
  stays in the audit log. Cancelled or carried out, an erasure leaves the list.
* **Its pages carry the due time to the microsecond**, as the parcels' lists do. The two helpers
  those lists had are now the platform's, for both: `exactTime` (`@hatti/db`) writes a time in
  SQL to the microsecond, and `decodeTimeCursor` (`@hatti/api`) refuses a cursor whose time is
  not exact or on no real day.
* The customers module's test pages one at a time through erasures due a microsecond apart and
  sees each once; the API's pages through two and refuses a cursor of the 31st of February.
* Lifts the list from simplification 20; a message to the customer when theirs is done waits for
  messaging.
* Tried on the demo shop: two customers made for it, whose erasures were asked for 65 ms apart,
  came a page at a time in that order, each once; cancelled, they left the list, and they were
  then erased.

### c142352 · Orders' links saying what confirming agrees to

* **An order staff or an app placed keeps what its customer agreed to in confirming it through
  its link** ([ADR-115](../architecture/13-decision-log.md#adr-115--an-order-staff-or-an-app-placed-keeps-what-its-customer-agreed-to-in-confirming-it-through-its-link-the-page-names-the-shops-policies-and-the-order-keeps-their-versions-where-it-was-confirmed-from-and-when)): while it waits for a customer
  who has agreed to nothing, its page names the shop's policies above the button, as a draft's
  does, and confirming keeps their versions, the address and browser it came from, and when.
* **When is kept with what** (`orders.agreed_at`, migration 0074): orders placed through checkout
  or a draft's link agree as they are placed, these as their customers confirm them.
  `OrderAgreement.agreedAt` reads it, and so does the customer's file of their own data. The
  migration dates the agreements kept before by their orders' placing, and a check keeps the
  versions and the time together.
* **An order that agreed as it was placed keeps that**: one from checkout waiting to be confirmed
  names nothing on its page, and confirming changes nothing of what it kept. Cancelling through
  the link agrees to nothing, and nor does staff's confirming after a call.
* `linkTermsIn` names the policies for both links' pages, and `confirmLocked` takes the
  agreement, keeping it only for an order that has none.
* Lifts the rest of simplification 45 but the edge's forwarded address.
* Tried on the demo shop: order #1056, placed by the app as from a phone call, showed the four
  policies on its page; confirmed two seconds later from a phone's browser, it kept them, the
  address and the browser, agreed at its confirmation rather than its placing. Order #1055,
  confirmed through its draft's link before the migration, was dated by its placing. The order
  was then cancelled and its customer erased.

### 552293a · Drafts' links saying what confirming agrees to

* **A draft's page says what confirming agrees to**
  ([ADR-114](../architecture/13-decision-log.md#adr-114--a-draft-its-customer-confirms-through-its-link-keeps-what-they-agreed-to-as-checkouts-orders-do-the-page-names-the-shops-policies-above-its-button-and-the-order-keeps-their-versions-and-where-it-was-confirmed-from)), above its button, in English and Urdu,
  as checkout says it: the shop's policies, each linked where its storefront shows it and
  opening beside the page, but for its contact information, which promises nothing. Nothing
  when the shop has none.
* **The order its customer confirms there keeps it**, as checkout's orders do: the versions of
  the policies the page named, and the address and browser the confirmation came from, as the
  core sees them. `Order.agreement` shows it, the policies as they were; erasure clears the
  address and browser, and the versions stay. A draft staff complete keeps none: its customer
  agreed in the chat.
* **A policy changed while the page was open shows it again**: the page's digest covers the
  versions it named, and the page says that the order or the shop's policies changed.
* `DraftOrderService` takes the `StorefrontSite`, for the policies' addresses, and
  `ShownOrder.terms` carries them to the page and its digest.
* **Checkout's limit on orders from one internet address counts its own alone**, as its limit by
  number did: it counted every order with an address, and drafts' orders now keep one.
* Lifts the first part of simplification 45. Orders staff and apps place, whose customers
  confirm them through the order's link, keep none yet: the order is placed before they agree,
  so when they agreed is a time of its own to keep.
* Tried on the demo shop: draft #D8's page named the refund, privacy, terms and shipping
  policies, each opening on the storefront. Confirmed from a phone's browser, order #1055 kept
  the four versions, the address and the browser. The order was then cancelled and its customer
  erased, which cleared the address and browser and left the versions.

### e26e632 · Erased receipts' files removed from storage

* **An erased customer's receipts leave storage too**
  ([ADR-113](../architecture/13-decision-log.md#adr-113--an-erased-customers-receipts-leave-storage-too-the-erasure-records-each-orders-receipt-files-in-an-event-and-the-worker-removes-them-once-it-commits)): erasing a customer deleted the records of
  the receipts they sent for their transfers, but storage kept the files, their names and
  accounts on them, for as long as the shop lasted.
* **The erasure records what to remove, in its transaction**: deleting an order's receipts, it
  appends an `order.receipts_erased` event naming their files' keys, one event per order.
  Storage can't join the transaction: a file deleted before the commit could be gone from an
  erasure that rolled back, and one deleted after could be missed if the process died between.
  The event is recorded only if the erasure commits, and the outbox delivers it at least once.
* **The worker removes them** (`ErasedReceipts`, in its events role): each key under that
  order's receipts in that shop, `shops/{shop}/receipts/{order}/`, as every receipt's is; a key
  elsewhere is left and logged. A file already gone changes nothing, and the worker's test hands
  the event over twice.
* **The worker reads the API's storage settings** (`STORAGE_DRIVER`, the directory or the bucket
  and its keys), with the same checks, so the two name the same place. An erasure that waited
  (ADR-110) does the same when the sweep carries it out.
* Simplification 57 now says what is left: a sweep for files no record names. Simplification
  50 is corrected too: the sales report has said how much of its sales is tax since sales tax
  reached refunds, but net sales still include it.
* Tried on the demo shop with the worker running: an order paid by transfer (#1054) with a
  receipt sent through its page, then cancelled and its customer erased; the receipt's file, and
  the type kept beside it, were gone a millisecond after the erasure's `customer.erased` event,
  as the order's `order.receipts_erased` reached the worker.

### e44afd3 · Risk scored again as a customer's history changes

* **An order waiting to be confirmed is scored again when its customer's history changes**
  ([ADR-112](../architecture/13-decision-log.md#adr-112--an-order-waiting-to-be-confirmed-is-scored-again-when-its-customers-history-changes-by-the-worker-a-score-that-makes-it-risky-holds-it-and-a-held-order-stays-held)): a parcel of
  theirs delivered, refused, back or lost, an order of theirs cancelled, or another customer
  merged into them. The worker's `RiskRescoring` takes those events and the orders module's
  `rescoreRisk` scores the customer's open, unshipped cash-on-delivery orders still waiting to
  be confirmed or reviewed, by the same rules as at placement.
* **A new score that makes a waiting order risky holds it**, as it would have been held when
  placed, with the reasons on its timeline; one held already stays held, whatever its score,
  and a confirmed one keeps the score it was confirmed on. Every new score is on the timeline
  ("Scored again as the customer's history changed: risk 0.60 (high), was 0.25. …") and in an
  `order.updated` event naming `risk`.
* **The duplicate rule looks back from the order's placing**: re-scored, an order counts the
  customer's unshipped orders placed in the 6 hours before it, not before now.
* **Safe to repeat**: it reads the history as it is and locks the waiting orders in one order;
  the worker's test hands the refusal's event over twice, and the second changes nothing.
* Lifts simplification 25, which waited for the Confirmation Desk.
* Tried on the demo shop with the worker running: three orders for a number made for it, the
  first shipped and then refused; within milliseconds of the refusal's event the worker had
  scored the second 0 → 0.35 and the third 0.25 → 0.60, holding the third for review with both
  reasons on its timeline. The two were then cancelled, the parcel taken back into stock and the
  customer erased.

### 3965f76 · More hot queries prepared

* **Orders and carts are read through prepared statements too**
  ([ADR-111](../architecture/13-decision-log.md#adr-111--orders-and-carts-are-read-through-prepared-statements-too-each-checked-by-the-benchmark-against-shops-of-every-size-a-prepared-page-writes-its-size-into-its-text)):
  an order by ID, which every change to an order answers with, orders by ID for loaders, and
  pages of the newest orders or of one stage's, risk level's or customer's; a cart by its secret,
  its variants and their stock. Searches, dates and filters together are planned each time.
* **Measured first, on medium shops** (one caller, median, direct and through PgBouncer): an order
  went from 1.65 to 0.49 ms and from 2.16 to 0.60 ms, the newest 50 orders from 3.66 to 2.69 and
  from 4.03 to 2.84 ms, a cart from 2.44 to 2.26 and from 3.23 to 3.00 ms.
* **A prepared page writes its size into its text** (`literalLimit`). With the limit a parameter,
  Postgres priced the generic plan of the newest orders at a tenth of a shop's rows and planned
  every call: the page took 3.27 ms, not 2.69.
* **Customers' statements stay as they were**: prepared, Postgres still planned them every call
  and the customers page slowed from 0.95 to 1.16 ms, so they were left out.
* **The benchmark's shops sell now**: a location with stock, 724,204 orders at every stage with
  lines and parcels, 543,267 customers and 46,385 carts, beside spike 5's unchanged catalog.
  `pnpm bench:db prepared` captures the statements the application prepares and checks each
  generic plan against a small, a medium and a large shop's: every one matched
  ([output](./spikes/05-prepared-output.md)). `service` times orders, an order, customers and
  a cart too.
* `runPrepared` prepares a Drizzle query as `executePrepared` does SQL; a list of IDs goes in as
  one array, so one statement serves every length.
* Tried on the demo shop: the restarted API answered seven requests for its orders and for one
  order, past the five after which Postgres may keep the generic plan, and a cart added through
  the storefront route, read seven times and cleared; the cart was then removed.

### 975d90b · Erasure requests that wait

* **A customer's erasure can be asked for ten days ahead**
  ([ADR-110](../architecture/13-decision-log.md#adr-110--a-customers-erasure-can-be-asked-for-ten-days-ahead-and-cancelled-until-then-the-workers-sweep-carries-it-out-as-the-system-naming-who-asked)):
  `customerErasureRequest` says when, as `erasureScheduledAt`, which the customer shows too, and
  `customerErasureCancel` stops it until then. Asking again keeps the first time. Staff need a
  recent sign-in to ask, as they do to erase at once; cancelling needs `write_customers` alone.
* **The worker's sweep carries it out once due**: it finds the shops with erasures due as the
  system, then erases each customer in their shop's own transaction, as `customerErase` would,
  after locking them and finding the request still there. One with an order still open waits for
  a later sweep. Orders' timelines say the system erased the customer's details; the
  `customer.erased` event and audit entry name who asked, and when. Asking and cancelling are
  events and audit entries of their own.
* **A duplicate whose erasure waits can't be merged away**, since its request would go with it
  and the erasure never happen; erasing a customer at once takes their request with them.
* **The worker runs each module's part in an erasure as the API does**: it builds its own
  registry of the modules' handlers, which a test holds equal to the API's. Its sweeps share
  `repeat`, which runs one at once and then every interval after the last ends.
* Tried on the demo shop: a customer made for it was given a date ten days on, kept it when asked
  again, lost it on a cancel, which a second cancel then refused, and got a new one. The sweep
  left it alone as of now, and erased the customer as of eleven days on; the audit log showed
  the requests, the cancel and the erasure, which named the requesting app and when it asked.

### d990adb · Other numbers in customer CSVs

* **A customer's other numbers travel in a CSV column of their own**
  ([ADR-109](../architecture/13-decision-log.md#adr-109--a-customers-other-numbers-travel-in-a-csv-column-of-their-own-after-the-main-number-in-exports-and-in-imports-a-new-customers-or-on-overwrite-in-place-of-an-existing-ones)):
  exports list them in Other phones, after the main number, oldest first and separated by
  commas, and imports read them back, also from Other numbers or Alternate phones and separated
  by semicolons or slashes. Hatti's export now imports into another shop with every number.
* **Each number checked as a customer's other numbers are**: a Pakistani mobile, not the main
  number, at most ten, in one row of the file and no other customer's in the shop. A row that
  fails is reported at that column and left out.
* **A new customer gets the file's numbers**; one already here keeps theirs unless the import
  overwrites it, when a list takes the place of theirs and the numbers it leaves out stop being
  theirs. A blank cell leaves them, as blank cells leave every field.
* The orders module's test of the export's order columns finds them by name now, not position.
* Tried on the demo shop: a customer made for it, with one other number, came out of an export
  with it beside the main number; an import overwriting them gave the customer the two the file
  listed instead. The customer was then erased.

### 4500a79 · Prepared statements for hot queries

* **Hot queries run as statements prepared by name**
  ([ADR-108](../architecture/13-decision-log.md#adr-108--hot-queries-run-as-statements-prepared-by-name-planned-once-per-connection-every-pooler-in-front-of-the-application-sets-max_prepared_statements)):
  `executePrepared` names a statement after a digest of its text, so each connection parses and
  plans it once and afterwards only binds and runs it. The products statement is the first:
  the admin's products list, newest first, and a product by ID, IDs or handle. A collection's
  pages, sorted otherwise, are planned each time until their plans are checked.
* **Measured first**, on spike 5's dataset: a products page's two statements took 1.50 ms over
  the extended protocol and 0.98 ms prepared, directly, and 1.66 and 1.09 ms through PgBouncer,
  with 30% to 49% more throughput at 8 clients. Their generic plans, which Postgres may keep
  after five runs, are the same as the custom ones for large shops and small. In the
  application's own code, the products list's median fell from 2.81 to 2.23 ms directly and from
  3.05 to 2.48 ms through PgBouncer.
* **PgBouncer runs with `max_prepared_statements`**, 200 per server connection, locally and in
  CI. A database test runs a prepared statement from four callers at once through it; behind a
  pooler without the setting it fails, as the second caller's statement collides with the
  first's (42P05). Deployments must carry the setting too.
* Tried on the demo shop: the restarted API answered eight requests for its products and a product
  by handle alike, past the five runs after which Postgres may switch to the generic plan.

### 419e820 · One round trip fewer per transaction

* **A tenant transaction begins with its shop and limits set, in one round trip**
  ([ADR-107](../architecture/13-decision-log.md#adr-107--a-tenant-transaction-begins-with-its-shop-and-limits-set-in-one-round-trip-begin-and-set_config-sent-as-one-simple-query-the-values-written-in-once-checked)):
  `begin` and the `set_config`s go as one simple query, where drizzle sent them one after the
  other. The shop's ID and the limits are written into it once checked, a UUID and whole
  milliseconds; the work runs on drizzle's own transaction over that connection, savepoints and
  all.
* **A connection that fails while a transaction holds it is closed**, not handed on. The pool
  hears idle connections' errors only, so one failing between a transaction's statements went
  unheard and would have ended the process, as a test that kills its own connection showed.
* **Measured on spike 5's dataset**: around a `select 1`, the median went from 0.26 to 0.19 ms
  direct and from 0.40 to 0.30–0.32 ms through PgBouncer; the products page from 2.93 to 2.86 ms
  direct and from 3.12 to 3.00 ms through PgBouncer. No shop leaked across 34,965 interleaved
  transactions direct and 52,587 through PgBouncer.
* **The benchmark loads again**: its seed predated options, and the catalog now refuses a
  product's second variant without one, so clothes and shoes get a Size option. Its pgbench
  scripts begin as the application does.
* Tried on the demo shop: the restarted API read its products, orders and drafts, saved draft #D7
  and deleted it, and refused a product whose handle was taken, leaving nothing behind.

### 065985c · Drafts' sales tax

* **A draft says the sales tax its prices include**
  ([ADR-106](../architecture/13-decision-log.md#adr-106--a-draft-says-the-sales-tax-its-prices-include-an-open-ones-at-the-shops-rates-now-as-placing-it-would-work-it-out-a-completed-ones-as-its-order-keeps-it)):
  while it is open, at the shop's rates and its variants' now, worked out as placing it would;
  once completed, as its order keeps it, whatever the shop's rate since. Nothing is stored:
  `DraftOrder.taxesIncluded`, `totalTax` and `taxLines`, as Shopify's, are worked out when asked
  for, a page of drafts at once through the request's loaders.
* **Its link's page says it under the total**, a line a rate in English and Urdu, as orders'
  pages do. What the page showed now includes the tax, so a page opened before the shop's tax
  changed shows the draft again, rather than placing an order whose tax the customer had not seen.
* The status page's simplification on sales tax no longer lists refunds' and reports' tax,
  which ce5ddc9 did.
* Tried on the demo shop, at 18% for the while: draft #D6, a Rs 1,850 ajrak with Rs 200 for
  delivery, said Rs 282.20 of tax in the API and on its link's page, while the completed drafts
  beside it kept their orders' none. With delivery taxed too, confirming from the page opened
  before was refused (409), and the page showed Rs 312.71. The draft was then deleted and the
  rate set back to none.

### ce5ddc9 · Sales tax in refunds and the sales report

* **Each refund keeps its share of its order's sales tax**
  ([ADR-105](../architecture/13-decision-log.md#adr-105--a-refund-keeps-its-share-of-its-orders-sales-tax-the-orders-tax-in-all-it-has-refunded-less-what-the-refunds-before-it-gave-back-the-sales-report-adds-up-the-tax-its-sales-include)):
  the order's tax in all it has refunded, this refund included, in proportion to its total and
  rounded half up, less what the refunds before it gave back, so that refunds of a whole order
  give back all its tax however many there are (`refunds.tax`, migration 0072, which works it out
  for refunds made before, in their order). `Refund.totalTax` gives it, `Order.currentTotalTax`
  what the order keeps after its refunds, and the refund's event and audit entry carry it.
* **The sales report's `taxes`**: its orders' tax less that of the items that came back, period
  by period. Prices include it, so it is part of the other amounts, never added to them.
* Tried on the demo shop, at 18% for the while: #1050, a Rs 3,499 chappal paid ahead, kept Rs
  533.75 of tax; Rs 1,000 refunded took Rs 152.54 of it back, the Rs 2,499 left the other Rs
  381.21, leaving none, and the day's report counted the Rs 533.75. The order was then cancelled
  and the shop's rate set back to none.

### bfa18ad · Batched collection lookups

* **A page of products reads its collections with one query**: `Product.collections` asks the
  request's loaders, as variants' stock does, and `collectionsOfProducts` reads the first page of
  each product's collections with one ranked query and their details with another, instead of a
  query a product. Items asking for the same page share a loader named after its arguments.
* An end-to-end test counts one call for a page of products, as the stock test does; the
  simplification it lifts is off the status page.

### eccee12 · Handing a shop over

* **The owner hands the shop to one of its managers**
  ([ADR-104](../architecture/13-decision-log.md#adr-104--the-owner-hands-the-shop-to-one-of-its-managers-who-has-a-second-factor-and-stays-on-as-a-manager-the-shop-has-one-owner-throughout)):
  `shopOwnershipTransfer(staffMemberId)` makes the manager the owner and the owner a manager,
  from their next requests. Only the owner does it, having proved who they are in the last 15
  minutes; never other staff or apps.
* **Only to a manager with a second factor**, since owners must pass one to open the shop; to
  hand it to someone new, the owner invites them as a manager first.
* **One owner throughout**: both memberships locked, the old owner steps down before the new one
  steps up, in one transaction. `shop.ownership_transferred` goes on the audit log, from whom to
  whom, and both accounts' activity says so. Staff identity's last piece that needs no email.
* Tried in a shop made for it: the owner, signed in with a passkey, was told the manager needed a
  passkey first; the manager, refused the handover themselves, added one; the owner handed the
  shop over, the staff list showed them swapped, the old owner could not take it back, and the
  audit log named both. The accounts and the shop were then deleted.

### f9f1904 · Re-authentication for sensitive actions

* **Sensitive actions need staff to have proved who they are in the last 15 minutes**
  ([ADR-103](../architecture/13-decision-log.md#adr-103--sensitive-actions-need-staff-to-have-proved-who-they-are-in-the-last-15-minutes-by-signing-in-or-confirming-with-the-strongest-factor-their-account-has-apps-are-not-asked)):
  each session keeps when its user last did (`authenticated_at`, migration 0071), at sign-in or
  since, and refreshing leaves it. `@RequireRecentAuthentication()` marks eight mutations: taking
  staff on, changing their roles or letting them go, where transfers are paid, customers' and
  orders' exports, a customer's file and their erasure. `/auth` asks the same before passkeys or
  an authenticator app change. Apps are not asked.
* **Refused before anything runs**: such a request from staff past the 15 minutes gets
  `REAUTHENTICATION_REQUIRED` (403) before its Idempotency-Key is claimed, so the same request
  with the same key goes through once they have confirmed. The guard refuses them too, after
  scopes.
* **Confirming takes the strongest factor the account has**: `POST /auth/reauthenticate/options`
  says which, with a passkey's options; `POST /auth/reauthenticate` takes a passkey of the user's
  own, a code from their authenticator app (once; recovery codes don't), or the password of an
  account with neither. A second factor marks the session as having passed one. Attempts are rate
  limited and on the account's activity.
* Tried on the demo shop: a manager signed in with a passkey exported its 31 customers; made 20
  minutes older, the same export was refused with a 403 while a customers query went through; the
  password was refused (`INVALID_METHOD`), the passkey confirmed, and the refused request went
  through with its own key. The account was then deleted.

### 2fdfae6 · A customer's own data export

* **A customer's own data is one JSON file**
  ([ADR-102](../architecture/13-decision-log.md#adr-102--a-customers-own-data-is-one-json-file-of-everything-the-shop-keeps-of-them-which-each-module-with-their-data-adds-to-the-blocklist-and-risk-scores-stay-out)):
  `customerDataExport(id)` returns `customer-cus_….json` for an owner or manager to send them:
  their profile with every number, marketing consent and its history; their orders whole, with
  items, amounts, address, what they agreed to and from where, parcels, refunds, calls to confirm
  and the receipts they sent; drafts found as erasure finds them; and their uses of discount
  codes. It takes `write_customers` and `read_orders`, and each export is an audit entry,
  `customer.data_exported`. CUS-05 is done, its erasure half having come first.
* **Each module with customer data adds its sections** through `CustomerDataHandler.export`,
  beside `erase`: orders give `orders` and `draftOrders`, discount codes `discountCodeUses`.
  `ErasedCustomer` is now `CustomerIdentity`, since exports find records by the same numbers and
  email.
* **The shop's defences against fraud stay out**: the blocklist, orders' risk scores and their
  reasons, and orders' timelines, which hold the reasons for holds. So does which of the staff
  did what.
* Postgres keeps a jsonb object's keys in its own order, the shortest first, so a stored address
  came out `zip` first; the file writes addresses field by field, with the province's name.
* Tried on the demo shop: Usman Ali's file has #1006 with its TCS parcel, delivered, the Rs 300
  refunded to his wallet, and the WhatsApp and SMS consent he gave; Ayesha Khan's has her other
  number and the agents' four calls; Fatima Raza's, her use of EID25. Four exports, four audit
  entries.

### edfa8e5 · Staff invitations

* **Owners and managers invite staff by a link they send themselves**
  ([ADR-101](../architecture/13-decision-log.md#adr-101--owners-and-managers-invite-staff-by-a-link-they-send-themselves-accepted-once-by-a-signed-in-account-the-owner-manages-every-role-but-its-own-managers-those-below-them-apps-none)):
  `staffInvitationCreate` returns the link's secret once (`hsi_…`, kept as a digest, migration
  0070), with a role and a note of whom it is for, good for 7 days, 50 waiting at most a shop.
  `POST /auth/invitations/preview` says what it is before anyone signs in, and
  `POST /auth/invitations/accept` makes the signed-in account a member in its role, once.
* **The owner manages every role but its own, managers those below them, apps none**:
  `staffMembers`, `staffInvitations`, `staffInvitationRevoke`, `staffMemberRoleUpdate` and
  `staffMemberRemove`, each change reading the acting member's role again under a lock and going
  on the shop's audit log. Nobody is made the owner, or changes or removes themselves, so. Until
  now only the seed put staff in shops.
* `StaffService` keeps it all in the identity module; the core's `StaffResolver` authorises by the
  shop's role and writes the audit log.
* Tried on the demo shop: a new account, signed in with a passkey, was made a manager, invited
  Imran as a packer (and was told only the owner invites managers), whose account previewed and
  accepted the link; the manager made him a marketer and removed him, and the audit log shows the
  three changes by a manager. Both accounts were then deleted.

### 88bdae8 · Passkeys for staff

* **Staff sign in with a passkey alone**, which passes the second factor, **or answer the second
  step after their password with one**
  ([ADR-100](../architecture/13-decision-log.md#adr-100--staff-sign-in-with-a-passkey-alone-which-passes-the-second-factor-or-answer-the-second-step-after-their-password-with-one-once-an-account-has-a-second-factor-only-a-session-that-passed-one-adds-another)),
  through `@simplewebauthn/server` 14.0.3: discoverable passkeys, their user verified, no
  attestation. `POST /auth/sign-in/passkey/options` and `POST /auth/sign-in/passkey` sign in;
  `mfa_required` now names the `methods` that answer it and, for a passkey, `passkeyOptions`,
  which `POST /auth/sign-in/verify` takes back as `passkey`. Staff list, add and remove their
  passkeys under `/auth/passkeys`; the first second factor comes with recovery codes, and once an
  account has one, adding a passkey or an authenticator app, or removing a passkey, takes a
  session that passed one. Challenges answer once within 5 minutes (migration 0069), and
  counters must move on where kept.
* Where passkeys belong is `PASSKEY_RP_ID` and `PASSKEY_ORIGINS`, checked at start-up so that
  each origin is on the relying party or under it, `PUBLIC_URL`'s host and origin unless set.
* **`SoftAuthenticator`** (`@hatti/identity/testing`) makes ES256 passkeys and signs with them as
  a phone's would, synced or not, so the identity module's tests and the API's run the real
  verification: phishing from another origin, a replayed response, a passkey no one added, a
  counter gone back, a disabled account and a passkey that didn't verify its user are all
  refused.
* Tried in Chromium with its virtual authenticator against the dev API: a new account added a
  passkey (201, with 10 recovery codes), signed in with it alone and after its password, the
  session passing the second factor each time, listed it as used, and removed it (204).

### af41854 · Prepaid alone for the riskiest orders

* **A limit for risk in the shop's rules for cash on delivery** (COD-06,
  [ADR-099](../architecture/13-decision-log.md#adr-099--an-order-paid-on-delivery-that-the-shops-risk-rules-score-at-its-limit-or-above-is-not-taken-at-checkout-placed-scored-and-undone-its-page-asks-for-a-transfer-instead)):
  `riskScoreLimit`, 0.01 to 1, above the advance's `riskScore` where the shop asks one by risk,
  which migration 0068 checks too. Checkout places an order paid on delivery as before, reads the
  score placing gave it and, at the limit or above, undoes it by throwing in the order's
  transaction, as a refused discount code does: nothing of it is left, its number and its
  customer included. The page comes back with a transfer chosen where the shop takes one, saying
  "The shop asks for this order to be paid in advance. Pay by bank transfer to place it.", in
  English and Urdu; without one, that cash on delivery isn't available for the order. The page
  says nothing of the limit before.
* Tried on the demo shop at 0.30. In Chromium, a Peshawari chappal to "Bazaar", Lahore, paid on
  delivery, came back 409 with those words and the transfer chosen; placed so, it was #1049, for
  Rs 3,474 with Rs 175 off for paying by transfer and no fee, and nothing was left of the first
  try. #1049 was then cancelled and the limit taken away.
* Also: two links in the conventions that an earlier edit had left as `({link})` now go to
  ADR-077.

### 6640ca1 · Exact cursors for the lost and returning parcels

* **`lostParcels` and `returningParcels` page on times to the microsecond**, as `parcelClaims`
  does. Their cursors kept the millisecond a JavaScript date keeps, while the database keeps the
  microsecond, so the page after one started at the millisecond of the parcel it ended with,
  just before it, and brought it back: a client paging one parcel at a time would have had that
  one for ever. The service now gives each parcel's time as `to_char` writes it (`exactly()`),
  the cursor carries it as it is, and a cursor whose time is not to the microsecond, or on no
  real day, is refused as malformed, as Postgres would refuse it.
* Their tests had set the parcels' times to whole seconds, which hid it. They now set them to
  the microsecond, and the API's test pages one at a time through parcels whose times the
  database set itself; both failed before the fix, the parcel a page ended with first on the
  next. On the demo shop, paged one at a time, the claims came once each (#1012, #1030, #1007),
  and so did the lost parcels (#1012, #1030).

### cbe9b89 · Claims for parcels that came back damaged

* **What of a parcel that came back was written off as damaged is claimed from its courier**
  (COD-09, [ADR-098](../architecture/13-decision-log.md#adr-098--a-parcel-that-came-back-with-items-written-off-as-damaged-is-claimed-from-its-courier-for-their-worth-as-a-lost-parcel-is-for-its-own-every-claim-is-listed-the-oldest-first-to-follow-up)):
  `fulfillmentClaimCreate` takes a returned parcel too, at the worth of its items not restocked,
  at their prices on the order, unless the shop says otherwise; one back whole, or still on its
  way back, is refused. The claim is the one a lost parcel has, settled the same way, and the
  timeline says what it is for: "the damaged items of the returned parcel PX10293847". Couriers'
  statements pay lost parcels' claims alone: cash on a parcel that came back stays a line to look
  into, recorded on its claim by hand. Migration 0067 lets only lost and returned parcels have
  claims, and indexes those that do.
* **`parcelClaims` lists every claim, the oldest first**, lost or damaged, by status and courier,
  to follow up those open or refused; the home's `claimsOpen` counts both kinds, and
  `lostToClaim` still the lost parcels alone. Its cursor keeps when a claim was made to the
  microsecond: the first try, at a JavaScript `Date`, brought the claim a page ended with back at
  the top of the next. `lostParcels` and `returningParcels` page on their times the same way, and
  are fixed next.
* Tried on the demo shop: #1022, back whole, was refused a claim. #1007's PostEx parcel
  PX10293847, back with its shalwar qameez written off, was claimed at Rs 3,400 with "Seam torn,
  box wet"; the home counted it open, with no lost parcel to claim, and `parcelClaims` listed it
  after the paid claims on #1012's and #1030's lost parcels. PostEx's refusal, then the claim's
  withdrawal, took it off the home, each on #1007's timeline: "PostEx refused the claim for the
  damaged items of the returned parcel PX10293847: PostEx says the box was packed badly".

### 10b941c · Tax categories

* **Rates of their own for some products** (TAX-01,
  [ADR-097](../architecture/13-decision-log.md#adr-097--tax-categories-are-the-shops-codes-with-rates-of-their-own-which-variants-name-by-shopifys-tax-code-every-other-variant-it-taxes-is-at-the-shops-rate)):
  a shop's tax categories, each a code, a name and a rate, up to twenty, kept with its tax
  settings and replaced whole through `taxSettingsUpdate` (migration 0066), codes each once in any
  letter case.
* **Variants name them by Shopify's tax code** (`taxCode`, which the product import reads from
  "Variant Tax Code"): a taxable variant whose code is a category's is taxed at its rate, any
  other at the shop's; categories apply only while the shop charges tax, and delivery and the fee
  stay at the shop's rate. Each line keeps its rate, so receipts, invoices, checkout's page and
  the API's `taxLines` give a line a rate.
* Tried on the demo shop at 18%, with a category at 10% that the ajrak's variant named. In
  Chromium, a chappal and an ajrak came to Rs 5,349, delivered free: the page said "Sales tax 10%
  (included) Rs 168.18" and "Sales tax 18% (included) Rs 533.75". Placed paying on delivery,
  #1048 came to Rs 5,449 with its fee, whose Rs 15.25 joined the 18%: Rs 549. The API's
  `taxLines` said the same, each line its own. The order was then cancelled, the code taken off
  the ajrak and the tax away from the shop.

### f3ffad1 · Sales tax, included in prices

* **A shop's sales tax, included in its prices** (TAX-01, CHK-17,
  [ADR-096](../architecture/13-decision-log.md#adr-096--sales-tax-is-included-in-prices-at-a-rate-the-tax-module-keeps-each-order-keeps-the-tax-in-it-as-it-was-placed-line-by-line-and-in-its-delivery)):
  a tax module of its own (`@hatti/tax`, migration 0065) keeps one rate, or none, every shop's
  until it sets one, and whether its delivery charges and fee for paying on delivery include it;
  `taxSettings` and `taxSettingsUpdate`, audited, for those who read and write settings. Prices
  always include it, as Pakistan's consumer laws ask them to be shown: no total grows for it, and
  Shopify's `taxesIncluded`, `shop.taxes_included` and `cart.taxes_included` say so.
* **Each order keeps the tax in it as it was placed**, at the rate then: on each taxable line,
  what was paid for it after its share of the discount, rounded half up line by line, and on its
  delivery and fee where the shop's include them. Variants are taxed unless the shop says
  otherwise, Shopify's `taxable`, which the product import reads from "Variant Taxable".
* **It is said where the total is**: on checkout's page, worked out as placing will, a change of
  rate showing the page again; on the placed page, invoices and customers' order pages, a line per
  rate, "Sales tax 18% (included)", in English and Urdu; in the API, Shopify's `totalTax` and
  `taxLines` on orders and their lines; and in the export, the order's taxes and each line's.
* Tried on the demo shop at 18%, delivery included. In Chromium, an ajrak's checkout said "Total
  Rs 2,000" and "Sales tax 18% (included) Rs 305.08" once Lahore was typed. Placed paying on
  delivery, #1047 came to Rs 2,100 with its Rs 100 fee and kept Rs 320.34: Rs 282.20 in the
  ajrak, Rs 38.14 in delivery and the fee. Its thank-you page, the API and its invoice said so.
  The order was then cancelled, keeping its tax, and the rate taken away.

### a5529f4 · The setup checklist

* **What a new shop has left to set up before it sells** (ONB-02,
  [ADR-095](../architecture/13-decision-log.md#adr-095--the-setup-checklist-is-worked-out-when-asked-from-what-each-module-keeps-in-one-transaction-a-step-is-done-while-what-it-asks-for-holds)):
  `setupChecklist` asks seven things in the order a shop is asked them: products on sale, its
  delivery charges, a bank account for transfers, Raast and advances, the refund, privacy and
  shipping policies and terms of service, its logo, its WhatsApp number, and its store open to
  shoppers. Each step says whether it is done and, for those of many things, how far along it
  is: the products on sale, and how many of the four policies are written.
* **Worked out when asked, in one transaction, from what each module keeps**: nothing is stored,
  so a step is done as soon as what it asks for is, and undone when it no longer is, as when the
  store is closed again or its last product drafted. The catalog counts its products on sale
  (`activeProductsIn`); the other steps are read through the facades of the modules that keep
  them. Owners and managers read it, and apps with `read_settings`; the API gives keys, and the
  admin app will word them in English and Urdu.
* Tried on the demo shop: six steps of seven were done, one policy of the four written. The other
  three were written from their drafts (`shopPolicyDraft`), and the checklist was done, seven of
  seven.

### 541541d · An advance of customers new to the shop, or by their risk

* **The shop's advance may be asked only of customers new to it** (CHK-10,
  [ADR-094](../architecture/13-decision-log.md#adr-094--a-shops-advance-may-be-asked-only-of-customers-new-to-it-and-of-orders-its-risk-rules-score-high-such-an-order-is-asked-it-instead-of-waiting-for-review)),
  `newCustomers`: none of their orders delivered before, by any of their numbers, counted with
  their refusals as the order is placed (`OrderService.deliveriesOf`, which `refusedDeliveriesOf`
  became), never for the page.
* **And only of orders its risk rules score high** (COD-06), `riskScore` from 0.01 to 1: checkout
  hands the orders module the advance with the score it needs (`riskAdvance`), and placing scores
  the order as any order paid on delivery; if the score reaches it, the order asks for the
  advance instead of waiting for review, keeps its score, and says why on its timeline ("Asks for
  Rs 500 in advance for its risk 0.35 (medium). …"); scored lower, it asks nothing and the shop's
  hold applies as before. The checkout doc's middle outcome of the risk decision, a partial
  advance, is built.
* **The page says of whom before anything is typed**, in English and Urdu: "If no order from this
  shop has reached you before", "If the shop's checks on your order call for it". Migration 0064
  keeps both conditions with the shop's rules, and the API's `CashOnDeliveryAdvance` has
  `newCustomers` and `riskScore`, checked in hundredths.
* Tried on the demo shop in Chromium: with the delivery charge asked of new customers, the option
  said so in both languages; a number whose order #1005 was delivered placed #1043 asking nothing,
  and a new number placed #1044 asking its Rs 150. With Rs 500 asked of orders scored 0.30 or
  more, a new number's order to "Bazaar", no house number and a short address, scored 0.35 and
  was #1045 asking Rs 500, its timeline saying why; one with a full address scored 0.10 and asked
  nothing. The advance was then taken away and the orders cancelled.

### 6551ef6 · Claims on couriers for the parcels they lost

* **A lost parcel's worth is claimed from its courier** (COD-09,
  [ADR-093](../architecture/13-decision-log.md#adr-093--a-claim-on-the-courier-that-lost-a-parcel-is-the-parcels-followed-until-the-courier-pays-it-or-refuses-it-a-statements-cash-for-a-lost-parcel-pays-its-claim-filed-or-not)):
  `fulfillmentClaimCreate` files the claim at the parcel's worth, its items at their prices on
  the order, or what the shop says, up to the order's total, with a note such as the courier's
  complaint number. The claim is the parcel's, kept with it (migration 0063), `OPEN` until
  `fulfillmentClaimSettle` records it paid otherwise than in a statement, refused, or withdrawn;
  a refused claim may still be paid, and a withdrawn one filed again. A lost parcel that turns up
  and is checked back in has its claim withdrawn, unless it was paid. Owners, managers and
  accountants claim, as they reconcile couriers' cash.
* **A statement's cash for a lost parcel pays its claim** (`COMPENSATED`), filing one the shop had
  not, at the parcel's worth or what was paid if more; it used to be cash on an order owing
  nothing, to look into. A claim paid by hand or withdrawn leaves the line to look into. The
  import reads its parcels again once their orders are locked, so that a claim settled by hand
  meanwhile is not paid twice, and each statement keeps what of its cash paid claims, as it keeps
  what was received; statements imported before pay their claims in the migration.
* **`lostParcels` lists the lost parcels**, the longest lost first, with their worth and claims, by
  claim and courier, and the home counts those to claim, at their worth, and the claims open.
* Tried on the demo shop through the API: #1012 and #1030 shipped with TCS and marked lost, the
  home had two to claim for Rs 5,749; #1012's claimed at its Rs 3,499 with TCS's complaint
  number, and then one to claim and one claim open. A TCS statement paying Rs 3,000 for the
  first and Rs 2,500 for the second, with Rs 180 in charges, was two lines compensated on a dry
  run and then on import: the first claim paid Rs 3,000 of Rs 3,499, the second filed at Rs 2,500,
  more than its Rs 2,250 worth, and paid; the charges on its parcel, nothing received on either
  order, and each step on their timelines.

### ce83cb5 · Giving up on customers who can't be reached

* **A shop may say after how many days to give up on a customer** (COD-05,
  [ADR-092](../architecture/13-decision-log.md#adr-092--an-order-whose-customer-could-not-be-reached-is-cancelled-as-many-days-after-it-was-placed-as-the-shop-says-by-a-sweep-in-the-worker-shop-by-shop-and-order-by-order)),
  `cancelUnreachableAfterDays`, from 1 to 30, or none for never: an order whose customer did not
  answer three calls, still waiting to be confirmed that many days after it was placed, is
  cancelled for no response, its stock let go, and its timeline says the customer could not be
  reached in that many days.
* **A sweep in the worker cancels them**, under its new `sweeps` role, on by default with the
  relay and events: it finds the shops that give up with the system role, then cancels each
  order in its shop's own transaction, locked and checked again, so an agent confirming it that
  moment either wins or is refused cleanly. A shop gives up on 100 orders at most a sweep, every
  `SWEEP_INTERVAL_MS` (ten minutes), a sweep never starting before the last ended; one shop's
  failure is logged and tried again on the next. Migration 0062 keeps the days with the order
  settings, which check them and record each change.
* Tried on the demo shop through the API: with 2 days, two more unanswered calls made #1001,
  placed on 29 September, wait with no response; the worker, started with its sweeps alone,
  cancelled it at once for no response, its stock commitment released by the system and
  `order.cancelled` in the outbox, and shut down cleanly when stopped. The days were then taken
  away.

### 98c0805 · Calling hours and the first call

* **A shop may keep calling hours** (COD-05,
  [ADR-091](../architecture/13-decision-log.md#adr-091--a-shops-confirmation-desk-keeps-calling-hours-outside-which-it-deals-out-no-order-and-after-which-an-unanswered-one-falls-due-an-order-waiting-longer-for-its-first-call-than-the-shops-target-counting-those-hours-is-overdue)),
  the same day's clocks in its time zone, an hour apart at least: outside them
  `confirmationQueueNext` deals out no order and says when they open, and the queue says whether
  it is calling time. An unanswered order falls due again in two hours, or at the next opening
  if that is outside them; a time the customer asked for stands.
* **A first-call target**, `firstCallMinutes`: an order not called yet that has waited longer,
  counting calling hours alone, is `overdue`, and the queue counts them, so an order placed at
  night starts waiting when the desk opens.
* **Each day's hours become instants in Postgres**, from local midnights without a time zone
  (`generate_series` over dates gives them one, which turned the first try's hours inside out),
  and `calling-hours.ts` counts through them in TypeScript. Migration 0061 keeps the hours and
  the target with the order settings, which check them and record each change.
* Tried on the demo shop through the API at 14:55 in Karachi: with hours of 09:00 to 14:00 and a
  30-minute target, the queue said calling opens at 09:00 tomorrow and that #1011 and #1026,
  never called, were overdue, and none was dealt; with hours to 16:00, #1011 was dealt, and its
  unanswered call fell due at 09:00 tomorrow rather than 16:55. The hours were then taken away.

### ec82869 · Agents' performance

* **`confirmationAgents` says how each agent of the Confirmation Desk did over a period of work**
  (COD-11,
  [ADR-090](../architecture/13-decision-log.md#adr-090--agents-performance-is-worked-out-when-asked-from-the-calls-the-desk-keeps-and-the-confirmations-and-cancellations-on-orders-timelines-by-who-made-them-with-how-the-orders-each-agent-confirmed-turned-out)),
  a year at most: the orders they confirmed, those they cancelled while they waited to be
  confirmed, their calls that settled nothing by how they went, their hours on the desk as their
  work shows them in the shop's time, and how the parcels of the orders they confirmed went,
  counted as COD health counts them, so its return rate is the RTO rate of the orders they
  confirmed. The API adds the confirmation rate and confirmations an active hour.
* **An agent is whoever did the work**, a staff member or an app by its access token; customers
  confirming through their links are no one's. Owners and managers see it, and apps with
  `read_orders`; agents are refused.
* **Worked out when asked** from the desk's calls and the `confirmed` and `cancelled` entries of
  orders' timelines, which migration 0060 indexes by when, partially; COD health's parcel tally
  is shared.
* Tried on the demo shop through the API: an agent's token recorded an unanswered call on #1040,
  confirmed #1041 and cancelled #1042 as declined, and the day's report had them at one
  confirmed and one cancelled, a 0.5 confirmation rate, one call unanswered and one confirmation
  in their one hour; over the year, the seed's app had confirmed five orders, of whose three
  parcels one came back. The orders were then cancelled.

### da9e536 · An advance by city or customer

* **The shop's advance may be asked only to cities it names, and only of customers who refused
  parcels before** (CHK-10,
  [ADR-089](../architecture/13-decision-log.md#adr-089--a-shops-advance-may-be-asked-only-to-cities-it-names-and-of-customers-who-refused-parcels-before-checkout-names-every-city-and-says-of-whom-and-placing-applies-them-to-the-city-and-number-typed)),
  each a condition the orders it asks must meet, as its total is: cities as addresses name
  them, fifty at most; refusals counted as the rule that keeps cash on delivery from refusers
  counts them. Migration 0059 keeps them with the shop's rules for cash on delivery.
* **The page names every city and says of whom**, in English and Urdu, before anything is typed,
  so that a shopper knows whether it asks them; its summary takes the advance off what the door
  collects once the city typed is one of them. Placing applies it to the city and the number
  typed, counting the number's refusals only where the shop asks, never for the page.
* **`advanceOf` is `advanceAmountOf`, what the advance asks for, and `advanceTakes`, whether its
  cities and refusals take in an order, together**: the page says the first, and its summary
  and placing use both.
* The API's `CashOnDeliveryAdvance` has `cities` and `refusedDeliveries`, and its input takes
  them, checked.
* Tried on the demo shop in Chromium: with the delivery charge asked ahead in Quetta and Karachi,
  the option said so beside cash on delivery in both languages; an ajrak to Karachi was placed
  asking its Rs 250 delivery charge ahead, with the shop's account, and one to Lahore asked
  nothing. With Rs 300 asked of customers who refused a delivery before, the number behind
  #1007, which came back, was asked it, and a new number wasn't. The four orders were then
  cancelled and the advance taken away.

### 8a9c9e6 · What a return cost

* **A parcel keeps what couriers' statements charged for it, out and back** (COD-09,
  [ADR-088](../architecture/13-decision-log.md#adr-088--a-parcel-keeps-what-couriers-statements-charged-for-it-which-cod-health-adds-up-for-those-that-came-back-a-statement-with-the-lines-of-one-imported-before-is-refused)):
  each statement's charges are added to its parcels as it is imported, through the orders
  module's `chargeParcelsIn` in the import's transaction, but for a line with cash collected
  before, whose charges came with it. Each charge is a line on the order's timeline and a
  `fulfillment.updated` event, and the API has it as `Fulfillment.courierCharges`. Migration
  0058 adds the column and charges parcels what the statements imported before charged them.
* **COD health adds up what returns cost:** `returnCharges`, what statements charged for the
  parcels that came back, both ways, and `returnsCharged`, how many of them they have charged,
  for the shop and by city, product, source and courier. A product's parcels are read once each,
  as a parcel's lines can hold a product twice. The tax withheld is not a return's cost.
* **A statement is imported once:** one with the same lines as one imported before is refused,
  however it was saved, sorted, spaced or its columns named otherwise, known by a SHA-256 of its
  lines as read. The same lines with cash are refused whatever the reference; charges alone with
  references that differ are both taken, as a parcel can be charged alike out and back. A shop's
  imports run one at a time under a transaction's advisory lock, so the same statement imported
  twice at once is taken once.
* **Tests that imported a statement twice** to see its cash `repeated` now import it again saved
  another way, refused, and name the parcel in other statements.
* Tried on the demo shop through the API: a Leopards statement charging the parcel of #1022, in
  Karachi, Rs 220 out and Rs 220 back took Rs 440 onto it, with a line on its timeline; the same
  lines saved another way, without a reference, were refused, saying to give the reference if it
  was another statement; two PostEx statements of Rs 180 for #1007's parcel, with references of
  their own, both took. COD health then had returns costing Rs 800, Karachi's Rs 440 and
  Hyderabad's Rs 360.

### 1f9d7c1 · Limits on how fast checkout takes orders

* **Checkout takes at most three orders a day from one mobile number** (CHK-18,
  [ADR-087](../architecture/13-decision-log.md#adr-087--checkout-takes-at-most-three-orders-a-day-from-one-mobile-number-and-twenty-an-hour-from-one-internet-address-counting-the-orders-it-placed-one-at-a-time)), however it is written,
  and **twenty an hour from one internet address**, many more as a mobile network's phones share
  addresses. It counts the orders it placed for the shop, cancelled ones too, from the number and
  address orders keep; an address not known, or not one, counts by the number alone.
* **One at a time:** the count runs in the placement's transaction under advisory locks on the
  number, then the address, held to its end, so five orders placed at once from one number place
  three. Migration 0057 indexes orders by their address.
* **Past a limit, nothing is placed and the page says why**, in English and Urdu, answering 429:
  to order more, message the shop; or try again later. Orders staff, apps and drafts place aren't
  limited.
* **Tests that placed several orders from one number** now place them from several, as shoppers
  would.
* Tried on the demo shop in Chromium: three orders of an ajrak from one new number went through,
  and a fourth was refused with 429 and the page saying why; the three were then cancelled.
* 1018 tests pass through PgBouncer, as CI runs them.

### c19d8b0 · Trust badges on the checkout

* **The shop picks its checkout's trust badges from the platform's set** (CHK-14,
  [ADR-086](../architecture/13-decision-log.md#adr-086--a-shop-chooses-trust-badges-for-its-checkout-from-the-platforms-set-worded-in-english-and-urdu-and-shown-under-the-button-where-they-hold)): cash on delivery; open
  your parcel before you pay; an exchange or returns within its days; 100% original products;
  help on WhatsApp. Up to four, each once, in its order, through `checkoutTrustBadgesUpdate`;
  the platform words them in English and Urdu, and nothing the shop types reaches the page.
  Migration 0056 keeps them.
* **The page shows them under its button, each where it holds:** cash on delivery and opening the
  parcel where it offers cash on delivery for the cart, an exchange or returns linked to the
  refund policy where the shop has one, and help on WhatsApp as a link to a chat with its number,
  which the badge needs. A tick before each, the Urdu to the right as on the payment choices.
* The seed gives the demo shop cash on delivery, a 7-day exchange, original products and help on
  WhatsApp; it was tried on a database migrated from nothing, as CI seeds one.
* Tried on the demo shop, given the seed's WhatsApp number and a refund policy: its checkout in
  Chromium showed the four badges under the button, light and dark, the exchange linking to the
  refund policy and WhatsApp to `wa.me`, with no console errors but the sandbox's fonts.
* 1014 tests pass through PgBouncer, as CI runs them.

### 712f153 · Drafts asking for an advance

* **A draft asks for an advance as an order does** (CHK-10, [ADR-085](../architecture/13-decision-log.md#adr-085--a-draft-may-ask-for-an-advance-as-an-order-does-once-its-customer-confirms-it-the-drafts-link-shows-where-to-pay-and-takes-the-receipt)):
  `advanceDue` on `draftOrderCreate` and `draftOrderUpdate`, checked as an order's: on cash on
  delivery alone, not beside an advance paid, never above the total, the law's cap on what it
  leaves, and only from a shop with a bank account. Migration 0055 keeps it.
* **Its link's page says it before the customer confirms:** the advance by transfer and what the
  door collects in the summary, and above the button that they pay it to the account the next
  page shows, in English and Urdu.
* **Confirmed, or completed by staff, its order waits for the advance**, and the draft's link
  shows where to pay and takes the receipt, as the order's own link does: forms with a file are
  read on `/d/` too, and a draft not yet an order takes none.
* **The shop sees an advance's receipts:** orders' links counted them as none, and the Admin
  API's `transferReceipts` listed a transfer's alone; both show them now.
* Tried on the demo shop: draft #D5, a khussa with Rs 500 asked ahead, confirmed through its
  link in Chromium, became #1032 waiting for the advance, Rs 1,900 left for the door; a receipt
  sent on the same page showed in its `transferReceipts` and among the transfers to check.
* 1009 tests pass through PgBouncer, as CI runs them.

### b51dc63 · Checkout asking for an advance

* **The shop's rules for cash on delivery name an advance** (CHK-10, [ADR-084](../architecture/13-decision-log.md#adr-084--checkout-asks-for-the-advance-the-shops-rules-name-an-amount-a-share-of-the-items-or-the-delivery-charge-on-every-order-or-above-a-total-said-beside-cash-on-delivery)):
  an amount, never more than the items; a percentage of the items after any code, to the rupee;
  or the order's delivery charge, nothing where delivery is free. On every order, or only on
  those whose items come to more than a total of its own. `advance` on
  `cashOnDeliverySettingsUpdate` takes one of the three; migration 0054 keeps it.
* **It is paid into the shop's bank account**, which the shop gives first, offering bank transfer
  or not. Without the account, checkout asks for none, and the shop's other rules still change.
* **Checkout says it beside cash on delivery**, in English and Urdu: the amount, or "the
  delivery charge" until the city says what that is. Where cash on delivery is the only way, the
  summary takes it off what the door collects. A page shown before the advance changed shows
  itself again.
* **The order it places asks for it** (`advanceDue`) and waits for it without a call to confirm.
  The thank-you page says where to transfer it and what the door collects, then, once staff
  record it, that the shop will be in touch. An order paid by transfer asks for none.
* Tried on the demo shop, its delivery charges back to the seed's: with the delivery charge
  asked ahead, a lawn suit paid on delivery to Lahore became #1031, asking Rs 150 and leaving
  Rs 5,090 for the door, the page in Chromium saying so in English and Urdu. Asking 20% above
  Rs 3,000 left an ajrak alone and asked Rs 1,368 of a cart of Rs 6,840; the advance was then
  taken away.
* 1007 tests pass through PgBouncer, as CI runs them.

### badbdd8 · An advance on cash on delivery

* **A cash-on-delivery order can ask for an advance** (CHK-07, [ADR-083](../architecture/13-decision-log.md#adr-083--a-cash-on-delivery-order-may-ask-for-an-advance-paid-by-transfer-before-it-ships-it-waits-for-it-as-a-transfer-waits-for-its-money-and-staff-record-it-when-it-is-in)):
  `advanceDue` on `orderCreate`, paid by transfer into the shop's account, which the order keeps
  as a transfer's. Not beside an advance paid already, never above the total, and not from a shop
  without an account. The law's cap on cash at the door counts what the advance leaves.
* **It waits for the advance as a transfer waits for its money**, at `awaiting_payment`: no
  packing or shipping before, no call to confirm and no score, as paying is the customer's
  say-so; its customer may cancel through their link until they pay.
* **Its pages say what to pay ahead and what at the door:** the account with the advance as the
  amount to transfer, the rest the courier collects, and the summary's advance by transfer and
  payment on delivery; the receipt is taken as a transfer's, and the link's WhatsApp message
  asks for the advance.
* **Staff record money received by hand** with `orderCreateManualPayment`, as Shopify's
  records a manual payment: an amount, or what the order waits for, never more than it owes,
  with an idempotency key; the advance moves the order on to pack, and the rest marks it paid.
  Migration 0053 adds the advance.
* Tried on the demo shop: a khussa with Rs 250 asked ahead became #1030, its page in Chromium
  saying to transfer Rs 250 and pay Rs 2,250 at the door; recorded through the API, it moved
  to To pack, partially paid, and the same call without an idempotency key was refused.
* 997 tests pass through PgBouncer, as CI runs them.

### 0d15328 · The shop's Raast ID

* **Beside its IBAN, the shop's account takes its Raast ID** (PAY-02,
  [ADR-082](../architecture/13-decision-log.md#adr-082--a-shops-account-takes-its-raast-id-beside-its-iban-kept-with-each-order-as-the-account-is-and-shown-on-its-customers-pages-to-copy-a-raast-qr-waits-for-the-partners)): the mobile number its bank registered for
  Raast, which customers' banking apps pay to, typed in any format and kept in E.164. A new one
  is a new place for the money, audited as the account is. Migration 0052 adds it.
* **Orders keep it with the account their customers were told**, and the thank-you page and the
  order's page show it under the IBAN as people write numbers, "0300 1234567", selected whole
  with a tap to copy. Orders placed before have none.
* **No QR yet:** the page is read on the phone that pays, which can't scan its own screen, and a
  merchant's Raast QR carries the State Bank's payload, which comes with a partner (PAY-03).
* The seed gives the demo shop a Raast ID. Tried in Chromium: a lawn suit paid by transfer
  became #1029, its thank-you page showing the Raast ID under the IBAN.
* 993 tests pass through PgBouncer, as CI runs them.

### e15b235 · Transfers to check

* **The admin's home counts the transfers to check** (`transfersToCheck`): of the orders
  waiting for a transfer, those whose customers sent a receipt ([ADR-080](../architecture/13-decision-log.md#adr-080--a-customer-sends-the-receipt-of-their-transfer-through-their-orders-page-in-a-form-the-core-reads-and-keeps-in-storage-by-order-the-shop-sees-it-with-the-order)),
  each once however many it has, with what they come to; paid, an order leaves the count.
* **The order list finds them:** `orders(hasTransferReceipt: true)`, or `false` for those
  without, which exports take too.
* Tried on the demo shop: the home counted four orders awaiting payment, Rs 19,460.50, and one
  transfer to check, #1028's Rs 4,740, which the filter listed with its receipt.
* 992 tests pass through PgBouncer, as CI runs them.

### f23b893 · The shop's colour and logo on its customers' links' pages

* **Orders' and drafts' links' pages are in the shop's colour and show its logo**, as its
  checkout's page does ([ADR-069](../architecture/13-decision-log.md#adr-069--the-checkouts-page-takes-the-shops-accent-colour-from-its-published-theme-on-its-buttons-and-on-its-links-where-they-stay-readable),
  [ADR-081](../architecture/13-decision-log.md#adr-081--a-shops-logo-is-one-of-its-files-chosen-as-its-brands-the-checkouts-page-shows-it-in-place-of-the-shops-name-through-a-url-signed-for-an-hour-that-the-pages-policy-allows-alone)): a customer sees the same shop from its checkout to
  their order's page. They get both through `linkShopIn`, the logo's URL signed for an hour as
  the page is made, and the page's policy allows that image alone; without a logo, the shop's
  name.
* The link services take storage as the checkout's does; the seed, which shows no pages, gives
  them none.
* Tried on the demo shop in Chromium: #1028's link page showed the shop's logo in light and dark
  mode, loaded under its policy with no violations reported.
* 991 tests pass through PgBouncer, as CI runs them.

### 9b6d827 · The shop's logo on its checkout

* **A shop's logo is one of the files it uploaded** (CHK-14,
  [ADR-081](../architecture/13-decision-log.md#adr-081--a-shops-logo-is-one-of-its-files-chosen-as-its-brands-the-checkouts-page-shows-it-in-place-of-the-shops-name-through-a-url-signed-for-an-hour-that-the-pages-policy-allows-alone)): `shopBrandUpdate` makes an image, JPEG, PNG, WebP or
  GIF, its brand's logo, as Shopify's `shop.brand.logo` is one of its images, or takes it away;
  `Shop.brand` shows it, under the files' scopes. Deleting the file takes the logo with it. The
  files module keeps it and records `shop_brand.updated`; migration 0051 adds its table.
* **The checkout's page shows it in place of the shop's name**, as its thank-you page and its
  other pages do: at most 200 by 64 pixels, named by the shop's name, and on a white ground in
  dark mode, where a logo made for light pages would vanish. Its URL goes straight to storage,
  signed for an hour as the page is made.
* **The page's policy allows that image and no other**: pages name the images they show
  (`renderPage`'s `images`), each allowed at its address without the signature, over https or on
  localhost.
* Tried on the demo shop in Chromium: a PNG logo uploaded through `stagedUploadsCreate` and set
  with `shopBrandUpdate` headed its checkout's page in light and dark mode, loaded under the
  page's policy, which named that image alone, with no violations reported.
* 990 tests pass through PgBouncer, as CI runs them.

### fe0d9d6 · The receipt for a transfer

* **A customer sends the receipt of their transfer through their order's page** (PAY-02,
  [ADR-080](../architecture/13-decision-log.md#adr-080--a-customer-sends-the-receipt-of-their-transfer-through-their-orders-page-in-a-form-the-core-reads-and-keeps-in-storage-by-order-the-shop-sees-it-with-the-order)): while a bank-transfer order waits for its money, the
  page has a form under where to pay for a photo, a screenshot or the PDF of the receipt, and
  thanks them once it is in, saying how many they sent; five an order.
* **The page runs no scripts, so the form sends the file through the core**, which reads forms
  with a file on orders' pages alone (`/o/`), with busboy: one file of up to 10 MiB, in memory;
  past it, the rest is dropped and the page says the file is too large. A form with a file
  anywhere else is refused.
* **What the file is comes from its first bytes**, never from the browser: JPEG, PNG, WebP or
  PDF, and a page called a photo is refused, in both languages. Storage takes it before any
  transaction, under `shops/{shopId}/receipts/{orderId}/`, so none waits on storage; the order,
  locked, then takes it while it waits for the transfer, or it is removed. Telling files by their
  first bytes moved from the files module into `@hatti/storage`, which both use.
* **The shop sees them on the order:** `Order.transferReceipts`, oldest first, each through a
  URL signed for an hour and named for the order ("Receipt #1028-1.png"); the timeline says the
  customer sent one, and `order.updated` names it. Erasing the customer deletes their receipts'
  records. Migration 0050 adds the table.
* Tried on the demo shop in Chromium: #1028's page refused an HTML page named `.png`, saying so
  in both languages, then took a 129 KB screenshot and thanked the customer; the API's URL for
  it gave back the same bytes, named "Receipt #1028-1.png", and refused an altered signature.
* 985 tests pass through PgBouncer, as CI runs them.

### 3a486ad · Files the shop uploads

* **The platform keeps files now** ([ADR-079](../architecture/13-decision-log.md#adr-079--files-are-kept-in-object-storage-under-each-shops-prefix-uploaded-straight-there-through-urls-the-admin-api-signs-and-shown-only-through-short-lived-signed-urls-a-directory-stands-in-for-r2-in-development)):
  `@hatti/storage` keeps them by key, in R2 through the S3 API, its requests and URLs signed with
  Signature Version 4, written in the package and checked against AWS's own examples rather
  than taken from the AWS SDK; and in development and tests in a directory, which the API serves
  at `/storage` through URLs it signs itself. Production must use the bucket.
* **A shop uploads files as Shopify's apps do:** `stagedUploadsCreate` signs where each one goes,
  for its exact size and type, for an hour; the client puts the bytes straight there;
  `fileCreate` makes a file of each once it is in, of that size, and its first bytes say it is
  what it was staged as, or removes it. `files` lists them, each with a URL that shows it for an
  hour, and `fileDelete` removes them from storage too. JPEG, PNG, WebP, GIF and PDF, up to
  20 MiB, under Shopify's `read_files` and `write_files`, which owners, managers and marketers
  hold.
* Each shop's files are under its own prefix, `shops/{shopId}/files/`, and none is public.
  Uploads staged a day ago and never made files are swept as the shop stages more. Migration
  0049 adds the files module's table.
* Tried on the dev API: a PNG staged, put with curl to the URL given, and made a file, which its
  URL showed; the same URL refused a body of another size.
* 980 tests pass through PgBouncer, as CI runs them.

### 97cd3fb · Cash on delivery's rules for products

* **A shop can keep cash on delivery from products by their tags** (CHK-07,
  [ADR-078](../architecture/13-decision-log.md#adr-078--a-shop-keeps-cash-on-delivery-from-products-by-their-tags-a-cart-holding-one-is-offered-bank-transfer-alone-the-page-naming-the-product)):
  `unavailableProductTags`, with its rules for cash on delivery, up to 50, each once in any
  letter case, such as "pre-order" for what it can't sell again once refused at the door.
* **The page knows before the shopper types:** a cart holding a product with any of the tags,
  in any letter case, is offered bank transfer alone, the page naming the product; without
  transfer, there is nothing to fill in, and the page says to remove it or ask the shop. Checkout
  reads the products' tags with the cart's variants, and only when the shop names tags; the
  catalog knows nothing of the rule.
* Orders staff and apps place are the shop's own call, as for its other rules. Migration 0048
  adds the tags.
* Tried on the demo shop: with "Wedding" named, the Multani Khussa, tagged "wedding", went to a
  checkout offering transfer alone, Rs 113 off, and saying in both languages that cash on
  delivery isn't available for it. The rule was taken away again after.
* 961 tests pass through PgBouncer, as CI runs them.

### bbeb628 · Something off for paying by transfer

* **A shop can take something off orders paid by bank transfer, as its prepaid incentive**
  (CHK-08,
  [ADR-077](../architecture/13-decision-log.md#adr-077--something-off-for-paying-by-transfer-is-part-of-the-orders-discount-kept-apart-from-the-codes-off-the-items-after-any-code-to-the-rupee-said-where-the-shopper-chooses)):
  `discount`, with its bank account, through `bankTransferSettingsUpdate`: a percentage, up to a
  cap if it sets one, or an amount. A change is audited with the account, before and after.
* **Checkout takes it off the items after any code, to the rupee**, so that what the shopper
  transfers stays whole. Delivery is worked out before it, so paying by transfer never costs
  delivery, and a code's use counts the code's share alone.
* **The order keeps it in its discount, and apart as `transferDiscount`**, on transfers alone
  and within the discount, which a database check holds. Invoices, the thank-you page and the
  customer's link show the code's discount and it on lines of their own; exports have a column
  for it, and sales reports count it in discounts.
* **The page says it where the shopper chooses:** beside cash on delivery, the transfer's option
  says what it takes off this cart; alone, the summary takes it off. A page shown before it
  changed shows itself again. Migration 0047 adds it, and the seed takes 5%, up to Rs 500, off
  the demo shop's transfers.
* Tried on the demo shop: a lawn suit's checkout offered "Bank transfer, Rs 250 off" beside cash
  on delivery with its Rs 100 fee, and chosen, it became #1028, Rs 4,740 to transfer, its
  thank-you page and the API showing the Rs 250 apart; five suits, past the shop's Rs 20,000 for
  cash on delivery, were offered transfer alone, Rs 500 off in the summary. Taken to the paisa at
  first, as codes take theirs, 5% of the suit was Rs 249.50 and Rs 4,740.50 to transfer, which no
  one types into a banking app: it is now rounded to the rupee.
* 958 tests pass through PgBouncer, as CI runs them.

### e2e1a01 · Cash on delivery's fee

* **A shop can charge a fee for paying at the door** (CHK-08,
  [ADR-076](../architecture/13-decision-log.md#adr-076--a-shops-fee-for-cash-on-delivery-is-the-orders-own-amount-apart-from-delivery-in-its-total-and-the-cash-collected-said-beside-the-option-where-the-shopper-chooses)):
  `fee`, with its rules for cash on delivery, which checkout adds to orders paid on delivery and
  to none paid by transfer.
* **The order keeps it as an amount of its own, `codFee`**, apart from delivery: in its total,
  which a database check holds, and in the cash collected, which the law's cap counts. Invoices,
  the thank-you page and the customer's link show it on a line of its own, exports in a column,
  and sales reports as additional fees, in total sales.
* **The page says it where the shopper chooses:** beside transfer, in the cash-on-delivery
  option; alone, as a line of the summary, in what is paid at the door. A page shown before the
  fee changed shows itself again. Migration 0046 adds the fee.
* Tried on the demo shop: with a Rs 100 fee, the checkout's option said so beside transfer, and
  a lawn suit paid on delivery became #1026: Rs 4,990 and the fee, Rs 5,090 to pay at the door,
  as its thank-you page and the API said, and the day's sales report counted Rs 100 of
  additional fees.
* 952 tests pass through PgBouncer, as CI runs them.

### 4e0b7c0 · Cash on delivery's rules

* **A shop keeps cash on delivery at checkout to the orders it trusts** (CHK-07,
  [ADR-075](../architecture/13-decision-log.md#adr-075--a-shop-keeps-cash-on-delivery-to-the-orders-it-trusts-up-to-a-total-of-its-own-outside-cities-it-names-and-not-for-customers-who-refused-parcels-before-checkout-offers-transfer-instead)):
  `cashOnDeliverySettingsUpdate` sets a total above which it takes no cash on delivery, cities
  where it doesn't, and how many refused parcels a customer may have had before, as their
  delivery history counts them, by any of their numbers.
* **The page says what it can before the shopper types:** the total and the cities, with the
  cash-on-delivery option, and a cart whose items alone come to more is offered transfer alone,
  or, without it, nothing to fill in. **Placing checks the rest:** the total with delivery, the
  city typed, and the history of the customer with the number typed. Turned away, the page says
  why, keeping what the shopper typed, with transfer chosen for them where the shop takes it; a
  customer turned away for their refusals is not told so.
* **Orders staff and apps place are the shop's own call**, and keep to the law's cap alone.
  Migration 0045 adds the rules.
* Tried on the demo shop: with cash on delivery up to Rs 20,000 and not in Gilgit or Skardu, the
  checkout's option said so; a lawn suit to Gilgit paid on delivery was turned away, the page
  saying why in both languages with bank transfer chosen, and placed again it became #1025, to
  pay by transfer.
* 948 tests pass through PgBouncer, as CI runs them.

### fa4b309 · Bank transfer at checkout

* **A shop that gives its bank account offers bank transfer beside cash on delivery** (PAY-02,
  [ADR-074](../architecture/13-decision-log.md#adr-074--a-shop-that-gives-its-bank-account-offers-bank-transfer-the-order-waits-for-the-money-at-a-stage-of-its-own-and-keeps-the-account-its-customer-was-told-to-pay-into)):
  `bankTransferSettingsUpdate` keeps one account, its title, bank and Pakistani IBAN, spaced or
  not, its check digits checked, and what customers are told besides, such as where to send the
  receipt. A change is audited with the account before and after.
* **Checkout offers the choice**, on delivery unless the shopper picks transfer, and transfer
  alone for a cart above the Rs 200,000 that cash on delivery may collect, which it turned away
  before. The thank-you page shows the account, its IBAN in groups of four and selected whole
  with a tap, the amount, and the order's number to give as the reference.
* **A bank-transfer order is placed unpaid and waits at a stage of its own, `AWAITING_PAYMENT`**,
  until staff see the money and mark it paid: it needs no confirming, isn't scored for risk,
  collects nothing at the door, and can't be packed or shipped before. It keeps the account its
  customer was told to pay into. The admin's home counts those waiting, their packing slips say
  not to pack them, and their customer's link shows where to pay and lets them cancel until they
  do. Staff's orders and drafts may be paid by transfer too.
* Migration 0044 adds the account, the method, the stage and the order's account. The seed gives
  the demo shop an account, and one order waiting for its transfer.
* Tried on the demo shop: a lawn suit checked out in Chromium by bank transfer became #1023, its
  thank-you page showing the account, Rs 4,990 and #1023 as the reference, and a tap on the IBAN
  selecting it whole; its customer's link said it waited for the payment. Shipping it was
  refused until it was marked paid, which moved it to To pack, the link then saying it was
  confirmed.
* 940 tests pass through PgBouncer, as CI runs them.

### 0397dc0 · The Confirmation Desk's queue

* **Orders waiting for their customers to confirm them are dealt out to agents one at a time**
  (COD-04,
  [ADR-073](../architecture/13-decision-log.md#adr-073--the-confirmation-desk-deals-orders-waiting-for-their-customers-to-agents-one-at-a-time-the-most-urgent-due-first-and-keeps-the-calls-that-did-not-settle-them)),
  the most urgent due first: high value, as the shop's risk policy sets it, then those due
  longest, then the riskier. `confirmationQueue` lists those due now, with how many wait for
  later.
* **`confirmationQueueNext` deals an agent the first order no one else holds**, theirs for 15
  minutes, so that no two agents call the same customer; asked again, they get the one they
  have. Taking an order is the queue's, not the order's: no version, timeline entry or event.
* **`orderConfirmationCall` keeps a call that did not settle the order**, and lets it go: no
  answer, due again in two hours or when the agent says, three making the customer unreachable
  (`NO_RESPONSE`); asked to call back, due then, within a week; a wrong number, held for review.
  The agent's note stays with the call, off the timeline, and erasure clears it.
* Held orders stay on their own tab, to be decided rather than dealt out. Migration 0043 adds the
  calls, the queue's columns and its index.
* Tried on the demo shop: two of its apps' tokens each asked for the next order and got #1001
  and #1011, one each; #1001's customer did not answer, and it left the queue until later, its
  timeline saying so, while the queue showed #1011 held by the other.
* 929 tests pass through PgBouncer, as CI runs them.

### b60689b · Parcels the courier lost

* **A parcel the courier lost, on its way out or back, is written off** (COD-09,
  [ADR-072](../architecture/13-decision-log.md#adr-072--a-parcel-the-courier-lost-is-written-off-and-an-order-with-nothing-delivered-or-back-ends-at-a-stage-of-its-own-lost-before-reaching-the-customer-it-is-never-their-refusal)):
  `fulfillmentMarkLost` makes it `LOST`, with `lostAt`, nothing of it restocked, and the
  timeline says so. It takes no more news from its courier; if it turns up, it is checked back
  in as any, by its ID or tracking number, its items back on the shelf, and stays counted as
  lost.
* **An order with nothing delivered or brought back ends at a stage of its own, `LOST`**: done
  and closed, an unpaid cash-on-delivery order voided, a prepaid one left paid for the shop to
  settle. One lost parcel of several leaves the order to the others.
* **Lost before reaching the customer, it is never their refusal:** their delivery history counts
  it as `lost`, risk scores leave it out, and COD health counts it as `lost`, courier by courier,
  in neither rate. Refused first, it stays a refusal, though the courier lost it on its way back.
* **Its items count as returns in sales reports**, as a refused parcel's do; the customer's page
  says the courier lost the parcel and the shop will be in touch. Migration 0042 adds the state,
  the stage and `lost_at`.
* Tried on the demo shop: order #1014, sent with TCS, was marked lost: lost, closed and voided,
  its timeline saying two items were written off, and COD health counted it as TCS's loss. Then
  it turned up: scanned, it was checked back in, its items back in stock, and the order stayed
  lost.
* 926 tests pass through PgBouncer, as CI runs them.

### c729d6f · Returned parcels checked in by their tracking numbers

* **A parcel that comes back is checked in by the tracking number on its label**, as a scanner
  reads it (COD-09,
  [ADR-071](../architecture/13-decision-log.md#adr-071--a-parcel-coming-back-is-checked-in-by-the-tracking-number-on-its-label-matched-as-couriers-statements-are-those-on-their-way-back-are-listed-the-longest-first)):
  `fulfillmentReceiveReturn` takes `trackingNumber` in place of the parcel's ID, matched as
  couriers' statements are, spaces and letter case ignored. Everything is restocked unless
  `restock` says otherwise, as before.
* **It must name one parcel still out:** a number on two names both orders and checks neither
  in; one already checked in or delivered says so at the tracking number's box; and a parcel
  brought back before anyone marked it coming back is checked in all the same.
* **`returningParcels` lists the parcels on their way back, the longest on its way first**, with
  the days since each started back, its courier, tracking number, order and items, one
  courier's alone if asked: those a courier is slow to bring back, to chase. Migration 0041
  indexes them.
* **The orders list finds an order by its parcel's tracking number the same way**, typed with
  spaces or scanned without.
* Tried on the demo shop: order #1022, confirmed and sent with Leopards as "LE 5501 7788", then
  marked coming back, was listed among Leopards' parcels coming back; scanned as "le55017788",
  it was checked in, its item back in stock and the order returned and voided, and scanned
  again, it said it was already checked back in.
* 923 tests pass through PgBouncer, as CI runs them.

### eafa981 · Areas and landmarks in addresses

* **Checkout and customers' links ask for the area and the nearest landmark in boxes of their
  own** (CHK-02,
  [ADR-070](../architecture/13-decision-log.md#adr-070--an-address-keeps-its-area-in-its-second-line-and-its-landmark-in-a-field-of-its-own-checkout-and-customers-links-ask-for-each-suggesting-the-areas-of-the-larger-cities)),
  as couriers sort parcels by area and riders ask for landmarks; the landmark's box says what it
  is for, in both languages. Before, one box took either.
* **The area's box suggests well-known areas of the ten larger cities** (`PK_CITY_AREAS` and
  `areaSuggestions` in `@hatti/pk`): the city's once one is typed, or every listed city's, each
  by its city, before, since the page has no scripts. About 200 areas, under 2 KB compressed;
  any area may still be typed.
* **An order's address keeps the area as its second line**, where apps built for Shopify's
  addresses read it, **and the landmark in a field of its own**: `landmark` on the Admin API's
  `MailingAddress` and `MailingAddressInput`, and a line of `formatted`, after the area. Packing
  slips, invoices, exports (Area and Landmark columns), checkout's thank-you page and the
  customers' links show it; erasure clears it, and logs redact it.
* **Migration 0040** gives the addresses kept before no landmark, their second line as it was.
* Tried on the demo shop: checkout's form had the house and street, the area, and the nearest
  landmark with its hint, Karachi's areas among those suggested; order #1022, placed with
  Gulshan-e-Iqbal and "Near Nipa Chowrangi", showed each on a line of its own on its thank-you
  page and in the Admin API's `formatted`, and #1001, kept before, read with no landmark.
* 920 tests pass through PgBouncer, as CI runs them.

### dfb1583 · The checkout's page in the shop's colours

* **The checkout's page is in the shop's colour** (CHK-14,
  [ADR-069](../architecture/13-decision-log.md#adr-069--the-checkouts-page-takes-the-shops-accent-colour-from-its-published-theme-on-its-buttons-and-on-its-links-where-they-stay-readable)):
  the accent of its published theme, Hatti Base's "Buttons and links", in the theme's current
  settings or the preset they name, as its storefront pages have it. Its buttons take it, with
  white or dark text, whichever reads better, or black on the few mid tones where neither reads
  at 4.5 to 1; its links and focus rings take it where it reads on white, the platform's teal
  otherwise. The thank-you page, an expired checkout's and an empty cart's take it too.
* **What stays the platform's:** dark mode, a checkout not found, which has no shop to show, and
  the colours that say what happened, a mistake's red and an order placed's green.
* **`renderPage` takes an `accent`** for any page in a shop's name: a hex colour alone gets
  through, as a style element of its own that sets the page's variables, its hash added to the
  page's content security policy. The online store's `shopAccentOf(tx, …)` reads it from the
  main theme in the caller's transaction.
* Not yet: the shop's logo, which comes with images it uploads, and trust badges it chooses; the
  orders' links' pages keep the platform's colours.
* Tried on the demo shop: its theme's accent set to amber through `themeFilesUpsert`, the same
  checkout's page, reloaded, had amber buttons and links, its policy allowing both styles by
  their hashes; a light yellow, set by a preset, gave its button dark text and left the links
  teal; with the setting deleted, the page was the platform's again.
* 916 tests pass through PgBouncer, as CI runs them.

### a3a5aba · Customers cancel after confirming

* **A customer who changes their mind after confirming can still cancel**, through the order's
  link, until the order is packed, while nothing has been paid or shipped (05 §8,
  [ADR-068](../architecture/13-decision-log.md#adr-068--a-cash-on-delivery-customer-may-cancel-through-the-orders-link-until-it-is-packed-though-they-confirmed-it-unless-the-shop-keeps-that-to-before-confirming)):
  the confirmed order's page offers it below the order and asks first, as before confirming. The
  order stays confirmed, its stock goes back, and the timeline says the customer cancelled after
  confirming it.
* **The shop says how long**: `orderSettings` and `orderSettingsUpdate` keep its order settings,
  `UNTIL_PACKED` by default or `UNTIL_CONFIRMED` as before, for owners and managers
  (`write_settings`), audited, with an `order_settings.updated` event. Migration 0039 makes the
  table.
* Tried on the demo shop: order #1020, confirmed through its link, showed "Cancel this order"
  under its address; asked first, the customer cancelled it, and it stayed confirmed, cancelled
  for the customer, the timeline saying they cancelled after confirming it.
* 913 tests pass through PgBouncer, as CI runs them.

### a3201b6 · Couriers' remittance statements

* **A courier's remittance statement is imported as the CSV they send** (COD-10,
  [ADR-067](../architecture/13-decision-log.md#adr-067--couriers-remittance-statements-are-imported-whole-into-a-logistics-module-each-lines-cash-received-on-its-parcels-order-at-most-what-the-order-owes-and-a-parcels-cash-once)):
  `codRemittanceImport` finds its columns by the names couriers use ("CN #", "Tracking Number",
  "COD Amount", "Delivery Charges", "WHT", "Net Payable" and their like), reads amounts as they
  write them, passes over a totals row, and reports the rows it cannot read.
* **Each line's cash is received on its parcel's order**, matched by tracking number without
  spaces, in capitals: in full, short (the rest still owed) or over (no more than owed), as a
  payment with a line on the order's timeline. Lines that match no parcel, name a parcel paid
  for before, or an order that owes nothing, receive nothing and are kept to look into; no cash
  on a parcel sent back is the courier's charges. Charges and tax withheld are kept with each
  line.
* **A statement is taken whole, in one transaction**, its parcels' orders locked in turn, so
  that two statements naming a parcel at once pay it once; a statement's reference from the
  same courier is taken once, and a dry run writes nothing. Owners, managers and accountants
  import them, and apps with `write_orders`; `codRemittances` and `codRemittance` read them
  back, their lines a page at a time or only those to look into.
* **A logistics module** (`@hatti/logistics`) keeps them, as courier bookings will be: it
  reaches orders only through functions of the orders module that take its transaction.
  Migration 0038 makes its tables, and an index of parcels by their tracking numbers as couriers
  write them. The conventions' list of modules names `pricing` and `logistics` now.
* Tried on the demo shop with a Leopards statement: a dry run said order #1005's Rs 6,650 would
  be received and an unknown CN matched nothing, its totals row passed over, Rs 7,073.50 paid
  over after Rs 500 of charges and Rs 76.50 withheld. Imported, #1005 was paid and completed,
  and Leopards owed nothing more.
* 910 tests pass through PgBouncer, as CI runs them.

### 27898ba · What couriers owe

* **The cash couriers hold for the shop** (COD-10,
  [ADR-066](../architecture/13-decision-log.md#adr-066--what-couriers-owe-is-worked-out-from-the-orders-when-asked-delivered-cash-on-delivery-orders-not-yet-paid-by-courier-and-by-days-since-delivery)):
  `codReceivables` gives what delivered cash-on-delivery orders not yet paid still owe, by
  courier and by days since delivery, up to a week, a fortnight, a month and longer, with when
  the oldest was delivered; and what is still on its way.
* **A courier is as staff named it**, in any letter case, the spelling used most standing for
  the rest, as COD health groups them; parcels shipped with no courier named come last.
* **What is owed and what is on its way add up to the home's cash still to come**, which a test
  holds them to. Worked out from the orders when asked, over the stage index.
* Tried on the demo shop: order #1005's Rs 6,650 was on its way with Leopards, as the home
  said; once its parcel was marked delivered, Leopards owed Rs 6,650 for up to a week.
* 901 tests pass through PgBouncer, as CI runs them.

### 6e1945c · Cart permalinks

* **Shopify's cart permalinks work** (CH-07,
  [ADR-065](../architecture/13-decision-log.md#adr-065--a-cart-permalink-begins-a-cart-of-its-own-and-goes-to-its-checkout-leaving-the-shoppers-cart-as-it-is)):
  `/cart/{variant}:{quantity},…`, which shops send in chats and put in bios, begins a cart of
  those items, applies the link's `discount`, `note` and `attributes`, and goes straight to its
  checkout. The shopper's own cart stays as it was.
* **Items that cannot be had show the shopper's own cart, saying why**, as a refused cart form
  does. Links from other sites are followed, under the limit on cart changes; a HEAD request
  changes nothing.
* **Placing an order sets the cart count from the shopper's own cart**, rather than to 0, so an
  order from a permalink leaves the header counting what they had chosen.
* Tried on the demo shop: with a lawn suit and EID25 in the cart, a cross-site
  `/cart/{lawn suit}:2?discount=EID25&note=From+WhatsApp` went to a new checkout for Rs 7,485,
  Rs 9,980 less Rs 2,495, its note kept, and the cart still held its one suit. Order #1019,
  placed there, kept the note and EID25, and the count stayed at 1; #1019 was cancelled
  afterwards.
* 899 tests pass through PgBouncer, as CI runs them.

### cb63623 · Discount links and the cart

* **Shopify's discount links work** (CHK-06,
  [ADR-064](../architecture/13-decision-log.md#adr-064--discount-links-keep-their-code-with-the-shoppers-cart-one-begun-for-it-if-need-be-and-a-cart-says-of-a-code-only-whether-it-applies)):
  `/discount/CODE?redirect=/collections/eid` keeps the code with the shopper's cart, beginning
  one that holds only the code when they have none, and sends them on, to the home page without
  a `redirect`, in the link's language. Links come from Instagram and WhatsApp, so other sites'
  are taken; past the limit on cart changes, or with the core away, the shopper still goes on.
* **The cart says what its code takes off, as Shopify's does:** the Ajax cart takes `discount`,
  codes separated by commas, an empty one taking the code off; its JSON and Liquid's `cart` have
  `total_price` after the code, `total_discount`, a cart-level discount application and
  `discount_codes`. A code that does not apply is written as typed, with nothing else, whether
  or not the shop has it: checkout says why, and counts the codes tried there.
* **Hatti Base's cart page and drawer show it:** the subtotal, the code and what it takes off,
  and the total; free delivery by code; or a code that does not apply yet; in English and Urdu,
  the code keeping its own direction. The shop's free-delivery threshold is for the items after
  their discount, as at checkout.
* **Fixed: a form's `return_to` could send shoppers off the shop.** `/%09/elsewhere.example`
  passed its check, and a browser drops the tab and reads `//elsewhere.example`. Paths are read
  as a browser reads them now (`localPath`), links' `redirect` and `sections_url` too.
* **Fixed a flaky test:** a theme preview's token, its last letter changed, could still open,
  as that letter's low bits may be base64's padding, which decoders ignore: about one run in 16
  failed. The test changes a letter that always counts.
* Tried on the demo shop: a cross-site `/discount/eid25?redirect=/collections/all` began a cart
  with only the code and went on; `/cart.js` said `eid25` did not apply under its Rs 3,000
  minimum. With a Rs 4,990 lawn suit it took Rs 1,247.50 off as EID25, and the cart page, in
  both languages, and the checkout's page showed the same Rs 3,742.50.
* 898 tests pass through PgBouncer, as CI runs them.

### 8f00f2e · Discount codes at checkout

* **Shoppers apply discount codes at checkout** (CHK-06,
  [ADR-063](../architecture/13-decision-log.md#adr-063--a-shoppers-discount-code-is-kept-with-their-cart-and-counted-with-the-order-placed-with-it-in-the-orders-transaction)):
  the page takes a code in a form of its own, above the address, typed in any letter case; the
  cart keeps it, and the page shows what it takes off, in English and Urdu, or why it takes
  nothing: unknown, not yet started, ended, under its minimum or used up.
* **The order is placed with it as the page showed it:** the code off the items, then delivery,
  whose free threshold the discounted items must reach, as Shopify's free shipping does; a
  free-delivery code makes delivery free wherever it goes. Orders keep their codes, as
  Shopify's `discountCodes`, and the thank-you page and invoices show the discount.
* **Its use is counted with the order, in the same transaction:** the code locked and its uses
  counted under the limit, with a redemption of the order, its customer and what the code took
  off. A code used up since, or used before by a customer meant to use it once, undoes the
  order, and the page says why, keeping what was typed. Merging customers moves their uses.
* **A checkout's page takes ten codes that take nothing off, then no more**, so that codes
  cannot be guessed through the core's own page, which has no storefront rate limit.
* Migration 0037 gives carts and orders their codes, checkouts their attempts, and the pricing
  module its redemptions. Phone pages have a secondary button.
* Tried on the demo shop through its storefront: two lawn suits, Rs 9,980, took EID25 for
  Rs 2,495 off, and order #1018 was placed for Rs 7,485 with `discountCodes: ["EID25"]` and the
  code's usage at 1. The same number's next order was refused, the page saying so in both
  languages under the code, with the name still typed. That check found the Urdu label saying
  the code twice; it says only the word now. #1018 was cancelled afterwards.
* 893 tests pass through PgBouncer, as CI runs them.

### 65732e7 · Discount codes

* **Shops keep discount codes** (CHK-06,
  [ADR-062](../architecture/13-decision-log.md#adr-062--discount-codes-are-the-pricing-modules-a-percentage-or-an-amount-off-an-orders-items-or-free-delivery-matched-in-any-letter-case)),
  as Shopify's basic and free-shipping codes are: a percentage or an amount off an order's
  items, or free delivery, with a minimum the items must come to, the dates a code works
  between, a limit on the orders placed with it and one order a customer.
* **`@hatti/pricing`, a new module**, keeps them, as the architecture's Pricing & Promotions:
  `DiscountCodeService` makes, changes and deletes them with `discount_code.*` events, and
  `discountOf` alone works out what a code takes off an order, a percentage rounded half up to
  the paisa. Migration 0036 makes its schema.
* **Codes are matched in any letter case:** a shop cannot have both EID25 and eid25, though
  another shop may. They are letters, digits, hyphens and underscores, up to 64; 10,000 a shop.
* **The Admin API** has `discountCodes`, `discountCode`, `discountCodeByCode`,
  `discountCodeCreate`, `discountCodeUpdate` and `discountCodeDelete`, under Shopify's
  `read_discounts` and `write_discounts`, which owners, managers and marketers now have; each
  code says what it gives in a line: "25% off orders of Rs 3,000 or more; one use a customer".
* The conventions' list of scopes had stopped at segments; it names all thirteen now.
* Tried on the demo shop: EID25, 25% off orders of Rs 3,000 or more until the 8th, 200 uses
  and one a customer, came back ACTIVE with that line; eid25 was refused as taken, `Eid25`
  found it, and a token without the discount scopes was denied. It stays there for checkout's
  part.
* 883 tests pass through PgBouncer, as CI runs them.

### 64778f2 · Sales analytics

* **What a period's orders came to, in Shopify's terms** (ANL-02,
  [ADR-061](../architecture/13-decision-log.md#adr-061--sales-are-reported-in-shopifys-terms-from-the-orders-when-asked-an-order-counts-on-the-day-it-was-placed-cancelled-ones-aside-and-so-do-its-items-that-came-back)):
  `salesReport(placedFrom, placedBefore, interval, topProducts)` gives orders, gross sales,
  discounts, returns, net sales, shipping, total sales and average order value, for the period
  and every day, week from Monday or month of it in the shop's time zone, days without orders
  included, and the products that sold most, by what they came to.
* **An order counts on the day it was placed, and cancelled orders are left out.** Returns are
  the items in parcels that came back, at the prices sold, counted on their order's day rather
  than the day they came back, as Shopify would: a day's net sales then say what it really
  sold once its parcels have arrived somewhere.
* **The orders module works it out when asked**, and stores nothing: a year of 54,000 orders
  took 0.36 to 0.41 seconds, a month of them 73 to 104 ms.
* Tried on the demo shop, over its year: 13 orders, Rs 77,487 gross, Rs 5,650 of returns from
  its refused parcel, Rs 74,337 in total sales and Rs 5,960.54 an order, all on 29 September,
  as its orders table has them; the lawn suit its best seller.
* 869 tests pass through PgBouncer, as CI runs them.

### 8261757 · COD health

* **How a period's cash-on-delivery orders turned out** (COD-12,
  [ADR-060](../architecture/13-decision-log.md#adr-060--cod-health-follows-a-periods-cash-on-delivery-orders-worked-out-from-them-when-asked-its-rates-of-those-that-turned-out)):
  `codHealth(placedFrom, placedBefore, by)` follows the orders placed in a period, a year at
  most, through confirmation (confirmed, cancelled before anyone confirmed them, still waiting)
  and their parcels (delivered, returned, on their way), with the rates
  [06 §11](../architecture/06-orders-fulfillment-logistics.md#11-key-metrics-merchant-dashboard)
  names: confirmation, delivery success and RTO.
* **Rates are of those that turned out,** so a recent period does not look worse than it is
  while its orders wait; what waits is counted beside them. An order confirmed and then
  cancelled counts as confirmed.
* **By city, product, source or courier**, most orders first: cities typed in other letter
  cases as one, under the spelling most orders have; an order counted for each product in it;
  couriers as staff named them, for parcels alone.
* **The orders module works it out when asked**, from the orders and their parcels, in a
  statement for each side; nothing is stored. A year of 57,000 orders with 48,000 parcels took
  0.1 to 0.45 seconds, and a month of them 40 to 120 ms; an index on when orders were placed
  halved a month's times, and is left for when shops need it.
* Tried on the demo shop, over its year: 15 orders, 7 confirmed, 4 cancelled first and 4
  waiting, a confirmation rate of 0.64; three parcels, one delivered by TCS, one returned by
  PostEx and one with Leopards on its way; Sindhi Ajrak its most ordered product; and its one
  order from the online store, cancelled. A period of 21 months was refused.
* 865 tests pass through PgBouncer, as CI runs them.

### bf2b07c · Orders from checkout in the order list

* **An order placed through checkout took the order list down** for any caller that asked for
  orders' `source`: the API's `OrderSource` had no `ONLINE_STORE`, so the order's source could
  not be given, and `source`, which cannot be null, took the list with it. Found while working
  out COD health by source; the demo shop's order list came back as `null`.
* **`OrderSource` has every source an order can have:** `ONLINE_STORE`, and `POS`,
  `MARKETPLACE` and `RESELLER`, reserved. A draft still comes only from a chat, a call or an
  app, and says so.
* **A test checks every enum of the orders' API** against the values the database can hold, and
  checkout's test reads its order back through the Admin API: without the fix it failed with
  the error the demo shop had.
* Tried on the demo shop: its 17 orders listed with their sources, #1015 from the online store.
* 861 tests pass through PgBouncer, as CI runs them.

### 9bc78fd · The home's next actions

* **The admin's home says what waits for the shop** (ANL-01): `home` gives how many orders wait
  to be confirmed and to be reviewed, how many to pack and to book, and how many parcels are
  coming back, each with what they come to, and the cash on delivery still to come: on parcels
  on their way, on delivered orders not yet marked paid and on the rest of an advance, never on
  prepaid orders. It needs `read_orders`, which every staff role has.
* **The core composes it; the orders module counts.** `OrderService.home` works the tallies out
  in one statement over the stage index when asked, as the stage counts are, and stores
  nothing; other modules' figures, such as low stock, join `Home` in the core as they come.
* Tried on the demo shop: the home gave two orders to confirm, Rs 7,699; two to review,
  Rs 20,770; five to pack, Rs 24,739; one to book, Rs 10,230; none coming back; and Rs 6,650 to
  come on the parcel in transit, as the orders table has them, in a tenth of a second. Order
  #1017, placed through the API, made it three to confirm, Rs 9,549, and two again once
  cancelled; a token for menus alone was refused.
* 849 tests pass through PgBouncer, as CI runs them.

### 0219f4d · Redirects from a Shopify export

* **A shop moving from Shopify keeps the old addresses its store sent on**
  ([ADR-052](../architecture/13-decision-log.md#adr-052--a-shops-url-redirects-are-the-online-stores-and-the-storefront-follows-one-only-where-it-has-no-page),
  ONB-05): `urlRedirectsImport` takes Shopify's redirects export, Redirect from and Redirect to,
  each row checked as `urlRedirectCreate` checks one; rows that fail are said by row and column,
  a path repeated in the file or one the shop has is said or skipped, and the rest go in, in one
  transaction, with one `url_redirects.imported` event that has the publisher write the shop's
  redirects again. A dry run counts the same and changes nothing; at most 20,000 rows, a shop's
  limit.
* **`urlRedirectsExport` gives them back in the same columns**, by path, which this import or
  Shopify's takes back.
* Tried on the demo bazaar: a file of four Shopify redirects went in but for the one from the home
  page, which the dry run had said; the storefront sent `/products/old-kurta?utm_source=wa` on to
  the catalog with its query, and the Urdu address of an old sale to the shop's Instagram, at
  once; the export listed the three. They were deleted afterwards.
* 847 tests pass through PgBouncer, as CI runs them.

## 2026-09-30

### a2e9cf5 · Products from a Shopify export

* **A shop moving from Shopify brings its catalog in one file**
  ([ADR-059](../architecture/13-decision-log.md#adr-059--a-shopify-product-export-is-imported-product-by-product-as-productcreate-makes-them-keeping-their-handles-the-core-sets-the-stock)):
  `productsImport` takes Shopify's product CSV as Shopify writes it. Rows are grouped by handle;
  option values or a price make a row a variant, and Title / Default Title a product without
  options; Status, or Published, says whether it is on sale; Body (HTML) becomes the plain text
  the catalog keeps, paragraphs and list items kept; SKUs, barcodes, grams, compare-at prices,
  costs, tags and images by position come too.
* **Each product is made as `productCreate` makes it**, in a transaction of its own, then given
  its images: what the catalog would refuse is said by the row and column it came from, and the
  rest go in. `ProductService.checkCreate` makes the same checks for a dry run, which counts and
  writes nothing. Gift cards and images not at https addresses are left out, and said.
* **Handles are kept**, so every product keeps its address; a handle the shop has already is
  skipped, and the same file can be imported again.
* **The core sets the stock Shopify tracked** through the inventory module, on hand at the primary
  location, 250 variants a change, and keeps selling what Shopify sold when out of stock: the
  catalog cannot reach inventory, so it returns what to set. The mutation needs the products and
  inventory scopes.
* **Hatti Base's meta description keeps paragraphs apart:** `strip_html` joined the last word of
  one to the first of the next, which imported descriptions made common.
* Tried on the demo shop: a Shopify-shaped export of 300 kurtas in three sizes, with images and
  tracked stock, checked in a dry run in 0.1 seconds and made in 5.7, the storefront showing them
  with their prices, compare-at prices, sizes and descriptions; importing it again skipped all
  300. They were deleted afterwards.
* 845 tests pass through PgBouncer, as CI runs them.

### 8cfba3b · The cash-on-delivery cap

* **No order collects more cash on delivery than the law allows**
  ([ADR-058](../architecture/13-decision-log.md#adr-058--no-order-collects-more-cash-on-delivery-than-the-law-allows-whoever-places-it-the-rest-is-paid-in-advance-or-the-order-is-not-placed)),
  whoever places it (TAX-07): since Income Tax Circular 02 of 2025-26, Rs 200,000 an order.
  `placeIn`, which every order goes through, and saving a draft refuse a cash-on-delivery order
  whose cash at the door, its total less any advance, is more, with `COD_LIMIT` on its
  `advancePaid` and the advance that would do. That advance, or paying in full, places it.
* **Checkout says so before the shopper types:** a cart whose items alone come to more shows why,
  in English and Urdu, without the form, and asks the shopper to take items out or ask the shop
  about an advance; one that delivery takes past the cap is refused when placed, the page saying
  the same.
* **The cap is the law's**, `COD_CASH_LIMIT` in the orders module, for orders in rupees: it
  changes with the law, in a release with its tests, not as a setting.
* Tried on the demo shop at a phone's width: a Rs 250,000 lehnga's checkout gave the reason in
  both languages, with its total but no form and nothing to pay on delivery. Through the Admin
  API, `orderCreate` was refused with the Rs 50,000 advance it needed, and with that advance
  placed #1016, collecting Rs 200,000; the order was cancelled and the product deleted after.
* 837 tests pass through PgBouncer, as CI runs them.

### d647d95 · Tamper with a sealed secret's bytes in its test

* **`SecretBox`'s test of an altered ciphertext failed about once in 250 runs.** It changed the
  sealed text's last two characters, and when they were `BA`, the `BB` it wrote is the same
  bytes: base64 ignores the last bits of its last character. It now flips a bit of the
  authentication tag. Over 20,000 runs the old change went unnoticed 80 times, the new one never.
* 835 tests pass through PgBouncer, as CI runs them.

### cea2a6e · E-contract logs

* **What a shopper agrees to in placing an order is kept with it**
  ([ADR-057](../architecture/13-decision-log.md#adr-057--what-a-shopper-agrees-to-in-placing-an-order-is-kept-with-it-the-versions-of-the-shops-policies-its-checkout-linked-and-where-it-was-placed-from)),
  as Pakistan's Electronic Transactions Ordinance lets online contracts stand (TAX-06). Above its
  button, the checkout says that placing the order agrees to the shop's policies, each linked,
  but for its contact information, in English and Urdu.
* **Every body a policy is saved with is a version, kept as it was.** **Migration `0035`** adds
  `online_store.policy_versions`, which request code can neither change nor delete, and makes
  each policy kept so far its first version. A policy names its current one; one taken away
  leaves its versions.
* **The order agrees only to what its page linked:** the page's digest covers the versions, so a
  policy changed while the shopper was there shows the page again. The order keeps the versions,
  and the address and browser it was placed from, as Shopify's client details; storefronts pass
  their shopper's on with the form. Orders from staff and apps keep none.
* **`Order.agreement` shows it**: when, from where, and the policies as they were then, which the
  core joins from the online store, one query for a page of orders. The address and browser are
  shown only to those who see customers' numbers whole, and erasure clears them; the versions
  stay.
* Tried on the demo shop in Chromium at a phone's width: with its refund policy and terms saved
  from their drafts, the checkout said above its button that placing the order agrees to them,
  each linked. The order placed there, #1015, kept both, its address and Chromium's user agent,
  and still showed the refund policy as it was after the policy changed. The order was cancelled
  and the policies taken away afterwards.
* 835 tests pass through PgBouncer, as CI runs them.

### 950b8ae · Checkout links the shop's policies

* **The checkout's page links the shop's policies at its foot**, as Shopify's checkout does
  ([ADR-056](../architecture/13-decision-log.md#adr-056--a-shops-policies-are-kept-as-shopify-keeps-them-shown-in-shopifys-markup-and-drafted-from-what-the-shop-has-set-never-saved-by-themselves)),
  and so does its thank-you page: those the shop has, in Shopify's order, in English and Urdu as
  the rest of the page. The checkout module reads their kinds through the online store's
  `shopPolicyTypesOf(tx, …)`, without their bodies.
* **Each opens in a new tab.** Shopify shows a policy in a dialog over its checkout, but this page
  runs no scripts, and a shopper who left it could come back to an empty form.
* The online store's `POLICY_TITLES` give each title in English and Urdu, which the drafts and the
  checkout share.
* Tried on the demo shop in Chromium at a phone's width: with its refund, privacy and shipping
  policies saved, a checkout started from the cart listed them under "Back to cart"; the refund
  policy opened in a new tab, titled "Refund policy · Hatti Demo Bazaar", while the checkout kept
  the name typed in it.
* 830 tests pass through PgBouncer, as CI runs them.

### bb53d07 · Shop policies

* **A shop keeps its policies as Shopify keeps them**
  ([ADR-056](../architecture/13-decision-log.md#adr-056--a-shops-policies-are-kept-as-shopify-keeps-them-shown-in-shopifys-markup-and-drafted-from-what-the-shop-has-set-never-saved-by-themselves)):
  its refund, privacy, shipping and terms policies and its contact information, one of each.
  **Migration `0034`** adds `online_store.policies`. `shopPolicyUpdate` sets one, its HTML cleaned
  as pages' bodies are, and a blank body takes it away; `shop { shopPolicies }` lists them in
  Shopify's order, each with its address on the storefront. Both need the new
  `read_legal_policies` and `write_legal_policies` scopes, as Shopify's do; owners and managers
  have them. A change records `shop_policy.updated`.
* **Drafts from what the shop has set:** `shopPolicyDraft(type, locale)` writes one in English or
  Urdu from the shop's name and address, its WhatsApp number and its delivery charges and zones,
  for Pakistan's cash on delivery: 7 days to return, refunds by bank transfer, Easypaisa or
  JazzCash, couriers, the laws of Pakistan. It saves nothing: the shop reads it, changes it and
  saves it, and the API says it is not legal advice.
* **The storefront shows them at Shopify's addresses**, `/policies/refund-policy` and the rest,
  and `/ur/policies/…`, in Shopify's markup (`.shopify-policy__container`) inside the theme's
  layout, so a theme needs no template for them. Liquid's `shop.policies`, and
  `shop.refund_policy` and the rest, give their titles and addresses in the page's language, and
  Hatti Base's footer links them.
* **Their bodies are kept apart from the shop's document**, which lists the ones the shop has: a
  page fetches a policy's body only at its own address. The publisher writes them whole and
  purges the shop's pages when one differs. No shop had policies before, so documents without the
  list are right as they are.
* Tried on the demo shop with the worker: drafts of the refund and shipping policies in English
  and of the privacy policy in Urdu, saved through the Admin API as they came; the footer listed
  them, and Chromium followed it to `/policies/refund-policy`, titled "Refund policy · Hatti Demo
  Bazaar", with what can be returned, how, and the refunds and exchanges, and to
  `/ur/policies/privacy-policy`, right to left under the Urdu footer. Taken away, they answered
  404.
* 829 tests pass through PgBouncer, as CI runs them.

### 55e5e05 · robots.txt rules

* **A shop adds rules to its robots.txt**
  ([ADR-055](../architecture/13-decision-log.md#adr-055--a-shop-adds-rules-to-its-robotstxt-as-lines-crawlers-read-checked-when-saved-never-liquid)),
  as Shopify's `robots.txt.liquid` lets it, as lines rather than Liquid: `onlineStorePreferencesUpdate`
  takes `robotsTxtRules`, `User-agent`, `Allow`, `Disallow`, `Crawl-delay` and `Sitemap` lines,
  comments and blank lines, 200 at most. **Migration `0033`** keeps them with the preferences.
* **Each line is checked when saved**, as crawlers would read it (`robotsRules`): a directive they
  know, written in its usual case, with a value of its kind; lines that are not are said by their
  number, and nothing is saved.
* **The storefront serves them after the platform's rules**: those before any `User-agent` of
  the shop's own join the platform's `User-agent: *` group, its groups follow, and its sitemaps
  join the platform's at the end. A closed shop's robots.txt still shuts everything out.
* Tried on a seeded shop with the worker: rules typed in lowercase through the Admin API came
  back in their usual case, and a moment later its robots.txt kept crawlers off the sale
  collection beside the platform's rules, and GPTBot off the whole shop; cleared, the platform's
  rules stood alone.
* 819 tests pass through PgBouncer, as CI runs them.

### fccb44b · Storefront password

* **A shop can close its storefront behind a password until it opens**
  ([ADR-054](../architecture/13-decision-log.md#adr-054--a-shops-storefront-can-be-closed-behind-a-password-which-the-storefront-checks-against-a-verifier-in-the-shops-document)),
  as a new Shopify store is: `onlineStorePreferencesUpdate` takes `passwordEnabled`, `password`
  and `passwordMessage`, under the settings scopes. **Migration `0032`** adds them to
  `online_store.preferences`: the password sealed with the secret box, so staff can see it again,
  and a scrypt verifier (`passwordVerifier` in `@hatti/crypto`) for the storefront, which the
  shop's document carries with the message; never the password. A password is changed, never
  taken away, and closing needs one.
* **The storefront shows shoppers without the pass only the password page:** a `preHandler` hook
  sends pages to `/password` (`/ur/password` in Urdu) and tells scripts and sections 401, and
  robots.txt shuts crawlers out; theme assets stay open. `/password` renders the theme's
  `password` template, with Liquid's `shop.password_message` and the `storefront_password`
  form's `form.errors`, and takes the password, ten tries a minute from an address; the right one
  leaves a pass in the `storefront_digest` cookie for a month, bound to the shop and the
  verifier, so a new password asks everyone again.
* **Nothing of a closed shop is kept at the edge**, even for shoppers with the pass: every answer
  is `private, no-store` and `noindex`. Staff see the shop, and the password page, through a
  preview. The stores fetch the shop's document once a request, so the gate costs no round trip.
* **Hatti Base has a password page**: `templates/password.json`, `layout/password.liquid` and
  `sections/main-password.liquid`, in English and Urdu.
* Tried on a seeded shop in Chromium at a phone's width: closed through the Admin API, a product
  asked for sent the shopper to the password page with the shop's message; a wrong password was
  said, the right one let them in to the product; another shopper, in Urdu, got the page right to
  left. Opened again, the shop's pages were kept at the edge once more.
* 815 tests pass through PgBouncer, as CI runs them.

### a93c014 · Redirects when handles change

* **A handle change asks for its redirect, as Shopify's does**
  ([ADR-053](../architecture/13-decision-log.md#adr-053--a-handle-change-asks-for-its-redirect-as-shopifys-redirectnewhandle-does-and-the-redirect-leads-to-where-the-page-is-now)):
  `productUpdate`, `collectionUpdate` and `pageUpdate` take `redirectNewHandle`, false unless
  given, and with it the old address sends shoppers to the new one. It needs only the change's
  own scope.
* **A page's redirect is written with the change**; a product's or collection's by the worker,
  since the catalog knows nothing of the online store: `product.updated` and `collection.updated`
  now name the old handle (`previousHandle`) and whether the change asked, and `HandleRedirects`
  writes the redirect to the handle the product or collection has when it runs. Events handled
  late or out of order still send every old address to the current one.
* **One redirect written moves the others** (`redirectMoved`): those that sent shoppers to the
  old address, with a query or a fragment or without, send them to the new one, so none goes the
  long way round; one from the new address goes, since the page is there now; and a page back at
  an old address frees it.
* Tried on a seeded shop with the worker: a product renamed with `redirectNewHandle` sent its old
  address, and its Urdu one with a campaign's query, to the new one a moment later; renamed back,
  the old address showed the product again and the other sent shoppers to it.
* 808 tests pass through PgBouncer, as CI runs them.

### 38da6c2 · URL redirects

* **Shops keep redirects from addresses they have no page at**
  ([ADR-052](../architecture/13-decision-log.md#adr-052--a-shops-url-redirects-are-the-online-stores-and-the-storefront-follows-one-only-where-it-has-no-page)),
  such as their old store's `/products/old-lawn`, through an Admin API that follows Shopify's:
  `urlRedirects` (searchable by path or target), `urlRedirect`, `urlRedirectCreate`,
  `urlRedirectUpdate` and `urlRedirectDelete`, under the navigation scopes. **Migration `0031`**
  adds `online_store.url_redirects`, one redirect a path, 20,000 a shop at most, and each change
  records `url_redirect.created`, `.updated` or `.deleted`.
* **A path is kept as the storefront compares addresses**: pasted whole or typed, it loses its
  query, fragment, trailing slash and `/ur`, and is decoded and lowercased, so one redirect sends
  both languages' pages. A target is a path on the shop, with a query if it likes, or an http(s)
  address; the home page, a target back to its own path, and control characters or halves of
  characters, which Postgres or a header would refuse, are refused as typed.
* **The storefront follows one only where it would answer 404**: `sendPage` looks the path up
  after `prepare` finds nothing there, one round trip, and answers 301, in the shopper's language
  when the target is on the shop and with the query they came with when the target has none,
  but for a preview's token, which stays on the shop. A page is never hidden by a redirect; a
  preview follows them, uncached, and the theme editor's frame shows the 404 page, to change it.
* **The publisher writes a shop's redirects to Valkey** as a hash of targets by path, on any
  redirect event, from all of the shop's, sending only what differs, 500 at a time
  (`ShopWriter.putRedirects`). 404 pages and redirects carry their path's tag (`pathTag`, a
  hash), which it purges for the paths that changed, or the shop's past 25. Documents are
  version 7, so each shop is published whole once more.
* Tried on the seeded shop with the worker: redirects created through the Admin API, one pasted
  as a whole Shopify address, reached Valkey at once; in Chromium,
  `/products/Old-Lawn?utm_source=…` landed on `/collections/all?utm_source=…`, and
  `/ur/products/old-lawn` on the collection in Urdu, right to left; a redirect deleted answered
  404 again.
* 802 tests pass through PgBouncer, as CI runs them.

### 0df9b46 · SEO basics

* **Every page says where it is** ([ADR-051](../architecture/13-decision-log.md#adr-051--search-engines-and-link-previews-are-told-each-pages-address-at-the-shops-own-in-each-language-and-find-pages-through-sitemaps-of-the-storefronts-documents)):
  Liquid's `shop.url` is the shop's primary domain, else its handle's subdomain, with the
  platform's scheme and port, and `canonical_url` is the page there, in its language, keeping only
  its page past the first. Hatti Base links it as canonical, and the storefront puts the page's
  address in each of the theme's languages beside it, `x-default` English, for pages that are
  found and are not previews.
* **Link previews and search engines get what they read**: Hatti Base's tags give the page's
  address, type, description and image at the shop's address, as WhatsApp's previews need; and
  product pages carry schema.org's `Product`, with an `Offer` for each variant in rupees and
  whether it can be bought, through Shopify's `structured_data` filter.
* **`/sitemap.xml` and `robots.txt`**: the index names sitemaps of the shop's products,
  collections and pages, 5,000 addresses to a file, each with its Urdu address, the home page
  first among the pages; they come from the handles of the documents the storefront shows
  (`StoreData.handles`, one round trip). robots.txt keeps crawlers from carts, checkouts,
  searches, the editor's routes, previews, other sort orders and sections alone. Both are kept at
  the edge for an hour.
* **Liquid's `json` is safe in a script**: `<`, `>` and `&` go out as JSON's escapes, so a variant
  named `</script>…` no longer ends the product page's script.
* Tried on the seeded shop: robots.txt, and a sitemap index and sitemaps that parse as XML, with
  the home page and four pages and each address's Urdu one; a product page whose canonical,
  alternate and preview addresses agree, and whose structured data parses, in rupees.
* 787 tests pass through PgBouncer, as CI runs them.

### 3c59d8f · The theme editor's protocol

* **A preview the theme editor frames is in design mode**
  ([ADR-050](../architecture/13-decision-log.md#adr-050--the-theme-editor-talks-to-its-preview-through-postmessage-a-framed-preview-is-in-design-mode-and-renders-sections-with-the-editors-unsaved-files)):
  with the editor's origins set (`STOREFRONT_EDITOR_ORIGINS`), a preview the browser says is
  framed renders with Liquid's `request.design_mode` true, each section's wrapper naming its ID,
  type and the file and key its settings are under, and each block's `shopify_attributes` its ID
  and type, as on Shopify. Only the editor may frame previews, and there the preview's cookie is
  the frame's own, `Partitioned`, so links followed in the frame stay in the preview and in design
  mode.
* **The page's script and the editor talk through `postMessage`**
  (`apps/storefront/src/editor.ts`): the editor says hello on each load and learns the page's
  path, locale and template and its sections and blocks; it chooses a section or block, which the
  page scrolls to; the merchant's taps choose too, and tell the editor; and the editor renders
  sections again with theme files it has not saved, through `POST /editor/sections`, which lays
  them over the preview as saved and says what the storefront cannot use.
* **Themes hear Shopify's theme editor events**, `shopify:section:load`, `unload`, `select` and
  `deselect` and `shopify:block:select` and `deselect`, and see `Shopify.designMode`. Hatti Base
  marks its blocks, its cart drawer opens while chosen, and the drawer lets go of the page's
  listeners when rendered again.
* Tried in Chromium with a stand-in editor on `editor.localhost` framing the seeded shop's winter
  theme: it heard the page's eight sections, chose the banner's heading, changed it without
  saving and saw it rendered again, still chosen, heard a tap on the announcement, opened and
  closed the cart drawer by choosing it, and followed a product link in the frame, still the
  winter theme in design mode; a bad file was said, and the saved heading stood.
* 783 tests pass through PgBouncer, as CI runs them.

### 38ee951 · Theme previews

* **Any theme can be seen on the storefront before it is published**
  ([ADR-049](../architecture/13-decision-log.md#adr-049--a-theme-is-previewed-through-a-link-the-core-seals-which-storefronts-keep-in-a-cookie-and-render-from-the-cores-files-never-kept)):
  the Admin API's `OnlineStoreTheme.previewUrl` is the shop's storefront with `?preview=` and a
  token that names the theme and when the link ends, 14 days on, sealed with the core's secret
  box and bound to the shop, so nothing is stored. A theme being prepared for Eid can be looked
  at, or sent to someone for a second opinion.
* **The storefront keeps the link in a cookie** and shows every page, section, search and cart
  page after it in that theme, until the link ends or the bar at the foot of the page, in the
  page's language, ends it. It hands the token back to the core for the theme's files as saved
  at that moment (`GET /storefront/shops/{shop}/theme-preview`), so a saved change shows on the
  next page without waiting for the worker, and lays them over the platform theme once per
  version, beside main themes. A link of another shop's, one that has ended, or one whose theme
  is gone shows the main theme, and its cookie goes.
* **Previewed answers are the shopper's own**: `private, no-store`, `noindex`, without cache tags,
  and not sent on to the shop's primary domain. Any answer that sets a cookie is now kept by no
  one, whatever its handler said.
* Tried on the seeded shop: a copy of its theme with a winter announcement and banner, opened
  from its link in Chromium at phone width, showed on the home page, on a product page reached
  through the page's links, and in Urdu, each with its bar, while another browser saw the Eid
  theme; **Stop previewing** brought the Eid theme back and left no cookie.
* 781 tests pass through PgBouncer, as CI runs them.

### 0eb1da0 · Custom domains

* **Shops connect domains of their own** (ONB-07,
  [ADR-048](../architecture/13-decision-log.md#adr-048--a-shops-own-domains-are-the-online-stores-one-shops-each-served-once-dns-points-them-at-the-platform-the-primary-one-where-pages-send-shoppers)):
  `domainCreate` takes a domain as it is typed or pasted, `https://WWW.Zari.pk/` say, and keeps
  it as DNS has it, `www.zari.pk`, with internationalised names in their `xn--` form. A domain is
  one shop's across the platform, and never the platform's own, its subdomains or the DNS
  target; a shop connects ten at most. `read_domains` and `write_domains` are owners' and
  managers', as the online store is.
* **A domain is checked by asking DNS, when the shop asks.** It is pointed at the platform with a
  CNAME record naming `shops.{storefront domain}` (`STOREFRONT_DNS_TARGET` names another), or,
  at an apex, one its DNS provider flattens. `domainVerify` asks DNS outside the transaction: a
  CNAME naming the target, or addresses all among the target's, verify it; otherwise
  `NOT_POINTED` says what DNS answered and what to add, and `UNAVAILABLE` that DNS could not be
  asked.
* **One domain is primary**, once verified: making another primary makes the first stop being.
  The Admin API's `shop.url` names it, and the storefront sends a page asked for at the shop's
  other addresses to the same path there, with a 301, before it renders: the renderer now
  prepares a page, its shop, theme and resource fetched, apart from rendering it. Forms, cart
  changes and checkouts answer where they are asked, so a shopper's cart stays on the host it
  began on.
* **The directory maps verified domains to their shop**, in `s:sf:domains` beside handles:
  `domain.*` events rebuild the shop's document, which names its verified domains and its
  primary one, and the publisher adds and takes away the directory's entries as they change.
  `DOCUMENTS_VERSION` is now 6.
* Tried with the seeded shop and `bazaar.localtest.me`, which public DNS resolves to 127.0.0.1,
  the API's DNS target being `localtest.me`: refused as primary before it was checked, then
  verified by its addresses, and served by the storefront 16 ms later; made primary, after which
  the shop's subdomain sent its pages there. In Chromium, a link to the subdomain landed on the
  domain, where a product went into the drawer and a cash-on-delivery order, #1014, was placed.
  Let go, the domain answered 404 and the subdomain served its pages again.
* 777 tests pass through PgBouncer, as CI runs them.

### 2aae4c2 · Storefront pages kept at the edge

* **Pages go out as the edge is to keep them**
  ([ADR-047](../architecture/13-decision-log.md#adr-047--the-edge-keeps-storefront-pages-by-the-handles-they-name-before-they-stream-and-forgets-those-whose-documents-change)):
  five minutes, then shown while fetched again for a day and for a week while the storefront
  cannot answer; search results and suggestions a minute; theme assets a year. The cart,
  checkout and anything rendered with a shopper's cart stay `private, no-store`, and refusals
  and errors `no-store`.
* **Pages carry cache tags**: their shop's, and the handles of the products, collections and
  pages they name, known before the head is written: the route's, found or not, and those the
  theme's, sections' and blocks' settings choose. The home page names the collections it
  features, a product page the one it recommends from.
* **The publisher purges what changed, and only that.** It compares each document it writes with
  the one in Valkey: a sale that leaves a product for sale purges nothing; one that sells it out
  purges its page and the listings that show its card; a new handle, the pages at both; a new
  setting, theme or menu, the whole shop. It purges after writing and outside the transaction,
  and an edge that cannot be reached leaves the documents written.
* **The edge is Cloudflare**, purged by tag thirty at a time when the worker has
  `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_API_TOKEN`; without them, as in development, nothing is.
  The edge itself comes with the infrastructure.
* 764 tests pass through PgBouncer, as CI runs them.

### 4260a24 · The cart drawer

* **Hatti Base's cart opens in a drawer** (CHK-22) when a product is added, without leaving the
  page, and when the header's cart is chosen. Quantities change and lines go in the drawer, and
  its **Check out** button saves them and goes on to checkout, as the cart page's does. It is a
  modal `<dialog>` from the side the page reads from, the left in Urdu, and Escape or its
  backdrop closes it. A new setting, "When a product is added to the cart", sends shoppers to the
  cart page instead; without scripts they go there anyway.
* **Shopify's section rendering API**, which the drawer fills itself through: pages come the same
  for every shopper, with the drawer empty, so its script asks for the drawer's section,
  rendered with the shopper's cart. Any page answers `?section_id=` with one of its sections and
  `?sections=` with up to five as JSON; the Ajax cart's answers carry the `sections` a change asks
  for, rendered as part of `sections_url` or the page that asked. They are never kept.
* The cart's lines and totals moved into snippets, `cart-item` and `cart-totals`, which the cart
  page and the drawer share, and their styles into `base.css`, as a section's styles come only
  with a page that has it.
* Tried in Chromium on the seeded shop: added from a product page, changed to three, the header's
  count following; opened from the header on another page; emptied; and checked out from the
  drawer, in English and in Urdu.
* 759 tests pass through PgBouncer, as CI runs them.

### 99a0cb9 · Predictive search

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
