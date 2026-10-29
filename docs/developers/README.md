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

An app's functions (ADR-868) are built and deployed the same way, from a directory with a
`hatti.function.json`. `hatti function init` begins one (ADR-935): its `hatti.function.json`, a
starter in JavaScript for its target, built with [Javy](https://github.com/bytecodealliance/javy),
and a sample cart to run it on. With `--lang rust` the starter is a Rust crate instead, built with
Cargo for WASI once `rustup target add wasm32-wasip1` has been run (ADR-942); it reads and writes
its JSON with `serde_json`, and its module is about 90 KB of the 256 KiB a function may be:

```sh
hatti function init cod-above-limit --target payment_customization --dir cod-above-limit
cd cod-above-limit && hatti function run --input input.json

hatti function init five-at-most --target cart_validation --lang rust --dir five-at-most
```

A payment customisation's starter hides cash on delivery above a limit, a cart validation's refuses
more than a few of an item; each reads its limit from the function's configuration. The file:

```json
{
  "handle": "cod-above-limit",
  "title": "No cash on delivery above Rs 10,000",
  "target": "payment_customization",
  "build": "javy build src/index.js -o dist/function.wasm",
  "module": "dist/function.wasm"
}
```

```sh
export HATTI_ACCESS_TOKEN=…   # the app's token, with write_settings

hatti function build    # run its build, and check its module as Hatti will
hatti function run --input cart.json   # build it, then run it on that input as checkout does
hatti function deploy   # build it, then give it to the shop as the app's new version
hatti function list     # the app's functions in the shop, on or off, and their last failure
```

`build` is the developer's own tool: Javy, TinyGo or Rust's `wasm32-wasi`. A new version runs as
the last did; a function the shop hasn't turned on stays off (ADR-922). `build` and `run` need no
token: they check and run the module with Hatti's own code, its memory capped and its time limited
to 50 ms as at checkout, and `run` prints its answer and how long it took (ADR-927).

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

## Charging shops

An installed public app charges the shop once, in rupees, as Shopify's apps do (ADR-854):

```graphql
mutation {
  appPurchaseOneTimeCreate(
    name: "Photo reviews, for good"
    price: { amount: "2500", currencyCode: PKR }
    returnUrl: "https://your-app.example/charged"
  ) {
    appPurchaseOneTime { id status test }
    confirmationUrl
    userErrors { field message }
  }
}
```

Send the shop's owner to `confirmationUrl`. They approve it and pay it as an invoice of Hatti's;
then they come back to `returnUrl`, and `appPurchaseOneTime(id)` says `PAID`. Subscribe to
`APP_PURCHASES_ONE_TIME_UPDATE` to be told as each of your charges is declined or paid, with its
ID and status, rather than asking (ADR-914). On a development store the charge is a test, paid
once approved with no money moving. Hatti pays you 80% of what the shop paid, less the sales tax.

## Inside the admin, and on the storefront

* **Embedded apps:** a merchant opens an installed app from Settings › Apps, inside the admin.
  Its frame loads the app's URL with `shop`, `embedded=1` and `id_token`, a session token of a
  minute's life. Check it, then keep a session of your own (ADR-852):

  ```ts
  import { verifySessionToken } from '@hatti/admin-client';

  const claims = verifySessionToken(url.searchParams.get('id_token'), { clientId, clientSecret });
  if (!claims) return reply.code(401);
  // claims.dest is the shop, claims.sub the member of staff looking.
  ```

* **App Bridge:** from inside the frame, an app asks the admin for a fresh session token, a
  toast, a page of the admin to go to, or the save bar (ADR-912). It answers only the admin
  named by the `host` the frame's address carries:

  ```ts
  import { createAppBridge } from '@hatti/admin-client/app-bridge';

  const bridge = createAppBridge();
  const token = await bridge.idToken(); // send it to your server with each request
  bridge.toast('Reviews imported');
  bridge.saveBar.show({ onSave: save, onDiscard: reset });
  bridge.navigate('/orders');
  ```

* **App embeds:** an app with `write_themes` offers the storefront a script of its own, which
  loads on every page once the shop turns it on:

  ```graphql
  mutation {
    appEmbedSet(input: { handle: "reviews", name: "Reviews widget", src: "https://cdn.example/w.js" }) {
      appEmbed { id enabled }
      userErrors { field message }
    }
  }
  ```

  Changing its address turns it off again until the shop looks. Follow the shop's consent
  banner by reading its `hatti_consent` cookie before tracking anyone.

## Selling themes

A partner builds a theme on a development store, then offers it to the theme store from their
partner page, free or for Rs 1,000 to Rs 100,000 (ADR-853). Hatti looks at it on that store
before listing it, and again each time it is offered anew. Shops install free themes at once
and buy paid ones once; the designer earns 80% of each sale, paid out with partners' other
earnings. A theme's own files are JSON over one of Hatti's themes, so `hatti theme pull` and
`push` work on it like any other.

## Workflows

Shops make workflows in Settings › Workflows: a trigger, conditions, and actions (ADR-861). An
app adds triggers it fires and actions it is sent, as a Shopify Flow extension does:

```graphql
mutation {
  flowExtensionSet(input: {
    kind: ACTION, handle: "ask-for-review", title: "Ask for a review", resource: ORDER
    url: "https://your-app.example/flow"
    fields: [{ key: "message", label: "Message", type: TEXT, required: true }]
  }) { flowExtension { id } userErrors { field message } }
}
```

* **An action** is posted to its `url` as JSON: `action`, `shop_id`, `workflow_id`, `run_id`,
  `order_id` or `customer_id` as its resource says, and `properties`, the merchant's words with
  `{{order.name}}` and the like filled in. Check `x-hatti-hmac-sha256` as for webhooks, and
  answer 2xx. One that doesn't answer is tried again for a day; a 4xx other than 429 is not.
* **A trigger** has no `url`. Fire it with `flowTriggerReceive(handle:, orderId:, properties:)`;
  each enabled workflow on it runs once, and its conditions can read the fields you send.
* One about orders needs `read_orders`; about customers, `read_customers`.

## Trying things safely

* A **development store**, opened by a partner (ADR-504), is closed to shoppers until it is
  handed over.
* Its **test courier** books parcels that go nowhere (ADR-232).
* A gateway's **sandbox account** takes payments that move no money, said so on the order. Outside
  production, Hatti's own test gateway does too (ADR-151).

## Hatti's review

Hatti's people look at each public app, theme and expert profile before shops see it, from the
command line where Hatti runs (`pnpm --filter @hatti/core partner-apps`, `partner-themes`,
`partner-experts`). Until the owner settles what is checked (OWN-46, OWN-47, OWN-49), they look
for:

* **Apps:** a working install on the partner's development store; scopes the app needs and no
  more; an https address and redirect URLs on the partner's own domain; a privacy policy saying
  what it keeps of shoppers.
* **Themes:** a preview on the development store that works on a phone, in Urdu and English;
  no images of others' work; a description that says what it is for; a price in range.
* **Experts:** a real business, with past work to see; services they offer, in the cities they
  name; no phone numbers or links in the profile to take shops off Hatti.

## Not yet

* PHP and Python clients.
* Publishing the client and the command line to npm (OWN-45).
* Recurring and usage charges for apps, and an app store page.
* Urdu video tutorials.
