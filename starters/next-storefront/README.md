# Hatti headless storefront (Next.js)

A storefront for a Hatti shop built on its Storefront API, for shops and partners who want a site
of their own design while Hatti keeps the catalog, carts, checkout and orders (OS-19, ADR-869).

It shows the shop's products, a search, collections and product pages, and keeps a cart with the
Storefront API. Shoppers sign in with a code sent to their mobile number, on WhatsApp or by SMS,
and see their orders, buy their items again, and their store credit (ADR-944), and keep their
addresses (ADR-947) and a wishlist, "Save for later" on each product's page (ADR-953), kept on
the device before they sign in and joined to their account's when they do (ADR-957). Each
product's page, and the home page, show the products viewed before, kept by the shopper's
browser alone (ADR-961). **Checkout is the shop's own**, at the cart's `checkoutUrl`: the address, delivery,
cash on delivery or paying online, and the order, as on the shop's Hatti storefront.

## Start

1. In the shop's admin, open **Settings › Apps › Storefront API** and make a **public** token
   (ADR-848).
2. Copy `.env.example` to `.env.local` and fill it in:
   - `HATTI_STORE_DOMAIN`: the shop's storefront, `zari.hatti.pk` or its own domain;
   - `HATTI_STOREFRONT_TOKEN`: the public token;
   - `HATTI_STOREFRONT_PRIVATE_TOKEN`, optional: a **private** token for sign-ins. With it, the
     Storefront API counts each shopper's sign-ins by their own address, read from the
     `x-forwarded-for` your host sets; without it, every shopper's sign-ins count as this
     server's, 20 a minute in all. Keep it on the server.
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
- `app/account/`: sign-in, the number then the code (`login`), the account page, the address
  book (`addresses`), where addresses are added, changed, delivered to first or taken out, and
  the wishlist (`wishlist`), kept in an httpOnly cookie before signing in (`lib/wishlist.ts`).
  The customer
  access token is kept in an httpOnly cookie until it expires; signing out ends it at the shop
  too.
- `app/`: the pages: home and search, `products/[handle]`, `collections/[handle]`, `cart`,
  `account`.
- `lib/language.ts` and `lib/words.ts`: English or Urdu, as the header's switch keeps it in a
  cookie. The catalog and the cart are asked for in it with `@inContext(language:)`, the shop's
  Urdu words where it wrote them; pages in Urdu are right to left, and the site's own words are
  in `lib/words.ts`.

The Storefront API speaks Shopify's dialect, so Shopify headless examples mostly carry over: the
same headers, `cartCreate`, `cartLinesAdd`, `checkoutUrl`.
