# 02 · Feature Catalog

> **Status:** Draft v0.1 · **Last updated:** 2026-09-27
> The master list of what Hatti does: everything Shopify does that matters in Pakistan, plus
> what Pakistan needs, plus what goes beyond Shopify. Each feature has an ID for use in the roadmap,
> tickets and specs.

**Type**

* **PARITY**: Shopify offers it, natively or through a common app. We must match it.
* **LOCAL**: required by how Pakistan buys, ships, pays or complies.
* **BEYOND**: better than what Shopify offers (in Pakistan or anywhere).

**Phase** (see [Roadmap](./04-roadmap.md); month 0 = October 2026): **MVP** (months 0–5, closed
beta from March 2027) · **V1** (6–9, public launch ≈ July 2027) · **GROWTH** (10–15) · **SCALE** (16–24).

"(app on Shopify)" marks features Shopify merchants usually buy as a separate app; Hatti includes
them.

---

## Summary

<!-- SUMMARY:START -->
268 features across 24 domains. Counts are generated from the tables below; run `python3 scripts/update_feature_summary.py` after editing.

| Type \ Phase | MVP | V1 | GROWTH | SCALE | Total |
|---|---|---|---|---|---|
| **PARITY** | 42 | 44 | 41 | 14 | **141** |
| **LOCAL** | 23 | 14 | 10 | 0 | **47** |
| **BEYOND** | 15 | 38 | 20 | 7 | **80** |
| **Total** | **80** | **96** | **71** | **21** | **268** |
<!-- SUMMARY:END -->

### Built-in features that replace paid Shopify apps

App prices are indicative 2024–25 listings and were not verified this session (see
[Shopify benchmark](../research/02-shopify-benchmark.md)).

| Need | Typical Shopify app cost (USD/month) | Hatti feature(s) |
|---|---|---|
| COD order form & COD fee | $10–30 | CHK-07, CHK-08 |
| OTP / WhatsApp order verification | $5–30 + message fees | CHK-09, COD-01…COD-05 |
| WhatsApp notifications & chat | $0–50 + message fees | MSG-01…MSG-04, OS-10 |
| Courier booking, labels, tracking | $0–20 | SHP-01…SHP-08 |
| Product reviews | $0–15 | MKT-05 |
| Upsell / cross-sell | $5–30 | MKT-09, CHK-13 |
| Page builder | $0–29 | OS-02 |
| Size charts | $5–15 | CAT-10 |
| Wishlist | $0–20 | OS-12 |
| SEO & image optimisation | $0–35 | OS-09, CAT-02 |
| Pixels & server-side conversion APIs | often paid | MKT-10 |
| Profit analytics | often paid | ANL-03 |
| Loyalty & referrals | $0–49 | MKT-06, MKT-07 |
| **Typical total for a DTC store** | **≈ $100–$150+/month** | **Included in Growth (Rs 6,999/month)** |

---

## 1. Onboarding & store setup (ONB)

| ID | Feature | Notes | Type | Phase |
|---|---|---|---|---|
| ONB-01 | Sign up with phone OTP, email or Google | Phone-first; WhatsApp OTP with SMS fallback | PARITY | MVP |
| ONB-02 | Guided setup checklist (English/Urdu) | Add product → delivery rates → connect courier → payments → go live | PARITY | MVP |
| ONB-03 | AI store builder | Describe the business or paste an Instagram handle → theme, colours, homepage, pages | BEYOND | V1 |
| ONB-04 | Instagram import | Posts → draft products; AI extracts price, sizes and variants from captions | BEYOND | V1 |
| ONB-05 | Shopify migration | CSV import (MVP); API importer for products, collections, customers, orders, codes, pages, blogs, **redirects** (V1) | BEYOND | MVP |
| ONB-06 | WooCommerce, Daraz and CSV/Excel importers | Urdu-safe UTF-8 templates | PARITY | V1 |
| ONB-07 | Free subdomain + custom domains | `name.hatti.pk`; CNAME/apex connect; automatic TLS | PARITY | MVP |
| ONB-08 | Buy a domain in-app | `.com` via registrar partner; `.pk` assisted | PARITY | GROWTH |
| ONB-09 | Policy generator | Returns, privacy, shipping, T&Cs in English and Urdu; "not legal advice" | PARITY | MVP |
| ONB-10 | Pakistan defaults | PKR, Asia/Karachi, grams, tax-inclusive prices, WhatsApp number, city list | LOCAL | MVP |
| ONB-11 | Business verification tiers & badges | T0 phone/email → T1 CNIC (via KYC partner) → T2 NTN/business; "Verified" badge | BEYOND | V1 |
| ONB-12 | Tax profile & registration assistant | NTN/STRN, filer status, province; guidance and partner referrals to register | LOCAL | V1 |
| ONB-13 | Vertical starter kits | Fashion (stitched/unstitched), jewellery, beauty, electronics, bakery/grocery | LOCAL | V1 |
| ONB-14 | Pre-launch waitlist | Collect WhatsApp/phone sign-ups on the password page; notify at launch | PARITY | V1 |

## 2. Catalog (CAT)

| ID | Feature | Notes | Type | Phase |
|---|---|---|---|---|
| CAT-01 | Products & variants | 3 options; 250 variants/product at MVP, 2,000+ later | PARITY | MVP |
| CAT-02 | Media | Phone-gallery bulk upload, auto AVIF/WebP, crop, video, alt text | PARITY | MVP |
| CAT-03 | Collections | Manual and rule-based | PARITY | MVP |
| CAT-04 | Types, vendors, tags | | PARITY | MVP |
| CAT-05 | Bulk editor & CSV/Excel import-export | Spreadsheet-style grid (V1); CSV (MVP) | PARITY | V1 |
| CAT-06 | Metafields & metaobjects | Custom fields and content types | PARITY | V1 |
| CAT-07 | Bilingual product content | English/Urdu fields; AI draft translation with review | LOCAL | V1 |
| CAT-08 | Eastern-wear attributes | Stitched/unstitched, 2-pc/3-pc, fabric (lawn, khaddar, chiffon…), season; filterable | LOCAL | V1 |
| CAT-09 | Stitching service add-on | Unstitched → stitched upsell with measurement form and tailoring lead time | BEYOND | GROWTH |
| CAT-10 | Size charts | Per product/collection; unit toggle (app on Shopify) | PARITY | V1 |
| CAT-11 | Bundles & multipacks | Fixed and mix-and-match | PARITY | V1 |
| CAT-12 | Gift cards & store credit | Digital gift cards; store credit for refunds and returns | PARITY | V1 |
| CAT-13 | Digital products | Downloads, licence keys | PARITY | GROWTH |
| CAT-14 | Pre-orders & back-orders | Prepaid or partial-advance rules; ship-by dates | PARITY | V1 |
| CAT-15 | Personalisation fields | Text (e.g. embroidery name), file upload, dropdowns | PARITY | GROWTH |
| CAT-16 | Subscriptions / selling plans | Wallet token debit or card | PARITY | SCALE |
| CAT-17 | Scheduled publishing & price changes | For drops and sales ("go live at 00:00") | BEYOND | V1 |
| CAT-18 | Product taxonomy & feed attributes | Standard categories, GTIN, brand, condition | PARITY | V1 |
| CAT-19 | FBR invoice fields | HS code, unit of measure, tax category/SRO | LOCAL | GROWTH |
| CAT-20 | AI product copy | Titles, descriptions, SEO, alt text in English/Urdu/Roman Urdu | BEYOND | V1 |
| CAT-21 | AI image tools | Background removal, auto-crop (V1); lifestyle backgrounds (GROWTH) | BEYOND | V1 |
| CAT-22 | Barcodes & product labels | Generate and print | PARITY | GROWTH |
| CAT-23 | Combined listings | One listing across colour products (Plus-only on Shopify) | PARITY | GROWTH |

## 3. Inventory (INV)

| ID | Feature | Notes | Type | Phase |
|---|---|---|---|---|
| INV-01 | Stock tracking & low-stock alerts | Push and WhatsApp alerts | PARITY | MVP |
| INV-02 | Multi-location inventory | Warehouses and shops | PARITY | V1 |
| INV-03 | Inventory states & adjustment ledger | On hand, committed, reserved, safety stock; reasons | PARITY | MVP |
| INV-04 | Transfers | Between locations | PARITY | GROWTH |
| INV-05 | Purchase orders & suppliers | Receiving with barcode scan | PARITY | GROWTH |
| INV-06 | RTO restock | Scan returned parcel → restock or mark damaged | BEYOND | MVP |
| INV-07 | Stock counts | Cycle counts via phone scanner | PARITY | GROWTH |
| INV-08 | Demand forecast & reorder suggestions | Hijri-calendar-aware seasonality (Ramadan, Eid) | BEYOND | SCALE |
| INV-09 | Drop Mode inventory protection | Token pools, per-customer limits, no oversell | BEYOND | GROWTH |
| INV-10 | Order routing rules | Which location fulfils which order | PARITY | GROWTH |

## 4. Online store & themes (OS)

| ID | Feature | Notes | Type | Phase |
|---|---|---|---|---|
| OS-01 | Free themes for low-end Android | Hatti Base + 2 verticals (MVP); 6 themes (V1) | PARITY | MVP |
| OS-02 | Visual editor | Sections and blocks, drag and drop, works on a phone, undo/redo | PARITY | MVP |
| OS-03 | Theme versions & scheduled publish | Rollback; publish the Eid or lawn-launch look at an exact time | BEYOND | V1 |
| OS-04 | Code editor, Theme CLI & Theme Check | Code editor (V1); CLI and linter (GROWTH) | PARITY | V1 |
| OS-05 | Shopify-compatible Liquid | Objects, filters and tags for theme portability | BEYOND | V1 |
| OS-06 | Urdu RTL storefront & language switcher | Bilingual content, `hreflang`, Nastaliq display font | LOCAL | MVP |
| OS-07 | Pages, blog, menus, announcement bar | Blog in V1 | PARITY | MVP |
| OS-08 | Forms & pop-ups | Contact, custom forms, WhatsApp/phone opt-in, spin-to-win (app on Shopify) | PARITY | V1 |
| OS-09 | SEO toolkit | Meta, canonicals, JSON-LD, sitemaps, redirects manager, robots editor | PARITY | MVP |
| OS-10 | WhatsApp button & chat widget | Pre-filled with product/variant context | LOCAL | MVP |
| OS-11 | Trust elements | Verified badge, city-based delivery estimate, COD availability, return summary | BEYOND | V1 |
| OS-12 | Wishlist & recently viewed | (app on Shopify) | PARITY | V1 |
| OS-13 | Store speed score | Real-user Core Web Vitals with actionable fixes | BEYOND | V1 |
| OS-14 | Installable PWA storefront | Offline page, web push | BEYOND | GROWTH |
| OS-15 | Password protection, maintenance mode, age gate | Age gate in GROWTH | PARITY | MVP |
| OS-16 | Cookie/tracking consent | For diaspora and EU visitors | PARITY | GROWTH |
| OS-17 | Drop Mode | Waiting room, countdown, scheduled publish, bot defences | BEYOND | GROWTH |
| OS-18 | Store locator & pickup points | For retailers | PARITY | GROWTH |
| OS-19 | Headless | Storefront API + Next.js starter kit | PARITY | SCALE |
| OS-20 | Theme marketplace | Paid themes in PKR by local designers | PARITY | GROWTH |
| OS-21 | Diaspora storefronts | Multi-currency display (AED, SAR, GBP, USD, CAD), international domains | PARITY | SCALE |
| OS-22 | A/B testing | Sections, offers, prices (with guardrails) | BEYOND | SCALE |
| OS-23 | Agent-ready storefront | Feeds, JSON-LD, store MCP endpoint, UCP profile | BEYOND | GROWTH |

## 5. Search & discovery (SRC)

| ID | Feature | Notes | Type | Phase |
|---|---|---|---|---|
| SRC-01 | Instant search | Typo tolerant; predictive suggestions | PARITY | MVP |
| SRC-02 | Roman Urdu & Urdu search | Phonetic folding, script normalisation, commerce lexicon | BEYOND | V1 |
| SRC-03 | Filters & facets | Size, colour, fabric, price, availability | PARITY | V1 |
| SRC-04 | Merchandising & synonyms | Pin, hide, boost per query | PARITY | GROWTH |
| SRC-05 | Recommendations | Related, frequently bought together | PARITY | V1 |
| SRC-06 | Search analytics | Top queries, zero-result queries | PARITY | GROWTH |
| SRC-07 | Visual search | Photo → similar products | BEYOND | SCALE |

## 6. Cart & checkout (CHK)

| ID | Feature | Notes | Type | Phase |
|---|---|---|---|---|
| CHK-01 | One-page, phone-first checkout | Guest by default, < 8 fields | PARITY | MVP |
| CHK-02 | Pakistani address capture | City picker with aliases, area, landmark, optional map pin; quality prompts (V1) | LOCAL | MVP |
| CHK-03 | Returning-shopper OTP autofill | Saved addresses by phone | BEYOND | V1 |
| CHK-04 | Delivery options | City-group zones, flat, free threshold (MVP); weight/price, local delivery, pickup (V1) | PARITY | MVP |
| CHK-05 | Delivery ETA by city | Courier lead times and holidays | BEYOND | V1 |
| CHK-06 | Discounts | Codes, %/fixed, free shipping (MVP); automatic, BXGY, tiered, bundles, combinations (V1) | PARITY | MVP |
| CHK-07 | COD with rules | Merchant limits, geography, product, customer; platform legal cap | LOCAL | MVP |
| CHK-08 | COD fee & prepaid incentive | e.g. Rs 100 COD fee; Rs 150 off when paying online | LOCAL | MVP |
| CHK-09 | Checkout OTP verification | WhatsApp → SMS; rule-based (MVP), risk-based (V1) | LOCAL | MVP |
| CHK-10 | Partial advance | Delivery charge or a % upfront via wallet or Raast | BEYOND | V1 |
| CHK-11 | Duplicate-order detection | Same phone + overlapping basket → merge prompt | BEYOND | V1 |
| CHK-12 | Abandoned checkout recovery | Phone captured at the first step; WhatsApp/SMS flows | PARITY | V1 |
| CHK-13 | Post-purchase COD upsell | One tap, pay on delivery, before packing | BEYOND | V1 |
| CHK-14 | Checkout branding & custom fields | Logo, colours, trust badges (MVP); custom fields (V1) | PARITY | MVP |
| CHK-15 | Delivery date & time slots | Bakery, grocery, flowers, gifting | PARITY | GROWTH |
| CHK-16 | Order notes & gift options | Gift wrap, message | PARITY | V1 |
| CHK-17 | Tax-inclusive pricing | Tax lines on receipts and invoices | LOCAL | MVP |
| CHK-18 | Fake-order & bot protection | Velocity limits, Turnstile, blocklists | BEYOND | MVP |
| CHK-19 | Works without JavaScript | Progressive enhancement for bad networks | BEYOND | MVP |
| CHK-20 | Checkout extensibility | Wasm Functions (discount/delivery/payment rules), UI extensions | PARITY | SCALE |
| CHK-21 | Express checkout for returning shoppers | One-tap with verified phone and saved address | BEYOND | GROWTH |
| CHK-22 | Cart drawer & cart notes | Delivery estimate in cart | PARITY | MVP |

## 7. Payments (PAY)

| ID | Feature | Notes | Type | Phase |
|---|---|---|---|---|
| PAY-01 | Merchant-owned gateways | Safepay + JazzCash (MVP); Easypaisa, PayFast, one bank gateway (V1) | LOCAL | MVP |
| PAY-02 | Manual methods | Bank transfer (IBAN + reference + proof upload), merchant Raast QR | LOCAL | MVP |
| PAY-03 | Raast-first prepaid | Request-to-pay and dynamic QR via partner | BEYOND | GROWTH |
| PAY-04 | Payment links | Single/multi-use, for WhatsApp and Instagram sales | PARITY | MVP |
| PAY-05 | Payment method rules | Availability, ordering, fees and discounts per method | BEYOND | MVP |
| PAY-06 | Refunds | API where supported; manual refund with proof otherwise | PARITY | MVP |
| PAY-07 | Settlement reconciliation | Provider settlements vs orders; fees and withholding itemised | BEYOND | V1 |
| PAY-08 | Payment-proof parsing | AI reads transfer screenshots; merchant confirms | BEYOND | GROWTH |
| PAY-09 | COD-to-digital at the door | Pay-now link or QR when the parcel is out for delivery | BEYOND | GROWTH |
| PAY-10 | Hatti Payments (partner-powered) | Instant sub-merchant onboarding; settlement to the merchant's IBAN | BEYOND | GROWTH |
| PAY-11 | BNPL & instalments | Via partners | PARITY | SCALE |
| PAY-12 | International cards | Diaspora shoppers; multi-currency presentment | PARITY | SCALE |
| PAY-13 | Store credit, gift cards, loyalty at checkout | | PARITY | V1 |
| PAY-14 | Saved wallets and cards | Tokenised one-tap repeat payments | PARITY | SCALE |

## 8. Orders (OMS) (ORD)

| ID | Feature | Notes | Type | Phase |
|---|---|---|---|---|
| ORD-01 | Order list & saved views | Stages, filters; search by phone, name, order or tracking number | PARITY | MVP |
| ORD-02 | Order timeline | Every event: messages, calls, courier scans, payments, edits | PARITY | MVP |
| ORD-03 | Draft/manual orders | From DMs; send a payment or COD-confirmation link | PARITY | MVP |
| ORD-04 | Order editing, split & merge | Items, address, shipping | PARITY | V1 |
| ORD-05 | Bulk actions | Confirm, cancel, tag, print, book, mark packed | PARITY | MVP |
| ORD-06 | Invoices & packing slips | Bilingual; A4 and thermal; bulk print | PARITY | MVP |
| ORD-07 | Returns & exchanges (merchant-initiated) | Exchange-first for sizes | PARITY | V1 |
| ORD-08 | Self-serve return portal | Reverse pickup where the courier supports it | PARITY | GROWTH |
| ORD-09 | Refund flows | Store credit, wallet, bank, original method | PARITY | MVP |
| ORD-10 | Tags, notes, assignment | | PARITY | MVP |
| ORD-11 | Exports | CSV/Excel; scheduled exports | PARITY | MVP |
| ORD-12 | Order risk panel | Score and reasons | BEYOND | V1 |
| ORD-13 | Order attribution | Source, UTM, ad click IDs, influencer code | PARITY | V1 |

## 9. COD operations (COD)

| ID | Feature | Notes | Type | Phase |
|---|---|---|---|---|
| COD-01 | WhatsApp confirmation bot | Confirm / Cancel / Change address buttons | BEYOND | MVP |
| COD-02 | SMS confirmation link fallback | Tap-to-confirm link | LOCAL | MVP |
| COD-03 | IVR confirmation (Urdu) | "Press 1 to confirm" for high-value or unanswered orders | LOCAL | V1 |
| COD-04 | Confirmation Desk | Prioritised agent queue, one-tap call/WhatsApp, outcomes, SLA timers | BEYOND | MVP |
| COD-05 | Confirmation policy builder | Channel sequence, quiet hours, auto-cancel rules, outage-aware | BEYOND | V1 |
| COD-06 | RTO risk scoring | Rules and heuristics (MVP) → network-trained ML with reasons (V1) | BEYOND | MVP |
| COD-07 | Blocklist & network reliability tier | Merchant blocklist (MVP); cross-store tier after legal sign-off (GROWTH) | BEYOND | MVP |
| COD-08 | Failed-delivery rescue | Auto WhatsApp to shopper; re-attempt instruction to the courier | BEYOND | V1 |
| COD-09 | RTO workflow | Expected returns, receive scan, restock/damaged, loss accounting | BEYOND | MVP |
| COD-10 | COD remittance reconciliation | CSV import + receivables ageing (MVP); courier APIs, dispute sheets (V1) | BEYOND | MVP |
| COD-11 | Agent performance | Confirmations/hour, and the RTO rate of the orders each agent confirmed | BEYOND | V1 |
| COD-12 | COD health dashboard | Confirmation, delivery and RTO rates by city, courier, product, source | BEYOND | MVP |
| COD-13 | Early COD remittance / advances | Via licensed financing partners | BEYOND | SCALE |

## 10. Shipping & logistics (SHP)

| ID | Feature | Notes | Type | Phase |
|---|---|---|---|---|
| SHP-01 | Courier integrations | PostEx, Leopards, TCS, Trax (MVP); M&P, BlueEx, Call Courier, Rider, Swyft, Daewoo, Pakistan Post manifests (V1) | LOCAL | MVP |
| SHP-02 | Bulk booking, labels, load sheets, pickups | A4 and thermal labels | LOCAL | MVP |
| SHP-03 | Courier city mapping | Auto-suggest; shared mapping improves with use | LOCAL | MVP |
| SHP-04 | Unified tracking | Normalised statuses; proactive shopper notifications | BEYOND | MVP |
| SHP-05 | Branded tracking page | Bilingual; WhatsApp opt-in | PARITY | MVP |
| SHP-06 | Smart courier allocation | Rules (MVP) → scoring on network performance data (V1) | BEYOND | V1 |
| SHP-07 | Courier rate cards & shipping cost per order | Feeds profit analytics | LOCAL | V1 |
| SHP-08 | Courier performance analytics | Delivery %, days to deliver, RTO % by city | BEYOND | V1 |
| SHP-09 | Multi-warehouse fulfilment | With routing rules | PARITY | GROWTH |
| SHP-10 | Own-rider delivery | Zones, assignment, proof of delivery, cash hand-over | LOCAL | GROWTH |
| SHP-11 | Hatti Ship programme | Negotiated platform rates; COD still remitted directly to merchants | BEYOND | GROWTH |
| SHP-12 | 3PL / fulfilment-centre integrations | | PARITY | SCALE |
| SHP-13 | International shipping | Diaspora orders via express carriers | PARITY | SCALE |
| SHP-14 | Scan-to-verify packing | Camera barcode scan prevents wrong items | BEYOND | V1 |
| SHP-15 | Local pickup | Store pickup with ready notification | PARITY | V1 |

## 11. Customers & accounts (CUS)

| ID | Feature | Notes | Type | Phase |
|---|---|---|---|---|
| CUS-01 | Phone-first customer profiles | Orders, LTV, addresses, notes, tags, delivery history | PARITY | MVP |
| CUS-02 | Customer accounts with OTP login | Order history, tracking, reorder, wishlist, loyalty | PARITY | V1 |
| CUS-03 | Segments | Filter builder over customers, orders, behaviour | PARITY | V1 |
| CUS-04 | Consent management | Per channel, with source and timestamp | PARITY | MVP |
| CUS-05 | Data export & erasure | Customer rights tooling | PARITY | V1 |
| CUS-06 | B2B / wholesale | Customer groups, price lists, quantity breaks, payment terms (Plus-only on Shopify) | PARITY | GROWTH |
| CUS-07 | Customer import/export | | PARITY | MVP |
| CUS-08 | Hatti Pass | Opt-in cross-store identity: verified phone and addresses, one-tap checkout | BEYOND | SCALE |

## 12. Marketing & growth (MKT)

| ID | Feature | Notes | Type | Phase |
|---|---|---|---|---|
| MKT-01 | WhatsApp broadcasts | Opted-in segments; cost estimate before sending | BEYOND | V1 |
| MKT-02 | SMS campaigns | Shared or branded sender | LOCAL | V1 |
| MKT-03 | Email campaigns | Builder and templates | PARITY | GROWTH |
| MKT-04 | Automations | Recipes (V1): abandoned cart, welcome, review request, win-back, back in stock, COD→prepaid nudge; flow builder (GROWTH) | PARITY | V1 |
| MKT-05 | Reviews | Photo/video, WhatsApp requests, moderation, rich snippets (app on Shopify) | PARITY | V1 |
| MKT-06 | Loyalty & rewards | Points and tiers (app on Shopify) | PARITY | GROWTH |
| MKT-07 | Referral programme | Fraud checks by phone, device and address (app on Shopify) | PARITY | GROWTH |
| MKT-08 | Affiliates & influencers | Codes/links; commission on **delivered** orders; payout reports | BEYOND | GROWTH |
| MKT-09 | Upsells & cross-sells | Product page, cart, post-purchase (app on Shopify) | PARITY | V1 |
| MKT-10 | Pixels + conversion APIs | Meta CAPI, TikTok Events API, Google; **delivered-order events** | BEYOND | V1 |
| MKT-11 | Catalog feeds | Meta and Google (V1); TikTok (GROWTH) | PARITY | V1 |
| MKT-12 | Attribution & ROAS | UTM reports (V1); ad-spend import and ROAS on delivered revenue (GROWTH) | BEYOND | V1 |
| MKT-13 | Pop-ups & capture forms | Phone/WhatsApp opt-in (app on Shopify) | PARITY | V1 |
| MKT-14 | Urgency & social proof | Countdowns and honest stock indicators; no fake scarcity | PARITY | V1 |
| MKT-15 | Blog with AI writing assistant | | PARITY | GROWTH |
| MKT-16 | Pakistani marketing calendar | Ramadan, Eid, 14 August, White Friday, lawn seasons; ready-made campaign kits | BEYOND | V1 |

## 13. Messaging & inbox (MSG)

| ID | Feature | Notes | Type | Phase |
|---|---|---|---|---|
| MSG-01 | Notification engine | Order, shipping and payment templates on WhatsApp/SMS/email/push, bilingual | LOCAL | MVP |
| MSG-02 | Own WhatsApp number via Embedded Signup | Coexistence: keep using the WhatsApp Business app on the same number | LOCAL | V1 |
| MSG-03 | Shared Hatti notifications number | For small shops' utility messages | LOCAL | MVP |
| MSG-04 | PKR message credits & cost policy | Prepaid wallet; Rich vs Economy routing | BEYOND | MVP |
| MSG-05 | Unified inbox | WhatsApp, Instagram, Messenger, web chat with order context | BEYOND | GROWTH |
| MSG-06 | Quick replies, assignment, SLAs | Urdu and English saved replies | PARITY | GROWTH |
| MSG-07 | AI support agent | Order status, FAQs, policy answers, human hand-off | BEYOND | GROWTH |
| MSG-08 | Order from a conversation | Draft order, product card, payment or COD link from chat | BEYOND | GROWTH |
| MSG-09 | Multilingual opt-out | "STOP", "band karo" | LOCAL | MVP |
| MSG-10 | Web chat widget | | PARITY | GROWTH |
| MSG-11 | Voice-note orders | Urdu speech-to-text → draft order | BEYOND | SCALE |

## 14. Sales channels (CH)

| ID | Feature | Notes | Type | Phase |
|---|---|---|---|---|
| CH-01 | Online store | | PARITY | MVP |
| CH-02 | WhatsApp catalog & chat-to-order | Catalog sync to the merchant's WABA | LOCAL | GROWTH |
| CH-03 | Facebook & Instagram catalog | For catalogue/dynamic ads | PARITY | V1 |
| CH-04 | TikTok catalog | | PARITY | GROWTH |
| CH-05 | Google free listings & Shopping | | PARITY | V1 |
| CH-06 | Daraz sync | Products, stock, orders | LOCAL | GROWTH |
| CH-07 | Link-in-bio store & shareable links | Product and checkout links for social bios and DMs | PARITY | MVP |
| CH-08 | Buy buttons & embeds | | PARITY | SCALE |
| CH-09 | AI shopping agents | Store MCP/UCP; agent orders pass COD confirmation | BEYOND | GROWTH |
| CH-10 | Reseller network | Supplier catalogues, reseller margins, supplier-fulfilled COD (subject to tax classification review) | BEYOND | SCALE |
| CH-11 | Multi-store / expansion stores | e.g. Pakistan + international store (Plus on Shopify) | PARITY | GROWTH |

## 15. POS & retail (POS)

| ID | Feature | Notes | Type | Phase |
|---|---|---|---|---|
| POS-01 | Android POS app | Sales, returns/exchanges, discounts, customer lookup | PARITY | GROWTH |
| POS-02 | Offline mode | Local store and sync | PARITY | GROWTH |
| POS-03 | Local hardware | Bluetooth/USB thermal printers, scanners, cash drawers available in Pakistan | LOCAL | GROWTH |
| POS-04 | FBR POS integration (Tier-1) | FBR invoice number, QR, service fee line | LOCAL | GROWTH |
| POS-05 | Unified inventory & customers | Across online and shops | PARITY | GROWTH |
| POS-06 | Click & collect, ship from store | | PARITY | GROWTH |
| POS-07 | Staff PINs, cash management, Z report | | PARITY | GROWTH |
| POS-08 | Endless aisle | Order from the shop for home delivery | PARITY | SCALE |

## 16. Analytics & finance (ANL)

| ID | Feature | Notes | Type | Phase |
|---|---|---|---|---|
| ANL-01 | Home with next best actions | "12 orders to confirm", "40 parcels to book", "Rs 3.2 lakh COD pending" | BEYOND | MVP |
| ANL-02 | Sales analytics | Sales, orders, AOV, conversion, sessions, top products, live view | PARITY | MVP |
| ANL-03 | True profit report | Revenue − COGS − shipping − RTO losses − payment fees − tax withheld (V1) − ad spend (GROWTH) | BEYOND | V1 |
| ANL-04 | Cohorts, retention, RFM | | PARITY | GROWTH |
| ANL-05 | Inventory reports | Sell-through, ageing, stock-outs | PARITY | V1 |
| ANL-06 | Custom reports & scheduling | | PARITY | GROWTH |
| ANL-07 | Daily owner summary on WhatsApp | Yesterday's sales, delivered, RTO, cash pending | BEYOND | V1 |
| ANL-08 | AI analytics Q&A | Questions in Urdu or English | BEYOND | GROWTH |
| ANL-09 | Payouts & settlements view | Gateways + couriers; fees and withholding | BEYOND | V1 |
| ANL-10 | Accounting exports | Excel; integrations with accounting tools | PARITY | GROWTH |

## 17. Tax & compliance (TAX)

| ID | Feature | Notes | Type | Phase |
|---|---|---|---|---|
| TAX-01 | Tax-inclusive pricing & tax categories | | LOCAL | MVP |
| TAX-02 | Merchant tax profile | NTN, STRN, filer status, province, Tier-1 flag | LOCAL | V1 |
| TAX-03 | Withholding reconciliation | Income tax and sales tax deducted by couriers/PSPs; tax credit report | BEYOND | V1 |
| TAX-04 | FBR digital invoicing connector | Via licensed integrator; FBR number + QR on invoices; 72-hour edit window | LOCAL | GROWTH |
| TAX-05 | Invoice series & credit/debit notes | Gapless numbering | LOCAL | V1 |
| TAX-06 | Consumer-protection templates & e-contract logs | Terms version, timestamp, device | LOCAL | MVP |
| TAX-07 | COD cash-cap enforcement | Platform-level ceiling | LOCAL | MVP |
| TAX-08 | Filer-status check assistance | Active Taxpayer List guidance | LOCAL | GROWTH |

## 18. Staff, security & admin (ADM)

| ID | Feature | Notes | Type | Phase |
|---|---|---|---|---|
| ADM-01 | Staff roles | Presets: Owner, Manager, Confirmation Agent, Packer, Marketer, Accountant (MVP); custom roles (V1) | PARITY | MVP |
| ADM-02 | MFA & sessions | Passkeys/TOTP, device list, login alerts | PARITY | MVP |
| ADM-03 | PII masking with logged reveal | Packers never see phone numbers | BEYOND | V1 |
| ADM-04 | Activity & audit log | | PARITY | MVP |
| ADM-05 | Urdu admin UI | | LOCAL | V1 |
| ADM-06 | Multi-store organisation view | | PARITY | GROWTH |
| ADM-07 | Collaborator access for agencies | Request/approve, time-boxed | PARITY | V1 |
| ADM-08 | Consent-based support access | Time-limited, logged | PARITY | MVP |
| ADM-09 | Enterprise SSO | SAML/OIDC | PARITY | SCALE |
| ADM-10 | Full store export | Data portability, no lock-in | BEYOND | V1 |

## 19. AI (cross-cutting)

AI features live in their domains. This index maps them. Architecture:
[09 · AI & Intelligence](../architecture/09-ai-and-intelligence.md).

| Capability | IDs | Phase |
|---|---|---|
| Store builder, Instagram import | ONB-03, ONB-04 | V1 |
| Product copy, translation, attributes, image tools | CAT-07, CAT-20, CAT-21 | V1 |
| RTO risk model, smart courier allocation | COD-06, SHP-06 | V1 |
| Merchant copilot (draft → confirm) | AI-01 *(new)*: natural-language admin for discounts, segments, broadcasts, reports | GROWTH |
| Support agent, analytics Q&A, payment-proof parsing | MSG-07, ANL-08, PAY-08 | GROWTH |
| Forecasting, visual search, voice-note orders | INV-08, SRC-07, MSG-11 | SCALE |

## 20. Developer platform & apps (DEV)

| ID | Feature | Notes | Type | Phase |
|---|---|---|---|---|
| DEV-01 | Admin GraphQL API | Date-versioned; cost-based limits | PARITY | V1 |
| DEV-02 | Storefront API | Public/private tokens | PARITY | GROWTH |
| DEV-03 | Webhooks | HMAC-signed, retries, filters | PARITY | V1 |
| DEV-04 | Custom apps | Merchant-created tokens with scopes | PARITY | V1 |
| DEV-05 | Public apps & App Store | OAuth, review, **billing API in PKR** | PARITY | GROWTH |
| DEV-06 | Theme app extensions & embedded admin apps | | PARITY | GROWTH |
| DEV-07 | Functions (Wasm) | Discounts, delivery, payment, validation, routing | PARITY | SCALE |
| DEV-08 | CLI, dev stores & sandboxes | Mock couriers, payments and WhatsApp simulator | BEYOND | GROWTH |
| DEV-09 | SDKs & docs | TypeScript, PHP, Python; Urdu video tutorials | PARITY | GROWTH |
| DEV-10 | Bulk operations | Async export/import to files | PARITY | GROWTH |
| DEV-11 | Automation triggers/actions for apps | | PARITY | SCALE |

## 21. Partners & ecosystem (PRT)

| ID | Feature | Notes | Type | Phase |
|---|---|---|---|---|
| PRT-01 | Partner dashboard | Dev stores, client management, store transfer | PARITY | V1 |
| PRT-02 | Recurring revenue share in PKR | For referred merchants | LOCAL | V1 |
| PRT-03 | Experts marketplace | Setup, photography, ads, migration services | PARITY | GROWTH |
| PRT-04 | Certification & Urdu training | | LOCAL | GROWTH |

## 22. Platform billing & support (BIL)

| ID | Feature | Notes | Type | Phase |
|---|---|---|---|---|
| BIL-01 | PKR plans & local payment | JazzCash/Easypaisa auto-debit, cards, Raast, bank transfer | LOCAL | MVP |
| BIL-02 | Tax-compliant invoices | Provincial sales tax on services | LOCAL | V1 |
| BIL-03 | Usage wallets | Messaging and AI credits | LOCAL | MVP |
| BIL-04 | Humane dunning | Grace period; storefront never goes dark abruptly | BEYOND | V1 |
| BIL-05 | Local support | WhatsApp and phone in Urdu/English; help centre; video tutorials | LOCAL | MVP |
| BIL-06 | Status page & incident comms | | PARITY | V1 |
| BIL-07 | Annual plans | Two months free | PARITY | V1 |

## 23. Trust & safety (TNS)

| ID | Feature | Notes | Type | Phase |
|---|---|---|---|---|
| TNS-01 | Report-this-store & takedowns | Footer link; SLA-bound workflow; appeals | BEYOND | V1 |
| TNS-02 | Scam-store detection | Prepaid anomalies, cloned catalogues, brand impersonation | BEYOND | GROWTH |
| TNS-03 | Prohibited-items screening | Keyword and image checks at listing time | PARITY | V1 |
| TNS-04 | IP & counterfeit complaints | Notice-and-takedown | PARITY | V1 |

## 24. Merchant mobile app (APP)

| ID | Feature | Notes | Type | Phase |
|---|---|---|---|---|
| APP-01 | Android & iOS app | Orders, Confirmation Desk, booking, Bluetooth label printing (MVP uses the responsive PWA admin) | LOCAL | V1 |
| APP-02 | Camera-first product creation | AI copy and background removal | BEYOND | V1 |
| APP-03 | Push notifications | New order, needs review, cash remitted, low stock | PARITY | V1 |
| APP-04 | Scanning | Scan-to-pack, RTO receiving, stock counts | BEYOND | V1 |
| APP-05 | Offline-tolerant actions | Queue and sync on bad networks | BEYOND | GROWTH |
| APP-06 | Rider mode | See SHP-10 | LOCAL | GROWTH |
