import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import {
  ACCESS_SCOPES,
  PublicSite,
  StorefrontSite,
  generateAccessToken,
  type TenantContext,
} from '@hatti/api';
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
import { DeliveryService } from '@hatti/checkout/public';
import {
  MenuService,
  PageService,
  PreferencesService,
  ThemeService,
} from '@hatti/online-store/public';
import {
  DraftOrderService,
  FulfillmentService,
  ORDER_CUSTOMER_DATA,
  ORDER_SEGMENT_FACTS,
  OrderLinkService,
  OrderService,
  RefundService,
  type DraftOrderLink,
} from '@hatti/orders/public';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
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
  SAMPLE_PAGES,
  SAMPLE_PRODUCTS,
  SAMPLE_SEGMENTS,
  SAMPLE_STOCK,
  SAMPLE_THEME_FILES,
  SAMPLE_DELIVERY,
  SAMPLE_WHATSAPP,
  sampleMainMenu,
  type SampleStep,
} from './seed-data.js';
import { createStorefrontPublisher } from './storefront/publisher.js';

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
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });

try {
  const shopId = newId();
  // Handles are unique across the platform, and every run makes a new shop.
  const handle = `hatti-demo-bazaar-${randomBytes(2).toString('hex')}`;
  // The control plane creates shops; locally the system role stands in for it.
  await database.system((tx) =>
    tx.execute(sql`
      insert into control.shops (id, name, handle)
      values (${shopId}, 'Hatti Demo Bazaar', ${handle})`),
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
  const publicSite = new PublicSite(config.PUBLIC_URL ?? `http://localhost:${config.PORT}`);
  const links = new OrderLinkService(database, orders, publicSite);
  let orderLink = '';
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
        case 'link':
          return links.createLink(tenant, order.id);
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
      if ('url' in result.value) orderLink = result.value.url;
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
  const drafts = new DraftOrderService(database, variants, locations, orders, publicSite);
  let waitingLink: DraftOrderLink | null = null;
  let addressLink: DraftOrderLink | null = null;
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
        // As the customer does: open the page, then confirm what it showed.
        const token = new URL(link!.url).pathname.split('/').at(-1)!;
        const page = await drafts.viewLink(token);
        if (page.kind !== 'open') throw new Error(`Seed draft link: ${page.kind}`);
        const view = await drafts.confirmLink(token, page.shown);
        if (view.kind !== 'completed') throw new Error(`Seed draft confirm: ${view.kind}`);
        link = null;
      } else {
        const done = await drafts.complete(tenant, created.value.id);
        if (!done.ok) throw new Error(`Seed draft complete: ${JSON.stringify(done.errors)}`);
      }
    }
    if (link && !sample.shippingAddress) addressLink = link;
    else waitingLink = link ?? waitingLink;
  }

  const collections = new CollectionService(database);
  const collectionIds = new Map<string, string>();
  for (const collection of SAMPLE_COLLECTIONS) {
    const result = await collections.create(tenant, collection);
    if (!result.ok) {
      throw new Error(`Seed collection "${collection.title}": ${JSON.stringify(result.errors)}`);
    }
    collectionIds.set(collection.title, result.value.id);
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

  // Its own home page and announcement, over Hatti Base's.
  const themes = new ThemeService(database);
  const theme = await themes.main(tenant);
  const saved = await themes.upsertFiles(tenant, theme.id, SAMPLE_THEME_FILES);
  if (!saved.ok) throw new Error(`Seed theme: ${JSON.stringify(saved.errors)}`);
  // And its main menu, in place of the one made from its collections.
  const menus = new MenuService(database, collections, catalog);
  const main = (await menus.list(tenant, { first: 2 })).items[0]!;
  const menu = await menus.update(tenant, main.id, {
    title: main.title,
    items: sampleMainMenu(collectionIds),
  });
  if (!menu.ok) throw new Error(`Seed menu: ${JSON.stringify(menu.errors)}`);
  // Its pages, which its footer menu links to.
  const pageService = new PageService(database);
  const footerItems = [];
  for (const sample of SAMPLE_PAGES) {
    const page = await pageService.create(tenant, sample);
    if (!page.ok) throw new Error(`Seed page: ${JSON.stringify(page.errors)}`);
    footerItems.push({ title: page.value.title, type: 'page', resourceId: page.value.id });
  }
  const footer = (await menus.list(tenant, { first: 2 })).items.find(
    (each) => each.handle === 'footer',
  )!;
  const footerMenu = await menus.update(tenant, footer.id, {
    title: footer.title,
    items: footerItems,
  });
  if (!footerMenu.ok) throw new Error(`Seed footer: ${JSON.stringify(footerMenu.errors)}`);
  // And the number its "Order on WhatsApp" links go to.
  const preferences = await new PreferencesService(database).update(tenant, {
    whatsappNumber: SAMPLE_WHATSAPP,
  });
  if (!preferences.ok) throw new Error(`Seed preferences: ${JSON.stringify(preferences.errors)}`);
  // And what it charges for delivery.
  const delivery = await new DeliveryService(database).update(tenant, SAMPLE_DELIVERY);
  if (!delivery.ok) throw new Error(`Seed delivery: ${JSON.stringify(delivery.errors)}`);

  // The worker does this as events arrive; the seed does not wait for it.
  await createStorefrontPublisher(database, redis).publishAll(shopId);

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

Open customers' links as they would, on a phone or in a browser. Drafts' links work for 72
hours; the order's until 30 days after the order ends:
  a draft order to confirm         ${waitingLink?.url ?? '(none)'}
  a draft order without an address ${addressLink?.url ?? '(none)'}
  an order to confirm              ${orderLink || '(none)'}

Look at its storefront (with \`pnpm dev:storefront\` running), which \`pnpm dev:worker\` keeps
up to date as the catalog changes:
  ${new StorefrontSite(config.STOREFRONT_URL).url(handle)}/   (Urdu: /ur/)
  its pages, such as ${new StorefrontSite(config.STOREFRONT_URL).url(handle)}/pages/about-us
`);
} finally {
  await database.close();
  await identityDatabase.close();
  redis.disconnect();
}
