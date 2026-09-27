# 03 · Pricing & Business Model

> **Status:** Draft v0.1 (a proposal for founders to pressure-test with merchants) ·
> **Last updated:** 2026-09-27 · Currency: PKR; USD equivalents at an assumed Rs 280/USD.
> Shopify cost figures come from the [Shopify benchmark](../research/02-shopify-benchmark.md). App
> prices there are indicative and unverified.

---

## 1. Pricing principles

1. **Priced in rupees, paid in rupees.** JazzCash/Easypaisa auto-debit, cards, Raast or bank
   transfer. No USD exposure for merchants.
2. **0% platform transaction fees on every plan**, whether on COD or on the merchant's own gateway.
   We never tax a merchant's growth, and we never penalise digital payments.
3. **A real free plan** for social sellers, limited by order volume, not by crippled features.
4. **Essentials included.** What Shopify merchants buy as apps (COD tools, courier booking,
   WhatsApp, reviews, upsells, pixels, profit analytics) is part of the plans.
5. **Pass-through costs at near cost.** WhatsApp, SMS and IVR are charged at provider cost plus a
   small, published service fee, in PKR.
6. **Predictable.** Annual plans lock the price. Price changes are announced 60 days ahead and
   reviewed at most once a year (FX pressure is real, but merchants need stability).

---

## 2. Plans (proposal)

Prices are monthly, exclusive of provincial sales tax on services. Annual billing = **2 months
free**.

| | **Free** | **Starter** | **Growth** | **Pro** | **Enterprise** |
|---|---|---|---|---|---|
| **Price / month** | **Rs 0** | **Rs 2,499** (≈ $9) | **Rs 6,999** (≈ $25) | **Rs 17,999** (≈ $64) | **from Rs 75,000** (≈ $268) |
| Annual (per month) | n/a | Rs 2,083 | Rs 5,833 | Rs 14,999 | Custom |
| Best for | Instagram/WhatsApp sellers starting out | Small stores and home businesses | Growing DTC brands (the typical Shopify + apps store) | Multi-channel brands and retailers | Top brands, high-volume drops |
| Orders / month | 50 | Unlimited | Unlimited | Unlimited | Unlimited |
| Staff accounts | 1 | 3 | 8 | 20 | Unlimited |
| Locations (inventory) | 1 | 1 | 3 | 10 | Custom |
| Platform transaction fee | **0%** | **0%** | **0%** | **0%** | **0%** |
| Domain | hatti.pk subdomain | Custom domain | Custom domain | Custom domain | Custom + multi-store |
| "Powered by Hatti" | Shown | Removable | Removable | Removable | Removable |
| Themes | 2 free | All free themes | All free + code editor | All + code editor | All + custom |
| Payments | COD, bank transfer, payment links | + all supported gateways | + partial advance, prepaid incentives | + all | + all |
| COD essentials: OTP, WhatsApp/SMS confirmation, blocklist, Confirmation Desk | ✓ (1 agent) | ✓ | ✓ | ✓ | ✓ |
| COD intelligence: ML risk scoring, IVR, rescue flows, policy builder, network tier | — | — | ✓ | ✓ | ✓ |
| Couriers: booking, labels, tracking | All couriers | All couriers | + smart allocation | + smart allocation | + custom |
| COD remittance reconciliation | Manual CSV | CSV + APIs | + receivables ageing, disputes | ✓ | ✓ |
| Reviews, discounts, upsells, size charts, wishlist | Basic | ✓ | ✓ | ✓ | ✓ |
| Abandoned checkout recovery, automations | — | Recipes | + flow builder | ✓ | ✓ |
| Pixels + conversion APIs (delivered-order events) | — | Pixels | ✓ CAPI | ✓ | ✓ |
| True profit analytics | — | — | ✓ | ✓ | ✓ |
| Loyalty, referrals, affiliates | — | — | ✓ | ✓ | ✓ |
| Bilingual (EN/UR) storefront | ✓ | ✓ | ✓ | ✓ | ✓ |
| Unified inbox, AI support agent | — | — | ✓ (fair use) | ✓ | ✓ |
| POS | — | — | — | 1 register included | Custom |
| FBR digital invoicing / POS connectors | — | — | — | ✓ | ✓ |
| B2B price lists, multi-store | — | — | — | ✓ | ✓ |
| Drop Mode (waiting room, token inventory) | — | — | — | ✓ | ✓ + rehearsals |
| API access | — | Custom apps | Custom apps | Higher rate limits | Highest; dedicated cell option |
| AI credits included / month | 10 | 50 | 150 | 600 | Custom |
| Support | Help centre + community | WhatsApp support | Priority WhatsApp | Priority + onboarding call | Account manager + SLA (99.95%) |

**Why these price points:** a typical fashion DTC store pays Shopify plus apps **≈ Rs 46–63k per
month**. Growth replaces that stack for **Rs 6,999**. Starter undercuts Shopify Basic's list price
alone (≈ Rs 8–11k before apps, FX spread and advance tax) by roughly 70–75%.

---

## 3. Add-ons & usage

| Add-on | Price (proposal) | Notes |
|---|---|---|
| WhatsApp messages | Meta's rate for the category, converted to PKR, **+ 10% service fee** | Prepaid credit wallet; per-message cost shown before broadcasts |
| SMS | Bundles priced at aggregator cost + ~15% | Shared or branded sender |
| IVR confirmations | Per call, at cost + ~15% | Used selectively by policy |
| AI credit packs | Rs 999 per 100 generations | Priced above current model cost (≈ Rs 7–9 per product-copy generation); revisit after cost tuning |
| Extra staff | Rs 499 / staff / month | |
| Extra POS register | Rs 1,999 / register / month | |
| Extra location | Rs 999 / location / month | |
| Premium themes | One-time Rs 5,000–30,000 | Designers keep 70% |
| Domains | Registrar cost + small margin | `.com` in-app; `.pk` assisted |
| Migration service | Free with annual Growth/Pro; otherwise from Rs 15,000 | White-glove Shopify/Woo moves |

---

## 4. Revenue streams & phasing

| Stream | Model | Starts |
|---|---|---|
| **Subscriptions** | Plans above | MVP (paid beta), V1 (public) |
| **Messaging margin** | Service fee on WhatsApp/SMS/IVR pass-through | MVP |
| **AI credits** | Packs beyond included quotas | V1 |
| **Services** | Migrations; Experts marketplace commission (15%) | V1 |
| **Partner-powered payments ("Hatti Payments")** | Revenue share on MDR with a licensed partner. Merchant pricing is kept **at or below** a standalone gateway contract; Raast is the lowest-cost rail | Growth |
| **Hatti Ship** | Commission or margin on negotiated courier rates. Couriers still remit COD directly to merchants | Growth |
| **Theme & app store** | Themes 30% commission. Apps **0% on a developer's first Rs 5M annual revenue, then 10%** | Growth |
| **POS hardware** | Resale of printers, scanners and drawers at a modest margin | Growth |
| **Enterprise** | Custom contracts, dedicated cells | Growth |
| **Financing referrals** | Fees from licensed NBFC partners for COD advances and working capital | Scale |

Keeping payments and shipping monetisation **partner-led** keeps Hatti out of fund custody. That
matters for SBP licensing and for tax classification (see
[Local ecosystem research](../research/03-local-ecosystem.md)).

---

## 5. Merchant savings vs Shopify (illustrative)

| Scenario | Shopify: plan + apps (research estimate) | Shopify: 3rd-party fee on prepaid orders | Hatti | Monthly saving |
|---|---|---|---|---|
| **A. Lean COD store**: 300 orders, 10% prepaid, AOV Rs 3,000 | ≈ $39–45 → **Rs 11–13k** | 2% × Rs 90k = Rs 1.8k | **Starter Rs 2,499** | **≈ Rs 10–12k (≈ 80–85%)** |
| **B. Typical fashion DTC**: 1,500 orders, 20% prepaid, AOV Rs 3,500 | ≈ $165–225 → **Rs 46–63k** | 2% (Basic) × Rs 1.05M = Rs 21k | **Growth Rs 6,999** | **≈ Rs 60–77k (≈ 90%)** |
| **C. Scaling brand**: 5,000 orders, 25% prepaid, AOV Rs 4,000 | ≈ $400–865 → **Rs 112–242k** | 1% (Grow) × Rs 5M = Rs 50k | **Pro Rs 17,999** | **≈ Rs 144–274k** |

Not included on either side: messaging charges (Meta charges per message on both), gateway MDR (paid
to the gateway on both), bank FX spread and advance tax on USD card payments (Shopify only; they
make the gap wider).

---

## 6. Unit economics (targets)

| Metric | Target | Notes |
|---|---|---|
| Blended subscription ARPU (paid) | Rs 5,000 (year 1) → Rs 6,000 (year 3) | Mix shifts to Growth/Pro |
| Additional revenue per paid store | Rs 500 (year 1) → Rs 3,000 (year 3) | Messaging, AI, payments, shipping |
| Infrastructure cost per active store | ≤ Rs 150–250 / month | See [10 · Infrastructure](../architecture/10-infrastructure-and-devops.md) |
| Support cost per paid store | ≤ Rs 500 / month | Self-serve content, AI deflection, 1 agent per ~300 paid stores |
| AI cost | ≤ 5% of plan revenue | Quotas, caching, batching, effort tuning |
| Subscription gross margin | ≥ 75% | |
| Paid logo churn | < 3% / month | Industry SMB norms are 3–5% |
| CAC payback | ≤ 6 months | Partner-led acquisition keeps CAC variable |
| Free → paid conversion | ≥ 8% within 6 months | Order-volume limit is the natural trigger |

### 6.1 Illustrative scenario (base case, not a forecast)

| | Month 12 | Month 24 | Month 36 |
|---|---|---|---|
| Paying stores | 1,500 | 6,000 | 18,000 |
| Free stores | 8,000 | 30,000 | 80,000 |
| Subscription MRR | Rs 7.5M | Rs 33M | Rs 108M |
| Usage + payments + shipping MRR | Rs 1.0M | Rs 12M | Rs 55M |
| **Total MRR** | **Rs 8.5M** | **Rs 45M** | **Rs 163M** |
| **ARR (USD)** | **≈ $0.36M** | **≈ $1.9M** | **≈ $7.0M** |
| Orders / month across paying stores | ≈ 0.3M | ≈ 1.3M | ≈ 4.5M |

Month-36 payments and shipping revenue assumes ~25% prepaid share, ~0.5% net payments take rate
on prepaid GMV, and about half of parcels booked through Hatti Ship at a small per-parcel margin.
Engineering capacity targets in [12 · Scalability](../architecture/12-scalability-and-reliability.md)
include roughly 2× headroom over this base case.

---

## 7. Partner programme economics

| Element | Proposal |
|---|---|
| Referral revenue share | **20% of subscription revenue for 36 months** for each referred paying store, paid monthly in PKR (bank or wallet) |
| Migration bounty | Rs 5,000–25,000 per migrated Shopify/Woo store (by plan), paid after 90 days of retention |
| Dev stores | Free and unlimited; transferable to clients |
| Tiers | Registered → Certified (training + 5 live stores) → Premier (25+ stores): more leads, co-marketing, early access |
| App developers | Billing API in PKR; 0% on the first Rs 5M annual revenue, then 10% |
| Theme designers | 70% of each sale |

---

## 8. Billing operations

* **Methods:** JazzCash and Easypaisa wallet auto-debit (after one-time linking), card
  subscriptions, Raast request-to-pay for renewals and dunning, and bank transfer for annual plans.
* **Invoices:** PKR, with provincial sales tax on services and our registration numbers; business
  customers' withholding certificates are supported.
* **Dunning** (humane by design):

| Day | Action |
|---|---|
| 0 | Payment fails → retry with the next saved method; WhatsApp + email notice |
| 1–5 | Retries; Raast request-to-pay sent |
| 7 | Admin banner; owner call from support for Growth and above |
| 14 | **Grace mode:** storefront and checkout stay live; admin limited to orders, fulfilment and billing |
| 30 | Storefront paused with a friendly page and WhatsApp contact; data kept for 90 days |

* **Refund policy:** pro-rated refunds on annual plans within 30 days of purchase.

---

## 9. Pricing risks & open questions

| Question | How we'll answer it |
|---|---|
| Is Rs 2,499 too low to fund Urdu support at quality? | Measure support minutes per store in beta; adjust Starter limits (staff, automations) rather than price |
| Do merchants value order-unlimited plans, or prefer order-based tiers? | Test both in beta with 50 merchants (Van Westendorp + conjoint-lite interviews) |
| Messaging costs rival subscription costs for small COD sellers | Economy routing policy, SMS for one-way updates, clearer cost dashboards |
| Payment partner economics (rev share, onboarding speed) | Term sheets with at least two partners before Growth |
| FX pressure on USD-denominated costs | Annual review; PKR-billed local capacity (Pakistan data-centre cell) |
