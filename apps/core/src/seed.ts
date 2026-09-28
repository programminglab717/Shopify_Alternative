import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { ACCESS_SCOPES, generateAccessToken, type TenantContext } from '@hatti/api';
import { CollectionService, ProductService } from '@hatti/catalog/public';
import { base32Decode, totp } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { IdentityService } from '@hatti/identity/public';
import { newId, toPublicId } from '@hatti/ids';
import { sql } from 'drizzle-orm';
import { ACCESS_TOKEN_HEADER, ADMIN_GRAPHQL_PATH } from './api/constants.js';
import { loadSeedConfig } from './config.js';
import { SAMPLE_COLLECTIONS, SAMPLE_PRODUCTS } from './seed-data.js';

// Creates a demo shop with an app access token, an owner account and sample products. Safe to run
// repeatedly: each run creates a new shop and owner.
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
  const catalog = new ProductService(database);
  for (const product of SAMPLE_PRODUCTS) {
    const result = await catalog.create(tenant, product);
    if (!result.ok) {
      throw new Error(`Seed product "${product.title}": ${JSON.stringify(result.errors)}`);
    }
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

  const publicShopId = toPublicId('shop', shopId);
  const query = '{ shop { name } products(first: 5, query: \\"kameez\\") { nodes { title } } }';
  console.log(`
Created shop ${publicShopId} with ${SAMPLE_PRODUCTS.length} products and ${SAMPLE_COLLECTIONS.length} collections.

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
`);
} finally {
  await database.close();
  await identityDatabase.close();
}
