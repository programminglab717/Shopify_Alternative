import {
  CurrentTenant,
  RequireScopes,
  UserError,
  badUserInput,
  type TenantContext,
} from '@hatti/api';
import {
  STOCK_FILE_LIMITS,
  StockFileService,
  parseProductSearch,
  type StockCount,
  type StockLevel,
} from '@hatti/catalog/public';
import { tryFromPublicId } from '@hatti/ids';
import { InventoryService, LocationService } from '@hatti/inventory/public';
import { Args, Field, ID, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';

/** Counts set in one change, as `inventorySetQuantities` takes them. */
const COUNT_BATCH = 250;

/** Row errors a result lists; it counts them all. */
const ROW_ERRORS = 100;

/** Where a count from a file says it came from, in the stock history. */
const COUNT_REFERENCE = 'hatti://imports/shopify-inventory';

@ObjectType({
  description:
    "The shop's stock as Shopify's inventory CSV (CAT-05), which Shopify's inventory import and " +
    'inventoryImport both take back.',
})
export class InventoryExport {
  @Field({
    description:
      "CSV under the headings of Shopify's inventory export with all its states: a row for each " +
      'tracked variant at each active location, the products oldest first, On hand (new) blank ' +
      'for a count to fill in.',
  })
  csv!: string;

  @Field(() => Int)
  productCount!: number;

  @Field(() => Int, { description: 'Rows under the headings, as an import counts them.' })
  rowCount!: number;
}

@ObjectType({ description: 'A row of a stock file that was not counted, and why.' })
export class InventoryImportRowError {
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
export class InventoryImportPayload {
  @Field(() => Int, { description: 'Rows under the headings.' })
  rows!: number;

  @Field(() => Int, {
    description: "Levels set to the file's On hand (new), or that would be in a dry run.",
  })
  counted!: number;

  @Field(() => Int, {
    description: 'Rows that change nothing: On hand (new) blank, or what is on hand already.',
  })
  unchanged!: number;

  @Field(() => [InventoryImportRowError], {
    description: `The first ${ROW_ERRORS}, in the order of the file.`,
  })
  rowErrors!: InventoryImportRowError[];

  @Field(() => Int)
  rowErrorCount!: number;

  @Field()
  dryRun!: boolean;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

type RowError = { row: number; column: string | null; message: string };

/** A count to set: a row of the file, its variant and location found. */
interface Count extends StockCount {
  locationId: string;
  locationName: string;
}

/**
 * Stock as Shopify's inventory CSV (CAT-05, ADR-133). The catalog writes and reads the file,
 * naming each variant by its product's handle and its options; the core gives it the stock, and
 * sets what a count says, through the inventory module, which the catalog cannot reach.
 */
@Resolver()
export class InventoryFileResolver {
  constructor(
    private readonly files: StockFileService,
    private readonly inventory: InventoryService,
    private readonly locations: LocationService,
  ) {}

  @Query(() => InventoryExport, {
    description:
      "The shop's stock as Shopify's inventory CSV, of the products a search matches as the " +
      'products list does, at one location or all active ones: a row for each tracked variant ' +
      'at each, with what is on hand, committed to orders, available and not, for a stock count ' +
      'in a spreadsheet that inventoryImport then takes back. As much as one import takes, ' +
      `${STOCK_FILE_LIMITS.rows.toLocaleString('en')} rows and ` +
      `${STOCK_FILE_LIMITS.csv.toLocaleString('en')} characters, a larger shop's in parts.`,
  })
  @RequireScopes('read_products', 'read_inventory')
  async inventoryExport(
    @CurrentTenant() tenant: TenantContext,
    @Args('query', {
      type: () => String,
      nullable: true,
      description: 'Searches as `products(query:)` does.',
    })
    query?: string | null,
    @Args('locationId', {
      type: () => ID,
      nullable: true,
      description: 'Only this location; every active one if left out.',
    })
    locationId?: string | null,
  ): Promise<InventoryExport> {
    const search = query ?? '';
    const parsed = parseProductSearch(search);
    if (!parsed.ok) throw badUserInput(parsed.error);
    let only: string | null = null;
    if (locationId) {
      only = tryFromPublicId(locationId, 'location');
      const location = only ? await this.locations.get(tenant, only) : null;
      if (!location?.isActive) throw badUserInput('Location not found, or not active');
    }
    const result = await this.files.export(tenant, search, (variantIds) =>
      this.#levels(tenant, variantIds, only),
    );
    if (!result.ok) throw badUserInput(result.errors[0]!.message);
    return Object.assign(new InventoryExport(), {
      csv: result.value.csv,
      productCount: result.value.products,
      rowCount: result.value.rows,
    });
  }

  @Mutation(() => InventoryImportPayload, {
    description:
      "Counts stock from Shopify's inventory CSV, as inventoryExport or Shopify writes it: each " +
      'row whose On hand (new) is filled in sets what its variant has on hand at its location, ' +
      "found by its product's handle and option values and the location's name, a stock count " +
      'in the stock history. A row whose On hand (current) is no longer what is on hand, as ' +
      'when stock sold since the file was exported, is not counted, and said. Rows are counted ' +
      `${COUNT_BATCH} at a time. dryRun checks the file and counts, changing nothing.`,
  })
  @RequireScopes('write_inventory', 'read_products')
  async inventoryImport(
    @CurrentTenant() tenant: TenantContext,
    @Args('csv', { description: "The file's text, at most 1,500,000 characters." }) csv: string,
    @Args('dryRun', { nullable: true }) dryRun?: boolean,
  ): Promise<InventoryImportPayload> {
    const dry = dryRun ?? false;
    const read = await this.files.read(tenant, csv);
    if (!read.ok) {
      return Object.assign(new InventoryImportPayload(), {
        rows: 0,
        counted: 0,
        unchanged: 0,
        rowErrors: [],
        rowErrorCount: 0,
        dryRun: dry,
        userErrors: UserError.list(read.errors),
      });
    }
    const { counts, problems } = read.value;
    const errors: RowError[] = [...problems];
    let unchanged = read.value.unchanged;

    // The shop's active locations, by name in any case: at most 50.
    const active = await this.locations.list(tenant, { first: 50 });
    const byName = new Map(active.items.map((location) => [location.name.toLowerCase(), location]));
    const items = await this.inventory.itemsOf(tenant, [
      ...new Set(counts.map((count) => count.variantId)),
    ]);
    const seen = new Map<string, number>();
    const toSet: Count[] = [];
    for (const count of counts) {
      const location = byName.get(count.location.toLowerCase());
      if (!location) {
        errors.push({
          row: count.row,
          column: 'Location',
          message: `No active location is named "${count.location}"`,
        });
        continue;
      }
      const key = `${count.variantId}/${location.id}`;
      const first = seen.get(key);
      if (first !== undefined) {
        errors.push({
          row: count.row,
          column: null,
          message: `Row ${first} counts ${count.name} at ${location.name} already`,
        });
        continue;
      }
      seen.set(key, count.row);
      const item = items.get(count.variantId);
      const onHand = item?.levels.find((level) => level.location.id === location.id)?.onHand ?? 0;
      if (count.current !== null && count.current !== onHand) {
        errors.push({
          row: count.row,
          column: 'On hand (current)',
          message:
            `${count.name} has ${onHand} on hand at ${location.name} now, not ` +
            `${count.current} as when the file was exported: export it again`,
        });
        continue;
      }
      if (item?.tracked && count.quantity === onHand) {
        unchanged += 1;
        continue;
      }
      toSet.push({ ...count, locationId: location.id, locationName: location.name });
    }

    let counted = 0;
    if (!dry) {
      for (let start = 0; start < toSet.length; start += COUNT_BATCH) {
        const batch = toSet.slice(start, start + COUNT_BATCH);
        const set = await this.inventory.setQuantities(tenant, {
          name: 'on_hand',
          reason: 'cycle_count_available',
          referenceDocumentUri: COUNT_REFERENCE,
          quantities: batch.map((count) => ({
            inventoryItemId: count.variantId,
            locationId: count.locationId,
            quantity: count.quantity,
            compareQuantity: count.current,
          })),
        });
        if (set.ok) {
          counted += batch.length;
          continue;
        }
        // All of a batch is set, or none: each row says why, its own error or another's.
        const own = new Map<number, string>();
        for (const error of set.errors) {
          const at = Number(error.field[2]);
          if (Number.isInteger(at) && batch[at]) own.set(at, error.message);
        }
        const failed = [...own.keys()].map((at) => batch[at]!.row);
        batch.forEach((count, at) => {
          errors.push({
            row: count.row,
            column: own.has(at) ? 'On hand (new)' : null,
            message:
              own.get(at) ??
              `Not counted, as row ${failed[0] ?? '?'} of the same ${COUNT_BATCH} could not be: ` +
                'import the file again',
          });
        });
      }
    } else {
      counted = toSet.length;
    }
    errors.sort((a, b) => a.row - b.row);
    return Object.assign(new InventoryImportPayload(), {
      rows: read.value.rows,
      counted,
      unchanged,
      rowErrors: errors
        .slice(0, ROW_ERRORS)
        .map((error) => Object.assign(new InventoryImportRowError(), error)),
      rowErrorCount: errors.length,
      dryRun: dry,
      userErrors: [],
    });
  }

  /**
   * Each tracked variant's levels at active locations, or `only` that one: on hand, committed,
   * available, and not available though on hand, held for checkouts or kept back.
   */
  async #levels(
    tenant: TenantContext,
    variantIds: string[],
    only: string | null,
  ): Promise<Map<string, StockLevel[]>> {
    const items = await this.inventory.itemsOf(tenant, variantIds);
    const levels = new Map<string, StockLevel[]>();
    for (const [variantId, item] of items) {
      if (!item.tracked) continue;
      levels.set(
        variantId,
        item.levels
          .filter((level) => only === null || level.location.id === only)
          .map((level) => ({
            location: level.location.name,
            onHand: level.onHand,
            committed: level.committed,
            available: level.available,
            unavailable: level.reserved + level.safetyStock,
          })),
      );
    }
    return levels;
  }
}
