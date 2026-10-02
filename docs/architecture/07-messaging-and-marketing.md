# 07 · Messaging, Notifications & Marketing

> **Status:** Draft v0.1 · **Last updated:** 2026-09-27
> In Pakistan, **WhatsApp is the storefront's second screen**. Customers confirm orders, ask
> questions, track parcels and discover products there. SMS is the dependable fallback. Email
> matters less, except for diaspora and B2B. This module turns those channels into a
> reliable, cost-controlled system.

---

## 1. Notification pipeline

```mermaid
flowchart LR
    EV["Domain events<br/>order.created, shipment.status_changed, ..."] --> NR["Notification rules<br/>(per shop, per event)"]
    NR --> TR["Template renderer<br/>(locale: en / ur / roman-ur, variables)"]
    TR --> RT["Channel router<br/>consent · preferences · quiet hours ·<br/>cost · channel health"]
    RT --> WA["WhatsApp Cloud API adapter"]
    RT --> SMS["SMS adapters<br/>(primary + secondary aggregator)"]
    RT --> EM["Email adapter (SES)"]
    RT --> PU["Push: web push, FCM/APNs"]
    RT --> IVR["IVR adapter"]
    WA --> ST[("messages<br/>status: queued → sent → delivered → read / failed")]
    SMS --> ST
    EM --> ST
    ST --> FB{"Delivered in time?"}
    FB -- "no" --> RT
    WAIN["Inbound webhooks<br/>(button replies, text, status)"] --> INB["Inbound handler"]
    INB --> ACT["Actions: confirm / cancel / reschedule"]
    INB --> BOX["Unified inbox"]
```

**Router decisions, in order:**

1. **Is this message allowed?** Transactional messages go out on the legitimate-interest basis
   of the order. Marketing messages require an explicit opt-in per channel.
2. **Quiet hours.** No marketing between 21:00 and 10:00 and no calls between 22:00 and 09:00
   (shop timezone). Transactional OTPs are exempt.
3. **Channel preference and health.** Use WhatsApp unless it is failing for this shopper or
   degraded nationally (for example during a regional block), then fall back to SMS.
4. **Cost.** Use the cheapest channel that achieves the purpose, following the shop's messaging
   cost policy (see §2.3): the free service-message allowance first, then utility templates or
   SMS, with marketing templates only for opted-in campaigns.
5. **Fallback timers.** For example, send SMS if the WhatsApp message is not *delivered* within
   15 min.

---

## 2. WhatsApp

### 2.1 Account model

| Model | For | How |
|---|---|---|
| **Merchant's own WhatsApp Business Account** (recommended) | Brands that want their own name and number | Hatti acts as a Meta **Tech Provider** using **Embedded Signup**: the merchant connects or creates a WABA in a few clicks inside the Hatti admin. Messages come from the merchant's verified business name. |
| **Shared Hatti notifications number** | New and small shops before they set up their own WABA | Transactional utility templates only ("Your order from *Ayesha's Closet* …"), no marketing. |

**Coexistence matters for small merchants.** Meta allows a business to keep using the free
**WhatsApp Business app** on its phone while the same number is connected to the Cloud API (outside
a few excluded countries; Pakistan is not excluded). The shop owner keeps chatting from their phone
as today, while Hatti sends automated confirmations and updates from the same, familiar number.
Onboarding offers this by default.

### 2.2 Template library

Hatti ships a pre-written, policy-compliant **template library** in English, Urdu and Roman Urdu. It
is auto-submitted for approval to each connected WABA:

| Event | Category | Buttons |
|---|---|---|
| Order confirmation request | Utility | Confirm · Cancel · Change address |
| Order confirmed / packed | Utility | Track order |
| Shipped with tracking | Utility | Track · Contact us |
| Out for delivery (keep cash ready) | Utility | Reschedule |
| Delivery attempt failed | Utility | Deliver tomorrow · Change address · Cancel |
| Delivered + review request | Utility / Marketing* | Rate your order |
| OTP for checkout / login | Authentication | Copy code |
| Abandoned cart | Marketing | Complete order |
| Back in stock / price drop | Marketing | Shop now |
| Broadcasts (sales, new drops) | Marketing | Custom |

\* Meta decides the category based on content. The library is written to keep order-related
messages in the cheaper utility category.

### 2.3 Throughput, billing and cost control

* **Queues per sending number**, with rate limiters sized to the number's current Meta messaging
  tier. Broadcasts are paced and can be paused.
* **Pricing model (as researched):** Meta has charged **per message** since July 2025, by
  category (marketing, utility, authentication) and destination country, **billed in USD**. At
  current Pakistan rates a marketing message is roughly 3× a utility message; a utility message is
  about PKR 4. From **1 October 2026**, Meta also charges for free-form and utility replies
  *inside* the 24-hour customer-service window beyond a monthly free allowance per number.
  Conversations started from click-to-WhatsApp ads keep a longer free window. Rates and rules
  change often, so the router reads them from configuration. Sources and verification status are
  in [Research · Local Ecosystem](../research/03-local-ecosystem.md).
* **Billing in PKR:** most small merchants cannot pay Meta in USD, so Hatti offers **prepaid
  message credits in PKR**, bought through a Business Solution Provider at first (flat-licence
  providers avoid per-message markups) and later extended directly as an approved partner.
  Merchants who can pay Meta directly keep their own payment method.
* **Messaging cost policy per shop:** *Rich* (WhatsApp for all updates) or *Economy* (WhatsApp
  only for interactive steps such as confirmation and failed-delivery rescue; SMS for
  informational updates like "shipped"). With per-message pricing, SMS can be cheaper for one-way
  updates, while WhatsApp wins where buttons and replies matter.
* **Pre-send estimates:** "This broadcast to 4,200 opted-in customers will cost about Rs X" before
  sending.
* **Channel risk:** WhatsApp has been restricted in parts of Pakistan at times. The router tracks
  delivery rates per network and region and switches to SMS automatically.

---

## 3. SMS, IVR, email, push

| Channel | Design |
|---|---|
| **SMS** | Two aggregators behind one adapter interface (primary + failover), health-checked by delivery-report rates. Branded sender IDs need operator pre-registration (about two weeks), so shops start on a shared sender and upgrade later. Two-way SMS is limited, so actions use **short links** (tap to confirm, track, reschedule) rather than reply keywords. Unicode (Urdu) SMS is costed per segment; Roman Urdu is the default because it fits more text per segment. |
| **IVR** | Pre-recorded Urdu prompts with text-to-speech for variables (amount, store name). DTMF result ("1 = confirm") posts back via webhook. Used selectively (see [06 §3](./06-orders-fulfillment-logistics.md)). |
| **Email** | Amazon SES (or equivalent) with per-shop sending domains (SPF/DKIM/DMARC wizard) or the platform domain with the shop's reply-to. MJML templates, bilingual. |
| **Web push** | Storefront PWA opt-in (Android Chrome), used for back-in-stock and order updates when the shopper opted in. |
| **Merchant push** | New order, needs-review order, low stock, COD remittance received, daily summary. |

---

## 4. Unified inbox (Growth phase)

* **Channels:** WhatsApp, Instagram DMs, Facebook Messenger, website chat widget.
* **Order context panel:** the customer's orders, delivery status, risk tier and lifetime value,
  shown next to the conversation.
* **Actions from chat:** create a draft order, send a product card, payment link or COD
  confirmation link, update an address, start a return.
* **Assignment** and SLAs, saved replies (Urdu and English), and **AI suggested replies** grounded in
  order data and store policies (see [09](./09-ai-and-intelligence.md)).
* **AI auto-replies** outside business hours for FAQs and order status ("Mera order kahan hai?"),
  with a clean hand-off to a human.

---

## 5. Marketing engine

### 5.1 Segments

Segments are defined by a filter language over customers, orders and behaviour. Examples:
`city in (Lahore, Islamabad) AND orders_count >= 2 AND last_order_at > -90d`,
`cod_refusals >= 1`, `viewed_product_in_collection('eid-edit', 7d) AND NOT purchased`. Segments are
evaluated on demand for campaigns and incrementally for automations.

**Built so far** ([ADR-024](./13-decision-log.md#adr-024--segments-are-queries-evaluated-on-demand-over-fields-modules-contribute)):
saved segments and previews over customer fields (tags, when added, blocked) and order fields
(orders, amount spent, first and last order, delivered, returned and cancelled orders, city and
province), in a language close to Shopify's: `number_of_orders >= 2 AND city IN (Lahore,
Islamabad) AND last_order_date > -90d`. Consent and behaviour fields come with those features.

### 5.2 Automations (flow builder)

```mermaid
flowchart LR
    T["Trigger<br/>checkout.abandoned"] --> W1["Wait 45 min"]
    W1 --> C1{"Order placed since?"}
    C1 -- "yes" --> X["Exit"]
    C1 -- "no" --> A1["WhatsApp: cart reminder<br/>(marketing opt-in required)"]
    A1 --> W2["Wait 20 h"]
    W2 --> C2{"Still no order?"}
    C2 -- "yes" --> A2["WhatsApp: reminder + Rs 150 prepaid discount"]
    C2 -- "no" --> X
```

| Built-in recipe | Trigger | Notes |
|---|---|---|
| Abandoned checkout | `checkout.abandoned` | Phone captured at the first step; respects opt-in |
| Welcome series | `customer.subscribed` | Brand story, bestsellers |
| Post-delivery review request | `shipment.delivered` + 2 days | Photo reviews via WhatsApp |
| COD → prepaid nudge | `order.created` (COD) | Pay now for store credit; improves cash flow |
| Win-back | No order in N days | Segment-based offer |
| Back in stock / price drop | Inventory or price change on a watched item | Web push or WhatsApp |
| Replenishment | Days since purchase of consumables | Skincare, grocery |
| Birthday / anniversary | Customer date fields | Optional |

The engine runs on durable, delayed jobs (BullMQ) keyed by `(automation_id, customer_id,
trigger_event_id)`, so duplicate triggers never double-send.

### 5.3 Loyalty, referrals, affiliates, reviews

* **Loyalty:** points per rupee, tiers, redemption at checkout, points expiry; ledger-based for
  auditability.
* **Referrals:** "Give Rs 300, get Rs 300" with fraud checks (same phone/device/address).
* **Affiliates and influencers:** unique codes and links, commission rules (per delivered order,
  not per placed order), a payout report. Influencer selling is a major channel in Pakistan.
* **Reviews:** photo and video reviews, WhatsApp review requests, moderation, star ratings in
  structured data, a "verified buyer" badge.

---

## 6. Ads measurement: pixels and conversion APIs

Pakistani DTC brands depend on Meta and TikTok ads. Client-side pixels are increasingly lossy
(ad blockers, iOS, flaky networks), and **COD fake orders poison ad optimisation**: the algorithm
learns to find people who place orders but never accept them.

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant H as Hatti (server)
    participant META as Meta CAPI / TikTok Events API / Google

    B->>H: Purchase (order #1043) with event_id E1
    B-->>META: Pixel "Purchase" (event_id E1), if loaded
    H->>META: Server "Purchase" (event_id E1, hashed phone/email, fbp/fbc, value)
    Note over META: Deduplicated on event_id
    H->>META: Later: custom "OrderConfirmed" and "OrderDelivered" events (delivered value)
    Note over H,META: Merchants can optimise campaigns on delivered orders, not placed orders
```

* Built in and free on paid plans. On Shopify this typically costs a separate app.
* PII is normalised and SHA-256 hashed per each platform's spec. Events are sent only when the
  shopper's consent state allows it.
* **Delivered-value optimisation:** custom events for confirmed and delivered orders let ad
  platforms optimise toward real buyers. This is one of the most valuable features for COD
  merchants.

---

## 7. Catalog feeds & social channels

| Channel | Mechanism | Phase | Availability notes (verify at build time) |
|---|---|---|---|
| Meta (Facebook/Instagram) catalog | Catalog API sync + scheduled feed for catalogue/dynamic ads | V1 | On-platform checkout is not available in Pakistan; Instagram product tagging availability uncertain. Ads to the Hatti store are the core use |
| TikTok catalog | Catalog API / feed for catalogue ads | Growth | TikTok is Pakistan's largest social platform by adult reach, but TikTok Shop had not launched there at research time |
| Google Merchant Center | Merchant API / feed for free listings and Shopping ads | V1 | Confirm free-listing eligibility for Pakistan |
| WhatsApp catalog | Catalog linked to the merchant's WABA; chat-to-order | Growth | In-chat payments are not available in Pakistan; orders complete via COD or a payment link |
| Daraz | Product, inventory and order sync via the Daraz Open Platform seller API (app key, seller OAuth, signed requests) | Growth | Marketplace commission rules apply on Daraz orders |

Feeds are generated from the storefront product documents (see [03 §8](./03-multi-tenancy-and-data.md))
with per-channel **feed rules**: title templates, category mapping, excluded products, and Urdu or
English variants.

---

## 8. Attribution

* Captured at session start: UTM parameters, click IDs (`fbclid`, `ttclid`, `gclid`), referrer,
  landing page, affiliate or influencer code.
* Stored on the order (`attribution` JSONB) and in ClickHouse for first-touch and last-touch
  reports.
* **ROAS on delivered revenue:** combines daily ad spend (pulled from ad platform APIs) with
  delivered and reconciled revenue, so merchants see real profit instead of vanity revenue.

*Built so far*
([ADR-139](./13-decision-log.md#adr-139--a-shoppers-browser-keeps-the-visits-that-brought-them-the-first-and-the-last-from-elsewhere-checkout-passes-them-on-and-the-order-keeps-them-as-shopifys-customer-journey)):
storefront pages are the same for every shopper and kept at the edge, so a small script in each
page's head keeps the visits that brought the shopper in a first-party cookie of the shop's: the
first, and the last from elsewhere (an ad's click ID, UTM tags, or another site linking), each
with when it began, its landing page and the site that linked to it, for 30 days. The storefront
passes them when checkout starts, a cart permalink's own with them, and a discount link carries
its campaign on to its page. The checkout keeps them, checked, and the order placed copies them,
with where each came from (its `utm_source`, the platform of its ad or of the site linking, that
site's domain, or `direct`) and its UTM parameters; the Admin API gives them as Shopify's
`Order.customerJourneySummary`. An erasure clears their pages and keeps where they came from.
The sales report and COD health break orders down by the source and the campaign of their last
visit from elsewhere: what each sold, and how its orders were confirmed and delivered
([ADR-140](./13-decision-log.md#adr-140--sales-and-cod-health-are-broken-down-by-where-orders-came-from-the-source-and-the-campaign-of-each-orders-last-visit-from-elsewhere-orders-without-one-together)). Not yet: ClickHouse, reports by first visit, medium
or ad, every visit rather than the first and last, the consent banner the cookie should wait for
where the law asks, and ad spend.
