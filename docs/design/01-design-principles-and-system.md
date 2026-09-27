# 01 · Design Principles & Design System ("Hatti UI")

> **Status:** Draft v0.1 · **Last updated:** 2026-09-27
> Covers who we design for, the principles behind every screen, and the foundations and
> components of the Hatti design system used by the admin, the merchant app, checkout and the
> reference themes.

---

## 1. Who we design for

| | Merchant (admin, merchant app) | Shopper (storefront, checkout, WhatsApp) |
|---|---|---|
| Typical device | Mid-range Android (e.g. 4–6 GB RAM), often shared with personal use; a laptop for larger brands | Low- to mid-range Android (2–4 GB RAM, ~360×800 dp screens); a large feature-phone tail reached only by SMS/IVR |
| Network | 4G with drops; home broadband for some; data cost matters | Congested 4G; median mobile download ~24 Mbps; periodic disruptions |
| Language | Mixed English/Urdu; many prefer Roman Urdu on phones; formal Urdu script for some | Roman Urdu and English on social media; Urdu script for some; English UI conventions familiar from Daraz and banking apps |
| Context | Busy, interrupted, on the move; staff with mixed literacy (packers, riders) | Buying from social media, often at night, often COD, wary of scams |

---

## 2. Design principles

1. **Phone first, not "mobile friendly".** Every merchant workflow is designed at 360 dp first:
   confirm 30 orders, book 30 parcels, add a product with the camera. Desktop is the expansion.
2. **Tell me what to do next.** Home is a to-do list with rupee amounts ("12 orders need
   confirmation", "Rs 3.2 lakh pending from Leopards for more than 7 days"), not a wall of charts.
3. **Money and stock are sacred.** Show consequences before irreversible actions ("This will cancel
   8 orders and restock 11 items"). Prefer undo over confirmation dialogs where possible. Every
   change is visible in a timeline.
4. **Speak like a person, in their language.** Plain words, respectful tone ("aap"), everyday
   loanwords (order, parcel, courier, COD) rather than formal translations nobody uses.
5. **Defaults over settings.** Sensible Pakistan defaults (PKR, city groups, COD rules, quiet
   hours). Advanced settings sit behind progressive disclosure.
6. **Fast on a Rs 30,000 phone.** Performance budgets are design constraints, not engineering
   afterthoughts. If a design needs 200 KB of JS, redesign it.
7. **Trust is visible.** For shoppers: delivery charges upfront, verified badges, clear return
   policy, proactive tracking. For merchants: why an order is flagged, where the cash is.
8. **Works on a bad day.** Designs include offline, slow, failed and blocked-channel states from
   the start. Every async action shows its status ("booking pending, will retry").
9. **Inclusive by default.** Large touch targets, colour plus text for status, icons with labels,
   screen-reader labels in both languages.

---

## 3. Language, content & formatting

| Topic | Rule |
|---|---|
| UI languages | English and Urdu (script) for admin and storefronts. Notifications can also go out in **Roman Urdu** (the default for SMS). |
| Tone | Warm, respectful, brief. Address merchants and shoppers as "aap". No slang in system text. |
| Terminology | Keep familiar loanwords in Urdu UI: آرڈر (order), پارسل (parcel), کورئیر (courier), کیش آن ڈیلیوری (COD). A shared **glossary** is maintained by the UX writer and used by translators and AI prompts. |
| Numbers | Western digits (0–9) in both languages, for prices, phone numbers, order and tracking IDs. |
| Currency | "Rs 12,500" by default; optional lakh/crore grouping ("Rs 1,25,000") and "Rs 3.2 lakh" in summaries. |
| Dates & times | `27 Sep 2026`, 12-hour clock with am/pm; relative times for recency ("2 hours ago"); `Asia/Karachi`. Optional Hijri date display in campaign planning. |
| Phone | Display `0300 1234567`; store `+923001234567`; always LTR-isolated in RTL text. |
| Addresses | City first, then area, then free text, then landmark. Never force postal codes. |
| Bidirectional text | Wrap LTR fragments (IDs, phone numbers, prices, SKUs) in `<bdi>`/`dir="ltr"`. Mirror layout, not numbers. |
| Error messages | Say what happened, why, and what to do next, in one or two short sentences. Never blame the user. |

---

## 4. Foundations

### 4.1 Colour

The starting palette is a **proposal for the brand designer to refine**. Teal conveys trust and
calm; saffron adds bazaar warmth. We deliberately avoid the exact national-flag green, so the
product doesn't read as a government service. All text pairs below meet **WCAG 2.2 AA** (≥ 4.5:1),
checked numerically.

| Token | Light | Dark | Use |
|---|---|---|---|
| `color.brand.primary` | `#0F766E` (white text 5.5:1) | `#2DD4BF` (dark text 10:1) | Primary actions, focus |
| `color.brand.primary-strong` | `#115E59` | `#5EEAD4` | Hover/pressed, links on dark |
| `color.brand.accent` | `#F59E0B` (dark text 8.3:1) | `#FBBF24` | Highlights, badges, promos (never for errors) |
| `color.bg.canvas` | `#F8FAFC` | `#0B1220` | Page background |
| `color.bg.surface` | `#FFFFFF` | `#111827` | Cards, sheets |
| `color.text.primary` | `#0F172A` | `#E5E7EB` | Body text |
| `color.text.secondary` | `#475569` (7.6:1) | `#94A3B8` (6.9:1) | Secondary text |
| `color.feedback.success` | `#15803D` | `#4ADE80` | Success states |
| `color.feedback.warning` | `#B45309` | `#FBBF24` | Warnings |
| `color.feedback.danger` | `#B91C1C` | `#F87171` | Errors, destructive |
| `color.feedback.info` | `#1D4ED8` | `#60A5FA` | Info |

**Order stage colours.** Status is always shown as **colour + icon + text**, never colour alone.

| Stage | Badge (text on background) | Contrast |
|---|---|---|
| Needs confirmation | `#92400E` on `#FEF3C7` | 6.4:1 |
| Confirmed | `#1E40AF` on `#DBEAFE` | 7.2:1 |
| Packed | `#3730A3` on `#E0E7FF` | 8.1:1 |
| In transit | `#5B21B6` on `#EDE9FE` | 7.6:1 |
| Out for delivery | `#155E75` on `#CFFAFE` | 6.5:1 |
| Delivered | `#166534` on `#DCFCE7` | 6.5:1 |
| Delivery issue | `#9A3412` on `#FFEDD5` | 6.4:1 |
| Returned (RTO) | `#991B1B` on `#FEE2E2` | 6.8:1 |
| Cancelled | `#475569` on `#F1F5F9` | 6.9:1 |

### 4.2 Typography

| Script | Face | Notes |
|---|---|---|
| Latin | **Inter** (variable, subset) or the system UI stack on storefronts | Tabular numerals for prices and tables |
| Urdu (UI and body) | **Noto Nastaliq Urdu** | Readers expect Nastaliq. Needs generous line height (≥ 1.9) and ~1.15× the Latin size; subset and cache aggressively; `font-display: swap` |
| Urdu (dense data) | **Noto Naskh Arabic** (option) | Only for very dense tables where Nastaliq's height breaks layouts, and only after user testing |

| Token | Latin size / line | Urdu size / line | Use |
|---|---|---|---|
| `type.display` | 28 / 36 | 32 / 60 | Page titles (mobile) |
| `type.title` | 20 / 28 | 23 / 44 | Section titles |
| `type.body` | 16 / 24 | 18 / 36 | Default text (minimum body size) |
| `type.body-sm` | 14 / 20 | 16 / 32 | Secondary text, table cells |
| `type.caption` | 12 / 16 | 14 / 28 | Metadata only; never for primary information |

### 4.3 Space, shape, elevation, motion

* **Spacing:** 4 px base (4, 8, 12, 16, 24, 32, 48). Mobile gutters 16 px.
* **Touch targets:** ≥ 48×48 dp; primary actions in the thumb zone (bottom bar or sticky footer).
* **Radius:** 8 px controls, 12 px cards, 16 px bottom sheets.
* **Elevation:** borders first, shadows sparingly (they cost rendering on low-end GPUs).
* **Motion:** 150–200 ms ease-out for state changes; no decorative animation; honour
  `prefers-reduced-motion`.
* **Density:** *comfortable* (mobile default) and *compact* (desktop tables).
* **Themes:** light and dark for admin and apps (dark mode saves battery on OLED phones and suits
  late-night order processing).

### 4.4 Iconography & RTL

* One icon set (Lucide or Phosphor), 24 px grid, 1.5–2 px stroke, always paired with a label in
  navigation.
* **Mirrored in RTL:** back/forward arrows, chevrons, progress direction, "send" and reply icons.
  **Not mirrored:** checkmarks, clocks, media controls, charts' time axes, brand logos.
* Courier and payment logos use official assets at consistent heights.

---

## 5. Component inventory

| Group | Components | Local notes |
|---|---|---|
| Inputs | Text, textarea, select, combobox, checkbox, radio, switch, date/time, file/camera upload | **Phone input** (`+92` prefix, `03XX` formats); **CNIC input** (`12345-1234567-1` mask); **Money input** ("Rs", integers by default); **City picker** (search with aliases and Urdu names); **Address block** (city → area → address → landmark → map pin) |
| Actions | Button (primary, secondary, tertiary, destructive), icon button, split button, FAB (mobile), bulk action bar | Destructive actions show counts ("Cancel 8 orders") |
| Feedback | Toast, inline alert, banner (incl. **channel outage banner**), progress, skeletons, empty states with a next action | Async states: queued / pending / retrying / failed with retry |
| Data display | Data table ↔ **mobile card list**, stat tile, badge/status pill, timeline, key-value list, avatar, image gallery | Every table has a card layout at < 600 dp |
| Navigation | Sidebar (desktop), bottom nav (mobile), tabs, breadcrumbs, command palette (desktop), saved views | Role-aware navigation (e.g. a Packer sees only packing and shipping) |
| Overlays | Modal (desktop), **bottom sheet** (mobile), popover, tooltip (never for essential info) | |
| Commerce-specific | **Order stage pipeline**, **risk indicator** (score + reasons), **confirmation call card**, **courier chip** with delivery rate, **label print preview**, **WhatsApp message preview**, **COD cash widget**, reconciliation diff row, product variant matrix | |
| Charts | ECharts theme (tokens, RTL, locale-aware numbers); sparklines in stat tiles | Charts follow the data-visualisation guidelines in the design system repo |

Components ship in **React (web)** and **React Native (apps)** from shared tokens. The storefront uses
a lighter set of **web components** that follow the same tokens.

---

## 6. Storefront & theme design guidelines

* **Mobile-first product pages:** image gallery first (3:4 aspect for fashion), then price and
  delivery estimate, variant picker, **sticky add-to-cart**, WhatsApp "Ask about this" and a trust
  block (COD available, returns, verified store).
* **Delivery transparency:** a city-based delivery charge and ETA on the product page and in the
  cart, never first shown at the last checkout step.
* **Size and fit:** size chart and "stitched/unstitched" choices clearly separated; measurements in
  inches by default for eastern wear.
* **Imagery:** real photos over stock; compressed; LCP image preloaded; no auto-playing video on
  cellular.
* **Honest urgency only:** countdowns for real sale ends; stock indicators from real stock.
* **RTL:** mirror layout; keep product images unmirrored; test every section in Urdu.
* **Budgets:** themes must pass Theme Check budgets (JS ≤ 30 KB gz, CSS ≤ 40 KB gz, LCP ≤ 2.0 s on
  the reference device) to be listed in the theme marketplace.

---

## 7. Messaging design (WhatsApp / SMS)

* **Structure:** who is messaging (store name) → what happened → what to do (buttons) → how to get
  help.
* **Length:** WhatsApp body ≤ 400 characters; SMS ≤ 1 segment where possible (Roman Urdu).
* **Buttons:** ≤ 20 characters, verb first: "Confirm order", "Deliver tomorrow".
* **Language:** follow the shopper's checkout language. Default to Roman Urdu with key English
  words for SMS.
* **Never:** marketing content inside utility templates (policy risk and cost reclassification),
  messages at night, more than 3 confirmation messages per order.

Example (Roman Urdu utility template):

```text
Assalam-o-Alaikum Hamza! Ayesha's Closet se aap ka order #1043 (Rs 4,850, COD) mila hai.
Delivery: Multan, 2-4 din. Kya hum order confirm kar dein?
[ Confirm order ]  [ Cancel ]  [ Change address ]
```

---

## 8. Accessibility

* **WCAG 2.2 AA** for admin, checkout and reference themes; automated checks in CI (axe) plus
  manual TalkBack testing in English and Urdu.
* Visible focus states, logical focus order (including RTL), labelled form fields, errors linked to
  fields, no information conveyed by colour alone.
* Respect OS font scaling up to 200% without breaking critical flows.
* **Low-literacy support:** icons with labels; short sentences; voice-note help videos in Urdu;
  a Packer mode with pictures of items and big scan targets.

---

## 9. Design operations

* **Figma library** mirrors the code components; tokens flow from a single source (Style
  Dictionary) to CSS variables, Tailwind config and React Native themes.
* **Storybook** for web components with visual regression tests; RTL and dark-mode stories are
  mandatory for every component.
* **Research cadence:** a monthly merchant usability session in Lahore and Karachi (in person) plus
  remote sessions; a shopper test panel on low-end devices; a research repository tagged by feature
  ID.
* **Definition of done (design):** Urdu and English copy reviewed, RTL checked, dark mode, empty,
  error, loading and offline states designed, analytics events named.
