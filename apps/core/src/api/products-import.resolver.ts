import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import {
  MediaService,
  ProductImportService,
  ProductService,
  type ImportedStock,
} from '@hatti/catalog/public';
import { InventoryService, LocationService } from '@hatti/inventory/public';
import { readStoreProducts, shopDomainOf, type StoreVideo } from '@hatti/shopify-admin';
import {
  Args,
  Field,
  Int,
  Mutation,
  ObjectType,
  Resolver,
  registerEnumType,
} from '@nestjs/graphql';
import { ShopifyStores, credentialsOf } from './shopify-stores.js';

/** Variants given their stock in one change, as `inventorySetQuantities` takes them. */
const STOCK_BATCH = 250;

/** Whose product export a file is (ADR-482). */
export enum ProductImportFormat {
  SHOPIFY = 'shopify',
  WOOCOMMERCE = 'woocommerce',
  INSTAGRAM = 'instagram',
}

registerEnumType(ProductImportFormat, {
  name: 'ProductImportFormat',
  description: "Whose product export an import's file is.",
  valuesMap: {
    SHOPIFY: { description: "Shopify's product CSV, rows grouped by Handle (ONB-05)." },
    WOOCOMMERCE: {
      description:
        "WooCommerce's product CSV, as Products > Export writes it: a row for each simple or " +
        'variable product, and one for each variation naming its product in Parent (ONB-06).',
    },
    INSTAGRAM: {
      description:
        "A shop's Instagram posts, as JSON: its API's media list, or posts_1.json from " +
        "Instagram's own download. Each post with a caption is a draft product, its title, " +
        'price, sizes, colours, hashtags and eastern wear read from the caption, its photos by ' +
        'address (ONB-04, ADR-501).',
    },
  },
});

/** Where stock set by an import says it came from, in the stock history, and its column. */
const IMPORTED: Record<ProductImportFormat, { reference: string; column: string }> = {
  [ProductImportFormat.SHOPIFY]: {
    reference: 'hatti://imports/shopify-products',
    column: 'Variant Inventory Qty',
  },
  [ProductImportFormat.WOOCOMMERCE]: {
    reference: 'hatti://imports/woocommerce-products',
    column: 'Stock',
  },
  // Posts say no stock: none is ever set from them.
  [ProductImportFormat.INSTAGRAM]: {
    reference: 'hatti://imports/instagram-posts',
    column: 'caption',
  },
};

@ObjectType({ description: "A row of an import's file that did not go in as it was, and why." })
export class ProductImportRowError {
  @Field(() => Int, { description: 'Its row in the file, the headings being row 1.' })
  row!: number;

  @Field(() => String, {
    nullable: true,
    description: "The column's heading in the file; null for the row as a whole.",
  })
  column!: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      "The handle of the row's product, where the import read it from a store: there is no " +
      'file to look the row up in (ADR-749). Null for a file.',
  })
  handle!: string | null;

  @Field()
  message!: string;
}

@ObjectType()
export class ProductsImportPayload {
  @Field(() => Int, { description: 'Rows under the headings.' })
  rows!: number;

  @Field(() => Int, { description: 'Products made, or that would be in a dry run.' })
  created!: number;

  @Field(() => Int, {
    description:
      'Products the shop had, updated from the file with overwrite, or that would be in a dry run.',
  })
  updated!: number;

  @Field(() => Int, { description: 'Variants made: of new products, and new to those updated.' })
  variants!: number;

  @Field(() => Int, { description: 'Images added by their addresses.' })
  images!: number;

  @Field(() => Int, {
    description:
      "Videos added to products from a Shopify store's, its own by their MP4s and YouTube's or " +
      "Vimeo's by their addresses (ADR-794), those the store's products have in a dry run; " +
      'none from a file, which has no videos.',
  })
  videos!: number;

  @Field(() => Int, {
    description:
      'Products left as they are: the shop has products with their handles already, and the ' +
      'import was not told to overwrite them.',
  })
  skipped!: number;

  @Field(() => Int, {
    description: 'Variants given the stock the file tracked for them, at the primary location.',
  })
  stocked!: number;

  @Field(() => [ProductImportRowError], { description: 'The first 100, in the order of the file.' })
  rowErrors!: ProductImportRowError[];

  @Field(() => Int)
  rowErrorCount!: number;

  @Field()
  dryRun!: boolean;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

/**
 * Products from a Shopify store's product export (ONB-05), or a WooCommerce store's (ONB-06,
 * ADR-482). The catalog makes the products and their images; the core then gives them the stock
 * the file tracked, through the inventory module, which the catalog cannot reach.
 */
@Resolver()
export class ProductsImportResolver {
  constructor(
    private readonly imports: ProductImportService,
    private readonly products: ProductService,
    private readonly media: MediaService,
    private readonly inventory: InventoryService,
    private readonly locations: LocationService,
    private readonly shopify: ShopifyStores,
  ) {}

  @Mutation(() => ProductsImportPayload, {
    description:
      'Imports products from a Shopify product export, as CSV, with format WOOCOMMERCE from a ' +
      "WooCommerce one, or with INSTAGRAM from a shop's Instagram posts as drafts, made as Shopify's file would make them: rows grouped by Handle into " +
      'products with their options, variants, prices, SKUs, weights, tags, status and images ' +
      '(by address, https only), each keeping its handle, and the stock the store tracked at the ' +
      'primary location. Products whose handles the shop has are left as they are, or with ' +
      "overwrite updated from the file: their fields from the file's columns, a blank cell " +
      'clearing an optional one; their variants matched by option values, new combinations ' +
      "added; the images they lack added; their variants' stock left alone. productsExport " +
      'writes such a file. dryRun checks the file and counts, changing nothing.',
  })
  @RequireScopes('write_products', 'write_inventory')
  async productsImport(
    @CurrentTenant() tenant: TenantContext,
    @Args('csv', { description: "The file's text, at most 1,500,000 characters." }) csv: string,
    @Args('dryRun', { nullable: true }) dryRun?: boolean,
    @Args('overwrite', {
      nullable: true,
      description:
        "Update the shop's products whose handles the file has, rather than leave them: their " +
        'options must be the same. Default false.',
    })
    overwrite?: boolean,
    @Args('format', {
      type: () => ProductImportFormat,
      nullable: true,
      description: 'Whose export the file is. Default SHOPIFY.',
    })
    format?: ProductImportFormat,
  ): Promise<ProductsImportPayload> {
    return this.#import(tenant, csv, {
      dryRun: dryRun ?? false,
      overwrite: overwrite ?? false,
      format: format ?? ProductImportFormat.SHOPIFY,
    });
  }

  @Mutation(() => ProductsImportPayload, {
    description:
      "Imports a Shopify store's products through its own Admin API, as productsImport imports " +
      "Shopify's product export, so nothing is downloaded or uploaded by hand (ONB-05, ADR-749): " +
      'their options, variants, prices, costs, SKUs, barcodes, weights, tags, status, SEO, ' +
      'category, images and videos (ADR-794), each keeping its handle, and the stock the store ' +
      'tracked at the ' +
      "shop's primary location. Give the store's address and the Admin API access token of a " +
      "custom app made in the store's admin, or the client ID and secret of an app made in " +
      "Shopify's Dev Dashboard and installed on the store; the app needs the read_products and " +
      'read_inventory access scopes. Nothing given is kept. Shopify exports the products in the ' +
      'background, which is waited for up to 90 seconds. The store must price in rupees. Row ' +
      "errors name each product's handle. dryRun reads the store and counts, changing nothing.",
  })
  @RequireScopes('write_products', 'write_inventory')
  async productsImportFromShopify(
    @CurrentTenant() tenant: TenantContext,
    @Args('store', {
      description:
        "The store's address at Shopify, as zari.myshopify.com, its name, or a link to its admin.",
    })
    store: string,
    @Args('accessToken', {
      nullable: true,
      description: "The Admin API access token of the store's custom app, shpat_ and the rest.",
    })
    accessToken?: string,
    @Args('clientId', {
      nullable: true,
      description: "The client ID of the store's Dev Dashboard app, with its secret.",
    })
    clientId?: string,
    @Args('clientSecret', { nullable: true }) clientSecret?: string,
    @Args('dryRun', { nullable: true }) dryRun?: boolean,
    @Args('overwrite', {
      nullable: true,
      description:
        "Update the shop's products whose handles the store has, rather than leave them: their " +
        'options must be the same. Default false.',
    })
    overwrite?: boolean,
  ): Promise<ProductsImportPayload> {
    const refused = (field: string[] | null, code: string, message: string) =>
      payloadOf(dryRun ?? false, [UserError.of(field, code, message)]);
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
    const read = await readStoreProducts(
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
    const { currency, storeName, products, csv, rowHandles } = read.value;
    if (currency !== 'PKR') {
      return refused(
        ['store'],
        'INVALID',
        `${storeName} prices in ${currency}, and Hatti's shops in rupees: export its products ` +
          'as a CSV, change their prices to rupees and import the file',
      );
    }
    if (products === 0) return refused(['store'], 'BLANK', `${storeName} has no products`);
    const payload = await this.#import(
      tenant,
      csv,
      {
        dryRun: dryRun ?? false,
        overwrite: overwrite ?? false,
        format: ProductImportFormat.SHOPIFY,
      },
      {
        reference: `hatti://imports/shopify-store/${shop}`,
        rowHandles,
        tooMuch:
          `${storeName} has more products than one import takes: export them from Shopify as ` +
          'CSV files of fewer products each, and import those',
      },
    );
    // Its products' videos, which Shopify's file has not (ADR-794), once the products are made.
    const videos = read.value.videos;
    if (payload.userErrors.length > 0) return payload;
    payload.videos =
      (dryRun ?? false)
        ? videos.reduce((sum, product) => sum + product.videos.length, 0)
        : await this.#videos(tenant, videos);
    return payload;
  }

  /**
   * Adds the store's products' videos to the shop's products of the same handles (ADR-794), after
   * their images: a video Shopify keeps by its MP4, which the worker fetches and checks, and a
   * YouTube or Vimeo one by its address. A product with a video already is left as it is, so
   * importing again adds none. How many were added.
   */
  async #videos(
    tenant: TenantContext,
    stored: readonly { handle: string; videos: StoreVideo[] }[],
  ): Promise<number> {
    if (stored.length === 0) return 0;
    const ids = await this.products.idsByHandle(
      tenant,
      stored.map((product) => product.handle),
    );
    let added = 0;
    for (const { handle, videos } of stored) {
      const id = ids.get(handle);
      const product = id && (await this.products.get(tenant, id));
      if (!product || product.media.some((media) => media.mediaType !== 'image')) continue;
      const made = await this.media.create(
        tenant,
        product.id,
        videos.map((video) => ({
          originalSource: video.url,
          mediaContentType:
            video.type === 'video' ? ('VIDEO' as const) : ('EXTERNAL_VIDEO' as const),
          alt: video.alt,
        })),
      );
      if (made.ok) added += videos.length;
    }
    return added;
  }

  /**
   * Products from a file, or from a store as Shopify's export would give them; then the stock it
   * tracked. Row errors name their products' handles where the rows came from a store.
   */
  async #import(
    tenant: TenantContext,
    csv: string,
    options: { dryRun: boolean; overwrite: boolean; format: ProductImportFormat },
    store?: { reference: string; rowHandles: readonly string[]; tooMuch: string },
  ): Promise<ProductsImportPayload> {
    const result = await this.imports.import(tenant, csv, options);
    if (!result.ok) {
      const errors = UserError.list(result.errors);
      return payloadOf(
        options.dryRun,
        store
          ? errors.map((error) =>
              error.code === 'TOO_LONG' || error.code === 'TOO_MANY'
                ? UserError.of(['store'], error.code, store.tooMuch)
                : error,
            )
          : errors,
      );
    }
    const { stock, rowErrors, rowErrorCount, ...counts } = result.value;
    const imported = store
      ? { ...IMPORTED[options.format], reference: store.reference }
      : IMPORTED[options.format];
    const stockErrors = await this.#stock(tenant, stock, imported);
    const errors = [...rowErrors, ...stockErrors].sort((a, b) => a.row - b.row);
    return Object.assign(new ProductsImportPayload(), {
      ...counts,
      stocked: stock.length - stockErrors.length,
      rowErrors: errors.slice(0, 100).map((error) =>
        Object.assign(new ProductImportRowError(), {
          ...error,
          handle: store?.rowHandles[error.row - 2] ?? null,
        }),
      ),
      rowErrorCount: rowErrorCount + stockErrors.length,
      userErrors: [],
    });
  }

  /**
   * Sets the stock the file tracked, on hand at the primary location, a batch at a time; and
   * keeps selling what the store sold when out of stock. What could not be set, by its row.
   */
  async #stock(
    tenant: TenantContext,
    stock: ImportedStock[],
    imported: { reference: string; column: string },
  ): Promise<{ row: number; column: string; message: string }[]> {
    if (stock.length === 0) return [];
    const location = await this.locations.primary(tenant);
    const errors: { row: number; column: string; message: string }[] = [];
    for (let start = 0; start < stock.length; start += STOCK_BATCH) {
      const batch = stock.slice(start, start + STOCK_BATCH);
      const set = await this.inventory.setQuantities(tenant, {
        name: 'on_hand',
        reason: 'correction',
        referenceDocumentUri: imported.reference,
        quantities: batch.map((entry) => ({
          inventoryItemId: entry.variantId,
          locationId: location.id,
          quantity: entry.quantity,
        })),
      });
      if (!set.ok) {
        const message = set.errors[0]?.message ?? 'Stock could not be set';
        errors.push(
          ...batch.map((entry) => ({ row: entry.row, column: imported.column, message })),
        );
        continue;
      }
      for (const entry of batch.filter((each) => each.continueSelling)) {
        await this.inventory.updateItem(tenant, entry.variantId, { inventoryPolicy: 'continue' });
      }
    }
    return errors;
  }
}

/** A payload that imported nothing, for what was refused before anything was read. */
function payloadOf(dryRun: boolean, userErrors: UserError[]): ProductsImportPayload {
  return Object.assign(new ProductsImportPayload(), {
    rows: 0,
    created: 0,
    updated: 0,
    variants: 0,
    images: 0,
    videos: 0,
    skipped: 0,
    stocked: 0,
    rowErrors: [],
    rowErrorCount: 0,
    dryRun,
    userErrors,
  });
}
