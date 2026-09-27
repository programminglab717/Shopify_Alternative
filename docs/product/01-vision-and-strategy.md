# 01 · Vision & Strategy

> **Status:** Draft v0.1 · **Last updated:** 2026-09-27
> Evidence for every claim below is in the research documents:
> [Market](../research/01-market-research.md) · [Shopify benchmark](../research/02-shopify-benchmark.md) ·
> [Local ecosystem](../research/03-local-ecosystem.md).

---

## 1. Mission

**Make it effortless and affordable for every Pakistani business to sell online, and to actually
get paid.**

"Actually get paid" is deliberate. In Pakistan an online order is not revenue until the parcel is
accepted at the door and the courier's cash reaches the merchant. Shopify stops at checkout. We run
the whole loop.

## 2. The problem

| # | Problem | Evidence (see research) |
|---|---|---|
| 1 | **The default platform is priced for another economy.** | ~68% of sampled Pakistani brand stores and ~79% of fashion brands run on Shopify. It bills in USD ($29–$399/month list). Card payments abroad attract advance tax (5% for filers, 10% for non-filers; a 2026 cut is reported but unverified) plus bank FX spreads. The rupee went from ~155 per USD (mid-2021) to ~280 (2024–26), so the same subscription nearly doubled in rupees. |
| 2 | **Local gaps are patched with paid apps.** | Typical fashion DTC store: **≈ $165–$225/month (≈ PKR 46–63k)** once COD forms, OTP/WhatsApp confirmation, courier booking, reviews, upsells and page builders are added. Scaling brands: $400–$865/month. |
| 3 | **Shopify's fees penalise digital payments.** | Shopify Payments is unavailable in Pakistan, so every prepaid order pays Shopify's **2% (Basic)** third-party fee plus 1.8–3.3% gateway MDR. That is about **3.8–5.3%**, while COD orders pay Shopify nothing. This runs against the national push to digital payments. |
| 4 | **COD dominates, and it leaks margin.** | COD is ~60–70% of orders nationally (~80% on Daraz; 90%+ for social-traffic DTC). RTO runs **18–30%**; one large retailer cancels **37%** of COD orders before dispatch; first-attempt delivery failure is 18–25%. |
| 5 | **Almost no small seller can accept online payments.** | ~17.5k e-commerce merchants accept online payments, versus ~2.6 million merchants registered on Raast (the State Bank's instant-payment system). The rails exist; checkout integration and onboarding don't. |
| 6 | **Compliance just got harder.** | Since Finance Act 2025, payment intermediaries and couriers withhold income tax (1% digital / 2% COD, doubled for non-filers from FY2026-27) and 2% sales tax; sellers must register; FBR digital invoicing is mandatory for sales-tax-registered businesses. |
| 7 | **The internet is slower and less reliable than the tools assume.** | Median mobile download is ~24 Mbps; much of the phone base is low-end Android plus a large feature-phone tail; there have been repeated submarine-cable faults and mobile shutdowns. Shopify's admin has no Urdu. |

## 3. Vision & positioning

**Positioning statement.** *For Pakistani merchants who sell online, Hatti is the commerce
operating system built for how Pakistan actually buys: cash on delivery, WhatsApp, local couriers,
Urdu, and wallets and Raast. It does everything Shopify does, prices in rupees, and charges no fee
on your sales. Unlike Shopify, it runs the whole path from order to cash, so you keep more of every
rupee you sell.*

**Tagline candidates** (for the brand team): "Order se paisay tak" (from order to money) ·
"Pakistan ka online dukaan" · "Sell more. Return less. Get paid faster."

## 4. Target segments

| Segment | Size / signal | What they need most | Our wedge | Priority |
|---|---|---|---|---|
| **A. Mid-sized DTC brands** (fashion, footwear, beauty, home) on Shopify | Hundreds of brands; ~79% of fashion brands are on Shopify | Lower TCO, fewer RTOs, courier and COD reconciliation, ads attribution on delivered orders | Built-in COD OS, PKR pricing, migration service | **Beachhead #1** |
| **B. Social sellers** (Instagram, TikTok, WhatsApp, many women-led, home-based) | Likely hundreds of thousands; mostly without gateways | A store in minutes, orders from DMs, COD, simple courier booking, phone-only admin | Free plan, WhatsApp-native tools, Urdu mobile app | **Beachhead #2** (volume) |
| **C. Omnichannel retailers** (chains with shops) | Thousands | POS + online inventory, FBR POS/e-invoicing, multi-location | POS + FBR connectors | Growth phase |
| **D. Agencies & freelancers** (Shopify/Woo developers) | Large pool; many build for foreign clients | Familiar tooling (Liquid), recurring income, PKR payouts | Partner programme, Liquid-compatible themes, app store | **Channel** from day one |
| **E. Resellers / dropshippers** | Reseller apps are proven locally | Catalogue sharing, margins, COD fulfilment by supplier | Reseller network | Scale phase |
| **F. Enterprise brands** (e.g. on Salesforce Commerce Cloud) | Top 5–10 | Scale, SLAs, integrations, drops | Dedicated cells, Drop Mode | Opportunistic from year 2 |

## 5. Personas

| Persona | Snapshot | Jobs to be done | Current pain |
|---|---|---|---|
| **Ayesha**, home-based seller, Lahore | Sells embroidered suits on Instagram and WhatsApp; 80–150 orders/month; runs everything from a Rs 45k Android phone | Take orders from DMs quickly; book couriers; know which customers to trust; get paid on time | Fake orders, courier chaos, spreadsheets, no online payments |
| **Bilal**, DTC founder, Karachi | Skincare brand; 3,000 orders/month; Shopify Basic + 7 apps (~$190/mo); 2 confirmation agents, 1 packer; heavy Meta ads | Cut RTO; see true profit per order after ads, shipping and returns; reconcile courier cash | USD app stack, 24% RTO, ad platforms optimising for fake orders, tax deductions he can't track |
| **Usman**, retailer, Faisalabad | 3 shops + website; 8k orders/month in season; FBR Tier-1 obligations | One inventory across shops and online; FBR-compliant POS; lawn-launch traffic without crashes | Disconnected POS and web; site crashes at drops |
| **Sana**, freelancer / agency, Islamabad | Builds Shopify stores for local and foreign clients | Ship client stores fast; earn recurring revenue; use Liquid skills | Clients complain about USD costs; commission paid in USD |
| **Hamza**, shopper, Multan | Rs 30k Android, Jazz 4G, reads Roman Urdu and English | Buy with confidence; pay COD or JazzCash; track on WhatsApp | Scam stores, surprise delivery charges, no updates |
| **Fatima**, reseller, Rawalpindi | Shares supplier catalogues in WhatsApp groups | Add margin, take orders, get profit payouts | Manual work, unreliable suppliers |

## 6. Product principles

1. **Delivered orders, not placed orders.** Every feature is judged by whether it increases
   successfully delivered, paid orders.
2. **Built in, not bolted on.** COD tools, courier booking, WhatsApp, reviews, upsells, pixels and
   profit analytics are part of the product, not a stack of paid apps.
3. **Rupee-first and no tax on growth.** PKR plans, local payment methods, and **0% platform
   transaction fees** on COD and on the merchant's own gateway.
4. **Phone-first, for merchants and shoppers.** Every merchant workflow works on a phone; the
   shopper's identity is their phone number.
5. **Urdu is not an afterthought.** Admin, storefront, notifications, support and AI work in Urdu,
   Roman Urdu and English.
6. **Trust is a feature.** Verified stores, transparent delivery charges, proactive tracking and fair
   dispute handling raise buyer confidence, and confident buyers pay online.
7. **Works on a bad day.** Low-end phones, slow networks, cable faults and blocked apps are design
   inputs, not edge cases.
8. **Open ecosystem.** Public APIs, Liquid-compatible themes and a partner programme: local
   developers should earn more building on Hatti than on anything else.

## 7. Why Hatti wins against Shopify in Pakistan

| Dimension | Shopify (for a Pakistani merchant) | Hatti |
|---|---|---|
| Price & currency | USD list prices; FX + advance tax on card payments | PKR plans from Rs 0; pay by JazzCash, Easypaisa, card, Raast or bank transfer |
| Transaction fees | 2% / 1% / 0.6% on prepaid orders (no Shopify Payments in PK) | **0%** on every plan |
| COD | Manual payment method; OTP, COD fees and risk need apps | **COD OS**: risk scoring, OTP, partial advance, confirmation bot, confirmation desk, rescue, RTO workflows |
| Couriers | Via separate courier and aggregator apps | Built-in multi-courier booking, labels, load sheets, tracking, **smart allocation**, **COD reconciliation** |
| WhatsApp | Via third-party apps; USD message billing | Native: confirmations, updates, broadcasts, inbox, PKR message credits |
| Payments | Third-party gateways; wallets via aggregators | Safepay, JazzCash, Easypaisa, PayFast, banks; **Raast-first** prepaid nudges; partner-powered payments later |
| Tax | No Pakistani tax features | Withholding reconciliation, tax profile, FBR digital-invoicing and POS connectors |
| Language | No Urdu admin | Urdu + English admin and storefronts, Roman Urdu search |
| Performance | Good globally; heavy themes and app scripts common | HTML-first themes for low-end Android; server-side pixels replace client-side tags |
| Ads measurement | Pixels/CAPI via apps | Built-in CAPI with **delivered-order optimisation events** |
| Support | English, global | Urdu/English, WhatsApp support, local partners |
| Ecosystem | Huge global app store | Liquid compatibility + migration tools + a local partner and app economy paid in PKR |

**What Shopify does better, and our answer:** global brand trust (→ verified local references and
partner advocacy); a huge app ecosystem (→ built-in essentials plus Liquid compatibility); mature
cross-border tooling (→ diaspora features in the Scale phase); agentic-commerce distribution
(→ UCP/MCP readiness in the Growth phase).

## 8. Competitive landscape

| Competitor type | Examples | Their strength | Our angle |
|---|---|---|---|
| Global platforms | Shopify, WooCommerce, Wix | Maturity, ecosystem | Local depth, PKR pricing, COD OS |
| Local add-on layer | COD form apps, courier aggregators (Courierify, WeShip, Flaship, ShipUp), tracking and WhatsApp tools, one-click checkout (bSecure) | Point solutions that already monetise | Bundle them natively into one coherent product; partner or acquire where useful |
| Local store builders | Dukan.pk, restaurant platforms (Blinkco, Tossdown) | Local presence | Breadth, performance, ecosystem, network intelligence |
| Marketplaces | Daraz | Traffic, trust | Own-brand stores plus Daraz sync; lower take rate |
| Reseller apps | Markaz | Reseller network | Reseller mode on independent stores (Scale phase) |
| Regional analogues (reference) | Salla, Zid (KSA), YouCan (Morocco), Dukaan (India) | Local-first playbooks | Proof that local-first beats global in COD, local-language markets |

## 9. Moats we are building

1. **Network intelligence.** Courier performance by city, delivery-outcome signals and address
   quality all improve with every merchant, and no single-store tool can match them.
2. **Integration depth.** Couriers, wallets, Raast, FBR, WhatsApp and SMS integrations that are
   tedious to build and maintain.
3. **Ecosystem.** Partners, agencies and app developers earning in PKR on Hatti.
4. **Cost structure.** Multi-tenant efficiency and a local team let us price in rupees profitably.
5. **Trust brand.** A "Verified on Hatti" badge that shoppers recognise.

## 10. North-star metric & KPIs

**North star: Successfully Delivered Orders (SDO) per month across Hatti stores.**

| KPI | Why it matters | Year-1 target (proposal) |
|---|---|---|
| Active paying stores | Revenue base | 1,500 by month 12; 6,000 by month 24 |
| Merchant delivery success rate (delivered ÷ shipped) | Proves the COD OS works | +5 pts vs the merchant's pre-Hatti baseline |
| Prepaid share of orders | Cash flow, lower RTO, payments revenue | +10 pts vs baseline |
| Time to first order (new store) | Activation | < 72 hours median |
| Paid logo churn (monthly) | Retention | < 3% |
| Net revenue retention | Expansion | > 105% |
| Storefront p75 LCP (mobile) | Performance promise | ≤ 2.0 s |
| Support first response (WhatsApp) | Local service promise | < 10 min in business hours |

## 11. Go-to-market

1. **Partners first.** Recruit Shopify/Woo freelancers and agencies with recurring revenue share,
   free dev stores, migration bounties and Urdu training. They are the fastest route to Segment A.
2. **"We move you for free."** A white-glove migration service for Shopify stores (products,
   customers, orders, redirects) with SEO continuity.
3. **Co-marketing with couriers and payment providers.** Their merchant bases are our pipeline, and
   integrations are the pitch.
4. **Community and content in Urdu:** YouTube tutorials, Facebook seller groups, WhatsApp
   communities, live "COD masterclasses".
5. **Free plan for social sellers**, spreading virally through "Powered by Hatti" and order-tracking
   pages seen by millions of shoppers.
6. **Seasonal timing.** Never ask merchants to migrate right before Ramadan/Eid or White Friday.
   Launch windows sit after peaks (see [Roadmap](./04-roadmap.md)).

## 12. Business model (summary)

Subscriptions in PKR (Free → Enterprise), messaging and AI credits, then partner-powered payments,
shipping-programme margins, a theme and app store, and financing referrals. Details:
[Pricing & Business Model](./03-pricing-and-business-model.md).

## 13. Key risks

| Risk | Mitigation |
|---|---|
| Shopify localises (PKR pricing, local payments) | Our wedge is depth (COD OS, couriers, tax, Urdu) plus network data, not just price |
| Scope is too broad for a small team | Strict phase gates; built-in essentials first; partners fill the long tail |
| Tax classification as an "online marketplace" | Stay a software platform at launch; written tax opinion before any marketplace-like feature |
| Dependence on Meta/WhatsApp pricing and policy | SMS/IVR fallbacks, cost policies, prepaid PKR credits |
| Courier API instability | Adapter contract tests, polling, queues, manual fallbacks |
| Hosting geopolitics and cable faults | Singapore primary, second-region DR, Pakistan data-centre cell (see ADR-015) |
| FX exposure (USD costs, PKR revenue) | Lean infrastructure, annual plans, PKR-billed local capacity later, periodic price reviews |
| Scam stores damaging trust | Trust & Safety tiers, verification badges, fast takedowns |
| Payments partner concentration | Multiple gateways; partner-powered payments with at least two providers |

## 14. Decisions needed from founders

1. Final **brand name** (working name: Hatti), with trademark and domain checks.
2. **Funding plan** and runway (it shapes team size and roadmap pace).
3. **Beachhead emphasis:** DTC brands first (higher ARPU) vs social sellers first (volume). We
   recommend DTC first with a free tier running in parallel.
4. **Launch partners:** 2 couriers + 2 payment providers for co-launch agreements.
5. **Legal counsel** for tax classification, PECA, data protection and network risk signals.
