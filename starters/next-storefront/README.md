# Hatti headless storefront (Next.js)

A storefront for a Hatti shop built on its Storefront API, for shops and partners who want a site
of their own design while Hatti keeps the catalog, carts, checkout and orders (OS-19, ADR-869).

It shows the shop's products, a search, collections and product pages, and keeps a cart with the
Storefront API. **Checkout is the shop's own**, at the cart's `checkoutUrl`: the address, delivery,
cash on delivery or paying online, and the order, as on the shop's Hatti storefront.

## Start

1. In the shop's admin, open **Settings › Apps › Storefront API** and make a **public** token
   (ADR-848).
2. Copy `.env.example` to `.env.local` and fill it in:
   - `HATTI_STORE_DOMAIN`: the shop's storefront, `zari.hatti.pk` or its own domain;
   - `HATTI_STOREFRONT_TOKEN`: the public token.
3. Install and run:

   ```sh
   npm install
   npm run dev
   ```

   Open http://localhost:3000.

## Deploy

Any host that runs Next.js does: Vercel, Netlify, a container, or `npm run build && npm start` on
a server of your own. Set the same variables there.

## What's where

- `lib/hatti.ts`: the Storefront API client. Catalog answers are kept a minute; carts never.
- `lib/queries.ts`: every query the site asks, whole. Hatti's tests check them against the
  Storefront API's schema, so they keep working as the API changes.
- `app/actions.ts`: the cart, its ID kept in an httpOnly cookie, changed by server actions.
- `app/`: the pages: home and search, `products/[handle]`, `collections/[handle]`, `cart`.
- `lib/language.ts` and `lib/words.ts`: English or Urdu, as the header's switch keeps it in a
  cookie. The catalog and the cart are asked for in it with `@inContext(language:)`, the shop's
  Urdu words where it wrote them; pages in Urdu are right to left, and the site's own words are
  in `lib/words.ts`.

The Storefront API speaks Shopify's dialect, so Shopify headless examples mostly carry over: the
same headers, `cartCreate`, `cartLinesAdd`, `checkoutUrl`.
