# 01 · Market Research: Pakistan E-commerce

> **Status:** Research snapshot · **Compiled:** 2026-09-27
>
> **How to read this.** Every fact carries a confidence tag:
> **[P]** primary source (regulator, official document or first-party data), read directly or through a
> faithful mirror · **[S]** reputable secondary source, or a search extract of a primary page ·
> **[3P]** third-party/vendor/community source · **[U]** unverified (background knowledge or
> inference) · **[DNS]** observed directly by resolving store domains on 2026-09-27.
>
> **Method and limits.** Desk research on 27 Sep 2026 using web search and public code
> repositories. Many primary sites (sbp.org.pk, dawn.com, brecorder.com and others) could not be
> opened from the research environment, so several figures come from search extracts of those pages.
> Verify the items in §10 before quoting externally.

---

## 1. Key takeaways

1. **Market:** online physical-goods retail is about **US$5–8 bn (2024–25), growing 10–20%/yr**.
   Broader definitions (travel, food, services) reach ~$14 bn. The government's draft e-commerce
   policy targets $20 bn by 2030.
2. **Payments rails exist, merchants aren't on them:** 92% of retail payments are digital by volume,
   and there are 2.6M+ Raast merchant aliases. Yet only **~17.5k e-commerce merchants** accept
   online payments. Almost all small online sellers run without a gateway.
3. **COD rules checkout:** ~60–70% of orders nationally, ~80% on Daraz, 90%+ for social-traffic DTC
   stores. **RTO of 18–30%** and heavy pre-dispatch cancellations destroy margin.
4. **Shopify is the default:** **~68%** of 102 sampled Pakistani brand stores (and **~79% of fashion
   brands**) run on Shopify. The real competition is Shopify plus a layer of local add-on apps.
5. **Shopify's model penalises Pakistan:** USD billing, no Shopify Payments (so a 2% extra fee on
   prepaid orders on Basic), and an app stack for COD, couriers and WhatsApp.
6. **Policy is pushing digital:** since July 2025, withholding on COD orders is double that on
   digital payments, and sellers must register for tax.

---

## 2. Market size

| Source | Metric | Value | Period | Definition | Tag |
|---|---|---|---|---|---|
| ECDB | B2C e-commerce revenue | **US$5.78 bn**; growth 10–15% | 2025 | Physical goods only | [S] |
| Statista (via extract) | eCommerce revenue | ~US$5.78 bn; electronics largest (~23%), fashion second | 2025 | Physical goods | [S] |
| Research & Markets / PayNXT360 | B2C e-commerce GMV | **US$14.11 bn** (+13.2%); **$20.41 bn by 2029** | 2025 | Broad: includes travel, food, services | [S] |
| Ministry of Commerce, draft e-Commerce Policy 2.0 (2025–30) | Target | **US$20 bn by 2030** | target | Policy target | [S] |
| SBP (payments-based) | Digital e-commerce payments | ~PKR 0.9 trn/yr run-rate (≈ $3.2 bn) in H1 2025 | quarterly | Digital payments only; excludes COD; includes digital services | [P via S] |

**Planning anchor:** about US$5–8 bn physical-goods e-commerce, growing 10–20% per year.

---

## 3. Digital adoption

### 3.1 Connectivity & devices

| Indicator | Value | Date | Tag |
|---|---|---|---|
| Internet users | **117M** (45.6% penetration) | end-2025 (DataReportal 2026) | [S] |
| Cellular connections | 194M (75.9% of population) | end-2025 | [S] |
| Broadband subscriptions | 166M (162M mobile + 3.7M fixed) | Jul 2026 (PTA, extract) | [S] |
| 4G coverage | 95% of cell sites 4G-enabled | PTA Annual Report 2024–25 | [S] |
| Smartphone penetration | > 56% | PTA Annual Report 2024–25 | [S] |
| Median mobile download | **24.3 Mbps** (+24% YoY) | Aug 2025 (Ookla via DataReportal) | [S] |
| Median fixed download | 16.3 Mbps | Aug 2025 | [S] |
| Locally assembled phones | 25.1M in Jan–Oct 2025: **53% smartphones, 47% 2G feature phones**; top brand Infinix | 2025 (PTA via PhoneWorld) | [S] |
| Android share | Historically ~90%+ of mobile web | — | [U] |

**Implications:** design for low/mid-range Android on ~24 Mbps connections with data-cost
sensitivity. The large feature-phone tail means SMS/IVR fallbacks remain necessary.

### 3.2 Social platforms (discovery channels)

| Platform | Reach | Tag |
|---|---|---|
| TikTok | **79.9M adults**: the largest platform | [S] DataReportal 2026 |
| Facebook | ≈ 53M ad reach (DataReportal); 68–69M (NapoleonCat, 2026); ~75% male | [S] |
| Instagram | 22–24M | [S] |
| YouTube | 56–72M (conflicting) | [S] |
| WhatsApp | No official figure; estimates 52–105M; near-universal among smartphone users | [U] |

Social-discovery orders show higher RTO (**22.7%**) than search-intent orders (**14.2%**) in one
large retailer's 2025–26 data [3P].

### 3.3 Digital payments

| Indicator | Value | Date | Tag |
|---|---|---|---|
| Retail payments | 3.7 bn txns; PKR 168.8 trn; **92% digital by volume** | Q3 FY26 (Jan–Mar 2026) | [P via S] |
| Mobile-app payments | 2.9 bn txns (78% of digital) | Q3 FY26 | [P via S] |
| **E-commerce merchants** | **17,554 (+92% YoY)** | Mar 2026 (single extract; verify) | [S] |
| Card e-commerce | 32.3M txns, PKR 0.14 trn in the quarter | Q3 FY26 | [P via S] |
| E-commerce by channel | 93% account/wallet-based (FY25); 95% bank/wallet vs 5% cards (Q2 FY26) | FY25–26 | [P via S] |
| Raast | **742M txns, PKR 23.3 trn** in the quarter; **2.6M+ merchant aliases** | Q3 FY26 | [P via S] |
| QR merchants | 1.09M (839k on Raast P2M QR) | FY25 | [P via S] |
| JazzCash | **60M registered; 29.2M active** (Q1 2026) | May 2026 (VEON) | [P] |
| Easypaisa | ~20M MAU; 59M+ registered; Pakistan's first digital retail bank | FY2025 results | [S] |

**The acceptance gap:** 2.6M Raast merchant aliases → 1.09M QR merchants → 159k POS merchant
locations → **~17.5k e-commerce merchants**. Sellers pay with wallets and Raast in daily life, but
their online stores can't accept them.

---

## 4. The COD reality

| Metric | Value | Source | Tag |
|---|---|---|---|
| COD share nationally | **60–70%** of orders | MoC draft e-Commerce Policy 2.0 | [S] |
| COD on Daraz | **~80%** (20% prepaid) | ProPakistani, Sep 2025 | [S] |
| COD for one large Shopify retailer | 94.5% of ~170k orders | Retailer report 2026 | [3P] |
| National RTO | **18–30%**, some stores 35%+ | Industry blogs | [3P] |
| Single-retailer RTO | 19–22% every month (Jul 2025–May 2026) | Retailer report | [3P] |
| COD orders cancelled before dispatch | **37.3%** | Retailer report | [3P] |
| Failed first delivery attempts | 18–25% (vs 12–15% global) | Logistics market report 2026 | [3P] |

**How merchants fight it today:** confirmation calls, SMS OTP, WhatsApp confirmation, screening
incomplete addresses, blacklists shared in seller groups [U], advance delivery charges for new
customers [U], PostEx's upfront COD cash, and Daraz's **"COD Plus"** (pay digitally at the door,
launched July 2025) [S].

**Courier remittance:** Leopards pays weekly [S]; TCS about 7–15 days [3P]; PostEx sells same-day
"upfront" COD [S]. Working capital locked in COD is a recurring complaint [3P].

---

## 5. Policy shift toward digital payments

Since 1 July 2025 (Finance Act 2025), **payment intermediaries withhold 1%** of digitally paid
online sales and **couriers withhold 2%** of COD sales as income tax. From FY2026-27 these rates
double for non-filers. **Sales tax of 2%** is also collected on both channels; sellers must register;
and marketplaces, payment intermediaries and couriers file monthly statements. Details and sources:
[Local Ecosystem §6](./03-local-ecosystem.md#6-tax-legal--compliance).

---

## 6. Who sells online: segments & platforms

### 6.1 Platform evidence (DNS, 2026-09-27)

| Brand | Platform |
|---|---|
| Khaadi, Sapphire | Salesforce Commerce Cloud |
| Gul Ahmed/Ideas, J. (Junaid Jamshed), Outfitters, Limelight, Breakout | Shopify |
| Broader sample | **69 of 102 stores (~68%) on Shopify**; **54 of 68 fashion brands (~79%)**; footwear 7/8; home 3/3; beauty 3/6; electronics 1/6; grocery 1/5 |
| Marketplaces | Daraz (Alibaba infrastructure), HomeShopping (VTEX) |
| Restaurants | OPTP, 14th Street Pizza → Blinkco; Savour Foods → Odoo; others custom |

Several brands run **separate domestic and international Shopify stores**, which shows real
demand for diaspora selling [DNS].

### 6.2 Segments

| Segment | Profile | Current tools |
|---|---|---|
| Enterprise fashion/lifestyle | Omnichannel chains, international stores | SFCC or Shopify/Plus |
| Mid-sized DTC brands | Fashion, footwear, beauty, home; heavy Meta/TikTok ads; COD-heavy | Shopify + local COD/courier/WhatsApp apps |
| Social sellers (SMEs, home-based) | Likely hundreds of thousands [U]; DM/WhatsApp orders; many women-led | WhatsApp Business, Instagram, Facebook; some WooCommerce |
| Resellers / dropshippers | Share catalogues on WhatsApp; earn margins | Reseller apps (e.g. Markaz); Shopify dropshipping |
| Daraz sellers | ~80% COD | Daraz Seller Center |
| Restaurants / grocery | Direct ordering, delivery | Blinkco, Tossdown [U], custom builds |

---

## 7. Competitive landscape

| Type | Players | Notes |
|---|---|---|
| Global platforms | **Shopify** (dominant), WooCommerce, Wix, Squarespace, BigCommerce, Ecwid | USD pricing; no Pakistan-specific payments/couriers |
| Local store builders | Dukan.pk (exists; details unverified), Tossdown and Blinkco (restaurants) | Thin; several names from lists (Shopdesk, Storekit, Oyester, Ebizmart) **not found**; webstore.pk is itself on Shopify [DNS] |
| **Local add-on layer** | COD forms, courier aggregators and OMS (Courierify, WeShip, Flaship, ShipUp, ShipKarDo, Orio, ShipNOC, TrackMyOrder), WhatsApp API vendors, one-click checkout (bSecure), gateways (Safepay, PayFast, XPay) | **The "app tax" a local platform can bundle** |
| Marketplaces | Daraz | ~80% COD; COD Plus |
| Reseller apps | Markaz | Social reselling with fulfilment |

**Regional analogues** (profiles from background knowledge [U]; verify pricing/funding): **Salla**
and **Zid** (Saudi Arabia: local currency, own payments and shipping, COD, app ecosystems,
e-invoicing), **YouCan** (Morocco: COD-first with confirmation call-centre integrations),
**Dukaan** and **Instamojo** (India: free or low-cost stores monetised through payments), **Take App**
(WhatsApp-first), **EasyStore** and **Shopline** (SEA). **The shared playbook:** local-currency
pricing with a free tier, own or bundled payments, COD as a core flow, shipping aggregation,
WhatsApp-native selling, local-language RTL, app marketplaces, built-in compliance, and financing.

---

## 8. Shopify in Pakistan

| Topic | Finding | Tag |
|---|---|---|
| Plans | Basic $39 ($29 yearly), Grow $105 ($79), Advanced $399 ($299); Plus from ~$2,300–2,500 | [S] |
| Currency | **USD billing**; no PKR billing or Pakistan-specific pricing found (India has INR prices) | [S] |
| Shopify Payments | **Not available in Pakistan** | [S] |
| Fees | Third-party gateway fee 2% / 1% / 0.6% by plan on prepaid orders; **COD and other manual methods: no Shopify fee** | [P via S] |
| Effective prepaid cost | ≈ **3.8–5.3%** on Basic (2% Shopify + 1.8–3.3% gateway MDR) | [S, derived] |
| Paying a USD bill | s.236Y advance tax on foreign card payments: **5% filers / 10% non-filers** (a 2026 cut is reported but unverified) + bank FX spread; DPPT suspended since July 2025 | [S] |
| FX | ~PKR 155/USD (mid-2021) → ~280 (2024–26) | [U] |
| Ecosystem | Big freelancer/agency and dropshipping-training community; Pakistan is the **#2 market for COD-app stores** on Shopify (11.9%) | [U]/[S] |

Full benchmark: [02 · Shopify Benchmark](./02-shopify-benchmark.md).

---

## 9. Merchant pain points

| Pain point | Evidence | Tag |
|---|---|---|
| COD refusals & RTO | 18–30% RTO; 37% pre-dispatch cancellations; social traffic RTO 1.6× search | [3P] |
| Fake/prank orders | Common; confirmation workflows everywhere | [3P] |
| Failed delivery & addressing | 18–25% first-attempt failure | [3P] |
| Courier delays, lost parcels, slow remittance | Upfront-COD products exist because of it | [3P]/[U] |
| USD costs & volatility | USD plans + USD apps + advance tax + FX | [S]/[U] |
| Payment gateway onboarding friction | 17.5k e-merchants vs 2.6M Raast merchants; MDR 1.8–3.3% | [S] |
| Tax confusion | New withholding, registration and statements since July 2025 | [S] |
| Customer trust | Scam stores, empty-box stories; COD as a trust hedge | [S]/[3P] |
| Slow and disrupted internet | 24 Mbps median; shutdowns and slowdowns 2023–25 | [S]/[P] |
| No Urdu admin/support | Shopify admin not in Urdu | [U] |
| "App tax" & fragmentation | COD form + courier + tracking + WhatsApp + checkout apps | [DNS]/[U] |

---

## 10. Opportunities (ranked)

1. **COD risk engine in checkout:** OTP, WhatsApp/IVR confirmation, address scoring, a
   privacy-safe cross-merchant refusal network, partial advance.
2. **Digital payment as the easy, cheaper path:** Raast/wallet checkout with **no platform fee**,
   COD-to-digital at the door, customer incentives.
3. **PKR pricing and billing** with a free tier.
4. **Bundle the Pakistan app stack** into the core product.
5. **Courier aggregation, faster COD remittance, COD reconciliation**, and advances via partners.
6. **WhatsApp-native commerce.**
7. **A tax and compliance autopilot** for the new withholding regime.
8. **An Android-first, low-bandwidth, Urdu experience** that stays resilient to disruptions.
9. **A tier for social sellers and resellers.**
10. **Shopify migration + a local partner and app ecosystem.**

---

## 11. Verification backlog

1. SBP PS Review Q3 FY26: e-commerce merchant count (17,554), channel splits, Raast figures.
2. Finance Act 2026 changes to e-commerce withholding, 236Y rates, DPPT status.
3. PTA July/August 2026 indicators; DataReportal 2026 platform numbers; StatCounter Android share.
4. The count of Shopify stores in Pakistan (StoreLeads/BuiltWith).
5. Daraz seller commissions and fees; courier payout terms (merchant interviews).
6. Dates and impact of the 2023–24 internet shutdowns and WhatsApp restrictions (partly confirmed
   in [Local Ecosystem §7](./03-local-ecosystem.md#7-hosting--network)).

---

## 12. Selected sources

* SBP Payment Systems Review Q3 FY26: https://www.sbp.org.pk/psd/pdf/PS-Review-Q3FY26.pdf
* SBP Annual Payment Systems Review FY25: https://www.sbp.org.pk/PS/PDF/Annual-Payment-Systems-Review-FY25.pdf
* SBP press release, 3 Nov 2025: https://www.sbp.org.pk/press/2025/Pr-03-Nov-2025.pdf
* ECDB Pakistan: https://ecdb.com/resources/sample-data/market/pk/all
* Research & Markets Pakistan B2C e-commerce: https://www.researchandmarkets.com/reports/6191228/pakistan-b2c-ecommerce-market-size-and-forecast
* MoC draft e-Commerce Policy 2025–30: https://www.commerce.gov.pk/wp-content/uploads/2025/06/draft-e-Commerce-Policy-2025-30-for-stakeholders.pdf
* DataReportal Digital 2026 Pakistan: https://datareportal.com/reports/digital-2026-pakistan
* PTA Annual Report 2024–25: https://pta.gov.pk/category/pta-releases-annual-report-2024%E2%80%9325-1374704410-2026-01-01
* JazzCash 60M customers (VEON, May 2026): https://www.investing.com/news/company-news/jazzcash-reaches-60-million-users-processes-597-billion-93CH-4688815
* Easypaisa FY2025 results: https://propakistani.pk/2026/03/10/easypaisa-digital-bank-reports-profit-after-tax-of-rs-17-04-billion-for-2025/
* Daraz a decade (COD share): https://propakistani.pk/2025/09/12/a-decade-of-daraz-pakistan-pioneering-e-commerce-and-shaping-access-trust-and-opportunity/
* Daraz COD Plus: https://www.nation.com.pk/25-Jul-2025/daraz-pakistan-introduces-cod-plus-as-step-towards-cashless-e-commerce-ecosystem
* Retailer data (OrderNation 2026): https://www.ordernation.com/blogs/research/state-of-online-shopping-pakistan-2026
* RTO benchmarks: https://trackmyorder.pk/blog/shopify-tips/cod-return-rate-pakistan-shopify
* Logistics market report 2026: https://www.icargos.com/post/pakistan-courier-logistics-market-report-2026
* KPMG on withholding for digitally ordered goods: https://kpmg.com/us/en/taxnewsflash/news/2025/11/tnf-pakistan-withholding-tax-and-filing-requirements-for-digitally-ordered-goods.html
* DPPT suspension: https://www.dawn.com/news/1927776
* PostEx upfront COD: https://postex.pk/cod
