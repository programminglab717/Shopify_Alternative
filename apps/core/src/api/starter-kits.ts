import type { TenantContext } from '@hatti/api';
import {
  CollectionService,
  SizeChartService,
  type CollectionRuleSetInput,
  type SizeChartInput,
} from '@hatti/catalog/public';
import { MenuService, type MenuItemInput, type MenuItemRecord } from '@hatti/online-store/public';
import { Injectable } from '@nestjs/common';

// Vertical starter kits (ONB-13, ADR-486): what a new shop of a kind sells by, set up in one
// go. Each kit is smart collections a shop's tags fill, the size chart its clothes need, and
// links to them in the main menu. Applying one makes what is not there yet and leaves what is,
// so a shop may apply it again, or another kit after it.

export const STARTER_KITS = ['fashion', 'jewellery', 'beauty', 'electronics', 'grocery'] as const;
export type StarterKitValue = (typeof STARTER_KITS)[number];

export interface KitCollection {
  title: string;
  handle: string;
  description: string;
  /** The tag that puts a product in it; none for the collections every kit has. */
  tag: string | null;
  ruleSet: CollectionRuleSetInput;
}

export interface StarterKit {
  kit: StarterKitValue;
  collections: readonly KitCollection[];
  sizeCharts: readonly (SizeChartInput & { name: string })[];
}

const byTag = (title: string, handle: string, tag: string, description: string): KitCollection => ({
  title,
  handle,
  description,
  tag,
  ruleSet: {
    appliedDisjunctively: false,
    rules: [{ column: 'tag', relation: 'equals', condition: tag }],
  },
});

/** The newest of everything for sale. */
const NEW_ARRIVALS: KitCollection = {
  title: 'New arrivals',
  handle: 'new-arrivals',
  description: 'The latest in the shop.',
  tag: null,
  ruleSet: {
    appliedDisjunctively: false,
    rules: [{ column: 'variant_price', relation: 'greater_than', condition: '0' }],
  },
};

/** Whatever is priced below its compare-at price. */
const SALE: KitCollection = {
  title: 'Sale',
  handle: 'sale',
  description: 'Everything on sale now.',
  tag: null,
  ruleSet: {
    appliedDisjunctively: false,
    rules: [{ column: 'is_price_reduced', relation: 'is_set', condition: '' }],
  },
};

const KITS: Record<StarterKitValue, StarterKit> = {
  fashion: {
    kit: 'fashion',
    collections: [
      NEW_ARRIVALS,
      byTag('Unstitched', 'unstitched', 'unstitched', 'Unstitched suits and fabric to tailor.'),
      byTag('Ready to wear', 'ready-to-wear', 'stitched', 'Stitched, ready to wear.'),
      byTag('Lawn', 'lawn', 'lawn', 'Lawn for the summer.'),
      byTag('Formal', 'formal', 'formal', 'Formal and party wear.'),
      byTag('Eid collection', 'eid-collection', 'eid', 'Dressed for Eid.'),
      SALE,
    ],
    sizeCharts: [
      {
        name: 'Kameez (women)',
        unit: 'in',
        columns: ['Chest', 'Waist', 'Hip', 'Shirt length'],
        rows: [
          { size: 'XS', values: [34, 30, 36, 40] },
          { size: 'S', values: [36, 32, 38, 41] },
          { size: 'M', values: [38, 34, 40, 42] },
          { size: 'L', values: [41, 37, 43, 43] },
          { size: 'XL', values: [44, 40, 46, 44] },
        ],
        note: 'Body measurements; the shirt is cut a little looser.',
      },
      {
        name: 'Kurta (men)',
        unit: 'in',
        columns: ['Chest', 'Shoulder', 'Kurta length'],
        rows: [
          { size: 'S', values: [38, 17, 40] },
          { size: 'M', values: [40, 18, 41] },
          { size: 'L', values: [42, 19, 42] },
          { size: 'XL', values: [44, 20, 43] },
        ],
        note: null,
      },
    ],
  },
  jewellery: {
    kit: 'jewellery',
    collections: [
      NEW_ARRIVALS,
      byTag('Earrings', 'earrings', 'earrings', 'Jhumkas, studs and drops.'),
      byTag('Necklaces', 'necklaces', 'necklaces', 'Necklaces and sets.'),
      byTag('Bangles', 'bangles', 'bangles', 'Bangles and bracelets.'),
      byTag('Rings', 'rings', 'rings', 'Rings for every day and for occasions.'),
      byTag('Bridal sets', 'bridal-sets', 'bridal', 'Sets for the bride.'),
      SALE,
    ],
    sizeCharts: [],
  },
  beauty: {
    kit: 'beauty',
    collections: [
      NEW_ARRIVALS,
      byTag('Skin care', 'skin-care', 'skin-care', 'Cleansers, serums and creams.'),
      byTag('Makeup', 'makeup', 'makeup', 'Face, eyes and lips.'),
      byTag('Hair care', 'hair-care', 'hair-care', 'Oils, shampoos and treatments.'),
      byTag('Fragrance', 'fragrance', 'fragrance', 'Perfumes and attars.'),
      SALE,
    ],
    sizeCharts: [],
  },
  electronics: {
    kit: 'electronics',
    collections: [
      NEW_ARRIVALS,
      byTag(
        'Mobile accessories',
        'mobile-accessories',
        'mobile-accessories',
        'Chargers, cables, cases and power banks.',
      ),
      byTag('Audio', 'audio', 'audio', 'Earbuds, headphones and speakers.'),
      byTag('Smart watches', 'smart-watches', 'smart-watches', 'Smart watches and bands.'),
      byTag('Home appliances', 'home-appliances', 'home-appliances', 'For the kitchen and home.'),
      SALE,
    ],
    sizeCharts: [],
  },
  grocery: {
    kit: 'grocery',
    collections: [
      NEW_ARRIVALS,
      byTag('Bakery', 'bakery', 'bakery', 'Fresh breads, cakes and biscuits.'),
      byTag('Mithai', 'mithai', 'mithai', 'Sweets for every occasion.'),
      byTag('Dry fruits', 'dry-fruits', 'dry-fruits', 'Nuts and dried fruit.'),
      byTag('Spices', 'spices', 'spices', 'Masalas and whole spices.'),
      { ...SALE, title: 'Deals', handle: 'deals', description: "This week's deals." },
    ],
    sizeCharts: [],
  },
};

/** A kit, as the Admin API shows it before it is applied. */
export function starterKit(kit: StarterKitValue): StarterKit {
  return KITS[kit];
}

export interface KitApplied {
  collectionsMade: number;
  collectionsKept: number;
  sizeChartsMade: number;
  menuLinksAdded: number;
}

/** A menu item as it was saved, given back whole so the menu keeps it. */
function inputOf(item: MenuItemRecord): MenuItemInput {
  return {
    id: item.id,
    title: item.title,
    type: item.type,
    resourceId: item.resourceId,
    url: item.type === 'http' ? item.url : null,
    items: item.items.map(inputOf),
  };
}

/** Applies starter kits through the catalog's and the online store's facades (ADR-486). */
@Injectable()
export class StarterKitService {
  constructor(
    private readonly collections: CollectionService,
    private readonly sizeCharts: SizeChartService,
    private readonly menus: MenuService,
  ) {}

  /**
   * Makes the kit's collections and size charts that the shop does not have, by handle and by
   * name, and links its collections from the main menu where it does not link them yet.
   */
  async apply(tenant: TenantContext, kit: StarterKitValue): Promise<KitApplied> {
    const { collections, sizeCharts } = KITS[kit];
    const applied: KitApplied = {
      collectionsMade: 0,
      collectionsKept: 0,
      sizeChartsMade: 0,
      menuLinksAdded: 0,
    };
    const linked: { id: string; title: string }[] = [];
    for (const each of collections) {
      const found = await this.collections.getByHandle(tenant, each.handle);
      if (found) {
        applied.collectionsKept += 1;
        linked.push({ id: found.id, title: found.title });
        continue;
      }
      const made = await this.collections.create(tenant, {
        title: each.title,
        handle: each.handle,
        description: each.description,
        sortOrder: 'created_desc',
        ruleSet: each.ruleSet,
      });
      if (!made.ok) throw new Error(`Kit collection ${each.handle}: ${made.errors[0]?.message}`);
      applied.collectionsMade += 1;
      linked.push({ id: made.value.id, title: made.value.title });
    }

    const charts = new Set((await this.sizeCharts.list(tenant)).map((chart) => chart.name));
    for (const chart of sizeCharts) {
      if (charts.has(chart.name)) continue;
      const made = await this.sizeCharts.create(tenant, chart);
      if (!made.ok) throw new Error(`Kit size chart ${chart.name}: ${made.errors[0]?.message}`);
      applied.sizeChartsMade += 1;
    }

    const { items: menus } = await this.menus.list(tenant, { first: 10 });
    const main = menus.find((menu) => menu.handle === 'main-menu');
    if (main) {
      const already = new Set(main.items.map((item) => item.resourceId));
      const added = linked.filter((collection) => !already.has(collection.id));
      if (added.length > 0) {
        const saved = await this.menus.update(tenant, main.id, {
          title: main.title,
          items: [
            ...main.items.map(inputOf),
            ...added.map((collection) => ({
              title: collection.title,
              type: 'collection',
              resourceId: collection.id,
            })),
          ],
        });
        if (!saved.ok) throw new Error(`Kit menu: ${saved.errors[0]?.message}`);
        applied.menuLinksAdded = added.length;
      }
    }
    return applied;
  }
}
