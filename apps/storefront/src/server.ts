import type { RenderedPage } from '@hatti/documents';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { checkPassword } from '@hatti/crypto';
import { metrics } from '@opentelemetry/api';
import { formatMoney, money } from '@hatti/money';
import {
  MemoryStore,
  RedisStore,
  ShopDirectory,
  StoreMissingError,
  StorefrontActivity,
  StorefrontKeys,
  StorefrontSearches,
  StorefrontVitals,
  TranslatedStore,
  handleTag,
  pathTag,
  localDay,
  pausedAt,
  waitingRoomAt,
  redirectKey,
  searchReportOf,
  shopTag,
  vitalSampleOf,
  type ActivityStep,
  type ShopDoc,
  type StoreData,
  type ThemeDoc,
  arrivalOf,
  sessionOriginOf,
} from '@hatti/storefront-data';
import { RateLimiter } from '@hatti/ratelimit';
import {
  ACCOUNT_ADDRESSES_MAX,
  ACCOUNT_PRICES_MAX,
  ACCOUNT_WISHLIST_MAX,
  CONTENT_TYPES,
  NUMBER_PROOF_COOKIE,
  PRODUCT_FEED_PATH,
  SEARCH_TERMS_MAX,
  StorefrontApiError,
  accountCookie,
  accountCookieCleared,
  checkoutPagePath,
  numberProofCookie,
  type CartItemInput,
  type CartJson,
  type ContentSearchResponse,
  type ContentType,
  type ThemePreviewResponse,
} from '@hatti/storefront-api';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import type { Redis } from 'ioredis';
import {
  CART_COOKIE,
  ajaxCart,
  ajaxLineItem,
  cartBody,
  cartCookies,
  cartCountCookie,
  cartErrorMessage,
  cartErrorStatus,
  cartProducts,
  cartRoute,
  cookieOf,
  parseForm,
  parseMultipartForm,
  permalinkItems,
  permalinkPrefill,
  withoutPrefill,
  type CoreBackend,
} from './cart.js';
import {
  askedCurrency,
  currencyCookie,
  currencyCookieOf,
  suggestedCurrency,
} from './currencies.js';
import {
  CODE_TYPED_MAX,
  PHONE_TYPED_MAX,
  accountTokenOf,
  addAgain,
  addressErrorMessages,
  addressRequestOf,
  dataNoticeMessage,
  dataNoticeOf,
  loginCookie,
  loginCookieCleared,
  loginErrorMessage,
  pendingLoginOf,
  reorderItems,
  reorderNoticeMessage,
  reorderNoticeOf,
  signedInCookie,
  signedInCookieCleared,
  type AddressForm,
  type DataNotice,
  type LoginForm,
  type LoginProblem,
} from './accounts.js';
import { AGENT_LIMITS, AGENT_PATHS, mcpAnswer, ucpProfile } from './agents.js';
import {
  BUY_BUTTON_COLLECTION,
  BUY_BUTTON_PATHS,
  BUY_BUTTON_SCRIPT,
  buyButtonCollection,
  buyButtonPage,
  buyButtonProduct,
} from './buy-button.js';
import {
  STOREFRONT_BUYER_IP_HEADER,
  STOREFRONT_TOKEN_HEADERS,
  storefrontApiAnswer,
  storefrontTokenOf,
} from './storefront-graphql.js';
import { blogFeed, collectionFeed, productFeed } from './feeds.js';
import { sampleStore } from './fixtures.js';
import { PASSWORD_COOKIE, isPasswordPass, passwordCookie, passwordPass } from './password.js';
import { browserIdsOf } from './pixels.js';
import { layoutStyles, translation } from './liquid.js';
import type { SearchFound } from './objects.js';
import {
  shownCurrencyOf,
  type NamedDocument,
  type PageRenderer,
  type PageRequest,
} from './render.js';
import {
  SITEMAP_KINDS,
  inSitemapOrder,
  robotsTxt,
  sitemapIndex,
  sitemapOf,
  sitemapPage,
  sitemapPages,
} from './sitemap.js';
import { LINK_TAP_PATH, linkKey, linkTargets, tapTarget } from './link-page.js';
import { developmentPage, maintenancePage, retryAfterOf } from './maintenance.js';
import {
  PUSH_PATHS,
  PWA_PATHS,
  SERVICE_WORKER,
  initialIcon,
  offlinePage,
  webManifest,
} from './pwa.js';
import { ROOM_LIMITS, WaitingRooms, waitingPage } from './waiting-room.js';
import {
  EMPTY_REPORT,
  EMPTY_RIGHTS,
  RIGHTS_LISTINGS_MAX,
  listingAddresses,
  reportPage,
  reportTakenPage,
  rightsPage,
  rightsTakenPage,
  takenDownPage,
} from './report-page.js';
import { StorefrontLogs } from './error-logs.js';
import { VISIT_BODY_MAX, VISIT_PATH, isRobot, sessionOf } from './sessions.js';
import {
  EXPERIMENT_COOKIE,
  experimentArm,
  experimentCookie,
  type ExperimentArm,
} from './experiments.js';
import { VITALS_BODY_MAX, VITALS_PATH, vitalsReportOf } from './vitals.js';
import { SEARCH_REPORT_BODY_MAX, SEARCH_REPORT_PATH, searchReportBodyOf } from './searches.js';
import {
  PHOTO_SEARCH_BODY_MAX,
  PHOTO_SEARCH_PATH,
  photoRequestOf,
  photoSearchLocation,
  photoSearchMessage,
} from './photo-search.js';
import { suggestJson, suggestParams, suggestWanted, suggestedProducts } from './suggest.js';
import { chatCookie, chatCookieCleared, chatMessagesJson, chatTokenOf } from './web-chat.js';
import {
  VISITS_COOKIE,
  keptVisits,
  storefrontVisits,
  visitsAfter,
  visitsCookie,
  withCampaign,
} from './visits.js';
import { overlayTheme, type Theme, type ThemeError } from '@hatti/themes';

export interface StorefrontServerOptions {
  /** Hatti Base: the theme of shops with none of their own, and of any built on a theme unknown. */
  theme: Theme;
  /**
   * Hatti's themes by handle (ADR-730), each shop's theme laid over the one it is built on; Hatti
   * Base alone without them.
   */
  platformThemes?: ReadonlyMap<string, Theme>;
  renderer: PageRenderer;
  /** The platform's domain, without a port: each shop answers at {handle}.{domain}. */
  domain: string;
  /** Where published shops' documents are. Without it, only the sample shop is served. */
  redis?: Redis;
  keys?: StorefrontKeys;
  /** What the platform's domain itself serves: the sample shop, in development. */
  sample?: MemoryStore;
  /** Draws placeholder images under /images/, which sample data points at. */
  placeholders?: boolean;
  /** Told of each file of a shop's theme left out, the platform theme's showing instead. */
  onThemeFileRejected?: (shopId: string, error: ThemeError) => void;
  /**
   * The core's storefront API, which keeps shoppers' carts (ADR-042) and checkouts (ADR-044).
   * Without it, carts cannot change.
   */
  core?: CoreBackend;
  /** Cookies only over HTTPS, as in production. */
  secureCookies?: boolean;
  /** Behind a proxy, such as the edge, which says who the shopper is. */
  trustProxy?: boolean;
  /**
   * Where the theme editor is, such as https://admin.hatti.pk (ADR-050): only these may frame a
   * preview, whose page is then in design mode, and talk to it. Without them, previews have no
   * design mode.
   */
  editorOrigins?: readonly string[];
  /**
   * Where the server logs (ADR-744): each answer that failed with a 5xx at error, so that it
   * reaches the error tracker. Without it, nothing is logged.
   */
  logger?: FastifyBaseLogger;
}

/**
 * Pages, as the edge keeps them (ADR-047): five minutes unless the publisher purges them sooner,
 * then shown while fetched again, and for a week while the storefront cannot answer. Browsers
 * ask each time, as they cannot be told to forget.
 */
const PAGE_CACHE =
  'public, max-age=0, s-maxage=300, stale-while-revalidate=86400, stale-if-error=604800';

/** Search results and suggestions: a minute, as nothing purges them. */
const SEARCH_CACHE = 'public, max-age=0, s-maxage=60';

/** robots.txt and sitemaps: an hour at the edge, or until the shop's document changes. */
const CRAWLER_CACHE = 'public, max-age=0, s-maxage=3600';

/** Theme assets, whose address names the theme's version. */
const ASSET_CACHE = 'public, max-age=31536000, immutable';

/** Changes to carts an address may make a minute: more than a shopper would, fewer than a script. */
const CART_CHANGES = { name: 'cart-changes', limit: 120, windowMs: 60_000 };

/**
 * Pages an address may say it saw a minute (ADR-180): many shoppers share one behind a mobile
 * network's address, so many, but not a script's flood.
 */
const VISITS = { name: 'visits', limit: 600, windowMs: 60_000 };

/** Pages' speed reports an address may make a minute (ADR-485), as many as the pages it saw. */
const VITALS_REPORTS = { name: 'vitals', limit: 600, windowMs: 60_000 };

/** Searches' reports an address may make a minute (ADR-683), as many as its searches. */
const SEARCH_REPORTS = { name: 'search-reports', limit: 240, windowMs: 60_000 };

/** Taps on link pages' links an address counts a minute (ADR-204); past them, it is sent on all the same. */
const LINK_TAPS = { name: 'link-taps', limit: 120, windowMs: 60_000 };

/**
 * Searches an address may ask the core for a minute, suggestions as a shopper types among them:
 * room for many shoppers behind one mobile network's address, but not for a script.
 */
const SEARCHES = { name: 'searches', limit: 240, windowMs: 60_000 };

/**
 * Tries at a closed shop's password an address may make a minute (ADR-054): enough for shoppers
 * behind one mobile network's address to mistype, too few to guess.
 */
const PASSWORD_TRIES = { name: 'password-tries', limit: 10, windowMs: 60_000 };

/**
 * Notifications an address may turn on or off a minute (ADR-833): a shopper does it once, so few,
 * but room for many behind one mobile network's address.
 */
const PUSH_CHANGES = { name: 'push-changes', limit: 20, windowMs: 60_000 };
/**
 * Calls of the Storefront API (ADR-848) an address makes in a minute: with a public token, as a
 * shopper's browser does; and with a private one, from the shop's own server, for its shoppers.
 */
const STOREFRONT_API_CALLS = { name: 'storefront-api', limit: 300, windowMs: 60_000 };
const STOREFRONT_API_SERVER_CALLS = {
  name: 'storefront-api-server',
  limit: 6_000,
  windowMs: 60_000,
};
/**
 * Photos an address may send to be read into a search a minute (ADR-870): each spends one of the
 * shop's AI credits, so a few, with room for shoppers behind one mobile network's address.
 */
const PHOTO_SEARCHES = { name: 'photo-searches', limit: 10, windowMs: 60_000 };
/** Calls of the store's MCP endpoint (ADR-847), an agent's address's, in a minute. */
const AGENT_CALLS = { name: 'agent-calls', limit: 120, windowMs: 60_000 };

/**
 * Sign-ups an address may make a minute through shops' forms (ADR-189): a shopper signs up once,
 * so few, but room for many behind one mobile network's address.
 */
const SIGN_UPS = { name: 'sign-ups', limit: 10, windowMs: 60_000 };
/**
 * Spins an address may make a minute of shops' wheels (ADR-900): a shopper spins once, so few,
 * but room for many behind one mobile network's address.
 */
const SPINS = { name: 'spins', limit: 10, windowMs: 60_000 };
/**
 * Messages an address may write a minute in shops' chats (ADR-811): a shopper writes a few, and
 * a script many.
 */
const CHAT_WRITES = { name: 'chat-writes', limit: 20, windowMs: 60_000 };

/**
 * Reads of chats an address may make a minute: an open chat asks every ten seconds, for room for
 * many shoppers behind one mobile network's address.
 */
const CHAT_READS = { name: 'chat-reads', limit: 240, windowMs: 60_000 };

/** Messages through the contact form from one address (ADR-589). */
const CONTACT_MESSAGES = { name: 'contact-messages', limit: 5, windowMs: 60_000 };

/**
 * Wishes an address may leave a minute to hear a sold-out variant is back (ADR-431): a shopper
 * asks for one or two, and a script many.
 */
const STOCK_WATCHES = { name: 'stock-watches', limit: 10, windowMs: 60_000 };

/**
 * Comments an address may post a minute on shops' articles (ADR-220): a reader writes a few, and
 * a script many.
 */
const COMMENTS = { name: 'comments', limit: 5, windowMs: 60_000 };

/**
 * Reports of stores an address may send a minute (ADR-460): a shopper sends one, and a script
 * many; the core takes three a day of one store from one address.
 */
const REPORTS = { name: 'store-reports', limit: 5, windowMs: 60_000 };

/**
 * Orders an address may look up a minute on a shop's tracking page (ADR-251): a customer looks
 * for one or two, and a script trying numbers many.
 */
const TRACKING_LOOKUPS = { name: 'tracking-lookups', limit: 10, windowMs: 60_000 };

/**
 * Tries at signing in an address may make a minute, codes asked for and codes typed (ADR-571): a
 * shopper asks for a code or two and types each once or twice, and many share one mobile
 * network's address; a script trying numbers or codes is stopped here, before the core's own
 * limits on each number.
 */
const ACCOUNT_LOGINS = { name: 'account-logins', limit: 20, windowMs: 60_000 };

/**
 * What an address may ask of shoppers' own data a minute, their files and erasures (ADR-572): a
 * shopper asks once or twice, and the core makes one file a customer a day whatever is asked.
 */
const ACCOUNT_DATA_REQUESTS = { name: 'account-data-requests', limit: 10, windowMs: 60_000 };

/**
 * Orders an address may buy again from shoppers' accounts a minute (ADR-574), as many as they
 * may ask of their own data: a shopper buys one or two again, and each asks the cart a few times.
 */
const ACCOUNT_REORDERS = { name: 'account-reorders', limit: 10, windowMs: 60_000 };

/**
 * What an address may ask of shoppers' wishlists kept with their accounts a minute (ADR-575): a
 * page's script asks once as a shopper's visit begins, and once for each heart they press; room
 * for many shoppers behind one mobile network's address, but not for a script.
 */
const ACCOUNT_WISHLISTS = { name: 'account-wishlists', limit: 60, windowMs: 60_000 };

/**
 * What an address may ask of signed-in shoppers' own prices a minute (ADR-781): a product page's
 * script asks once as it loads; room for a reseller browsing quickly, and many behind one network.
 */
const ACCOUNT_PRICES = { name: 'account-prices', limit: 120, windowMs: 60_000 };

/** What could be a variant's ID as the storefront's documents give it. */
const VARIANT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Changes an address may make to shoppers' address books a minute (ADR-584): a shopper adds an
 * address or two, and corrects one; room for many behind one mobile network's address.
 */
const ACCOUNT_ADDRESS_CHANGES = { name: 'account-address-changes', limit: 30, windowMs: 60_000 };

/** Forms posted as `multipart/form-data` that carried a file, which the cart refuses (ADR-701). */
const withFiles = new WeakSet<object>();

/** The longest handle a wishlist's script is asked of, as catalog's handles are at most. */
const HANDLE_MAX = 255;

/** The longest password a shopper's try is checked for: shops' are at most 100 characters. */
const PASSWORD_TYPED_MAX = 200;

/** Routes a closed shop answers to everyone: its password page, and what crawlers and pages load. */
const OPEN_ROUTES = new Set([
  '/password',
  '/ur/password',
  // Sign-ups, as a closed shop's password page asks shoppers to be told when it opens.
  '/contact',
  '/ur/contact',
  // Reports of the store to Hatti (ADR-460), whatever the shop shows.
  '/report',
  '/ur/report',
  '/report/rights',
  '/ur/report/rights',
  '/robots.txt',
  '/assets/:version/:file',
  '/images/*',
  '/theme-images/:file',
  '/theme-images/:file/:name',
]);

/**
 * Routes a paused shop answers as ever (ADR-252): what crawlers read, so they keep its pages;
 * theme files and images; its tracking page, for orders placed before; checkouts, whose pages
 * the core shows paused, and a placed order's as it was; and reports of it to Hatti (ADR-460).
 */
const PAUSE_OPEN_ROUTES = new Set([
  '/robots.txt',
  '/sitemap.xml',
  '/sitemaps/:name',
  '/assets/:version/:file',
  '/images/*',
  '/theme-images/:file',
  '/theme-images/:file/:name',
  '/track',
  '/ur/track',
  '/checkouts/:token',
  '/report',
  '/ur/report',
  '/report/rights',
  '/ur/report/rights',
  // The installable storefront's (ADR-832): the worker must install and update whatever the shop.
  PWA_PATHS.manifest,
  PWA_PATHS.worker,
  PWA_PATHS.offline,
  PWA_PATHS.icon,
]);

/**
 * Where Kubernetes asks whether the storefront is up and may take traffic (ADR-724): no shop's
 * page answers at these, on its handle or its own domain.
 */
export const HEALTH_PATHS = { live: '/healthz', ready: '/readyz' } as const;

/** Whether `probe` answers within two seconds. */
async function answers(probe: () => Promise<unknown>, timeoutMs = 2_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** What a previewed page is: the shopper's own, never kept, and not for search engines. */
const PREVIEWED = 'private, no-store';

/**
 * The token of the preview link the shopper followed (ADR-049), which the core opens: the theme
 * it shows is shown on every page here until the link ends.
 */
const PREVIEW_COOKIE = 'hatti_preview';

/** Tokens the core seals: anything else is not sent to it. */
const PREVIEW_TOKEN = /^[\w.-]{16,512}$/;

/** A section's ID, as themes may name one (the themes package's rule). */
const SECTION_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** A product's ID, as its document names it: Shopify's numeric IDs, or Hatti's UUIDs. */
const PRODUCT_ID = /^[A-Za-z0-9-]{1,64}$/;

/** The most products recommended beside one, as Shopify's (ADR-434). */
const RECOMMENDATIONS_LIMIT = 10;

/** A file's public ID, as a theme names a picture of the shop's (ADR-326). */
const FILE_ID = /^file_[0-9a-hjkmnp-tv-z]{26}$/;

/**
 * A picture a theme shows is the shop's to change: browsers and the edge keep it an hour, and one
 * not there a minute.
 */
const THEME_IMAGE_CACHE = 'public, max-age=3600';
const NO_THEME_IMAGE_CACHE = 'public, max-age=60';

/** The most sections one request may ask for, as on Shopify. */
const SECTIONS_MAX = 5;

// A shop's handle: a DNS label, as control.shops checks it.
const HANDLE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * The handle a host names on the platform's domain: "zari" for zari.hatti.pk (or with a port).
 * Null for the domain itself; undefined for any other host, such as a shop's own domain.
 */
export function handleOf(host: string, domain: string): string | null | undefined {
  const name = host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (name === domain) return null;
  if (!name.endsWith(`.${domain}`)) return undefined;
  const label = name.slice(0, -domain.length - 1);
  return HANDLE.test(label) && !label.includes('--') ? label : undefined;
}

/**
 * Shops by handle, from the directory, each answer kept for a few seconds: every page asks, and
 * handles seldom change. A shop just published shows within that time.
 */
export class ShopResolver {
  readonly #answers = new Map<string, { shopId: string | null; until: number }>();

  constructor(
    private readonly directory: Pick<ShopDirectory, 'find'>,
    private readonly ttlMs = 5_000,
    private readonly size = 10_000,
  ) {}

  async find(handle: string): Promise<string | null> {
    const now = Date.now();
    const known = this.#answers.get(handle);
    if (known && known.until > now) return known.shopId;
    const shopId = await this.directory.find(handle);
    this.#answers.delete(handle);
    if (this.#answers.size >= this.size) {
      this.#answers.delete(this.#answers.keys().next().value!);
    }
    this.#answers.set(handle, { shopId, until: now + this.ttlMs });
    return shopId;
  }
}

/** A theme a preview link shows (ADR-049), and its name, for the bar on its pages. */
interface Preview {
  name: string;
  theme: Theme;
}

/**
 * The shop a request is for, where its documents are, the theme it previews, if any, and whether
 * the preview is in the theme editor's frame.
 */
interface Found {
  shopId: string;
  store: StoreData;
  preview: Preview | null;
  editor: boolean;
  /** The currency the shopper picked (ADR-865), from their cookie; null for rupees. */
  currency: string | null;
  /**
   * The arm of the shop's running theme experiment the shopper is in (ADR-866), once a page
   * asked: as their cookie keeps it, or as they were put in now, for the answer to keep. Null
   * until asked, or with no experiment.
   */
  experiment: ExperimentArm | null;
  /** The experiment cookie the request came with. */
  experimentCookie: string | null;
  /** Whether a robot asked, which always sees the live theme. */
  robot: boolean;
}

/**
 * A shop closed behind its password (ADR-054), as a request finds it: what the password page
 * checks and says, and whether this shopper may see the shop anyway, having given the password,
 * or being its staff in a preview.
 */
interface Lock {
  password: { verifier: string; message: string };
  passed: boolean;
}

/** The most sections the editor has rendered at once, and files it sends over the theme's. */
const EDITOR_SECTIONS_MAX = 5;
const EDITOR_FILES_MAX = 50;

/**
 * What the theme editor asks to have rendered (ADR-050): a path on the shop, the sections of its
 * page, and the theme's files it has not saved; null when the body is not that.
 */
function editorAsk(
  body: unknown,
): { page: string; sections: string[]; files: Record<string, string>; styles: boolean } | null {
  if (typeof body !== 'object' || body === null) return null;
  const { page, sections, files, styles } = body as Record<string, unknown>;
  if (typeof page !== 'string' || !/^\/(?!\/)/.test(page) || page.length > 2_000) return null;
  if (styles !== undefined && typeof styles !== 'boolean') return null;
  // Sections, or the layout's CSS alone (ADR-700).
  if (
    !Array.isArray(sections) ||
    (sections.length === 0 && styles !== true) ||
    sections.length > EDITOR_SECTIONS_MAX
  )
    return null;
  if (!sections.every((id) => typeof id === 'string' && SECTION_ID.test(id))) return null;
  if (typeof files !== 'object' || files === null || Array.isArray(files)) return null;
  const entries = Object.entries(files);
  if (entries.length > EDITOR_FILES_MAX) return null;
  if (!entries.every(([, source]) => typeof source === 'string')) return null;
  return {
    page,
    sections,
    files: Object.fromEntries(entries) as Record<string, string>,
    styles: styles === true,
  };
}

/**
 * The cookie that keeps a preview link's token until the link ends; a null token forgets it. In
 * the theme editor's frame it is the frame's alone (`Partitioned`), and sent there though the
 * editor is another site, as in development (ADR-050).
 */
function previewCookie(
  token: string | null,
  seconds: number,
  options: { secure: boolean; framed: boolean },
): string {
  const attributes = options.framed
    ? 'Path=/; SameSite=None; Secure; Partitioned; HttpOnly'
    : `Path=/; SameSite=Lax; HttpOnly${options.secure ? '; Secure' : ''}`;
  return token === null
    ? `${PREVIEW_COOKIE}=; Max-Age=0; ${attributes}`
    : `${PREVIEW_COOKIE}=${token}; Max-Age=${Math.max(seconds, 0)}; ${attributes}`;
}

/**
 * An answer showing a preview: the shopper's own, never kept, not for search engines, and framed
 * only by the theme editor.
 */
function previewedAnswer(reply: FastifyReply, editorOrigins: readonly string[]): FastifyReply {
  const ancestors = editorOrigins.length > 0 ? editorOrigins.join(' ') : "'none'";
  return reply
    .header('cache-control', PREVIEWED)
    .header('x-robots-tag', 'noindex')
    .header('content-security-policy', `frame-ancestors ${ancestors}`);
}

/**
 * Shops' themes, each laid over the platform theme once per version and kept for the pages after,
 * the least recently used let go first once their files pass `maxBytes`. A shop's document names
 * the version to show; the theme's document is fetched only when that one is not at hand.
 */
export class ShopThemes {
  readonly #themes = new Map<string, { theme: Theme; bytes: number }>();
  readonly #loading = new Map<string, Promise<Theme>>();
  #bytes = 0;

  constructor(
    private readonly base: Theme,
    private readonly options: {
      maxBytes?: number;
      onRejected?: (shopId: string, error: ThemeError) => void;
      /** The platform themes shops' themes are built on, by handle (ADR-730). */
      platform?: ReadonlyMap<string, Theme>;
    } = {},
  ) {}

  /**
   * The theme `shop`'s pages are rendered with: its own, or the platform theme; or, for a shopper
   * in a draft's arm of its running experiment (ADR-866, ADR-931), that draft.
   */
  async for(
    shopId: string,
    shop: ShopDoc,
    store: StoreData,
    arm: ExperimentArm['arm'] = 'a',
  ): Promise<Theme> {
    const experiment = shop.experiment;
    const draft =
      !experiment || arm === 'a'
        ? null
        : arm === 'b'
          ? { themeId: experiment.themeId, version: experiment.version }
          : (experiment.others?.[arm === 'c' ? 0 : 1] ?? null);
    // Documents written before shops had themes have none.
    const wanted = draft ? { id: draft.themeId, version: draft.version } : (shop.theme ?? null);
    if (!wanted) return this.base;
    const key = `${shopId}:${wanted.id}:${wanted.version}`;
    const kept = this.#kept(key);
    if (kept) return kept;
    let loading = this.#loading.get(key);
    if (!loading) {
      loading = this.#load(shopId, wanted, store, key, draft ? arm : null).finally(() =>
        this.#loading.delete(key),
      );
      this.#loading.set(key, loading);
    }
    return loading;
  }

  async #load(
    shopId: string,
    wanted: { id: string; version: number },
    store: StoreData,
    key: string,
    draft: ExperimentArm['arm'] | null = null,
  ): Promise<Theme> {
    const doc = await (draft && draft !== 'a' ? store.experimentTheme(draft) : store.theme());
    if (!doc) return this.base;
    // Written since the shop's document was read, or not yet: shown, but not kept as the version
    // the shop's document names.
    if (doc.id !== wanted.id || doc.version !== wanted.version) return this.#overlay(shopId, doc);
    return this.#keep(shopId, key, doc);
  }

  /**
   * A theme a preview link shows (ADR-049), from the core's copy of its files: laid over the
   * platform theme once per version, and kept with main themes.
   */
  preview(shopId: string, doc: ThemeDoc): Theme {
    const key = `${shopId}:${doc.id}:${doc.version}`;
    return this.#kept(key) ?? this.#keep(shopId, key, doc);
  }

  /** The theme kept under `key`, now the most recently used. */
  #kept(key: string): Theme | null {
    const kept = this.#themes.get(key);
    if (!kept) return null;
    // Last in the map is the most recently used, so the first is the one to let go.
    this.#themes.delete(key);
    this.#themes.set(key, kept);
    return kept.theme;
  }

  #overlay(shopId: string, doc: ThemeDoc): Theme {
    // Over the platform theme it is built on; Hatti Base for one this storefront does not know.
    const base = this.options.platform?.get(doc.base) ?? this.base;
    return overlayTheme(base, doc.files, (error) => this.options.onRejected?.(shopId, error));
  }

  /** `doc` laid over the platform theme, and kept as `key` while there is room. */
  #keep(shopId: string, key: string, doc: ThemeDoc): Theme {
    const theme = this.#overlay(shopId, doc);
    const bytes = Object.values(doc.files).reduce((sum, source) => sum + source.length, 0);
    const maxBytes = this.options.maxBytes ?? 64 * 1024 * 1024;
    if (bytes > maxBytes) return theme;
    this.#themes.set(key, { theme, bytes });
    this.#bytes += bytes;
    for (const [oldest, { bytes: size }] of this.#themes) {
      if (this.#bytes <= maxBytes) break;
      this.#themes.delete(oldest);
      this.#bytes -= size;
    }
    return theme;
  }
}

/**
 * Renders the sample shop's pages once, a page of each template in both languages: the first
 * render parses the theme and runs the renderer's code for the first time, which is slow enough
 * to put a section over its time limit on a busy machine. Before listening, it spares the first
 * visitors that.
 */
export async function warmUp(renderer: PageRenderer): Promise<void> {
  const documents = sampleStore();
  const store = new MemoryStore(documents);
  const requests: PageRequest[] = [
    { path: '/' },
    { path: '/', locale: 'ur' },
    { path: `/collections/${documents.collections[0]!.handle}` },
    { path: `/products/${documents.products[0]!.handle}` },
    { path: '/cart', cart: null },
    {
      path: '/search',
      query: { q: 'lawn' },
      search: { terms: 'lawn', productIds: documents.products.slice(0, 4).map((p) => p.id) },
    },
    { path: `/pages/${documents.pages![0]!.handle}` },
    { path: '/pages/none' },
    { path: `/blogs/${documents.blogs![0]!.handle}` },
    { path: `/blogs/${documents.articles![0]!.blogHandle}/${documents.articles![0]!.handle}` },
  ];
  for (const request of requests) await renderer.render(request, store.fresh());
  const suggest = suggestParams(new URLSearchParams({ q: 'lawn' }));
  const productIds = documents.products.slice(0, 20).map((p) => p.id);
  await renderer.sections(
    { path: '/search', suggest: { params: suggest, productIds } },
    store.fresh(),
    ['predictive-search'],
  );
}

/**
 * The storefront's HTTP server: each request's host names a shop, whose documents the page is
 * rendered from, and sent as it is written. Urdu pages are under /ur/. It warms up before it
 * listens.
 */
/** The edges of {@link createStorefrontServer}'s LCP histogram, in milliseconds. */
export const LCP_BUCKETS = [500, 1000, 1500, 2000, 2500, 3000, 4000, 6000, 10000];

export function createStorefrontServer(options: StorefrontServerOptions): FastifyInstance {
  const { theme, renderer, domain, redis, sample } = options;
  const keys = options.keys ?? new StorefrontKeys();
  const directory = redis ? new ShopDirectory(redis, keys) : null;
  const shops = directory ? new ShopResolver(directory) : null;
  // Shops' own domains (ADR-048), found as handles are.
  const domainShops = directory
    ? new ShopResolver({ find: (host) => directory.findDomain(host) })
    : null;
  const themes = new ShopThemes(theme, {
    onRejected: options.onThemeFileRejected,
    platform: options.platformThemes,
  });
  const limiter = redis ? new RateLimiter(redis, keys.rateLimits()) : null;
  // Drops' waiting rooms (ADR-822); without Valkey, none.
  const rooms = redis ? new WaitingRooms(redis, keys) : null;
  // What shoppers do on each shop, counted as Shopify's analytics count it (ADR-180).
  const activity = redis ? new StorefrontActivity(redis, keys) : null;
  // Shoppers' largest contentful paint across every shop, for the objective that three in four
  // pages on a phone paint within two seconds (12 §1, ADR-729).
  const paints = metrics.getMeter('hatti.storefront').createHistogram('hatti.storefront.lcp', {
    unit: 'ms',
    description: "Shoppers' largest contentful paint, by device and kind of page",
    advice: { explicitBucketBoundaries: LCP_BUCKETS },
  });
  // How fast each shop's pages are for its shoppers (ADR-485).
  const vitals = redis ? new StorefrontVitals(redis, keys) : null;
  // What each shop's shoppers search it for (ADR-683).
  const searchCounts = redis ? new StorefrontSearches(redis, keys) : null;
  const core = options.core;
  const secure = options.secureCookies ?? false;
  const editorOrigins = options.editorOrigins ?? [];
  const previewed = (reply: FastifyReply) => previewedAnswer(reply, editorOrigins);
  const app = Fastify({
    trustProxy: options.trustProxy ?? false,
    ...(options.logger
      ? { loggerInstance: options.logger, logController: new StorefrontLogs() }
      : {}),
  });
  app.addHook('onReady', () => warmUp(renderer));
  // Kubernetes' probes (ADR-724), answered before any shop is looked for, whatever the host: the
  // process is up, and Valkey, where shops are found, answers.
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?', 1)[0];
    if (path !== HEALTH_PATHS.live && path !== HEALTH_PATHS.ready) return;
    reply.header('cache-control', 'no-store');
    if (path === HEALTH_PATHS.live || !redis) return reply.send({ status: 'ok' });
    const ok = await answers(() => redis.ping());
    return reply
      .code(ok ? 200 : 503)
      .send({ status: ok ? 'ok' : 'unavailable', checks: { redis: ok ? 'ok' : 'failed' } });
  });
  // An answer that sets a cookie is the shopper's own, whatever its handler said: never kept.
  app.addHook('onSend', async (request, reply, payload) => {
    // A shopper put in an arm of the shop's theme experiment keeps it; a page of its draft is
    // theirs alone (ADR-866).
    const found = await requestShops.get(request)?.catch(() => null);
    if (found?.experiment) {
      if (found.experiment.assigned && !reply.hasHeader('set-cookie')) {
        reply.header('set-cookie', experimentCookie(found.experiment, { secure }));
      } else if (found.experiment.assigned) {
        const kept = reply.getHeader('set-cookie');
        reply.header('set-cookie', [
          ...(Array.isArray(kept) ? kept : [String(kept)]),
          experimentCookie(found.experiment, { secure }),
        ]);
      }
      if (
        found.experiment.arm !== 'a' &&
        /^public/.test(String(reply.getHeader('cache-control')))
      ) {
        reply.header('cache-control', 'private, no-store').removeHeader('cache-tag');
      }
    }
    if (reply.hasHeader('set-cookie') && /^public/.test(String(reply.getHeader('cache-control')))) {
      reply.header('cache-control', 'private, no-store').removeHeader('cache-tag');
    }
    // Prices shown in the shopper's own currency (ADR-865): their page alone, never kept for
    // everyone at the edge, which keeps the rupees' pages.
    if (
      currencyCookieOf(request.headers.cookie) !== null &&
      /^public/.test(String(reply.getHeader('cache-control'))) &&
      /^(text\/html|application\/json)/.test(String(reply.getHeader('content-type') ?? ''))
    ) {
      reply.header('cache-control', 'private, no-store').removeHeader('cache-tag');
    }
    // A shop closed behind its password (ADR-054): nothing is kept at the edge, which would show
    // it to everyone, or indexed, while it is closed.
    if (await locks.get(request)?.catch(() => null)) {
      reply
        .header('cache-control', 'private, no-store')
        .header('x-robots-tag', 'noindex')
        .removeHeader('cache-tag');
    }
    return payload;
  });
  // Shopify's cart forms post as forms; its Ajax cart, as forms or JSON.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 64 * 1024 },
    (_request, body, done) => done(null, parseForm(body as string)),
  );
  // A script's FormData (ADR-701): its fields as a form's, its files kept by nothing.
  app.addContentTypeParser(
    'multipart/form-data',
    { parseAs: 'buffer', bodyLimit: 64 * 1024 },
    (request, body, done) => {
      parseMultipartForm(String(request.headers['content-type']), body as Buffer).then(
        ({ params, files }) => {
          if (files > 0) withFiles.add(params);
          done(null, params);
        },
        () => done(Object.assign(new Error('The form could not be read'), { statusCode: 400 })),
      );
    },
  );

  /**
   * The theme a preview link shows here (ADR-049), from `?preview=` or the cookie it leaves, as
   * the core has it saved now: null when there is none, or the link shows none any more, whose
   * cookie then goes. `?preview=` with nothing ends a preview.
   */
  const previewFor = async (
    request: FastifyRequest,
    reply: FastifyReply,
    shopId: string,
  ): Promise<Preview | null> => {
    const asked = (request.query as Record<string, unknown> | undefined)?.preview;
    const kept = cookieOf(request.headers.cookie, PREVIEW_COOKIE);
    const token = typeof asked === 'string' ? asked : kept;
    const cookie = { secure, framed: request.headers['sec-fetch-dest'] === 'iframe' };
    const forget = () => {
      if (kept !== null) reply.header('set-cookie', previewCookie(null, 0, cookie));
      return null;
    };
    if (!token || !core || !PREVIEW_TOKEN.test(token)) return forget();
    let found: ThemePreviewResponse | null;
    try {
      found = await core.themePreview(shopId, token);
    } catch (error) {
      // The core cannot say what the link shows just now: the shop's own theme, until it can.
      request.log.warn({ err: error }, 'theme preview not reached');
      return null;
    }
    if (!found) return forget();
    if (token !== kept) {
      const seconds = Math.floor((Date.parse(found.expiresAt) - Date.now()) / 1000);
      reply.header('set-cookie', previewCookie(token, seconds, cookie));
    }
    return { name: found.theme.name, theme: themes.preview(shopId, found.theme) };
  };

  /**
   * The shop a request's host names, by its handle or as a domain of the shop's own, the
   * documents its pages are made from, and the theme a preview link shows there, if any; null if
   * no shop answers.
   */
  const requestShops = new WeakMap<FastifyRequest, Promise<Found | null>>();
  /** Found once a request: its hooks and its handler ask. */
  const shopFor = (request: FastifyRequest, reply: FastifyReply): Promise<Found | null> => {
    let shop = requestShops.get(request);
    if (!shop) {
      shop = findShop(request, reply);
      requestShops.set(request, shop);
    }
    return shop;
  };
  const findShop = async (request: FastifyRequest, reply: FastifyReply): Promise<Found | null> => {
    const host = request.headers.host ?? '';
    const handle = handleOf(host, domain);
    let found: { shopId: string; store: StoreData } | null = null;
    if (handle === null) {
      found = sample ? { shopId: 'sample', store: sample.fresh() } : null;
    } else if (shops && domainShops && redis) {
      const shopId =
        handle === undefined ? await domainShops.find(hostName(host)) : await shops.find(handle);
      found = shopId ? { shopId, store: new RedisStore(redis, shopId, keys) } : null;
    }
    if (!found) return null;
    const preview = await previewFor(request, reply, found.shopId);
    // Framed, a preview is in the theme editor, which alone may frame it.
    const framed = request.headers['sec-fetch-dest'] === 'iframe';
    return {
      ...found,
      preview,
      editor: preview !== null && framed && editorOrigins.length > 0,
      currency: currencyCookieOf(request.headers.cookie),
      experiment: null,
      experimentCookie: cookieOf(request.headers.cookie, EXPERIMENT_COOKIE),
      robot: isRobot(request.headers['user-agent']),
    };
  };

  /**
   * Counts what the request's session did on its shop (ADR-180): a page it saw, or a step on its
   * way to an order. Not a robot's, staff's previews or the sample shop's, and never failing the
   * request it is counted from.
   */
  const counted = async (
    request: FastifyRequest,
    found: Found,
    step: 'visited' | Exclude<ActivityStep, 'sessions'>,
  ): Promise<void> => {
    if (!activity || found.preview || !(found.store instanceof RedisStore)) return;
    const session = sessionOf(request.headers.cookie);
    if (!session || isRobot(request.headers['user-agent'])) return;
    try {
      const doc = await found.store.shop();
      const timezone = doc.timezone ?? 'Asia/Karachi';
      await (step === 'visited'
        ? activity.visited(found.shopId, timezone, session)
        : activity.reached(found.shopId, timezone, session, step));
      // Counted in the arm of the shop's theme experiment its cookie keeps, too (ADR-866); in
      // none where Hatti stopped its draft (ADR-939).
      const arm = experimentArm(doc.experiment, found.experimentCookie, false);
      if (arm && !arm.assigned && !arm.uncounted) {
        await activity.experimented(
          found.shopId,
          arm.id,
          arm.arm,
          session,
          step === 'visited' ? undefined : step,
        );
      }
    } catch {
      // A count missed is no reason to fail a shopper.
    }
  };

  /**
   * An order placed at checkout, counted in the arm of the shop's theme experiment the session's
   * cookie keeps, with what it came to (ADR-921). As `counted`: not a robot's or a preview's, and
   * never failing the request.
   */
  const sold = async (
    request: FastifyRequest,
    found: Found,
    sale: { orderId: string; amount: string },
  ): Promise<void> => {
    if (!activity || found.preview || !(found.store instanceof RedisStore)) return;
    if (isRobot(request.headers['user-agent'])) return;
    try {
      const arm = experimentArm(
        (await found.store.shop()).experiment,
        found.experimentCookie,
        false,
      );
      const amount = Number(sale.amount);
      if (arm && !arm.assigned && !arm.uncounted && Number.isSafeInteger(amount) && amount > 0) {
        await activity.experimentSold(found.shopId, arm.id, arm.arm, sale.orderId, amount);
      }
    } catch {
      // A sale missed is no reason to fail a shopper.
    }
  };

  /**
   * Where a session came from, the page it landed on and its device, as its first page's script
   * says (ADR-884): counted once a session. Not a robot's, staff's previews or the sample shop's,
   * and never failing the request.
   */
  const began = async (request: FastifyRequest, found: Found): Promise<void> => {
    if (!activity || found.preview || !(found.store instanceof RedisStore)) return;
    const arrival = arrivalOf(request.body);
    const session = sessionOf(request.headers.cookie);
    const userAgent = request.headers['user-agent'];
    if (!arrival || !session || isRobot(userAgent)) return;
    try {
      const timezone = (await found.store.shop()).timezone ?? 'Asia/Karachi';
      await activity.began(
        found.shopId,
        timezone,
        session,
        sessionOriginOf(arrival, request.hostname, userAgent),
      );
    } catch {
      // A count missed is no reason to fail a shopper.
    }
  };

  /**
   * A shopper's page seen, as its script says (ADR-180): counted among its shop's sessions and
   * who is on it now, and, a session's first, by where it came from (ADR-884). Answered with
   * nothing, never kept.
   */
  app.post(VISIT_PATH, { bodyLimit: VISIT_BODY_MAX }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const found = await shopFor(request, reply);
    if (!found) return reply.code(404).send();
    const allowed = limiter
      ? await limiter.hit(VISITS, request.ip).then(
          (hit) => hit.allowed,
          () => true,
        )
      : true;
    if (!allowed) return reply.code(429).send();
    await counted(request, found, 'visited');
    await began(request, found);
    return reply.code(204).send();
  });

  /**
   * A shopper's page's measurements of how fast it was, as its script reports them when the
   * shopper leaves it (ADR-485): counted by its kind and the shopper's device. Not a robot's,
   * staff's previews or the sample shop's, nor a session's that has no cookie. Answered with
   * nothing, never kept.
   */
  app.post(VITALS_PATH, { bodyLimit: VITALS_BODY_MAX }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const found = await shopFor(request, reply);
    if (!found) return reply.code(404).send();
    const allowed = limiter
      ? await limiter.hit(VITALS_REPORTS, request.ip).then(
          (hit) => hit.allowed,
          () => true,
        )
      : true;
    if (!allowed) return reply.code(429).send();
    const userAgent = request.headers['user-agent'];
    const sample = vitalSampleOf(vitalsReportOf(request.body), userAgent);
    if (!sample) return reply.code(400).send();
    const counted =
      !found.preview &&
      found.store instanceof RedisStore &&
      sessionOf(request.headers.cookie) &&
      !isRobot(userAgent);
    if (counted && sample.values.lcp !== undefined) {
      paints.record(sample.values.lcp, { device: sample.device, template: sample.template });
    }
    if (vitals && counted) {
      try {
        const timezone = (await found.store.shop()).timezone ?? 'Asia/Karachi';
        await vitals.record(found.shopId, timezone, sample);
      } catch {
        // A report missed is no reason to fail a shopper.
      }
    }
    return reply.code(204).send();
  });

  /**
   * A shopper's search, as its page reports it (ADR-683): counted by its words, and whether it
   * found anything. Not a robot's, staff's previews or the sample shop's, nor a session's that
   * has no cookie. Answered with nothing, never kept.
   */
  app.post(SEARCH_REPORT_PATH, { bodyLimit: SEARCH_REPORT_BODY_MAX }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const found = await shopFor(request, reply);
    if (!found) return reply.code(404).send();
    const allowed = limiter
      ? await limiter.hit(SEARCH_REPORTS, request.ip).then(
          (hit) => hit.allowed,
          () => true,
        )
      : true;
    if (!allowed) return reply.code(429).send();
    const report = searchReportOf(searchReportBodyOf(request.body));
    if (!report) return reply.code(400).send();
    if (
      searchCounts &&
      !found.preview &&
      found.store instanceof RedisStore &&
      sessionOf(request.headers.cookie) &&
      !isRobot(request.headers['user-agent'])
    ) {
      try {
        const timezone = (await found.store.shop()).timezone ?? 'Asia/Karachi';
        await searchCounts.record(found.shopId, localDay(new Date(), timezone), report);
      } catch {
        // A search missed is no reason to fail a shopper.
      }
    }
    return reply.code(204).send();
  });

  /**
   * A tap on one of the links of the shop's link page (ADR-204): counted among the day's taps on
   * it, then sent on to where it goes, in the page's language; a link no longer on the page sends
   * the shopper back to it. Not counted for robots, a browser's prefetch, staff's previews or the
   * sample shop, nor past an address's taps a minute; never kept at the edge.
   */
  const linkTap = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'private, no-store');
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    const prefix = request.url.startsWith('/ur/') ? '/ur' : '';
    let doc: ShopDoc;
    try {
      doc = await found.store.shop();
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      throw error;
    }
    const { key } = request.params as { key: string };
    const link = linkTargets(doc.linkPage?.links, doc).find((each) => linkKey(each.url) === key);
    if (!link) return reply.redirect(`${prefix}/links`, 302);
    const purpose = String(request.headers['sec-purpose'] ?? request.headers.purpose ?? '');
    if (
      activity &&
      request.method === 'GET' &&
      !/prefetch|prerender/i.test(purpose) &&
      !found.preview &&
      found.store instanceof RedisStore &&
      !isRobot(request.headers['user-agent'])
    ) {
      try {
        const allowed = limiter ? (await limiter.hit(LINK_TAPS, request.ip)).allowed : true;
        if (allowed) await activity.tapped(found.shopId, doc.timezone ?? 'Asia/Karachi', link.url);
      } catch {
        // A tap missed is no reason to keep a shopper from where they were going.
      }
    }
    return reply.redirect(tapTarget(link.url, prefix), 302);
  };
  for (const path of [`${LINK_TAP_PATH}:key`, `/ur${LINK_TAP_PATH}:key`]) app.get(path, linkTap);

  const locks = new WeakMap<FastifyRequest, Promise<Lock | null>>();
  /** The request's shop's lock, if it is closed behind its password (ADR-054); worked out once. */
  const lockOf = (request: FastifyRequest, shop: Found): Promise<Lock | null> => {
    let lock = locks.get(request);
    if (!lock) {
      lock = (async () => {
        let doc: ShopDoc;
        try {
          doc = await shop.store.shop();
        } catch (error) {
          // Not published: the handler says so.
          if (error instanceof StoreMissingError) return null;
          throw error;
        }
        if (!doc.password) return null;
        const pass = cookieOf(request.headers.cookie, PASSWORD_COOKIE);
        // Its staff see it as it will be, through a preview.
        const passed =
          shop.preview !== null ||
          (pass !== null && isPasswordPass(pass, shop.shopId, doc.password.verifier));
        return { password: doc.password, passed };
      })();
      locks.set(request, lock);
    }
    return lock;
  };

  // A store Hatti has taken down (ADR-461) answers every address with Hatti's page saying so, and
  // scripts and forms in a line of text, all with 404, never kept, so that search engines drop its
  // pages; nothing of the shop's own runs, its password page and staff's previews included.
  app.addHook('preHandler', async (request, reply) => {
    const shop = await shopFor(request, reply);
    if (!shop) return;
    let doc: ShopDoc;
    try {
      doc = await shop.store.shop();
    } catch (error) {
      // Not published: the handler says so.
      if (error instanceof StoreMissingError) return;
      throw error;
    }
    if (!doc.suspended) return;
    reply.header('cache-control', 'private, no-store').header('x-robots-tag', 'noindex');
    const url = new URL(request.url, 'http://storefront');
    const page =
      (request.method === 'GET' || request.method === 'HEAD') &&
      !fromScript(request) &&
      !asksForSections(url) &&
      !/\.(js|json|xml|atom|txt)$/.test(url.pathname);
    if (!page) {
      return reply
        .code(404)
        .type('text/plain; charset=utf-8')
        .send('This store is not available.\n');
    }
    const down = takenDownPage(doc.name);
    return reply
      .code(404)
      .header('content-security-policy', down.contentSecurityPolicy)
      .header('x-content-type-options', 'nosniff')
      .type('text/html; charset=utf-8')
      .send(down.html);
  });

  // A shop closed behind its password shows shoppers without it nothing but the password page:
  // a page sends them there, and a script is told the shop is not open.
  app.addHook('preHandler', async (request, reply) => {
    if (OPEN_ROUTES.has(request.routeOptions.url ?? '')) return;
    const shop = await shopFor(request, reply);
    const lock = shop && (await lockOf(request, shop));
    if (!lock || lock.passed) return;
    const url = new URL(request.url, 'http://storefront');
    const urdu = url.pathname === '/ur' || url.pathname.startsWith('/ur/');
    reply.header('cache-control', 'private, no-store');
    const page =
      (request.method === 'GET' || request.method === 'HEAD') &&
      !fromScript(request) &&
      !asksForSections(url) &&
      !/\.(js|json)$/.test(url.pathname);
    if (page) return reply.redirect(urdu ? '/ur/password' : '/password', 302);
    return reply.code(401).type('text/plain; charset=utf-8').send('This shop is not open yet.\n');
  });

  // A shop paused for a while (ADR-252) answers each page with its page saying it is back soon,
  // and scripts and forms in a line of text, all with 503 and when to ask again, so search
  // engines come back rather than forget its pages, and nothing is kept at the edge. Its staff
  // see it as it is through a preview.
  app.addHook('preHandler', async (request, reply) => {
    if (PAUSE_OPEN_ROUTES.has(request.routeOptions.url ?? '')) return;
    const shop = await shopFor(request, reply);
    if (!shop || shop.preview) return;
    let doc: ShopDoc;
    try {
      doc = await shop.store.shop();
    } catch (error) {
      // Not published: the handler says so.
      if (error instanceof StoreMissingError) return;
      throw error;
    }
    if (doc.development) {
      // A partner builds it (ADR-504): shoppers wait for it to open; its staff's previews pass.
      reply.header('cache-control', 'private, no-store').header('x-robots-tag', 'noindex');
      const url = new URL(request.url, 'http://storefront');
      const page =
        (request.method === 'GET' || request.method === 'HEAD') &&
        !fromScript(request) &&
        !asksForSections(url) &&
        !/\.(js|json|xml|atom)$/.test(url.pathname);
      if (!page) {
        return reply.code(503).type('text/plain; charset=utf-8').send('This store opens soon.\n');
      }
      const soon = developmentPage(doc);
      return reply
        .code(503)
        .header('content-security-policy', soon.contentSecurityPolicy)
        .header('x-content-type-options', 'nosniff')
        .type('text/html; charset=utf-8')
        .send(soon.html);
    }
    const { maintenance } = doc;
    const now = new Date();
    if (!maintenance || !pausedAt(maintenance, now)) return;
    reply
      .header('cache-control', 'private, no-store')
      .header('retry-after', String(retryAfterOf(maintenance, now)));
    const url = new URL(request.url, 'http://storefront');
    const page =
      (request.method === 'GET' || request.method === 'HEAD') &&
      !fromScript(request) &&
      !asksForSections(url) &&
      !/\.(js|json|xml|atom)$/.test(url.pathname);
    if (!page) {
      return reply
        .code(503)
        .type('text/plain; charset=utf-8')
        .send('This shop is taking a short break.\n');
    }
    const urdu = url.pathname === '/ur' || url.pathname.startsWith('/ur/');
    const paused = maintenancePage(doc, maintenance, { urdu });
    return reply
      .code(503)
      .header('content-security-policy', paused.contentSecurityPolicy)
      .header('x-content-type-options', 'nosniff')
      .type('text/html; charset=utf-8')
      .send(paused.html);
  });

  // While a drop with a waiting room is live (ADR-822), a shopper is let in once their place in
  // line is reached; until then every page shows where they are and asks again by itself, and
  // scripts and forms are answered in a line of text, all with 503 and nothing kept at the edge.
  // What a paused shop answers as ever, it answers as ever too; its staff's previews pass.
  app.addHook('preHandler', async (request, reply) => {
    if (!rooms || PAUSE_OPEN_ROUTES.has(request.routeOptions.url ?? '')) return;
    const shop = await shopFor(request, reply);
    if (!shop || shop.preview) return;
    let doc: ShopDoc;
    try {
      doc = await shop.store.shop();
    } catch (error) {
      if (error instanceof StoreMissingError) return;
      throw error;
    }
    const now = new Date();
    const room = waitingRoomAt(doc.waitingRooms, now);
    if (!room) return;
    const answer = await rooms.enter(shop.shopId, room, request.headers.cookie, request.ip, now, {
      secure: secureFor(request),
    });
    if (answer.kind !== 'refused' && answer.cookie) reply.header('set-cookie', answer.cookie);
    if (answer.kind === 'in') return;
    // Asked again a few seconds apart at random, so that the line does not ask all at once.
    const again = ROOM_LIMITS.refreshSeconds + Math.floor(Math.random() * 10);
    reply.header('cache-control', 'private, no-store').header('retry-after', String(again));
    const url = new URL(request.url, 'http://storefront');
    const page =
      (request.method === 'GET' || request.method === 'HEAD') &&
      !fromScript(request) &&
      !asksForSections(url) &&
      !/\.(js|json|xml|atom)$/.test(url.pathname);
    if (!page) {
      return reply
        .code(503)
        .type('text/plain; charset=utf-8')
        .send("You're in line for this drop: open the shop's page to keep your place.\n");
    }
    const waiting = waitingPage(doc, room, answer);
    return reply
      .code(503)
      .header('refresh', String(again))
      .header('content-security-policy', waiting.contentSecurityPolicy)
      .header('x-content-type-options', 'nosniff')
      .type('text/html; charset=utf-8')
      .send(waiting.html);
  });

  /**
   * The theme the shop's pages are rendered in: the one previewed, else its main theme, or the
   * draft of its running experiment for a shopper in a draft's arm (ADR-866, ADR-931).
   */
  const themeFor =
    (shop: Found) =>
    (doc: ShopDoc): Theme | Promise<Theme> => {
      if (shop.preview) return shop.preview.theme;
      shop.experiment ??= experimentArm(doc.experiment, shop.experimentCookie, shop.robot);
      return themes.for(shop.shopId, doc, shop.store, shop.experiment?.arm);
    };

  /**
   * The shop's address, as search engines are told it (OS-09): its primary domain, else its
   * handle's subdomain; the request's own where the renderer knows neither, as in tests.
   */
  const originOf = async (request: FastifyRequest, found: Found): Promise<string> =>
    renderer.shopUrl(await found.store.shop()) ||
    `${secure ? 'https' : 'http'}://${request.headers.host ?? ''}`;
  const languages = { locales: [...theme.locales.keys()], defaultLocale: theme.defaultLocale };

  /** What crawlers read: kept at the edge for an hour, and forgotten with the shop's document. */
  const crawlers = async (
    request: FastifyRequest,
    reply: FastifyReply,
    type: string,
    body: (found: Found, origin: string) => Promise<string | null>,
  ) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    try {
      const sent = await body(found, await originOf(request, found));
      if (sent === null) return await notFound(reply, 'The shop has no such sitemap.');
      return await reply
        .header('cache-control', CRAWLER_CACHE)
        .header('cache-tag', shopTag(found.shopId))
        .type(type)
        .send(sent);
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      throw error;
    }
  };

  /**
   * The installable storefront (OS-14, ADR-832): the shop's manifest, its icon where it has no
   * square logo, and its offline page, kept at the edge an hour and forgotten with the shop's
   * document; and the worker, which browsers ask for afresh, so a new one reaches them at once.
   */
  const installable =
    (type: string, body: (doc: ShopDoc, request: FastifyRequest, reply: FastifyReply) => string) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const found = await shopFor(request, reply);
      if (!found) return notFound(reply, 'No shop answers at this address.');
      try {
        const doc = await found.store.shop();
        reply
          .header('cache-control', CRAWLER_CACHE)
          .header('cache-tag', shopTag(found.shopId))
          .header('x-content-type-options', 'nosniff');
        return await reply.type(type).send(body(doc, request, reply));
      } catch (error) {
        if (error instanceof StoreMissingError)
          return notFound(reply, 'This shop is not open yet.');
        throw error;
      }
    };
  app.get(
    PWA_PATHS.manifest,
    installable('application/manifest+json; charset=utf-8', (doc, request) =>
      JSON.stringify(
        webManifest(doc, {
          urdu: (request.query as Record<string, unknown>).locale === 'ur',
        }),
      ),
    ),
  );
  app.get(
    PWA_PATHS.icon,
    installable('image/svg+xml', (doc) => initialIcon(doc.name)),
  );
  app.get(
    PWA_PATHS.offline,
    installable('text/html; charset=utf-8', (doc, _request, reply) => {
      const page = offlinePage(doc);
      reply
        .header('content-security-policy', page.contentSecurityPolicy)
        .header('x-robots-tag', 'noindex');
      return page.html;
    }),
  );
  app.get(PWA_PATHS.worker, async (_request, reply) =>
    reply
      .header('cache-control', 'no-cache')
      .header('x-content-type-options', 'nosniff')
      .type('text/javascript; charset=utf-8')
      .send(SERVICE_WORKER),
  );

  app.get('/robots.txt', (request, reply) =>
    crawlers(request, reply, 'text/plain; charset=utf-8', async (found, origin) =>
      // Closed behind its password: nothing to crawl yet.
      (await lockOf(request, found))
        ? 'User-agent: *\nDisallow: /\n'
        : robotsTxt(origin, languages, (await found.store.shop()).robotsRules),
    ),
  );

  /**
   * The index of the shop's sitemaps, one for each 5,000 of its products, collections, pages, blogs
   * or articles, with when each last changed (ADR-608).
   */
  app.get('/sitemap.xml', (request, reply) =>
    crawlers(request, reply, 'application/xml; charset=utf-8', async (found, origin) => {
      const entries = await Promise.all(
        SITEMAP_KINDS.map(async (kind) => [kind, inSitemapOrder(await found.store.sitemap(kind))]),
      );
      return sitemapIndex(origin, Object.fromEntries(entries));
    }),
  );

  app.get('/sitemaps/:name', (request, reply) =>
    crawlers(request, reply, 'application/xml; charset=utf-8', async (found, origin) => {
      const asked = sitemapOf((request.params as { name: string }).name);
      if (!asked) return null;
      const entries = inSitemapOrder(await found.store.sitemap(asked.kind));
      if (asked.page > Math.max(sitemapPages(entries.length), 1)) return null;
      return sitemapPage(origin, asked.kind, entries, asked.page, languages);
    }),
  );

  /**
   * The shop's catalog feed (MKT-11, ADR-142), which Google Merchant Center and Meta's catalogs
   * fetch: kept at the edge for an hour, as what crawlers read is, and sent as it is made, a chunk
   * of products at a time.
   */
  app.get(PRODUCT_FEED_PATH, async (request, reply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    try {
      const shop = await found.store.shop();
      const origin = await originOf(request, found);
      return await reply
        .header('cache-control', CRAWLER_CACHE)
        .header('cache-tag', shopTag(found.shopId))
        .type('application/xml; charset=utf-8')
        .send(Readable.from(productFeed(found.store, shop, origin)));
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      throw error;
    }
  });

  /**
   * A blog's Atom feed (ADR-209), at its page's address with .atom, as Shopify's: kept at the edge
   * as its page is, and forgotten with it when an article changes. At its Urdu page's too, in Urdu
   * as that page is (ADR-623).
   */
  const blogAtom = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    const { handle } = request.params as { handle: string };
    const language = languageOf(request);
    try {
      const store = language.prefix
        ? new TranslatedStore(found.store, language.locale)
        : found.store;
      const blog = /^[\w-]+$/.test(handle) ? await store.blogByHandle(handle) : null;
      if (!blog) return await notFound(reply, 'The shop has no such blog.');
      const shop = await store.shop();
      const origin = await originOf(request, found);
      return await reply
        .header('cache-control', PAGE_CACHE)
        .header('cache-tag', cacheTags(found.shopId, [{ kind: 'blog', handle }], null))
        .type('application/atom+xml; charset=utf-8')
        .send(Readable.from(blogFeed(store, shop, blog, origin, new Date(), language)));
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      throw error;
    }
  };
  for (const path of ['/blogs/:handle.atom', '/ur/blogs/:handle.atom']) app.get(path, blogAtom);

  /**
   * A collection's Atom feed (ADR-216), at its page's address with .atom, as Shopify's: kept at the
   * edge as its page is, and forgotten when the collection changes, or any product, whose change
   * purges the listing of them all, as the link page's does. In Urdu at its Urdu page's address,
   * as a blog's is (ADR-623).
   */
  const collectionAtom = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    const { handle } = request.params as { handle: string };
    const language = languageOf(request);
    try {
      const store = language.prefix
        ? new TranslatedStore(found.store, language.locale)
        : found.store;
      const collection = /^[\w-]+$/.test(handle) ? await store.collectionByHandle(handle) : null;
      if (!collection) return await notFound(reply, 'The shop has no such collection.');
      const shop = await store.shop();
      const origin = await originOf(request, found);
      const named: NamedDocument[] = [
        { kind: 'collection', handle },
        { kind: 'collection', handle: 'all' },
      ];
      return await reply
        .header('cache-control', PAGE_CACHE)
        .header('cache-tag', cacheTags(found.shopId, handle === 'all' ? [named[0]!] : named, null))
        .type('application/atom+xml; charset=utf-8')
        .send(Readable.from(collectionFeed(store, shop, collection, origin, new Date(), language)));
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      throw error;
    }
  };
  for (const path of ['/collections/:handle.atom', '/ur/collections/:handle.atom']) {
    app.get(path, collectionAtom);
  }

  app.get('/assets/:version/:file', async (request, reply) => {
    const { file } = request.params as { file: string };
    const source = theme.files[`assets/${file}`];
    if (source === undefined) return reply.code(404).send();
    const type = file.endsWith('.css') ? 'text/css' : 'application/javascript';
    return reply.type(`${type}; charset=utf-8`).header('cache-control', ASSET_CACHE).send(source);
  });

  if (options.placeholders) {
    app.get('/images/*', async (request, reply) => {
      const path = (request.params as { '*': string })['*'];
      const hue = createHash('sha256').update(path).digest()[0]! * 1.4;
      const [width, height] = path.startsWith('banners/') ? [5, 3] : [4, 5];
      const label = path
        .split('/')
        .at(-1)!
        .replace(/\.\w+$/, '')
        .replace(/-/g, ' ')
        .slice(0, 28);
      return reply
        .type('image/svg+xml')
        .header('cache-control', 'public, max-age=86400')
        .send(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width * 100} ${height * 100}">` +
            `<rect width="100%" height="100%" fill="hsl(${hue} 45% 78%)"/>` +
            `<text x="50%" y="50%" text-anchor="middle" font-family="sans-serif" font-size="14" ` +
            `fill="hsl(${hue} 40% 30%)">${label}</text></svg>`,
        );
    });
  }

  /**
   * Sends the shopper to a new checkout of the cart `token` names, on the shop's own address; or
   * to the cart again when it has nothing to order. The checkout keeps the visits that brought
   * them (ADR-139): those their cookie keeps, and the request itself, by the rules the pages'
   * script keeps them by: a cart permalink is where they `landed`, as when an ad brings them
   * straight here; another request counts only when another site or a campaign's link sent it.
   */
  const toCheckout = async (
    request: FastifyRequest,
    reply: FastifyReply,
    shopId: string,
    token: string | null,
    urdu: boolean,
    landed = false,
    /** What a permalink fills in of the checkout, its `checkout[...]` query (ADR-709). */
    filled = '',
  ) => {
    if (!core) throw new StorefrontApiError(503, 'This storefront keeps no carts');
    const started = await core.startCheckout(shopId, token, checkoutVisits(request, reply, landed));
    return reply.redirect(
      started.ok ? `${started.path}${filled}` : `${urdu ? '/ur' : ''}/cart`,
      303,
    );
  };

  /**
   * The visits that brought the shopper to a checkout they begin (ADR-139), this request among
   * them, which the visits cookie keeps; `landed` when it is where they came in.
   */
  const checkoutVisits = (request: FastifyRequest, reply: FastifyReply, landed: boolean) => {
    const now = Math.floor(Date.now() / 1000);
    const host = request.headers.host ?? '';
    const url = new URL(request.url, 'http://storefront');
    const kept = keptVisits(cookieOf(request.headers.cookie, VISITS_COOKIE), now);
    // Without the shopper's details a permalink fills in, which visits do not keep (ADR-709).
    const path = `${url.pathname}${withoutPrefill(url.search)}`;
    const after = visitsAfter(kept, { path, host, referrer: request.headers.referer, landed }, now);
    if (after) reply.header('set-cookie', visitsCookie(after, { secure }));
    return storefrontVisits(after ?? kept, `${secure ? 'https' : 'http'}://${host}`);
  };

  /** The core could not be reached, as when it restarts: said so, rather than failing. */
  const unreachable = (request: FastifyRequest, error: unknown): boolean => {
    if (!(error instanceof StorefrontApiError) && !isNetworkError(error)) return false;
    request.log.warn({ err: error }, 'core not reached');
    return true;
  };

  /**
   * A page of the shop's, sent as it is written: the head goes while the sections render. A page
   * showing a preview is the shopper's alone, with a bar that names the theme.
   */
  const sendPage = async (
    reply: FastifyReply,
    request: PageRequest,
    shop: Found,
    status?: number,
    /**
     * The request, for a page that sends shoppers on: to the shop's primary domain, or where the
     * shop's URL redirect from its path points.
     */
    asked?: FastifyRequest,
  ) => {
    const preview = shop.preview && { name: shop.preview.name };
    const editor = shop.editor ? { origins: editorOrigins } : null;
    const ready = await renderer.prepare(
      { ...request, preview, editor, currency: shop.currency },
      shop.store,
      themeFor(shop),
    );
    // Asked for at another of the shop's addresses: the same page at its primary domain, which
    // renders there (ADR-048). A preview stays where its link opened it.
    const host = asked?.headers.host ?? '';
    if (asked && !preview && ready.domain !== '' && hostName(host) !== ready.domain) {
      const port = secure ? '' : (/:\d+$/.exec(host)?.[0] ?? '');
      const to = `${secure ? 'https' : 'http'}://${ready.domain}${port}${asked.url}`;
      return reply.header('cache-control', PAGE_CACHE).redirect(to, 301);
    }
    // Nothing at the path: the shop may send shoppers on from it (ADR-052). The editor shows its
    // 404 page, to change it.
    const notFoundAt =
      ready.status === 404 && status === undefined ? redirectKey(request.path) : null;
    if (notFoundAt !== null && asked && !editor) {
      const first = await shop.store.redirect(notFoundAt);
      if (first !== null) {
        // On to where the chain ends, in one hop (ADR-617): through paths the shop has no page
        // at and another redirect leaves, at most a few, a loop stopping where it turns back.
        let target = first;
        const passed = [notFoundAt];
        for (let hop = 0; hop < CHAIN_HOPS; hop += 1) {
          const through = /^\/(?!\/)[^?#]*/.exec(target)?.[0];
          const key = through === undefined ? null : redirectKey(through);
          if (key === null || passed.includes(key)) break;
          const next = await shop.store.redirect(key);
          if (next === null) break;
          const there = await renderer.prepare(
            { path: through!, locale: request.locale, preview, editor },
            shop.store,
            themeFor(shop),
          );
          if (there.status !== 404) break;
          passed.push(key);
          // A part of the page named on the way is kept where the next target names none.
          const part = /#.*$/.exec(target)?.[0];
          target = part && !next.includes('#') ? `${next}${part}` : next;
        }
        if (preview) previewed(reply);
        else {
          reply
            .header('cache-control', PAGE_CACHE)
            .header(
              'cache-tag',
              [
                cacheTags(shop.shopId, ready.named, notFoundAt),
                ...passed.slice(1).map((key) => pathTag(shop.shopId, key)),
              ].join(','),
            );
        }
        return reply.redirect(redirectedTo(target, request.locale === 'ur', asked.url), 301);
      }
    }
    const page = ready.stream();
    // Kept at the edge by the documents it names, unless a handler said otherwise (ADR-047).
    if (preview) previewed(reply);
    else if (!reply.hasHeader('cache-control')) reply.header('cache-control', PAGE_CACHE);
    if (String(reply.getHeader('cache-control')).startsWith('public')) {
      reply.header('cache-tag', cacheTags(shop.shopId, page.named, notFoundAt));
    }
    return reply
      .code(status ?? page.status)
      .type('text/html; charset=utf-8')
      .send(Readable.from(page.body));
  };

  /**
   * Sections of `page`, as Shopify's section rendering API gives them: each by its ID, rendered
   * with the shopper's cart, or null when neither the page nor the theme has it.
   */
  const sectionsOf = async (
    shop: Found,
    page: URL,
    ids: readonly string[],
    cart: CartJson | null,
    /** The theme editor's, with the theme it has unsaved over the one previewed. */
    editing?: { theme: Theme },
  ): Promise<Record<string, string | null>> => {
    if (ids.length === 0) return {};
    const theme = editing ? () => editing.theme : themeFor(shop);
    const request = { ...pageRequestOf(page, cart, Boolean(editing)), currency: shop.currency };
    const rendered = await renderer.sections(request, shop.store, ids, theme);
    return Object.fromEntries(ids.map((id) => [id, rendered.get(id) ?? null]));
  };

  /**
   * The CSS the theme's settings fill in on a page's layout, its `{% style %}` elements in order,
   * with the theme the editor has unsaved (ADR-700): the whole page rendered in design mode.
   */
  const layoutStylesOf = async (
    shop: Found,
    page: URL,
    cart: CartJson | null,
    theme: Theme,
  ): Promise<string[]> => {
    const rendered = await renderer.render(
      pageRequestOf(page, cart, true),
      shop.store,
      () => theme,
    );
    return layoutStyles(rendered.html);
  };

  /** A page of the shop's, at `page`, as sections and the editor render it. */
  const pageRequestOf = (page: URL, cart: CartJson | null, editing: boolean): PageRequest => {
    const urdu = page.pathname === '/ur' || page.pathname.startsWith('/ur/');
    return {
      path: urdu ? page.pathname.slice(3) || '/' : page.pathname,
      query: Object.fromEntries(page.searchParams),
      // A collection's filters, each as often as given (ADR-478).
      params: [...page.searchParams],
      locale: urdu ? 'ur' : 'en',
      cart,
      editor: editing ? { origins: editorOrigins } : null,
    };
  };

  /**
   * Sections rendered for the theme editor (ADR-050): `POST /editor/sections` with
   * `{ page, sections, files, styles? }` renders those sections of that page in design mode, with
   * the theme's files the editor has not saved over the previewed theme's, and says what in them
   * the storefront could not use; with `styles`, the CSS of the layout's `{% style %}` elements
   * too, in order (ADR-700). Only the editor's script asks: a preview of the shop's, its own
   * header, and a request from the page itself.
   */
  app.post('/editor/sections', async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    const refuse = (status: number, message: string) => reply.code(status).send({ message });
    if (
      !found.preview ||
      editorOrigins.length === 0 ||
      request.headers['x-hatti-editor'] !== '1' ||
      request.headers['sec-fetch-site'] === 'cross-site'
    ) {
      return refuse(403, 'Only the theme editor renders settings it has not saved, in a preview.');
    }
    const asked = editorAsk(request.body);
    if (!asked) {
      return refuse(
        400,
        `Send { page, sections, files }: a path on the shop, up to ${EDITOR_SECTIONS_MAX} ` +
          `section IDs, and up to ${EDITOR_FILES_MAX} of the theme's files by name.`,
      );
    }
    // Over the previewed theme as saved, so a file the storefront cannot use leaves the saved one.
    const problems: string[] = [];
    const edited = overlayTheme(found.preview.theme, asked.files, (error) =>
      problems.push(error.message),
    );
    try {
      const token = cookieOf(request.headers.cookie, CART_COOKIE);
      const cart =
        token && core
          ? await core.read(found.shopId, token, accountTokenOf(request.headers.cookie))
          : null;
      const page = new URL(asked.page, 'http://storefront');
      const sections = await sectionsOf(found, page, asked.sections, cart, { theme: edited });
      // The layout's CSS too, as the theme's settings change (ADR-700).
      const styles = asked.styles ? await layoutStylesOf(found, page, cart, edited) : undefined;
      return await reply.send({ sections, problems, ...(styles && { styles }) });
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return refuse(503, 'The cart cannot be reached just now. Please try again in a minute.');
    }
  });

  /**
   * The pictures a shop chose for its themes (ADR-326), at /theme-images/{file}/{name} on its own
   * address, as Shopify serves a shop's files on its domain: from the core, which gives those one
   * of the shop's themes shows and, to a page in a preview, any of its pictures, so the theme
   * editor's choice shows before it is saved. The name is for people, and any will do. A theme's
   * `image_url` asks for a width, which the core makes it at, in the best format the browser
   * takes (ADR-538).
   */
  const themeImage = async (request: FastifyRequest, reply: FastifyReply) => {
    const { file } = request.params as { file: string };
    const found = FILE_ID.test(file) ? await shopFor(request, reply) : null;
    if (!found || !core) {
      return reply.code(404).header('cache-control', NO_THEME_IMAGE_CACHE).send();
    }
    let image;
    try {
      const asked = Number((request.query as Record<string, unknown>).width);
      image = await core.themeImage(found.shopId, file, found.preview !== null, {
        width: Number.isInteger(asked) && asked > 0 && asked <= 10_000 ? asked : null,
        accept: request.headers.accept,
      });
    } catch (error) {
      if (!unreachable(request, error)) throw error;
      return reply.code(503).header('cache-control', 'no-store').send();
    }
    if (!image) return reply.code(404).header('cache-control', NO_THEME_IMAGE_CACHE).send();
    return reply
      .type(image.contentType)
      .header('cache-control', found.preview ? PREVIEWED : THEME_IMAGE_CACHE)
      .header('vary', 'Accept')
      .header('x-content-type-options', 'nosniff')
      .send(Buffer.from(image.body));
  };
  app.get('/theme-images/:file', themeImage);
  app.get('/theme-images/:file/:name', themeImage);

  /**
   * Shopify's section rendering API on a page: `?section_id=` gives one of the page's sections as
   * HTML, `?sections=` up to five as JSON, rendered with the shopper's cart, so never kept.
   */
  const sendSections = async (
    reply: FastifyReply,
    shop: Found,
    url: URL,
    cart: CartJson | null,
  ) => {
    const one = url.searchParams.get('section_id');
    const ids =
      one === null
        ? sectionIdsOf(url.searchParams.get('sections'))
        : SECTION_ID.test(one)
          ? [one]
          : [];
    const page = new URL(`${url.pathname}${url.search}`, 'http://storefront');
    page.searchParams.delete('section_id');
    page.searchParams.delete('sections');
    const rendered = await sectionsOf(shop, page, ids, cart);
    reply.header('cache-control', 'private, no-store');
    if (one === null) return reply.send(rendered);
    const html = ids[0] === undefined ? null : rendered[ids[0]];
    if (!html) return notFound(reply, 'The theme has no such section.');
    return reply.type('text/html; charset=utf-8').send(html);
  };

  /** Whether the address has changed carts more this minute than {@link CART_CHANGES} allows. */
  const changedTooMuch = async (request: FastifyRequest): Promise<boolean> =>
    limiter !== null && !(await limiter.hit(CART_CHANGES, request.ip)).allowed;

  /**
   * A cart permalink, Shopify's `/cart/{variant}:{quantity},…`, which shops paste into chats and
   * bios: a cart of its own with those items, the link's `discount`, `note` and `attributes`
   * applied, and on to its checkout, the shopper's own cart left as it is. Links come from
   * anywhere, so one followed from another site is taken; a HEAD request changes nothing. Items
   * that cannot be had show the shopper's cart, saying why.
   */
  const followPermalink = async (
    request: FastifyRequest,
    reply: FastifyReply,
    found: Found,
    items: CartItemInput[],
    urdu: boolean,
  ) => {
    reply.header('cache-control', 'private, no-store');
    const locale = urdu ? 'ur' : 'en';
    if (request.method !== 'GET') return reply.redirect(`${urdu ? '/ur' : ''}/cart`, 302);
    try {
      if (!core) throw new StorefrontApiError(503, 'This storefront keeps no carts');
      if (await changedTooMuch(request)) return await tooMany(reply);
      const added = await core.act(
        found.shopId,
        null,
        'add',
        { items },
        accountTokenOf(request.headers.cookie),
      );
      if (!added.ok) {
        const words = (key: string, values: Record<string, unknown>) =>
          translation(theme, locale, key, values);
        const own = cookieOf(request.headers.cookie, CART_COOKIE);
        const shown = own
          ? await core.read(found.shopId, own, accountTokenOf(request.headers.cookie))
          : null;
        const page = {
          path: '/cart',
          locale,
          cart: shown,
          cartError: cartErrorMessage(added.error, words),
        };
        return await sendPage(reply, page, found, cartErrorStatus(added.error));
      }
      const search = new URL(request.url, 'http://storefront').search;
      const query = parseForm(search.slice(1));
      const { body } = cartBody('update', {
        note: query.note,
        attributes: query.attributes,
        discount: query.discount,
      });
      // What the link adds to its items; the items go to checkout even if the core refuses it.
      if (Object.keys(body).length > 0)
        await core.act(
          found.shopId,
          added.token,
          'update',
          body,
          accountTokenOf(request.headers.cookie),
        );
      // The shopper's details it gives, as Shopify's `checkout[...]`, carried to the checkout's
      // page to fill it in (ADR-709).
      const filled = new URLSearchParams(
        [...new URLSearchParams(search)].filter(([key]) => key.startsWith('checkout[')),
      ).toString();
      return await toCheckout(
        request,
        reply,
        found.shopId,
        added.token,
        urdu,
        true,
        filled ? `?${filled}` : '',
      );
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return unavailable(reply);
    }
  };

  /**
   * The cart (ADR-042): `/cart` shows it and `/cart.js` gives it to scripts; `/cart/add`,
   * `/change`, `/update` and `/clear` change it, as Shopify's do, through the core. A form is
   * sent back to the cart page, a script gets JSON. Changes come from the shop's own pages, at
   * most {@link CART_CHANGES} a minute from an address.
   */
  const cart = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    const url = new URL(request.url, 'http://storefront');
    const urdu = url.pathname.startsWith('/ur/');
    const locale = urdu ? 'ur' : 'en';
    const path = urdu ? url.pathname.slice(3) : url.pathname;
    const route = cartRoute(path);
    if (!route) {
      const items = request.method === 'POST' ? null : permalinkItems(path);
      if (items) return followPermalink(request, reply, found, items, urdu);
      return sendPage(reply, { path, locale }, found);
    }
    const json = route.json || fromScript(request);
    const token = cookieOf(request.headers.cookie, CART_COOKIE);
    const words = (key: string, values: Record<string, unknown>) =>
      translation(theme, locale, key, values);
    const refuse = (status: number, message: string) =>
      json
        ? reply.code(status).send(ajaxError(status, message))
        : reply.code(status).type('text/plain; charset=utf-8').send(`${message}\n`);
    /** The cookies that keep the cart the shopper has now: none once it names no cart. */
    const keep = (kept: string | null, shown: CartJson | null) => {
      if (kept !== null || token !== null) {
        reply.header('set-cookie', cartCookies(kept, shown?.itemCount ?? 0, { secure }));
      }
    };
    reply.header('cache-control', 'private, no-store');
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    const reading = method === 'GET' && route.action === 'show';
    // Themes' remove links (`line_item.url_to_remove`) change the cart by GET.
    if (!reading && method !== 'POST' && route.action !== 'change') {
      return reply.code(405).header('allow', 'POST').send();
    }
    try {
      if (reading) {
        const shown =
          token && core
            ? await core.read(found.shopId, token, accountTokenOf(request.headers.cookie))
            : null;
        if (core) keep(shown ? token : null, shown);
        if (asksForSections(url)) return await sendSections(reply, found, url, shown);
        if (json) return await reply.send(await ajax(shown, found.store, urdu, found.currency));
        // What came of buying an order again (ADR-574), as its address says.
        const reorder = reorderNoticeOf(url.searchParams.get('reorder'));
        const cartError = reorder && reorderNoticeMessage(reorder, words);
        return await sendPage(reply, { path: '/cart', locale, cart: shown, cartError }, found);
      }
      if (request.headers['sec-fetch-site'] === 'cross-site') {
        return await refuse(403, 'Carts change from the shop itself.');
      }
      if (!core) throw new StorefrontApiError(503, 'This storefront keeps no carts');
      if (limiter && !(await limiter.hit(CART_CHANGES, request.ip)).allowed) {
        return await refuse(429, 'Too many changes to the cart. Please wait a moment.');
      }
      const action = route.action === 'show' ? 'update' : route.action;
      const params = method === 'GET' ? parseForm(url.search.slice(1)) : paramsOf(request);
      // Shopify keeps a file a line's property names; nothing here would (ADR-701).
      if (withFiles.has(params)) return await refuse(422, "This shop's cart takes no files.");
      const { body, single } = cartBody(action, params);
      const result = await core.act(
        found.shopId,
        token,
        action,
        body,
        accountTokenOf(request.headers.cookie),
      );
      if (!result.ok) {
        const message = cartErrorMessage(result.error, words);
        const status = cartErrorStatus(result.error);
        if (json) return await reply.code(status).send(ajaxError(status, message));
        // The cart page again, saying why, as the cart is.
        const shown = token
          ? await core.read(found.shopId, token, accountTokenOf(request.headers.cookie))
          : null;
        const page = { path: '/cart', locale, cart: shown, cartError: message };
        return await sendPage(reply, page, found, status);
      }
      keep(result.token, result.cart);
      if (action === 'add') await counted(request, found, 'added_to_cart');
      // The cart form's checkout button: its quantities and note saved, on to checkout.
      if (!json && route.action === 'show' && params.checkout !== undefined) {
        return await toCheckout(request, reply, found.shopId, result.token, urdu);
      }
      if (!json) return await reply.redirect(returnTo(params) ?? `${urdu ? '/ur' : ''}/cart`, 303);
      // Shopify's bundled section rendering: the sections asked for, with the cart as it is now.
      const asked = sectionIdsOf(params.sections);
      const withSections = async (answer: Record<string, unknown>) =>
        asked.length === 0
          ? answer
          : {
              ...answer,
              sections: await sectionsOf(found, sectionsPage(params, request), asked, result.cart),
            };
      if (action !== 'add') {
        return await reply.send(
          await withSections(await ajax(result.cart, found.store, urdu, found.currency)),
        );
      }
      const store = urdu ? new TranslatedStore(found.store, 'ur') : found.store;
      const products = await cartProducts(result.cart, (ids) => store.products(ids));
      const currency = shownCurrencyOf((await found.store.shop()).currencies, found.currency);
      const added = result.added.flatMap((key) => {
        const line = result.cart.items.find((item) => item.key === key);
        return line
          ? [ajaxLineItem(line, products.get(line.productId), urdu ? '/ur' : '', currency)]
          : [];
      });
      return await reply.send(await withSections(single ? (added[0] ?? {}) : { items: added }));
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return refuse(503, 'Your cart cannot be reached just now. Please try again in a minute.');
    }
  };
  for (const path of ['/cart', '/cart.js', '/cart.json', '/cart/:action']) {
    app.route({ method: ['GET', 'POST'], url: path, handler: cart });
    app.route({ method: ['GET', 'POST'], url: `/ur${path}`, handler: cart });
  }

  /**
   * `/checkout`, as Shopify has it, for themes' checkout links and `return_to`: a new checkout of
   * the shopper's cart, or the cart again when it has nothing to order.
   */
  const checkout = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    reply.header('cache-control', 'private, no-store');
    const urdu = request.url.startsWith('/ur/');
    const token = cookieOf(request.headers.cookie, CART_COOKIE);
    try {
      if (token && limiter && !(await limiter.hit(CART_CHANGES, request.ip)).allowed) {
        return await tooMany(reply);
      }
      return await toCheckout(request, reply, found.shopId, token, urdu);
    } catch (error) {
      if (!unreachable(request, error)) throw error;
      return unavailable(reply);
    }
  };
  for (const path of ['/checkout', '/ur/checkout']) {
    app.route({ method: ['GET', 'POST'], url: path, handler: checkout });
  }

  /**
   * `/discount/CODE`, as Shopify's discount links: the code kept with the shopper's cart, one
   * begun for it if they have none, for checkout to apply; then on to `redirect`, a path on the
   * shop, or its home page, with the link's campaign tags and click IDs, whose page keeps the
   * visit (ADR-139). Shops share links anywhere, so one followed from another site is
   * taken: it changes nothing but the code. Past {@link CART_CHANGES}, or with the core away, the
   * shopper is still sent on, without the code; a HEAD request only learns where.
   */
  const discountLink = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    reply.header('cache-control', 'private, no-store');
    const url = new URL(request.url, 'http://storefront');
    const onward = withCampaign(
      localPath(url.searchParams.get('redirect')) ??
        (url.pathname.startsWith('/ur/') ? '/ur' : '/'),
      url.searchParams,
    );
    const { code } = request.params as { code: string };
    const token = cookieOf(request.headers.cookie, CART_COOKIE);
    try {
      if (core && request.method === 'GET' && !(await changedTooMuch(request))) {
        const result = await core.act(
          found.shopId,
          token,
          'update',
          { discount: code },
          accountTokenOf(request.headers.cookie),
        );
        if (result.ok && (result.token !== null || token !== null)) {
          reply.header('set-cookie', cartCookies(result.token, result.cart.itemCount, { secure }));
        }
      }
    } catch (error) {
      if (!unreachable(request, error)) throw error;
    }
    return reply.redirect(onward, 302);
  };
  for (const path of ['/discount/:code', '/ur/discount/:code']) app.get(path, discountLink);

  /**
   * A checkout's page (ADR-044), on the shop's own address: the core renders it, for this shop's
   * checkouts only, and the storefront sends it, with the shopper's address and browser when they
   * post it. Placing the order empties the cart, so the count pages show goes to 0.
   */
  const checkoutPage = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    const { token } = request.params as { token: string };
    const posted = request.method === 'POST';
    reply.header('cache-control', 'no-store');
    try {
      if (!core) throw new StorefrontApiError(503, 'This storefront keeps no carts');
      if (posted && request.headers['sec-fetch-site'] === 'cross-site') {
        return await reply
          .code(403)
          .type('text/plain; charset=utf-8')
          .send('Orders are placed from the shop itself.\n');
      }
      if (posted && limiter && !(await limiter.hit(CART_CHANGES, request.ip)).allowed) {
        return await tooMany(reply);
      }
      const form = posted ? textFields(paramsOf(request)) : null;
      // Where the shopper placed the order from, which the order keeps (ADR-057), with the IDs
      // the shop's Meta pixel gave their browser, for its conversions (ADR-144); none, and that
      // they declined, when the shop asked first and they did not accept (ADR-551).
      const asks =
        posted &&
        (await found.store.shop().then(
          (doc) => doc.consentBanner === true,
          () => false,
        ));
      const browserIds = browserIdsOf(request.headers.cookie, asks);
      // And the number this browser proved lately at the shop's checkout (ADR-199), and the
      // shopper's session signed in to their account, which proved its own (ADR-586).
      const proof = cookieOf(request.headers.cookie, NUMBER_PROOF_COOKIE);
      const signedIn = accountTokenOf(request.headers.cookie);
      const client = {
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        ...(browserIds && { browserIds }),
        ...(proof && { proof }),
        ...(signedIn && { account: signedIn }),
      };
      // Opened by a shopper signed in to their account, filled in from it (ADR-585), and with
      // what the cart permalink that began it gives (ADR-709).
      const account = posted ? null : signedIn;
      const prefill = posted
        ? undefined
        : permalinkPrefill(new URL(request.url, 'http://storefront').searchParams);
      const page = await core.checkoutPage(
        found.shopId,
        token,
        form,
        posted ? client : undefined,
        account,
        prefill,
      );
      // Its session reached checkout, and, once it is placed, converted (ADR-180).
      if (!posted && 'html' in page && page.status === 200) {
        await counted(request, found, 'reached_checkout');
      }
      if (page.placed) {
        await counted(request, found, 'converted');
        if (page.sale) await sold(request, found, page.sale);
        // The shopper's own cart: emptied by the order, unless a permalink's cart was ordered.
        const own = cookieOf(request.headers.cookie, CART_COOKIE);
        // The order is placed whatever the count says: a cart not read counts none.
        const kept = own
          ? await core
              .read(found.shopId, own, accountTokenOf(request.headers.cookie))
              .catch(() => null)
          : null;
        const count = cartCountCookie(kept?.itemCount ?? 0, { secure });
        // Its number proved by a code: its next checkouts need not ask again (ADR-199).
        reply.header(
          'set-cookie',
          page.proof ? [count, numberProofCookie(page.proof, { secure })] : count,
        );
        return await reply.redirect(checkoutPagePath(token), 303);
      }
      // Paying the order online: on to the shop's gateway (ADR-152).
      if ('redirect' in page) {
        return await reply.header('referrer-policy', 'no-referrer').redirect(page.redirect, 303);
      }
      return await reply.code(page.status).headers(page.headers).send(page.html);
    } catch (error) {
      if (!unreachable(request, error)) throw error;
      return unavailable(reply);
    }
  };
  app.route({ method: ['GET', 'POST'], url: '/checkouts/:token', handler: checkoutPage });

  /**
   * The name and number a shopper typed on a checkout's page, as its script sends them once the
   * number is whole (ADR-393), passed to the core for the shop's abandoned checkouts: 204 for
   * whatever came of it. From the shop's own pages only, and as often as cart changes.
   */
  app.post('/checkouts/:token/contact', async (request, reply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    reply.header('cache-control', 'no-store');
    if (!core || request.headers['sec-fetch-site'] === 'cross-site') {
      return reply.code(204).send();
    }
    if (limiter && !(await limiter.hit(CART_CHANGES, request.ip)).allowed) {
      return tooMany(reply);
    }
    const { token } = request.params as { token: string };
    const form = textFields(paramsOf(request));
    try {
      await core.checkoutContact(found.shopId, token, {
        name: (form.name ?? '').slice(0, 200),
        phone: (form.phone ?? '').slice(0, 40),
      });
    } catch (error) {
      if (!unreachable(request, error)) throw error;
    }
    return reply.code(204).send();
  });

  /**
   * A payment link (ADR-248), `/pay/{token}`, which a shop shares once, on WhatsApp, Instagram or
   * anywhere: each shopper who opens it gets a checkout of their own with the link's items, kept
   * apart from their own cart, as a cart permalink's is; or the core's page saying why not, such
   * as once the link closed. Links come from anywhere, so one followed from another site is
   * taken, at most {@link CART_CHANGES} a minute from an address; a HEAD request changes nothing.
   */
  const paymentLink = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    reply.header('cache-control', 'private, no-store');
    const urdu = request.url.startsWith('/ur/');
    if (request.method !== 'GET') return reply.redirect(urdu ? '/ur' : '/', 302);
    const { token } = request.params as { token: string };
    try {
      if (!core) throw new StorefrontApiError(503, 'This storefront keeps no carts');
      if (await changedTooMuch(request)) return await tooMany(reply);
      const opened = await core.openPaymentLink(
        found.shopId,
        token,
        checkoutVisits(request, reply, true),
      );
      if ('path' in opened) return await reply.redirect(opened.path, 303);
      return await reply.code(opened.status).headers(opened.headers).send(opened.html);
    } catch (error) {
      if (!unreachable(request, error)) throw error;
      return unavailable(reply);
    }
  };
  for (const path of ['/pay/:token', '/ur/pay/:token']) app.get(path, paymentLink);

  /**
   * The shop's tracking page (SHP-05, ADR-251), `/track`: its form, and a customer's order found
   * by its number or a tracking number, with the mobile number they ordered with, as the core
   * renders it. Lookups come from the shop's own pages, at most {@link TRACKING_LOOKUPS} a minute
   * from an address.
   */
  const trackingPage = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    const posted = request.method === 'POST';
    reply.header('cache-control', 'no-store');
    try {
      if (!core) throw new StorefrontApiError(503, 'This storefront keeps no orders');
      if (posted && request.headers['sec-fetch-site'] === 'cross-site') {
        return await reply
          .code(403)
          .type('text/plain; charset=utf-8')
          .send('Orders are looked up from the shop itself.\n');
      }
      if (posted && limiter && !(await limiter.hit(TRACKING_LOOKUPS, request.ip)).allowed) {
        return await tooMany(reply);
      }
      const fields = posted ? textFields(paramsOf(request)) : null;
      const page = await core.trackingPage(
        found.shopId,
        fields && { reference: fields.reference ?? '', phone: fields.phone ?? '' },
      );
      return await reply.code(page.status).headers(page.headers).send(page.html);
    } catch (error) {
      if (!unreachable(request, error)) throw error;
      return unavailable(reply);
    }
  };
  for (const path of ['/track', '/ur/track']) {
    app.route({ method: ['GET', 'POST'], url: path, handler: trackingPage });
  }

  /** Whether the address has asked for more searches this minute than {@link SEARCHES} allows. */
  const searchedTooMuch = async (request: FastifyRequest): Promise<boolean> =>
    limiter !== null && !(await limiter.hit(SEARCHES, request.ip)).allowed;

  /**
   * Search (ADR-046): `/search?q=` finds the shop's products through the core, and its pages and
   * articles (ADR-212), or the kinds Shopify's `type` names, and the theme's search page shows
   * them, a page at a time. Without words, the page asks for some. With Shopify's
   * `options[prefix]=last`, the last word may be cut short.
   */
  const search = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    const url = new URL(request.url, 'http://storefront');
    const urdu = url.pathname.startsWith('/ur/');
    const query = Object.fromEntries(url.searchParams);
    const terms = (query.q ?? '').trim().slice(0, SEARCH_TERMS_MAX);
    const types = searchTypes(query.type);
    let results: Omit<SearchFound, 'terms' | 'types'> = { productIds: [] };
    try {
      if (terms !== '') {
        if (!core) throw new StorefrontApiError(503, 'This storefront has no search');
        if (await searchedTooMuch(request)) {
          return await reply
            .code(429)
            .header('cache-control', 'no-store')
            .type('text/plain; charset=utf-8')
            .send('Too many searches. Please wait a moment.\n');
        }
        const prefix = query['options[prefix]'] === 'last' ? 'last' : 'none';
        const content = contentTypes(types);
        const [productIds, more] = await Promise.all([
          types.includes('product') ? core.search(found.shopId, terms, { prefix }) : [],
          content.length > 0
            ? core.searchContent(found.shopId, terms, { prefix, types: content })
            : { pageIds: [], articleIds: [] },
        ]);
        results = { productIds, pageIds: more.pageIds, articleIds: more.articleIds };
      }
      const page = {
        path: '/search',
        query,
        // Its filters, each as often as given (ADR-479).
        params: [...url.searchParams],
        locale: urdu ? 'ur' : 'en',
        search: { terms, types, ...results },
      };
      reply.header('cache-control', SEARCH_CACHE);
      return await sendPage(reply, page, found, undefined, request);
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return reply
        .code(503)
        .header('cache-control', 'no-store')
        .type('text/plain; charset=utf-8')
        .send('Search cannot be reached just now. Please try again in a minute.\n');
    }
  };
  for (const path of ['/search', '/ur/search']) app.get(path, search);

  /**
   * The shop for AI shopping agents (OS-23, ADR-847): its UCP profile, which says where its store
   * MCP endpoint is and what its tools do; and the endpoint, JSON-RPC 2.0 over POST, whose tools
   * search and read the shop's products and make carts that its own checkout takes. Nothing while
   * the shop is behind its password, or keeps agents out (ADR-908).
   */
  app.get(AGENT_PATHS.profile, async (request, reply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    try {
      if (await lockOf(request, found)) return await notFound(reply, 'This shop is not open yet.');
      if ((await found.store.shop()).agentsBlocked) {
        return await notFound(reply, 'This shop takes no AI agents.');
      }
      return await reply
        .header('cache-control', CRAWLER_CACHE)
        .header('cache-tag', shopTag(found.shopId))
        .header('access-control-allow-origin', '*')
        .type('application/json; charset=utf-8')
        .send(JSON.stringify(ucpProfile(await originOf(request, found))));
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      throw error;
    }
  });
  /**
   * Buy buttons (CH-08, ADR-860): the script other websites load, the same for every shop, and
   * the product it shows, as JSON any site may read, as public as the product's page: nothing for
   * a product the storefront doesn't show, nor while the shop is behind its password.
   */
  app.get(BUY_BUTTON_PATHS.script, async (_request, reply) =>
    reply
      .header('cache-control', 'public, max-age=3600, s-maxage=86400')
      .type('text/javascript; charset=utf-8')
      .send(BUY_BUTTON_SCRIPT),
  );
  app.get<{ Params: { handle: string } }>(BUY_BUTTON_PATHS.product, async (request, reply) => {
    reply.header('access-control-allow-origin', '*');
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    try {
      if (await lockOf(request, found)) return await notFound(reply, 'This shop is not open yet.');
      const product = await found.store.productByHandle(request.params.handle.slice(0, 255));
      if (!product) return await notFound(reply, 'The shop has no such product.');
      return await reply
        .header('cache-control', PAGE_CACHE)
        .header('cache-tag', shopTag(found.shopId))
        .type('application/json; charset=utf-8')
        .send(JSON.stringify(buyButtonProduct(product, await originOf(request, found), 'PKR')));
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      throw error;
    }
  });
  // A collection's embed (ADR-925): a page of its products, `?page=2` the next (ADR-937), as
  // public as its page.
  app.get<{ Params: { handle: string }; Querystring: { page?: string } }>(
    BUY_BUTTON_PATHS.collection,
    async (request, reply) => {
      reply.header('access-control-allow-origin', '*');
      const found = await shopFor(request, reply);
      if (!found) return notFound(reply, 'No shop answers at this address.');
      try {
        if (await lockOf(request, found))
          return await notFound(reply, 'This shop is not open yet.');
        const collection = await found.store.collectionByHandle(
          request.params.handle.slice(0, 255),
        );
        if (!collection) return await notFound(reply, 'The shop has no such collection.');
        const page = buyButtonPage(request.query.page);
        const size = BUY_BUTTON_COLLECTION.products;
        const products = await found.store.products(
          collection.productIds.slice((page - 1) * size, page * size),
        );
        return await reply
          .header('cache-control', PAGE_CACHE)
          .header('cache-tag', shopTag(found.shopId))
          .type('application/json; charset=utf-8')
          .send(
            JSON.stringify(
              buyButtonCollection(
                collection,
                products,
                await originOf(request, found),
                'PKR',
                page,
              ),
            ),
          );
      } catch (error) {
        if (error instanceof StoreMissingError)
          return notFound(reply, 'This shop is not open yet.');
        throw error;
      }
    },
  );
  /**
   * The Storefront API (DEV-02, ADR-848), as Shopify's at /api/<version>/graphql.json: answered
   * with one of the shop's tokens, public from browsers, private from a server; a cart it makes
   * is checked out at /cart/c/<token>, its checkoutUrl.
   */
  const STOREFRONT_API_PATH = '/api/:version/graphql.json';
  const API_VERSION = /^(\d{4}-\d{2}|unstable)$/;
  const corsHeaders = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': `content-type, accept, ${STOREFRONT_TOKEN_HEADERS.public}, ${STOREFRONT_TOKEN_HEADERS.private}`,
    'access-control-max-age': '86400',
  };
  app.options(STOREFRONT_API_PATH, (_request, reply) =>
    reply.code(204).headers(corsHeaders).send(),
  );
  app.post(STOREFRONT_API_PATH, { bodyLimit: 64 * 1024 }, async (request, reply) => {
    reply.headers(corsHeaders).header('cache-control', 'no-store');
    const { version } = request.params as { version: string };
    if (!API_VERSION.test(version)) {
      return reply.code(404).send({ errors: [{ message: 'No such API version' }] });
    }
    const found = await shopFor(request, reply);
    if (!found) return reply.code(404).send({ errors: [{ message: 'No shop answers here' }] });
    if (!isJson(request)) return reply.code(415).send({ errors: [{ message: 'Send JSON' }] });
    try {
      const shop = await found.store.shop();
      const kind = storefrontTokenOf(request.headers, shop.storefrontTokens);
      if (!kind) {
        return await reply.code(401).send({
          errors: [{ message: "Give one of the shop's Storefront API tokens" }],
        });
      }
      const bucket = kind === 'private' ? STOREFRONT_API_SERVER_CALLS : STOREFRONT_API_CALLS;
      if (limiter !== null && !(await limiter.hit(bucket, request.ip)).allowed) {
        return await reply
          .code(429)
          .send({ errors: [{ message: 'Too many calls: wait a minute' }] });
      }
      // Who signs in: the buyer a shop's own server calls for, as Shopify's header says, where
      // its private token vouches for it; the caller otherwise (ADR-943).
      const said = request.headers[STOREFRONT_BUYER_IP_HEADER];
      const buyer =
        kind === 'private' && typeof said === 'string' && isIP(said.trim())
          ? said.trim()
          : request.ip;
      const signInsLeft = async () =>
        limiter === null || (await limiter.hit(ACCOUNT_LOGINS, buyer)).allowed;
      const answer = await storefrontApiAnswer(request.body, {
        shopId: found.shopId,
        store: found.store,
        shop,
        accounts: core
          ? {
              sendCode: async (asked) =>
                (await signInsLeft())
                  ? core.accountLoginStart(found.shopId, asked, { ip: buyer })
                  : 'too_many_requests',
              signIn: async (asked) =>
                (await signInsLeft())
                  ? core.accountLoginVerify(found.shopId, asked)
                  : 'too_many_requests',
              account: (token) => core.account(found.shopId, token),
              signOut: (token) => core.accountLogout(found.shopId, token),
              addresses: (token) => core.accountAddresses(found.shopId, token),
              saveAddress: (token, address, id) =>
                core.accountAddressSave(found.shopId, token, address, id),
              deleteAddress: (token, id) => core.accountAddressDelete(found.shopId, token, id),
            }
          : null,
        search: async (terms) => (core ? core.search(found.shopId, terms, { prefix: 'none' }) : []),
        carts: core
          ? {
              read: (shopId, token) => core.read(shopId, token),
              act: (shopId, token, action, body) =>
                core.act(shopId, token, action as Parameters<typeof core.act>[2], body as never),
            }
          : null,
        origin: await originOf(request, found),
        currency: 'PKR',
        // In Urdu where a query asks for it with @inContext (ADR-903).
        inLanguage: (locale) => new TranslatedStore(found.store, locale),
      });
      return await reply.type('application/json; charset=utf-8').send(JSON.stringify(answer));
    } catch (error) {
      if (error instanceof StoreMissingError) {
        return reply.code(404).send({ errors: [{ message: 'This shop is not open yet' }] });
      }
      if (!unreachable(request, error)) throw error;
      return reply.code(503).send({ errors: [{ message: 'The shop cannot be reached just now' }] });
    }
  });
  // A cart the Storefront API made, taken to the shop's checkout: kept as the shopper's cart too.
  app.get('/cart/c/:token', async (request, reply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    const { token } = request.params as { token: string };
    try {
      if (!core) throw new StorefrontApiError(503, 'This storefront keeps no carts');
      const cart = /^[\w.-]{1,200}$/.test(token) ? await core.read(found.shopId, token) : null;
      if (!cart) return await reply.redirect('/cart', 303);
      reply.header('set-cookie', cartCookies(token, cart.itemCount, { secure }));
      return await toCheckout(request, reply, found.shopId, token, false, true);
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return reply
        .code(503)
        .header('cache-control', 'no-store')
        .type('text/plain; charset=utf-8')
        .send('The cart cannot be reached just now. Please try again in a minute.\n');
    }
  });

  // Nothing streams from it: MCP's GET, for events, is not taken.
  app.get(AGENT_PATHS.mcp, (_request, reply) =>
    reply.code(405).header('allow', 'POST').header('cache-control', 'no-store').send(),
  );
  app.post(AGENT_PATHS.mcp, { bodyLimit: AGENT_LIMITS.body }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    if (!isJson(request)) return reply.code(415).send({ message: 'Send JSON-RPC as JSON.' });
    if (limiter !== null && !(await limiter.hit(AGENT_CALLS, request.ip)).allowed) {
      return reply.code(429).send({ message: 'Too many calls. Please wait a minute.' });
    }
    try {
      if (await lockOf(request, found)) return await notFound(reply, 'This shop is not open yet.');
      const shop = await found.store.shop();
      // A shop that keeps agents out answers as if it had no endpoint (ADR-908).
      if (shop.agentsBlocked) return await notFound(reply, 'This shop takes no AI agents.');
      const answer = await mcpAnswer(request.body, {
        store: found.store,
        shop,
        search: async (terms) => (core ? core.search(found.shopId, terms, { prefix: 'none' }) : []),
        origin: await originOf(request, found),
        name: shop.name,
        currency: 'PKR',
      });
      if (!answer) return await reply.code(202).send();
      return await reply.type('application/json; charset=utf-8').send(JSON.stringify(answer));
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return reply.code(503).send({ message: 'The shop cannot be reached just now.' });
    }
  });

  /**
   * Predictive search (ADR-046), as Shopify's: the products that could be what a shopper is
   * typing, the last word taken as cut short. `/search/suggest.json?q=` gives them as JSON;
   * `/search/suggest?q=&section_id=` renders that section of the theme's with them, as
   * `predictive_search`, for a script to show under a search box.
   */
  const suggest = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    const url = new URL(request.url, 'http://storefront');
    const json = url.pathname.endsWith('.json');
    const sectionId = url.searchParams.get('section_id') ?? '';
    if (!json && !SECTION_ID.test(sectionId)) {
      return notFound(reply, 'Ask for the section to render: ?section_id=');
    }
    const params = suggestParams(url.searchParams);
    const wanted = suggestWanted(params);
    const refuse = (status: number, message: string, description: string) => {
      reply.code(status).header('cache-control', 'no-store');
      return json
        ? reply.send({ status, message, description })
        : reply.type('text/plain; charset=utf-8').send(`${description}\n`);
    };
    try {
      let productIds: string[] = [];
      let more: ContentSearchResponse = { pageIds: [], articleIds: [] };
      // The shop's own pages and articles, when asked for (ADR-212).
      const content = params.terms === '' ? [] : contentTypes(params.types);
      if (wanted > 0 || content.length > 0) {
        if (!core) throw new StorefrontApiError(503, 'This storefront has no search');
        if (await searchedTooMuch(request)) {
          return await refuse(429, 'Too Many Requests', 'Too many searches. Please wait a moment.');
        }
        [productIds, more] = await Promise.all([
          wanted > 0
            ? core.search(found.shopId, params.terms, { prefix: 'last', limit: wanted })
            : [],
          content.length > 0
            ? core.searchContent(found.shopId, params.terms, {
                prefix: 'last',
                limit: params.limit,
                types: content,
              })
            : more,
        ]);
      }
      if (found.preview) previewed(reply);
      else reply.header('cache-control', SEARCH_CACHE).header('cache-tag', shopTag(found.shopId));
      if (json) {
        // In Urdu at its Urdu address, as its pages are (ADR-624).
        const urdu = url.pathname.startsWith('/ur/');
        const store = urdu ? new TranslatedStore(found.store, 'ur') : found.store;
        const [docs, pages, articles] = await Promise.all([
          store.products(productIds),
          store.pages(more.pageIds),
          store.articles(more.articleIds),
        ]);
        return await reply.send(
          suggestJson(
            params,
            suggestedProducts(docs, params),
            {
              pages: pages.filter((doc) => doc !== null),
              articles: articles.filter((doc) => doc !== null),
            },
            urdu ? '/ur' : '',
          ),
        );
      }
      const page: PageRequest = {
        path: '/search',
        query: Object.fromEntries(url.searchParams),
        locale: url.pathname.startsWith('/ur/') ? 'ur' : 'en',
        suggest: { params, productIds, pageIds: more.pageIds, articleIds: more.articleIds },
      };
      const rendered = await renderer.sections(
        { ...page, currency: found.currency },
        found.store,
        [sectionId],
        themeFor(found),
      );
      const html = rendered.get(sectionId);
      if (!html) return notFound(reply, 'The theme has no such section.');
      return await reply.type('text/html; charset=utf-8').send(html);
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return refuse(
        503,
        'Service Unavailable',
        'Search cannot be reached just now. Please try again in a minute.',
      );
    }
  };
  for (const path of ['/search/suggest', '/search/suggest.json']) {
    app.get(path, suggest);
    app.get(`/ur${path}`, suggest);
  }

  /**
   * Visual search (SRC-07, ADR-870): a shopper's photo, posted as JSON by the theme's search
   * section where the shop allows it, read by the core into a search. Answered with where that
   * search's page is, `{ "location": "/search?q=…" }`, or a message for the shopper; never kept.
   */
  const photoSearch = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'private, no-store');
    const found = await shopFor(request, reply);
    if (!found) return reply.code(404).send({ message: 'No shop answers at this address.' });
    const urdu = request.url.startsWith('/ur/');
    const locale = urdu ? 'ur' : 'en';
    const allowed = limiter
      ? await limiter.hit(PHOTO_SEARCHES, request.ip).then(
          (hit) => hit.allowed,
          () => true,
        )
      : true;
    if (!allowed) {
      return reply.code(429).send({ message: photoSearchMessage(locale, 'too_many') });
    }
    const photo = photoRequestOf(request.body);
    if (!photo) return reply.code(400).send({ message: photoSearchMessage(locale, 'invalid') });
    if (!core || found.preview) {
      return reply.code(503).send({ message: photoSearchMessage(locale, 'unavailable') });
    }
    try {
      const answer = await core.photoSearch(found.shopId, photo);
      if ('refused' in answer) {
        const status = answer.refused === 'too_many' ? 429 : 503;
        return await reply
          .code(status)
          .send({ message: photoSearchMessage(locale, answer.refused) });
      }
      const location = photoSearchLocation(answer, urdu ? '/ur' : '');
      return await reply.send(
        location ? { location } : { message: photoSearchMessage(locale, 'none') },
      );
    } catch (error) {
      if (error instanceof StoreMissingError) return reply.code(404).send();
      if (error instanceof StorefrontApiError && error.status === 400) {
        return reply.code(400).send({ message: photoSearchMessage(locale, 'invalid') });
      }
      if (!unreachable(request, error)) throw error;
      return reply.code(503).send({ message: photoSearchMessage(locale, 'unavailable') });
    }
  };
  for (const path of [PHOTO_SEARCH_PATH, `/ur${PHOTO_SEARCH_PATH}`]) {
    app.post(path, { bodyLimit: PHOTO_SEARCH_BODY_MAX }, photoSearch);
  }

  /**
   * Product recommendations (MKT-09, ADR-434), as Shopify's:
   * `/recommendations/products?product_id=&section_id=&limit=&intent=` renders that section of the
   * theme's with `recommendations`, the products related to the one named, for a script to show
   * on its page. Complementary products are asked for as Shopify's are, and none are found yet.
   */
  const recommendations = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    const url = new URL(request.url, 'http://storefront');
    const sectionId = url.searchParams.get('section_id') ?? '';
    const productId = url.searchParams.get('product_id') ?? '';
    if (!SECTION_ID.test(sectionId) || !PRODUCT_ID.test(productId)) {
      return notFound(
        reply,
        'Ask for a product and the section to render: ?product_id=&section_id=',
      );
    }
    const limit = Number(url.searchParams.get('limit') ?? RECOMMENDATIONS_LIMIT);
    try {
      // Rendered as the product's own page renders it, with the settings its template gives it.
      const [product] = await found.store.products([productId]);
      if (!product) return notFound(reply, 'The shop has no such product.');
      const page: PageRequest = {
        path: `/products/${product.handle}`,
        query: Object.fromEntries(url.searchParams),
        locale: url.pathname.startsWith('/ur/') ? 'ur' : 'en',
        recommendations: {
          productId,
          intent: url.searchParams.get('intent') === 'complementary' ? 'complementary' : 'related',
          limit:
            Number.isInteger(limit) && limit >= 1
              ? Math.min(limit, RECOMMENDATIONS_LIMIT)
              : RECOMMENDATIONS_LIMIT,
        },
      };
      const rendered = await renderer.sections(
        { ...page, currency: found.currency },
        found.store,
        [sectionId],
        themeFor(found),
      );
      const html = rendered.get(sectionId);
      if (!html) return notFound(reply, 'The theme has no such section.');
      if (found.preview) previewed(reply);
      else reply.header('cache-control', SEARCH_CACHE).header('cache-tag', shopTag(found.shopId));
      return await reply.type('text/html; charset=utf-8').send(html);
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      throw error;
    }
  };
  for (const path of ['/recommendations/products', '/ur/recommendations/products']) {
    app.get(path, recommendations);
  }

  /**
   * A closed shop's password page (ADR-054), in the theme's `password` template: the password it
   * is given, when right, leaves a pass in a cookie and sends the shopper in. An open shop, or a
   * shopper with the pass, is sent in; a preview shows the page, to design it.
   */
  const password = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    const urdu = request.url.startsWith('/ur/');
    const home = urdu ? '/ur' : '/';
    try {
      const lock = await lockOf(request, found);
      reply.header('cache-control', 'private, no-store');
      if (!found.preview && (!lock || lock.passed)) return await reply.redirect(home, 302);
      const page: PageRequest = {
        path: '/password',
        // How a form on it went, as its sign-up's says (ADR-446).
        query: Object.fromEntries(new URL(request.url, 'http://storefront').searchParams),
        locale: urdu ? 'ur' : 'en',
      };
      if (request.method === 'POST' && lock) {
        if (limiter && !(await limiter.hit(PASSWORD_TRIES, request.ip)).allowed) {
          return await reply
            .code(429)
            .type('text/plain; charset=utf-8')
            .send('Too many tries. Please wait a minute.\n');
        }
        const typed = paramsOf(request).password;
        const verifier = lock.password.verifier;
        // No password is longer: nothing longer is worth scrypt's time.
        const given = typeof typed === 'string' && typed.length <= PASSWORD_TYPED_MAX;
        if (given && (await checkPassword(typed, verifier))) {
          reply.header(
            'set-cookie',
            passwordCookie(passwordPass(found.shopId, verifier), { secure }),
          );
          return await reply.redirect(home, 303);
        }
        const wrong = { ...page, formErrors: { storefront_password: ['form'] } };
        return await sendPage(reply, wrong, found, 401);
      }
      return await sendPage(reply, page, found);
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      throw error;
    }
  };
  for (const path of ['/password', '/ur/password']) {
    app.route({ method: ['GET', 'POST'], url: path, handler: password });
  }

  /**
   * Shopify's contact form, which themes' contact pages post (ADR-589): the shopper's name, email
   * or mobile number, what they wrote and the form's other fields, all under `contact[…]`, sent on
   * to the core, which keeps them for the shop's staff. Then back to the page the form was on:
   * `contact_posted=true` says it was taken, for `form.posted_successfully?`, or `contact_error`
   * names the fields that were wrong, for `form.errors`.
   */
  const contactMessage = async (
    request: FastifyRequest,
    reply: FastifyReply,
    found: Found,
    params: Record<string, unknown>,
  ) => {
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      return reply
        .code(403)
        .type('text/plain; charset=utf-8')
        .send('Messages are sent from the shop itself.\n');
    }
    if (limiter && !(await limiter.hit(CONTACT_MESSAGES, request.ip)).allowed) {
      return reply
        .code(429)
        .type('text/plain; charset=utf-8')
        .send('Too many messages. Please wait a minute.\n');
    }
    const urdu = request.url.startsWith('/ur/');
    const from = returnTo(params) ?? refererPath(request) ?? (urdu ? '/ur' : '/');
    try {
      if (!core) throw new StorefrontApiError(503, 'This storefront keeps no messages');
      const own = new Set(['name', 'email', 'phone', 'body']);
      const fields: Record<string, string> = {};
      const given: Record<string, string> = {};
      for (const [name, value] of Object.entries(recordOf(params.contact))) {
        if (typeof value !== 'string') continue;
        if (own.has(name)) given[name] = value;
        else fields[name] = value;
      }
      const result = await core.contactMessage(found.shopId, {
        ...given,
        body: given.body ?? '',
        fields,
        page: new URL(from, 'http://storefront.invalid').pathname,
        language: urdu ? 'ur' : 'en',
        ip: request.ip,
        ...(request.headers['user-agent'] && { userAgent: request.headers['user-agent'] }),
      });
      const back = new URL(from, 'http://storefront.invalid');
      back.searchParams.delete('contact_posted');
      back.searchParams.delete('contact_error');
      if (result.ok) back.searchParams.set('contact_posted', 'true');
      else {
        const wrong = new Set(result.errors.map((error) => error.field));
        back.searchParams.set('contact_error', [...wrong].join(','));
      }
      return await reply.redirect(`${back.pathname}${back.search}${back.hash}`, 303);
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return reply
        .code(503)
        .type('text/plain; charset=utf-8')
        .send('The shop cannot be reached just now. Please try again in a minute.\n');
    }
  };

  /**
   * Shopify's customer form, which themes' newsletter sections post (ADR-189): the shopper's
   * mobile number, sent on to the core, which keeps it as their consent to the shop's news and
   * offers on WhatsApp. Then back to the page the form was on: `customer_posted=true` says it was
   * taken, for `form.posted_successfully?`, or `customer_error` names the fields that were wrong,
   * for `form.errors`. Shopify's contact form, which themes' contact pages post, goes to
   * {@link contactMessage}.
   */
  const contact = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    reply.header('cache-control', 'private, no-store');
    const params = paramsOf(request);
    if (params.form_type === 'contact') return contactMessage(request, reply, found, params);
    if (params.form_type !== 'customer') {
      return notFound(reply, 'This shop takes no messages here.');
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      return reply
        .code(403)
        .type('text/plain; charset=utf-8')
        .send('Sign-ups are made from the shop itself.\n');
    }
    if (limiter && !(await limiter.hit(SIGN_UPS, request.ip)).allowed) {
      return reply
        .code(429)
        .type('text/plain; charset=utf-8')
        .send('Too many sign-ups. Please wait a minute.\n');
    }
    try {
      if (!core) throw new StorefrontApiError(503, 'This storefront keeps no customers');
      const fields = recordOf(params.contact);
      const text = (name: string) => (typeof fields[name] === 'string' ? fields[name] : null);
      const tags = text('tags');
      const consent = text('consent');
      const result = await core.signUp(found.shopId, {
        phone: text('phone') ?? '',
        ...(tags !== null && { tags }),
        ...(consent !== null && { consent }),
      });
      const back = new URL(
        returnTo(params) ?? refererPath(request) ?? (request.url.startsWith('/ur/') ? '/ur' : '/'),
        'http://storefront.invalid',
      );
      back.searchParams.delete('customer_posted');
      back.searchParams.delete('customer_error');
      if (result.ok) back.searchParams.set('customer_posted', 'true');
      else {
        const wrong = new Set(result.errors.map((error) => error.field));
        back.searchParams.set('customer_error', [...wrong].join(','));
      }
      return await reply.redirect(`${back.pathname}${back.search}${back.hash}`, 303);
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return reply
        .code(503)
        .type('text/plain; charset=utf-8')
        .send('The shop cannot be reached just now. Please try again in a minute.\n');
    }
  };
  for (const path of ['/contact', '/ur/contact']) app.post(path, contact);

  /**
   * Shopify's localization form (OS-21, ADR-865): the currency the shopper picks of the shop's,
   * by `currency_code`, or by `country_code` as Shopify's country pickers post it, kept in their
   * cookie; rupees forget it. And the language, by `language_code`. Back to `return_to`.
   */
  const localization = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    reply.header('cache-control', 'private, no-store');
    const params = paramsOf(request);
    const asked = askedCurrency(params);
    if (asked === 'PKR') {
      reply.header('set-cookie', currencyCookie(null, { secure }));
    } else if (asked !== null) {
      // A currency the shop doesn't show its prices in is left as the shopper had it.
      const offered = (await found.store.shop()).currencies ?? [];
      if (offered.some((each) => each.currency === asked)) {
        reply.header('set-cookie', currencyCookie(asked, { secure }));
      }
    }
    let back = returnTo(params) ?? '/';
    const language = typeof params.language_code === 'string' ? params.language_code : null;
    if (language === 'ur' || language === 'en') {
      const path = back.replace(/^\/ur(?=\/|$|\?)/, '') || '/';
      back = language === 'ur' ? `/ur${path === '/' ? '' : path}` : path;
    }
    return reply.redirect(back, 303);
  };
  app.post('/localization', localization);

  /**
   * The currency the shopper's page is in and the one to suggest them, by the country the edge
   * says they are in, for the theme's script asking shoppers abroad to see prices in theirs.
   */
  app.get('/localization.json', async (request, reply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    const country = request.headers['cf-ipcountry'];
    const offered = (await found.store.shop()).currencies ?? [];
    return reply.header('cache-control', 'private, no-store').send({
      currency: found.currency ?? 'PKR',
      suggested:
        found.currency === null
          ? suggestedCurrency(typeof country === 'string' ? country : undefined, offered)
          : null,
      currencies: ['PKR', ...offered.map((each) => each.currency)],
    });
  });

  /**
   * Hatti's back_in_stock form, which Hatti Base shows on a sold-out variant's page (ADR-431):
   * the shopper's mobile number and the variant, sent on to the core, which keeps the wish while
   * the shop's automation is on. Then back to the page the form was on: `back_in_stock_posted=true`
   * says it was taken, for `form.posted_successfully?`, or `back_in_stock_error` names the fields
   * that were wrong, for `form.errors`.
   */
  const backInStock = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    reply.header('cache-control', 'private, no-store');
    const params = paramsOf(request);
    if (params.form_type !== 'back_in_stock') return notFound(reply, 'This page takes no form.');
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      return reply
        .code(403)
        .type('text/plain; charset=utf-8')
        .send('Back in stock messages are asked for from the shop itself.\n');
    }
    if (limiter && !(await limiter.hit(STOCK_WATCHES, request.ip)).allowed) {
      return reply
        .code(429)
        .type('text/plain; charset=utf-8')
        .send('Too many requests. Please wait a minute.\n');
    }
    try {
      if (!core) throw new StorefrontApiError(503, 'This storefront keeps no wishes');
      const fields = recordOf(params.contact);
      const text = (name: string) => (typeof fields[name] === 'string' ? fields[name] : '');
      const urdu = request.url.startsWith('/ur/');
      const result = await core.watchStock(found.shopId, {
        variantId: text('variant_id'),
        phone: text('phone'),
        language: urdu ? 'ur' : 'en',
      });
      const back = new URL(
        returnTo(params) ?? refererPath(request) ?? (urdu ? '/ur' : '/'),
        'http://storefront.invalid',
      );
      back.searchParams.delete('back_in_stock_posted');
      back.searchParams.delete('back_in_stock_error');
      if (result.ok) back.searchParams.set('back_in_stock_posted', 'true');
      else {
        const wrong = new Set(result.errors.map((error) => error.field));
        back.searchParams.set('back_in_stock_error', [...wrong].join(','));
      }
      return await reply.redirect(`${back.pathname}${back.search}${back.hash}`, 303);
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return reply
        .code(503)
        .type('text/plain; charset=utf-8')
        .send('The shop cannot be reached just now. Please try again in a minute.\n');
    }
  };
  for (const path of ['/back-in-stock', '/ur/back-in-stock']) app.post(path, backInStock);

  /**
   * Reporting the store to Hatti (TNS-01, ADR-460), from the link in Hatti Base's footer: Hatti's
   * page, not the shop's theme's, asking what is wrong, sent on to the core for Hatti's people,
   * then the report's number. The page it came from goes with it, and the shopper's address,
   * which the core keeps only hashed with the shop's.
   */
  const report = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    reply.header('cache-control', 'private, no-store');
    const urdu = request.url.startsWith('/ur/');
    const send = (page: RenderedPage, status = 200) =>
      reply
        .code(status)
        .header('content-security-policy', page.contentSecurityPolicy)
        .header('x-content-type-options', 'nosniff')
        .type('text/html; charset=utf-8')
        .send(page.html);
    try {
      const shopName = (await found.store.shop()).name;
      if (request.method !== 'POST') {
        const from = refererPath(request) ?? '';
        return await send(reportPage(shopName, { ...EMPTY_REPORT, from }, [], { urdu }));
      }
      if (request.headers['sec-fetch-site'] === 'cross-site') {
        return await reply
          .code(403)
          .type('text/plain; charset=utf-8')
          .send('Reports are made from the shop itself.\n');
      }
      if (limiter && !(await limiter.hit(REPORTS, request.ip)).allowed) {
        return await reply
          .code(429)
          .type('text/plain; charset=utf-8')
          .send('Too many reports. Please wait a minute.\n');
      }
      if (!core) throw new StorefrontApiError(503, 'This storefront takes no reports');
      const params = paramsOf(request);
      const text = (name: string) => (typeof params[name] === 'string' ? params[name] : '');
      const form = {
        reason: text('reason'),
        details: text('details'),
        phone: text('phone'),
        orderName: text('orderName'),
        from: localPath(text('from')) ?? '',
      };
      const origin = await originOf(request, found);
      const result = await core.report(found.shopId, {
        reason: form.reason,
        details: form.details,
        ...(form.phone && { phone: form.phone }),
        ...(form.orderName && { orderName: form.orderName }),
        ...(form.from && { pageUrl: `${origin}${form.from}` }),
        client: request.ip,
        language: urdu ? 'ur' : 'en',
      });
      if (!result.ok) return await send(reportPage(shopName, form, result.errors, { urdu }), 422);
      return await send(
        reportTakenPage(shopName, result.id, { back: form.from || (urdu ? '/ur' : '/') }),
      );
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return reply
        .code(503)
        .type('text/plain; charset=utf-8')
        .send('Hatti cannot be reached just now. Please try again in a minute.\n');
    }
  };
  for (const path of ['/report', '/ur/report']) {
    app.route({ method: ['GET', 'POST'], url: path, handler: report });
  }

  /**
   * A rights owner's complaint of the store's listings (TNS-04, ADR-474), from the report page:
   * Hatti's page, naming the listings by their addresses on this store, which the storefront finds
   * among its products, sent on to the core for Hatti's people, then the complaint's number.
   */
  const rights = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    reply.header('cache-control', 'private, no-store');
    const urdu = request.url.startsWith('/ur/');
    const send = (page: RenderedPage, status = 200) =>
      reply
        .code(status)
        .header('content-security-policy', page.contentSecurityPolicy)
        .header('x-content-type-options', 'nosniff')
        .type('text/html; charset=utf-8')
        .send(page.html);
    try {
      const shopName = (await found.store.shop()).name;
      if (request.method !== 'POST') {
        return await send(rightsPage(shopName, EMPTY_RIGHTS, [], { urdu }));
      }
      if (request.headers['sec-fetch-site'] === 'cross-site') {
        return await reply
          .code(403)
          .type('text/plain; charset=utf-8')
          .send('Complaints are made from the shop itself.\n');
      }
      if (limiter && !(await limiter.hit(REPORTS, request.ip)).allowed) {
        return await reply
          .code(429)
          .type('text/plain; charset=utf-8')
          .send('Too many complaints. Please wait a minute.\n');
      }
      if (!core) throw new StorefrontApiError(503, 'This storefront takes no complaints');
      const params = paramsOf(request);
      const text = (name: string) => (typeof params[name] === 'string' ? params[name] : '');
      const form = {
        kind: text('kind'),
        rightsOwner: text('rightsOwner'),
        registration: text('registration'),
        complainant: text('complainant'),
        actingAs: text('actingAs'),
        email: text('email'),
        phone: text('phone'),
        listings: text('listings').slice(0, 10_000),
        details: text('details'),
        sworn: params.sworn !== undefined && params.sworn !== '',
        signature: text('signature'),
      };
      const origin = await originOf(request, found);
      const hosts = [hostName(request.headers.host ?? ''), hostName(new URL(origin).host)];
      const addresses = listingAddresses(form.listings, hosts);
      const listings: { id: string; title: string; url: string }[] = [];
      let listingsWrong = addresses.wrong.length > 0 || addresses.found.length === 0;
      if (addresses.found.length > RIGHTS_LISTINGS_MAX) listingsWrong = true;
      else {
        for (const address of addresses.found) {
          const product = await found.store.productByHandle(address.handle);
          if (!product) listingsWrong = true;
          else if (!listings.some((each) => each.id === product.id)) {
            listings.push({
              id: product.id,
              title: product.title,
              url: `${origin}/products/${product.handle}`,
            });
          }
        }
      }
      const result = listingsWrong
        ? null
        : await core.complainOfRights(found.shopId, {
            kind: form.kind,
            rightsOwner: form.rightsOwner,
            ...(form.registration && { registration: form.registration }),
            complainant: form.complainant,
            actingAs: form.actingAs,
            email: form.email,
            ...(form.phone && { phone: form.phone }),
            listings,
            details: form.details,
            signature: form.signature,
            sworn: form.sworn,
            client: request.ip,
            language: urdu ? 'ur' : 'en',
          });
      if (!result || !result.ok) {
        const errors = [
          ...(listingsWrong ? [{ field: 'listings', message: 'Name listings on this store' }] : []),
          ...(result && !result.ok ? result.errors : []),
        ];
        return await send(rightsPage(shopName, form, errors, { urdu }), 422);
      }
      return await send(rightsTakenPage(shopName, result.id, { back: urdu ? '/ur' : '/' }));
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return reply
        .code(503)
        .type('text/plain; charset=utf-8')
        .send('Hatti cannot be reached just now. Please try again in a minute.\n');
    }
  };
  for (const path of ['/report/rights', '/ur/report/rights']) {
    app.route({ method: ['GET', 'POST'], url: path, handler: rights });
  }

  /**
   * Shopify's new_comment form, which themes' article pages post (ADR-220): the shopper's comment,
   * sent on to the core, which keeps it as the blog's policy says. Then back to the article, in
   * the page's language: `comment_posted=true` says it was taken, for
   * `form.posted_successfully?`, or `comment_error` names the fields that were wrong, for
   * `form.errors`.
   */
  const comment = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    reply.header('cache-control', 'private, no-store');
    const params = paramsOf(request);
    if (params.form_type !== 'new_comment') return notFound(reply, 'This page takes no form.');
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      return reply
        .code(403)
        .type('text/plain; charset=utf-8')
        .send('Comments are posted from the shop itself.\n');
    }
    if (limiter && !(await limiter.hit(COMMENTS, request.ip)).allowed) {
      return reply
        .code(429)
        .type('text/plain; charset=utf-8')
        .send('Too many comments. Please wait a minute.\n');
    }
    const { blog, article } = request.params as { blog: string; article: string };
    try {
      if (!core) throw new StorefrontApiError(503, 'This storefront keeps no comments');
      const fields = recordOf(params.comment);
      const text = (name: string) => (typeof fields[name] === 'string' ? fields[name] : '');
      const userAgent = request.headers['user-agent'];
      const result = await core.postComment(found.shopId, {
        blog,
        article,
        author: text('author'),
        email: text('email'),
        body: text('body'),
        ip: request.ip,
        ...(userAgent && { userAgent }),
      });
      const urdu = request.url.startsWith('/ur/');
      const back = new URLSearchParams();
      if (result.ok) back.set('comment_posted', 'true');
      else
        back.set(
          'comment_error',
          [...new Set(result.errors.map((error) => error.field))].join(','),
        );
      const path = `${urdu ? '/ur' : ''}/blogs/${encodeURIComponent(blog)}/${encodeURIComponent(article)}`;
      return await reply.redirect(
        `${path}?${back.toString()}#${result.ok ? 'comments' : 'comment_form'}`,
        303,
      );
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return reply
        .code(503)
        .type('text/plain; charset=utf-8')
        .send('The shop cannot be reached just now. Please try again in a minute.\n');
    }
  };
  for (const path of ['/blogs/:blog/:article/comments', '/ur/blogs/:blog/:article/comments']) {
    app.post(path, comment);
  }

  /** Whether cookies set for this request go over HTTPS alone: in production, or as it came. */
  const secureFor = (request: FastifyRequest) => secure || request.protocol === 'https';

  /**
   * An answer of the account's (ADR-571): the shopper's own, never kept, at the edge or in the
   * browser, and not for search engines.
   */
  const accountAnswer = (reply: FastifyReply) =>
    reply.header('cache-control', 'private, no-store').header('x-robots-tag', 'noindex');

  /** Forgets the shopper's session in their browser, and the sign of it pages' scripts read. */
  const signOutCookies = (request: FastifyRequest, reply: FastifyReply) => {
    const options = { secure: secureFor(request) };
    reply.header('set-cookie', [accountCookieCleared(options), signedInCookieCleared(options)]);
  };

  /** The account cannot be reached, as when the core restarts: said so, rather than failing. */
  const accountUnavailable = (reply: FastifyReply) =>
    reply
      .code(503)
      .type('text/plain; charset=utf-8')
      .send('Your account cannot be reached just now. Please try again in a minute.\n');

  /** The page's language, by its address: "/ur/account" is in Urdu. */
  const languageOf = (request: FastifyRequest) => {
    const urdu = request.url === '/ur' || request.url.startsWith('/ur/');
    return { locale: urdu ? 'ur' : 'en', prefix: urdu ? '/ur' : '' };
  };

  /** The sign-in page, its form as `login` leaves it. */
  const loginPage = (
    reply: FastifyReply,
    found: Found,
    locale: string,
    login: LoginForm,
    status?: number,
    asked?: FastifyRequest,
  ) => sendPage(reply, { path: '/account/login', locale, login }, found, status, asked);

  /** Sign-ins come from the shop's own pages, at most {@link ACCOUNT_LOGINS} a minute. */
  const loginTooMuch = async (request: FastifyRequest): Promise<boolean> =>
    limiter !== null && !(await limiter.hit(ACCOUNT_LOGINS, request.ip)).allowed;

  /**
   * Shopify's sign-in page, `/account/login` (CUS-02, ADR-571), in the theme's `customers/login`
   * template: its form asks for the shopper's mobile number, and posted, has the core send a code
   * to it, on WhatsApp unless they chose SMS, from their address, then asks for the code. The
   * number waits in a cookie only the server reads, for ten minutes, as the code does. A shopper
   * signed in already is sent to their account, or where the link asked.
   */
  const login = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    accountAnswer(reply);
    const { locale, prefix } = languageOf(request);
    const words = (key: string, values: Record<string, unknown>) =>
      translation(theme, locale, key, values);
    const phoneStep = (returnTo: string | null): LoginForm => ({
      step: 'phone',
      phone: '',
      phoneMasked: '',
      channel: 'whatsapp',
      errors: [],
      returnTo,
    });
    try {
      if (!core) throw new StorefrontApiError(503, 'This storefront keeps no accounts');
      if (request.method !== 'POST') {
        const query = Object.fromEntries(new URL(request.url, 'http://storefront').searchParams);
        const back = localPath(query.return_to);
        const token = accountTokenOf(request.headers.cookie);
        if (token) {
          if (await core.accountSession(found.shopId, token)) {
            return await reply.redirect(back ?? `${prefix}/account`, 302);
          }
          // Its session is over: the cookies that named it go.
          signOutCookies(request, reply);
        }
        return await loginPage(reply, found, locale, phoneStep(back), undefined, request);
      }
      if (request.headers['sec-fetch-site'] === 'cross-site') {
        return await reply
          .code(403)
          .type('text/plain; charset=utf-8')
          .send('Shoppers sign in from the shop itself.\n');
      }
      const params = paramsOf(request);
      const fields = recordOf(params.customer);
      const text = (name: string) => (typeof fields[name] === 'string' ? fields[name] : '');
      const form: LoginForm = {
        ...phoneStep(returnTo(params)),
        phone: text('phone').trim().slice(0, PHONE_TYPED_MAX),
        channel: text('channel') === 'sms' ? 'sms' : 'whatsapp',
      };
      const refused = (problem: LoginProblem, status: number) =>
        loginPage(
          reply,
          found,
          locale,
          { ...form, errors: [loginErrorMessage(problem, words)] },
          status,
        );
      if (await loginTooMuch(request)) return await refused('too_many_requests', 429);
      const started = await core.accountLoginStart(
        found.shopId,
        { phone: form.phone, channel: form.channel, locale },
        { ip: request.ip },
      );
      if (!started.ok) return await refused('invalid_phone', 422);
      if (started.state === 'too_many') return await refused('too_many_codes', 429);
      const pending = { phone: form.phone, masked: started.phone, channel: started.channel };
      reply.header('set-cookie', loginCookie(pending, { secure: secureFor(request) }));
      return await loginPage(reply, found, locale, {
        ...form,
        step: 'code',
        phone: '',
        phoneMasked: started.phone,
        channel: started.channel,
      });
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return accountUnavailable(reply);
    }
  };

  /**
   * The code a shopper typed (ADR-571), checked by the core against the last one sent to the
   * number their cookie keeps: right, the session's secret goes in its cookie, and they go on to
   * their account, or the path on the shop the form asked; wrong, the page asks again, saying
   * why; expired or tried too often, it asks for the number again, for a new code.
   */
  const verify = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    accountAnswer(reply);
    const { locale, prefix } = languageOf(request);
    const words = (key: string, values: Record<string, unknown>) =>
      translation(theme, locale, key, values);
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      return reply
        .code(403)
        .type('text/plain; charset=utf-8')
        .send('Shoppers sign in from the shop itself.\n');
    }
    const params = paramsOf(request);
    const fields = recordOf(params.customer);
    const code = (typeof fields.code === 'string' ? fields.code : '')
      .replace(/\s+/g, '')
      .slice(0, CODE_TYPED_MAX);
    const back = returnTo(params);
    const pending = pendingLoginOf(request.headers.cookie);
    const options = { secure: secureFor(request) };
    const said = (problem: LoginProblem) => [loginErrorMessage(problem, words)];
    const phoneStep = (problem: LoginProblem): LoginForm => ({
      step: 'phone',
      phone: pending?.phone ?? '',
      phoneMasked: '',
      channel: pending?.channel ?? 'whatsapp',
      errors: said(problem),
      returnTo: back,
    });
    try {
      if (!core) throw new StorefrontApiError(503, 'This storefront keeps no accounts');
      if (!pending) return await loginPage(reply, found, locale, phoneStep('expired'), 422);
      const codeStep = (problem: LoginProblem): LoginForm => ({
        step: 'code',
        phone: '',
        phoneMasked: pending.masked,
        channel: pending.channel,
        errors: said(problem),
        returnTo: back,
      });
      if (await loginTooMuch(request)) {
        return await loginPage(reply, found, locale, codeStep('too_many_requests'), 429);
      }
      const verified = await core.accountLoginVerify(found.shopId, { phone: pending.phone, code });
      if (verified.ok) {
        reply.header('set-cookie', [
          accountCookie(verified.token, options),
          signedInCookie(options),
          loginCookieCleared(options),
        ]);
        return await reply.redirect(back ?? `${prefix}/account`, 303);
      }
      if (verified.error === 'wrong') {
        return await loginPage(reply, found, locale, codeStep('wrong'), 422);
      }
      // A new code is needed, or the number was never one: it starts again.
      reply.header('set-cookie', loginCookieCleared(options));
      const status = verified.error === 'too_many' ? 429 : 422;
      return await loginPage(reply, found, locale, phoneStep(verified.error), status);
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return accountUnavailable(reply);
    }
  };

  /**
   * The account page, with what the shopper just asked of their own data said in the page's
   * language (ADR-572); without a session, on to sign in.
   */
  const accountPageOf = async (
    request: FastifyRequest,
    reply: FastifyReply,
    found: Found,
    notice: DataNotice | null,
    status?: number,
  ) => {
    const { locale, prefix } = languageOf(request);
    const token = accountTokenOf(request.headers.cookie);
    // With their address book, for `customer.default_address` (ADR-584).
    const [account, addresses] = token
      ? await Promise.all([
          core!.account(found.shopId, token),
          core!.accountAddresses(found.shopId, token),
        ])
      : [null, null];
    if (!account) {
      if (token) signOutCookies(request, reply);
      return reply.redirect(`${prefix}/account/login`, request.method === 'POST' ? 303 : 302);
    }
    const dataNotice = notice && {
      code: notice,
      message: dataNoticeMessage(notice, (key, values) => translation(theme, locale, key, values)),
    };
    const page = { path: '/account', locale, customer: account, addresses, dataNotice };
    return sendPage(reply, page, found, status, request.method === 'GET' ? request : undefined);
  };

  /**
   * The shopper's account, `/account` (ADR-571), in the theme's `customers/account` template,
   * with `customer`: their orders with the shop and their store credit, as the core reads them
   * for the session their cookie names, and what they just asked of their own data, as its
   * address says (ADR-572). Without one, they are sent to sign in.
   */
  const accountPage = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    accountAnswer(reply);
    try {
      if (!core) throw new StorefrontApiError(503, 'This storefront keeps no accounts');
      const query = Object.fromEntries(new URL(request.url, 'http://storefront').searchParams);
      return await accountPageOf(request, reply, found, dataNoticeOf(query.data_request));
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return accountUnavailable(reply);
    }
  };

  /**
   * One of the shopper's orders, from their account (ADR-571): on to its page, on the core's
   * address, as the core links it for their session; the shop's page not found for an order not
   * theirs, or with no page. Without a session, they sign in first and come back.
   */
  const accountOrder = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    accountAnswer(reply);
    const { locale, prefix } = languageOf(request);
    const { id } = request.params as { id: string };
    try {
      if (!core) throw new StorefrontApiError(503, 'This storefront keeps no accounts');
      const token = accountTokenOf(request.headers.cookie);
      if (!token) {
        const back = `${prefix}/account/orders/${encodeURIComponent(id)}`;
        const to = `${prefix}/account/login?${new URLSearchParams({ return_to: back })}`;
        return await reply.redirect(to, 302);
      }
      const link = id.length <= 64 ? await core.accountOrderLink(found.shopId, token, id) : null;
      if (!link) {
        const path = `/account/orders/${encodeURIComponent(id)}`;
        return await sendPage(reply, { path, locale }, found, 404);
      }
      return await reply.redirect(link.url, 303);
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return accountUnavailable(reply);
    }
  };

  /**
   * What a shopper asks of their own data from their account, posted (ADR-572): from the shop's
   * own pages alone, as signing in is, and at most {@link ACCOUNT_DATA_REQUESTS} a minute from an
   * address. With `confirmed`, it is asked only once the shopper ticked `customer[confirm]`,
   * saying they understand what it means. `ask` asks the core with the session's secret: null
   * without a session, which is sent to sign in; otherwise the notice for the account page to
   * say, which it comes back to.
   */
  const dataRequest =
    (
      ask: (shopId: string, token: string, locale: string) => Promise<DataNotice | null>,
      options: { confirmed: boolean },
    ) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const found = await shopFor(request, reply);
      if (!found) return notFound(reply, 'No shop answers at this address.');
      accountAnswer(reply);
      const { prefix, locale } = languageOf(request);
      if (request.headers['sec-fetch-site'] === 'cross-site') {
        return reply
          .code(403)
          .type('text/plain; charset=utf-8')
          .send("Shoppers ask for their data from the shop's own pages.\n");
      }
      try {
        if (!core) throw new StorefrontApiError(503, 'This storefront keeps no accounts');
        const token = accountTokenOf(request.headers.cookie);
        if (!token) return await reply.redirect(`${prefix}/account/login`, 303);
        if (limiter !== null && !(await limiter.hit(ACCOUNT_DATA_REQUESTS, request.ip)).allowed) {
          return await accountPageOf(request, reply, found, 'too_many_requests', 429);
        }
        if (options.confirmed && recordOf(paramsOf(request).customer).confirm !== '1') {
          return await accountPageOf(request, reply, found, 'erase_unconfirmed', 422);
        }
        const notice = await ask(found.shopId, token, locale);
        if (notice === null) {
          signOutCookies(request, reply);
          return await reply.redirect(`${prefix}/account/login`, 303);
        }
        const back = new URLSearchParams({ data_request: notice });
        return await reply.redirect(`${prefix}/account?${back.toString()}#your-data`, 303);
      } catch (error) {
        if (error instanceof StoreMissingError) {
          return notFound(reply, 'This shop is not open yet.');
        }
        if (!unreachable(request, error)) throw error;
        return accountUnavailable(reply);
      }
    };

  /** "Download my data" (ADR-572): the core makes the shopper's file, or gives the one kept. */
  const dataExport = dataRequest(
    async (shopId, token) => {
      const file = await core!.accountDataExport(shopId, token);
      if (!file) return null;
      return file.state === 'none' ? 'export_none' : 'export_ready';
    },
    { confirmed: false },
  );

  /**
   * "Delete my data" (ADR-572), once the shopper ticked that they understand: the core asks for
   * their erasure, as the shop's staff would for them.
   */
  const dataErase = dataRequest(
    // Told once it is done in the page's language (ADR-582).
    async (shopId, token, locale) => {
      const erasure = await core!.accountDataErase(shopId, token, locale);
      if (!erasure) return null;
      return erasure.state === 'none' ? 'erase_none' : 'erase_requested';
    },
    { confirmed: true },
  );

  /**
   * The shopper's file kept (ADR-572): on to storage, through a link the core signs for minutes,
   * made anew each time, so that the page never holds one. Without a file kept, back to the
   * account, saying so; without a session, to sign in first, and back.
   */
  const dataDownload = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    accountAnswer(reply);
    const { prefix } = languageOf(request);
    try {
      if (!core) throw new StorefrontApiError(503, 'This storefront keeps no accounts');
      const token = accountTokenOf(request.headers.cookie);
      if (!token) {
        const to = `${prefix}/account/login?${new URLSearchParams({ return_to: `${prefix}/account` })}`;
        return await reply.redirect(to, 302);
      }
      const file = await core.accountDataExportLink(found.shopId, token);
      if (!file) {
        const back = new URLSearchParams({ data_request: 'export_gone' });
        return await reply.redirect(`${prefix}/account?${back.toString()}#your-data`, 302);
      }
      return await reply.redirect(file.url, 303);
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return accountUnavailable(reply);
    }
  };

  /**
   * "Buy again" on one of the shopper's orders (ADR-574), posted from their account: what it sold
   * that can be had now goes in their cart, as many as it had, through the core's cart as
   * `/cart/add` puts things there, and on to the cart page, saying what could not. Posted only,
   * as it changes the cart: from the shop's own pages, as the account's other forms are, at most
   * {@link ACCOUNT_REORDERS} a minute from an address. Without a session, to sign in first; an
   * order not among those their account lists is the shop's page not found.
   */
  const reorder = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    accountAnswer(reply);
    const { locale, prefix } = languageOf(request);
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      return reply
        .code(403)
        .type('text/plain; charset=utf-8')
        .send("Shoppers buy again from the shop's own pages.\n");
    }
    const { id } = request.params as { id: string };
    const cartToken = cookieOf(request.headers.cookie, CART_COOKIE);
    try {
      if (!core) throw new StorefrontApiError(503, 'This storefront keeps no accounts');
      const token = accountTokenOf(request.headers.cookie);
      if (!token) return await reply.redirect(`${prefix}/account/login`, 303);
      if (limiter !== null && !(await limiter.hit(ACCOUNT_REORDERS, request.ip)).allowed) {
        const shown = cartToken
          ? await core.read(found.shopId, cartToken, accountTokenOf(request.headers.cookie))
          : null;
        const cartError = reorderNoticeMessage('too_many_requests', (key, values) =>
          translation(theme, locale, key, values),
        );
        return await sendPage(reply, { path: '/cart', locale, cart: shown, cartError }, found, 429);
      }
      const account = await core.account(found.shopId, token);
      if (!account) {
        signOutCookies(request, reply);
        return await reply.redirect(`${prefix}/account/login`, 303);
      }
      const order = account.orders.find((each) => each.id === id);
      if (!order) {
        const path = `/account/orders/${encodeURIComponent(id)}/reorder`;
        return await sendPage(reply, { path, locale }, found, 404);
      }
      const items = reorderItems(order.lines);
      // What the cart has of a variant, read only once it refuses more of it.
      let kept: Promise<CartJson | null> | null = null;
      const { added, short } = await addAgain(
        items,
        (left) =>
          core.act(
            found.shopId,
            cartToken,
            'add',
            { items: left },
            accountTokenOf(request.headers.cookie),
          ),
        async (variantId) => {
          kept ??= cartToken
            ? core.read(found.shopId, cartToken, accountTokenOf(request.headers.cookie))
            : Promise.resolve(null);
          const cart = await kept;
          return (cart?.items ?? [])
            .filter((item) => item.variantId === variantId)
            .reduce((sum, item) => sum + item.quantity, 0);
        },
      );
      if (added) {
        reply.header('set-cookie', cartCookies(added.token, added.cart.itemCount, { secure }));
        await counted(request, found, 'added_to_cart');
      }
      const left = order.lines.some((line) => !line.available || line.variantId === null);
      const notice = !added ? 'none' : short || left ? 'partial' : null;
      const onward = `${prefix}/cart${notice ? `?${new URLSearchParams({ reorder: notice })}` : ''}`;
      return await reply.redirect(onward, 303);
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return accountUnavailable(reply);
    }
  };

  /**
   * The shopper's wishlist kept with their account (ADR-575), for the theme's script, which keeps
   * it in the browser as well, the pages being the same for every shopper:
   * `GET /account/wishlist.json` reads it; `POST /account/wishlist` with `{ "handles": [...] }`,
   * the newest first, adds those products, as the browser's own list joins the account's once
   * signed in; `POST /account/wishlist/remove` with `{ "handle": "..." }` takes one off. Each
   * answers `{ "handles": [...] }`, the account's list as it is then, the newest first, of the
   * products the storefront shows; the core keeps them by the catalog's IDs. JSON alone, from the
   * shop's own pages alone, at most {@link ACCOUNT_WISHLISTS} a minute from an address, and never
   * kept. 401 without a session: a session that is over takes its cookies with it.
   */
  const wishlist =
    (change: 'read' | 'add' | 'remove') => async (request: FastifyRequest, reply: FastifyReply) => {
      const found = await shopFor(request, reply);
      if (!found) return notFound(reply, 'No shop answers at this address.');
      accountAnswer(reply);
      const refuse = (status: number, message: string) => reply.code(status).send({ message });
      if (!fromShopItself(request)) {
        return refuse(403, "Wishlists are kept from the shop's own pages.");
      }
      if (change !== 'read' && !isJson(request)) return refuse(415, 'Send JSON.');
      const body = paramsOf(request);
      const asked = change === 'add' ? handlesOf(body.handles) : null;
      const handle = change === 'remove' ? handlesOf([body.handle])?.[0] : null;
      if ((change === 'add' && !asked) || (change === 'remove' && !handle)) {
        return refuse(
          422,
          change === 'add'
            ? `Send { "handles": [...] }: at most ${ACCOUNT_WISHLIST_MAX} products' handles.`
            : 'Send { "handle": "..." }: the handle of the product to take off.',
        );
      }
      try {
        if (!core) throw new StorefrontApiError(503, 'This storefront keeps no accounts');
        const token = accountTokenOf(request.headers.cookie);
        if (!token) return await refuse(401, 'Sign in to keep your wishlist with your account.');
        if (limiter !== null && !(await limiter.hit(ACCOUNT_WISHLISTS, request.ip)).allowed) {
          return await refuse(429, 'Too many changes to your wishlist. Please wait a moment.');
        }
        const { shopId, store } = found;
        let productIds: string[] | null;
        if (asked) {
          const products = await Promise.all(asked.map((each) => store.productByHandle(each)));
          productIds = await core.accountWishlistAdd(
            shopId,
            token,
            products.flatMap((product) => (product ? [product.id] : [])),
          );
        } else if (handle) {
          // A product the storefront no longer shows is in the list no longer either.
          const product = await store.productByHandle(handle);
          productIds = product
            ? await core.accountWishlistRemove(shopId, token, product.id)
            : await core.accountWishlist(shopId, token);
        } else {
          productIds = await core.accountWishlist(shopId, token);
        }
        if (!productIds) {
          signOutCookies(request, reply);
          return await refuse(401, 'Sign in to keep your wishlist with your account.');
        }
        const products = await store.products(productIds);
        return await reply.send({
          handles: products.flatMap((product) => (product ? [product.handle] : [])),
        });
      } catch (error) {
        if (error instanceof StoreMissingError) {
          return notFound(reply, 'This shop is not open yet.');
        }
        if (!unreachable(request, error)) throw error;
        return refuse(
          503,
          'Your wishlist cannot be reached just now. Please try again in a minute.',
        );
      }
    };

  /**
   * Spin to win (OS-08, ADR-900), for the theme's sign-up pop-up: `GET /spin.json` answers the
   * shop's wheel, `{ "slices": [{ "label" }] }`, to draw; `POST /spin` with `{ "phone",
   * "consent" }` signs the shopper up and answers where the wheel stops, `{ "slice", "label",
   * "code", "endsAt", "again" }`, or 422 with `{ "errors": [{ "field", "message" }] }`. 404 while
   * the shop has no wheel turned on. JSON alone, from the shop's own pages alone, at most
   * {@link SPINS} spins a minute from an address, never kept.
   */
  const spin =
    (action: 'wheel' | 'spin') => async (request: FastifyRequest, reply: FastifyReply) => {
      const found = await shopFor(request, reply);
      if (!found) return notFound(reply, 'No shop answers at this address.');
      accountAnswer(reply);
      const refuse = (status: number, message: string) => reply.code(status).send({ message });
      if (!fromShopItself(request))
        return refuse(403, "Wheels are spun from the shop's own pages.");
      if (action === 'spin' && !isJson(request)) return refuse(415, 'Send JSON.');
      if (
        action === 'spin' &&
        limiter !== null &&
        !(await limiter.hit(SPINS, request.ip)).allowed
      ) {
        return refuse(429, 'Too many spins. Please wait a minute.');
      }
      const body = paramsOf(request);
      const text = (name: string) => (typeof body[name] === 'string' ? body[name] : null);
      try {
        if (!core) throw new StorefrontApiError(503, 'This storefront keeps no wheels');
        if (action === 'wheel') {
          const wheel = await core.spinWheel(found.shopId);
          return wheel ? await reply.send(wheel) : await refuse(404, 'No wheel here.');
        }
        const consent = text('consent');
        const result = await core.spin(found.shopId, {
          phone: text('phone') ?? '',
          ...(consent !== null && { consent }),
        });
        if (!result) return await refuse(404, 'No wheel here.');
        if (!result.ok) return await reply.code(422).send({ errors: result.errors });
        return await reply.send({
          slice: result.slice,
          label: result.label,
          code: result.code,
          endsAt: result.endsAt,
          again: result.again,
        });
      } catch (error) {
        if (error instanceof StoreMissingError)
          return notFound(reply, 'This shop is not open yet.');
        if (!unreachable(request, error)) throw error;
        return refuse(503, 'The shop cannot be reached just now. Please try again in a minute.');
      }
    };

  /**
   * The chat on the shop's pages (MSG-10, ADR-811), for the theme's script: `POST /chat` with
   * `{ "name", "phone", "body" }` starts one, keeping its session in a cookie of its own;
   * `POST /chat/messages` with `{ "body" }` writes in it; `GET /chat/messages.json` reads it. Each
   * answers `{ "messages": [{ "from": "shopper" | "shop", "body", "at" }] }`, the oldest first, or
   * 422 with `{ "errors": [{ "field", "message" }] }`; 404 while the shop's chat is off or for no
   * session, whose cookie goes. JSON alone, from the shop's own pages alone, at most
   * {@link CHAT_WRITES} writes and {@link CHAT_READS} reads a minute from an address, never kept.
   */
  const chat =
    (action: 'start' | 'write' | 'read') =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const found = await shopFor(request, reply);
      if (!found) return notFound(reply, 'No shop answers at this address.');
      accountAnswer(reply);
      const refuse = (status: number, message: string) => reply.code(status).send({ message });
      if (!fromShopItself(request))
        return refuse(403, "Chats are written from the shop's own pages.");
      if (action !== 'read' && !isJson(request)) return refuse(415, 'Send JSON.');
      const limit = action === 'read' ? CHAT_READS : CHAT_WRITES;
      if (limiter !== null && !(await limiter.hit(limit, request.ip)).allowed) {
        return refuse(429, 'Too many messages. Please wait a minute.');
      }
      const options = { secure: secureFor(request) };
      const body = paramsOf(request);
      const text = (name: string) => (typeof body[name] === 'string' ? body[name] : '');
      try {
        if (!core) throw new StorefrontApiError(503, 'This storefront keeps no chats');
        const token = chatTokenOf(request.headers.cookie);
        if (action !== 'start' && !token) return await refuse(404, 'No chat yet.');
        const result =
          action === 'start'
            ? await core.webChatStart(found.shopId, {
                name: text('name'),
                phone: text('phone'),
                body: text('body'),
              })
            : action === 'write'
              ? await core.webChatWrite(found.shopId, { token: token!, body: text('body') })
              : await core.webChatRead(found.shopId, token!);
        if (!result) {
          if (token) reply.header('set-cookie', chatCookieCleared(options));
          return await refuse(404, 'No chat here.');
        }
        if (!result.ok) return await reply.code(422).send({ errors: result.errors });
        if (result.token) reply.header('set-cookie', chatCookie(result.token, options));
        return await reply.send({ messages: chatMessagesJson(result.messages) });
      } catch (error) {
        if (error instanceof StoreMissingError)
          return notFound(reply, 'This shop is not open yet.');
        if (!unreachable(request, error)) throw error;
        return refuse(503, 'The shop cannot be reached just now. Please try again in a minute.');
      }
    };

  /**
   * A signed-in shopper's own prices (CUS-06, ADR-781), for the theme's script, the product pages
   * being the same for every shopper: `GET /account/prices.json?variants=…`, at most
   * {@link ACCOUNT_PRICES_MAX} variants' IDs by commas, answers `{ "prices": { id: { "amount",
   * "formatted" } } }`, the variants their price lists make lower, in paisa and as `money` writes
   * them. From the shop's own pages alone, at most {@link ACCOUNT_PRICES} a minute from an
   * address, and never kept. 401 without a session: a session that is over takes its cookies.
   */
  const accountPrices = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    accountAnswer(reply);
    const refuse = (status: number, message: string) => reply.code(status).send({ message });
    if (!fromShopItself(request)) return refuse(403, "Prices are read from the shop's own pages.");
    const asked = new URL(request.url, 'http://storefront').searchParams.get('variants') ?? '';
    const ids = [...new Set(asked.split(',').map((each) => each.trim()))];
    if (ids.length > ACCOUNT_PRICES_MAX || !ids.every((each) => VARIANT_ID.test(each))) {
      return refuse(422, `Ask of at most ${ACCOUNT_PRICES_MAX} variants' IDs, by commas.`);
    }
    try {
      if (!core) throw new StorefrontApiError(503, 'This storefront keeps no accounts');
      const token = accountTokenOf(request.headers.cookie);
      if (!token) return await refuse(401, 'Sign in to see your own prices.');
      if (limiter !== null && !(await limiter.hit(ACCOUNT_PRICES, request.ip)).allowed) {
        return await refuse(429, 'Too many requests. Please wait a moment.');
      }
      const prices = await core.accountPrices(found.shopId, token, ids);
      if (!prices) {
        signOutCookies(request, reply);
        return await refuse(401, 'Sign in to see your own prices.');
      }
      return await reply.send({
        prices: Object.fromEntries(
          Object.entries(prices).map(([id, amount]) => [
            id,
            { amount, formatted: formatMoney(money(BigInt(amount), 'PKR')) },
          ]),
        ),
      });
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return refuse(503, 'Your prices cannot be reached just now. Please try again in a minute.');
    }
  };

  /**
   * The address book's page (ADR-584), `/account/addresses`, in the theme's `customers/addresses`
   * template: `customer` with `customer.addresses`, the default first, and `form` showing again
   * an address that was just posted and refused. Without a session, on to sign in, and back.
   */
  const addressesPageOf = async (
    request: FastifyRequest,
    reply: FastifyReply,
    found: Found,
    form: AddressForm | null,
    status?: number,
  ) => {
    const { locale, prefix } = languageOf(request);
    const token = accountTokenOf(request.headers.cookie);
    const [account, addresses] = token
      ? await Promise.all([
          core!.account(found.shopId, token),
          core!.accountAddresses(found.shopId, token),
        ])
      : [null, null];
    if (!account || !addresses) {
      if (token) signOutCookies(request, reply);
      const back = `${prefix}/account/addresses`;
      const to = `${prefix}/account/login?${new URLSearchParams({ return_to: back })}`;
      return reply.redirect(to, request.method === 'POST' ? 303 : 302);
    }
    // A form for an address no longer in the book comes back as a new one's, to keep what was
    // typed.
    const shown =
      form && form.id !== null && !addresses.some((each) => each.id === form.id)
        ? { ...form, id: null }
        : form;
    const page = {
      path: '/account/addresses',
      locale,
      customer: account,
      addresses,
      addressForm: shown,
    };
    return sendPage(reply, page, found, status, request.method === 'GET' ? request : undefined);
  };

  const addressesPage = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    accountAnswer(reply);
    try {
      if (!core) throw new StorefrontApiError(503, 'This storefront keeps no accounts');
      return await addressesPageOf(request, reply, found, null);
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return accountUnavailable(reply);
    }
  };

  /**
   * An address of the shopper's book, posted from its page (ADR-584), as Shopify's forms post
   * them: to `/account/addresses` for a new one, or to the address's own `url` to change it, or,
   * with `_method=delete`, to take it out. From the shop's own pages alone, at most
   * {@link ACCOUNT_ADDRESS_CHANGES} a minute from an address. Done, back to the book; refused,
   * the book's page again, saying what was wrong beside what was typed. Without a session, to
   * sign in first.
   */
  const addressChange = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    accountAnswer(reply);
    const { locale, prefix } = languageOf(request);
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      return reply
        .code(403)
        .type('text/plain; charset=utf-8')
        .send("Shoppers change their addresses from the shop's own pages.\n");
    }
    const { id = null } = request.params as { id?: string };
    const body = paramsOf(request);
    const words = (key: string, values: Record<string, unknown>) =>
      translation(theme, locale, key, values);
    try {
      if (!core) throw new StorefrontApiError(503, 'This storefront keeps no accounts');
      const token = accountTokenOf(request.headers.cookie);
      if (!token) return await reply.redirect(`${prefix}/account/login`, 303);
      const { request: address, values } = addressRequestOf(recordOf(body.address));
      if (limiter !== null && !(await limiter.hit(ACCOUNT_ADDRESS_CHANGES, request.ip)).allowed) {
        const errors = [
          translation(theme, locale, 'customer.addresses.errors.too_many_requests', {}) ??
            'Too many changes. Please wait a minute and try again.',
        ];
        return await addressesPageOf(request, reply, found, { id, values, errors }, 429);
      }
      const back = `${prefix}/account/addresses`;
      if (id !== null && body._method === 'delete') {
        const left = await core.accountAddressDelete(found.shopId, token, id.slice(0, 64));
        if (!left) {
          signOutCookies(request, reply);
          return await reply.redirect(`${prefix}/account/login`, 303);
        }
        return await reply.redirect(back, 303);
      }
      const saved = await core.accountAddressSave(
        found.shopId,
        token,
        address,
        id === null ? undefined : id.slice(0, 64),
      );
      if (!saved) {
        signOutCookies(request, reply);
        return await reply.redirect(`${prefix}/account/login`, 303);
      }
      if (saved.ok) return await reply.redirect(back, 303);
      // Whether the book is full, for an error that names no field to say so.
      const book = await core.accountAddresses(found.shopId, token);
      const errors = addressErrorMessages(
        saved.errors,
        { full: (book?.length ?? 0) >= ACCOUNT_ADDRESSES_MAX },
        words,
      );
      return await addressesPageOf(request, reply, found, { id, values, errors }, 422);
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return accountUnavailable(reply);
    }
  };

  /**
   * Signing out (ADR-571): the core ends the session the cookie names, and the cookie goes; then
   * the shop's home page. Shopify's themes link to it, so a GET signs out as a POST does.
   */
  const logout = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    accountAnswer(reply);
    const { prefix } = languageOf(request);
    // A HEAD request, as a link checker's, only looks.
    if (request.method === 'HEAD') return reply.redirect(prefix || '/', 302);
    const token = accountTokenOf(request.headers.cookie);
    try {
      if (token && core) await core.accountLogout(found.shopId, token);
    } catch (error) {
      // The cookie goes all the same: the session ends unused, as sessions do.
      if (!unreachable(request, error)) throw error;
    }
    signOutCookies(request, reply);
    return reply.redirect(prefix || '/', request.method === 'POST' ? 303 : 302);
  };

  for (const prefix of ['', '/ur']) {
    app.get(`${prefix}/account`, accountPage);
    app.route({ method: ['GET', 'POST'], url: `${prefix}/account/login`, handler: login });
    app.post(`${prefix}/account/login/verify`, verify);
    app.get(`${prefix}/account/orders/:id`, accountOrder);
    app.post(`${prefix}/account/orders/:id/reorder`, reorder);
    app.post(`${prefix}/account/data/export`, dataExport);
    app.get(`${prefix}/account/data/export`, dataDownload);
    app.post(`${prefix}/account/data/erase`, dataErase);
    app.get(`${prefix}/account/wishlist.json`, wishlist('read'));
    app.get(`${prefix}/account/prices.json`, accountPrices);
    app.post(`${prefix}/account/wishlist`, wishlist('add'));
    app.post(`${prefix}/account/wishlist/remove`, wishlist('remove'));
    app.get(`${prefix}/account/addresses`, addressesPage);
    app.post(`${prefix}/account/addresses`, addressChange);
    app.post(`${prefix}/account/addresses/:id`, addressChange);
    app.route({ method: ['GET', 'POST'], url: `${prefix}/account/logout`, handler: logout });
  }
  /**
   * Notifications from the shop (OS-14, ADR-833), for the platform's script: `POST /push/subscribe`
   * with the browser's subscription, `{ "endpoint", "p256dh", "auth", "locale" }`, turns them on,
   * answered 204, or 422 with `{ "errors": [{ "field", "message" }] }` for a subscription that is
   * none; `POST /push/unsubscribe` with `{ "endpoint" }` turns them off. 404 while Hatti pushes
   * nothing. JSON alone, from the shop's own pages alone, at most {@link PUSH_CHANGES} a minute
   * from an address, never kept.
   */
  const pushChange =
    (action: 'subscribe' | 'unsubscribe') =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const found = await shopFor(request, reply);
      if (!found) return notFound(reply, 'No shop answers at this address.');
      accountAnswer(reply);
      const refuse = (status: number, message: string) => reply.code(status).send({ message });
      if (!fromShopItself(request)) {
        return refuse(403, "Notifications are turned on from the shop's own pages.");
      }
      if (!isJson(request)) return refuse(415, 'Send JSON.');
      if (limiter !== null && !(await limiter.hit(PUSH_CHANGES, request.ip)).allowed) {
        return refuse(429, 'Too many changes. Please wait a minute.');
      }
      const body = paramsOf(request);
      const text = (name: string) => (typeof body[name] === 'string' ? body[name] : '');
      try {
        if (!core) throw new StorefrontApiError(503, 'This storefront pushes nothing');
        if (action === 'unsubscribe') {
          await core.pushUnsubscribe(found.shopId, text('endpoint'));
          return await reply.code(204).send();
        }
        const result = await core.pushSubscribe(found.shopId, {
          endpoint: text('endpoint'),
          p256dh: text('p256dh'),
          auth: text('auth'),
          locale: text('locale') === 'ur' ? 'ur' : 'en',
        });
        if (!result) return await refuse(404, 'This shop sends no notifications.');
        if (!result.ok) return await reply.code(422).send({ errors: result.errors });
        return await reply.code(204).send();
      } catch (error) {
        if (error instanceof StoreMissingError)
          return notFound(reply, 'This shop is not open yet.');
        if (!unreachable(request, error)) throw error;
        return refuse(503, 'Notifications cannot be turned on just now. Please try again soon.');
      }
    };
  app.post(PUSH_PATHS.subscribe, pushChange('subscribe'));
  app.post(PUSH_PATHS.unsubscribe, pushChange('unsubscribe'));

  // The chat on the shop's pages, the same whatever the page's language (ADR-811).
  app.get('/spin.json', spin('wheel'));
  app.post('/spin', spin('spin'));
  app.post('/chat', chat('start'));
  app.post('/chat/messages', chat('write'));
  app.get('/chat/messages.json', chat('read'));

  app.get('/*', async (request, reply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    const url = new URL(request.url, 'http://storefront');
    const urdu = url.pathname === '/ur' || url.pathname.startsWith('/ur/');
    const path = urdu ? url.pathname.slice(3) || '/' : url.pathname;
    try {
      if (asksForSections(url)) {
        // With the shopper's cart, as a drawer shows it: cookies naming no cart go.
        const token = cookieOf(request.headers.cookie, CART_COOKIE);
        const shown =
          token && core
            ? await core.read(found.shopId, token, accountTokenOf(request.headers.cookie))
            : null;
        if (token && core && !shown) {
          reply.header('set-cookie', cartCookies(null, 0, { secure }));
        }
        return await sendSections(reply, found, url, shown);
      }
      const query = Object.fromEntries(url.searchParams);
      return await sendPage(
        reply,
        { path, query, params: [...url.searchParams], locale: urdu ? 'ur' : 'en' },
        found,
        undefined,
        request,
      );
    } catch (error) {
      // Named in the directory, but its documents are gone: it is being published again.
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return reply
        .code(503)
        .header('cache-control', 'no-store')
        .type('text/plain; charset=utf-8')
        .send('Your cart cannot be reached just now. Please try again in a minute.\n');
    }
  });

  return app;
}

/** What a search finds, as Shopify's search `type` names them, in the order it lists them. */
const SEARCH_TYPES = ['product', 'page', 'article'] as const;

/** The kinds a search finds: those Shopify's `type` names, else all of them (ADR-212). */
function searchTypes(asked: string | undefined): string[] {
  const named = (asked ?? '').split(',').map((each) => each.trim());
  const types = SEARCH_TYPES.filter((type) => named.includes(type));
  return types.length > 0 ? types : [...SEARCH_TYPES];
}

/** Of `types`, those the shop's own content holds, its pages and articles, in their order. */
function contentTypes(types: readonly string[]): ContentType[] {
  return types.filter((type): type is ContentType =>
    (CONTENT_TYPES as readonly string[]).includes(type),
  );
}

/**
 * The cart as `/cart.js` gives it, with its lines' products; at `/ur/cart.js`, in Urdu as its
 * pages are (ADR-625); in the currency the shopper picked, `asked`, where the shop shows its
 * prices in it (ADR-924).
 */
async function ajax(
  cart: CartJson | null,
  store: StoreData,
  urdu = false,
  asked: string | null = null,
): Promise<Record<string, unknown>> {
  const shown = urdu ? new TranslatedStore(store, 'ur') : store;
  const currency = asked ? shownCurrencyOf((await store.shop()).currencies, asked) : null;
  return ajaxCart(
    cart,
    await cartProducts(cart, (ids) => shown.products(ids)),
    urdu ? '/ur' : '',
    currency,
  );
}

/** Shopify's Ajax cart error. */
function ajaxError(status: number, description: string) {
  return { status, message: 'Cart Error', description };
}

/** The text fields of a posted form. */
function textFields(params: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function tooMany(reply: FastifyReply) {
  return reply
    .code(429)
    .type('text/plain; charset=utf-8')
    .send('Too many changes to the cart. Please wait a moment.\n');
}

function unavailable(reply: FastifyReply) {
  return reply
    .code(503)
    .type('text/plain; charset=utf-8')
    .send('Checkout cannot be reached just now. Please try again in a minute.\n');
}

/** Scripts ask for JSON where forms would be sent back to a page. */
function fromScript(request: FastifyRequest): boolean {
  const accept = String(request.headers.accept ?? '');
  return (
    request.headers['x-requested-with'] === 'XMLHttpRequest' ||
    (/application\/(json|javascript)/.test(accept) && !/text\/html/.test(accept))
  );
}

function paramsOf(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/** A request's host as the directory has it: lowercase, without a port or a final dot. */
function hostName(host: string): string {
  return host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

/** Whether a request asks for sections of a page rather than the page. */
function asksForSections(url: URL): boolean {
  return url.searchParams.has('section_id') || url.searchParams.has('sections');
}

/**
 * The sections a request asks for, as Shopify's `sections`: a list, or IDs with commas between
 * them; the first {@link SECTIONS_MAX} that could be IDs.
 */
function sectionIdsOf(value: unknown): string[] {
  const asked = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const ids = asked.flatMap((id: unknown) =>
    typeof id === 'string' && SECTION_ID.test(id.trim()) ? [id.trim()] : [],
  );
  return [...new Set(ids)].slice(0, SECTIONS_MAX);
}

/**
 * The page a cart change's sections render as part of: `sections_url`, a path on the shop; else
 * the page of the shop's that asked; else the home page.
 */
function sectionsPage(params: Record<string, unknown>, request: FastifyRequest): URL {
  const base = 'http://storefront';
  const asked = localPath(params.sections_url);
  if (asked !== null) return new URL(asked, base);
  try {
    const from = new URL(request.headers.referer ?? '');
    if (from.host === request.headers.host) return new URL(`${from.pathname}${from.search}`, base);
  } catch {
    // No page asked, or not an address.
  }
  return new URL('/', base);
}

/** Where a form asked to go afterwards: a path on the shop's own storefront, or nowhere. */
function returnTo(params: Record<string, unknown>): string | null {
  return localPath(params.return_to);
}

/** The page of the shop's own a form was posted from, as its browser says; null if it doesn't. */
function refererPath(request: FastifyRequest): string | null {
  try {
    const from = new URL(request.headers.referer ?? '');
    if (from.host === request.headers.host) return localPath(`${from.pathname}${from.search}`);
  } catch {
    // No page said, or not an address.
  }
  return null;
}

/**
 * Whether a script's request came from the shop's own pages, as its browser says: neither from
 * another site, nor from another address on the same site, such as another shop's on the
 * platform's domain. A browser that says nothing of either is let through, as forms' are.
 */
function fromShopItself(request: FastifyRequest): boolean {
  const site = request.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

/** Whether a request's body is JSON, which another site's form cannot send. */
function isJson(request: FastifyRequest): boolean {
  return /^application\/json\s*(;|$)/i.test(request.headers['content-type'] ?? '');
}

/**
 * The handles a wishlist's script sent, each once, in their order: at most
 * {@link ACCOUNT_WISHLIST_MAX}, each a handle a product could have. Null for anything else.
 */
function handlesOf(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > ACCOUNT_WISHLIST_MAX) return null;
  const handles: string[] = [];
  for (const each of value) {
    if (typeof each !== 'string' || each === '' || each.length > HANDLE_MAX) return null;
    if (!handles.includes(each)) handles.push(each);
  }
  return handles;
}

/** A posted form's nested fields, such as Shopify's `contact[...]`; none when it has none. */
function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * A path on the shop's own storefront, as a browser will follow it from a `Location`; null for
 * anything else. Links bring paths from anywhere, so nothing that leaves the shop passes, such as
 * `//elsewhere.example`, or `/\t/elsewhere.example`, which a browser drops the tab of and reads
 * the same. Letters a header cannot carry come back percent-encoded.
 */
export function localPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/')) return null;
  const base = 'http://storefront.invalid';
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }
  // `/..//elsewhere.example` stays on the shop as a URL, but not as a path in a `Location`.
  if (url.origin !== base || url.pathname.startsWith('//')) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The core could not be reached, as when it restarts. */
function isNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException &&
      (error.name === 'TimeoutError' || error.name === 'AbortError'))
  );
}

function notFound(reply: FastifyReply, message: string) {
  return reply
    .code(404)
    .header('cache-control', 'no-store')
    .type('text/plain; charset=utf-8')
    .send(`${message}\n`);
}

/**
 * A page's cache tags (ADR-047): the shop's, and those of the documents it names; with the path a
 * 404 page or a redirect was answered at, its tag, for a redirect from it to change (ADR-052).
 */
function cacheTags(shopId: string, named: readonly NamedDocument[], path: string | null): string {
  return [
    shopTag(shopId),
    ...named.map(({ kind, handle }) => handleTag(shopId, kind, handle)),
    ...(path === null ? [] : [pathTag(shopId, path)]),
  ].join(',');
}

/** The most redirects followed past the first in one hop (ADR-617). */
const CHAIN_HOPS = 5;

/** The prefix of the pages in Urdu (04 §5). */
const URDU_PREFIX = /^\/ur(?=[/?#]|$)/;

/**
 * Where a URL redirect sends a shopper (ADR-052): its target, in the shopper's language when it is
 * a path on the shop, with the query of the address asked for when the target has none, as for a
 * campaign's link, but a preview's token. Characters beyond ASCII are percent-encoded, as a header
 * carries them.
 */
export function redirectedTo(target: string, urdu: boolean, asked: string): string {
  let to = target;
  if (urdu && to.startsWith('/') && !URDU_PREFIX.test(to)) {
    to = to === '/' || /^\/[?#]/.test(to) ? `/ur${to.slice(1)}` : `/ur${to}`;
  }
  const query = (/\?([^#]*)/.exec(asked)?.[1] ?? '')
    .split('&')
    .filter((pair) => pair !== '' && !/^preview(=|$)/.test(pair))
    .join('&');
  if (query !== '' && !to.includes('?')) {
    const hash = to.indexOf('#');
    to = hash === -1 ? `${to}?${query}` : `${to.slice(0, hash)}?${query}${to.slice(hash)}`;
  }
  return to.replace(/[^\x21-\x7e]+/gu, (chars) => encodeURIComponent(chars));
}
