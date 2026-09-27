# 03 · Local Ecosystem: Payments, Logistics, Messaging, Tax & Infrastructure

> **Status:** Research snapshot · **Compiled:** 2026-09-27 · Not legal or tax advice.
>
> **Confidence tags:** **[P]** primary (regulator/gazette/official docs or official code, incl.
> faithful mirrors) · **[C]** seen in production code of a major implementation or official SDK ·
> **[M]** 2026 academic measurement data · **[S]** reputable secondary source or search extract of a
> primary page · **[3P]** vendor/community/blog · **[U]** unverified. Many Pakistani government,
> regulator and news sites could not be opened from the research environment. Treat [S]/[3P]/[U]
> items as leads to confirm; see §9.

---

## 1. Key takeaways

| Area | What it means for Hatti |
|---|---|
| **Payments** | Licensed PSPs with real APIs exist: **Safepay** (full licence 2025; public pricing 2.9% + Rs 30) and **PayFast** (2021). **JazzCash** and **Easypaisa** have direct gateways with wallet-linking recurring debits. **Raast** is the strategic rail (742M txns/quarter; 2.6M+ merchants), and Safepay exposes a public **Raast aggregator API**. Integrating merchants' own accounts needs **no licence**; holding funds does (PSP/EMI, PKR 200M capital). |
| **Logistics** | Five couriers have usable APIs (**PostEx, Leopards, TCS, Trax, M&P**); webhooks are rare (poll); every courier has its own city codes (mapping layer required). Some APIs are plain HTTP with credentials in URLs. A crowded aggregator layer already monetises shipping. |
| **Messaging** | WhatsApp is per-message, billed **in USD** (utility ≈ $0.015 ≈ PKR 4; marketing ≈ $0.047). **From 1 Oct 2026**, service replies are charged beyond 1,000 free per number per month. In-WhatsApp payments are not available in Pakistan. Coexistence with the Business app is supported. Two-way SMS is limited; branded sender IDs need registration. |
| **Tax** | Since July 2025: income tax withheld on online sales (1% digital / 2% COD; doubled for non-filers from July 2026), 2% sales tax collected, mandatory registration for sellers, monthly statements (STR-34/35/36), and a **Rs 200k COD cash cap**. FBR **digital invoicing** is mandatory for sales-tax-registered persons (via licensed integrators, ≤ 3 whitelisted IPs, 72-hour edit window). |
| **Legal** | No data protection law is enacted yet (a 2023 draft localises "critical personal data"). PECA 2025 creates a social media regulator whose definitions may reach platforms with user-generated content. |
| **Hosting** | The nearest hyperscaler regions (AWS UAE and Bahrain) were **physically damaged in March 2026** and impaired for months. There is no hyperscaler region in Pakistan. Measured latency: in-country 2–40 ms, Gulf 20–50 ms, Singapore 90–130 ms, Europe 130–200 ms. Submarine-cable faults (8 since 2024) multiply international latency 2–6×. |

---

## 2. Payments

### 2.1 Providers

| Provider | Licence / type | Methods | Pricing | Recurring / tokens | Refund API | Platform model | Plugins | Tag |
|---|---|---|---|---|---|---|---|---|
| **Safepay** | SBP PSP, full commercial licence Apr 2025 | Visa/MC; Easypaisa & Abhi wallets; bank accounts via NIFT/PayFast; **Raast** | **2.9% + Rs 30 domestic; 3.2% + Rs 30 international** (+tax); no setup/monthly fees | Card subscriptions (plans), tokenisation | Dashboard; API (3P); Raast refunds limited to technical/duplicate reasons | **Raastwire aggregator API**: sub-merchants settled to own IBAN, per-merchant rate cards incl. tax withholding fields, QR, request-to-pay, payouts | Shopify app; WooCommerce (v2.3, May 2026); Magento | [P]/[S] |
| **PayFast (APPS)** | SBP PSO/PSP commercial licence May 2021 (first gateway) | Cards (incl. UnionPay/PayPak), wallets, bank accounts; claimed first Raast P2M | Not published (3P: ~1.5–3%) | [U] | [U] | Serves "aggregators" | [U] | [S]/[3P] |
| **JazzCash** | Wallet operator; direct merchant contracts | Mobile wallet, OTC voucher, cards (3DS) | "As per agreement" | **Wallet linking + token debits**; card tokens | **Mandatory** (cards + wallet); status inquiry mandatory | `pp_SubMerchantID` field | Official plugins; many community | [P] |
| **Easypaisa** (easypaisa Bank, digital retail bank since Jan 2025) | Bank | Wallet, OTC token, cards (hosted) | Per-transaction only (not published) | "Pinless" wallet linking (3P code) | Portal reversals; API unclear | [U] | WooCommerce, Magento, others | [P]/[3P] |
| **Bank Alfalah (APG)** | Bank acquirer | Alfa Wallet & account (API), cards (redirect); Raast P2M QR & RTP | Not published | [U] | [U] | [U] | Community WooCommerce | [P] |
| **HBLPay** | Bank acquirer | Visa/MC/UnionPay; HBL & partner accounts/wallets; multi-currency (PKR, USD, CAD, GBP, AED, EUR) | Not published | Card tokenisation | Yes (API + portal) | [U] | Official WooCommerce (CVE-2025-14875 up to v5.0.0) | [P] |
| **XPay (XStak)** | Orchestration over Alfalah, HBL, PayFast; licence not found | Cards | [U] | [U] | [U] | Multi-acquirer routing | Shopify, WooCommerce | [P]/[U] |
| **Paymob Pakistan** | In-principle PSO/PSP approval Nov 2024; later stage [U] | Wallets, cards | [U] | Group-level tokens | [U] | [U] | [U] | [P]/[3P] |
| **EMIs** (NayaPay, SadaPay, Finja, others) | SBP EMIs | Own wallets | [U] | [U] | NayaPay: no refund API (3P) | [U] | [U] | [S] |
| **BNPL** (BaadMay; Alfa BNPL; QisstPay status unclear) | NBFC/bank partners [U] | 3-instalment BNPL (BaadMay) | [U] | — | [U] | — | [U] | [3P] |
| Stripe / PayPal / Checkout.com | **Not available** to Pakistan-domiciled merchants | — | — | — | — | — | — | [U] |

**Onboarding reality:** Safepay accepts **sole proprietors** with a declaration (NTN + bank
maintenance certificate; docs take 1–2 weeks to gather) [P via S]. JazzCash needs CNIC + NTN [P].

### 2.2 Raast (SBP instant payments)

* **Scale:** Q3 FY26 (Jan–Mar 2026) 742M transactions, PKR 23.27 trn; **> 2.6M merchants** onboarded
  or with aliases [P via S].
* **Instruments available to platforms** (via Safepay's aggregator API) [P]: **Request-to-Pay Now**
  (1–180 min expiry), **Request-to-Pay Later** (1–40 days; invoices and subscription renewals),
  **dynamic QR** (single use), **static QR**, **payouts** (merchant settlement, COD remittance,
  vendor payouts), **refunds** (only for technical problems or duplicates), title fetch.
* **Fees:** SBP circular 03/2025 funded **0.5% (max PKR 100)** per P2M **QR** transaction from 1 Sep
  2025 to 30 Jun 2026, and allowed institutions to charge merchants **up to 0.25%**. The regime
  **after June 2026 is unverified** [P via S].
* **Integration routes:** (1) aggregator API (Safepay) with KYB per merchant and batch settlement to
  merchant IBANs, the recommended route; (2) bank merchant Raast products (Bank Alfalah, Mashreq
  digital bank from Aug 2026); (3) DIY IBAN-based QR (P2P-style, no confirmation), acceptable only
  as a "manual bank transfer" option.

### 2.3 Regulation & money-flow models

| Model | What Hatti does | Licence? | Status in plan |
|---|---|---|---|
| **(a) Connector** | Merchant signs with the PSP; Hatti stores credentials and routes payments; funds go PSP → merchant | **None** (software service; confirm with counsel) | **MVP** |
| **(b1) Partner-led platform payments** | Hatti onboards merchants into a licensed PSP/EMI aggregator programme; the PSP does KYB and settles to each merchant's IBAN; Hatti earns rev-share | None for Hatti if it never holds or controls funds (analysis) | **Growth** ("Hatti Payments") |
| **(b2) Own collection & settlement** | Funds land with Hatti, which settles merchants | **Yes**: PSO/PSP (PKR 200M paid-up capital; cannot hold customer money) or **EMI** (payments aggregation / e-commerce escrow, PKR 200M+); 12–18+ months | Not planned |
| **(c1) COD remittance** | If Hatti receives courier cash and on-remits, that looks like handling third-party funds | Regulated (analysis) | Couriers remit directly; or a licensed PSP's payouts |
| **(c2) COD advances / BNPL** | Lending | SECP NBFC licence [U] | Partners only (Scale) |

Key instruments: Payment Systems & EFT Act 2007; PSO/PSP Rules 2014; EMI Regulations (revised June
2023: payments aggregation and domestic e-commerce escrow are permitted services); SBP Technology
Risk Management Framework for payment institutions (Oct 2025); SBP regulatory sandbox (first cohort
Jan–Jun 2026; one theme was remote merchant onboarding) [P via S].

### 2.4 Collecting Hatti's own subscription fees in PKR

| Method | Automation | Notes |
|---|---|---|
| Card subscriptions (Safepay) | Full | Many SME owners lack cards; test debit-card enablement |
| **JazzCash wallet linking + token debit** | Full after one-time MPIN + OTP link | Best fit for SMEs; needs recurring enabled on our merchant account |
| Easypaisa pinless linking | Full after OTP link | Eligibility to confirm |
| **Raast Request-to-Pay Later** | Semi (customer approves within days) | Ideal for renewals and dunning |
| Raast QR / bank transfer | Manual | Annual plans |

### 2.5 Cross-border

International cards via Safepay (3.2% + Rs 30; presentment in PKR, USD, GBP, AED, EUR, CAD, SAR) and
HBLPay (multi-currency) [P]. JazzCash is PKR-only [P]. Offshore-entity workarounds (Stripe Atlas
etc.) carry FX, tax and repatriation risk and are **not suitable as a platform design** [U].
Diaspora "pay-by-remittance" partnerships are a later option.

---

## 3. Logistics

### 3.1 Courier capability matrix

| Courier | Booking | Label | Tracking | Cancel | Cities | Rates | COD payment status | Re-attempt (shipper advice) | Webhooks | Auth | COD remittance | Tag |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **PostEx** (owns Call Courier since 2022) | ✓ | ✓ | ✓ bulk | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | `token` header | **Same-day "upfront" payment** (financing) | [P]/[S] |
| **Leopards** | ✓ single + batch | ✓ | ✓ | ✓ | ✓ numeric IDs | ✓ | ✓ | ✓ | ✗ | API key + password | **Weekly** | [P]/[S] |
| **TCS** | ✓ | ✓ | ✓ | ✓ | static list | ? | ? | ? | ✗ | Newest API: client credentials → bearer (three API generations coexist) | ~7–15 days | [P]/[3P] |
| **Trax (Sonic)** | ✓ (incl. try-and-buy) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ per consignment | ? | **✓ (unsigned; token in URL)** | API key header | ? | [P] |
| **M&P** | ✓ (bulk ≤ 49/call) | ✗ | ✓ | ✓ (before load sheet) | by name | ✗ | reports | ✗ | ✗ | user/pass in payload; **plain HTTP** | ? | [P] |
| **BlueEx** | ✓ | ✓ | ✓ | ✓ + reverse pickup | codes | ✓ | ✓ settlement | ? | ✗ | Basic auth + key | ? | [P] |
| **Call Courier** | ✓ (via GET query) | ✓ | ✓ | ✗ | city + area IDs | ✗ | ? | ? | ✗ | login + password | ? | [P] |
| **Rider** | ? | ✓ | ✓ | ✓ | ? | ? | ? | ? | ✗ | **credentials in URL over HTTP** | ? | [P] |
| **Swyft** | ? | ? | public tracking | ? | ? | ? | ? | ? | ? | ? | ? | [P]/[U] |
| **Daewoo FastEx** | ? | ? | ✓ | ? | ? | ? | ? | ? | ? | none (tracking) | ? | [P] |
| **Pakistan Post** | no API | — | site scraping only | — | postcodes | tariffs | VPL/VPP (money order) | — | — | — | slow | [P]/[U] |

**Engineering implications:** poll with bulk tracking and adaptive intervals; maintain a canonical
city table with per-courier mappings (nightly refresh); route all courier calls through a
server-side egress proxy and never log URLs with credentials; model rates as `base(weight, zone) +
fuel surcharge % + COD fee (% or min) + sales tax + return fee`; build the re-attempt loop via the
courier's shipper-advice endpoints where they exist.

### 3.2 API reference notes (for integration engineers)

| Courier | Base / notes |
|---|---|
| PostEx | `https://api.postex.pk/services/integration/api/order/` (v1–v3 endpoints: create-order, track-order, track-bulk-order, cancel-order, get-operational-city, generate-load-sheet, get-invoice (AWB), payment-status, shipper advice); rates at `…/api/shipment/v1/calculate-charges` |
| Leopards | `https://merchantapi.leopardscourier.com/api/` (staging `merchantapistaging…`): bookPacket, batchBookPacket, trackBookedPacket, cancelBookedPackets, getAllCities, getTariffDetails, getPaymentDetails, generateLoadSheet, shipperAdviceList, addShipperAdvices |
| TCS | Newest: `https://ociconnect.tcscourier.com` (sandbox `devconnect…`): auth (client id/secret → bearer), booking create/cancel, print label, tracking. Older IBM API Connect and SOAP generations still exist; confirm which one each merchant account uses |
| Trax (Sonic) | `https://sonic.pk/api/`: shipment book/track/status/cancel/air_waybill/charges/payments; city list; rate calculation; webhook without HMAC |
| M&P | `http://mnpcourier.com/mycodapi/api/`: InsertBookingData, InsertBulkBookingData (≤ 49), Generate_LoadSheet, VoidConsignment, tracking, Get_Cities; ask for HTTPS |
| BlueEx | JSON API with basic auth + account number + key; tariff, settlement, reverse pickup, load sheet |
| Daraz (marketplace) | `https://api.daraz.pk/rest`: app key + per-seller OAuth + HMAC-signed requests; products, orders, logistics, finance |

Community libraries such as the open-source *ShipDrill* (MIT) wrap several couriers and are useful
references [P].

### 3.3 Aggregators and OMS tools (competitors or partners)

Courierify (free ≤ 300 bookings/month, then $9.99/$19.99 tiers), Universal Courier (Devsol),
ShipKarDo, WeShip, Flaship (instant COD wallet), Run Courier, ShipUp ("COD e-commerce OS"),
CashOnDelivery.com.pk, TrackKaro, ParcelGrid [S]. **Monetisation patterns:** booking-tier SaaS,
margins through master courier accounts, float on instant-COD wallets, resold WhatsApp credits.

### 3.4 Address & city data

* Couriers each use their own city lists and codes, so a **canonical city + per-courier mapping**
  is mandatory [P].
* Open datasets exist (e.g. a CC-BY dataset of 7 provinces, 160 districts and 577 tehsils with
  postal codes; provenance not stated, so validate) [P].
* Addresses are landmark-based; postcodes are rarely used. The pattern is a city dropdown, area,
  landmark and an optional map pin.
* **TPL Maps** (local mapping with SDKs and Places) has a developer portal with unpublished pricing.
  Google Maps covers major cities well but is weaker at house level [P]/[U].

---

## 4. Messaging

### 4.1 WhatsApp Business Platform: pricing (Pakistan)

| Category | Rate (USD per delivered message) | ≈ PKR (@280) | Notes |
|---|---|---|---|
| Marketing | **0.0473** | ≈ 13 | Unchanged across sources |
| Utility | **≈ 0.015** (after 1 Apr 2026 update) | ≈ 4.2 | Some sources still show 0.0100 |
| Authentication | ≈ 0.015 | ≈ 4.2 | |
| Service (free-form replies in the 24 h window) | Free until 30 Sep 2026; **from 1 Oct 2026 charged at the utility rate after 1,000 free per number per month** | | Click-to-WhatsApp ad entry windows stay free for 72 h |

* Per-message pricing has been live since **1 Jul 2025**. Meta changes rates only at quarter starts.
  **Pakistan is billed in USD** (PKR is not a billing currency) [P mirrors; 3P for the Pakistan
  row]. Confirm the Pakistan row on Meta's official rate card before hard-coding.
* **Coexistence:** a business can keep using the **WhatsApp Business app** on the same number while
  a platform uses the Cloud API (unsupported only in Nigeria and South Africa) [P mirror].
* **Commerce:** catalogues, carts and Flows are available; **payments inside WhatsApp are India and
  Brazil only** [P mirror].
* **Messaging limits:** new portfolios start at 250 unique users per 24 h outside the service
  window, scaling to 2k → 10k → 100k → unlimited with verification and quality [P mirror].
* **Policies:** explicit opt-in naming the business; utility templates containing marketing content
  are re-categorised as marketing; from 15 Jan 2026, general-purpose AI assistants are restricted
  (business-specific bots such as order confirmation are not the target) [P mirror].
* **Providers:** Twilio adds ~$0.005/message; 360dialog uses a flat licence with no per-message
  markup; other providers typically mark up ~15% [3P]. Local Pakistani providers are unverified.
  Becoming a Meta Tech Provider/partner lets us bill merchants in PKR.

### 4.2 Blocks and outages (plan fallbacks)

| Date | Event | Tag |
|---|---|---|
| 25–26 Nov 2017 | Social media incl. WhatsApp Web blocked during the Faizabad sit-in | [P] (OONI) |
| 9–12 May 2023 | Nationwide mobile-data shutdown after Imran Khan's arrest | [P] (Cloudflare) |
| 8 Feb 2024 | Election-day mobile shutdown 07:00–20:00 | [P] (Cloudflare) |
| Jul–Aug 2024 | National "firewall" rollout; slowdowns; widely reported WhatsApp media failures | [S]/[U] |
| Nov 2024 | Protest-related mobile-data suspensions; VPN registration push | [S]/[U] |

SMS usually survives app throttling and mobile-data shutdowns, but not full cellular suspensions.
**Never auto-cancel COD orders for "no response" during an outage window.**

### 4.3 SMS, IVR, email

* **SMS rules:** branded sender IDs need pre-registration on some networks (about 15 days on Jazz);
  **two-way SMS is generally unsupported**; P2P traffic on A2P routes is prohibited; opt-in, DNC and
  STOP handling are expected [P mirror of Twilio's guidelines]. PTA's 2009 spam regulations and the
  Do-Not-Call register are [U].
* **Operators and aggregators with APIs:** Telenor, Zong, Ufone and Jazz corporate SMS; Veevo Tech,
  SendPK, LifetimeSMS, Branded SMS Pakistan (whose WooCommerce plugin already does COD OTP) [P].
  Indicative price **PKR 0.30–1.50 per segment** [U: get quotes]; Urdu Unicode uses 70-character
  segments.
* **IVR** ("press 1 to confirm"): telco and aggregator voice broadcast products; budget PKR 1–5 per
  30-second call [U: get quotes].
* **Email:** Gmail dominates [U]; engagement is low compared with WhatsApp. Use email for
  receipts, invoices and account messages, following Gmail/Yahoo bulk-sender rules.

---

## 5. Social commerce & marketplaces

| Channel | Status in Pakistan | Tag |
|---|---|---|
| Facebook/Instagram checkout | Not available | [U] |
| Instagram product tagging / Shops | Historically not supported in Pakistan | [U] |
| Catalogue ads, Click-to-WhatsApp ads | Work; CTWA opens a 72-hour free window | [U]/[P] |
| TikTok Shop | Not launched (TikTok ads and content available) | [U] |
| Google free listings / Shopping | Likely available; verify | [U] |
| Daraz | Open Platform API for products, stock, orders and logistics | [3P] |

---

## 6. Tax, legal & compliance

### 6.1 Timeline

| Date | Event | Tag |
|---|---|---|
| 26 Jun 2025 | Finance Act 2025 (effective 1 Jul 2025): new e-commerce income tax (s.6A), sales-tax collection on online sales, DPPT Act | [S] |
| 30 Jul 2025 | SRO 1366(I)/2025: **DPPT not applied** to digitally ordered goods/services supplied from abroad (retroactive) | [S] |
| 1 Aug 2025 | SRO 1413(I)/2025: **digital invoicing** obligation for all sales-tax-registered persons | [P] |
| 4 Aug 2025 | SRO 1429(I)/2025: e-commerce rules; monthly **STR-34/35/36** statements; registration gatekeeping | [S] |
| Aug 2025 | Income Tax Circular 02 of 2025-26: **Rs 200,000 cash cap** applies to COD orders | [S] |
| 30 Mar 2026 | Sales Tax General Order 01/2026: multiple licensed integrators allowed; **72-hour** edit/cancel window | [P] |
| 26–27 Jun 2026 | Finance Act 2026 (effective 1 Jul 2026): non-filer rates doubled; final/adjustable election by turnover | [S] |

### 6.2 Income tax on online sales (ITO s.6A; collected under s.153)

| Tax year | Digital payment (collected by payment intermediary) | COD (collected by courier) |
|---|---|---|
| TY2026 (FA 2025) | 1% | 2% |
| TY2027 (FA 2026), filers | 1% | 2% |
| TY2027 (FA 2026), non-filers | **2%** | **4%** |

Final tax under FA 2025. FA 2026 made it adjustable above Rs 200M turnover, with an opt-out for
smaller sellers [S; verify against the Act]. Collectors file statements and issue deduction
certificates to sellers [S].

### 6.3 Sales tax on online sales

* **2% of gross value** of digitally ordered goods, collected by the payment intermediary or courier
  [S]. **Final discharge** for cottage industry and non-Tier-1 retailers; an advance against the
  standard **18%** liability for others [S].
* **Registration:** every person selling digitally ordered goods must register (s.14(1A)).
  Marketplaces and couriers may not serve unregistered sellers; penalties are **Rs 300k, then Rs 1M
  per default** [S]. Exemptions for one-time sellers and home-based women sellers were signalled but
  are [U].
* **Monthly statements by the 10th:** STR-34 (online marketplaces), STR-35 (payment
  intermediaries), STR-36 (couriers) [S].

### 6.4 Is Hatti a "marketplace" or an "intermediary"? (analysis)

* **Base case:** Hatti is a SaaS; each merchant is seller of record on its own storefront, and money
  flows through the merchant's own PSP account (or a PSP sub-merchant account). The merchant is the
  taxable seller; the PSP or courier is the withholding agent. Hatti is plausibly neither
  [analysis/U].
* **Risk 1:** a cross-merchant discovery app or mall could make Hatti an **online marketplace**
  (STR-34 filing + registration gating).
* **Risk 2:** collecting and settling funds would make Hatti a **payment intermediary** (withholding
  duties + SBP licensing).
* **Action:** a written tax opinion before launch. Build registration gating as a switch from day
  one.

### 6.5 Taxes on foreign digital services (context for Shopify users)

* **DPPT** (5% on foreign vendors with significant digital presence) is enacted but switched off by
  SRO 1366 since July 2025. It could return [S].
* **s.236Y advance tax** on card payments abroad: 5% (filers) / 10% (non-filers) since 2023; a
  2026 cut to 0.5%/1% is reported but unverified [S]/[3P].
* Offshore digital services fees are taxed under s.6 (rate raised to 15% in FA 2025) [S]. Sindh
  appoints banks as collecting agents for sales tax on imported IT and advertising services [S].

### 6.6 FBR integrations (technical)

**Digital invoicing (DI)** [P]/[C]:

* Mandatory for sales-tax-registered persons through **licensed integrators** (PRAL is free; others
  reportedly charge Rs 1,500–10,000/month) [P]/[3P].
* Business flow: IRIS → Digital Invoicing → API integration → choose integrator → **whitelist up to
  3 IPs** → receive a Bearer token (5-year, bound to the NTN) → sandbox scenarios → live [3P]/[C].
* API: `https://gw.fbr.gov.pk/di_data/v1/di/postinvoicedata` and `validateinvoicedata` (sandbox
  `_sb` variants); reference data (provinces, HS codes, UoM, SRO items) under
  `https://gw.fbr.gov.pk/pdi/v1/…` (spec v1.12) [C].
* Payload essentials: seller/buyer NTN or CNIC, province, registration type; items with HS code, UoM,
  rate, values, sales tax, withheld amounts, SRO references, sale type [C].
* Printed invoices carry the **FBR invoice number, QR code and FBR DI logo**. Edits or cancellations
  are allowed only **within 72 hours** in FBR's system, then credit/debit notes [P].
* Real-world pattern: Odoo proxies DI and POS calls through fixed egress IPs, a model a multi-tenant
  SaaS can copy [C].

**Tier-1 retailer POS** [C]: register POS in IRIS → POSID + token → post each sale to
`https://gw.fbr.gov.pk/imsp/v1/api/Live/PostData` → FBR returns an invoice number printed as a QR;
a Rs 1 service fee per invoice is commonly added; receipts reference verification via the Tax Asaan
app or SMS 9966. Whether online sales of Tier-1 retailers must flow through POS/DI is [U]; a Feb 2026
FBR mandate headline mentions online sellers [S].

**Becoming a licensed integrator** is legally possible; the criteria are unverified [U]. Start as
merchants' software via PRAL.

### 6.7 Provincial sales tax on Hatti's own SaaS fees

| Jurisdiction | Standard rate on services | Tag |
|---|---|---|
| Punjab (PRA) | 16% (reduced IT rates cited under conditions) | [S]/[U] |
| Sindh (SRB) | 15% | [S] |
| Khyber Pakhtunkhwa (KPRA) | 15% | [3P] |
| Balochistan (BRA) | 15% | [3P] |
| Islamabad (FBR) | 15% or 16% (sources conflict) | [3P] |

Register where the business is based; cross-province origin vs destination disputes persist, so get
adviser sign-off. Corporate customers may withhold income tax on services. **IT export incentives**
(PSEB registration; 0.25% final tax on export proceeds) apply if we sell abroad later [3P].

### 6.8 Data protection & online-business law

* **Personal data protection:** **no law enacted** as of May 2026. The 2023 cabinet-approved draft
  would create a regulator, restrict transfers abroad, and bar **"critical personal data"** from
  leaving Pakistan. A revised draft was unpublished at research time [3P/S]. Sector regulators (SBP,
  PTA) already localise their licensees' data [S].
* **PECA 2016:** service-provider liability shield, no general monitoring duty, **traffic-data
  retention of at least 1 year**, PTA blocking powers [S].
* **PECA (Amendment) Act 2025** (gazetted 29 Jan 2025) [P]: creates the **Social Media Protection
  and Regulatory Authority** (enlistment, blocking, directives, fines), a complaint council and a
  tribunal; a false-information offence (up to 3 years or Rs 2M); the **National Cyber Crime
  Investigation Agency**. Its "social media platform" definition covers platforms where users post
  content viewed by others. A store builder with reviews and Q&A **might** be caught, so a legal
  opinion is needed.
* **Electronic Transactions Ordinance 2002:** electronic records and contracts are valid; keep
  click-wrap logs [S].
* **E-commerce policy:** still the 2019 policy (physical address requirement proposed; no licensing
  regime); Policy 2.0 (2025–30) in draft [S].
* **Consumer protection:** provincial acts (ICT 1995, KP 1997, Balochistan 2003, Punjab 2005, Sindh
  2014) apply to online sales, covering price display, receipts, warranties and defective goods
  [S]/[U].
* **Cloud First Policy (2022)** and MoITT cloud accreditation (in-country data centres) bind
  **government-serving** providers, not private SaaS [S].
* **PTA content rules (2021):** 48-hour (12-hour emergency) takedown compliance for social media
  companies; significant platforms must register and localise [S]. **VPN/IP whitelisting
  registration** is required for business VPNs [S].
* **Business setup:** SECP private limited company; PSEB registration for IT/ITeS benefits; Special
  Technology Zone incentives [3P].

---

## 7. Hosting & network

### 7.1 The 2026 Gulf region events

* **1 Mar 2026:** drone strikes damaged AWS facilities: two in **UAE (`me-central-1`)** directly
  struck and one in **Bahrain (`me-south-1`)** damaged. AWS advised customers to back up and migrate
  [P (Cloudflare Q1 2026 disruption summary citing Reuters/CNBC); S (The Register, Fortune)].
* **23 Mar 2026:** Bahrain disrupted again [P citing Al Jazeera].
* **30 Apr 2026:** AWS: `me-central-1` "is currently unable to reliably support customer
  applications" [P (Cloudflare Q2 summary)].
* **17 Sep 2026:** reports of **permanent data loss** in a UAE zone and Bahrain fully offline, with
  recovery timelines into 2027 [S (secondary reports citing DCD, Help Net Security)].
* No reports of damage to Azure UAE, GCP Doha/Dammam or Oracle Gulf regions, but they share the
  same regional risk. Pakistan also saw **up to ~7 hours/day of load-shedding** in April 2026 from
  the related LNG shortage [S].

### 7.2 Regions & measured latency

| Destination | Typical RTT from Pakistan (2026 measurements) | Notes | Tag |
|---|---|---|---|
| Hosted inside Pakistan | **2–40 ms** | Depends on peering with PTCL and Transworld | [M] |
| Gulf (Dubai/Muscat PoPs) | **20–50 ms** | Best proxy for Gulf cloud regions | [M] |
| Singapore | 60–90 ms floor; **90–130 ms** in practice | Daraz (Alibaba) and a major bank are served from Singapore | [M] |
| Europe | 130–200 ms | | [M] |
| Mumbai | Not measured; routes detour; political risk | Avoid | [U] |

No hyperscaler region or local zone inside Pakistan was found as of Sep 2026 [C].

### 7.3 Cloudflare in Pakistan

* PoPs confirmed in **Karachi, Lahore, Islamabad** [M].
* **Local edge ≠ local serving:** some ISPs (e.g. PTCL and smaller ISPs) were served from Singapore or
  Muscat for some sites, while Nayatel users consistently hit Islamabad [M].
* Cloudflare is **not a member of Pakistan's internet exchanges** (PKIX, PIE Karachi) [M].
* Cloudflare for SaaS custom hostnames: first 100 free, then $0.10/hostname/month [3P: verify].
  **Test serving colos from Pakistani ISPs before committing.**

### 7.4 Disruptions timeline (selected)

| Date | Event | Impact | Tag |
|---|---|---|---|
| 17 Jun 2024 | SEA-ME-WE-4 fault | 1,500 Gbps lost | [M] |
| 31 Jul 2024 | ~2 h nationwide disruption | PTCL near-total loss | [P] |
| 2 Jan 2025 | AAE-1 fault near Qatar | Median latency 80 → 125 ms | [P] |
| 19 Aug 2025 | PTCL/Ufone outage | −90% traffic for hours | [P] |
| 6 Sep 2025 | Red Sea cuts (SMW4 + IMEWE) | −25–30% traffic in Sindh and Punjab | [P] |
| 20 Oct 2025 | PEACE cable cut | −50% on some ISPs | [P] |
| 2 Jul 2026 | SMW5 fault | International RTT 2–6× for ~2 weeks; **in-country traffic unaffected** | [M]/[P] |

8 cable faults since 2024 [M]. Shutdowns are mostly mobile-only and last hours to days; cable faults
degrade international latency but rarely black out the country.

### 7.5 Local data centres & clouds

Candidates to evaluate (all [U]): PTCL, Jazz Garaj cloud, Nayatel, Multinet, Cybernet/StormFiber,
Wateen, Rapid Compute, Zong, Huawei Cloud's Pakistan presence. **Check:** tier certification, power
redundancy (generators with fuel contracts, N+1 UPS, run-hour history), multi-homing to PTCL,
Transworld and Nayatel, S3-compatible storage, managed Kubernetes/databases, pricing in PKR.

### 7.6 Recommendation

Launch in **Singapore** (stable, mature managed services) behind Cloudflare with cross-region backups
in Europe. Avoid AWS UAE/Bahrain; do not run any Gulf region as primary in 2026. Add a **multi-homed
Pakistani Tier-III data-centre cell** once SLAs and power resilience are proven, or when regulation or
customers require residency. Keep FBR and courier traffic on fixed egress IPs. Decision record:
[ADR-015](../architecture/13-decision-log.md).

---

## 8. .pk domains

PKNIC runs `.pk` (WHOIS `whois.pknic.net.pk`); its policy has **no local-presence requirement**;
second-level options include `.com.pk`, `.net.pk`, `.org.pk`. Registration has historically been in
2-year minimum terms; one reseller lists PKR 3,500 per two years (undated). **No PKNIC API or global
registrar support** was found, so `.pk` purchases are assisted flows; `.com` can use registrar
partner APIs [P]/[3P].

---

## 9. Verification backlog (priority)

1. Written **tax opinion**: marketplace/intermediary classification; registration gating duties.
2. **Finance Act 2026** text: s.6A rates and election; 236Y rates; any platform duties.
3. Legal opinion on **PECA 2025** definitions and on **network risk signals** (privacy basis).
4. **Raast P2M pricing after June 2026**; Safepay/PayFast platform partnership terms.
5. Courier **rate cards and payout terms** (PostEx, Leopards, TCS, Trax, M&P) under partnership talks.
6. Meta's official **Pakistan rate card** and the 1 Oct 2026 service-message changes.
7. SMS and IVR price quotes from two aggregators; PTA SMS regulations text.
8. **Latency bake-off** from Pakistani ISPs (Globalping/RIPE Atlas) incl. Cloudflare colo selection.
9. Local data-centre due diligence for the PK cell.
10. FBR licensed-integrator criteria.

---

## 10. Selected sources

**Payments:** Safepay pricing https://getsafepay.pk/pricing · Safepay Raast API https://github.com/getsafepay/raast-docs ·
Safepay licence https://profit.pakistantoday.com.pk/2025/04/21/safepay-granted-full-commercial-license-by-sbp-to-operate-as-payment-service-provider/ ·
PayFast licence https://propakistani.pk/2021/05/25/payfast-becomes-first-pakistani-payment-gateway-to-get-commercial-license-from-sbp/ ·
JazzCash onboarding pack (mirror) https://github.com/shaqilabs/pay-bridge/tree/main/docs/JazzCash ·
easypaisa digital bank https://www.sbp.org.pk/press/2025/Pr-28-Jan-2025.pdf ·
Raast P2M subsidy circular https://www.sbp.org.pk/psd/2025/c3.htm ·
EMI regulations (revised 2023) https://www.sbp.org.pk/circulars/pspod-circular-no-03-of-2023 ·
PSO/PSP rules https://www.sbp.org.pk/psd/2014/C3-Annex.pdf ·
HBLPay CVE https://www.wordfence.com/threat-intel/vulnerabilities/id/06362518-f2ee-485f-9e0e-1b1ada9c72db

**Logistics:** PostEx COD https://postex.pk/cod · Leopards COD https://www.leopardscourier.com/business/ecommerce-retail_cod ·
TCS plugins https://www.tcsexpress.com/plugins · ShipDrill https://github.com/Tech-Andaz/ShipDrill ·
Courierify https://www.courierifyapp.com/ · Pakistan admin divisions dataset https://github.com/open-admin-data/pakistan-administrative-divisions ·
TPL Maps https://api.tplmaps.com/apiportal

**Messaging:** Meta WhatsApp pricing https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing ·
Twilio Pakistan SMS guidelines https://www.twilio.com/en-us/guidelines/pk/sms · OONI 2017 report https://ooni.org/post/how-pakistan-blocked-social-media/

**Tax & legal:** SRO 1429(I)/2025 https://download1.fbr.gov.pk/SROs/2025858833282SRO1429DATED04-08-2025.pdf ·
Sales Tax Circular 02 of 2025-26 https://download1.fbr.gov.pk/Docs/202584118361586CircularNO02of2025-26SalesTax&FederalExcise.pdf ·
STGO 01/2026 https://download1.fbr.gov.pk/Docs/2026331133557466STGO01of2026.pdf ·
SRO 1366(I)/2025 (DPPT) https://download1.fbr.gov.pk/SROs/20257302072529390SRO1366(I)2025.pdf ·
KPMG withholding note https://kpmg.com/us/en/taxnewsflash/news/2025/11/tnf-pakistan-withholding-tax-and-filing-requirements-for-digitally-ordered-goods.html ·
KPMG Finance Act 2026 brief https://assets.kpmg.com/content/dam/kpmgsites/pk/pdf/2026/07/A%20Brief%20of%20Finance%20Act%202026.pdf.coredownload.inline.pdf ·
Quarterly filings by couriers and payment intermediaries https://profit.pakistantoday.com.pk/2025/08/29/fbr-mandates-quarterly-tax-filings-for-couriers-payment-intermediaries/ ·
E-commerce Policy 2019 https://www.commerce.gov.pk/wp-content/uploads/2019/11/e-Commerce_Policy_of_Pakistan_Web.pdf ·
Cloud First Policy https://moitt.gov.pk/SiteImage/Misc/files/Pakistan%20Cloud%20First%20Policy-Final-25-02-2022.pdf ·
PTA VPN registration https://www.pta.gov.pk/category/vpn-registration-process-55198854-2024-11-18

**Hosting & network:** AWS drone-strike coverage https://www.cnbc.com/2026/03/02/amazon-says-drone-strikes-damaged-3-facilities-in-uae-and-bahrain.html ·
https://www.theregister.com/2026/03/02/amazon_outages_middle_east/ ·
https://www.aljazeera.com/news/2026/3/24/amazon-says-aws-bahrain-region-disrupted-following-drone-activity ·
https://www.datacenterdynamics.com/en/news/aws-unable-to-restore-access-to-data-centers-hit-by-iran-strikes/ ·
Pakistan internet measurements https://github.com/msaqib/pkinternet ·
PTA SMW5 restoration https://www.pta.gov.pk/category/pta-confirms-full-restoration-of-smw5-submarine-cable;-internet-services-normalized-253423352-2026-07-06
