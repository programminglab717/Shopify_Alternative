import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import {
  UrlRedirectImportRowError,
  UrlRedirectService,
  UrlRedirectsImportPayload,
} from '@hatti/online-store/public';
import { readStoreRedirects, shopDomainOf } from '@hatti/shopify-admin';
import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { ShopifyStores, credentialsOf } from './shopify-stores.js';

/**
 * A Shopify store's URL redirects through its own Admin API (ONB-05, ADR-751): read as Shopify's
 * redirects export, which `urlRedirectsImport` takes as it takes a file.
 */
@Resolver()
export class RedirectsFromShopifyResolver {
  constructor(
    private readonly redirects: UrlRedirectService,
    private readonly shopify: ShopifyStores,
  ) {}

  @Mutation(() => UrlRedirectsImportPayload, {
    description:
      "Imports a Shopify store's URL redirects through its own Admin API, as urlRedirectsImport " +
      "imports Shopify's redirects export (ONB-05, ADR-751), so links to the old store's " +
      'addresses keep working. Give the store and its app as productsImportFromShopify takes ' +
      'them; the app needs the read_online_store_navigation access scope. Paths the shop has a ' +
      'redirect from are left as they are; row errors name each path. Nothing given is kept. ' +
      'dryRun reads the store and counts, changing nothing.',
  })
  @RequireScopes('write_online_store_navigation')
  async urlRedirectsImportFromShopify(
    @CurrentTenant() tenant: TenantContext,
    @Args('store', {
      description:
        "The store's address at Shopify, as zari.myshopify.com, its name, or a link to its admin.",
    })
    store: string,
    @Args('accessToken', { nullable: true }) accessToken?: string,
    @Args('clientId', { nullable: true }) clientId?: string,
    @Args('clientSecret', { nullable: true }) clientSecret?: string,
    @Args('dryRun', { nullable: true }) dryRun?: boolean,
  ): Promise<UrlRedirectsImportPayload> {
    const refused = (field: string[] | null, code: string, message: string) =>
      Object.assign(new UrlRedirectsImportPayload(), {
        rows: 0,
        created: 0,
        skipped: 0,
        rowErrors: [],
        rowErrorCount: 0,
        dryRun: dryRun ?? false,
        userErrors: [UserError.of(field, code, message)],
      });
    const shop = shopDomainOf(store);
    if (!shop) {
      return refused(
        ['store'],
        'INVALID',
        "Give the store's address at Shopify, as zari.myshopify.com, or its admin's link",
      );
    }
    const credentials = credentialsOf(accessToken, clientId, clientSecret);
    if (!credentials) {
      return refused(
        ['accessToken'],
        'BLANK',
        "Give the access token of the store's app, or the client ID and secret of its app",
      );
    }
    const read = await readStoreRedirects(
      this.shopify.connect(shop, credentials),
      this.shopify.bulk,
    );
    if (!read.ok) {
      const field =
        read.kind === 'credentials' || read.kind === 'scope'
          ? ['accessToken']
          : read.kind === 'store'
            ? ['store']
            : null;
      return refused(field, read.kind === 'busy' ? 'UNAVAILABLE' : 'INVALID', read.message);
    }
    if (read.value.redirects === 0) {
      return refused(['store'], 'BLANK', `${read.value.storeName} has no redirects`);
    }
    const result = await this.redirects.import(tenant, read.value.csv, { dryRun: dryRun ?? false });
    if (!result.ok) {
      return Object.assign(new UrlRedirectsImportPayload(), {
        rows: 0,
        created: 0,
        skipped: 0,
        rowErrors: [],
        rowErrorCount: 0,
        dryRun: dryRun ?? false,
        userErrors: UserError.list(result.errors),
      });
    }
    return Object.assign(new UrlRedirectsImportPayload(), {
      ...result.value,
      // No file to look a row up in: each names its path.
      rowErrors: result.value.rowErrors.map((error) =>
        Object.assign(new UrlRedirectImportRowError(), {
          ...error,
          path: read.value.rowPaths[error.row - 2] ?? null,
        }),
      ),
      userErrors: [],
    });
  }
}
