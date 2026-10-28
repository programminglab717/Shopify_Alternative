# Building on Hatti

Apps, integrations and headless storefronts reach a shop through Hatti's APIs. They are shaped
as Shopify's are, so most of what a developer knows of Shopify carries over. This page covers
what to use, and how.

| What | Where | How it's asked |
|---|---|---|
| **Admin API** | `https://api.hatti.pk/admin/api/2026-10/graphql` | A custom app's token in `X-Hatti-Access-Token` ([ADR-395](../architecture/13-decision-log.md)) |
| **Storefront API** | `https://<shop>/api/2026-10/graphql.json` | A Storefront API token, public in `X-Shopify-Storefront-Access-Token` or private in `Shopify-Storefront-Private-Token` (ADR-848) |
| **Store MCP endpoint** | `https://<shop>/api/mcp`, named by `https://<shop>/.well-known/ucp` | None: AI shopping agents' read of the catalog, and carts (ADR-847) |
| **Webhooks** | Your HTTPS endpoint | Each delivery signed in `X-Hatti-Hmac-Sha256` (ADR-397) |

## Getting a token

A shop's owner makes a custom app on **Settings › Apps**. They choose what it may reach, and the
app's Admin API token and webhook signing secret are shown once there. The same page makes
Storefront API tokens.

## The TypeScript client

`@hatti/admin-client` asks the Admin API with nothing but Node's `fetch`. It runs on Node 20 and
later.

```ts
import { HattiAdminClient, verifyWebhook } from '@hatti/admin-client';

const hatti = new HattiAdminClient({
  apiUrl: 'https://api.hatti.pk',
  accessToken: process.env.HATTI_ACCESS_TOKEN!,
});

const { data, cost } = await hatti.request<{ shop: { name: string } }>('{ shop { name } }');

// A connection, a page at a time: the query takes $after and asks pageInfo.
for await (const product of hatti.paginate<{ id: string; title: string }, { products: never }>(
  `query ($after: String) {
     products(first: 50, after: $after) { nodes { id title } pageInfo { hasNextPage endCursor } }
   }`,
  {},
  (data) => data.products,
)) {
  console.log(product.title);
}
```

* **Costs:** every answer says what its query cost and what is left, in `extensions.cost`, as
  Shopify's does (ADR-576). A throttled query is asked again once the bucket holds what it
  costs. A server error, or a 429, is asked again after a moment, three times at most.
* **Mutations** carry an `Idempotency-Key`, the same on each try, so a retry never does the work
  twice. Give your own with `{ idempotencyKey }` to make a retry of your own safe too.
* **Errors:** an answer with errors throws `HattiAdminApiError`, with the HTTP status and the
  API's errors.
* **Webhooks:** check a delivery before trusting it, against its raw body:

  ```ts
  if (!verifyWebhook(rawBody, request.headers['x-hatti-hmac-sha256'], secret)) reply.code(401);
  ```

## The command line

`hatti` works with a shop's themes from a directory, so they can be kept in git. A Hatti theme's
own files are JSON: its templates, its section groups and its settings.

```sh
export HATTI_API_URL=https://api.hatti.pk
export HATTI_ACCESS_TOKEN=…   # a custom app's token with write_themes

hatti theme list
hatti theme pull --theme thm_… --dir my-theme
hatti theme push --theme thm_… --dir my-theme
hatti theme dev  --theme thm_… --dir my-theme   # push each file as it is saved, with its preview
```

The theme shoppers see is changed only with `--allow-live`. The token is read from the
environment and never written to disk.

## Public apps

A partner (ADR-504) registers an app on their partner page: its address, its redirect URLs and
the scopes it asks for. Its client ID and secret are shown then, the secret once. Shops install
it as Shopify's apps are installed (ADR-851):

```ts
import { accessTokenFor, approvalOf, authorizeUrl } from '@hatti/admin-client';

// 1. Send the merchant to the consent page, with a state of your own.
const url = authorizeUrl({
  adminUrl: 'https://admin.hatti.pk',
  clientId,
  scopes: ['read_products', 'write_orders'],
  redirectUri: 'https://your-app.example/callback',
  state,
});

// 2. Approved, they come back to the redirect URL with code, shop and state.
const approval = approvalOf(request.url, state);

// 3. Trade the code, within ten minutes and once, for the shop's token.
const { accessToken, scopes } = await accessTokenFor({
  apiUrl: 'https://api.hatti.pk',
  clientId,
  clientSecret,
  code: approval!.code,
});
```

* The token is sent in `X-Hatti-Access-Token`, as a custom app's. Webhooks are signed with the
  app's client secret.
* Only the shop's owner or a manager installs an app, and gives no more than their role reaches.
* Until Hatti reviews and lists an app, it installs on its partner's own development stores
  alone.

## Trying things safely

* A **development store**, opened by a partner (ADR-504), is closed to shoppers until it is
  handed over.
* Its **test courier** books parcels that go nowhere (ADR-232).
* A gateway's **sandbox account** takes payments that move no money, said so on the order. Outside
  production, Hatti's own test gateway does too (ADR-151).

## Not yet

* PHP and Python clients.
* Publishing the client and the command line to npm (OWN-45).
* The billing API, by which a public app charges shops in PKR, and an app store page.
* Urdu video tutorials.
