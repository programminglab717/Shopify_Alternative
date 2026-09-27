import 'reflect-metadata';
import { ACCESS_SCOPES, generateAccessToken, type TenantContext } from '@hatti/api';
import { ProductService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { newId, toPublicId } from '@hatti/ids';
import { sql } from 'drizzle-orm';
import { ACCESS_TOKEN_HEADER, ADMIN_GRAPHQL_PATH } from './api/constants.js';
import { loadSeedConfig } from './config.js';
import { SAMPLE_PRODUCTS } from './seed-data.js';

// Creates a demo shop with an access token and sample products. Safe to run repeatedly: each run
// creates a new shop.
const config = loadSeedConfig();
const database = new Database({
  appUrl: config.DATABASE_URL,
  systemUrl: config.DATABASE_SYSTEM_URL,
  applicationName: 'seed',
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
    tokenId,
    scopes: new Set(ACCESS_SCOPES),
  };
  const catalog = new ProductService(database);
  for (const product of SAMPLE_PRODUCTS) {
    const result = await catalog.create(tenant, product);
    if (!result.ok) {
      throw new Error(`Seed product "${product.title}": ${JSON.stringify(result.errors)}`);
    }
  }

  const query = '{ shop { name } products(first: 5, query: \\"kameez\\") { nodes { title } } }';
  console.log(`
Created shop ${toPublicId('shop', shopId)} with ${SAMPLE_PRODUCTS.length} products.

Admin API access token (shown once, keep it safe):
  ${token}

Try it (with \`pnpm dev:api\` running):
  curl -s http://localhost:${config.PORT}${ADMIN_GRAPHQL_PATH} \\
    -H 'content-type: application/json' \\
    -H '${ACCESS_TOKEN_HEADER}: ${token}' \\
    -d '{"query":"${query}"}'
`);
} finally {
  await database.close();
}
