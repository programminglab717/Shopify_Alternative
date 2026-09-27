# Executive Summary: Hatti, Pakistan's Commerce Operating System

> **Status:** Planning v0.1 · **Date:** 2026-09-27 · Working name **Hatti** (Punjabi ہٹی, "shop"),
> a placeholder until branding and trademark checks are done.

## What we are building

An online commerce platform that does **everything Shopify does**: store builder, themes,
checkout, payments, orders, marketing, analytics, POS, apps and APIs. It is **built for how
Pakistan actually buys**: cash on delivery, WhatsApp, local couriers, wallets and Raast, and Urdu.
Plans are priced in rupees, and there are **no transaction fees**.

## Why now

* **Shopify is the default and a poor fit.** ~68% of sampled Pakistani brand stores (~79% of fashion
  brands) run on Shopify. It bills in USD, charges an extra **2% on prepaid orders** because Shopify
  Payments isn't available in Pakistan, and needs an app stack that pushes a typical fashion store's
  cost to **≈ Rs 46–63k/month**.
* **COD leaks margin.** COD is ~60–70% of orders nationally, and 18–30% of COD parcels return
  unsold. Courier cash arrives late and unreconciled.
* **The payment rails exist, but merchants aren't on them.** There are 2.6M+ merchants on Raast
  (the State Bank's instant-payment system), but only ~17.5k e-commerce merchants accept online
  payments.
* **Policy is moving.** Since July 2025, withholding on COD is double that on digital payments,
  sellers must register for tax, and FBR e-invoicing is mandatory for sales-tax-registered
  businesses.
* **AI shopping agents are becoming a channel.** Shopify and Google launched open agent-commerce
  protocols in 2026, and local stores need to be agent-ready too.

## Why merchants will switch

| | Shopify in Pakistan | Hatti |
|---|---|---|
| Price | USD, plus FX spread and advance tax | **PKR plans from Rs 0**; Growth Rs 6,999 replaces a ~Rs 46–63k stack |
| Fees | 2% / 1% / 0.6% on prepaid orders | **0%** on every plan |
| COD | Apps | **COD OS**: risk scoring, OTP, partial advance, WhatsApp/IVR confirmation, Confirmation Desk, failed-delivery rescue, returns (RTO) workflows |
| Couriers | Apps | Built-in booking, labels and tracking across PostEx, Leopards, TCS, Trax and more; **smart allocation** and **COD reconciliation** |
| Payments | Third-party gateways | Safepay, JazzCash, Easypaisa, PayFast, banks; **Raast-first** prepaid; partner-powered payments later |
| WhatsApp | Apps, billed in USD | Native confirmations, updates, broadcasts and inbox, with PKR message credits |
| Tax | None | Withholding reconciliation; FBR e-invoicing and POS connectors |
| Language & speed | English admin; heavy themes | Urdu/English, Roman Urdu search, themes built for Rs 30k phones |
| Ads | Pixels via apps | Server-side conversions with **delivered-order optimisation** |

## Who it's for

1. **Beachhead #1:** mid-sized DTC brands on Shopify (fashion, beauty, footwear, home).
2. **Beachhead #2:** social sellers on Instagram, TikTok and WhatsApp (free plan).
3. **Channel:** Pakistan's large pool of Shopify/Liquid freelancers and agencies (partner programme
   with recurring PKR revenue share).
4. **Later:** omnichannel retailers (POS + FBR), resellers, enterprise brands.

## Business model

Free · **Starter Rs 2,499** · **Growth Rs 6,999** · **Pro Rs 17,999** · Enterprise from Rs 75,000
per month. Additional revenue: messaging and AI credits, partner-powered payments, the Hatti Ship
courier programme, theme and app stores, and financing referrals. Base case: **≈ $0.36M ARR at month
12, ≈ $1.9M at month 24, ≈ $7M at month 36** (illustrative).

## Architecture at a glance

* **Modular monolith in TypeScript** (NestJS), deployed as isolated process pools (admin, storefront,
  checkout, workers), plus a Liquid-compatible **storefront renderer**.
* **PostgreSQL with shop-level tenancy + row-level security**, scaled out in **cells** (shards of
  shops), like Shopify's pods. There is a small global control plane.
* **Cloudflare edge:** custom domains, caching at PoPs in Karachi, Lahore and Islamabad,
  bot protection, a flash-sale waiting room; R2 for media.
* **Integration layer** for couriers, payments, WhatsApp/SMS and FBR, built on queues, polling,
  reconciliation and circuit breakers.
* **Hosting:** Singapore at launch (the Gulf regions were physically damaged in 2026), with DR in
  a second region, then a **Pakistan data-centre cell** for latency and cable-fault resilience.
* **AI:** Claude via an internal AI gateway (Urdu product copy, copilot, support agent) plus
  in-house ML for COD risk and courier performance.

## Roadmap

| Phase | When | Outcome |
|---|---|---|
| 0 · Foundations | Oct – mid-Nov 2026 | Partners, legal opinions, spikes, hosting decision |
| 1 · MVP | to Mar 2027 | "Sell and ship with COD": friendly alpha, then a closed beta after Eid ul-Fitr |
| 2 · V1 | to Jul 2027 | Public launch (~20 July): replaces the Shopify app stack |
| 3 · Growth | Aug 2027 – Jan 2028 | POS + FBR, partner-powered payments, inbox, AI, app platform, Drop Mode |
| 4 · Scale | Feb – Oct 2028 | Functions, headless, reseller network, cross-border, financing |

Team: ~15 people through MVP, ~26 at V1, ~42 in Growth. Infrastructure: ~$1.5–3k/month at MVP,
falling to ≈ $0.4–0.7 per active store per month at scale.

## Top risks

Scope versus team size · tax classification ("online marketplace") · dependence on Meta/WhatsApp ·
courier API instability · hosting geopolitics and cable faults · FX (USD costs, PKR revenue) · scam
stores eroding trust. Mitigations are in [Vision §13](./product/01-vision-and-strategy.md#13-key-risks).

## Decisions needed now

1. Final brand name and trademark.
2. Funding plan and runway (sets team size and pace).
3. Beachhead emphasis (we recommend DTC brands first, with a free tier in parallel).
4. Launch partners: 2 couriers and 2 payment providers.
5. Counsel engaged for tax classification, PECA, data protection and network risk signals.
6. Hosting bake-off sign-off (ADR-015).

## Document map

| Area | Documents |
|---|---|
| Research | [Market](./research/01-market-research.md) · [Shopify benchmark](./research/02-shopify-benchmark.md) · [Local ecosystem](./research/03-local-ecosystem.md) |
| Product | [Vision & strategy](./product/01-vision-and-strategy.md) · [Feature catalog](./product/02-feature-catalog.md) · [Pricing & business model](./product/03-pricing-and-business-model.md) · [Roadmap](./product/04-roadmap.md) |
| Design | [Principles & design system](./design/01-design-principles-and-system.md) · [Information architecture](./design/02-information-architecture.md) · [Key user flows](./design/03-key-user-flows.md) |
| Architecture | [Overview](./architecture/01-system-overview.md) and documents 02–13, ending with the [decision log](./architecture/13-decision-log.md) |
