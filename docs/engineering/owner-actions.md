# Waiting on the owner

Everything the build cannot finish without a decision, an account, a key or a signature from
Hatti's owner, in one place, so that none of it is forgotten. Each entry says what is asked, what
it unblocks, what is already built and waiting, and where the settings go. Engineering keeps this
file current: an item that comes to need the owner is added here in the same commit that finds it,
and one that is settled moves to [Settled](#settled) with what was chosen and the commit or ADR
that used it.

Settings named below are environment variables, each described in [`.env.example`](../../.env.example);
nothing secret is ever committed. Shortcuts are the numbered rows of
[phase 0's status](./phase-0-status.md#deliberate-simplifications); ADRs are in the
[decision log](../architecture/13-decision-log.md).

**Status:** *open* (nothing done yet), *asked* (requested from a partner, waiting), *partial*.

## Decisions

| ID | What is asked | What it unblocks | Already built | Status |
|---|---|---|---|---|
| OWN-01 | The brand's final name and its trademark (the code and docs say "Hatti") | Domains, the storefront domain on the Public Suffix List (OWN-31), app store listings, Meta and Google app names | Every name and domain is configuration (`PUBLIC_URL`, `STOREFRONT_URL`, `EMAIL_FROM`) | open |
| OWN-02 | Funding plan and runway; the beachhead (DTC brands first, a free tier in parallel, as recommended) | Team size and pace; which next steps come first | Plans and their limits, the free plan's included (BIL-01), are built | open |
| OWN-03 | The hosting bake-off's sign-off ([10 §3](../architecture/10-infrastructure-and-devops.md#3-hosting-decision-see-adr-015), ADR-015): the cloud for the first cell, and the Pakistani data centre shortlist for the PK cell, with counsel's view on data localisation (OWN-40) | Terraform/OpenTofu for a cell, staging deployed from `main`, the spike 5 benchmark re-run in the target cloud, the production OTel collector | Container images built and run by CI on every push (ADR-724); health probes; alerts and a dashboard (ADR-725) | open |
| OWN-04 | The container registry the images are pushed to (the chosen cloud's own, or GitHub's) | Signed images with an SBOM, scanned, and deployed by Argo CD (10 §4; shortcut 130) | `Dockerfile`, `scripts/image-smoke.sh`; CI builds both images | open |
| OWN-05 | The on-call tool that pages (PagerDuty, Opsgenie, Grafana OnCall or another) and who is on call; whether to use Sentry for errors | Alertmanager's receivers for `ops/prometheus` (ADR-725, shortcut 131); error tracking | Burn-rate and outbox alerts with unit tests, runbooks in [runbooks.md](./runbooks.md) | open |
| OWN-06 | The map tile provider for moving an address's pin (CHK-02): MapTiler, Stadia, Carto, or tiles of our own from OpenStreetMap, with its key and its terms' attribution | The map at checkout and on customers' links (ADR-719, ADR-720) | Built and tested; shown only once `MAP_TILES_URL` and `MAP_TILES_ATTRIBUTION` are set | open |
| OWN-07 | Paying online *before* the order is placed (PAY-01): today checkout places the order and then sends the shopper to pay (ADR-152, shortcut 39); the alternative holds the cart until the gateway says paid | Whether unpaid online orders exist at all; how stock is held meanwhile | Pay-after-placing with reminders and cancellation of unpaid orders; every gateway's callback | open |
| OWN-08 | Whether shops may write their own Liquid (the code editor, OS-04), which runs a shop's code on the platform's domain: it needs theme assets on an origin of their own, or the storefront domain on the Public Suffix List first | The code editor | The theme editor of sections and settings, theme versions, Theme Check against the platform theme | open |
| OWN-09 | The voice gateway for the Urdu confirmation calls (COD-03) | Calls to confirm orders (ADR-611) | Built against a gateway's documented API; `VOICE_GATEWAY_URL`, `VOICE_GATEWAY_KEY`, `VOICE_WEBHOOK_SECRET` | open |
| OWN-10 | The SMS gateway, and the shared sender name registered for it | Codes, one-way updates and SMS campaigns (MKT-02) | `SMS_GATEWAY_URL`, `SMS_GATEWAY_KEY`, `SMS_SENDER`; branded senders shops ask for | open |
| OWN-11 | The AI provider and model, and its key, for translations, product copy and photo crops (CAT-07, CAT-20, CAT-21) | AI drafts in the admin | `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`; daily quotas and credits by plan | open |

## Partners, accounts and keys

| ID | What is asked | What it unblocks | Settings | Status |
|---|---|---|---|---|
| OWN-20 | The launch partners: at least two couriers and two payment providers, with term sheets | Spikes 2–4, and the alpha's shops | — | open |
| OWN-21 | Sandboxes, then merchant test accounts, from each payment gateway: Safepay (and its refunds and reporter), JazzCash, Easypaisa (and its IPN), Baadmay (with a shop's key), PayFast's UAT (and its status API turned on), Bank Alfalah, HBL | Each adapter tried against its sandbox; reconciliation against settlements (05 §4.2) | A shop's own credentials, entered in the admin; Hatti's own billing through Safepay: `BILLING_SAFEPAY_*` | open |
| OWN-22 | Courier accounts: TCS's and Trax's live APIs with a merchant's account, Leopards' staging API, PostEx's live API | The adapters checked against live APIs; cities, serviceability, remittances, reverse pickups | A shop's own credentials in the admin; `TCS_URL`, `TRAX_URL`, `LEOPARDS_URL`, `POSTEX_URL` | open |
| OWN-23 | A Meta business and app: the WhatsApp Cloud API with a number for Hatti, Embedded Signup's configuration, the Conversions and Marketing APIs, and the app reviewed for their permissions | WhatsApp confirmations, broadcasts, shops' own numbers, ad spend | `WHATSAPP_*`, `SUPPORT_WHATSAPP_*`, `META_GRAPH_*` | open |
| OWN-24 | Google: the OAuth clients for signing in, and the Ads API developer token approved for Basic access, with the admin's address registered on its client (MKT-12) | Google sign-in, Google Ads spend | `GOOGLE_CLIENT_IDS`, `GOOGLE_ADS_*` | open |
| OWN-25 | A TikTok for Business developer app | TikTok ad spend (MKT-12) | `TIKTOK_API_URL` | open |
| OWN-26 | Amazon SES: the sending domain verified, production access, and the SNS topic for bounces and complaints | Every email: verification, invitations, orders, invoices, status updates | `SES_*`, `EMAIL_FROM` | open |
| OWN-27 | Cloudflare: the account, R2's bucket and keys, Cloudflare for SaaS for shops' own domains, Turnstile for checkout (CHK-18), and an API token for purges | Files and images in production (the core refuses local files in production), shops' domains and certificates, the edge's cache | `S3_*`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `STOREFRONT_DNS_TARGET` | open |
| OWN-28 | FBR's sandboxes for POS integration and digital invoicing, with a registered shop's credentials (TAX-04) | FBR invoices tried end to end | `FBR_POS_*`, `FBR_DI_*` | open |
| OWN-29 | An Apple developer account | Sign in with Apple and the iOS app | — | open |
| OWN-30 | Hatti's own details for its invoices and support: bank account and IBAN, Raast ID, NTN and sales tax registration, support phone, WhatsApp, email and hours | Shops paying Hatti by transfer, Hatti's tax invoices, the Help page | `BILLING_BANK_*`, `BILLING_RAAST_ID`, `BILLING_NTN`, `BILLING_TAX_*`, `SUPPORT_*` | open |
| OWN-31 | The storefronts' domain submitted to the Public Suffix List, once the domain is final (OWN-01) | Pixels and cookies safe at shops' subdomains; the code editor (OWN-08) | — | open |
| OWN-32 | Web Push keys generated for production (`pnpm --filter @hatti/core vapid-keys`) and kept in the secret manager | Staff's push alerts in production | `VAPID_*` | open |

## Legal

| ID | What is asked | Why | Status |
|---|---|---|---|
| OWN-40 | Counsel engaged in Pakistan | Tax classification (whether Hatti is an "online marketplace"); PECA; the data protection bill and data localisation for the cell's location; network risk signals before they launch ([11 §7](../architecture/11-security-and-compliance.md#7-privacy)); retention periods, tax records kept six years as assumed; confirming the payments "connector" model needs no licence | open |
| OWN-41 | Hatti's own terms of service, privacy policy and acceptable use policy reviewed by counsel | Shops' sign-up and takedowns refer to them | open |

## Settled

Nothing yet.
