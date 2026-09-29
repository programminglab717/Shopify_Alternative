import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { ACCESS_SCOPES, PublicSite, generateAccessToken, type TenantContext } from '@hatti/api';
import { CollectionService, ProductService, VariantService } from '@hatti/catalog/public';
import { base32Decode, totp } from '@hatti/crypto';
import {
  BlocklistService,
  CustomerDataRegistry,
  CustomerDataService,
  CustomerService,
  SegmentFieldRegistry,
  SegmentService,
} from '@hatti/customers/public';
import { Database } from '@hatti/db';
import { IdentityService } from '@hatti/identity/public';
import { newId, toPublicId } from '@hatti/ids';
import { parsePkMobile } from '@hatti/pk';
import {
  InventoryService,
  LocationService,
  StockService,
  type InventoryQuantityInput,
} from '@hatti/inventory/public';
import {
  DraftOrderService,
  FulfillmentService,
  ORDER_CUSTOMER_DATA,
  ORDER_SEGMENT_FACTS,
  OrderService,
  RefundService,
  type DraftOrderLink,
} from '@hatti/orders/public';
import { sql } from 'drizzle-orm';
import { ACCESS_TOKEN_HEADER, ADMIN_GRAPHQL_PATH } from './api/constants.js';
import { loadSeedConfig } from './config.js';
import {
  SAMPLE_BLOCKLIST,
  SAMPLE_COLLECTIONS,
  SAMPLE_CONSENT,
  SAMPLE_DRAFTS,
  SAMPLE_LOCATIONS,
  SAMPLE_MERGES,
  SAMPLE_ORDERS,
  SAMPLE_PRODUCTS,
  SAMPLE_SEGMENTS,
  SAMPLE_STOCK,
  type SampleStep,
} from './seed-data.js';

// Creates a demo shop with an app access token, an owner account, sample products, their stock
// and some orders. Safe to run repeatedly: each run creates a new shop and owner.
const config = loadSeedConfig();
const database = new Database({
  appUrl: config.DATABASE_URL,
  systemUrl: config.DATABASE_SYSTEM_URL,
  applicationName: 'seed',
});
const identityDatabase = new Database({
  appUrl: config.DATABASE_IDENTITY_URL,
  applicationName: 'seed:identity',
});

try {
  const shopId = newId();
  // The control plane creates shops; locally the system role stands in for it.
  await database.system((tx) =>
    tx.execute(sql`insert into control.shops (id, name) values (${shopId}, 'Hatti Demo Bazaar')`),
  );

  const tokenId = newId();
  const { token, hash, hint } = generateAccessToken();
  await database.tenant(shopId, (tx) =>
    tx.execute(sql`
      insert into apps.access_tokens (shop_id, id, name, token_hash, token_hint, scopes)
      values (${shopId}, ${tokenId}, 'Development token', ${hash}, ${hint},
              ${sql.param([...ACCESS_SCOPES])}::text[])
    `),
  );

  const tenant: TenantContext = {
    shopId,
    currency: 'PKR',
    scopes: new Set(ACCESS_SCOPES),
    actor: { kind: 'app', tokenId },
  };
  const locations = new LocationService(database);
  const locationIds = new Map<string, string>();
  for (const location of SAMPLE_LOCATIONS) {
    const result = await locations.add(tenant, location);
    if (!result.ok) {
      throw new Error(`Seed location "${location.name}": ${JSON.stringify(result.errors)}`);
    }
    locationIds.set(result.value.name, result.value.id);
  }

  const catalog = new ProductService(database);
  const stock: InventoryQuantityInput[] = [];
  const variantIds = new Map<string, string>();
  for (const product of SAMPLE_PRODUCTS) {
    const result = await catalog.create(tenant, product);
    if (!result.ok) {
      throw new Error(`Seed product "${product.title}": ${JSON.stringify(result.errors)}`);
    }
    for (const variant of result.value.variants) {
      variantIds.set(`${product.title}/${variant.title}`, variant.id);
      const counts = SAMPLE_STOCK[product.title]?.[variant.title] ?? {};
      for (const [location, quantity] of Object.entries(counts)) {
        stock.push({
          inventoryItemId: variant.id,
          locationId: locationIds.get(location)!,
          quantity,
        });
      }
    }
  }
  const inventory = new InventoryService(database, new VariantService(database));
  const counted = await inventory.setQuantities(tenant, {
    name: 'available',
    reason: 'cycle_count_available',
    quantities: stock,
  });
  if (!counted.ok) throw new Error(`Seed stock: ${JSON.stringify(counted.errors)}`);

  const customers = new CustomerService(database);
  const blocklist = new BlocklistService(database);
  for (const entry of SAMPLE_BLOCKLIST) {
    const result = await blocklist.add(tenant, entry);
    if (!result.ok) throw new Error(`Seed blocklist: ${JSON.stringify(result.errors)}`);
  }

  const variants = new VariantService(database);
  const stockService = new StockService();
  const orders = new OrderService(
    database,
    variants,
    locations,
    stockService,
    customers,
    blocklist,
  );
  const fulfillments = new FulfillmentService(database, stockService);
  const refunds = new RefundService(database);
  for (const { lines, then = [], tracking, writtenOff = [], refund, ...sample } of SAMPLE_ORDERS) {
    const placed = await orders.create(tenant, {
      ...sample,
      lineItems: lines.map((line) => ({
        variantId: variantIds.get(`${line.product}/${line.variant}`)!,
        quantity: line.quantity,
      })),
    });
    if (!placed.ok) throw new Error(`Seed order: ${JSON.stringify(placed.errors)}`);
    const order = placed.value;
    let parcel = '';
    const run = (step: SampleStep) => {
      switch (step) {
        case 'confirm':
          return orders.confirm(tenant, order.id);
        case 'pack':
          return orders.markPacked(tenant, order.id);
        case 'cancel':
          return orders.cancel(tenant, order.id, { reason: 'no_response' });
        case 'pay':
          return orders.markAsPaid(tenant, order.id);
        case 'refund':
          return refunds.refund(tenant, order.id, refund!);
        case 'ship':
          return fulfillments.fulfill(tenant, order.id, { tracking });
        case 'deliver':
          return fulfillments.markDelivered(tenant, parcel);
        case 'refuse':
          return fulfillments.markReturning(tenant, parcel);
        case 'check_in':
          return fulfillments.receiveReturn(
            tenant,
            parcel,
            order.lines
              .filter((line) => !writtenOff.includes(line.title))
              .map((line) => ({ lineItemId: line.id, quantity: line.quantity })),
          );
      }
    };
    for (const step of then) {
      const result = await run(step);
      if (!result.ok) throw new Error(`Seed order ${step}: ${JSON.stringify(result.errors)}`);
      if ('fulfillmentId' in result.value) parcel = result.value.fulfillmentId;
    }
  }
  const dataRegistry = new CustomerDataRegistry();
  dataRegistry.register(ORDER_CUSTOMER_DATA);
  const customerData = new CustomerDataService(database, dataRegistry);
  for (const { keep, duplicate } of SAMPLE_MERGES) {
    const [kept, merged] = [keep, duplicate].map((phone) => parsePkMobile(phone)!.e164) as [
      string,
      string,
    ];
    const found = await customers.byPhones(tenant, [kept, merged]);
    const result = await customerData.merge(tenant, found.get(kept)!.id, found.get(merged)!.id);
    if (!result.ok) throw new Error(`Seed merge: ${JSON.stringify(result.errors)}`);
  }
  const publicUrl = config.PUBLIC_URL ?? `http://localhost:${config.PORT}`;
  const drafts = new DraftOrderService(
    database,
    variants,
    locations,
    orders,
    new PublicSite(publicUrl),
  );
  let waitingLink: DraftOrderLink | null = null;
  for (const { lines, then = [], ...sample } of SAMPLE_DRAFTS) {
    const created = await drafts.create(tenant, {
      ...sample,
      lineItems: lines.map((line) => ({
        variantId: variantIds.get(`${line.product}/${line.variant}`)!,
        quantity: line.quantity,
        price: line.price,
      })),
    });
    if (!created.ok) throw new Error(`Seed draft: ${JSON.stringify(created.errors)}`);
    let link: DraftOrderLink | null = null;
    for (const step of then) {
      if (step === 'link') {
        const made = await drafts.createLink(tenant, created.value.id);
        if (!made.ok) throw new Error(`Seed draft link: ${JSON.stringify(made.errors)}`);
        link = made.value;
      } else if (step === 'confirm') {
        const token = new URL(link!.url).pathname.split('/').at(-1)!;
        const view = await drafts.confirmLink(token, link!.draftOrder.version);
        if (view.kind !== 'completed') throw new Error(`Seed draft confirm: ${view.kind}`);
        link = null;
      } else {
        const done = await drafts.complete(tenant, created.value.id);
        if (!done.ok) throw new Error(`Seed draft complete: ${JSON.stringify(done.errors)}`);
      }
    }
    waitingLink = link ?? waitingLink;
  }

  const collections = new CollectionService(database);
  for (const collection of SAMPLE_COLLECTIONS) {
    const result = await collections.create(tenant, collection);
    if (!result.ok) {
      throw new Error(`Seed collection "${collection.title}": ${JSON.stringify(result.errors)}`);
    }
  }

  // An owner account. Owners must use two-step verification, so it is switched on here too.
  const identity = new IdentityService({
    db: identityDatabase.app,
    secretBox: config.ENCRYPTION_KEYS,
  });
  const client = { ip: '127.0.0.1', userAgent: 'seed' };
  const ownerEmail = `owner-${randomBytes(3).toString('hex')}@demo.hatti.test`;
  const ownerPassword = randomBytes(12).toString('base64url');
  const owner = await identity.signUp(
    { email: ownerEmail, password: ownerPassword, name: 'Demo Owner' },
    client,
  );
  await identity.grantMembership({ userId: owner.userId, shopId, role: 'owner' });
  const session = await identity.authenticate(owner.tokens.accessToken);
  const { secret } = await identity.setUpTotp(session);
  await identity.confirmTotp(session, totp(base32Decode(secret)), client);
  await identity.signOut(session, client);

  for (const { phone, consent } of SAMPLE_CONSENT) {
    const e164 = parsePkMobile(phone)!.e164;
    const customer = (await customers.byPhones(tenant, [e164])).get(e164)!;
    const result = await customers.updateMarketingConsent(tenant, customer.id, consent);
    if (!result.ok) throw new Error(`Seed consent: ${JSON.stringify(result.errors)}`);
  }

  const registry = new SegmentFieldRegistry();
  registry.register(ORDER_SEGMENT_FACTS);
  const segments = new SegmentService(database, registry);
  for (const segment of SAMPLE_SEGMENTS) {
    const result = await segments.create(tenant, segment);
    if (!result.ok) throw new Error(`Seed segment: ${JSON.stringify(result.errors)}`);
  }

  const customerCount = (await customers.list(tenant, { first: 250 })).items.length;
  const publicShopId = toPublicId('shop', shopId);
  const query =
    '{ shop { name } products(first: 5, query: \\"kameez\\") { nodes { title totalInventory } } }';
  console.log(`
Created shop ${publicShopId} with ${SAMPLE_PRODUCTS.length} products, ${SAMPLE_COLLECTIONS.length} collections, ${SAMPLE_LOCATIONS.length} stock locations, ${SAMPLE_ORDERS.length} orders and ${SAMPLE_DRAFTS.length} draft orders from ${customerCount} customers, ${SAMPLE_SEGMENTS.length} segments and ${SAMPLE_BLOCKLIST.length} blocked numbers.

Owner account (shown once, keep it safe):
  email       ${ownerEmail}
  password    ${ownerPassword}
  2-step key  ${secret}
              Add it to an authenticator app, or get a code with: pnpm totp ${secret}
  Sign in with POST /auth/sign-in, then /auth/sign-in/verify, and call the Admin API with
  "Authorization: Bearer <accessToken>" and "x-hatti-shop-id: ${publicShopId}".

App access token for the Admin API (shown once, keep it safe):
  ${token}

Try it (with \`pnpm dev:api\` running):
  curl -s http://localhost:${config.PORT}${ADMIN_GRAPHQL_PATH} \\
    -H 'content-type: application/json' \\
    -H '${ACCESS_TOKEN_HEADER}: ${token}' \\
    -d '{"query":"${query}"}'

  A draft order waits for its customer to confirm it: open its link as they would, on a phone
  or in a browser (it works for 72 hours):
  ${waitingLink?.url ?? '(none)'}
`);
} finally {
  await database.close();
  await identityDatabase.close();
}
