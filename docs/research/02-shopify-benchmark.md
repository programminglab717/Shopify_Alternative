# 02 · Shopify Benchmark (2026)

> **Status:** Research snapshot · **Compiled:** 2026-09-27
>
> **Confidence tags:** **[P]** Shopify's own pages or official Shopify/protocol code on GitHub ·
> **[S]** reputable secondary source or a search extract of a Shopify page · **[3P]** blogs/vendors
> · **[U]** unverified (background knowledge). shopify.com and help.shopify.com could not be
> opened from the research environment. Page-level facts come from search extracts, while code-level
> facts were read from Shopify's public GitHub repositories. App prices and Pakistan availability
> details are mostly **[U]**. See §9.

---

## 1. Key takeaways

1. **Price in USD:** Basic **$39/month ($29 yearly)**, Grow **$105 ($79)**, Advanced **$399 ($299)**,
   Plus from ~$2,300–2,500, Starter $5. There is also a new **$0 Agentic plan** for non-Shopify
   merchants selling through AI channels [P/S].
2. **No Shopify Payments in Pakistan** [S]. Every prepaid order therefore pays the **third-party
   transaction fee (2% / 1% / 0.6%)** on top of gateway MDR. **COD and other manual payment
   methods pay no Shopify transaction fee** [P via S].
3. **Many flagship services are unavailable to Pakistani merchants:** Shop Pay, Installments,
   Capital, Balance, Shipping labels, Tax, Managed Markets, Fulfillment Network, POS hardware
   and Audiences (Shopify Payments unavailability is confirmed [S]; the rest [U]).
4. **Total cost of ownership is driven by apps** that fill local gaps: ≈ $40–60/month for a lean COD
   store, ≈ $165–225 for a typical fashion DTC store, $400–865 for scaling brands [U estimates].
5. **2026 headline: agentic commerce.** Winter '26 "Agentic Storefronts", Shopify Catalog, a
   Storefront MCP endpoint on every store, and the **Universal Commerce Protocol (UCP)** co-developed
   with Google and major retailers [P].
6. **Architecture lessons are well documented:** a modular monolith, shop-sharded pods, online tenant
   moves, circuit breakers and fault injection, sandboxed extensibility (Liquid limits, Wasm Functions,
   Remote DOM).

---

## 2. Pricing (2026)

| Plan | Monthly | Yearly (per month) | Card rate with Shopify Payments (US) | Third-party gateway fee | Staff | Tag |
|---|---|---|---|---|---|---|
| Agentic (new) | $0 | — | from 2.9% + 30¢ | third-party fees apply per sale | n/a | [P] |
| Starter | $5 | [U] | "5% when you use Shopify Payments" (extract) | [U] | [U] | [P]/[U] |
| **Basic** | **$39** | **$29** | 2.9% + 30¢ | **2%** | Owner only | [P]/[S] |
| **Grow** | **$105** | **$79** | 2.7% + 30¢ | **1%** | 5 additional | [P]/[S] |
| **Advanced** | **$399** | **$299** | 2.5% + 30¢ | **0.6%** (one source: 0.5%) | 15 additional | [P]/[S] |
| Plus | from ~$2,500 (1-year term); ~$2,300 (3-year) | — | negotiated | 0.2% [U] | unlimited [U] | [S]/[U] |
| POS Pro add-on | +$89 / location | +$67 / location | — | — | — | [P] |

* **Trial:** 3 days free, then **$1/month for 3 months** on most plans [P/S]. Whether this applies
  in Pakistan is [U].
* **Billing currency:** "most Shopify bills are charged in US dollars". Local-currency billing
  exists only in some countries (for Plus: INR, EUR, GBP, AUD, JPY, CAD) [P]. **No PKR billing or
  Pakistan-specific pricing found.** India has INR price points (Basic ₹1,994 monthly / ₹1,499 yearly)
  [S].
* **Fraud analysis:** Basic merchants without Shopify Payments get only fraud *indicators*, not
  recommendations, which is exactly the Pakistani Basic merchant's situation [P].
* **Carrier-calculated shipping** (third-party carrier accounts) is Advanced/Plus only. Built-in
  carriers are UPS, FedEx, USPS, Canada Post and Australia Post; Pakistani couriers come via apps
  [P]/[U].

### 2.1 Fee mechanics in Pakistan (worked example)

Store: 1,000 orders/month, AOV PKR 3,500 (≈ $12.5 at PKR 280), 80% COD, 20% prepaid through a local
gateway (≈ $2,500/month prepaid).

| Plan (yearly) | Subscription | Shopify fee on prepaid | Shopify total | Gateway MDR (≈2.5%, paid to gateway) |
|---|---|---|---|---|
| Basic | $29 | 2% × $2,500 = $50 | **$79** | ≈ $62.5 |
| Grow | $79 | 1% × $2,500 = $25 | **$104** | ≈ $62.5 |
| Advanced | $299 | 0.6% × $2,500 = $15 | **$314** | ≈ $62.5 |

Break-even Basic → Grow is **$5,000/month** of prepaid GMV (yearly billing). Market workaround:
some local one-click checkouts (e.g. bSecure) market off-platform checkout to avoid the 2% fee;
their standing under Shopify's terms is [U].

---

## 3. Pakistan availability matrix

| Capability | Available to a Pakistan-based merchant? | Tag |
|---|---|---|
| Core platform (admin, store, checkout, apps) | Yes (Shopify runs a Pakistan locale site; store currency PKR possible) | [P]/[S] |
| **Shopify Payments** | **No** | [S] |
| Shop Pay / Shop Pay Installments | No (require Shopify Payments; Installments US/CA) | [U] |
| Capital, Balance, Credit, Bill Pay | No | [U] |
| Shopify Shipping labels | No | [U] |
| Carrier-calculated rates | Plan-gated; no native Pakistani couriers | [P]/[U] |
| Local delivery / pickup | Yes | [U] |
| Shopify Tax, duties at checkout, Managed Markets | No | [U] |
| Multi-currency checkout | Limited (conversion at checkout needs Shopify Payments) | [U] |
| Markets (languages, domains) | Yes | [U] |
| POS app | Partial (no Shopify card hardware) | [U] |
| POS hardware | No | [U] |
| Shopify Email, Inbox, Forms, Flow, Search & Discovery, Translate & Adapt, Bundles | Likely yes | [U] |
| Subscriptions | Limited (needs recurring-capable gateway) | [U] |
| Audiences | No (Plus, US/CA) | [U] |
| Shopify Magic / Sidekick | Yes; **Urdu not confirmed** | [U] |
| Agentic storefronts / Agentic plan | Unknown for Pakistan | [U] |

---

## 4. Feature inventory (parity checklist)

This inventory feeds the PARITY rows of our [Feature Catalog](../product/02-feature-catalog.md).

| Area | Shopify capabilities (2026) |
|---|---|
| Online store | Online Store 2.0: JSON templates, sections everywhere, app blocks, metafield dynamic sources; **Horizon** theme family with nestable **theme blocks** [P]; Dawn and Skeleton reference themes [P]; AI store builder [U]; blog, pages, 3-level menus [P], redirects, SEO tooling, domains, password page, consent banner, policy generator [U] |
| Catalogue | Up to 2,048 variants per product (3 options) [U]; Liquid returns 250 variants unpaginated [P]; metafields and metaobjects [U/P]; standard product taxonomy; bundles (Cart Transform); gift cards and store credit; subscriptions (selling plans); digital downloads; collections; multi-location inventory with states, transfers and purchase orders [U] |
| Checkout | One-page checkout; Checkout Extensibility (UI extensions via **Remote DOM** with a component allowlist [P]); branding API; Web Pixels; **Functions** (Wasm): cart/checkout validation, cart transform, delivery and payment customisation, unified discounts, order routing (fulfilment constraints, location rules, pickup-point generators) [P]; Scripts deprecated (shutdown reported for June 2026) [U]; discounts with combination rules; accelerated checkouts; abandoned checkout recovery; Checkout Kit v4 (alpha) with an "Embedded Checkout Protocol" [P] |
| Orders | Draft orders, editing, fulfilment orders, partial fulfilment, returns and exchanges, refunds, tags, timeline, fraud analysis (plan-gated), packing slips, bulk actions [U] |
| Shipping | Profiles and zones; flat/free/weight/price rates; carrier-calculated rates; local delivery, pickup, pickup points; Shopify Shipping labels (select countries) [U] |
| Customers & B2B | New customer accounts (passwordless OTP), Customer Account API; Customer Account MCP [P]; segmentation; B2B (companies, catalogues, price lists, quantity breaks, payment terms), historically Plus [U] |
| Marketing | Shopify Email, Forms, marketing automations, **Flow** (now on paid plans), Audiences (Plus US/CA), Collabs, Shop Campaigns, attribution [U] |
| Analytics | Customisable dashboard, live view, reports library, ShopifyQL explorations, custom reports on Advanced+ [U] |
| International | Markets (currency, pricing, language, domains), Translate & Adapt, Managed Markets via Global-e [U] |
| POS | POS Lite included; POS Pro $89/location [P]; omnichannel inventory, staff PINs, BOPIS, POS UI extensions [U] |
| Channels | Online store, Shop app, Buy Button, headless, POS, Facebook & Instagram, Google & YouTube, TikTok, Pinterest, Snapchat, Marketplace Connect, Shopify Collective; **agentic storefronts** (ChatGPT, Copilot, Google AI Mode, Gemini, Perplexity, Shop app) [P] |
| Inbox | Web chat, Shop/Messenger/Instagram messages, AI-suggested replies [U]; storefront AI chat via MCP (reference app uses Claude) [P] |
| Staff | Plan-based staff limits [P]; granular permissions; collaborator accounts; SSO on Plus [U] |
| Apps | 10k+ apps; Billing API; "Built for Shopify"; revenue share 0% on first $1M lifetime, then 15% [U]; extensions for themes, checkout, customer accounts, admin, POS; Functions; Web Pixels; Flow [U/P] |
| APIs | Quarterly versions (`2024-10`…`2026-10`) [P]; GraphQL Admin API (REST legacy since Oct 2024; GraphQL-only for new public apps since Apr 2025) [U]; cost-based rate limits; Storefront API; webhooks via HTTPS, Pub/Sub, EventBridge; bulk operations [U] |
| Headless | Hydrogen (React Router-based; 2026.4.5 stable, 2026.10 preview proxies UCP and Storefront Agent traffic) [P]; Oxygen hosting on Cloudflare **workerd** [P] |
| AI | Shopify Magic (copy, images, replies); **Sidekick** admin assistant (reasoning, voice) [U]; Knowledge Base app for agent answers [U]; Dev MCP and AI Toolkit for coding agents [P] |
| Finance | Balance, Capital, Credit, Bill Pay, Tax: none available in Pakistan [U] |

---

## 5. Editions & the agentic-commerce timeline

| When | What | Tag |
|---|---|---|
| Dec 2024 | Winter '25 Edition (reported as "The Boring Edition": 150+ core improvements) | [U] |
| May 2025 | Summer '25 ("Horizons"): Horizon themes and theme blocks, AI store builder, Sidekick upgrades, developer and storefront MCP | [P]/[U] |
| Sep 2025 | OpenAI launches Instant Checkout in ChatGPT on the **Agentic Commerce Protocol (ACP)**, with Stripe | [U]; ACP repo [P] |
| Dec 2025 | **Winter '26: Agentic Storefronts**: "Sell your products everywhere AI conversations happen" | [P] |
| 11 Jan 2026 | **UCP** first release | [P] |
| 8 Apr 2026 | UCP: cart building, catalogue search, OAuth 2.0 identity linking | [P] |
| 17 Apr 2026 | ACP latest stable spec (cart, feed, orders, authentication, MCP) | [P] |
| 2026 | **Agentic plan** ($0/month; Catalog + agentic storefronts for non-Shopify merchants) | [P] |
| 25 Aug 2026 | UCP: food and lodging, store location lookup, **3-D Secure**, deferred payments, **split payments** | [P] |
| Sep 2026 | Hydrogen 2026.10 preview proxies UCP; Shopify `ucp-cli` supports the April and August UCP versions | [P] |

**UCP facts [P]:** an open standard (Apache-2.0) covering catalogue search, cart, identity linking,
checkout (native or embedded), order management and payment-token exchange. Transports are REST and
JSON-RPC, with MCP, A2A and AP2 integration. Co-developers: **Google, Shopify, Etsy, Wayfair,
Target, Walmart, Amazon, Microsoft, Meta, Salesforce, Stripe**, plus 50+ endorsers. Shopify's Ilya
Grigorik sits on the governance council.

**Per-store agent endpoints on Shopify [P]:** a Storefront MCP at `https://{store}/api/mcp` with no
auth (tools: `search_shop_catalog`, `search_shop_policies_and_faqs`, `get_cart`, `update_cart`); a
Customer Account MCP (OAuth; order status); and a UCP discovery profile at `/.well-known/ucp`.

**Implication:** agent-readable catalogues and checkout are becoming table stakes. Hatti's plan is
in [Architecture 09 §5](../architecture/09-ai-and-intelligence.md).

---

## 6. App costs & total cost of ownership

App prices are indicative 2024–25 listings **[U]**; verify on apps.shopify.com.

| Category | Examples | Typical USD/month | Pakistan relevance |
|---|---|---|---|
| COD order form | EasySell, Releasit | free–$30 | Very high |
| COD verification / fees / fake-order blocking | Releasit COD Fee, WhatsApp confirmation apps | $5–30 + messages | Very high |
| WhatsApp chat & notifications | Chat widgets, notification apps | free–$50 + messages | High |
| Reviews | Judge.me, Loox | $0–15 | Medium-high |
| Upsell / cross-sell | ReConvert, FBT, Rebuy | $5–30 (Rebuy $99+) | Medium |
| Loyalty | Smile.io, BON, Rivo | $0–49 | Low-medium |
| Email/SMS marketing | Shopify Email, Klaviyo, Omnisend | $0–45 (small list) | Medium |
| Page builder | PageFly, GemPages | $0–29 | Medium |
| Size chart | Kiwi and similar | $5–15 | Medium (apparel) |
| Wishlist | Swym and similar | $0–20 | Low |
| SEO / images | TinyIMG, Booster | $0–35 | Medium |
| Courier booking/tracking (PK) | Courier and aggregator apps | often free; aggregators $5–20 | Very high |
| Themes | Theme Store paid themes | $180–400+ one-time | — |

**TCO scenarios (USD/month):**

| Scenario | Plan | Apps + theme | Fixed total | On top |
|---|---|---|---|---|
| A. Lean COD starter | Basic yearly $29 | ≈ $10 | **≈ $39–45** (≈ PKR 11–13k) | 2% of prepaid GMV; MDR; FX |
| B. Typical fashion DTC | Basic monthly $39 or Grow yearly $79 | ≈ $126–146 | **≈ $165–225** (≈ PKR 46–63k) | 1–2% of prepaid; MDR; messages; FX |
| C. Scaling brand | Grow $79 or Advanced $299 | ≈ $315–565 | **≈ $400–865** | 0.6–1% of prepaid; MDR; FX |

---

## 7. Architecture lessons we adopt

| Lesson | Evidence | Hatti decision |
|---|---|---|
| Modular monolith with enforced boundaries | Packwerk still maintained (v3.3.1, Aug 2026) [P]; "Deconstructing the Monolith" [U] | ADR-001 |
| Shop-sharded pods (cells) | `job-iteration` README: jobs interrupted safely "when moving tenants between shards" [P]; pods posts [U] | ADR-003 |
| Online tenant moves | **Ghostferry**: selective copy between MySQL instances with minimal downtime, TLA+-specified [P] | Shop Mover (architecture 03) |
| Circuit breakers & bulkheads | **Semian** [P] | Resilience patterns (architecture 12) |
| Fault injection | **Toxiproxy**, in all Shopify dev/test environments since 2014 [P] | Fault injection in CI |
| Read-through caching, tolerant of staleness | **IdentityCache** [P] | Versioned read models |
| Safe merchant templates | **Liquid**: non-eval; render-score and output-length limits [P] | ADR-006 |
| Separate storefront renderer | Storefront Renderer posts [U] | Storefront renderer service |
| Sandboxed extensibility | Functions → Wasm (Javy for JS) [P]; UI extensions via Remote DOM allowlist [P] | Functions, UI extensions (architecture 08) |
| CDC/event log | Kafka on Kubernetes; Debezium CDC [S/U] | ADR-005 |
| APIs as a product | Quarterly versions; cost-based limits [P/U] | ADR-008 |
| Edge headless runtime | Oxygen on workerd [P] | Cloudflare edge (ADR-007) |

**BFCM scale** (unverified; don't quote): 2024 sales ≈ $11.5B, peak ≈ $4.6M/min; edge peaks in the
hundreds of millions of requests per minute [U].

---

## 8. Implications for Hatti

1. **0% platform fee** on COD and on merchant gateways; native local payments; no "double-dipping"
   on prepaid orders.
2. **Built-in COD risk tooling, couriers and WhatsApp** (Shopify merchants pay roughly $20–60+/month
   in apps for these alone) [U].
3. **PKR billing**, Urdu admin and storefront, tax invoices.
4. **Parity baseline:** one-page checkout, discount engine, rich variants, metafields/metaobjects,
   sections/blocks themes, staff roles, draft orders, returns/exchanges, local delivery/pickup,
   analytics, catalogue feeds, AI copy tools, and **agent-readable catalogues (MCP/UCP)**.

---

## 9. To verify

1. Exact third-party fees (Advanced 0.6% vs 0.5%; Plus; Starter) and Plus pricing.
2. Pakistan pricing: PPP pricing, the $1 trial, tax on bills; Starter availability without Shopify
   Payments.
3. Agentic plan fees and eligibility for merchants without Shopify Payments.
4. Per-feature country availability (Shop Pay, Capital, Shipping, Tax, Managed Markets, POS hardware).
5. Edition contents (Winter '25 → Summer '26); variant and location limits; Scripts shutdown date.
6. App prices for the categories in §6.

---

## 10. Sources

* Pricing: https://www.shopify.com/pricing · https://help.shopify.com/en/manual/intro-to-shopify/pricing-plans/plans-features
* Third-party transaction fees: https://help.shopify.com/en/manual/your-account/manage-billing/billing-charges/types-of-charges/third-party-charges/third-party-transaction-fees
* Manual payments: https://help.shopify.com/en/manual/payments/manual-payments
* Local-currency billing: https://help.shopify.com/en/manual/your-account/manage-billing/paying-your-bills/managing-payments/local-currency
* Free trial: https://www.shopify.com/free-trial-offer
* Agentic plan: https://help.shopify.com/en/manual/intro-to-shopify/pricing-plans/plans-features/shopify-agentic-plan
* Winter '26 Edition: https://www.shopify.com/news/winter-26-edition-agentic-storefronts
* Shopify Pakistan blog (costs, gateways): https://www.shopify.com/pk/blog/ecommerce-website-cost · https://www.shopify.com/pk/blog/best-payment-gateways
* UCP: https://github.com/Universal-Commerce-Protocol/ucp · ACP: https://github.com/agentic-commerce-protocol/agentic-commerce-protocol
* Storefront MCP reference: https://github.com/Shopify/shop-chat-agent · https://github.com/Shopify/claude-for-commerce-examples
* Horizon / Skeleton / Dawn: https://github.com/Shopify/horizon · https://github.com/Shopify/skeleton-theme · https://github.com/Shopify/dawn
* Liquid: https://github.com/Shopify/liquid · Functions: https://github.com/Shopify/function-examples · Remote DOM: https://github.com/Shopify/remote-dom
* Packwerk: https://github.com/Shopify/packwerk · Ghostferry: https://github.com/Shopify/ghostferry · job-iteration: https://github.com/Shopify/job-iteration
* Semian: https://github.com/Shopify/semian · Toxiproxy: https://github.com/Shopify/toxiproxy · IdentityCache: https://github.com/Shopify/identity_cache
* Hydrogen: https://github.com/Shopify/hydrogen · API versions: https://github.com/Shopify/shopify-app-js
* bSecure on Shopify costs: https://www.bsecure.pk/blog/how-much-does-shopify-cost
* COD app market share: https://easysellapp.com/blogs/wiki/shopify-cash-on-delivery-setup-guide
