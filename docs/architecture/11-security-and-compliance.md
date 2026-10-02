# 11 · Security, Privacy & Compliance

> **Status:** Draft v0.1 · **Last updated:** 2026-09-27
> Merchants hand us their business and their customers' phone numbers and addresses, and they
> route money through us. Security is a product feature. This document sets the baseline; legal
> points must be confirmed with Pakistani counsel before launch. **Nothing here is legal advice.**

---

## 1. Assets and threats

| Asset | Main threats | Key controls |
|---|---|---|
| Merchant accounts | Credential stuffing, phishing, SIM-swap OTP interception, session theft | Passkeys/TOTP MFA, breached-password checks, device/session management, login alerts |
| Customer PII (phones, addresses) | Cross-tenant leaks, insider misuse, scraping, malicious apps | Tenant isolation layers, permission-gated PII, protected-data scopes for apps, audit logs, rate limits |
| Merchant secrets (gateway, courier, WhatsApp tokens) | Theft via DB compromise or logs | Field-level envelope encryption, write-only UI fields, secrets never logged, rotation reminders |
| Payment flows | Callback spoofing, price tampering, skimming scripts | Signature + inquiry verification, server-side pricing, strict CSP on checkout, no PAN handling |
| Order integrity | Fake COD orders, bots, discount abuse | Risk engine, OTP, velocity limits, Turnstile, per-phone limits. *Built:* the risk rules and the blocklist; a code sent to the number from the shop's risk mark, kept as a digest, limited by checkout and by number ([ADR-148](./13-decision-log.md#adr-148--checkout-asks-a-shopper-paying-on-delivery-for-a-code-sent-to-the-number-they-typed-on-whatsapp-or-by-sms-where-the-shops-risk-rules-score-the-order-at-its-mark-a-digest-of-the-code-alone-is-kept-and-the-order-keeps-when-its-number-was-proved)); checkout's limits by number and by internet address ([ADR-087](./13-decision-log.md#adr-087--checkout-takes-at-most-three-orders-a-day-from-one-mobile-number-and-twenty-an-hour-from-one-internet-address-counting-the-orders-it-placed-one-at-a-time)); attempts at discount codes |
| Storefront integrity | Defacement via compromised accounts, malicious theme/app code | MFA, theme version history and rollback, app review, Liquid sandbox |
| Platform availability | DDoS, flash-sale overload, provider outages, national network disruptions | Cloudflare, waiting room, bulkheads, degradation modes (see [12](./12-scalability-and-reliability.md)) |
| Network risk data | Misuse, inaccurate labels harming shoppers, privacy complaints | Hashing, aggregation, coarse tiers, dispute process, legal review |
| Buyers (trust) | Scam stores collecting prepaid money | Trust & Safety: KYC tiers, prepaid enablement review, anomaly detection, takedowns |

**Threat actors:** fraudsters placing fake orders or taking over accounts, scam "stores",
malicious or careless app developers, scrapers, insiders (including our support staff),
opportunistic attackers, and **infrastructure disruption** (cable cuts, throttling). The last is not
an attacker, but it affects availability in the same way.

---

## 2. Identity & access

### 2.1 Merchant staff

* **Authentication:** passkeys (WebAuthn) preferred; password (argon2id, breached-password check
  via k-anonymity) + **TOTP** as the standard; **SMS OTP only as a recovery fallback**, because of
  SIM-swap risk. *Built:* passkeys sign staff in alone, passing the second factor, or answer the
  second step after a password; adding one takes a session that passed a second factor once the
  account has one ([ADR-100](./13-decision-log.md#adr-100--staff-sign-in-with-a-passkey-alone-which-passes-the-second-factor-or-answer-the-second-step-after-their-password-with-one-once-an-account-has-a-second-factor-only-a-session-that-passed-one-adds-another)).
* **MFA is mandatory** for owners and for any role with finance, payments, staff-management or
  data-export permissions. *Built:* a signed-up user opens a shop of their own, and uses it, its
  owner, once their session passed a second factor; the identity login may insert a shop's ID,
  name and handle, and its `shop.opened` event, and nothing else of shops or the outbox
  ([ADR-145](./13-decision-log.md#adr-145--a-signed-up-user-opens-a-shop-of-their-own-through-the-identity-login-its-name-a-handle-made-from-it-or-chosen-and-never-the-platforms-the-user-its-owner-and-shopopened-for-its-storefront-in-one-transaction)).
* **Sessions:** short-lived access tokens with rotating refresh tokens; a device list with remote
  sign-out; re-authentication for sensitive actions (payout details, API keys, staff roles).
  *Built:* staff who signed in or confirmed who they are over 15 minutes ago confirm it again,
  with the strongest factor their account has, before taking staff on, changing their roles or
  letting them go, handing the shop over, changing where transfers are paid, exporting customers or orders, giving a
  customer their file, erasing a customer, or changing their passkeys or authenticator app; apps
  are not asked ([ADR-103](./13-decision-log.md#adr-103--sensitive-actions-need-staff-to-have-proved-who-they-are-in-the-last-15-minutes-by-signing-in-or-confirming-with-the-strongest-factor-their-account-has-apps-are-not-asked)).
* **Authorisation:** RBAC with granular permissions and custom roles. Typical local roles ship as
  presets: *Owner*, *Manager*, *Confirmation Agent* (sees phones and addresses, can confirm or
  cancel), *Packer* (sees items and shipping labels, **not** customer phone numbers), *Marketer*
  (segments and campaigns; exports need approval), *Accountant* (finance, reconciliation).
  *Built so far:* role presets map to API scopes, and actions that need more than a scope check
  the role too: only owners, managers and accountants export orders, and only owners and
  managers record refunds; each export and refund goes into the audit log
  ([ADR-029](./13-decision-log.md#adr-029--refunds-record-money-staff-sent-back-only-owners-and-managers-make-them)).
  Only owners, managers and apps give an order to someone else or take it from whoever has it;
  other staff take only orders no one has, for themselves
  ([ADR-127](./13-decision-log.md#adr-127--an-order-is-given-to-one-member-of-staff-at-a-time-to-see-it-through-owners-managers-and-apps-give-it-to-anyone-other-staff-take-one-no-one-has-staff-find-theirs-with-assigneeme-and-those-who-leave-give-their-open-orders-back)).
  A comment on an order is its author's to change; owners and managers delete anyone's, and
  an erasure deletes those on the customer's orders
  ([ADR-128](./13-decision-log.md#adr-128--staff-and-apps-comment-on-an-orders-timeline-each-comment-its-authors-to-change-kept-apart-from-the-events-and-read-among-them-every-entry-saying-who-made-it-and-comments-going-with-the-customers-details-in-an-erasure)).
  Staff who change orders change an order's items, delivery charge or discount while it waits to
  be packed, split it, or merge one of a customer's orders into another, and its timeline says who
  did and what changed
  ([ADR-131](./13-decision-log.md#adr-131--an-orders-items-change-while-it-waits-to-be-packed-quantities-set-and-variants-added-in-one-edit-the-lines-kept-keeping-their-prices-its-amounts-and-tax-worked-out-again-and-the-difference-collected-at-the-door-its-stock-committed-and-let-go-at-once),
  [ADR-132](./13-decision-log.md#adr-132--an-order-its-customer-placed-twice-is-merged-into-the-other-while-both-wait-to-be-packed-the-other-takes-its-items-and-discount-and-keeps-its-own-delivery-charge-as-one-parcel-the-order-merged-is-cancelled-as-merged-naming-it-and-counts-for-nothing-in-its-customers-history),
  [ADR-134](./13-decision-log.md#adr-134--an-orders-delivery-charge-and-discount-change-while-it-waits-to-be-packed-as-its-items-do-its-totals-tax-and-cash-at-the-door-following-what-was-taken-off-for-paying-by-transfer-stays-part-of-the-discount-and-the-fee-stays),
  [ADR-135](./13-decision-log.md#adr-135--items-sent-apart-from-an-order-paid-on-delivery-become-an-order-of-their-own-as-its-cash-is-collected-by-order-at-their-prices-with-their-share-of-the-discount-the-rest-of-the-order-as-it-is-and-its-stock-where-it-was-both-orders-scored-as-the-one-their-customer-placed)).
  Owners and managers invite staff by a link and change or remove them, the owner every role but
  its own and managers those below them, and the owner hands the shop to a manager with a second
  factor, staying on as one ([ADR-104](./13-decision-log.md#adr-104--the-owner-hands-the-shop-to-one-of-its-managers-who-has-a-second-factor-and-stays-on-as-a-manager-the-shop-has-one-owner-throughout)); each change on the audit log
  ([ADR-101](./13-decision-log.md#adr-101--owners-and-managers-invite-staff-by-a-link-they-send-themselves-accepted-once-by-a-signed-in-account-the-owner-manages-every-role-but-its-own-managers-those-below-them-apps-none)).
* **PII visibility** is a permission: phone numbers can be masked (`0300-***4567`) with
  click-to-reveal that is logged. *Built so far:* numbers are masked ("0300 ••••567") for every
  staff role but owners and managers; confirmation agents reveal one with `orderPhoneReveal` or
  `customerPhoneReveal`, and each reveal goes into the shop's append-only audit log, with exports,
  merges and erasures ([ADR-027](./13-decision-log.md#adr-027--customers-numbers-are-masked-by-role-and-reveals-go-to-an-append-only-audit-log)).

### 2.2 Hatti employees

* SSO with hardware security keys; **just-in-time**, time-boxed production access; quarterly access
  reviews.
* **Support impersonation** requires the merchant's in-app consent, is time-limited (for example
  60 min), read-only by default, and shown in the merchant's activity log.
* Break-glass accounts are sealed, alarmed and reviewed after every use.

### 2.3 Shoppers

* Phone OTP (WhatsApp authentication template → SMS fallback), rate-limited per phone, IP and
  device; lockouts with exponential backoff; signed device cookies for returning shoppers.
* *Built so far:* no shopper accounts yet. The one credential a shopper holds is a link to a
  draft order or an order: 128 random bits in its path, kept only as a SHA-256 digest, working
  for 72 hours by default and replaced by the next link. Its page runs no scripts, allows only
  its own styles and fonts, is never cached, indexed or framed, and sends no referrer. It shows
  the number masked, and nothing once the link has expired or the customer's details are
  erased; only a POST confirms, cancels or saves a new address, and cancelling asks first. A
  number the shop has cannot be changed through a link (a draft sent without one asks the
  customer for theirs), so a forwarded link can redirect a parcel until it is packed but never
  the courier's call
  ([ADR-031](./13-decision-log.md#adr-031--draft-orders-keep-agreed-prices-and-hold-no-stock-customers-confirm-them-through-a-secret-link),
  [ADR-032](./13-decision-log.md#adr-032--customers-confirm-or-cancel-cash-on-delivery-orders-through-a-link-that-then-follows-the-order),
  [ADR-033](./13-decision-log.md#adr-033--customers-correct-an-orders-address-through-its-link-until-it-is-packed-the-number-stays-the-shops),
  [ADR-034](./13-decision-log.md#adr-034--customers-add-a-drafts-address-and-their-number-while-it-has-none-through-its-link)).

### 2.4 Apps and API clients

* OAuth 2.0 with PKCE; granular scopes; **protected customer data** scopes require justification
  and review; tokens hashed at rest; instant revocation on uninstall; per-app rate limits.

---

## 3. Data protection

| Control | Implementation |
|---|---|
| In transit | TLS 1.2+ (1.3 preferred) everywhere, HSTS with preload for platform domains, mTLS inside the cluster (service mesh or per-service certificates) |
| At rest | Provider-managed encryption for DBs, disks, backups and object storage |
| Field-level | Envelope encryption (AES-256-GCM) for secrets and sensitive PII (CNIC, NTN/STRN, bank details); data keys wrapped by cloud KMS; annual key rotation with re-wrap. *Built:* authenticator seeds, shops' Meta access tokens and their courier and payment gateway accounts' credentials, each sealed for its owner, an account's for that account alone, and opened only where used ([ADR-143](./13-decision-log.md#adr-143--orders-placed-through-checkout-go-to-metas-conversions-api-from-the-worker-as-they-are-placed-confirmed-and-delivered-the-shop-choosing-which-is-purchase-each-moment-waits-in-postgres-until-meta-takes-it-or-its-seven-days-are-up)), [ADR-149](./13-decision-log.md#adr-149--shops-book-orders-with-their-own-courier-accounts-their-credentials-sealed-for-each-account-each-booking-waits-in-postgres-until-the-worker-books-it-through-the-couriers-adapter-keeps-the-couriers-number-before-shipping-the-order-with-it-and-follows-the-parcel-by-asking-the-couriers-words-read-through-mappings-kept-as-data), [ADR-151](./13-decision-log.md#adr-151--shops-take-payments-online-through-their-own-gateway-accounts-safepay-first-their-credentials-sealed-for-each-account-an-order-waiting-for-its-money-offers-to-take-it-on-its-page-a-session-is-recorded-before-the-customer-leaves-for-the-gateway-and-the-gateways-signed-return-or-webhook-whichever-comes-first-records-it-paid-once-and-pays-what-the-order-owes-of-it-a-sandboxs-payments-pay-nothing)) |
| Ad platforms | *Built:* what an order tells Meta's conversions API leaves hashed with SHA-256: the customer's mobile number, email, names, city and postcode, and their ID with the shop; the browser's address and user agent go as Meta asks. Nothing of an erased customer's goes, and the shop's token never leaves the worker but to Meta. The pixel on the shop's pages reads no shopper's details; its cookies reach the server only with an order placed, kept in Meta's format and cleared with the customer's other data. Shops at the platform's subdomains share a registrable domain, where Meta's script keeps its cookies for all of them: the storefronts' domain goes on the Public Suffix List before they use the pixel ([ADR-144](./13-decision-log.md#adr-144--a-shops-storefront-loads-its-meta-pixel-while-meta-is-connected-for-the-steps-shoppers-take-before-checkout-orders-go-from-the-server-alone-each-keeping-the-pixels-browser-and-click-ids-for-them)) |
| Logs | Structured logging with PII scrubbers (phones, emails, addresses, tokens); separate security log stream with restricted access |
| Backups | Encrypted, access-controlled, restore-tested monthly |
| Minimisation | Collect what fulfilment needs; CNIC only for high-value or regulated flows; retention per [03 §11](./03-multi-tenancy-and-data.md) |
| Exports | Customer exports require a permission, are watermarked with the requester and time, and are logged |

---

## 4. Application security (secure SDLC)

| Stage | Practice |
|---|---|
| Design | Lightweight threat model for every feature touching money, PII, auth or multi-tenancy |
| Code | Code review with a security checklist; tenant-scoping helpers are mandatory |
| CI | SAST (CodeQL/Semgrep), dependency audit (OSV; malicious-package detection), secret scanning, IaC scanning, container scanning (Trivy), SBOM + signed images (Cosign) |
| Supply chain | Lockfiles, pinned versions, delayed adoption of freshly published npm versions (pnpm minimum release age), provenance checks, Renovate batches reviewed by humans |
| Test | Cross-tenant access tests on every resolver; authorisation matrix tests; fuzzing of webhook parsers and Liquid filters |
| Pre-release | DAST on staging; external **penetration test before public launch** and annually after that |
| Production | WAF (managed rules + custom rules for GraphQL abuse), bot management, anomaly alerts |
| Community | Responsible disclosure policy from day one; public **bug bounty** from V1 |

**Target standard:** OWASP ASVS Level 2 for the admin, APIs and checkout.

**GraphQL-specific hardening:** depth and complexity limits, cost-based rate limiting,
field-level authorisation for PII fields, persisted queries for public storefront traffic, and
disabled introspection on production storefront endpoints for anonymous clients.

**Webhooks:** a webhook is checked before anything in it is read. WhatsApp's carries the
HMAC-SHA256 of its raw body with the app's secret (`X-Hub-Signature-256`), compared in constant
time; the API keeps raw bodies under `/webhooks/` alone, up to 1 MB. What a webhook names, it
finds across shops only through `SECURITY DEFINER` functions that give back a shop and an ID, and
then acts as that shop under RLS ([ADR-146](./13-decision-log.md#adr-146--a-shops-customers-hear-of-their-orders-from-hattis-shared-whatsapp-number-or-by-sms-where-the-shop-saves-or-whatsapp-cannot-deliver-each-message-waits-in-postgres-queued-once-from-the-orders-events-until-the-worker-sends-it-and-whatsapps-webhook-follows-it-and-hears-customers-ask-to-stop)).
A payment gateway's webhook goes to its account's own address, `/webhooks/payments/{id}`, and is
checked with that account's secret, as its shop: Safepay's carries the HMAC-SHA512 of its body
with the webhook secret (`X-SFPY-SIGNATURE`). A customer coming back from the gateway is trusted
only with the tracker signed with the account's secret key; a gateway's sandbox pays no order,
as anyone may hold its test cards. Money goes back through a gateway only to the payment it came
from, with that account's secret key, recorded before the gateway is asked so that nothing is
given back twice ([ADR-153](./13-decision-log.md#adr-153--money-paid-online-goes-back-through-the-gateway-that-took-it-as-far-as-its-adapter-can-give-it-back-safepay-a-payment-whole-each-refund-is-recorded-before-the-gateway-is-asked-and-written-on-its-order-once-the-gateway-says-it-is-sent-a-refusal-is-said-and-a-refund-without-an-answer-holds-its-amount-until-staff-settle-it-from-the-gateways-dashboard)). A shopper paying at checkout comes back to the checkout's
address on the core, never a storefront, which refuses posts from other sites, and the
storefront relays the gateway's address with no referrer, keeping the checkout's secret off the
gateway's logs ([ADR-152](./13-decision-log.md#adr-152--checkout-offers-paying-online-where-the-shop-has-a-gateway-the-order-is-placed-to-wait-for-its-total-as-a-transfers-does-and-its-thank-you-page-sends-the-shopper-to-the-shops-gateway-which-sends-them-back-to-the-checkouts-address-on-the-core)) ([ADR-151](./13-decision-log.md#adr-151--shops-take-payments-online-through-their-own-gateway-accounts-safepay-first-their-credentials-sealed-for-each-account-an-order-waiting-for-its-money-offers-to-take-it-on-its-page-a-session-is-recorded-before-the-customer-leaves-for-the-gateway-and-the-gateways-signed-return-or-webhook-whichever-comes-first-records-it-paid-once-and-pays-what-the-order-owes-of-it-a-sandboxs-payments-pay-nothing)). Connecting or changing a gateway account
needs staff to have proved who they are lately, as it changes where customers' money goes.

**What shops pay Hatti:** the owner alone chooses a plan or message credit and pays its invoice,
having proved who they are lately, as it spends the shop's money; other staff and apps at most
see it, and the credit's entries are never changed once written. Hatti's own
gateway secrets live in its configuration alone, and its return and webhook are trusted only
signed with them ([ADR-154](./13-decision-log.md#adr-154--shops-pay-hatti-for-a-plan-in-rupees-by-the-month-or-the-year-through-hattis-own-payment-gateway-account-a-bigger-plan-begins-once-its-invoice-is-paid-less-what-is-left-of-the-period-it-cuts-short-a-smaller-one-when-the-period-ends-each-period-is-invoiced-a-week-ahead-and-a-week-unpaid-puts-the-shop-on-free-other-modules-ask-each-plans-limits-through-a-port)).

**Web hardening:** strict CSP on checkout and admin; `frame-ancestors` limits; customers' pages'
forms post to their own site alone, and go on only to the payment gateway's checkout where the
page offers paying online, by its origin (`form-action`); SRI on first-party
assets; cookies `Secure; HttpOnly; SameSite=Lax/Strict`; CSRF tokens on cookie-authenticated
mutations. The one cookie a script writes, `hatti_visits`, holds no secret: the visits that
brought a shopper, which the core checks as anything else a browser sends
([ADR-139](./13-decision-log.md#adr-139--a-shoppers-browser-keeps-the-visits-that-brought-them-the-first-and-the-last-from-elsewhere-checkout-passes-them-on-and-the-order-keeps-them-as-shopifys-customer-journey)).

---

## 5. Payments security & PCI DSS

* **No PAN ever touches Hatti systems.** Card entry happens only on the provider's hosted payment
  page or hosted fields. This keeps merchants eligible for the simplest PCI self-assessment (SAQ A
  type) and keeps Hatti's own scope small.
* Payment pages hosted by Hatti that *redirect to* or *embed* provider payment forms are
  script-controlled: no merchant or third-party JS, an inventory of our scripts with integrity
  monitoring, and change alerts. Confirm current PCI DSS v4.x eligibility criteria with a QSA
  before launch.
* **Partner-powered payments (Growth phase):** when Hatti orchestrates sub-merchant onboarding, we
  obtain a PCI DSS Attestation of Compliance as a service provider appropriate to our role, and
  follow the partner's security and KYC requirements.
* Callback verification, inquiry-before-fulfil, amount and currency matching, and daily
  reconciliation are covered in [05](./05-checkout-and-payments.md).

---

## 6. Trust & Safety

Social commerce in Pakistan suffers from **scam stores**: they collect advance payment and never
deliver. They also hurt honest merchants, because buyers learn to insist on COD. Trust & Safety is
part of the plan from day one.

| Tier | Requirements | Unlocks |
|---|---|---|
| **T0: Unverified** | Phone + email verified | Store live with COD and bank transfer only; "New store" label |
| **T1: Verified individual** | CNIC verification (through a licensed KYC partner), selfie match | Wallet/card payments via the merchant's own gateway; "Verified" badge |
| **T2: Verified business** | NTN / business registration, bank account title match | Partner-powered payments, higher limits, "Verified Business" badge |

* **Signals:** complaint rate, prepaid-to-fulfilment ratio, sudden prepaid spikes, cloned
  catalogues (image hashing), newly created stores advertising "limited time" prepaid deals,
  impersonation of known brands.
* **Actions:** warnings, feature restrictions (prepaid disabled), takedown with an appeal process,
  reporting to authorities where legally required.
* **Buyer reporting:** "Report this store" link in every store footer and order message.
* **Acceptable Use Policy:** prohibited and restricted goods in line with Pakistani law (for
  example weapons, narcotics, prescription medicines without licensing, alcohol, gambling,
  counterfeit goods, content unlawful under PECA). It also covers a notice-and-takedown process
  for IP and counterfeit complaints ("replica" listings of well-known brands are common).

---

## 7. Privacy

* **Roles:** for shop customers' data, the **merchant is the controller** and Hatti the processor.
  For merchant account data, and for the cross-shop network signals Hatti derives, Hatti acts as
  controller. Both roles are stated clearly in the Terms, the Data Processing Addendum and the
  privacy notices.
* **Rights:** per-shop tools and APIs to **export** and **erase or anonymise** a customer's data;
  platform-level request intake for shoppers who contact Hatti directly. *Built so far:*
  `customerErase` deletes a customer's profile, numbers and consent history, and strips their
  orders of name, number, email, street and note, and the notes of their refunds and returns
  ([ADR-136](./13-decision-log.md#adr-136--a-customers-return-of-delivered-items-is-recorded-by-staff-each-item-with-its-reason-and-checked-in-when-it-arrives-each-unit-back-in-stock-where-it-came-back-to-or-written-off-money-given-back-stays-a-refund-and-the-sales-report-counts-what-came-back)), while keeping what the accounts need; it is
  refused while an order is open ([ADR-026](./13-decision-log.md#adr-026--a-customer-can-have-several-numbers-modules-with-customer-data-join-merges-and-erasure)).
  Their draft orders are deleted, found by their numbers and email and through their orders, and
  their receipts for transfers, the files removed from storage by the worker once the erasure
  commits ([ADR-113](./13-decision-log.md#adr-113--an-erased-customers-receipts-leave-storage-too-the-erasure-records-each-orders-receipt-files-in-an-event-and-the-worker-removes-them-once-it-commits)).
  Of the visits that brought them to the shop, the pages they landed on and came from go, which
  may carry an ad's click ID or a search; where each came from and its UTM parameters stay
  ([ADR-139](./13-decision-log.md#adr-139--a-shoppers-browser-keeps-the-visits-that-brought-them-the-first-and-the-last-from-elsewhere-checkout-passes-them-on-and-the-order-keeps-them-as-shopifys-customer-journey)).
  `customerErasureRequest` asks for the same erasure in ten days, which `customerErasureCancel`
  stops until then; the worker's sweep carries it out as the system, waiting while an order is
  open, and the audit log names who asked
  ([ADR-110](./13-decision-log.md#adr-110--a-customers-erasure-can-be-asked-for-ten-days-ahead-and-cancelled-until-then-the-workers-sweep-carries-it-out-as-the-system-naming-who-asked));
  `customerErasureRequests` lists those waiting, the soonest first
  ([ADR-116](./13-decision-log.md#adr-116--the-admin-api-lists-the-erasures-waiting-the-soonest-due-first-with-their-customers-who-asked-stays-in-the-audit-log)).
  `customerDataExport` gives owners and managers the customer's own file to send them, JSON of
  everything erasure would take and the records it would keep: profile, numbers, consent and its
  history, orders whole with the visits that brought them, drafts, uses of discount codes, and
  the messages sent them and their opt-outs. Erasure deletes those messages, found by the
  customer or their numbers, and keeps the opt-outs, so the shop never writes to them by mistake.
  The shop's defences against fraud,
  the blocklist and risk scores, stay out, and each export is on the audit log
  ([ADR-102](./13-decision-log.md#adr-102--a-customers-own-data-is-one-json-file-of-everything-the-shop-keeps-of-them-which-each-module-with-their-data-adds-to-the-blocklist-and-risk-scores-stay-out)).
  Still to come: request intake, and customers asking for their file themselves.
* **Consent:** marketing consent per channel (WhatsApp, SMS, email, push), captured with wording,
  timestamp and source. Unsubscribe keywords are honoured in English, Urdu and Roman Urdu ("STOP",
  "band karo"). *Built so far:* WhatsApp, SMS and email consent with an append-only ledger of
  every change (wording, source, when, for which number or address, and who recorded it); a new
  number or email resets consent. Push consent comes with the storefront. Keyword opt-outs
  (MSG-09): a customer's "STOP", "band karo" or "بند کرو" on WhatsApp stops every message of the
  shop's to their number there, kept through erasure ([ADR-146](./13-decision-log.md#adr-146--a-shops-customers-hear-of-their-orders-from-hattis-shared-whatsapp-number-or-by-sms-where-the-shop-saves-or-whatsapp-cannot-deliver-each-message-waits-in-postgres-queued-once-from-the-orders-events-until-the-worker-sends-it-and-whatsapps-webhook-follows-it-and-hears-customers-ask-to-stop)); the consent ledger is to record it
  too, with campaigns.
* **Network risk signals:** hashed identifiers; only coarse tiers and reason categories are
  exposed; no raw cross-shop order history; a shopper-facing explanation and **dispute
  mechanism**; periodic legal review. This feature launches only after counsel signs off.
* **Sub-processors:** a public list (cloud, CDN, messaging, email, AI provider, KYC partner) with
  change notifications.
* **Design target:** GDPR-grade practices, so we are ready when Pakistan's personal data
  protection law is enacted and for diaspora and EU-facing stores.

---

## 8. Compliance map

Status of laws and rates changes often. See [Research · Local Ecosystem](../research/03-local-ecosystem.md)
for findings with sources and dates.

| Area | Instrument | How it touches Hatti | Our response |
|---|---|---|---|
| Cybercrime & online content | Prevention of Electronic Crimes Act 2016 (as amended) | Unauthorised access and data offences; content obligations; law-enforcement requests | Security controls, AUP, takedown process, legal-request handling procedure |
| E-contracts & e-signatures | Electronic Transactions Ordinance 2002 | Validity of online contracts and checkout acceptance | Clickwrap logging (version, timestamp, IP/device). *Built:* checkout says what placing the order agrees to, and each order keeps the versions of the policies it linked, when, and the address and browser it came from ([ADR-057](./13-decision-log.md#adr-057--what-a-shopper-agrees-to-in-placing-an-order-is-kept-with-it-the-versions-of-the-shops-policies-its-checkout-linked-and-where-it-was-placed-from)); so does a draft's link, for the order its customer confirms there ([ADR-114](./13-decision-log.md#adr-114--a-draft-its-customer-confirms-through-its-link-keeps-what-they-agreed-to-as-checkouts-orders-do-the-page-names-the-shops-policies-above-its-button-and-the-order-keeps-their-versions-and-where-it-was-confirmed-from)), and an order's link, for an order staff or an app placed, keeping when its customer confirmed it ([ADR-115](./13-decision-log.md#adr-115--an-order-staff-or-an-app-placed-keeps-what-its-customer-agreed-to-in-confirming-it-through-its-link-the-page-names-the-shops-policies-and-the-order-keeps-their-versions-where-it-was-confirmed-from-and-when)) |
| Data protection | Personal data protection bill (not enacted as of our research; a 2023 draft restricts transfers of "critical personal data" abroad) | Future obligations: consent, rights, breach notice, cross-border transfer | Build to GDPR-grade now: DPA, rights tooling, breach runbook; the PK-cell option ([10](./10-infrastructure-and-devops.md)) keeps data residency achievable |
| Platform regulation | PECA (Amendment) Act 2025: social-media regulator with blocking powers; traffic-data retention duties for service providers | Whether a store builder with user-generated content falls under "social media platform" definitions needs a legal opinion | Legal opinion before launch; logging/retention policy aligned; takedown workflow |
| Consumer protection | Provincial consumer protection laws | Merchant obligations (disclosures, returns, pricing) | Policy templates, mandatory price-inclusive display, returns tooling. *Built:* policies drafted in English and Urdu from what the shop has set, shown on the storefront and linked from checkout ([ADR-056](./13-decision-log.md#adr-056--a-shops-policies-are-kept-as-shopify-keeps-them-shown-in-shopifys-markup-and-drafted-from-what-the-shop-has-set-never-saved-by-themselves)) |
| E-commerce policy | National E-Commerce Policy (2019) and its successor | Registration and consumer-protection direction, digital-payment push | Track; build features that help merchants comply |
| Income tax on online sales | Income Tax Ordinance s.6A (Finance Act 2025, amended by Finance Act 2026): payment intermediaries withhold on digital payments (1%) and couriers on COD (2%); rates double for non-filers | Merchants' settlements arrive net of tax; merchants need statements to claim credit | Merchant tax profile (NTN, filer status); withheld tax itemised in reconciliation; exportable certificates and reports |
| Sales tax on online sales | Sales Tax Act (Finance Act 2025): 2% collected by intermediaries/couriers; monthly statements by marketplaces (STR-34), payment intermediaries (STR-35) and couriers (STR-36) under SRO 1429(I)/2025; online sellers must register | Marketplaces and couriers must not serve unregistered sellers (penalties apply). **If Hatti is deemed an "online marketplace", filing and gating duties apply** | Stay a software platform at launch (merchant-owned payments, no cross-store marketplace); registration assistant for merchants; legal opinion on classification before any marketplace-like feature |
| COD cash limit | Rules capping cash-on-delivery value per order (Rs 200,000 reported) | Checkout must block COD above the cap | Platform-level COD ceiling in the method rules engine. *Built:* no order collects more cash at the door, whoever places it ([ADR-058](./13-decision-log.md#adr-058--no-order-collects-more-cash-on-delivery-than-the-law-allows-whoever-places-it-the-rest-is-paid-in-advance-or-the-order-is-not-placed)) |
| Invoicing / fiscalisation | FBR **digital invoicing** mandatory for sales-tax-registered persons (via licensed integrators, API with max 3 allow-listed IPs per taxpayer, 72-hour edit/cancel window, QR + FBR invoice number on printed invoices); FBR POS integration for Tier-1 retailers | Sales-tax-registered merchants; retailers with POS | FBR connector (Growth phase) via a licensed integrator (e.g. PRAL) first; evaluate becoming a licensed integrator; ≤ 3 dedicated egress IPs |
| Our own taxes | Provincial sales tax on services (SaaS fees); federal income tax | Tax on our subscription invoices | Tax-compliant PKR invoices by merchant province |
| Payments | SBP payment-systems regulations | Only if we hold or move funds | Model A (no funds) → Model B via licensed partner → licence only if justified |
| Messaging | PTA rules for commercial SMS; Meta WhatsApp Business policies | Consent, sender IDs, content categories | Consent ledger, quiet hours, template governance |
| Card data | PCI DSS v4.x | Payment pages; partner-powered payments | Section 5 above |

---

## 9. Security operations

* **Detection:** security events (auth anomalies, privilege changes, export spikes, cross-tenant
  denials, WAF blocks) go to a restricted log store with alert rules.
* **Incident response:** severity levels, 24/7 on-call rotation, runbooks (credential leak,
  cross-tenant exposure, payment anomaly, account takeover wave), communication templates,
  and **merchant notification without undue delay** (target ≤ 72 h for personal-data breaches).
  Post-incident reviews are blameless and published internally.
* **Vulnerability SLAs:** critical 72 h · high 7 days · medium 30 days · low 90 days.
* **People:** security onboarding, annual training, phishing drills, background checks for roles
  with production or PII access.
* **Vendors:** security review of sub-processors and courier/payment integrations
  (credential handling, webhook authenticity, data residency).

---

## 10. Security roadmap

| Phase | Deliverables |
|---|---|
| MVP | MFA, RBAC presets, tenant isolation with RLS + tests, secrets encryption, WAF/Turnstile, CSP on checkout, audit log, backups, disclosure policy |
| V1 | External pentest, bug bounty, Trust & Safety tiers T0–T1, consent ledger, DPA and sub-processor list, SIEM alerting, incident drills |
| Growth | App platform security review programme, protected customer data scopes, T2 KYC, PCI AOC for partner-powered payments, network-signal legal review |
| Scale | Formal ISMS (ISO 27001 readiness), SOC 2 for enterprise and international customers, DR audits |
