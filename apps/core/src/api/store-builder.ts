import { shopProfile, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import {
  BASE_THEME,
  PageService,
  PreferencesService,
  THEME_LIMITS,
  ThemeService,
} from '@hatti/online-store/public';
import { Injectable } from '@nestjs/common';
import { STARTER_KITS, StarterKitService, type StarterKitValue } from './starter-kits.js';

// The store builder (ONB-03, ADR-502): a new shop's owner says in a few lines what it sells, and
// the shop is set up from it in one go. The kind of shop it reads them as gives the starter kit
// (ADR-486), Hatti's theme for it (ADR-732) and the theme's accent colour; the lines themselves
// the About us page and what search engines are told of the home page. What the shop set already
// is left as it is.

export const STORE_BUILDER_LIMITS = {
  /** A description, in characters. */
  description: { min: 20, max: 2_000 },
  /** What search engines show of a page's title, and of its description. */
  seoTitle: 70,
  seoDescription: 160,
} as const;

/** Words that say what a shop sells, by the kit they call for. */
const KIT_WORDS: Record<StarterKitValue, readonly string[]> = {
  fashion: [
    'lawn',
    'kurta',
    'kurti',
    'suit',
    'suits',
    'dress',
    'dresses',
    'clothing',
    'clothes',
    'fashion',
    'abaya',
    'abayas',
    'shalwar',
    'kameez',
    'shirt',
    'shirts',
    'unstitched',
    'stitched',
    'bridal',
    'wear',
    'dupatta',
    'shawl',
    'shawls',
    'shoes',
    'khussa',
  ],
  jewellery: [
    'jewellery',
    'jewelry',
    'jewel',
    'earring',
    'earrings',
    'bangle',
    'bangles',
    'necklace',
    'necklaces',
    'ring',
    'rings',
    'kundan',
    'jhumka',
    'jhumkas',
    'silver',
    'gold',
  ],
  beauty: [
    'beauty',
    'skin',
    'skincare',
    'cosmetic',
    'cosmetics',
    'makeup',
    'serum',
    'hair',
    'perfume',
    'perfumes',
    'attar',
    'fragrance',
    'fragrances',
    'soap',
  ],
  electronics: [
    'phone',
    'phones',
    'mobile',
    'mobiles',
    'electronic',
    'electronics',
    'gadget',
    'gadgets',
    'charger',
    'chargers',
    'earbuds',
    'laptop',
    'laptops',
    'smartwatch',
    'speaker',
    'speakers',
  ],
  grocery: [
    'grocery',
    'groceries',
    'spice',
    'spices',
    'masala',
    'dry',
    'fruit',
    'fruits',
    'tea',
    'honey',
    'rice',
    'food',
    'achar',
    'pickle',
    'pickles',
    'ghee',
  ],
};

/** The accent each kind of shop starts with: one its buttons read well on, light or dark. */
export const KIT_ACCENTS: Record<StarterKitValue, string> = {
  fashion: '#9F1239',
  jewellery: '#A16207',
  beauty: '#BE185D',
  electronics: '#1D4ED8',
  grocery: '#15803D',
};

/** The theme each kind of shop starts on (ADR-732): Hatti's theme made for it, else Hatti Base. */
export const KIT_THEMES: Record<StarterKitValue, string> = {
  fashion: 'lawn',
  jewellery: BASE_THEME,
  beauty: BASE_THEME,
  electronics: 'bazaar',
  grocery: BASE_THEME,
};

/** The platform's own, for a shop whose kind its words don't say. */
const PLATFORM_ACCENT = '#0F766E';

/** What the store builder would make of a shop's description. */
export interface StorePlan {
  /** The kit its words call for most; null when they call for none. */
  kit: StarterKitValue | null;
  /** The handle of Hatti's theme it starts on, Hatti Base where its kind has none (ADR-732). */
  theme: string;
  accent: string;
  /** The About us page, as HTML. */
  about: string;
  seo: { title: string; description: string };
}

/** The kit a description's words call for most, the first of those it names as often; or none. */
export function kitOf(description: string): StarterKitValue | null {
  const words = description.toLowerCase().match(/[a-z]+/g) ?? [];
  let best: StarterKitValue | null = null;
  let most = 0;
  for (const kit of STARTER_KITS) {
    const named = words.filter((word) => KIT_WORDS[kit].includes(word)).length;
    if (named > most) {
      best = kit;
      most = named;
    }
  }
  return best;
}

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** At most `max` characters of `text`, cut at a word and ended with an ellipsis where cut. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max / 2)).trimEnd()}...`.slice(0, max);
}

/** What the store builder makes of `description` for the shop `shopName`. */
export function planStore(shopName: string, description: string, kit?: StarterKitValue | null) {
  const chosen = kit === undefined ? kitOf(description) : kit;
  const paragraphs = description
    .split(/\n\s*\n|\r\n\s*\r\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const flat = paragraphs.join(' ');
  const firstSentence = /^.*?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat;
  return {
    kit: chosen,
    theme: chosen ? KIT_THEMES[chosen] : BASE_THEME,
    accent: chosen ? KIT_ACCENTS[chosen] : PLATFORM_ACCENT,
    about: paragraphs.map((paragraph) => `<p>${escape(paragraph)}</p>`).join('\n'),
    seo: {
      title: clip(shopName, STORE_BUILDER_LIMITS.seoTitle),
      description: clip(
        firstSentence.length >= 50 ? firstSentence : flat,
        STORE_BUILDER_LIMITS.seoDescription,
      ),
    },
  } satisfies StorePlan;
}

/** A plan, with the name of the theme it starts on, as Hatti's library calls it. */
export type PlannedStore = StorePlan & { themeName: string };

export interface StoreBuilt {
  plan: PlannedStore;
  collectionsMade: number;
  sizeChartsMade: number;
  menuLinksAdded: number;
  /**
   * The theme begun on the plan's (ADR-732), and whether it was published; null where the main
   * theme is on it already.
   */
  theme: { id: string; name: string; published: boolean } | null;
  /** Whether the main theme took the accent; false where the shop has none. */
  accentSet: boolean;
  /** The About us page made; null where the shop had one. */
  aboutPage: { id: string; handle: string } | null;
  /** Whether the home page's SEO was set; false where the shop had set its own. */
  seoSet: boolean;
}

/** The file Hatti Base keeps its settings in, as Shopify's themes do. */
const SETTINGS_FILE = 'config/settings_data.json';
const ABOUT_HANDLE = 'about-us';

/** A settings file's current settings; null where it has none to read. */
function currentOf(body: string | null): Record<string, unknown> | null {
  try {
    const { current } = JSON.parse(body ?? '') as { current?: unknown };
    return typeof current === 'object' && current !== null
      ? (current as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Whether a theme's settings are the store builder's own doing: those of the theme it is built
 * on, `platform`, but for the accent.
 */
function accentAlone(body: string, platform: string | null): boolean {
  const own = currentOf(body);
  const theirs = currentOf(platform) ?? {};
  return (
    own !== null &&
    Object.entries(own).every(
      ([key, value]) =>
        key === 'color_accent' || JSON.stringify(value) === JSON.stringify(theirs[key]),
    )
  );
}

/** Builds a shop from its description through the catalog's and the online store's facades. */
@Injectable()
export class StoreBuilderService {
  constructor(
    private readonly db: Database,
    private readonly kits: StarterKitService,
    private readonly themes: ThemeService,
    private readonly pages: PageService,
    private readonly preferences: PreferencesService,
  ) {}

  /** What the shop's description would make of it, changing nothing. */
  async plan(
    tenant: TenantContext,
    description: string,
    kit?: StarterKitValue | null,
  ): Promise<PlannedStore> {
    const shop = await this.db.tenant(tenant.shopId, (tx) => shopProfile(tx, tenant.shopId));
    const plan = planStore(shop.name, description, kit);
    const library = await this.themes.library();
    const name = library.find((theme) => theme.handle === plan.theme)?.name ?? plan.theme;
    return { ...plan, themeName: name };
  }

  /**
   * Sets the shop up from its description: its kit's collections, size charts and menu links;
   * a theme on Hatti's theme for its kind; the main theme's accent; an About us page; and the
   * home page's SEO. Leaves the page and the SEO where the shop has its own; a kit may be applied
   * again, as ever.
   */
  async build(
    tenant: TenantContext,
    input: { description: string; kit?: StarterKitValue | null; accent?: string | null },
  ): Promise<StoreBuilt> {
    const planned = await this.plan(tenant, input.description, input.kit);
    const plan = { ...planned, accent: input.accent ?? planned.accent };
    const applied = plan.kit
      ? await this.kits.apply(tenant, plan.kit)
      : { collectionsMade: 0, sizeChartsMade: 0, menuLinksAdded: 0 };

    const theme = await this.#startTheme(tenant, plan.theme, plan.themeName);
    const accentSet = await this.#setAccent(tenant, plan.accent);

    const { items } = await this.pages.list(tenant, { first: 250 });
    let aboutPage: StoreBuilt['aboutPage'] = null;
    if (!items.some((page) => page.handle === ABOUT_HANDLE)) {
      const made = await this.pages.create(tenant, {
        title: 'About us',
        handle: ABOUT_HANDLE,
        body: plan.about,
      });
      if (!made.ok) throw new Error(`About us: ${made.errors[0]?.message}`);
      aboutPage = { id: made.value.id, handle: made.value.handle };
    }

    const preferences = await this.preferences.get(tenant);
    let seoSet = false;
    if (preferences.seo.title === null && preferences.seo.description === null) {
      const saved = await this.preferences.update(tenant, { seo: plan.seo });
      if (!saved.ok) throw new Error(`Home page SEO: ${saved.errors[0]?.message}`);
      seoSet = true;
    }
    return {
      plan,
      collectionsMade: applied.collectionsMade,
      sizeChartsMade: applied.sizeChartsMade,
      menuLinksAdded: applied.menuLinksAdded,
      theme,
      accentSet,
      aboutPage,
      seoSet,
    };
  }

  /**
   * The shop on Hatti's theme `handle` (ADR-732): a theme begun on it, published where the main
   * theme holds nothing of the shop's own but its accent, else left for the owner to look at and
   * publish. One begun on it before is used again; null where the main theme is on it already.
   */
  async #startTheme(
    tenant: TenantContext,
    handle: string,
    name: string,
  ): Promise<StoreBuilt['theme']> {
    const main = await this.db.tenant(tenant.shopId, (tx) => this.themes.mainOf(tx, tenant.shopId));
    if (main?.theme.base === handle) return null;
    const platform = main ? await this.themes.platformFile(main.theme.base, SETTINGS_FILE) : null;
    const untouched =
      !main ||
      main.files.every(
        (file) => file.filename === SETTINGS_FILE && accentAlone(file.body, platform),
      );
    const { items } = await this.themes.list(tenant, {
      first: THEME_LIMITS.themes,
      roles: ['unpublished'],
    });
    let theme = items.find((each) => each.base === handle);
    if (!theme) {
      const made = await this.themes.create(tenant, { name, base: handle });
      // A shop with as many themes as it may keep: its kind's theme is left for it to add.
      if (!made.ok) return null;
      theme = made.value;
    }
    if (!untouched) return { id: theme.id, name: theme.name, published: false };
    const published = await this.themes.publish(tenant, theme.id);
    if (!published.ok) throw new Error(`Theme: ${published.errors[0]?.message}`);
    return { id: theme.id, name: theme.name, published: true };
  }

  /**
   * The main theme's accent, in its settings as the storefront reads them, keeping the rest of
   * them: the shop's own, else those of the theme it is built on (ADR-732).
   */
  async #setAccent(tenant: TenantContext, accent: string): Promise<boolean> {
    const main = await this.db.tenant(tenant.shopId, (tx) => this.themes.mainOf(tx, tenant.shopId));
    if (!main) return false;
    const body = await this.themes.fileAsShown(tenant, main.theme, SETTINGS_FILE);
    let data: { current?: unknown; presets?: Record<string, unknown> } = {};
    try {
      data = body ? (JSON.parse(body) as typeof data) : {};
    } catch {
      data = {};
    }
    const current =
      typeof data.current === 'string' ? data.presets?.[data.current] : (data.current ?? {});
    const settings = typeof current === 'object' && current !== null ? current : {};
    const saved = await this.themes.upsertFiles(tenant, main.theme.id, [
      {
        filename: SETTINGS_FILE,
        body: JSON.stringify({ ...data, current: { ...settings, color_accent: accent } }, null, 2),
      },
    ]);
    if (!saved.ok) throw new Error(`Theme accent: ${saved.errors[0]?.message}`);
    return true;
  }
}
