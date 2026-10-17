import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { ProductImportService, type ImportedStock } from '@hatti/catalog/public';
import { InventoryService, LocationService } from '@hatti/inventory/public';
import {
  Args,
  Field,
  Int,
  Mutation,
  ObjectType,
  Resolver,
  registerEnumType,
} from '@nestjs/graphql';

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
    private readonly inventory: InventoryService,
    private readonly locations: LocationService,
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
    const from = format ?? ProductImportFormat.SHOPIFY;
    const result = await this.imports.import(tenant, csv, {
      dryRun: dryRun ?? false,
      overwrite: overwrite ?? false,
      format: from,
    });
    if (!result.ok) {
      return Object.assign(new ProductsImportPayload(), {
        rows: 0,
        created: 0,
        updated: 0,
        variants: 0,
        images: 0,
        skipped: 0,
        stocked: 0,
        rowErrors: [],
        rowErrorCount: 0,
        dryRun: dryRun ?? false,
        userErrors: UserError.list(result.errors),
      });
    }
    const { stock, rowErrors, rowErrorCount, ...counts } = result.value;
    const stockErrors = await this.#stock(tenant, stock, IMPORTED[from]);
    const errors = [...rowErrors, ...stockErrors].sort((a, b) => a.row - b.row);
    return Object.assign(new ProductsImportPayload(), {
      ...counts,
      stocked: stock.length - stockErrors.length,
      rowErrors: errors
        .slice(0, 100)
        .map((error) => Object.assign(new ProductImportRowError(), error)),
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
