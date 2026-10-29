import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { collectMetrics } from '@hatti/telemetry/testing';
import { fileURLToPath } from 'node:url';
import {
  BuildQueue,
  MemoryStore,
  ShopDirectory,
  StorefrontActivity,
  StorefrontKeys,
  StorefrontSearches,
  StorefrontVitals,
  localDay,
  pathTag,
  summarize,
  type ProductDoc,
  type ShopDoc,
  type StoreData,
  type StoreDocuments,
  type ThemeDoc,
} from '@hatti/storefront-data';
import {
  ACCOUNT_ADDRESSES_MAX,
  PRODUCT_FEED_PATH,
  StorefrontApiError,
  type AccountAddress,
  type AccountAddressRequest,
  type AccountClient,
  type AccountDataEraseResponse,
  type AccountDataExportJson,
  type AccountDataExportResponse,
  type AccountJson,
  type AccountLoginStartRequest,
  type AccountLoginStartResult,
  type AccountLoginVerifyRequest,
  type AccountLoginVerifyResult,
  type AccountOrderLinkResponse,
  type AccountSessionJson,
  type CartActionName,
  type CartActionResult,
  type CartBodies,
  type CartError,
  type CartJson,
  type CheckoutClient,
  type CheckoutPageResponse,
  type PaymentLinkOpenResponse,
  type TrackingPageResponse,
  type TrackingRequest,
  type ContentSearchOptions,
  type ContentSearchResponse,
  type PhotoSearchRefusal,
  type PhotoSearchRequest,
  type PhotoSearchResponse,
  type SearchOptions,
  type CommentRequest,
  type CommentResult,
  type ContactMessageRequest,
  type ContactMessageResult,
  type PushSubscribeRequest,
  type PushSubscribeResult,
  type WebChatResult,
  type SignUpRequest,
  type SignUpResult,
  type SpinResult,
  type SpinWheelResponse,
  type ReportRequest,
  type ReportResult,
  type RightsComplaintRequest,
  type StockWatchRequest,
  type StockWatchResult,
  type StorefrontVisit,
  type ThemeImage,
  type ThemePreviewResponse,
} from '@hatti/storefront-api';
import type { InjectOptions } from 'fastify';
import { Redis } from 'ioredis';
import { Parser } from 'liquidjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { passwordVerifier } from '@hatti/crypto';
import { sampleStore } from './fixtures.js';
import { linkKey } from './link-page.js';
import { shortNameOf } from './pwa.js';
import { PageRenderer } from './render.js';
import {
  createStorefrontServer,
  handleOf,
  localPath,
  redirectedTo,
  ShopResolver,
  ShopThemes,
  type StorefrontServerOptions,
} from './server.js';
import { loadTheme, platformTheme, readThemeDir, type Theme } from '@hatti/themes';

// Before the servers that record them are made.
const recorded = collectMetrics();

const redisUrl = process.env.REDIS_URL;
if (!redisUrl && process.env.CI) throw new Error('REDIS_URL must be set in CI');

const THEME_DIR = fileURLToPath(new URL('../../../themes/hatti-base', import.meta.url));

/** A home page of a banner with `heading`, as a shop would save it. */
const bannerHome = (heading: string) =>
  JSON.stringify({
    sections: {
      banner: {
        type: 'image-banner',
        blocks: { heading: { type: 'heading', settings: { heading } } },
        block_order: ['heading'],
      },
    },
    order: ['banner'],
  });

describe('Finding the shop a host names', () => {
  it('reads the handle from a subdomain of the platform', () => {
    expect(handleOf('zari.hatti.pk', 'hatti.pk')).toBe('zari');
    expect(handleOf('Zari.Hatti.pk:443', 'hatti.pk')).toBe('zari');
    expect(handleOf('zari-fashions.localhost:4100', 'localhost')).toBe('zari-fashions');
    expect(handleOf('zari.hatti.pk.', 'hatti.pk')).toBe('zari');
    // The platform's own domain, and hosts that are no shop's subdomain.
    expect(handleOf('hatti.pk', 'hatti.pk')).toBeNull();
    expect(handleOf('localhost:4100', 'localhost')).toBeNull();
    for (const host of ['zari.com', 'www.zari.hatti.pk', 'xn--zari.hatti.pk', '-zari.hatti.pk']) {
      expect(handleOf(host, 'hatti.pk'), host).toBeUndefined();
    }
    expect(handleOf('evilhatti.pk', 'hatti.pk')).toBeUndefined();
  });

  it('remembers what the directory says for a few seconds', async () => {
    const asked: string[] = [];
    const shops = new ShopResolver(
      {
        find: async (handle: string) => {
          asked.push(handle);
          return handle === 'zari' ? 'shop-1' : null;
        },
      },
      60_000,
      2,
    );
    expect(await shops.find('zari')).toBe('shop-1');
    expect(await shops.find('zari')).toBe('shop-1');
    expect(await shops.find('nobody')).toBeNull();
    expect(await shops.find('nobody')).toBeNull();
    expect(asked).toEqual(['zari', 'nobody']);
    // It keeps two answers: a third handle pushes out the oldest.
    await shops.find('bazaar');
    await shops.find('zari');
    expect(asked).toEqual(['zari', 'nobody', 'bazaar', 'zari']);
  });
});

describe('Where forms and links may send shoppers', () => {
  it('sends them only along paths on the shop, as browsers read them', () => {
    expect(localPath('/collections/lawn?sort_by=price#grid')).toBe(
      '/collections/lawn?sort_by=price#grid',
    );
    expect(localPath('/collections/عید')).toBe('/collections/%D8%B9%DB%8C%D8%AF');
    // A browser drops a tab, reads a backslash as a slash, and `//` as another host.
    const tab = String.fromCharCode(9);
    const away = [
      '//evil.example',
      `/${tab}/evil.example`,
      '/\\evil.example',
      '/..//evil.example',
      'https://evil.example/',
      'evil.example',
      '',
      null,
    ];
    for (const path of away) expect(localPath(path), String(path)).toBeNull();
  });
});

describe("Where a shop's redirects send shoppers", () => {
  it("keeps the shopper's language and query, and writes the address as a header carries it", () => {
    expect(redirectedTo('/products/lawn', false, '/products/old?utm_source=fb')).toBe(
      '/products/lawn?utm_source=fb',
    );
    // The target's own query wins; a fragment stays last.
    expect(redirectedTo('/collections/eid?sort_by=price', false, '/x?page=2')).toBe(
      '/collections/eid?sort_by=price',
    );
    expect(redirectedTo('/pages/faq#delivery', false, '/x?a=1')).toBe('/pages/faq?a=1#delivery');
    expect(redirectedTo('/', true, '/ur/x')).toBe('/ur');
    expect(redirectedTo('/?a=1', true, '/ur/x')).toBe('/ur?a=1');
    expect(redirectedTo('/pages/faq', true, '/ur/x')).toBe('/ur/pages/faq');
    // A target in Urdu already, or elsewhere, as it is.
    expect(redirectedTo('/ur/pages/faq', true, '/ur/x')).toBe('/ur/pages/faq');
    expect(redirectedTo('/urdu-poetry', true, '/ur/x')).toBe('/ur/urdu-poetry');
    expect(redirectedTo('https://zari.pk/شلوار', true, '/ur/x?')).toBe(
      'https://zari.pk/%D8%B4%D9%84%D9%88%D8%A7%D8%B1',
    );
    // A preview's token stays on the shop; nothing a header cannot carry gets into one.
    expect(redirectedTo('https://instagram.com/zari', false, '/x?preview=abc&utm_source=fb')).toBe(
      'https://instagram.com/zari?utm_source=fb',
    );
    expect(redirectedTo('/pages/faq', false, '/x?preview')).toBe('/pages/faq');
    const [cr, lf] = [String.fromCharCode(13), String.fromCharCode(10)];
    expect(redirectedTo(`/pages/faq${cr}${lf}set-cookie:x`, false, '/x')).toBe(
      '/pages/faq%0D%0Aset-cookie:x',
    );
  });
});

describe('Starting a storefront', () => {
  it('renders the sample pages before it listens, so the first pages served parse nothing', async () => {
    const theme = loadTheme(await readThemeDir(THEME_DIR));
    const renderer = new PageRenderer(theme, { limits: { timeMs: 10_000 } });
    const app = createStorefrontServer({
      theme,
      renderer,
      domain: 'localhost',
      sample: new MemoryStore(sampleStore()),
    });
    // Templates and snippets alike, each parsed by a Parser of its own.
    const parse = vi.spyOn(Parser.prototype, 'parse');
    await app.ready();
    const atStart = parse.mock.calls.length;
    expect(atStart).toBeGreaterThan(0);
    const product = sampleStore().products[5]!.handle;
    for (const url of ['/', '/ur/', '/collections/khussa', `/products/${product}`, '/cart']) {
      const page = await app.inject({ method: 'GET', url, headers: { host: 'localhost' } });
      expect(page.statusCode, url).toBe(200);
    }
    expect(parse.mock.calls.length).toBe(atStart);
    parse.mockRestore();
    await app.close();
  });

  it("answers Kubernetes' probes at any host, Valkey's answering or not (ADR-724)", async () => {
    const theme = loadTheme(await readThemeDir(THEME_DIR));
    const renderer = new PageRenderer(theme, { limits: { timeMs: 10_000 } });
    // Nothing listens on port 1: each ask fails at once.
    const down = new Redis('redis://127.0.0.1:1', {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
    });
    const shops = new Map<string, Redis | undefined>([
      ['none', undefined],
      ['down', down],
    ]);
    if (redisUrl) shops.set('up', new Redis(redisUrl, { lazyConnect: true }));
    for (const [kind, redis] of shops) {
      const app = createStorefrontServer({ theme, renderer, domain: 'hatti.test', redis });
      // A pod's address, as the kubelet asks it, and a shop's.
      for (const host of ['10.0.3.7:4100', 'zari.hatti.test']) {
        const live = await app.inject({ method: 'GET', url: '/healthz', headers: { host } });
        expect(live.statusCode, `${kind} ${host}`).toBe(200);
        expect(live.json()).toEqual({ status: 'ok' });
        expect(live.headers['cache-control']).toBe('no-store');
        const ready = await app.inject({ method: 'GET', url: '/readyz?x=1', headers: { host } });
        expect(ready.statusCode, `${kind} ${host}`).toBe(kind === 'down' ? 503 : 200);
        expect(ready.json().status).toBe(kind === 'down' ? 'unavailable' : 'ok');
      }
      await app.close();
      redis?.disconnect();
    }
  });
});

describe("Shops' themes", () => {
  let base: Theme;
  beforeAll(async () => {
    base = loadTheme(await readThemeDir(THEME_DIR));
  });

  /** A shop's store, holding `doc` as its theme, counting how often it is fetched. */
  const holding = (doc: ThemeDoc | null) => {
    const store = {
      doc,
      fetched: 0,
      theme: async () => {
        store.fetched += 1;
        return store.doc;
      },
    };
    return store;
  };
  const shopWith = (theme: ShopDoc['theme']): ShopDoc => ({ ...sampleStore().shop, theme });
  const doc = (version: number, heading: string): ThemeDoc => ({
    id: 'thm-1',
    version,
    base: 'hatti-base',
    files: { 'templates/index.json': bannerHome(heading) },
  });
  const home = (theme: Theme) => theme.files['templates/index.json'];

  it('lays a theme over the platform theme once per version, for pages at once and after', async () => {
    const themes = new ShopThemes(base);
    const store = holding(doc(1, 'One'));
    const data = store as unknown as StoreData;
    const [first, second] = await Promise.all([
      themes.for('s1', shopWith({ id: 'thm-1', version: 1 }), data),
      themes.for('s1', shopWith({ id: 'thm-1', version: 1 }), data),
    ]);
    expect(second).toBe(first);
    expect(await themes.for('s1', shopWith({ id: 'thm-1', version: 1 }), data)).toBe(first);
    expect(home(first)).toBe(bannerHome('One'));
    expect(store.fetched).toBe(1);
    // No theme, or documents from before shops had them: the platform theme, fetching nothing.
    expect(await themes.for('s1', shopWith(null), data)).toBe(base);
    const { theme: _, ...older } = shopWith(null);
    expect(await themes.for('s1', older as ShopDoc, data)).toBe(base);
    expect(store.fetched).toBe(1);

    // The shop's document names version 2 before its theme's is written: version 1 shows, but is
    // not kept as version 2.
    const early = await themes.for('s1', shopWith({ id: 'thm-1', version: 2 }), data);
    expect(home(early)).toBe(bannerHome('One'));
    store.doc = doc(2, 'Two');
    const next = await themes.for('s1', shopWith({ id: 'thm-1', version: 2 }), data);
    expect(home(next)).toBe(bannerHome('Two'));
    await themes.for('s1', shopWith({ id: 'thm-1', version: 2 }), data);
    expect(store.fetched).toBe(3);
  });

  it('lays each theme over the platform theme it is built on, Hatti Base for one unknown (ADR-730)', async () => {
    const lawn = await platformTheme('lawn');
    const themes = new ShopThemes(base, {
      platform: new Map([
        ['hatti-base', base],
        ['lawn', lawn],
      ]),
    });
    const on = (name: string) => holding({ ...doc(1, 'One'), base: name }) as unknown as StoreData;
    const shop = shopWith({ id: 'thm-1', version: 1 });
    const dressed = await themes.for('s1', shop, on('lawn'));
    expect(home(dressed)).toBe(bannerHome('One'));
    expect(dressed.files['snippets/theme-style.liquid']).toBe(
      lawn.files['snippets/theme-style.liquid'],
    );
    expect(dressed.settings).toMatchObject({ color_accent: '#9D174D' });
    // A theme the storefront does not know, from a newer core: on Hatti Base, never failing.
    const unknown = await themes.for('s2', shop, on('zevar'));
    expect(unknown.files['snippets/theme-style.liquid']).toBe(
      base.files['snippets/theme-style.liquid'],
    );
    expect(unknown.settings).toMatchObject({ color_accent: '#0F766E' });
  });

  it('keeps themes up to a size, letting the least recently used go first', async () => {
    const size = bannerHome('Shop 1').length;
    const themes = new ShopThemes(base, { maxBytes: size * 2 });
    const stores = new Map(['s1', 's2', 's3'].map((id) => [id, holding(doc(1, `Shop ${id[1]}`))]));
    const show = (shopId: string) =>
      themes.for(shopId, shopWith({ id: 'thm-1', version: 1 }), stores.get(shopId) as never);
    await show('s1');
    await show('s2');
    await show('s1');
    await show('s3');
    // s2 was used least recently: making room for s3 let it go.
    await show('s1');
    await show('s2');
    expect([...stores.values()].map((store) => store.fetched)).toEqual([1, 2, 1]);
  });
});

/**
 * Carts as the core would keep them, as far as a test needs: each action recorded, and answered
 * with `answer`'s cart, kept under its token.
 */
class FakeCore {
  readonly actions: { token: string | null; action: CartActionName; body: unknown }[] = [];
  readonly kept = new Map<string, CartJson>();
  answer: (action: CartActionName) => CartActionResult | Error = () => new Error('No answer');
  /** The carts checkouts were started for, with the visits passed, and the pages asked for. */
  readonly started: (string | null)[] = [];
  readonly visits: StorefrontVisit[][] = [];
  readonly pages: {
    token: string;
    form: Record<string, string> | null;
    client?: CheckoutClient;
    prefill?: Record<string, string>;
    account?: string;
  }[] = [];
  page: CheckoutPageResponse | Error = new Error('No page');

  async read(_shopId: string, token: string | null): Promise<CartJson | null> {
    return (token && this.kept.get(token)) || null;
  }

  async act<A extends CartActionName>(
    _shopId: string,
    token: string | null,
    action: A,
    body: CartBodies[A],
  ): Promise<CartActionResult> {
    this.actions.push({ token, action, body });
    const answer = this.answer(action);
    if (answer instanceof Error) throw answer;
    if (answer.ok && answer.token) this.kept.set(answer.token, answer.cart);
    return answer;
  }

  /** A checkout for a cart with something in it; EMPTY otherwise. */
  async startCheckout(
    _shopId: string,
    token: string | null,
    visits: StorefrontVisit[] = [],
  ): Promise<{ ok: true; path: string; url: string } | { ok: false; error: CartError }> {
    this.started.push(token);
    this.visits.push(visits);
    const cart = token ? this.kept.get(token) : undefined;
    return cart && cart.itemCount > 0
      ? { ok: true, path: '/checkouts/c-secret', url: 'http://core.test/checkouts/c-secret' }
      : { ok: false, error: { code: 'EMPTY' } };
  }

  /** The payment links opened, by token, with the visits; what opening one comes to. */
  readonly links: { token: string; visits: StorefrontVisit[] }[] = [];
  link: PaymentLinkOpenResponse | Error = {
    path: '/checkouts/l-secret',
    url: 'http://core.test/checkouts/l-secret',
  };

  async openPaymentLink(
    _shopId: string,
    token: string,
    visits: StorefrontVisit[] = [],
  ): Promise<PaymentLinkOpenResponse> {
    this.links.push({ token, visits });
    if (this.link instanceof Error) throw this.link;
    return this.link;
  }

  /** The tracking lookups asked for, and the page the core answers with. */
  readonly lookups: (TrackingRequest | null)[] = [];
  tracking: TrackingPageResponse = {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    html: '<h1>Track your order</h1>',
  };

  async trackingPage(_shopId: string, form: TrackingRequest | null): Promise<TrackingPageResponse> {
    this.lookups.push(form);
    return this.tracking;
  }

  async checkoutPage(
    _shopId: string,
    token: string,
    form: Record<string, string> | null,
    client?: CheckoutClient,
    account?: string | null,
    prefill?: Record<string, string>,
  ): Promise<CheckoutPageResponse> {
    this.pages.push({
      token,
      form,
      ...(client && { client }),
      ...(account && { account }),
      ...(prefill && Object.keys(prefill).length > 0 && { prefill }),
    });
    if (this.page instanceof Error) throw this.page;
    return this.page;
  }

  /** The names and numbers shoppers typed at checkout, as the page's script sent them. */
  readonly contacts: { token: string; name: string; phone: string }[] = [];

  async checkoutContact(
    _shopId: string,
    token: string,
    contact: { name: string; phone: string },
  ): Promise<void> {
    this.contacts.push({ token, ...contact });
  }

  /** The searches asked for, and what they find. */
  readonly searches: { shopId: string; terms: string; options: SearchOptions }[] = [];
  found: string[] | Error = [];

  async search(shopId: string, terms: string, options: SearchOptions = {}): Promise<string[]> {
    this.searches.push({ shopId, terms, options });
    if (this.found instanceof Error) throw this.found;
    return this.found.slice(0, options.limit);
  }

  /** The photos sent to be read into searches (ADR-870), and what they were read into. */
  readonly photos: { shopId: string; request: PhotoSearchRequest }[] = [];
  photoRead: PhotoSearchResponse | { refused: PhotoSearchRefusal } | Error = {
    query: null,
    productIds: [],
  };

  async photoSearch(
    shopId: string,
    request: PhotoSearchRequest,
  ): Promise<PhotoSearchResponse | { refused: PhotoSearchRefusal }> {
    this.photos.push({ shopId, request });
    if (this.photoRead instanceof Error) throw this.photoRead;
    return this.photoRead;
  }

  /** The searches of the shop's pages and articles asked for, and what they find (ADR-212). */
  readonly contentSearches: { shopId: string; terms: string; options: ContentSearchOptions }[] = [];
  foundContent: ContentSearchResponse = { pageIds: [], articleIds: [] };

  async searchContent(
    shopId: string,
    terms: string,
    options: ContentSearchOptions = {},
  ): Promise<ContentSearchResponse> {
    this.contentSearches.push({ shopId, terms, options });
    const types = options.types ?? ['page', 'article'];
    return {
      pageIds: types.includes('page') ? this.foundContent.pageIds.slice(0, options.limit) : [],
      articleIds: types.includes('article')
        ? this.foundContent.articleIds.slice(0, options.limit)
        : [],
    };
  }

  /** Preview links' tokens, and the themes they show; the tokens asked about. */
  readonly previews = new Map<string, ThemePreviewResponse>();
  readonly previewsAsked: string[] = [];

  async themePreview(_shopId: string, token: string): Promise<ThemePreviewResponse | null> {
    this.previewsAsked.push(token);
    return this.previews.get(token) ?? null;
  }

  /**
   * Pictures shops' themes show, by shop and file, and those of a shop's a preview may show
   * besides; what was asked.
   */
  readonly themeImages = new Map<string, ThemeImage>();
  readonly otherImages = new Map<string, ThemeImage>();
  readonly themeImagesAsked: {
    shopId: string;
    file: string;
    preview: boolean;
    width?: number | null;
    accept?: string;
  }[] = [];

  async themeImage(
    shopId: string,
    file: string,
    preview: boolean,
    asked: { width?: number | null; accept?: string } = {},
  ): Promise<ThemeImage | null> {
    this.themeImagesAsked.push({
      shopId,
      file,
      preview,
      ...(asked.width && { width: asked.width }),
      ...(asked.accept && { accept: asked.accept }),
    });
    const key = `${shopId} ${file}`;
    return this.themeImages.get(key) ?? (preview ? (this.otherImages.get(key) ?? null) : null);
  }

  /** The sign-ups sent on, and how the core answers them. */
  readonly signUps: { shopId: string; request: SignUpRequest }[] = [];
  signedUp: SignUpResult | Error = { ok: true, created: true, subscribed: true };

  async signUp(shopId: string, request: SignUpRequest): Promise<SignUpResult> {
    this.signUps.push({ shopId, request });
    if (this.signedUp instanceof Error) throw this.signedUp;
    return this.signedUp;
  }

  /** The spins sent on, and the shop's wheel (ADR-900). */
  readonly spins: { shopId: string; request: object }[] = [];
  wheel: SpinWheelResponse | null = { slices: [{ label: '10% off' }, { label: 'Next time' }] };
  spun: SpinResult | null = {
    ok: true,
    slice: 0,
    label: '10% off',
    code: 'SPIN-ABCD2345',
    endsAt: '2026-11-03T09:00:00.000Z',
    again: false,
  };

  async spinWheel(): Promise<SpinWheelResponse | null> {
    return this.wheel;
  }

  async spin(shopId: string, request: object): Promise<SpinResult | null> {
    this.spins.push({ shopId, request });
    return this.spun;
  }

  /** The contact form's messages sent on, and how the core answers them (ADR-589). */
  readonly contactMessages: { shopId: string; request: ContactMessageRequest }[] = [];
  messaged: ContactMessageResult | Error = { ok: true, id: 'cform_7Kq2xY' };

  /** The chats the storefront sent on, and what the core says back (ADR-811). */
  readonly chats: { shopId: string; action: string; request: object }[] = [];
  chatting: WebChatResult = {
    ok: true,
    token: 'T'.repeat(43),
    messages: [
      { id: 'cmsg_1', direction: 'inbound', body: 'Salam', at: '2026-10-27T09:00:00.000Z' },
    ],
  };

  async webChatStart(shopId: string, request: object): Promise<WebChatResult> {
    this.chats.push({ shopId, action: 'start', request });
    return this.chatting;
  }

  async webChatWrite(shopId: string, request: object): Promise<WebChatResult> {
    this.chats.push({ shopId, action: 'write', request });
    return this.chatting && this.chatting.ok
      ? { ...this.chatting, token: undefined }
      : this.chatting;
  }

  async webChatRead(shopId: string, token: string): Promise<WebChatResult> {
    this.chats.push({ shopId, action: 'read', request: { token } });
    return this.chatting && this.chatting.ok
      ? { ...this.chatting, token: undefined }
      : this.chatting;
  }

  /** The push subscriptions the storefront passed on, and what the core says back (ADR-833). */
  readonly pushes: { shopId: string; action: string; request: object }[] = [];
  pushing: PushSubscribeResult = { ok: true };

  async pushSubscribe(shopId: string, request: PushSubscribeRequest): Promise<PushSubscribeResult> {
    this.pushes.push({ shopId, action: 'subscribe', request });
    return this.pushing;
  }

  async pushUnsubscribe(shopId: string, endpoint: string): Promise<void> {
    this.pushes.push({ shopId, action: 'unsubscribe', request: { endpoint } });
  }

  async contactMessage(
    shopId: string,
    request: ContactMessageRequest,
  ): Promise<ContactMessageResult> {
    this.contactMessages.push({ shopId, request });
    if (this.messaged instanceof Error) throw this.messaged;
    return this.messaged;
  }

  /** The wishes to hear a variant is back sent on, and how the core answers them (ADR-431). */
  readonly stockWatches: { shopId: string; request: StockWatchRequest }[] = [];
  watched: StockWatchResult | Error = { ok: true, created: true };

  async watchStock(shopId: string, request: StockWatchRequest): Promise<StockWatchResult> {
    this.stockWatches.push({ shopId, request });
    if (this.watched instanceof Error) throw this.watched;
    return this.watched;
  }

  /** The reports of the store sent on, and how the core answers them (ADR-460). */
  readonly reports: { shopId: string; request: ReportRequest }[] = [];
  reported: ReportResult | Error = { ok: true, id: 'rpt_7Kq2xY' };

  async report(shopId: string, request: ReportRequest): Promise<ReportResult> {
    this.reports.push({ shopId, request });
    if (this.reported instanceof Error) throw this.reported;
    return this.reported;
  }

  /** The rights complaints sent on, and how the core answers them (ADR-474). */
  readonly complaints: { shopId: string; request: RightsComplaintRequest }[] = [];
  complained: ReportResult | Error = { ok: true, id: 'ipc_3Rt9Lm' };

  async complainOfRights(shopId: string, request: RightsComplaintRequest): Promise<ReportResult> {
    this.complaints.push({ shopId, request });
    if (this.complained instanceof Error) throw this.complained;
    return this.complained;
  }

  /** The comments sent on, and how the core answers them (ADR-220). */
  readonly comments: { shopId: string; request: CommentRequest }[] = [];
  commented: CommentResult | Error = { ok: true, status: 'pending' };

  async postComment(shopId: string, request: CommentRequest): Promise<CommentResult> {
    this.comments.push({ shopId, request });
    if (this.commented instanceof Error) throw this.commented;
    return this.commented;
  }

  /** The codes asked for to sign in, with the address, and how the core answers (ADR-570). */
  readonly loginStarts: {
    shopId: string;
    request: AccountLoginStartRequest;
    client?: AccountClient;
  }[] = [];
  loginStarted: AccountLoginStartResult | Error = {
    ok: true,
    state: 'sent',
    phone: '0300 ••••567',
    channel: 'whatsapp',
  };

  async accountLoginStart(
    shopId: string,
    request: AccountLoginStartRequest,
    client?: AccountClient,
  ): Promise<AccountLoginStartResult> {
    this.loginStarts.push({ shopId, request, ...(client && { client }) });
    if (this.loginStarted instanceof Error) throw this.loginStarted;
    return this.loginStarted;
  }

  /** The codes typed, and how the core answers: signed in to the account `accounts` has. */
  readonly loginVerifies: { shopId: string; request: AccountLoginVerifyRequest }[] = [];
  loginVerified: AccountLoginVerifyResult | Error = new Error('No answer');

  async accountLoginVerify(
    shopId: string,
    request: AccountLoginVerifyRequest,
  ): Promise<AccountLoginVerifyResult> {
    this.loginVerifies.push({ shopId, request });
    if (this.loginVerified instanceof Error) throw this.loginVerified;
    return this.loginVerified;
  }

  /** Accounts by their session's secret; orders' pages by order; the sessions signed out. */
  readonly accounts = new Map<string, AccountJson>();
  readonly orderLinks = new Map<string, AccountOrderLinkResponse>();
  readonly signedOut: string[] = [];

  async accountSession(_shopId: string, token: string | null): Promise<AccountSessionJson | null> {
    const account = token ? this.accounts.get(token) : undefined;
    if (!account) return null;
    const now = new Date();
    return {
      phone: account.phone,
      name: account.name,
      signedInAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
    };
  }

  async account(_shopId: string, token: string | null): Promise<AccountJson | null> {
    return (token && this.accounts.get(token)) || null;
  }

  async accountOrderLink(
    _shopId: string,
    token: string | null,
    orderId: string,
  ): Promise<AccountOrderLinkResponse | null> {
    if (!token || !this.accounts.has(token)) return null;
    return this.orderLinks.get(orderId) ?? null;
  }

  async accountLogout(_shopId: string, token: string | null): Promise<void> {
    if (!token) return;
    this.signedOut.push(token);
    this.accounts.delete(token);
  }

  /**
   * What shoppers asked of their own data (ADR-572), by the session's secret; the files kept, and
   * how their erasure waits once asked for.
   */
  readonly dataAsked: ['export' | 'link' | 'erase', string][] = [];
  /** The languages erasures were asked in, to tell the shopper in once done (ADR-582). */
  readonly eraseLocales: (string | undefined)[] = [];
  readonly dataFiles = new Map<string, AccountDataExportJson>();
  erasure: AccountDataEraseResponse = {
    state: 'waiting',
    requestedAt: '2026-10-19T10:00:00.000Z',
    eraseAfter: '2026-10-29T10:00:00.000Z',
  };

  async accountDataExport(
    _shopId: string,
    token: string | null,
  ): Promise<AccountDataExportResponse | null> {
    const account = token ? this.accounts.get(token) : undefined;
    if (!token || !account) return null;
    this.dataAsked.push(['export', token]);
    if (!account.dataRequests.available) return { state: 'none' };
    const file = this.dataFiles.get(token) ?? {
      state: 'ready',
      readyAt: '2026-10-19T10:00:00.000Z',
      expiresAt: '2026-10-20T10:00:00.000Z',
    };
    const made = !this.dataFiles.has(token);
    this.dataFiles.set(token, file);
    return { ...file, made, url: SIGNED_FILE };
  }

  async accountDataExportLink(
    _shopId: string,
    token: string | null,
  ): Promise<Exclude<AccountDataExportResponse, { state: 'none' }> | null> {
    if (!token || !this.accounts.has(token)) return null;
    this.dataAsked.push(['link', token]);
    const file = this.dataFiles.get(token);
    return file ? { ...file, made: false, url: SIGNED_FILE } : null;
  }

  async accountDataErase(
    _shopId: string,
    token: string | null,
    locale?: string,
  ): Promise<AccountDataEraseResponse | null> {
    const account = token ? this.accounts.get(token) : undefined;
    if (!token || !account) return null;
    this.dataAsked.push(['erase', token]);
    this.eraseLocales.push(locale);
    return account.dataRequests.available ? this.erasure : { state: 'none' };
  }

  /**
   * Wishlists kept with accounts (ADR-575), by the session's secret, the newest first, as the
   * core keeps them by the products' IDs; and what was asked of them.
   */
  readonly wishlists = new Map<string, string[]>();
  readonly wishlistAsked: ['read' | 'add' | 'remove', string, string[]][] = [];

  /** A signed-in shopper's own prices (ADR-781), by variant, and the variants asked of. */
  readonly ownPrices = new Map<string, number>();
  readonly pricesAsked: string[][] = [];

  async accountPrices(
    _shopId: string,
    token: string | null,
    variantIds: readonly string[],
  ): Promise<Record<string, number> | null> {
    if (!token || !this.accounts.has(token)) return null;
    this.pricesAsked.push([...variantIds]);
    return Object.fromEntries(
      variantIds.flatMap((id) => (this.ownPrices.has(id) ? [[id, this.ownPrices.get(id)!]] : [])),
    );
  }

  async accountWishlist(_shopId: string, token: string | null): Promise<string[] | null> {
    if (!token || !this.accounts.has(token)) return null;
    this.wishlistAsked.push(['read', token, []]);
    return this.wishlists.get(token) ?? [];
  }

  async accountWishlistAdd(
    _shopId: string,
    token: string | null,
    productIds: readonly string[],
  ): Promise<string[] | null> {
    if (!token || !this.accounts.has(token)) return null;
    this.wishlistAsked.push(['add', token, [...productIds]]);
    const kept = this.wishlists.get(token) ?? [];
    const added = productIds.filter((id) => !kept.includes(id));
    this.wishlists.set(token, [...added, ...kept].slice(0, 100));
    return this.wishlists.get(token)!;
  }

  async accountWishlistRemove(
    _shopId: string,
    token: string | null,
    productId: string,
  ): Promise<string[] | null> {
    if (!token || !this.accounts.has(token)) return null;
    this.wishlistAsked.push(['remove', token, [productId]]);
    this.wishlists.set(
      token,
      (this.wishlists.get(token) ?? []).filter((id) => id !== productId),
    );
    return this.wishlists.get(token)!;
  }

  /**
   * Address books kept with accounts (ADR-584), by the session's secret, the default first, as
   * the core keeps them, checking a city and a number as it does; and what was saved.
   */
  readonly addressBooks = new Map<string, AccountAddress[]>();
  readonly addressesSaved: [string | null, AccountAddressRequest][] = [];

  async accountAddresses(_shopId: string, token: string | null): Promise<AccountAddress[] | null> {
    if (!token || !this.accounts.has(token)) return null;
    return this.addressBooks.get(token) ?? [];
  }

  async accountAddressSave(
    _shopId: string,
    token: string | null,
    address: AccountAddressRequest,
    addressId?: string,
  ): Promise<
    | { ok: true; addresses: AccountAddress[] }
    | { ok: false; errors: { field: string; message: string }[] }
    | null
  > {
    if (!token || !this.accounts.has(token)) return null;
    this.addressesSaved.push([addressId ?? null, address]);
    const book = this.addressBooks.get(token) ?? [];
    const errors = [
      ...(/^0?3\d{2}[\s-]?\d{7}$/.test(address.phone)
        ? []
        : [{ field: 'phone', message: 'Phone must be a Pakistani mobile number' }]),
      ...(address.city.trim() === '' ? [{ field: 'city', message: "City can't be blank" }] : []),
      ...(addressId !== undefined && !book.some((each) => each.id === addressId)
        ? [{ field: 'id', message: 'Id is not one of your addresses' }]
        : []),
      ...(addressId === undefined && book.length >= ACCOUNT_ADDRESSES_MAX
        ? [{ field: '', message: 'You can keep 20 addresses' }]
        : []),
    ];
    if (errors.length > 0) return { ok: false, errors };
    const kept: AccountAddress = {
      id: addressId ?? `addr_${book.length + 1}`,
      name: address.name,
      phone: `+92${address.phone.replace(/\D/g, '').slice(-10)}`,
      address1: address.address1,
      address2: address.address2 ?? null,
      landmark: address.landmark ?? null,
      city: address.city,
      provinceCode: 'PB',
      province: 'Punjab',
      zip: address.zip ?? null,
      default: book.length === 0 || address.default === true,
    };
    let next = addressId
      ? book.map((each) =>
          each.id === addressId ? { ...kept, default: each.default || kept.default } : each,
        )
      : [...book, kept];
    if (kept.default) next = next.map((each) => ({ ...each, default: each.id === kept.id }));
    next.sort((a, b) => Number(b.default) - Number(a.default));
    this.addressBooks.set(token, next);
    return { ok: true, addresses: next };
  }

  async accountAddressDelete(
    _shopId: string,
    token: string | null,
    addressId: string,
  ): Promise<AccountAddress[] | null> {
    if (!token || !this.accounts.has(token)) return null;
    const left = (this.addressBooks.get(token) ?? []).filter((each) => each.id !== addressId);
    if (left.length > 0 && !left.some((each) => each.default))
      left[0] = { ...left[0]!, default: true };
    this.addressBooks.set(token, left);
    return left;
  }
}

/** Where storage gives a shopper's file, as the core signs it for minutes (ADR-572). */
const SIGNED_FILE = 'https://storage.test/shops/1/customer-data/1.json?expires=300&signature=x';

/** A preview link's token, as the core seals them. */
const PREVIEW_TOKEN = 'v1.k1.cHJldmlldy1pdiE.c2VhbGVkLWNsYWltcy1hbmQtdGFn';

/** A theme a preview link shows for the next hour, its home page a banner with `heading`. */
const previewing = (name: string, heading: string): ThemePreviewResponse => ({
  theme: {
    id: 'thm-9',
    name,
    version: 3,
    base: 'hatti-base',
    files: { 'templates/index.json': bannerHome(heading) },
  },
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});

describe('Carts', () => {
  const sample = sampleStore();
  const lawn = sample.products[0]!;
  const variant = lawn.variants[1]!;
  const line = (quantity: number) => ({
    key: `${variant.id}:0123456789abcdef0123456789abcdef`,
    variantId: variant.id,
    productId: lawn.id,
    quantity,
    properties: {},
    price: variant.price,
    linePrice: variant.price * quantity,
    title: lawn.title,
    variantTitle: variant.title,
    sku: variant.sku,
    grams: 0,
    taxable: true,
    taxCode: null,
    maxQuantity: null,
  });
  const cartOf = (quantity: number, note = ''): CartJson => ({
    note,
    attributes: {},
    items: quantity > 0 ? [line(quantity)] : [],
    itemCount: quantity,
    subtotal: variant.price * quantity,
    totalWeightGrams: 0,
    discount: null,
    totalDiscount: 0,
  });
  let theme: Theme;
  let core: FakeCore;

  beforeAll(async () => {
    theme = loadTheme(await readThemeDir(THEME_DIR));
  });

  const server = (extra: Partial<StorefrontServerOptions> = {}) => {
    core = new FakeCore();
    return createStorefrontServer({
      theme,
      renderer: new PageRenderer(theme, { limits: { timeMs: 10_000 } }),
      domain: 'localhost',
      sample: new MemoryStore(sampleStore()),
      core,
      ...extra,
    });
  };
  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
  const FORM = { host: 'localhost', 'content-type': 'application/x-www-form-urlencoded' };

  it("gives scripts the cart in the shopper's currency, with what checkout charges in rupees (ADR-924)", async () => {
    const shop = sampleStore();
    const app = server({
      sample: new MemoryStore({
        ...shop,
        shop: {
          ...shop.shop,
          currencies: [{ currency: 'AED', rate: '76.4521', rounding: 'exact' }],
        },
      }),
    });
    core.kept.set('secret-aed', cartOf(2));
    const read = async (cookie: string) =>
      (
        await app.inject({
          method: 'GET',
          url: '/cart.js',
          headers: { host: 'localhost', cookie: `cart=secret-aed; ${cookie}` },
        })
      ).json() as Record<string, unknown> & { items: Record<string, unknown>[] };
    // Paisa over the rate, in fils: Rs 1 = 100 paisa is 100 / 76.4521 fils.
    const aed = (paisa: number) => Math.round(paisa / 76.4521);
    const inAed = await read('currency=AED');
    expect(inAed).toMatchObject({
      currency: 'AED',
      total_price: aed(variant.price * 2),
      items_subtotal_price: aed(variant.price * 2),
      hatti_checkout_currency: 'PKR',
      hatti_checkout_total_price: variant.price * 2,
    });
    expect(inAed.items[0]).toMatchObject({
      price: aed(variant.price),
      final_line_price: aed(variant.price * 2),
    });
    // In rupees without a currency, or with one the shop doesn't show.
    for (const cookie of ['', 'currency=GBP']) {
      expect(await read(cookie)).toMatchObject({
        currency: 'PKR',
        total_price: variant.price * 2,
        hatti_checkout_total_price: variant.price * 2,
      });
    }
    await app.close();
  });

  it("adds to the cart from a product page's form, keeping the cart's secret in a cookie", async () => {
    const app = server();
    core.answer = () => ({ ok: true, cart: cartOf(2), token: 'secret-1', added: [line(2).key] });
    const added = await app.inject({
      method: 'POST',
      url: '/cart/add',
      headers: FORM,
      payload: form({
        form_type: 'product',
        id: variant.id,
        quantity: '2',
        'properties[Name]': 'Ayesha',
      }),
    });
    expect([added.statusCode, added.headers.location]).toEqual([303, '/cart']);
    expect(added.headers['set-cookie']).toEqual([
      'cart=secret-1; Max-Age=1209600; Path=/; SameSite=Lax; HttpOnly',
      'cart_count=2; Max-Age=1209600; Path=/; SameSite=Lax',
    ]);
    expect(added.headers['cache-control']).toBe('private, no-store');
    expect(core.actions).toEqual([
      {
        token: null,
        action: 'add',
        body: { items: [{ variantId: variant.id, quantity: 2, properties: { Name: 'Ayesha' } }] },
      },
    ]);

    // The cart page shows it, and /cart.js gives it to scripts.
    const cookie = 'cart=secret-1; cart_count=2';
    const page = await app.inject({
      method: 'GET',
      url: '/cart',
      headers: { host: 'localhost', cookie },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<span class="count" data-cart-count>2</span>');
    expect(page.body).toContain(`href="/products/${lawn.handle}?variant=${variant.id}"`);
    expect(page.body).toContain(
      '<button type="submit" name="checkout" class="button">Check out</button>',
    );
    const json = await app.inject({
      method: 'GET',
      url: '/cart.js',
      headers: { host: 'localhost', cookie },
    });
    expect(json.json()).toMatchObject({
      item_count: 2,
      total_price: variant.price * 2,
      currency: 'PKR',
      items: [
        {
          id: variant.id,
          key: line(2).key,
          quantity: 2,
          title: `${lawn.title} - ${variant.title}`,
          variant_title: variant.title,
          url: `/products/${lawn.handle}?variant=${variant.id}`,
          handle: lawn.handle,
          final_line_price: variant.price * 2,
          taxable: true,
        },
      ],
    });
    // Without a cookie, an empty cart, and nothing asked of the core.
    const empty = await app.inject({
      method: 'GET',
      url: '/cart.js',
      headers: { host: 'localhost' },
    });
    expect(empty.json()).toMatchObject({ item_count: 0, items: [] });
    expect(empty.headers['set-cookie']).toBeUndefined();
    await app.close();
  });

  it("gives an Urdu page's scripts the cart in Urdu, at its Urdu addresses (ADR-625)", async () => {
    const urduLawn = { ...lawn, translations: { ur: { title: 'لان کا سوٹ' } } };
    const app = server({
      sample: new MemoryStore({
        ...sampleStore(),
        products: sample.products.map((doc) => (doc.id === lawn.id ? urduLawn : doc)),
      }),
    });
    core.answer = () => ({ ok: true, cart: cartOf(2), token: 'secret-9', added: [line(2).key] });
    const script = {
      host: 'localhost',
      cookie: 'cart=secret-9',
      'content-type': 'application/json',
    };
    const read = async (url: string) =>
      (await app.inject({ method: 'GET', url, headers: script })).json();
    // A line added from an Urdu page, in Urdu.
    const added = await app.inject({
      method: 'POST',
      url: '/ur/cart/add.js',
      headers: script,
      payload: { id: variant.id, quantity: 1 },
    });
    expect(added.json()).toMatchObject({
      product_title: 'لان کا سوٹ',
      url: `/ur/products/${lawn.handle}?variant=${variant.id}`,
    });
    const urdu = await read('/ur/cart.js');
    expect(urdu).toMatchObject({
      items: [
        {
          title: `لان کا سوٹ - ${variant.title}`,
          product_title: 'لان کا سوٹ',
          url: `/ur/products/${lawn.handle}?variant=${variant.id}`,
        },
      ],
    });
    // The shop's own words at the shop's own address, as before.
    expect(await read('/cart.js')).toMatchObject({
      items: [
        {
          title: `${lawn.title} - ${variant.title}`,
          url: `/products/${lawn.handle}?variant=${variant.id}`,
        },
      ],
    });
    // The cart changed from one.
    const changed = await app.inject({
      method: 'POST',
      url: '/ur/cart/change.js',
      headers: script,
      payload: { id: line(2).key, quantity: 2 },
    });
    expect(changed.json()).toMatchObject({ items: [{ product_title: 'لان کا سوٹ' }] });
    await app.close();
  });

  it("answers themes' scripts as Shopify's Ajax cart does", async () => {
    const app = server();
    core.answer = (action) => ({
      ok: true,
      cart: cartOf(action === 'add' ? 3 : 1, 'Gift'),
      token: 'secret-2',
      added: action === 'add' ? [line(3).key] : [],
    });
    const script = {
      host: 'localhost',
      cookie: 'cart=secret-2',
      'content-type': 'application/json',
    };
    // One item gives its line back; `items` gives a list.
    const one = await app.inject({
      method: 'POST',
      url: '/cart/add.js',
      headers: script,
      payload: { id: variant.id, quantity: 1 },
    });
    expect(one.json()).toMatchObject({ key: line(3).key, quantity: 3, product_title: lawn.title });
    const many = await app.inject({
      method: 'POST',
      url: '/cart/add.js',
      headers: script,
      payload: { items: [{ id: variant.id, quantity: 1 }] },
    });
    expect(many.json()).toMatchObject({ items: [{ key: line(3).key }] });
    // Scripts posting to the form's address get JSON too, as Dawn's do.
    const change = await app.inject({
      method: 'POST',
      url: '/cart/change',
      headers: { ...script, 'x-requested-with': 'XMLHttpRequest' },
      payload: { id: line(3).key, quantity: 1 },
    });
    expect(change.json()).toMatchObject({ item_count: 1, note: 'Gift' });
    await app.inject({
      method: 'POST',
      url: '/cart/update.js',
      headers: script,
      payload: { updates: { [variant.id]: 4 }, note: 'Gift', attributes: { Wrap: 'Red' } },
    });
    expect(core.actions.map(({ token, action, body }) => [token, action, body])).toEqual([
      ['secret-2', 'add', { items: [{ variantId: variant.id, quantity: 1, properties: {} }] }],
      ['secret-2', 'add', { items: [{ variantId: variant.id, quantity: 1, properties: {} }] }],
      ['secret-2', 'change', { line: { key: line(3).key }, quantity: 1 }],
      [
        'secret-2',
        'update',
        {
          updates: [{ line: { variantId: variant.id }, quantity: 4 }],
          note: 'Gift',
          attributes: { Wrap: 'Red' },
        },
      ],
    ]);
    await app.close();
  });

  it("adds from a script's FormData as Dawn's product form sends it, and keeps no files (ADR-701)", async () => {
    const app = server();
    core.answer = () => ({ ok: true, cart: cartOf(2), token: 'secret-9', added: [line(2).key] });
    /** A form as `fetch(url, { body: new FormData(form) })` sends it. */
    const multipart = async (fields: [string, string | Blob, string?][]) => {
      const data = new FormData();
      for (const [name, value, filename] of fields) {
        if (typeof value === 'string') data.append(name, value);
        else data.append(name, value, filename);
      }
      const request = new Request('http://localhost/', { method: 'POST', body: data });
      return {
        type: request.headers.get('content-type')!,
        body: Buffer.from(await request.arrayBuffer()),
      };
    };
    const post = async (fields: [string, string | Blob, string?][]) => {
      const { type, body } = await multipart(fields);
      return app.inject({
        method: 'POST',
        url: '/cart/add',
        headers: {
          host: 'localhost',
          'content-type': type,
          accept: 'application/javascript',
          'x-requested-with': 'XMLHttpRequest',
        },
        payload: body,
      });
    };
    const added = await post([
      ['form_type', 'product'],
      ['id', variant.id],
      ['quantity', '2'],
      ['properties[Name]', 'Ayesha'],
      // A file input left empty is an empty field, as in a form encoded in its address.
      ['properties[Photo]', new Blob([]), ''],
      ['sections', 'cart-drawer'],
      ['sections_url', `/products/${lawn.handle}`],
    ]);
    expect(added.statusCode).toBe(200);
    const answer = added.json() as { key: string; sections: Record<string, string | null> };
    expect(answer.key).toBe(line(2).key);
    expect(answer.sections['cart-drawer']).toContain(`>${lawn.title}</a>`);
    expect(core.actions).toEqual([
      {
        token: null,
        action: 'add',
        body: {
          items: [
            { variantId: variant.id, quantity: 2, properties: { Name: 'Ayesha', Photo: '' } },
          ],
        },
      },
    ]);

    // A file, which Shopify would keep for the line, is refused, the cart as it was.
    const photo = await post([
      ['id', variant.id],
      ['properties[Photo]', new Blob(['not really a photo'], { type: 'image/jpeg' }), 'me.jpg'],
    ]);
    expect(photo.statusCode).toBe(422);
    expect(photo.json()).toEqual({
      status: 422,
      message: 'Cart Error',
      description: "This shop's cart takes no files.",
    });
    expect(core.actions).toHaveLength(1);

    // Nor is a body that is not the form it says, or one past a form's 64 KB.
    const broken = await app.inject({
      method: 'POST',
      url: '/cart/add.js',
      headers: { host: 'localhost', 'content-type': 'multipart/form-data; boundary=nothing' },
      payload: 'id=1',
    });
    expect(broken.statusCode).toBe(400);
    const large = await post([
      ['id', variant.id],
      ['properties[Note]', 'x'.repeat(70 * 1024)],
    ]);
    expect(large.statusCode).toBe(413);
    expect(core.actions).toHaveLength(1);
    await app.close();
  });

  it("renders the sections a cart change asks for, and a page's, with the shopper's cart", async () => {
    const app = server();
    core.answer = () => ({ ok: true, cart: cartOf(2), token: 'secret-3', added: [line(2).key] });
    // A drawer adds by form, asking for its sections as the page it is on renders them.
    const added = await app.inject({
      method: 'POST',
      url: '/cart/add.js',
      headers: FORM,
      payload: form({
        id: variant.id,
        quantity: '2',
        sections: 'cart-drawer, header-group__header,nothing',
        sections_url: `/products/${lawn.handle}`,
      }),
    });
    expect(added.statusCode).toBe(200);
    const answer = added.json() as { key: string; sections: Record<string, string | null> };
    expect(answer.key).toBe(line(2).key);
    expect(Object.keys(answer.sections)).toEqual([
      'cart-drawer',
      'header-group__header',
      'nothing',
    ]);
    expect(answer.sections['cart-drawer']).toContain(`>${lawn.title}</a>`);
    expect(answer.sections['cart-drawer']).toContain(
      'value="2" min="0" inputmode="numeric" data-line="1"',
    );
    // What goes with it, asked for as on the cart page, two at most (ADR-440).
    expect(answer.sections['cart-drawer']).toMatch(
      new RegExp(
        `<hatti-cart-upsells[^>]*data-urls="/recommendations/products\\?section_id=cart-upsells&intent=complementary&product_id=${lawn.id}&limit=2"[^>]*data-limit="2"`,
      ),
    );
    expect(answer.sections['cart-drawer']).toContain(
      '<h2 dir="auto">Goes well with your order</h2>',
    );
    expect(answer.sections['header-group__header']).toContain('class="header"');
    expect(answer.sections.nothing).toBeNull();

    // As JSON, a list, rendered as part of the shop's page that asked: here in Urdu.
    core.answer = () => ({ ok: true, cart: cartOf(0), token: 'secret-3', added: [] });
    const changed = await app.inject({
      method: 'POST',
      url: '/cart/change.js',
      headers: {
        host: 'localhost',
        cookie: 'cart=secret-3',
        'content-type': 'application/json',
        referer: 'http://localhost/ur/collections/eid',
      },
      payload: { line: 1, quantity: 0, sections: ['cart-drawer'] },
    });
    expect(changed.json()).toMatchObject({ item_count: 0 });
    expect(changed.json().sections['cart-drawer']).toContain('آپ کا کارٹ خالی ہے۔');
    expect(changed.json().sections['cart-drawer']).not.toContain('<hatti-cart-upsells');

    // A page's sections, with the cart its cookie names, and never kept.
    core.kept.set('secret-4', cartOf(3));
    const drawer = await app.inject({
      method: 'GET',
      url: '/?section_id=cart-drawer',
      headers: { host: 'localhost', cookie: 'cart=secret-4' },
    });
    expect(drawer.statusCode).toBe(200);
    expect(drawer.headers['cache-control']).toBe('private, no-store');
    expect(drawer.body).toMatch(/^<div id="hatti-section-cart-drawer"/);
    expect(drawer.body).toContain('value="3"');
    const several = await app.inject({
      method: 'GET',
      url: `/products/${lawn.handle}?sections=cart-drawer,main,nothing`,
      headers: { host: 'localhost' },
    });
    const sections = several.json() as Record<string, string | null>;
    expect(Object.keys(sections)).toEqual(['cart-drawer', 'main', 'nothing']);
    expect(sections['cart-drawer']).toContain('Your cart is empty.');
    expect(sections.main).toContain(`>${lawn.title}</h1>`);
    expect(sections.nothing).toBeNull();
    // The cart page's own, as a theme's cart page asks for them.
    const cartPage = await app.inject({
      method: 'GET',
      url: '/cart?section_id=main',
      headers: { host: 'localhost', cookie: 'cart=secret-4' },
    });
    expect(cartPage.body).toMatch(/^<div id="hatti-section-main"/);
    expect(cartPage.body).toContain('value="3"');

    // A cookie naming no cart goes; a section there is not is not found.
    const stale = await app.inject({
      method: 'GET',
      url: '/?section_id=cart-drawer',
      headers: { host: 'localhost', cookie: 'cart=gone; cart_count=2' },
    });
    expect(stale.headers['set-cookie']).toEqual([
      'cart=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly',
      'cart_count=; Max-Age=0; Path=/; SameSite=Lax',
    ]);
    const missing = await app.inject({
      method: 'GET',
      url: '/?section_id=nothing',
      headers: { host: 'localhost' },
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("has the edge keep pages by what they show, search briefly, and never a shopper's cart", async () => {
    const app = server();
    const get = (url: string, host = 'localhost') =>
      app.inject({ method: 'GET', url, headers: { host } });
    const tagsOf = (response: { headers: Record<string, unknown> }) =>
      String(response.headers['cache-tag']).split(',');

    const home = await get('/');
    expect(home.headers['cache-control']).toBe(
      'public, max-age=0, s-maxage=300, stale-while-revalidate=86400, stale-if-error=604800',
    );
    // The shop's, and the collections its sections show, by handle.
    expect(tagsOf(home)).toEqual([
      'hatti:sample',
      'hatti:sample:collection:eid-lawn',
      'hatti:sample:collection:khussa',
      'hatti:sample:collection:mens-kurta',
    ]);
    expect(tagsOf(await get(`/ur/products/${lawn.handle}`))).toEqual([
      'hatti:sample',
      `hatti:sample:product:${lawn.handle}`,
    ]);
    // A handle nothing has yet: forgotten once something takes it, or a redirect from its path.
    const missing = await get('/pages/size-guide');
    expect([missing.statusCode, tagsOf(missing)]).toEqual([
      404,
      ['hatti:sample', 'hatti:sample:page:size-guide', pathTag('sample', '/pages/size-guide')],
    ]);

    // Search results for a minute; the cart, never; theme assets, for a year.
    expect((await get('/search?q=lawn')).headers['cache-control']).toBe(
      'public, max-age=0, s-maxage=60',
    );
    const cart = await get('/cart');
    expect([cart.headers['cache-control'], cart.headers['cache-tag']]).toEqual([
      'private, no-store',
      undefined,
    ]);
    expect((await get('/assets/v1/base.css')).headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    // A theme's script, as the cart's cross-sells use (ADR-440).
    const script = await get('/assets/v1/cart-upsells.js');
    expect([script.statusCode, script.headers['content-type']]).toEqual([
      200,
      'application/javascript; charset=utf-8',
    ]);
    expect(script.body).toContain("customElements.define('hatti-cart-upsells'");
    expect((await get('/', 'nobody.localhost')).headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it("updates the cart page's quantities and note, and removes a line by its link", async () => {
    const app = server();
    core.answer = () => ({
      ok: true,
      cart: cartOf(0, 'Call first'),
      token: 'secret-3',
      added: [],
    });
    const updated = await app.inject({
      method: 'POST',
      url: '/ur/cart',
      headers: { ...FORM, cookie: 'cart=secret-3' },
      payload: 'form_type=cart&updates%5B%5D=1&updates%5B%5D=0&note=Call+first&update=',
    });
    expect([updated.statusCode, updated.headers.location]).toEqual([303, '/ur/cart']);
    const removed = await app.inject({
      method: 'GET',
      url: `/cart/change?id=${encodeURIComponent(line(1).key)}&quantity=0`,
      headers: { host: 'localhost', cookie: 'cart=secret-3' },
    });
    expect(removed.statusCode).toBe(303);
    expect(core.actions.map(({ action, body }) => [action, body])).toEqual([
      [
        'update',
        {
          updates: [
            { line: { index: 1 }, quantity: 1 },
            { line: { index: 2 }, quantity: 0 },
          ],
          note: 'Call first',
        },
      ],
      ['change', { line: { key: line(1).key }, quantity: 0 }],
    ]);
    // Only removing is a link; adding takes a form.
    const add = await app.inject({
      method: 'GET',
      url: `/cart/add?id=${variant.id}`,
      headers: { host: 'localhost' },
    });
    expect(add.statusCode).toBe(405);
    await app.close();
  });

  it("says why a change was refused, in the page's language", async () => {
    const app = server();
    core.kept.set('secret-4', cartOf(2));
    core.answer = () => ({
      ok: false,
      error: { code: 'MAX_QUANTITY', variantId: variant.id, title: 'Rose Lawn', max: 3 },
    });
    const post = (url: string, headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url,
        headers: { ...FORM, cookie: 'cart=secret-4', ...headers },
        payload: form({ id: variant.id, quantity: '5' }),
      });
    const page = await post('/cart/add', {});
    expect(page.statusCode).toBe(422);
    expect(page.body).toContain(
      '<p class="cart__error" role="alert" dir="auto">You can have at most 3 of Rose Lawn in your cart.</p>',
    );
    // The cart as it was.
    expect(page.body).toContain('<span class="count" data-cart-count>2</span>');
    const urdu = await post('/ur/cart/add.js', {});
    expect([urdu.statusCode, urdu.json()]).toEqual([
      422,
      {
        status: 422,
        message: 'Cart Error',
        description: 'آپ کارٹ میں Rose Lawn زیادہ سے زیادہ 3 رکھ سکتے ہیں۔',
      },
    ]);
    core.answer = () => ({ ok: false, error: { code: 'NOT_FOUND', variantId: 'x' } });
    expect((await post('/cart/add.js', {})).json()).toEqual({
      status: 404,
      message: 'Cart Error',
      description: 'This product is no longer for sale.',
    });
    await app.close();
  });

  it('checks out from the cart form, its changes saved first, or from /checkout', async () => {
    const app = server();
    core.answer = () => ({ ok: true, cart: cartOf(2), token: 'secret-5', added: [] });
    const checkedOut = await app.inject({
      method: 'POST',
      url: '/cart',
      headers: { ...FORM, cookie: 'cart=secret-5' },
      payload: 'form_type=cart&updates%5B%5D=2&note=&checkout=',
    });
    expect([checkedOut.statusCode, checkedOut.headers.location]).toEqual([
      303,
      '/checkouts/c-secret',
    ]);
    expect(checkedOut.headers['set-cookie']).toContain(
      'cart=secret-5; Max-Age=1209600; Path=/; SameSite=Lax; HttpOnly',
    );
    expect(core.actions.map(({ action }) => action)).toEqual(['update']);
    expect(core.started).toEqual(['secret-5']);
    // Themes' checkout links and return_to go to /checkout.
    const linked = await app.inject({
      method: 'GET',
      url: '/checkout',
      headers: { host: 'localhost', cookie: 'cart=secret-5' },
    });
    expect([linked.statusCode, linked.headers.location]).toEqual([303, '/checkouts/c-secret']);
    expect(linked.headers['cache-control']).toBe('private, no-store');

    // Nothing to order: back to the cart, in the shopper's language.
    core.answer = () => ({ ok: true, cart: cartOf(0), token: 'secret-6', added: [] });
    const emptied = await app.inject({
      method: 'POST',
      url: '/ur/cart',
      headers: { ...FORM, cookie: 'cart=secret-6' },
      payload: 'updates%5B%5D=0&checkout=',
    });
    expect([emptied.statusCode, emptied.headers.location]).toEqual([303, '/ur/cart']);
    const none = await app.inject({
      method: 'GET',
      url: '/checkout',
      headers: { host: 'localhost' },
    });
    expect([none.statusCode, none.headers.location]).toEqual([303, '/cart']);
    expect(core.started).toEqual(['secret-5', 'secret-5', 'secret-6', null]);
    await app.close();
  });

  it("keeps a discount link's code with the shopper's cart, and sends them on, never off the shop", async () => {
    const app = server();
    const unusable = { code: 'EID10', applicable: false, kind: null, value: 0, amount: 0 };
    core.answer = () => ({
      ok: true,
      cart: { ...cartOf(0), discount: unusable },
      token: 'secret-8',
      added: [],
    });
    // From an Instagram post: another site, and no cart yet, so one begun for the code.
    const followed = await app.inject({
      method: 'GET',
      url: '/discount/EID10?redirect=/collections/lawn%3Fsort_by%3Dprice-ascending',
      headers: { host: 'localhost', 'sec-fetch-site': 'cross-site' },
    });
    expect([followed.statusCode, followed.headers.location]).toEqual([
      302,
      '/collections/lawn?sort_by=price-ascending',
    ]);
    expect(followed.headers['cache-control']).toBe('private, no-store');
    expect(followed.headers['set-cookie']).toEqual([
      'cart=secret-8; Max-Age=1209600; Path=/; SameSite=Lax; HttpOnly',
      'cart_count=0; Max-Age=1209600; Path=/; SameSite=Lax',
    ]);
    expect(core.actions).toEqual([{ token: null, action: 'update', body: { discount: 'EID10' } }]);

    // Without a redirect, or with one off the shop: home, in the link's language.
    const link = (url: string) =>
      app.inject({ method: 'GET', url, headers: { host: 'localhost', cookie: 'cart=secret-8' } });
    for (const away of [
      '//evil.example',
      '/%09/evil.example',
      '/%5Cevil.example',
      'https://evil.example/',
    ]) {
      expect((await link(`/discount/EID10?redirect=${away}`)).headers.location, away).toBe('/');
    }
    expect((await link('/ur/discount/EID10')).headers.location).toBe('/ur');
    // The link's campaign goes on with the shopper, for the page they land on to keep (ADR-139).
    const tagged = await link('/discount/EID10?utm_source=instagram&fbclid=F1&redirect=/?x=1');
    expect(tagged.headers.location).toBe('/?x=1&utm_source=instagram&fbclid=F1');
    expect(core.actions.at(-1)).toEqual({
      token: 'secret-8',
      action: 'update',
      body: { discount: 'EID10' },
    });
    // A form's return_to stays on the shop too.
    const added = await app.inject({
      method: 'POST',
      url: '/cart/add',
      headers: { ...FORM, cookie: 'cart=secret-8' },
      payload: form({ id: variant.id, return_to: '/\t/evil.example' }),
    });
    expect(added.headers.location).toBe('/cart');

    // A link checker's HEAD request only learns where; with the core away, the shopper still goes.
    const asked = core.actions.length;
    const head = await app.inject({
      method: 'HEAD',
      url: '/discount/EID10',
      headers: { host: 'localhost' },
    });
    expect([head.statusCode, head.headers.location, core.actions.length]).toEqual([
      302,
      '/',
      asked,
    ]);
    core.answer = () => new StorefrontApiError(502, 'Bad gateway');
    const down = await link('/discount/EID10?redirect=/cart');
    expect([down.statusCode, down.headers.location, down.headers['set-cookie']]).toEqual([
      302,
      '/cart',
      undefined,
    ]);
    await app.close();
  });

  it('shows the tracking page, and passes on what the shopper typed, so often an address (ADR-251)', async () => {
    const app = server();
    const page = await app.inject({ method: 'GET', url: '/track', headers: { host: 'localhost' } });
    expect([page.statusCode, page.body, page.headers['cache-control']]).toEqual([
      200,
      '<h1>Track your order</h1>',
      'no-store',
    ]);
    const typed = 'reference=%231001&phone=0300+1234567&extra=1';
    const ask = (headers: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: '/ur/track',
        headers: {
          host: 'localhost',
          'content-type': 'application/x-www-form-urlencoded',
          ...headers,
        },
        payload: typed,
      });
    expect((await ask()).statusCode).toBe(200);
    expect(core.lookups).toEqual([null, { reference: '#1001', phone: '0300 1234567' }]);
    // Not from another site.
    expect((await ask({ 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect(core.lookups).toHaveLength(2);
    await app.close();
  });

  it('opens a payment link to a checkout of its own, or sends the page saying why not', async () => {
    const app = server();
    const opened = await app.inject({
      method: 'GET',
      url: '/pay/AbCdEfGhIjKlMnOpQrStUv?utm_source=instagram',
      headers: { host: 'localhost', cookie: 'cart=own-1', 'sec-fetch-site': 'cross-site' },
    });
    expect([opened.statusCode, opened.headers.location]).toEqual([303, '/checkouts/l-secret']);
    expect(opened.headers['cache-control']).toBe('private, no-store');
    // The link is where the shopper landed, which their checkout keeps (ADR-139).
    expect(core.links).toEqual([
      {
        token: 'AbCdEfGhIjKlMnOpQrStUv',
        visits: [
          {
            occurredAt: expect.any(String),
            landingPage: 'http://localhost/pay/AbCdEfGhIjKlMnOpQrStUv?utm_source=instagram',
            referrerUrl: null,
          },
        ],
      },
    ]);
    // Their own cart is left as it is.
    expect([core.actions, core.started]).toEqual([[], []]);

    // Closed: the core's page, as it is.
    core.link = {
      status: 410,
      headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' },
      html: '<p>This link no longer takes orders</p>',
    };
    const closed = await app.inject({
      method: 'GET',
      url: '/ur/pay/AbCdEfGhIjKlMnOpQrStUv',
      headers: { host: 'localhost' },
    });
    expect([closed.statusCode, closed.headers['x-robots-tag'], closed.body]).toEqual([
      410,
      'noindex',
      '<p>This link no longer takes orders</p>',
    ]);
    // A HEAD request opens nothing; with the core away, the shopper is told so.
    const head = await app.inject({
      method: 'HEAD',
      url: '/pay/AbCdEfGhIjKlMnOpQrStUv',
      headers: { host: 'localhost' },
    });
    expect([head.statusCode, head.headers.location, core.links.length]).toEqual([302, '/', 2]);
    core.link = new StorefrontApiError(503, 'down');
    const away = await app.inject({
      method: 'GET',
      url: '/pay/AbCdEfGhIjKlMnOpQrStUv',
      headers: { host: 'localhost' },
    });
    expect(away.statusCode).toBe(503);
    await app.close();
  });

  it("fills in a permalink's checkout with Shopify's checkout[...] details, which visits do not keep (ADR-709)", async () => {
    const app = server();
    core.answer = () => ({ ok: true, cart: cartOf(1), token: 'linked-2', added: [] });
    const details =
      'checkout%5Bshipping_address%5D%5Bfirst_name%5D=Ayesha' +
      '&checkout%5Bshipping_address%5D%5Blast_name%5D=Khan' +
      '&checkout%5Bshipping_address%5D%5Bcity%5D=Lahore' +
      '&checkout%5Bshipping_address%5D%5Bphone%5D=0300+1234567' +
      '&checkout%5Bemail%5D=ayesha%40example.pk';
    const followed = await app.inject({
      method: 'GET',
      url: `/cart/${variant.id}:1?utm_source=whatsapp&${details}`,
      headers: { host: 'localhost' },
    });
    expect(followed.statusCode).toBe(303);
    expect(followed.headers.location).toBe(`/checkouts/c-secret?${details}`);
    // Where the shopper landed, without their details.
    expect(core.visits.at(-1)![0]!.landingPage).toBe(
      `http://localhost/cart/${variant.id}:1?utm_source=whatsapp`,
    );

    // The checkout's page, opened there, filled in with them.
    await app.inject({
      method: 'GET',
      url: followed.headers.location!,
      headers: { host: 'localhost' },
    });
    expect(core.pages.at(-1)).toMatchObject({
      token: 'c-secret',
      form: null,
      prefill: {
        name: 'Ayesha Khan',
        city: 'Lahore',
        phone: '0300 1234567',
        email: 'ayesha@example.pk',
      },
    });
    // Posted, the form is the shopper's own.
    await app.inject({
      method: 'POST',
      url: followed.headers.location!,
      headers: { ...FORM, 'sec-fetch-site': 'same-origin' },
      payload: form({ shown: 'digest', name: 'Ayesha', phone: '0300 1234567' }),
    });
    expect(core.pages.at(-1)!.prefill).toBeUndefined();
    await app.close();
  });

  it("follows a cart permalink to a checkout of its own, leaving the shopper's cart as it is", async () => {
    const app = server();
    const plain = lawn.variants[0]!;
    core.kept.set('own-1', cartOf(1));
    core.answer = (action) => ({
      ok: true,
      cart: cartOf(3),
      token: 'linked-1',
      added: action === 'add' ? [line(3).key] : [],
    });
    // From a chat: another site, and the shopper has a cart of their own.
    const permalink =
      `/cart/${variant.id}:2,${plain.id}:1` +
      '?discount=EID10&note=From+WhatsApp&attributes%5BSource%5D=WhatsApp';
    const followed = await app.inject({
      method: 'GET',
      url: permalink,
      headers: { host: 'localhost', cookie: 'cart=own-1', 'sec-fetch-site': 'cross-site' },
    });
    expect([followed.statusCode, followed.headers.location]).toEqual([303, '/checkouts/c-secret']);
    expect(followed.headers['cache-control']).toBe('private, no-store');
    // The cart cookies are left as they are; the link is the shopper's first visit (ADR-139),
    // which their checkout keeps.
    const [visit] = core.visits.at(-1)!;
    expect(visit).toEqual({
      occurredAt: expect.any(String),
      landingPage: `http://localhost${permalink}`,
      referrerUrl: null,
    });
    expect(String(followed.headers['set-cookie'])).toMatch(
      /^hatti_visits=[\w-]+; Max-Age=2592000; Path=\/; SameSite=Lax$/,
    );
    expect(core.actions).toEqual([
      {
        token: null,
        action: 'add',
        body: {
          items: [
            { variantId: variant.id, quantity: 2, properties: {} },
            { variantId: plain.id, quantity: 1, properties: {} },
          ],
        },
      },
      {
        token: 'linked-1',
        action: 'update',
        body: { note: 'From WhatsApp', attributes: { Source: 'WhatsApp' }, discount: 'EID10' },
      },
    ]);
    expect(core.started).toEqual(['linked-1']);

    // Its order placed, the shopper's own cart still counts what it holds.
    core.page = { placed: true };
    const placed = await app.inject({
      method: 'POST',
      url: '/checkouts/c-secret',
      headers: { ...FORM, cookie: 'cart=own-1; cart_count=1', 'sec-fetch-site': 'same-origin' },
      payload: form({ shown: 'digest', name: 'Ayesha Khan', phone: '0300 1234567' }),
    });
    expect(placed.headers['set-cookie']).toBe(
      'cart_count=1; Max-Age=1209600; Path=/; SameSite=Lax',
    );

    // Without a query, the items alone; colons as some apps write them.
    const actions = core.actions.length;
    const encoded = await app.inject({
      method: 'GET',
      url: `/ur/cart/${variant.id}%3A1`,
      headers: { host: 'localhost' },
    });
    expect(encoded.headers.location).toBe('/checkouts/c-secret');
    expect(core.actions.slice(actions)).toEqual([
      {
        token: null,
        action: 'add',
        body: { items: [{ variantId: variant.id, quantity: 1, properties: {} }] },
      },
    ]);

    // Items that cannot be had: the shopper's own cart, saying why.
    core.answer = () => ({ ok: false, error: { code: 'NOT_FOUND', variantId: variant.id } });
    const gone = await app.inject({
      method: 'GET',
      url: `/cart/${variant.id}:1`,
      headers: { host: 'localhost', cookie: 'cart=own-1' },
    });
    expect(gone.statusCode).toBe(404);
    expect(gone.body).toContain('This product is no longer for sale.');
    expect(gone.body).toContain('<span class="count" data-cart-count>1</span>');
    // A HEAD request changes nothing; a path that names no items is no permalink.
    const asked = core.actions.length;
    const head = await app.inject({
      method: 'HEAD',
      url: `/cart/${variant.id}:1`,
      headers: { host: 'localhost' },
    });
    expect([head.statusCode, head.headers.location]).toEqual([302, '/cart']);
    const unnamed = await app.inject({
      method: 'GET',
      url: `/cart/${variant.id}`,
      headers: { host: 'localhost' },
    });
    expect([unnamed.statusCode, core.actions.length]).toEqual([404, asked]);
    await app.close();
  });

  it("gives scripts the cart's discount code as Shopify's Ajax cart does, and takes theirs", async () => {
    const app = server();
    const subtotal = variant.price * 2;
    const percent = { code: 'EID10', applicable: true, kind: 'percentage' as const, value: 10 };
    const discounted = (discount: CartJson['discount']): CartJson => ({
      ...cartOf(2),
      discount,
      totalDiscount: discount?.amount ?? 0,
    });
    core.answer = () => ({
      ok: true,
      cart: discounted({ ...percent, amount: subtotal / 10 }),
      token: 'secret-9',
      added: [],
    });
    const script = {
      host: 'localhost',
      cookie: 'cart=secret-9',
      'content-type': 'application/json',
    };
    const updated = await app.inject({
      method: 'POST',
      url: '/cart/update.js',
      headers: script,
      payload: { discount: 'EID10,FREESHIP' },
    });
    expect(core.actions.map(({ body }) => body)).toEqual([{ discount: 'EID10,FREESHIP' }]);
    expect(updated.json()).toMatchObject({
      original_total_price: subtotal,
      items_subtotal_price: subtotal,
      total_discount: subtotal / 10,
      total_price: subtotal - subtotal / 10,
      cart_level_discount_applications: [
        {
          type: 'discount_code',
          title: 'EID10',
          value: '10.0',
          value_type: 'percentage',
          allocation_method: 'across',
          target_selection: 'all',
          target_type: 'line_item',
          total_allocated_amount: subtotal / 10,
        },
      ],
      discount_codes: [{ code: 'EID10', applicable: true }],
    });

    // An amount off, in rupees as Shopify's are; free delivery and a code that does not apply
    // take nothing off the cart.
    const read = async (discount: CartJson['discount']) => {
      core.kept.set('secret-9', discounted(discount));
      return (await app.inject({ method: 'GET', url: '/cart.js', headers: script })).json();
    };
    const amount = { code: 'EID500', applicable: true, kind: 'fixed_amount' as const };
    expect(await read({ ...amount, value: 500_00, amount: 500_00 })).toMatchObject({
      total_price: subtotal - 500_00,
      cart_level_discount_applications: [{ value: '500.0', value_type: 'fixed_amount' }],
    });
    const free = { code: 'FREESHIP', applicable: true, kind: 'free_shipping' as const };
    for (const discount of [
      { ...free, value: 0, amount: 0 },
      { code: 'eid10', applicable: false, kind: null, value: 0, amount: 0 },
    ]) {
      expect(await read(discount)).toMatchObject({
        total_price: subtotal,
        total_discount: 0,
        cart_level_discount_applications: [],
        discount_codes: [{ code: discount.code, applicable: discount.applicable }],
      });
    }
    await app.close();
  });

  it('passes the name and number a shopper typed at checkout to the core, from the shop alone (ADR-393)', async () => {
    const app = server();
    const sent = await app.inject({
      method: 'POST',
      url: '/checkouts/c-secret/contact',
      headers: { ...FORM, 'sec-fetch-site': 'same-origin' },
      payload: form({ name: 'Ayesha Khan', phone: '0300 1234567', other: 'x' }),
    });
    expect([sent.statusCode, sent.headers['cache-control']]).toEqual([204, 'no-store']);
    expect(core.contacts).toEqual([
      { token: 'c-secret', name: 'Ayesha Khan', phone: '0300 1234567' },
    ]);
    // From another site: nothing passed on.
    const elsewhere = await app.inject({
      method: 'POST',
      url: '/checkouts/c-secret/contact',
      headers: { ...FORM, 'sec-fetch-site': 'cross-site' },
      payload: form({ name: 'Someone', phone: '0300 7654321' }),
    });
    expect(elsewhere.statusCode).toBe(204);
    expect(core.contacts).toHaveLength(1);
  });

  it("shows a checkout's page on the shop's address, and forgets the count once its order is placed", async () => {
    const app = server();
    core.page = {
      placed: false,
      status: 200,
      headers: {
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'",
        'content-type': 'text/html; charset=utf-8',
        'x-frame-options': 'DENY',
      },
      html: '<p>Checkout · Zari</p>',
    };
    const page = await app.inject({
      method: 'GET',
      url: '/checkouts/c-secret',
      headers: { host: 'localhost', cookie: 'cart=secret-7; cart_count=2' },
    });
    expect([page.statusCode, page.body]).toEqual([200, '<p>Checkout · Zari</p>']);
    expect(page.headers).toMatchObject({
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'",
      'x-frame-options': 'DENY',
    });
    expect(page.headers['set-cookie']).toBeUndefined();
    // Opened by a shopper signed in to their account, the core fills it in for them (ADR-585):
    // the session's secret goes with the page asked for, never with what is posted.
    await app.inject({
      method: 'GET',
      url: '/checkouts/c-secret',
      headers: { host: 'localhost', cookie: `hatti_account=${ACCOUNT_TOKEN}; hatti_signed_in=1` },
    });
    expect(core.pages.pop()).toEqual({ token: 'c-secret', form: null, account: ACCOUNT_TOKEN });
    // Posted, where the shopper placed it from, proving the number it signed in with (ADR-586).
    await app.inject({
      method: 'POST',
      url: '/checkouts/c-secret',
      headers: {
        ...FORM,
        cookie: `hatti_account=${ACCOUNT_TOKEN}; hatti_signed_in=1`,
        'sec-fetch-site': 'same-origin',
      },
      payload: form({ shown: 'digest' }),
    });
    const posted = core.pages.pop()!;
    expect(posted).toMatchObject({ form: { shown: 'digest' }, client: { account: ACCOUNT_TOKEN } });
    expect(posted).not.toHaveProperty('account');

    core.page = { placed: true };
    const placed = await app.inject({
      method: 'POST',
      url: '/checkouts/c-secret',
      headers: {
        ...FORM,
        cookie: 'cart=secret-7; cart_count=2',
        'sec-fetch-site': 'same-origin',
        'user-agent': 'Mozilla/5.0 (Linux; Android 14)',
      },
      remoteAddress: '203.0.113.7',
      payload: form({ shown: 'digest', name: 'Ayesha Khan', phone: '0300 1234567' }),
    });
    expect([placed.statusCode, placed.headers.location]).toEqual([303, '/checkouts/c-secret']);
    expect(placed.headers['set-cookie']).toBe(
      'cart_count=0; Max-Age=1209600; Path=/; SameSite=Lax',
    );
    // With where the shopper placed it from, which the order keeps.
    expect(core.pages).toEqual([
      { token: 'c-secret', form: null },
      {
        token: 'c-secret',
        form: { shown: 'digest', name: 'Ayesha Khan', phone: '0300 1234567' },
        client: { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (Linux; Android 14)' },
      },
    ]);

    // With the IDs the shop's Meta pixel gave the browser, for the order's conversions (ADR-144).
    await app.inject({
      method: 'POST',
      url: '/checkouts/c-secret',
      headers: {
        ...FORM,
        cookie: '_fbp=fb.1.1727856000000.1116446470; _fbc=fb.1.1727856000000.IwAR2x; _fbx=1',
        'sec-fetch-site': 'same-origin',
        'user-agent': 'Mozilla/5.0 (Linux; Android 14)',
      },
      remoteAddress: '203.0.113.7',
      payload: form({ shown: 'digest' }),
    });
    expect(core.pages.pop()!.client).toEqual({
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (Linux; Android 14)',
      browserIds: { fbp: 'fb.1.1727856000000.1116446470', fbc: 'fb.1.1727856000000.IwAR2x' },
    });

    // Its number proved by a code: the browser keeps the proof the core gives, for /checkouts
    // alone, and sends it with its next orders, which need not ask again (ADR-199).
    core.page = { placed: true, proof: 'p-token-0123456789abcdef' };
    const proved = await app.inject({
      method: 'POST',
      url: '/checkouts/c-secret',
      headers: { ...FORM, 'sec-fetch-site': 'same-origin' },
      payload: form({ shown: 'digest', code: '123456' }),
    });
    expect(proved.headers['set-cookie']).toEqual([
      'cart_count=0; Max-Age=1209600; Path=/; SameSite=Lax',
      'hatti_proved=p-token-0123456789abcdef; Path=/checkouts; Max-Age=2592000; HttpOnly; SameSite=Lax',
    ]);
    await app.inject({
      method: 'POST',
      url: '/checkouts/c-secret',
      headers: {
        ...FORM,
        cookie: 'cart_count=1; hatti_proved=p-token-0123456789abcdef',
        'sec-fetch-site': 'same-origin',
      },
      remoteAddress: '203.0.113.7',
      payload: form({ shown: 'digest' }),
    });
    expect(core.pages.pop()!.client).toMatchObject({ proof: 'p-token-0123456789abcdef' });
    core.pages.pop();

    // Paying the order online: on to the shop's gateway, as the core says (ADR-152).
    core.page = { placed: false, redirect: 'https://getsafepay.com/checkout/pay?beacon=track_1' };
    const pay = await app.inject({
      method: 'POST',
      url: '/checkouts/c-secret',
      headers: { ...FORM, 'sec-fetch-site': 'same-origin' },
      payload: form({ action: 'pay' }),
    });
    expect([pay.statusCode, pay.headers.location]).toEqual([
      303,
      'https://getsafepay.com/checkout/pay?beacon=track_1',
    ]);
    expect(pay.headers['referrer-policy']).toBe('no-referrer');
    expect(pay.headers['set-cookie']).toBeUndefined();
    expect(core.pages.pop()!.form).toEqual({ action: 'pay' });

    // Orders are placed from the shop's own pages; and the core may be away.
    const crossSite = await app.inject({
      method: 'POST',
      url: '/checkouts/c-secret',
      headers: { ...FORM, 'sec-fetch-site': 'cross-site' },
      payload: form({ shown: 'digest' }),
    });
    expect(crossSite.statusCode).toBe(403);
    expect(core.pages).toHaveLength(2);
    core.page = new StorefrontApiError(502, 'Bad gateway');
    const down = await app.inject({
      method: 'GET',
      url: '/checkouts/c-secret',
      headers: { host: 'localhost' },
    });
    expect([down.statusCode, down.headers['cache-control']]).toEqual([503, 'no-store']);
    await app.close();
  });

  it("reads a shopper's photo into a search, and sends them to its page (SRC-07, ADR-870)", async () => {
    const app = server();
    const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
    const send = (payload: unknown, url = '/search/photo') =>
      app.inject({
        method: 'POST',
        url,
        headers: { host: 'localhost', 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });
    core.photoRead = { query: 'lawn suit', productIds: ['p1'] };
    const read = await send({ image: `data:image/png;base64,${PNG}` });
    expect([read.statusCode, read.headers['cache-control'], read.json()]).toEqual([
      200,
      'private, no-store',
      { location: '/search?q=lawn+suit&type=product' },
    ]);
    expect(core.photos).toEqual([
      { shopId: 'sample', request: { image: PNG, mediaType: 'image/png' } },
    ]);
    // In Urdu at its Urdu address; a photo of no product is said to be one.
    core.photoRead = { query: null, productIds: [] };
    const none = await send({ image: `data:image/jpeg;base64,${PNG}` }, '/ur/search/photo');
    expect(none.json()).toEqual({
      message: 'اس تصویر میں کوئی چیز نظر نہیں آئی۔ براہ کرم کوئی اور تصویر آزمائیں۔',
    });
    // What is not a photo never reaches the core, nor a photo too large.
    for (const image of ['data:image/svg+xml;base64,PHN2Zy8+', 'not a photo', 42]) {
      expect((await send({ image })).statusCode).toBe(400);
    }
    const large = await send({ image: `data:image/png;base64,${'A'.repeat(2_100_000)}` });
    expect(large.statusCode).toBe(413);
    expect(core.photos).toHaveLength(2);
    // The shop reads no photos, or no more today.
    core.photoRead = { refused: 'unavailable' };
    const off = await send({ image: `data:image/png;base64,${PNG}` });
    expect([off.statusCode, off.json()]).toEqual([
      503,
      { message: 'Search by photo is not available just now.' },
    ]);
    core.photoRead = { refused: 'too_many' };
    expect((await send({ image: `data:image/png;base64,${PNG}` })).statusCode).toBe(429);
    core.photoRead = new StorefrontApiError(502, 'Bad gateway');
    expect((await send({ image: `data:image/png;base64,${PNG}` })).statusCode).toBe(503);
    await app.close();
  });

  it("finds the shop's pages and articles beside its products, as asked, and suggests them (ADR-212)", async () => {
    const app = server();
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: 'localhost' } });
    const [product] = sampleStore().products;
    core.found = [product!.id];
    core.foundContent = { pageIds: ['pg-returns'], articleIds: ['art-eid'] };
    const found = await get('/search?q=eid');
    expect(found.statusCode).toBe(200);
    expect(found.body).toContain('3 results for “eid”');
    // Products, then pages, then articles, each said what it is.
    const grid = found.body.slice(found.body.indexOf('<ul class="grid" role="list">'));
    const order = [
      `/products/${product!.handle}`,
      '/pages/returns',
      '/blogs/news/eid-lawn-is-here',
    ].map((url) => grid.indexOf(`href="${url}`));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(found.body).toMatch(
      /<p class="search__kind">Page<\/p>\s*<h2 dir="auto"><a href="\/pages\/returns">Returns and exchanges<\/a><\/h2>\s*<p dir="auto">Changed your mind\?/,
    );
    expect(found.body).toContain('<p class="search__kind">Article</p>');
    expect(core.contentSearches).toEqual([
      { shopId: 'sample', terms: 'eid', options: { prefix: 'none', types: ['page', 'article'] } },
    ]);
    // Shopify's `type` says which kinds: products alone, or articles alone.
    await get('/search?q=eid&type=product');
    expect([core.searches.length, core.contentSearches.length]).toEqual([2, 1]);
    const articles = await get('/search?q=eid&type=article');
    expect([core.searches.length, core.contentSearches.at(-1)!.options.types]).toEqual([
      2,
      ['article'],
    ]);
    expect(articles.body).toContain('1 result for “eid”');

    // Suggested as Shopify's predictive search gives them, when asked for.
    const json = await get(
      '/search/suggest.json?q=eid&resources%5Btype%5D=product,page,article&resources%5Blimit%5D=2',
    );
    const results = (json.json() as { resources: { results: Record<string, unknown[]> } }).resources
      .results;
    expect(Object.keys(results)).toEqual(['products', 'pages', 'articles']);
    expect(results.pages).toEqual([
      expect.objectContaining({
        id: 'pg-returns',
        title: 'Returns and exchanges',
        url: '/pages/returns',
      }),
    ]);
    expect(results.articles).toEqual([
      expect.objectContaining({
        id: 'art-eid',
        url: '/blogs/news/eid-lawn-is-here',
        author: 'Ayesha Khan',
        tags: ['Eid', 'Lawn'],
      }),
    ]);
    expect(core.contentSearches.at(-1)!.options).toEqual({
      prefix: 'last',
      limit: 2,
      types: ['page', 'article'],
    });
    // Shopify's default kinds leave articles out; products alone ask nothing of the rest.
    const asked = core.contentSearches.length;
    await get('/search/suggest.json?q=eid&resources%5Btype%5D=product');
    expect(core.contentSearches).toHaveLength(asked);
    const section = await get(
      '/search/suggest?q=eid&section_id=predictive-search&resources%5Btype%5D=product,page,article',
    );
    expect(section.body).toMatch(
      /<a href="\/pages\/returns" class="predictive-search__link" tabindex="-1">\s*<span class="predictive-search__title" dir="auto">Returns and exchanges<\/span>\s*<span class="predictive-search__kind">Page<\/span>/,
    );
    expect(section.body).toContain('href="/blogs/news/eid-lawn-is-here"');
    await app.close();
  });

  it("searches the shop through the core, and shows what it found in the theme's search page", async () => {
    const app = server();
    core.found = sampleStore()
      .products.slice(0, 3)
      .map((product) => product.id);
    const found = await app.inject({
      method: 'GET',
      url: '/search?q=+Eid+lawn++',
      headers: { host: 'localhost' },
    });
    expect(found.statusCode).toBe(200);
    expect(found.body).toContain('3 results for “Eid lawn”');
    expect(core.searches).toEqual([
      { shopId: 'sample', terms: 'Eid lawn', options: { prefix: 'none' } },
    ]);
    // In Urdu too; without words, nothing to ask the core.
    const urdu = await app.inject({
      method: 'GET',
      url: '/ur/search?q=lawn',
      headers: { host: 'localhost' },
    });
    expect(urdu.body).toContain('کے لیے 3 نتائج');
    const blank = await app.inject({
      method: 'GET',
      url: '/search?q=+',
      headers: { host: 'localhost' },
    });
    expect(blank.statusCode).toBe(200);
    expect(core.searches).toHaveLength(2);
    // As Shopify's forms ask: the last word may be cut short.
    await app.inject({
      method: 'GET',
      url: '/search?q=kame&options%5Bprefix%5D=last',
      headers: { host: 'localhost' },
    });
    expect(core.searches[2]!.options).toEqual({ prefix: 'last' });
    // What the core cannot answer is said as such.
    core.found = new StorefrontApiError(502, 'Bad gateway');
    const down = await app.inject({
      method: 'GET',
      url: '/search?q=lawn',
      headers: { host: 'localhost' },
    });
    expect([down.statusCode, down.body]).toEqual([
      503,
      'Search cannot be reached just now. Please try again in a minute.\n',
    ]);
    await app.close();
  });

  it("suggests products as a shopper types, as JSON or in the theme's section", async () => {
    const app = server();
    const products = sampleStore().products;
    core.found = products.slice(0, 12).map((product) => product.id);
    const suggest = (url: string) =>
      app.inject({ method: 'GET', url, headers: { host: 'localhost' } });

    // Shopify's JSON: products, and nothing yet of the other kinds asked for.
    const json = await suggest(
      '/search/suggest.json?q=lawn&resources%5Btype%5D=product,collection&resources%5Blimit%5D=2',
    );
    expect(json.statusCode).toBe(200);
    expect(json.headers['content-type']).toMatch(/^application\/json/);
    expect(json.headers['cache-control']).toBe('public, max-age=0, s-maxage=60');
    const { results } = (json.json() as { resources: { results: Record<string, unknown[]> } })
      .resources;
    expect(Object.keys(results)).toEqual(['products', 'collections']);
    expect(results.collections).toEqual([]);
    const [first] = results.products as Record<string, unknown>[];
    const doc = products[0]!;
    expect(results.products).toHaveLength(2);
    expect(first).toMatchObject({
      id: doc.id,
      title: doc.title,
      handle: doc.handle,
      url: `/products/${doc.handle}`,
      available: true,
      price: `${Math.min(...doc.variants.map((v) => v.price)) / 100}.00`,
    });
    // Twice as many asked of the core, for the sold out to go last; the last word cut short.
    expect(core.searches.at(-1)).toEqual({
      shopId: 'sample',
      terms: 'lawn',
      options: { prefix: 'last', limit: 4 },
    });

    // The theme's section, in the page's language.
    const section = await suggest('/ur/search/suggest?q=lawn&section_id=predictive-search');
    expect(section.statusCode).toBe(200);
    expect(section.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(section.body).toMatch(/^<div id="hatti-section-predictive-search"/);
    expect(section.body).toContain('“lawn” تلاش کریں');
    expect((section.body.match(/role="option"/g) ?? []).length).toBe(11);

    // A section the theme has not, or none; nothing typed asks the core nothing.
    expect((await suggest('/search/suggest?q=lawn&section_id=nothing')).statusCode).toBe(404);
    expect((await suggest('/search/suggest?q=lawn')).statusCode).toBe(404);
    const asked = core.searches.length;
    const blank = await suggest('/search/suggest.json?q=+');
    expect(blank.json()).toEqual({
      resources: { results: { queries: [], products: [], collections: [], pages: [] } },
    });
    expect(core.searches).toHaveLength(asked);

    // The core not there: said as such, as JSON to scripts.
    core.found = new StorefrontApiError(502, 'Bad gateway');
    const down = await suggest('/search/suggest.json?q=lawn');
    expect([down.statusCode, down.json()]).toEqual([
      503,
      {
        status: 503,
        message: 'Service Unavailable',
        description: 'Search cannot be reached just now. Please try again in a minute.',
      },
    ]);
    await app.close();
  });

  it('shows the theme a preview link names on every page until the link ends, and never keeps it', async () => {
    const app = server();
    core.previews.set(PREVIEW_TOKEN, previewing('Winter <look>', 'Winter Sale'));
    const kept = `hatti_preview=${PREVIEW_TOKEN}`;
    const get = (url: string, cookie?: string) =>
      app.inject({ method: 'GET', url, headers: { host: 'localhost', ...(cookie && { cookie }) } });

    // The link: the theme, and a cookie that keeps it for the link's hour.
    const opened = await get(`/?preview=${PREVIEW_TOKEN}`);
    expect(opened.statusCode).toBe(200);
    expect(opened.body).toContain('Winter Sale');
    expect(opened.body).toContain('Preview: <strong>Winter &lt;look&gt;</strong>');
    expect(opened.headers['cache-control']).toBe('private, no-store');
    expect(opened.headers['x-robots-tag']).toBe('noindex');
    expect(opened.headers['cache-tag']).toBeUndefined();
    expect(opened.headers['set-cookie']).toMatch(
      new RegExp(`^${kept}; Max-Age=35\\d\\d; Path=/; SameSite=Lax; HttpOnly$`),
    );
    // The pages after it, in Urdu too, their sections and the search page: the cookie's theme.
    const urdu = await get('/ur/', kept);
    expect(urdu.body).toContain('Winter Sale');
    expect(urdu.body).toContain('پیش منظر بند کریں');
    expect(urdu.headers['set-cookie']).toBeUndefined();
    // Staff previewing are no shoppers: their visits are not kept (ADR-139).
    expect(urdu.body).not.toContain('data-hatti-visits');
    const section = await get('/?section_id=banner', kept);
    expect([section.statusCode, section.body]).toEqual([200, expect.stringContaining('Winter')]);
    expect((await get('/search', kept)).headers['cache-control']).toBe('private, no-store');
    // Without it, the shop's own theme, kept at the edge as ever.
    const live = await get('/');
    expect(live.body).not.toContain('Winter Sale');
    expect(live.body).not.toContain('hatti-preview-bar');
    expect(live.headers['cache-control']).toMatch(/^public/);
    // Its head keeps the shopper's visits, in their browser: the page is still everyone's.
    expect(live.body).toMatch(/<head>[^]*<script data-hatti-visits>[^]*hatti_visits=[^]*<\/head>/);

    // `?preview=` with nothing ends it; so does a link that shows nothing any more.
    const ended = await get('/?preview=', kept);
    expect(ended.body).not.toContain('Winter Sale');
    expect(ended.headers['set-cookie']).toMatch(/^hatti_preview=; Max-Age=0; Path=\//);
    core.previews.delete(PREVIEW_TOKEN);
    const over = await get('/', kept);
    expect([over.statusCode, over.body]).toEqual([200, expect.not.stringContaining('Winter')]);
    expect(over.headers['set-cookie']).toMatch(/^hatti_preview=; Max-Age=0/);
    // It sets a cookie, so it is not kept, though it is the page everyone sees.
    expect([over.headers['cache-control'], over.headers['cache-tag']]).toEqual([
      'private, no-store',
      undefined,
    ]);
    // What no core would have sealed is not sent to it.
    const asked = core.previewsAsked.length;
    expect((await get('/?preview=%3Cscript%3E')).statusCode).toBe(200);
    expect(core.previewsAsked).toHaveLength(asked);
    await app.close();
  });

  it("serves the pictures a shop's themes show at its own address, and in a preview any of its pictures (ADR-326)", async () => {
    const app = server();
    const SHOWN = 'file_01k7c3d3t0pqrxwzw8x9a2b4c5';
    const CHOSEN = 'file_01k7c3d3t0pqrxwzw8x9a2b4c6';
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    core.themeImages.set(`sample ${SHOWN}`, { body: jpeg, contentType: 'image/jpeg' });
    core.otherImages.set(`sample ${CHOSEN}`, { body: jpeg, contentType: 'image/jpeg' });
    const get = (url: string, cookie?: string) =>
      app.inject({ method: 'GET', url, headers: { host: 'localhost', ...(cookie && { cookie }) } });

    const shown = await get(`/theme-images/${SHOWN}/Eid-banner.jpg`);
    expect([
      shown.statusCode,
      shown.headers['content-type'],
      shown.headers['cache-control'],
      shown.headers['x-content-type-options'],
    ]).toEqual([200, 'image/jpeg', 'public, max-age=3600', 'nosniff']);
    expect(new Uint8Array(shown.rawPayload)).toEqual(jpeg);
    expect((await get(`/theme-images/${SHOWN}`)).statusCode).toBe(200);
    // One no theme shows yet: none, but for a page in a preview, which is the shopper's alone.
    const none = await get(`/theme-images/${CHOSEN}/x.jpg`);
    expect([none.statusCode, none.headers['cache-control']]).toEqual([404, 'public, max-age=60']);
    core.previews.set(PREVIEW_TOKEN, previewing('Winter', 'Winter Sale'));
    const previewed = await get(`/theme-images/${CHOSEN}/x.jpg`, `hatti_preview=${PREVIEW_TOKEN}`);
    expect([previewed.statusCode, previewed.headers['cache-control']]).toEqual([
      200,
      'private, no-store',
    ]);
    expect(core.themeImagesAsked).toEqual([
      { shopId: 'sample', file: SHOWN, preview: false },
      { shopId: 'sample', file: SHOWN, preview: false },
      { shopId: 'sample', file: CHOSEN, preview: false },
      { shopId: 'sample', file: CHOSEN, preview: true },
    ]);
    // What is no file's ID is not asked about.
    for (const url of ['/theme-images/eid.jpg', '/theme-images/file_x/eid.jpg']) {
      expect((await get(url)).statusCode, url).toBe(404);
    }
    expect(core.themeImagesAsked).toHaveLength(4);
    // The width a theme's image_url asks for, and the formats the browser takes, go on to the
    // core, which makes it so (ADR-538); a width that is no width does not.
    const sized = await app.inject({
      method: 'GET',
      url: `/theme-images/${SHOWN}/Eid-banner.jpg?width=360`,
      headers: { host: 'localhost', accept: 'image/avif,image/webp,*/*' },
    });
    expect([sized.statusCode, sized.headers.vary]).toEqual([200, 'Accept']);
    await get(`/theme-images/${SHOWN}/Eid-banner.jpg?width=wide`);
    expect(core.themeImagesAsked.slice(4)).toEqual([
      {
        shopId: 'sample',
        file: SHOWN,
        preview: false,
        width: 360,
        accept: 'image/avif,image/webp,*/*',
      },
      { shopId: 'sample', file: SHOWN, preview: false },
    ]);
    await app.close();
  });

  it("puts a preview in design mode in the theme editor's frame, and renders its unsaved settings", async () => {
    const EDITOR = 'https://admin.hatti.pk';
    const app = server({ editorOrigins: [EDITOR] });
    core.previews.set(PREVIEW_TOKEN, previewing('Winter', 'Winter Sale'));
    const kept = `hatti_preview=${PREVIEW_TOKEN}`;
    const page = (headers: Record<string, string>) =>
      app.inject({ method: 'GET', url: '/', headers: { host: 'localhost', ...headers } });

    // The link opened in the editor's frame: kept in the frame's own cookie.
    const linked = await app.inject({
      method: 'GET',
      url: `/?preview=${PREVIEW_TOKEN}`,
      headers: { host: 'localhost', 'sec-fetch-dest': 'iframe' },
    });
    expect(linked.headers['set-cookie']).toMatch(
      /; Path=\/; SameSite=None; Secure; Partitioned; HttpOnly$/,
    );
    // Framed, as the editor frames it: design mode, and no bar; the editor alone may frame it.
    const framed = await page({ cookie: kept, 'sec-fetch-dest': 'iframe' });
    expect(framed.body).toContain('data-hatti-editor-section=');
    expect(framed.body).toContain('window.Shopify.designMode = true');
    expect(framed.body).not.toContain('hatti-preview-bar');
    expect(framed.body).not.toContain('data-hatti-visits');
    expect(framed.headers['content-security-policy']).toBe(`frame-ancestors ${EDITOR}`);
    expect(framed.headers['cache-control']).toBe('private, no-store');
    // Opened on its own, or framed without a preview: no design mode.
    const opened = await page({ cookie: kept });
    expect(opened.body).toContain('hatti-preview-bar');
    expect(opened.body).not.toContain('data-hatti-editor');
    expect((await page({ 'sec-fetch-dest': 'iframe' })).body).not.toContain('data-hatti-editor');

    // Its script renders a section again with the editor's unsaved files over the theme's.
    const ask = (body: unknown, headers: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: '/editor/sections',
        headers: {
          host: 'localhost',
          cookie: kept,
          'x-hatti-editor': '1',
          'sec-fetch-site': 'same-origin',
          ...headers,
        },
        payload: body as Record<string, unknown>,
      });
    const unsaved = { 'templates/index.json': bannerHome('Unsaved Eid') };
    const rendered = await ask({ page: '/?x=1', sections: ['banner'], files: unsaved });
    expect(rendered.statusCode).toBe(200);
    expect(rendered.headers['cache-control']).toBe('private, no-store');
    const answer = rendered.json() as { sections: Record<string, string>; problems: string[] };
    expect(answer.problems).toEqual([]);
    expect(answer.sections.banner).toMatch(
      /^<div id="hatti-section-banner" class="hatti-section section-image-banner" data-hatti-editor-section=/,
    );
    expect(answer.sections.banner).toContain('Unsaved Eid');
    // What the storefront cannot use is said, and the saved file stands.
    const broken = await ask({
      page: '/',
      sections: ['banner', 'nothing'],
      files: { 'templates/index.json': '{ not json', 'layout/theme.liquid': '<html>' },
    });
    const told = broken.json() as { sections: Record<string, string | null>; problems: string[] };
    expect(told.sections.banner).toContain('Winter Sale');
    expect(told.sections.nothing).toBeNull();
    expect(told.problems).toHaveLength(2);
    expect(told.problems.join(' ')).toMatch(
      /templates\/index\.json.*layout\/theme\.liquid|layout\/theme\.liquid.*templates\/index\.json/s,
    );

    // The layout's CSS, marked in design mode alone, with the theme's settings the editor has
    // not saved: no section needed (ADR-700).
    expect(framed.body).toContain('<style data-hatti data-hatti-layout>');
    expect(opened.body).not.toContain('data-hatti-layout');
    const settings = JSON.stringify({ current: { color_accent: '#B91C1C', page_width: 1400 } });
    const styled = await ask({
      page: '/',
      sections: [],
      files: { 'config/settings_data.json': settings },
      styles: true,
    });
    expect(styled.statusCode).toBe(200);
    const css = (styled.json() as { sections: object; styles: string[] }).styles;
    expect(css).toHaveLength(1);
    expect(css[0]).toContain('--color-accent: #B91C1C;');
    expect(css[0]).toContain('--page-width: 1400px;');
    expect(css[0]).not.toContain('<style');
    // Asked for sections alone, none.
    expect((rendered.json() as { styles?: unknown }).styles).toBeUndefined();

    // Only the editor's script asks: with its header, from the page, in a preview.
    const good = { page: '/', sections: ['banner'], files: unsaved };
    expect((await ask(good, { 'x-hatti-editor': '' })).statusCode).toBe(403);
    expect((await ask(good, { 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect((await ask(good, { cookie: '' })).statusCode).toBe(403);
    for (const bad of [
      { ...good, page: 'https://evil.pk/' },
      { ...good, sections: [] },
      { ...good, sections: ['a', 'b', 'c', 'd', 'e', 'f'] },
      { ...good, sections: ['<script>'] },
      { ...good, files: { 'templates/index.json': 1 } },
      { ...good, styles: 'yes' },
      { ...good, sections: [], styles: false },
    ]) {
      expect((await ask(bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    await app.close();

    // Without an editor's origin, no preview is framed or rendered for one.
    const plain = server();
    core.previews.set(PREVIEW_TOKEN, previewing('Winter', 'Winter Sale'));
    const alone = await plain.inject({
      method: 'GET',
      url: '/',
      headers: { host: 'localhost', cookie: kept, 'sec-fetch-dest': 'iframe' },
    });
    expect(alone.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(alone.body).not.toContain('data-hatti-editor');
    const refused = await plain.inject({
      method: 'POST',
      url: '/editor/sections',
      headers: { host: 'localhost', cookie: kept, 'x-hatti-editor': '1' },
      payload: good,
    });
    expect(refused.statusCode).toBe(403);
    await plain.close();
  });

  it('tells crawlers what to fetch, and lists every product, collection, page, blog and article in sitemaps', async () => {
    const app = server();
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: 'localhost' } });
    const sample = sampleStore();
    const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

    const robots = await get('/robots.txt');
    expect(robots.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(robots.headers['cache-control']).toBe('public, max-age=0, s-maxage=3600');
    for (const line of ['Disallow: /cart', 'Disallow: /ur/search', 'Disallow: /*?*preview=']) {
      expect(robots.body.split('\n')).toContain(line);
    }
    expect(robots.body).toMatch(/\nSitemap: http:\/\/localhost\/sitemap\.xml\n$/);

    const index = await get('/sitemap.xml');
    expect(index.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(locs(index.body)).toEqual([
      'http://localhost/sitemaps/products-1.xml',
      'http://localhost/sitemaps/collections-1.xml',
      'http://localhost/sitemaps/pages-1.xml',
      'http://localhost/sitemaps/blogs-1.xml',
      'http://localhost/sitemaps/articles-1.xml',
    ]);
    const products = (await get('/sitemaps/products-1.xml')).body;
    expect(locs(products)).toHaveLength(sample.products.length);
    // Each with its image, whole (ADR-236).
    const pictured = sample.products.find((product) => product.images.length > 0)!;
    const handle = pictured.handle;
    expect(products).toContain('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"');
    expect(products).toContain(
      `<url><loc>http://localhost/products/${handle}</loc>` +
        `<xhtml:link rel="alternate" hreflang="en" href="http://localhost/products/${handle}"/>` +
        `<xhtml:link rel="alternate" hreflang="ur" href="http://localhost/ur/products/${handle}"/>` +
        `<image:image><image:loc>http://localhost${pictured.images[0]!.src}</image:loc>` +
        '</image:image></url>',
    );
    expect(locs((await get('/sitemaps/collections-1.xml')).body)).toHaveLength(
      sample.collections.length,
    );
    // The pages', with the home page first, in Urdu at /ur; each page with when it was
    // published, as it has not changed since.
    const pages = (await get('/sitemaps/pages-1.xml')).body;
    expect(locs(pages)[0]).toBe('http://localhost/');
    expect(pages).toContain('hreflang="ur" href="http://localhost/ur"/>');
    expect(locs(pages)).toHaveLength(1 + sample.pages!.length);
    const published = sample.pages![0]!;
    expect(pages).toContain(
      `<loc>http://localhost/pages/${published.handle}</loc>` +
        `<lastmod>${published.publishedAt.replace(/\.\d+(?=Z$)/, '')}</lastmod>`,
    );
    // The index says when the last of each file's addresses changed (ADR-608).
    const latest = sample
      .pages!.map((page) => page.publishedAt)
      .sort()
      .at(-1)!;
    expect(index.body).toContain(
      '<sitemap><loc>http://localhost/sitemaps/pages-1.xml</loc>' +
        `<lastmod>${latest.replace(/\.\d+(?=Z$)/, '')}</lastmod></sitemap>`,
    );
    // Blogs, and articles at their blog's address and theirs (ADR-177).
    expect(locs((await get('/sitemaps/blogs-1.xml')).body)).toEqual([
      'http://localhost/blogs/news',
    ]);
    expect(locs((await get('/sitemaps/articles-1.xml')).body)).toEqual([
      'http://localhost/blogs/news/eid-lawn-is-here',
      'http://localhost/blogs/news/how-to-measure',
      'http://localhost/blogs/news/winter-shawls',
    ]);
    for (const missing of ['/sitemaps/products-2.xml', '/sitemaps/blogs-2.xml', '/sitemaps/x']) {
      expect((await get(missing)).statusCode, missing).toBe(404);
    }
    await app.close();

    // When a product last changed, to the second, after its address.
    const changed = server({
      sample: new MemoryStore({
        ...sample,
        products: sample.products.map((product, at) =>
          at === 0 ? { ...product, updatedAt: '2026-10-06T09:41:12.345Z' } : product,
        ),
      }),
    });
    const dated = (
      await changed.inject({
        method: 'GET',
        url: '/sitemaps/products-1.xml',
        headers: { host: 'localhost' },
      })
    ).body;
    expect(dated).toContain(
      `<loc>http://localhost/products/${sample.products[0]!.handle}</loc>` +
        '<lastmod>2026-10-06T09:41:12Z</lastmod>',
    );
    await changed.close();

    // The shop's own rules: those for every crawler join the platform's, its groups follow.
    const ruled = server({
      sample: new MemoryStore({
        ...sample,
        shop: {
          ...sample.shop,
          robotsRules: [
            '# The sale is not ready',
            'Disallow: /collections/sale',
            '',
            'User-agent: GPTBot',
            'Disallow: /',
            'Sitemap: https://zari.pk/lookbook.xml',
          ].join('\n'),
        },
      }),
    });
    const text = (
      await ruled.inject({ method: 'GET', url: '/robots.txt', headers: { host: 'localhost' } })
    ).body;
    expect(text).toContain(
      'Disallow: /*?*sections=\n# The sale is not ready\nDisallow: /collections/sale\n\n' +
        'User-agent: GPTBot\nDisallow: /\n\n' +
        'Sitemap: http://localhost/sitemap.xml\nSitemap: https://zari.pk/lookbook.xml\n',
    );
    expect(text.startsWith('User-agent: *\n')).toBe(true);
    await ruled.close();
  });

  it('makes the shop installable: its manifest, icon, worker and offline page (ADR-832)', async () => {
    const app = server();
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: 'localhost' } });
    const shop = sampleStore().shop;

    // Every shopper's page names the manifest and registers the worker.
    const home = await get('/');
    expect(home.body).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(home.body).toContain('navigator.serviceWorker.register("/sw.js")');
    expect((await get('/ur')).body).toContain('href="/manifest.webmanifest?locale=ur"');

    const manifest = await get('/manifest.webmanifest');
    expect([manifest.statusCode, manifest.headers['content-type']]).toEqual([
      200,
      'application/manifest+json; charset=utf-8',
    ]);
    expect(manifest.headers['cache-control']).toBe('public, max-age=0, s-maxage=3600');
    expect(manifest.json()).toMatchObject({
      name: shop.name,
      short_name: shortNameOf(shop.name),
      start_url: '/',
      scope: '/',
      display: 'standalone',
      lang: 'en',
      // No square logo: an icon of its initial.
      icons: [{ src: '/pwa-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
    });
    expect((await get('/manifest.webmanifest?locale=ur')).json()).toMatchObject({
      start_url: '/ur',
      lang: 'ur',
      dir: 'rtl',
    });
    const icon = await get('/pwa-icon.svg');
    expect(icon.headers['content-type']).toBe('image/svg+xml');
    expect(icon.body).toContain(`>${shop.name[0]!.toUpperCase()}</text>`);

    // Asked for afresh, so a new worker reaches browsers at once.
    const worker = await get('/sw.js');
    expect([worker.headers['content-type'], worker.headers['cache-control']]).toEqual([
      'text/javascript; charset=utf-8',
      'no-cache',
    ]);
    expect(worker.body).toContain('const OFFLINE = "/offline";');

    const offline = await get('/offline');
    expect(offline.statusCode).toBe(200);
    expect(offline.body).toContain('Connect to the internet to keep shopping.');
    expect(offline.body).toContain('آپ آف لائن ہیں');
    expect(offline.headers['content-security-policy']).toContain("default-src 'none'");
    expect(offline.headers['x-robots-tag']).toBe('noindex');
  });

  it("gives Google's and Meta's catalogs the shop's products, an item a variant", async () => {
    const app = server();
    const feed = await app.inject({
      method: 'GET',
      url: PRODUCT_FEED_PATH,
      headers: { host: 'localhost' },
    });
    // Kept at the edge as sitemaps are, and forgotten with the shop's document.
    expect([
      feed.statusCode,
      feed.headers['content-type'],
      feed.headers['cache-control'],
      feed.headers['cache-tag'],
    ]).toEqual([
      200,
      'application/xml; charset=utf-8',
      'public, max-age=0, s-maxage=3600',
      'hatti:sample',
    ]);
    expect([...feed.body.matchAll(/<item>/g)]).toHaveLength(
      sample.products.reduce((count, product) => count + product.variants.length, 0),
    );
    expect(feed.body).toContain(
      `<g:link>http://localhost/products/${lawn.handle}?variant=${variant.id}</g:link>`,
    );
    expect(feed.body.endsWith('</channel>\n</rss>\n')).toBe(true);
    const missing = await app.inject({
      method: 'GET',
      url: PRODUCT_FEED_PATH,
      headers: { host: 'nobody.localhost' },
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it('serves buy buttons for other websites: the script, and each product as any site may read it (CH-08)', async () => {
    const app = server();
    const script = await app.inject({
      method: 'GET',
      url: '/buy-button.js',
      headers: { host: 'localhost' },
    });
    expect([script.statusCode, script.headers['content-type']]).toEqual([
      200,
      'text/javascript; charset=utf-8',
    ]);
    expect(script.body).toContain('[data-hatti-buy-button]');
    const product = sample.products.find((each) => each.images.length > 0)!;
    const read = await app.inject({
      method: 'GET',
      url: `/buy-button/products/${product.handle}`,
      headers: { host: 'localhost', origin: 'https://blog.example.pk' },
    });
    expect(read.statusCode).toBe(200);
    expect(read.headers['access-control-allow-origin']).toBe('*');
    const body = read.json() as {
      handle: string;
      url: string;
      currency: string;
      image: { src: string } | null;
      variants: { id: string; price: string }[];
    };
    expect(body).toMatchObject({
      handle: product.handle,
      url: `http://localhost/products/${product.handle}`,
      currency: 'PKR',
    });
    expect(body.image?.src).toMatch(/^http:\/\/localhost\//);
    expect(body.variants[0]).toMatchObject({
      id: product.variants[0]!.id,
      price: (product.variants[0]!.price / 100).toFixed(2),
    });
    const missing = await app.inject({
      method: 'GET',
      url: '/buy-button/products/no-such-thing',
      headers: { host: 'localhost' },
    });
    expect([missing.statusCode, missing.headers['access-control-allow-origin']]).toEqual([
      404,
      '*',
    ]);
    // A collection, as its embed shows it: its first products, in its order (ADR-925).
    const collection = sample.collections.find((each) => each.productIds.length > 0)!;
    const embed = await app.inject({
      method: 'GET',
      url: `/buy-button/collections/${collection.handle}`,
      headers: { host: 'localhost', origin: 'https://blog.example.pk' },
    });
    expect([embed.statusCode, embed.headers['access-control-allow-origin']]).toEqual([200, '*']);
    const shown = embed.json() as { title: string; url: string; products: { handle: string }[] };
    expect(shown).toMatchObject({
      title: collection.title,
      url: `http://localhost/collections/${collection.handle}`,
    });
    const handles = new Map(sample.products.map((each) => [each.id, each.handle]));
    expect(shown.products.map((each) => each.handle)).toEqual(
      collection.productIds.slice(0, 12).map((id) => handles.get(id)),
    );
    // Its next page, and the page after its last empty (ADR-937).
    const page = async (asked: string) =>
      (
        await app.inject({
          method: 'GET',
          url: `/buy-button/collections/${collection.handle}?page=${asked}`,
          headers: { host: 'localhost' },
        })
      ).json() as { products: { handle: string }[]; next: number | null };
    const pages = Math.ceil(collection.productIds.length / 12);
    expect((await page('1')).next).toBe(pages > 1 ? 2 : null);
    expect((await page(String(pages + 1))).products).toEqual([]);
    // A page that is no page is the first.
    expect((await page('nope')).products.map((each) => each.handle)).toEqual(
      shown.products.map((each) => each.handle),
    );
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/buy-button/collections/no-such-thing',
          headers: { host: 'localhost' },
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });

  it('answers AI shopping agents: its UCP profile and its store MCP endpoint (OS-23, ADR-847)', async () => {
    const app = server();
    const profile = await app.inject({
      method: 'GET',
      url: '/.well-known/ucp',
      headers: { host: 'localhost' },
    });
    expect([profile.statusCode, profile.headers['cache-control']]).toEqual([
      200,
      'public, max-age=0, s-maxage=3600',
    ]);
    expect(profile.json().ucp.services['dev.ucp.shopping'][0].endpoint).toBe(
      'http://localhost/api/mcp',
    );
    const rpc = (body: unknown, headers: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: '/api/mcp',
        headers: { host: 'localhost', 'content-type': 'application/json', ...headers },
        payload: JSON.stringify(body),
      });
    core.found = [lawn.id];
    const searched = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'search_catalog', arguments: { catalog: { query: 'lawn' } } },
    });
    expect([searched.statusCode, searched.headers['cache-control']]).toEqual([200, 'no-store']);
    expect(searched.json().result.structuredContent.products[0].url).toBe(
      `http://localhost/products/${lawn.handle}`,
    );
    expect(core.searches.at(-1)).toMatchObject({ terms: 'lawn' });
    // A notification has no answer; GET streams nothing; and it takes JSON alone.
    expect((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).statusCode).toBe(
      202,
    );
    expect(
      (await app.inject({ method: 'GET', url: '/api/mcp', headers: { host: 'localhost' } }))
        .statusCode,
    ).toBe(405);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/mcp',
          headers: { host: 'localhost', 'content-type': 'text/plain' },
          payload: '{}',
        })
      ).statusCode,
    ).toBe(415);
    await app.close();
  });

  it('keeps AI agents out where the shop says, its profile and endpoint answering none (ADR-908)', async () => {
    const docs = sampleStore();
    docs.shop = { ...docs.shop, agentsBlocked: true };
    const app = server({ sample: new MemoryStore(docs) });
    const profile = await app.inject({
      method: 'GET',
      url: '/.well-known/ucp',
      headers: { host: 'localhost' },
    });
    const rpc = await app.inject({
      method: 'POST',
      url: '/api/mcp',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect([profile.statusCode, rpc.statusCode]).toEqual([404, 404]);
    await app.close();
  });

  it("answers the Storefront API with the shop's tokens, and checks its carts out (DEV-02, ADR-848)", async () => {
    const docs = sampleStore();
    docs.shop = {
      ...docs.shop,
      storefrontTokens: [
        { digest: createHash('sha256').update('hsf_public').digest('hex'), private: false },
      ],
    };
    const app = server({ sample: new MemoryStore(docs) });
    const api = (headers: Record<string, string>, body: unknown = { query: '{ shop { name } }' }) =>
      app.inject({
        method: 'POST',
        url: '/api/2026-10/graphql.json',
        headers: { host: 'localhost', 'content-type': 'application/json', ...headers },
        payload: JSON.stringify(body),
      });
    expect((await api({})).statusCode).toBe(401);
    expect((await api({ 'x-shopify-storefront-access-token': 'nope' })).statusCode).toBe(401);
    const answered = await api({ 'x-shopify-storefront-access-token': 'hsf_public' });
    expect([answered.statusCode, answered.headers['access-control-allow-origin']]).toEqual([
      200,
      '*',
    ]);
    expect(answered.json()).toEqual({ data: { shop: { name: docs.shop.name } } });
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/2026-10/graphql.json',
      headers: { host: 'localhost' },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-headers']).toContain(
      'x-shopify-storefront-access-token',
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v9/graphql.json',
          headers: { host: 'localhost', 'content-type': 'application/json' },
          payload: '{}',
        })
      ).statusCode,
    ).toBe(404);

    // A cart it made, taken to checkout: kept as the shopper's cart, and sent on.
    core.kept.set('headless-cart', cartOf(1));
    const checkout = await app.inject({
      method: 'GET',
      url: '/cart/c/headless-cart',
      headers: { host: 'localhost' },
    });
    expect([checkout.statusCode, checkout.headers.location]).toEqual([303, '/checkouts/c-secret']);
    expect(String(checkout.headers['set-cookie'])).toContain('cart=headless-cart');
    const gone = await app.inject({
      method: 'GET',
      url: '/cart/c/gone',
      headers: { host: 'localhost' },
    });
    expect([gone.statusCode, gone.headers.location]).toEqual([303, '/cart']);
    await app.close();
  });

  it("gives a blog's Atom feed at its address with .atom, kept at the edge as its page is (ADR-209)", async () => {
    const app = server();
    const get = (url: string, host = 'localhost') =>
      app.inject({ method: 'GET', url, headers: { host } });
    const feed = await get('/blogs/news.atom');
    // Forgotten with the shop's document and the blog's, which an article's change purges.
    expect([
      feed.statusCode,
      feed.headers['content-type'],
      feed.headers['cache-control'],
      feed.headers['cache-tag'],
    ]).toEqual([
      200,
      'application/atom+xml; charset=utf-8',
      'public, max-age=0, s-maxage=300, stale-while-revalidate=86400, stale-if-error=604800',
      'hatti:sample,hatti:sample:blog:news',
    ]);
    expect(feed.body).toContain('<title>Zari Fashions - News</title>');
    expect(feed.body).toContain(
      '<link rel="self" type="application/atom+xml" href="http://localhost/blogs/news.atom"/>',
    );
    expect(
      [...feed.body.matchAll(/<link rel="alternate" type="text\/html" href="([^"]+)"/g)].map(
        (m) => m[1],
      ),
    ).toEqual([
      'http://localhost/blogs/news',
      'http://localhost/blogs/news/eid-lawn-is-here',
      'http://localhost/blogs/news/how-to-measure',
      'http://localhost/blogs/news/winter-shawls',
    ]);
    expect(feed.body.endsWith('</entry>\n</feed>\n')).toBe(true);
    // No such blog, no such handle, and no such shop.
    for (const [url, host] of [
      ['/blogs/journal.atom', 'localhost'],
      ['/blogs/news.notes.atom', 'localhost'],
      ['/blogs/news.atom', 'nobody.localhost'],
    ] as const) {
      expect((await get(url, host)).statusCode, url).toBe(404);
    }
    // The blog's page is still its page.
    expect((await get('/blogs/news')).headers['content-type']).toBe('text/html; charset=utf-8');

    // In Urdu at its Urdu page's address, linking the Urdu pages, kept and forgotten as it is
    // (ADR-623); and linked from its Urdu page.
    const urdu = await get('/ur/blogs/news.atom');
    expect([urdu.statusCode, urdu.headers['content-type'], urdu.headers['cache-tag']]).toEqual([
      200,
      'application/atom+xml; charset=utf-8',
      'hatti:sample,hatti:sample:blog:news',
    ]);
    expect(urdu.body).toContain('<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="ur">');
    expect(urdu.body).toContain(
      '<link rel="self" type="application/atom+xml" href="http://localhost/ur/blogs/news.atom"/>',
    );
    expect(
      [...urdu.body.matchAll(/<link rel="alternate" type="text\/html" href="([^"]+)"/g)].map(
        (m) => m[1],
      ),
    ).toEqual([
      'http://localhost/ur/blogs/news',
      'http://localhost/ur/blogs/news/eid-lawn-is-here',
      'http://localhost/ur/blogs/news/how-to-measure',
      'http://localhost/ur/blogs/news/winter-shawls',
    ]);
    expect((await get('/ur/blogs/journal.atom')).statusCode).toBe(404);
    expect((await get('/ur/blogs/news')).body).toMatch(
      /<link rel="alternate" type="application\/atom\+xml" title="[^"]+" href="\/ur\/blogs\/news\.atom">/,
    );
    expect((await get('/blogs/news')).body).toMatch(
      /<link rel="alternate" type="application\/atom\+xml" title="[^"]+" href="\/blogs\/news\.atom">/,
    );
    await app.close();
  });

  it("gives a collection's Atom feed at its address with .atom, forgotten with it or any product (ADR-216)", async () => {
    const app = server();
    const get = (url: string, host = 'localhost') =>
      app.inject({ method: 'GET', url, headers: { host } });
    const feed = await get('/collections/eid-lawn.atom');
    // Forgotten with the collection's document, and with any product's, which purges all's.
    expect([
      feed.statusCode,
      feed.headers['content-type'],
      feed.headers['cache-control'],
      feed.headers['cache-tag'],
    ]).toEqual([
      200,
      'application/atom+xml; charset=utf-8',
      'public, max-age=0, s-maxage=300, stale-while-revalidate=86400, stale-if-error=604800',
      'hatti:sample,hatti:sample:collection:eid-lawn,hatti:sample:collection:all',
    ]);
    expect(feed.body).toContain(
      '<link rel="self" type="application/atom+xml" href="http://localhost/collections/eid-lawn.atom"/>',
    );
    const entries = [...feed.body.matchAll(/<entry>/g)].length;
    expect(entries).toBeGreaterThan(0);
    expect(entries).toBeLessThanOrEqual(50);
    expect(feed.body.endsWith('</entry>\n</feed>\n')).toBe(true);
    const all = await get('/collections/all.atom');
    expect([all.statusCode, all.headers['cache-tag']]).toEqual([
      200,
      'hatti:sample,hatti:sample:collection:all',
    ]);
    // No such collection, no such handle, and no such shop.
    for (const [url, host] of [
      ['/collections/silk.atom', 'localhost'],
      ['/collections/eid-lawn.x.atom', 'localhost'],
      ['/collections/eid-lawn.atom', 'nobody.localhost'],
    ] as const) {
      expect((await get(url, host)).statusCode, url).toBe(404);
    }
    // The collection's page is still its page, and links its feed.
    const page = await get('/collections/eid-lawn');
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.body).toMatch(
      /<link rel="alternate" type="application\/atom\+xml" title="Zari Fashions - [^"]+" href="\/collections\/eid-lawn\.atom">/,
    );

    // In Urdu at its Urdu page's address, linked from that page (ADR-623).
    const urdu = await get('/ur/collections/eid-lawn.atom');
    expect([urdu.statusCode, urdu.headers['cache-tag']]).toEqual([
      200,
      'hatti:sample,hatti:sample:collection:eid-lawn,hatti:sample:collection:all',
    ]);
    expect(urdu.body).toContain(
      '<link rel="self" type="application/atom+xml" href="http://localhost/ur/collections/eid-lawn.atom"/>',
    );
    expect(urdu.body).toMatch(
      /<entry>\n<id>[^<]+<\/id>\n<published>[^<]+<\/published>\n<updated>[^<]+<\/updated>\n<link rel="alternate" type="text\/html" href="http:\/\/localhost\/ur\/products\//,
    );
    expect((await get('/ur/collections/silk.atom')).statusCode).toBe(404);
    expect((await get('/ur/collections/eid-lawn')).body).toMatch(
      /<link rel="alternate" type="application\/atom\+xml" title="[^"]+" href="\/ur\/collections\/eid-lawn\.atom">/,
    );
    await app.close();
  });

  it("shows the shop's policies at Shopify's addresses, in its theme, and links them from the footer", async () => {
    const sample = sampleStore();
    const app = server({
      sample: new MemoryStore({
        ...sample,
        shop: { ...sample.shop, policies: ['refund_policy', 'shipping_policy'] },
        policies: {
          refund_policy: '<p>7 days.</p>',
          shipping_policy: '<p>Rs 250.</p>',
          // In Urdu, as the shop wrote it (ADR-239).
          'ur:refund_policy': '<p>سات دن۔</p>',
        },
      }),
    });
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: 'localhost' } });

    const refund = await get('/policies/refund-policy');
    expect(refund.statusCode).toBe(200);
    expect(refund.body).toContain(
      '<div class="shopify-policy__container"><div class="shopify-policy__title">' +
        '<h1>Refund policy</h1></div><div class="shopify-policy__body">' +
        '<div class="rte" dir="auto"><p>7 days.</p></div></div></div>',
    );
    expect(refund.body).toMatch(/<title>Refund policy · /);
    expect(refund.headers['cache-control']).toMatch(/^public/);
    const urdu = await get('/ur/policies/refund-policy');
    expect(urdu.body).toContain('<h1>واپسی کی پالیسی</h1>');
    expect(urdu.body).toContain('dir="rtl"');
    // Its Urdu where the shop gave it, else its own words.
    expect(urdu.body).toContain('<div class="rte" dir="auto"><p>سات دن۔</p></div>');
    expect(refund.body).not.toContain('سات دن');
    expect((await get('/ur/policies/shipping-policy')).body).toContain('<p>Rs 250.</p>');
    // One the shop has not set, or none by the name, is not found.
    expect((await get('/policies/privacy-policy')).statusCode).toBe(404);
    expect((await get('/policies/returns')).statusCode).toBe(404);

    // Every page's footer lists them, in Shopify's order, in the page's language.
    const home = (await get('/')).body;
    expect(home).toContain(
      '<ul class="footer__policies" role="list"><li><a href="/policies/refund-policy">Refund policy</a>' +
        '</li><li><a href="/policies/shipping-policy">Shipping policy</a></li></ul>',
    );
    expect((await get('/ur')).body).toContain(
      'href="/ur/policies/shipping-policy">ترسیل کی پالیسی<',
    );
    await app.close();
  });

  it("shows the shop's link page at /links, in its theme, a product with nothing to choose a tap from checkout (ADR-161)", async () => {
    const sample = sampleStore();
    const [several, one, out] = sample.products as [ProductDoc, ProductDoc, ProductDoc];
    const single: ProductDoc = {
      ...one,
      variants: [{ ...one.variants[0]!, available: true, price: 250_000, compareAtPrice: 300_000 }],
    };
    const soldOut: ProductDoc = {
      ...out,
      variants: out.variants.map((variant) => ({ ...variant, available: false })),
    };
    const app = server({
      sample: new MemoryStore({
        ...sample,
        products: sample.products.map((product) =>
          product.id === single.id ? single : product.id === soldOut.id ? soldOut : product,
        ),
        shop: {
          ...sample.shop,
          linkPage: {
            bio: 'Lawn & khussas <handmade>.\nCash on delivery.',
            links: [
              { title: 'Eid sale', url: '/collections/eid-lawn' },
              { title: 'Instagram', url: 'https://www.instagram.com/zari.pk' },
            ],
            // One no longer on sale is left out.
            productIds: [single.id, 'p-gone', several.id, soldOut.id],
          },
        },
      }),
    });
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: 'localhost' } });
    // Its links go through the storefront, to be counted (ADR-204).
    const [eid, instagram, whatsapp] = [
      linkKey('/collections/eid-lawn'),
      linkKey('https://www.instagram.com/zari.pk'),
      linkKey('https://wa.me/923001234567'),
    ];

    const page = await get('/links');
    expect(page.statusCode).toBe(200);
    expect(page.body).toMatch(/<title>Zari Fashions<\/title>/);
    expect(page.body).toContain(
      '<div class="hatti-links"><h1 class="hatti-links__name" dir="auto">Zari Fashions</h1>' +
        '<p class="hatti-links__bio" dir="auto">Lawn &amp; khussas &lt;handmade&gt;.\n' +
        'Cash on delivery.</p><ul class="hatti-links__links" role="list">' +
        '<li><a class="button button--secondary hatti-links__link" ' +
        `href="/links/to/${eid}" dir="auto">Eid sale</a></li>` +
        '<li><a class="button button--secondary hatti-links__link" ' +
        `href="/links/to/${instagram}" dir="auto">Instagram</a></li>` +
        '<li><a class="button button--secondary hatti-links__link" ' +
        `href="/links/to/${whatsapp}" dir="auto">Chat on WhatsApp</a></li></ul>`,
    );
    const items = [...page.body.matchAll(/<li class="hatti-links__product">(.*?)<\/li>/g)].map(
      (match) => match[1]!,
    );
    expect(items).toHaveLength(3);
    expect(items[0]).toContain(`<a class="card__link" href="/products/${single.handle}">`);
    expect(items[0]).toContain(
      '<div class="price price--sale"><span class="visually-hidden">Sale price</span>' +
        '<span class="price__amount">Rs 2,500</span>' +
        '<span class="visually-hidden">Regular price</span>' +
        '<s class="price__compare">Rs 3,000</s></div>' +
        `<a class="button hatti-links__buy" href="/cart/${single.variants[0]!.id}:1">Buy now</a>`,
    );
    expect(items[1]).toContain(
      `<a class="button button--secondary hatti-links__buy" href="/products/${several.handle}">` +
        'Choose options</a>',
    );
    expect(items[2]).toContain('aria-disabled="true">Sold out</span>');
    expect(page.body).toContain(
      '<p class="hatti-links__all"><a href="/collections/all">See all products</a></p>',
    );
    // Kept at the edge until the shop or any of its products changes.
    expect(page.headers['cache-control']).toMatch(/^public/);
    expect(String(page.headers['cache-tag']).split(',')).toEqual(
      expect.arrayContaining(['hatti:sample', 'hatti:sample:collection:all']),
    );

    // In Urdu, its paths on the shop stay in Urdu.
    const urdu = await get('/ur/links');
    expect(urdu.body).toContain('dir="rtl"');
    expect(urdu.body).toContain(`href="/ur/links/to/${eid}"`);
    expect(urdu.body).toContain(`href="/ur/links/to/${instagram}"`);
    expect(urdu.body).toContain(`href="/ur/cart/${single.variants[0]!.id}:1">ابھی خریدیں</a>`);
    expect(urdu.body).toContain('<a href="/ur/collections/all">تمام مصنوعات دیکھیں</a>');

    // A shop that set none has its name, its WhatsApp, and its products.
    const plain = server();
    const bare = await plain.inject({
      method: 'GET',
      url: '/links',
      headers: { host: 'localhost' },
    });
    expect(bare.statusCode).toBe(200);
    expect(bare.body).toContain(`href="/links/to/${whatsapp}"`);
    expect(bare.body).not.toContain('hatti-links__products');
    await plain.close();
    await app.close();
  });

  it('shows a product of the link page with its variant chosen, a tap from checkout (ADR-206)', async () => {
    const sample = sampleStore();
    const several = sample.products.find((product) => product.variants.length > 1)!;
    const [first, second, ...rest] = several.variants;
    // Its own price, on sale, and its own image.
    const chosen = { ...second!, price: 525_000, compareAtPrice: 600_000, image: 1 };
    const image = { src: '/images/products/rose-suit.jpg', width: 0, height: 0, alt: 'Rose suit' };
    const item = async (variantIds: (string | null)[], available = true) => {
      const product: ProductDoc = {
        ...several,
        images: [several.images[0]!, image],
        variants: [first!, { ...chosen, available }, ...rest],
      };
      const app = server({
        sample: new MemoryStore({
          ...sample,
          products: sample.products.map((each) => (each.id === product.id ? product : each)),
          shop: {
            ...sample.shop,
            linkPage: { bio: '', links: [], productIds: [product.id], variantIds },
          },
        }),
      });
      const page = await app.inject({
        method: 'GET',
        url: '/links',
        headers: { host: 'localhost' },
      });
      await app.close();
      return page.body.match(/<li class="hatti-links__product">(.*?)<\/li>/)![1]!;
    };
    const shown = await item([chosen.id]);
    expect(shown).toContain(
      `<a class="card__link" href="/products/${several.handle}?variant=${chosen.id}">`,
    );
    expect(shown).toContain('src="/images/products/rose-suit.jpg');
    expect(shown).toContain(
      `</h2><p class="hatti-links__variant" dir="auto">${chosen.title}</p></a>`,
    );
    expect(shown).toContain(
      '<div class="price price--sale"><span class="visually-hidden">Sale price</span>' +
        '<span class="price__amount">Rs 5,250</span>' +
        '<span class="visually-hidden">Regular price</span>' +
        '<s class="price__compare">Rs 6,000</s></div>' +
        `<a class="button hatti-links__buy" href="/cart/${chosen.id}:1">Buy now</a>`,
    );
    // Sold out, it says so; a variant gone since is as none chosen.
    expect(await item([chosen.id], false)).toContain('aria-disabled="true">Sold out</span>');
    const gone = await item(['v-gone']);
    expect(gone).toContain(`<a class="card__link" href="/products/${several.handle}">`);
    expect(gone).toContain('Choose options</a>');
    expect(gone).not.toContain('hatti-links__variant');
  });

  it("shows the shop's square logo atop its link page, else its logo, else neither (ADR-205)", async () => {
    const sample = sampleStore();
    const logo = 'https://api.hatti.pk/logos/s1?v=0a1b2c3d';
    const square = 'https://api.hatti.pk/logos/s1/square?v=4e5f6a7b';
    const page = async (brand: ShopDoc['brand']) => {
      const app = server({
        sample: new MemoryStore({ ...sample, shop: { ...sample.shop, ...(brand && { brand }) } }),
      });
      const response = await app.inject({
        method: 'GET',
        url: '/links',
        headers: { host: 'localhost' },
      });
      await app.close();
      return response.body;
    };
    expect(await page({ logo, squareLogo: square })).toContain(
      '<div class="hatti-links"><img class="hatti-links__image hatti-links__image--square" ' +
        `src="${square}" alt="" width="96" height="96"><h1 class="hatti-links__name"`,
    );
    expect(await page({ logo, squareLogo: null })).toContain(
      '<div class="hatti-links"><img class="hatti-links__image" ' +
        `src="${logo}" alt="" width="96" height="96"><h1 class="hatti-links__name"`,
    );
    expect(await page(undefined)).toContain(
      '<div class="hatti-links"><h1 class="hatti-links__name"',
    );
  });

  it("sends a tap on the link page's links on to where it goes, in the page's language, never kept (ADR-204)", async () => {
    const sample = sampleStore();
    const app = server({
      sample: new MemoryStore({
        ...sample,
        shop: {
          ...sample.shop,
          linkPage: {
            bio: '',
            links: [
              { title: 'Eid sale', url: '/collections/eid-lawn' },
              { title: 'Instagram', url: 'https://www.instagram.com/zari.pk' },
            ],
            productIds: [],
          },
        },
      }),
    });
    const tap = async (url: string, host = 'localhost') => {
      const response = await app.inject({ method: 'GET', url, headers: { host } });
      return [response.statusCode, response.headers.location, response.headers['cache-control']];
    };
    const [eid, instagram, whatsapp] = [
      linkKey('/collections/eid-lawn'),
      linkKey('https://www.instagram.com/zari.pk'),
      linkKey('https://wa.me/923001234567'),
    ];
    expect(eid).toMatch(/^[0-9a-f]{12}$/);
    expect(await tap(`/links/to/${eid}`)).toEqual([
      302,
      '/collections/eid-lawn',
      'private, no-store',
    ]);
    expect(await tap(`/links/to/${instagram}`)).toEqual([
      302,
      'https://www.instagram.com/zari.pk',
      'private, no-store',
    ]);
    expect(await tap(`/links/to/${whatsapp}`)).toEqual([
      302,
      'https://wa.me/923001234567',
      'private, no-store',
    ]);
    // From the page in Urdu, the shop's own paths stay in Urdu.
    expect((await tap(`/ur/links/to/${eid}`))[1]).toBe('/ur/collections/eid-lawn');
    expect((await tap(`/ur/links/to/${instagram}`))[1]).toBe('https://www.instagram.com/zari.pk');
    // Only the shop's own links: any other key, as of a link since taken off, is back at the page.
    expect(await tap('/links/to/0123456789ab')).toEqual([302, '/links', 'private, no-store']);
    expect((await tap(`/ur/links/to/${linkKey('https://evil.example')}`))[1]).toBe('/ur/links');
    // No shop answers here.
    expect((await tap(`/links/to/${eid}`, 'nobody.localhost'))[0]).toBe(404);
    await app.close();
  });

  it('sends shoppers on from addresses the shop has no page at, where its redirects point', async () => {
    const EDITOR = 'https://admin.hatti.pk';
    const app = server({
      editorOrigins: [EDITOR],
      sample: new MemoryStore({
        ...sampleStore(),
        redirects: {
          '/products/old-lawn': `/products/${lawn.handle}`,
          '/collections/sale': '/',
          '/blogs/news/eid-edit': 'https://instagram.com/zari',
          '/pages/رابطہ': '/pages/contact',
          '/pages/contact-us': '/pages/رابطہ#form',
          // A chain, followed to its end in one hop (ADR-617).
          '/sale-2024': '/sale-2025?ref=old',
          '/sale-2025': '/collections/sale',
          // A page is there: it is shown, never hidden by a redirect.
          [`/products/${lawn.handle}`]: '/collections/all',
        },
      }),
    });
    const get = (url: string, headers: Record<string, string> = {}) =>
      app.inject({ method: 'GET', url, headers: { host: 'localhost', ...headers } });
    const answer = async (url: string) => {
      const response = await get(url);
      return [response.statusCode, response.headers.location];
    };

    const moved = await get('/products/old-lawn/?utm_source=facebook');
    expect([moved.statusCode, moved.headers.location]).toEqual([
      301,
      `/products/${lawn.handle}?utm_source=facebook`,
    ]);
    // Kept at the edge until the redirect changes, or a product takes the handle.
    expect(moved.headers['cache-control']).toMatch(/^public, max-age=0, s-maxage=300/);
    expect(String(moved.headers['cache-tag']).split(',')).toEqual([
      'hatti:sample',
      'hatti:sample:product:old-lawn',
      pathTag('sample', '/products/old-lawn'),
    ]);
    // However the link wrote the path; in Urdu, to the page in Urdu.
    expect(await answer('/PRODUCTS//Old-Lawn')).toEqual([301, `/products/${lawn.handle}`]);
    expect(await answer('/ur/products/old-lawn')).toEqual([301, `/ur/products/${lawn.handle}`]);
    expect(await answer('/ur/collections/sale?page=2')).toEqual([301, '/ur?page=2']);
    expect(await answer('/ur/blogs/news/eid-edit')).toEqual([301, 'https://instagram.com/zari']);
    expect(await answer('/pages/%D8%B1%D8%A7%D8%A8%D8%B7%DB%81')).toEqual([301, '/pages/contact']);
    // On through the Urdu address, which has no page, to the page it sends shoppers to, keeping
    // the part of the page named on the way (ADR-617).
    expect(await answer('/pages/contact-us')).toEqual([301, '/pages/contact#form']);
    const chained = await get('/sale-2024?utm_source=sms');
    expect([chained.statusCode, chained.headers.location]).toEqual([301, '/?utm_source=sms']);
    expect(String(chained.headers['cache-tag']).split(',')).toEqual(
      expect.arrayContaining([
        pathTag('sample', '/sale-2024'),
        pathTag('sample', '/sale-2025'),
        pathTag('sample', '/collections/sale'),
      ]),
    );
    expect(await answer('/ur/sale-2024')).toEqual([301, '/ur']);
    expect(await answer(`/products/${lawn.handle}`)).toEqual([200, undefined]);
    expect(await answer('/blogs/news/other')).toEqual([404, undefined]);

    // In a preview, followed but not kept; in the editor's frame, the 404 page, to change it.
    core.previews.set(PREVIEW_TOKEN, previewing('Winter', 'Winter Sale'));
    const cookie = `hatti_preview=${PREVIEW_TOKEN}`;
    const previewed = await get('/products/old-lawn', { cookie });
    expect([previewed.statusCode, previewed.headers['cache-control']]).toEqual([
      301,
      'private, no-store',
    ]);
    const framed = await get('/products/old-lawn', { cookie, 'sec-fetch-dest': 'iframe' });
    expect(framed.statusCode).toBe(404);
    expect(framed.body).toContain('data-hatti-editor-section=');
    await app.close();
  });

  it('shows a shop closed behind its password nothing but its password page, until a shopper gives it', async () => {
    const verifier = await passwordVerifier('eid-2026');
    const sample = sampleStore();
    const app = server({
      sample: new MemoryStore({
        ...sample,
        shop: { ...sample.shop, password: { verifier, message: '<p>Opening on Chand Raat.</p>' } },
      }),
    });
    const get = (url: string, cookie?: string) =>
      app.inject({ method: 'GET', url, headers: { host: 'localhost', ...(cookie && { cookie }) } });

    // Pages send shoppers to the password page, in their language; scripts are told it is shut.
    const home = await get('/');
    expect([home.statusCode, home.headers.location, home.headers['cache-control']]).toEqual([
      302,
      '/password',
      'private, no-store',
    ]);
    expect((await get(`/ur/products/${lawn.handle}`)).headers.location).toBe('/ur/password');
    expect((await get('/sitemap.xml')).headers.location).toBe('/password');
    expect((await get(PRODUCT_FEED_PATH)).headers.location).toBe('/password');
    expect((await get('/cart.js')).statusCode).toBe(401);
    expect((await get('/?section_id=header')).statusCode).toBe(401);
    // Reporting it to Hatti stays open (ADR-460).
    expect((await get('/report')).statusCode).toBe(200);
    const robots = await get('/robots.txt');
    expect([robots.body, robots.headers['cache-control']]).toEqual([
      'User-agent: *\nDisallow: /\n',
      'private, no-store',
    ]);

    // The theme's password page, with what the shop says: never kept, nor indexed.
    const page = await get('/password');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<p>Opening on Chand Raat.</p>');
    expect(page.body).toContain('action="/password"');
    expect(page.body).not.toContain('aria-invalid');
    expect([page.headers['cache-control'], page.headers['x-robots-tag']]).toEqual([
      'private, no-store',
      'noindex',
    ]);
    expect(page.headers['cache-tag']).toBeUndefined();
    const urdu = await get('/ur/password');
    expect(urdu.body).toContain('action="/ur/password"');
    expect(urdu.body).toContain('یہ دکان جلد کھلے گی');

    // A wrong password is said to be; the right one lets the shopper in, with a pass.
    const post = (password: string, url = '/password') =>
      app.inject({
        method: 'POST',
        url,
        headers: FORM,
        payload: form({ form_type: 'storefront_password', password }),
      });
    const wrong = await post('eid-2025');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).toContain('aria-invalid="true"');
    expect(wrong.body).toContain('That password is not right. Try again.');
    const right = await post(' eid-2026 ', '/ur/password');
    expect([right.statusCode, right.headers.location]).toEqual([303, '/ur']);
    expect(right.headers['set-cookie']).toMatch(
      /^storefront_digest=[\w-]{43}; Max-Age=2592000; Path=\/; SameSite=Lax; HttpOnly$/,
    );
    const pass = String(right.headers['set-cookie']).split(';')[0]!;
    const inside = await get('/', pass);
    expect(inside.statusCode).toBe(200);
    // The shop is still closed to everyone else: nothing of it is kept at the edge.
    expect([inside.headers['cache-control'], inside.headers['cache-tag']]).toEqual([
      'private, no-store',
      undefined,
    ]);
    expect((await get('/password', pass)).headers.location).toBe('/');
    expect((await get('/', 'storefront_digest=forged')).statusCode).toBe(302);

    // Its staff see it through a preview, the password page too, to design it.
    core.previews.set(PREVIEW_TOKEN, previewing('Winter', 'Winter Sale'));
    const preview = `hatti_preview=${PREVIEW_TOKEN}`;
    expect(await get('/', preview)).toMatchObject({ statusCode: 200 });
    expect((await get('/password', preview)).statusCode).toBe(200);
    await app.close();

    // An open shop has no password page.
    const open = server();
    expect(
      (await open.inject({ method: 'GET', url: '/password', headers: { host: 'localhost' } }))
        .headers.location,
    ).toBe('/');
    await open.close();
  });

  it('shows a paused shop its page saying it is back soon, with 503, until the time it set (ADR-252)', async () => {
    const sample = sampleStore();
    const paused = (maintenance: { message: string; until: string | null }) =>
      server({
        sample: new MemoryStore({
          ...sample,
          shop: { ...sample.shop, whatsapp: '+923001234567', maintenance },
        }),
      });
    const until = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const app = paused({
      message: 'Eid break <3>.\n\nOur couriers are off.',
      until: until.toISOString(),
    });
    const get = (url: string, headers: Record<string, string> = {}) =>
      app.inject({ method: 'GET', url, headers: { host: 'localhost', ...headers } });

    // Every page: the page saying so, with 503 and when to ask again, never kept.
    const home = await get('/');
    expect([home.statusCode, home.headers['cache-control']]).toEqual([503, 'private, no-store']);
    expect(Number(home.headers['retry-after'])).toBeGreaterThan(7_100);
    expect(Number(home.headers['retry-after'])).toBeLessThanOrEqual(7_200);
    expect(home.headers['cache-tag']).toBeUndefined();
    expect(home.headers['content-security-policy']).toContain("default-src 'none'");
    expect(home.body).toContain('This shop is taking a short break');
    expect(home.body).toContain('یہ دکان کچھ دیر کے لیے بند ہے');
    expect(home.body).toContain('Eid break &lt;3&gt;.');
    expect(home.body).toContain('It takes orders again from');
    expect(home.body).toContain('href="https://wa.me/923001234567"');
    expect(home.body).toContain('href="/track"');
    const urdu = await get(`/ur/products/${lawn.handle}`);
    expect(urdu.statusCode).toBe(503);
    expect(urdu.body).toContain('href="/ur/track"');
    expect((await get('/pay/abcdefghijklmnopqrstuv')).statusCode).toBe(503);
    // Scripts, sections, feeds and forms are told in a line.
    for (const url of ['/cart.js', '/?section_id=header', PRODUCT_FEED_PATH]) {
      const answer = await get(url);
      expect([answer.statusCode, answer.body], url).toEqual([
        503,
        'This shop is taking a short break.\n',
      ]);
    }
    const added = await app.inject({
      method: 'POST',
      url: '/cart/add',
      headers: FORM,
      payload: form({ id: String(variant.id), quantity: '1' }),
    });
    expect(added.statusCode).toBe(503);
    expect(core.actions).toEqual([]);

    // What crawlers read stays, so that they keep its pages, as do its tracking page, reporting
    // it to Hatti, and checkouts, which the core says are paused, and orders placed before as
    // they were.
    const robots = await get('/robots.txt');
    expect(robots.statusCode).toBe(200);
    expect(robots.body).not.toMatch(/^Disallow: \/$/m);
    expect((await get('/sitemap.xml')).statusCode).toBe(200);
    expect((await get('/track')).statusCode).toBe(200);
    expect((await get('/ur/report')).statusCode).toBe(200);
    core.page = { placed: false, status: 503, headers: {}, html: '<p>Paused</p>' };
    const checkout = await get('/checkouts/abcdefghijklmnopqrstuv');
    expect([checkout.statusCode, checkout.body]).toEqual([503, '<p>Paused</p>']);

    // Its staff see the shop as it is through a preview.
    core.previews.set(PREVIEW_TOKEN, previewing('Winter', 'Winter Sale'));
    expect((await get('/', { cookie: `hatti_preview=${PREVIEW_TOKEN}` })).statusCode).toBe(200);
    await app.close();

    // Without a message or a time, the platform's words and an hour; past its time, open again.
    const soon = paused({ message: '', until: null });
    const answer = await soon.inject({ method: 'GET', url: '/', headers: { host: 'localhost' } });
    expect([answer.statusCode, answer.headers['retry-after']]).toEqual([503, '3600']);
    expect(answer.body).toContain('It takes orders again soon.');
    await soon.close();
    const over = paused({ message: '', until: new Date(Date.now() - 1_000).toISOString() });
    expect(
      (await over.inject({ method: 'GET', url: '/', headers: { host: 'localhost' } })).statusCode,
    ).toBe(200);
    await over.close();
  });

  it("serves its pages where the pause is checkout's alone, the storefront open to browse (ADR-603)", async () => {
    const sample = sampleStore();
    const app = server({
      sample: new MemoryStore({
        ...sample,
        shop: {
          ...sample.shop,
          maintenance: { message: 'Back after Eid.', until: null, checkoutOnly: true },
        },
      }),
    });
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: 'localhost' } });
    const home = await get('/');
    expect(home.statusCode).toBe(200);
    expect(home.body).not.toContain('This shop is taking a short break');
    // Each page says checkout is paused, and why (ADR-604).
    expect(home.body).toContain('<strong>Orders are paused for a while.</strong>');
    expect(home.body).toContain('Back after Eid.');
    // Hatti Base says so in its own place too, from shop.checkout_paused, the bar standing aside
    // for it in the browser (ADR-620).
    expect(home.body).toMatch(
      /<div class="checkout-paused" role="status" data-checkout-paused>\s*<strong>Orders are paused for a while\.<\/strong>\s*<span dir="auto">Back after Eid\.<\/span>\s*<span>We take orders again soon\.<\/span>/,
    );
    expect((await get(`/products/${lawn.handle}`)).statusCode).toBe(200);
    expect((await get('/cart.js')).statusCode).toBe(200);
    await app.close();
  });

  it("shows a partner's development store as opening soon, to all but its staff's previews (ADR-504)", async () => {
    const sample = sampleStore();
    const app = server({
      sample: new MemoryStore({ ...sample, shop: { ...sample.shop, development: true } }),
    });
    const get = (url: string, headers: Record<string, string> = {}) =>
      app.inject({ method: 'GET', url, headers: { host: 'localhost', ...headers } });
    for (const url of ['/', `/ur/products/${lawn.handle}`, '/collections/all']) {
      const answer = await get(url);
      expect(
        [answer.statusCode, answer.headers['cache-control'], answer.headers['x-robots-tag']],
        url,
      ).toEqual([503, 'private, no-store', 'noindex']);
      expect(answer.body, url).toContain('This store opens soon');
    }
    expect((await get('/cart.js')).body).toBe('This store opens soon.\n');
    core.previews.set(PREVIEW_TOKEN, previewing('Winter', 'Winter Sale'));
    expect((await get('/', { cookie: `hatti_preview=${PREVIEW_TOKEN}` })).statusCode).toBe(200);
    await app.close();
  });

  it("answers every address of a store Hatti took down with Hatti's page saying so (ADR-461)", async () => {
    const sample = sampleStore();
    const app = server({
      sample: new MemoryStore({
        ...sample,
        shop: { ...sample.shop, suspended: true, password: { verifier: 'x', message: '' } },
      }),
    });
    const get = (url: string, headers: Record<string, string> = {}) =>
      app.inject({ method: 'GET', url, headers: { host: 'localhost', ...headers } });
    for (const url of ['/', `/ur/products/${lawn.handle}`, '/password', '/report', '/track']) {
      const answer = await get(url);
      expect(
        [answer.statusCode, answer.headers['cache-control'], answer.headers['x-robots-tag']],
        url,
      ).toEqual([404, 'private, no-store', 'noindex']);
      expect(answer.body, url).toContain('This store is not available');
      expect(answer.body, url).toContain('یہ دکان دستیاب نہیں ہے');
    }
    expect((await get('/')).headers['content-security-policy']).toContain("default-src 'none'");
    // Scripts, feeds and forms are told in a line, and nothing reaches the core.
    for (const url of ['/cart.js', '/robots.txt', '/sitemap.xml', PRODUCT_FEED_PATH]) {
      const answer = await get(url);
      expect([answer.statusCode, answer.body], url).toEqual([
        404,
        'This store is not available.\n',
      ]);
    }
    const added = await app.inject({
      method: 'POST',
      url: '/cart/add',
      headers: FORM,
      payload: form({ id: String(variant.id), quantity: '1' }),
    });
    expect(added.statusCode).toBe(404);
    expect(core.actions).toEqual([]);
    // Staff's previews show it no more than shoppers.
    core.previews.set(PREVIEW_TOKEN, previewing('Winter', 'Winter Sale'));
    expect((await get('/', { cookie: `hatti_preview=${PREVIEW_TOKEN}` })).statusCode).toBe(404);
    await app.close();
  });

  it('refuses changes from other sites, forgets carts that are gone, and says when the core is not there', async () => {
    const app = server();
    const crossSite = await app.inject({
      method: 'POST',
      url: '/cart/clear',
      headers: { host: 'localhost', 'sec-fetch-site': 'cross-site' },
    });
    expect(crossSite.statusCode).toBe(403);
    expect(core.actions).toEqual([]);

    // A cookie naming a cart the core no longer has: both cookies go.
    const stale = await app.inject({
      method: 'GET',
      url: '/cart',
      headers: { host: 'localhost', cookie: 'cart=expired; cart_count=4' },
    });
    expect(stale.body).toContain('Your cart is empty.');
    expect(stale.headers['set-cookie']).toEqual([
      'cart=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly',
      'cart_count=; Max-Age=0; Path=/; SameSite=Lax',
    ]);

    core.answer = () => new StorefrontApiError(502, 'Bad gateway');
    const down = await app.inject({
      method: 'POST',
      url: '/cart/clear.js',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      payload: {},
    });
    expect([down.statusCode, down.json().status]).toEqual([503, 503]);
    core.answer = () => new TypeError('fetch failed');
    expect(
      (await app.inject({ method: 'POST', url: '/cart/clear', headers: { host: 'localhost' } }))
        .statusCode,
    ).toBe(503);
    await app.close();
  });
  it('sends a sign-up on to the core, then back to its page saying how it went', async () => {
    const app = server();
    const post = (
      fields: Record<string, string>,
      headers: Record<string, string> = {},
      url = '/contact',
    ) =>
      app.inject({ method: 'POST', url, headers: { ...FORM, ...headers }, payload: form(fields) });
    const consent = 'Send me news and offers from Zari Fashions on WhatsApp';
    const signUp = {
      form_type: 'customer',
      'contact[phone]': '0300-1234567',
      'contact[tags]': 'newsletter',
      'contact[consent]': consent,
      return_to: '/#newsletter',
    };
    const taken = await post(signUp);
    expect([taken.statusCode, taken.headers.location, taken.headers['cache-control']]).toEqual([
      303,
      '/?customer_posted=true#newsletter',
      'private, no-store',
    ]);
    expect(core.signUps.map((signedUp) => signedUp.request)).toEqual([
      { phone: '0300-1234567', tags: 'newsletter', consent },
    ]);

    // What was wrong goes back to the page the browser came from, by field.
    core.signedUp = { ok: false, errors: [{ field: 'phone', message: 'Phone is not a mobile' }] };
    const wrong = await post(
      { form_type: 'customer', 'contact[phone]': '123' },
      { referer: 'http://localhost/collections/eid-lawn?page=2&customer_posted=true' },
    );
    expect(wrong.headers.location).toBe('/collections/eid-lawn?page=2&customer_error=phone');
    // In Urdu, with no page of the shop's to go back to, to its home.
    core.signedUp = { ok: true, created: false, subscribed: false };
    const urdu = await post(
      { form_type: 'customer', 'contact[phone]': '0300-1234567' },
      { referer: 'https://elsewhere.example/' },
      '/ur/contact',
    );
    expect(urdu.headers.location).toBe('/ur?customer_posted=true');

    // Another form is not one Hatti takes here, nor a sign-up from another site.
    expect((await post({ form_type: 'other', 'contact[body]': 'Hi' })).statusCode).toBe(404);
    expect((await post(signUp, { 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    core.signedUp = new StorefrontApiError(502, 'Bad gateway');
    expect((await post(signUp)).statusCode).toBe(503);
    expect(core.signUps).toHaveLength(4);
    await app.close();
  });

  it("offers the shop's chat on every page while it is on, and sends its messages on (ADR-811)", async () => {
    const sample = sampleStore();
    // Off: no chat on the page.
    const off = await server().inject({ method: 'GET', url: '/', headers: { host: 'localhost' } });
    expect(off.body).not.toContain('data-web-chat');
    // Hatti's words while the shop wrote none, written once.
    const own = await server({
      sample: new MemoryStore({ ...sample, shop: { ...sample.shop, webChat: { greeting: null } } }),
    }).inject({ method: 'GET', url: '/', headers: { host: 'localhost' } });
    expect(own.body).toContain('Hi! Ask us anything, and we&#39;ll answer here.</p>');
    const app = server({
      sample: new MemoryStore({
        ...sample,
        shop: { ...sample.shop, webChat: { greeting: 'Ask us about <sizes>!' } },
      }),
    });
    const page = await app.inject({ method: 'GET', url: '/', headers: { host: 'localhost' } });
    expect(page.body).toContain('<div class="web-chat" data-web-chat hidden>');
    expect(page.body).toContain(
      '<p class="web-chat__greeting" dir="auto">Ask us about &lt;sizes&gt;!</p>',
    );
    expect(page.body).toMatch(/<script src="[^"]*web-chat\.js[^"]*" defer><\/script>/);
    const urdu = await app.inject({ method: 'GET', url: '/ur', headers: { host: 'localhost' } });
    expect(urdu.body).toContain('<label for="WebChatPhone">آپ کا موبائل نمبر</label>');

    const JSON_POST = { host: 'localhost', 'content-type': 'application/json' };
    const start = await app.inject({
      method: 'POST',
      url: '/chat',
      headers: JSON_POST,
      payload: { name: 'Ayesha', phone: '0300 1234567', body: 'Salam' },
    });
    expect([start.statusCode, start.headers['cache-control']]).toEqual([200, 'private, no-store']);
    expect(start.json()).toEqual({
      messages: [{ from: 'shopper', body: 'Salam', at: '2026-10-27T09:00:00.000Z' }],
    });
    // The session's token in a cookie the page's script never reads.
    const cookie = String(start.headers['set-cookie']);
    expect(cookie).toMatch(/^hatti_chat=T{43}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax/);
    expect(core.chats.at(-1)).toEqual({
      shopId: expect.any(String) as unknown,
      action: 'start',
      request: { name: 'Ayesha', phone: '0300 1234567', body: 'Salam' },
    });
    const session = `hatti_chat=${'T'.repeat(43)}`;
    const wrote = await app.inject({
      method: 'POST',
      url: '/chat/messages',
      headers: { ...JSON_POST, cookie: session },
      payload: { body: 'Medium?' },
    });
    expect([wrote.statusCode, wrote.headers['set-cookie']]).toEqual([200, undefined]);
    expect(core.chats.at(-1)?.request).toEqual({ token: 'T'.repeat(43), body: 'Medium?' });
    const read = await app.inject({
      method: 'GET',
      url: '/chat/messages.json',
      headers: { host: 'localhost', cookie: session },
    });
    expect(read.json().messages).toHaveLength(1);

    // No session yet: nothing to read or write in, and nothing asked of the core.
    const asked = core.chats.length;
    const none = await app.inject({
      method: 'GET',
      url: '/chat/messages.json',
      headers: { host: 'localhost' },
    });
    expect(none.statusCode).toBe(404);
    expect(core.chats).toHaveLength(asked);
    // What the core refuses, said by field.
    core.chatting = {
      ok: false,
      errors: [{ field: 'phone', message: 'Give a Pakistani mobile number' }],
    };
    const wrong = await app.inject({
      method: 'POST',
      url: '/chat',
      headers: JSON_POST,
      payload: { name: 'Ayesha', phone: '12', body: 'Hi' },
    });
    expect([wrong.statusCode, wrong.json()]).toEqual([
      422,
      { errors: [{ field: 'phone', message: 'Give a Pakistani mobile number' }] },
    ]);
    // A session the core no longer knows, or a chat turned off: its cookie goes.
    core.chatting = null;
    const gone = await app.inject({
      method: 'GET',
      url: '/chat/messages.json',
      headers: { host: 'localhost', cookie: session },
    });
    expect(gone.statusCode).toBe(404);
    expect(String(gone.headers['set-cookie'])).toMatch(/^hatti_chat=; Path=\/; Max-Age=0/);
    // From another site, or not JSON: refused.
    const across = await app.inject({
      method: 'POST',
      url: '/chat',
      headers: { ...JSON_POST, 'sec-fetch-site': 'cross-site' },
      payload: { name: 'A', phone: '0300 1234567', body: 'Hi' },
    });
    expect(across.statusCode).toBe(403);
    const formed = await app.inject({
      method: 'POST',
      url: '/chat',
      headers: FORM,
      payload: form({ name: 'A', phone: '0300 1234567', body: 'Hi' }),
    });
    expect(formed.statusCode).toBe(415);
  });

  it("answers the shop's wheel and sends shoppers' spins on (ADR-900)", async () => {
    const app = server();
    const JSON_POST = { host: 'localhost', 'content-type': 'application/json' };
    const wheel = await app.inject({
      method: 'GET',
      url: '/spin.json',
      headers: { host: 'localhost' },
    });
    expect([wheel.statusCode, wheel.headers['cache-control'], wheel.json()]).toEqual([
      200,
      'private, no-store',
      { slices: [{ label: '10% off' }, { label: 'Next time' }] },
    ]);
    const spun = await app.inject({
      method: 'POST',
      url: '/spin',
      headers: JSON_POST,
      payload: { phone: '0300 1234567', consent: 'Yes, send me offers' },
    });
    expect([spun.statusCode, spun.json()]).toEqual([
      200,
      {
        slice: 0,
        label: '10% off',
        code: 'SPIN-ABCD2345',
        endsAt: '2026-11-03T09:00:00.000Z',
        again: false,
      },
    ]);
    expect(core.spins.at(-1)?.request).toEqual({
      phone: '0300 1234567',
      consent: 'Yes, send me offers',
    });
    // What the core refuses, said by field.
    core.spun = { ok: false, errors: [{ field: 'phone', message: 'Give a mobile number' }] };
    const wrong = await app.inject({
      method: 'POST',
      url: '/spin',
      headers: JSON_POST,
      payload: { phone: '12' },
    });
    expect([wrong.statusCode, wrong.json()]).toEqual([
      422,
      { errors: [{ field: 'phone', message: 'Give a mobile number' }] },
    ]);
    // From another site, or not JSON: refused, and nothing asked of the core.
    const asked = core.spins.length;
    const across = await app.inject({
      method: 'POST',
      url: '/spin',
      headers: { ...JSON_POST, 'sec-fetch-site': 'cross-site' },
      payload: { phone: '0300 1234567' },
    });
    const formed = await app.inject({
      method: 'POST',
      url: '/spin',
      headers: FORM,
      payload: form({ phone: '0300 1234567' }),
    });
    expect([across.statusCode, formed.statusCode]).toEqual([403, 415]);
    expect(core.spins).toHaveLength(asked);
    // A shop with no wheel turned on.
    core.wheel = null;
    core.spun = null;
    const none = await app.inject({
      method: 'GET',
      url: '/spin.json',
      headers: { host: 'localhost' },
    });
    const noSpin = await app.inject({
      method: 'POST',
      url: '/spin',
      headers: JSON_POST,
      payload: { phone: '0300 1234567' },
    });
    expect([none.statusCode, noSpin.statusCode]).toEqual([404, 404]);
  });

  it("offers the shop's notifications where Hatti pushes, and passes subscriptions on (ADR-833)", async () => {
    const KEY = `B${'A'.repeat(86)}`;
    // Without Hatti's key, pages offer none.
    const plain = await server().inject({
      method: 'GET',
      url: '/',
      headers: { host: 'localhost' },
    });
    expect(plain.body).not.toContain('data-hatti-push');
    const app = server({
      renderer: new PageRenderer(theme, { limits: { timeMs: 10_000 }, pushPublicKey: KEY }),
    });
    const page = await app.inject({ method: 'GET', url: '/', headers: { host: 'localhost' } });
    expect(page.body).toContain(`<script data-hatti-push>(function(){var key="${KEY}";`);
    // Hatti Base offers them in its footer, once its script finds them off (ADR-836).
    expect(page.body).toContain('<hatti-notifications class="footer__notifications" hidden>');
    expect(page.body).toContain('Get our offers as notifications');

    const JSON_POST = { host: 'localhost', 'content-type': 'application/json' };
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      p256dh: 'B'.repeat(87),
      auth: 'a'.repeat(22),
      locale: 'ur',
    };
    const on = await app.inject({
      method: 'POST',
      url: '/push/subscribe',
      headers: JSON_POST,
      payload: subscription,
    });
    expect([on.statusCode, on.headers['cache-control']]).toEqual([204, 'private, no-store']);
    expect(core.pushes.at(-1)).toEqual({
      shopId: expect.any(String) as unknown,
      action: 'subscribe',
      request: subscription,
    });
    // What the core refuses, said by field; nothing while Hatti pushes nothing.
    core.pushing = { ok: false, errors: [{ field: 'endpoint', message: 'Not a push service' }] };
    const wrong = await app.inject({
      method: 'POST',
      url: '/push/subscribe',
      headers: JSON_POST,
      payload: { ...subscription, endpoint: 'https://evil.example/' },
    });
    expect([wrong.statusCode, wrong.json()]).toEqual([
      422,
      { errors: [{ field: 'endpoint', message: 'Not a push service' }] },
    ]);
    core.pushing = null;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/push/subscribe',
          headers: JSON_POST,
          payload: subscription,
        })
      ).statusCode,
    ).toBe(404);
    const off = await app.inject({
      method: 'POST',
      url: '/push/unsubscribe',
      headers: JSON_POST,
      payload: { endpoint: subscription.endpoint },
    });
    expect(off.statusCode).toBe(204);
    expect(core.pushes.at(-1)).toEqual({
      shopId: expect.any(String) as unknown,
      action: 'unsubscribe',
      request: { endpoint: subscription.endpoint },
    });
    // From another site, or not JSON: refused, and nothing asked of the core.
    const asked = core.pushes.length;
    const across = await app.inject({
      method: 'POST',
      url: '/push/subscribe',
      headers: { ...JSON_POST, 'sec-fetch-site': 'cross-site' },
      payload: subscription,
    });
    const form = await app.inject({
      method: 'POST',
      url: '/push/subscribe',
      headers: { host: 'localhost', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'endpoint=x',
    });
    expect([across.statusCode, form.statusCode]).toEqual([403, 415]);
    expect(core.pushes).toHaveLength(asked);
  });

  it("sends Shopify's contact form on to the core, then back to its page saying how it went (ADR-589)", async () => {
    const app = server();
    const post = (
      fields: Record<string, string>,
      headers: Record<string, string> = {},
      url = '/contact',
    ) =>
      app.inject({
        method: 'POST',
        url,
        headers: { ...FORM, 'user-agent': 'Mozilla/5.0', ...headers },
        payload: form(fields),
      });
    const message = {
      form_type: 'contact',
      'contact[name]': 'Ayesha',
      'contact[phone]': '0300 1234567',
      'contact[body]': 'Is the lawn suit back in medium?',
      'contact[Order number]': '#1042',
      return_to: '/pages/contact#contact_form',
    };
    const taken = await post(message);
    expect([taken.statusCode, taken.headers.location, taken.headers['cache-control']]).toEqual([
      303,
      '/pages/contact?contact_posted=true#contact_form',
      'private, no-store',
    ]);
    expect(core.contactMessages.at(-1)).toEqual({
      shopId: expect.any(String) as unknown,
      request: {
        name: 'Ayesha',
        phone: '0300 1234567',
        body: 'Is the lawn suit back in medium?',
        fields: { 'Order number': '#1042' },
        page: '/pages/contact',
        language: 'en',
        ip: '127.0.0.1',
        userAgent: 'Mozilla/5.0',
      },
    });

    // What was wrong goes back to the page the browser came from, by field, in its language.
    core.messaged = {
      ok: false,
      errors: [
        { field: 'email', message: 'Email or a mobile number is needed' },
        { field: 'body', message: "Body can't be blank" },
      ],
    };
    const wrong = await post(
      { form_type: 'contact', 'contact[body]': '' },
      { referer: 'http://localhost/ur/pages/contact?contact_posted=true' },
      '/ur/contact',
    );
    expect(wrong.headers.location).toBe('/ur/pages/contact?contact_error=email%2Cbody');
    expect(core.contactMessages.at(-1)?.request).toMatchObject({
      body: '',
      fields: {},
      page: '/ur/pages/contact',
      language: 'ur',
    });

    // The page shows how it went: the form's errors, or its thanks.
    const page = (query: string) =>
      app.inject({ method: 'GET', url: `/pages/contact?${query}`, headers: { host: 'localhost' } });
    const shown = await page('contact_error=email,body');
    expect(shown.body).toContain('id="contact_form"');
    expect(shown.body).toContain('Enter your email or mobile number');
    expect(shown.body).toContain('Write your message');
    const thanked = await page('contact_posted=true');
    expect(thanked.body).toContain('Thank you for your message.');
    expect(thanked.body).not.toContain('name="contact[body]"');

    // Not from another site; a core not reached said so.
    expect((await post(message, { 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    core.messaged = new StorefrontApiError(502, 'Bad gateway');
    expect((await post(message)).statusCode).toBe(503);
    expect(core.contactMessages).toHaveLength(3);
    await app.close();
  });

  it('renders the section of related or paired products a product page asks for, kept briefly at the edge (ADR-434, ADR-435)', async () => {
    const sample = sampleStore();
    const [first, second, ...rest] = sample.products;
    const app = server({
      sample: new MemoryStore({
        ...sample,
        products: [
          { ...first!, related: [second!.id], complements: [rest[0]!.id] },
          second!,
          ...rest,
        ],
      }),
    });
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: 'localhost' } });
    const asked = await get(
      `/recommendations/products?section_id=related&product_id=${first!.id}&limit=4`,
    );
    expect([asked.statusCode, asked.headers['cache-control']]).toEqual([
      200,
      'public, max-age=0, s-maxage=60',
    ]);
    expect(asked.body).toMatch(/^<div id="hatti-section-related"/);
    expect(asked.body).toContain(`href="/products/${second!.handle}"`);
    const urdu = await get(
      `/ur/recommendations/products?section_id=related&product_id=${first!.id}`,
    );
    expect([urdu.statusCode, urdu.body.includes(`href="/ur/products/${second!.handle}"`)]).toEqual([
      200,
      true,
    ]);
    // Those the shop pairs with it, where the section asks for them (ADR-435).
    const paired = await get(
      `/recommendations/products?section_id=complementary&product_id=${first!.id}&intent=complementary`,
    );
    expect(paired.body).toMatch(/^<div id="hatti-section-complementary"/);
    expect(paired.body).toContain(`href="/products/${rest[0]!.handle}"`);
    expect(paired.body).not.toContain(`href="/products/${second!.handle}"`);
    // Without a product or a section to render, or for a product the shop has not.
    for (const url of [
      '/recommendations/products?section_id=related',
      `/recommendations/products?product_id=${first!.id}`,
      '/recommendations/products?section_id=related&product_id=p-gone',
      `/recommendations/products?section_id=nothing&product_id=${first!.id}`,
    ]) {
      expect((await get(url)).statusCode).toBe(404);
    }
    await app.close();
  });

  it('sends a wish to hear a variant is back on to the core, then back to its page (ADR-431)', async () => {
    const app = server();
    const post = (
      fields: Record<string, string>,
      headers: Record<string, string> = {},
      url = '/back-in-stock',
    ) =>
      app.inject({ method: 'POST', url, headers: { ...FORM, ...headers }, payload: form(fields) });
    const wish = {
      form_type: 'back_in_stock',
      'contact[variant_id]': 'v-lawn-m',
      'contact[phone]': '0300-1234567',
      return_to: '/products/lawn?variant=v-lawn-m#back-in-stock',
    };
    const taken = await post(wish);
    expect([taken.statusCode, taken.headers.location, taken.headers['cache-control']]).toEqual([
      303,
      '/products/lawn?variant=v-lawn-m&back_in_stock_posted=true#back-in-stock',
      'private, no-store',
    ]);
    // In Urdu, it is asked in Urdu; what was wrong goes back by field.
    core.watched = {
      ok: false,
      errors: [{ field: 'phone', message: 'Enter a Pakistani mobile number' }],
    };
    const wrong = await post(
      {
        ...wish,
        'contact[phone]': '123',
        return_to: '/ur/products/lawn?back_in_stock_posted=true',
      },
      {},
      '/ur/back-in-stock',
    );
    expect(wrong.headers.location).toBe('/ur/products/lawn?back_in_stock_error=phone');
    expect(core.stockWatches.map((watched) => watched.request)).toEqual([
      { variantId: 'v-lawn-m', phone: '0300-1234567', language: 'en' },
      { variantId: 'v-lawn-m', phone: '123', language: 'ur' },
    ]);

    // Only Hatti's form, and from the shop itself.
    expect((await post({ ...wish, form_type: 'customer' })).statusCode).toBe(404);
    expect((await post(wish, { 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    core.watched = new StorefrontApiError(502, 'Bad gateway');
    expect((await post(wish)).statusCode).toBe(503);
    expect(core.stockWatches).toHaveLength(3);
    await app.close();
  });

  it("reports the store to Hatti from its own page, then gives the report's number (ADR-460)", async () => {
    const app = server();
    const get = (url: string, headers: Record<string, string> = {}) =>
      app.inject({ method: 'GET', url, headers: { host: 'localhost', ...headers } });
    const post = (
      fields: Record<string, string>,
      headers: Record<string, string> = {},
      url = '/report',
    ) =>
      app.inject({ method: 'POST', url, headers: { ...FORM, ...headers }, payload: form(fields) });

    // Hatti's page, never kept, with the page the shopper came from.
    const page = await get('/report', { referer: 'http://localhost/products/lawn?variant=2' });
    expect([page.statusCode, page.headers['cache-control']]).toEqual([200, 'private, no-store']);
    expect(page.headers['content-security-policy']).toContain("form-action 'self'");
    expect(page.body).toContain('Report this store');
    expect(page.body).toContain('اس دکان کی شکایت کریں');
    expect(page.body).toContain('<form method="post" action="/report">');
    expect(page.body).toContain('name="from" value="/products/lawn?variant=2"');
    expect(page.body).toContain('<option value="never_delivered"');
    expect((await get('/ur/report')).body).toContain('action="/ur/report"');

    const report = {
      reason: 'never_delivered',
      details: 'Paid an advance; nothing came in three weeks.',
      phone: '0300 1234567',
      orderName: '#1042',
      from: '/products/lawn?variant=2',
    };
    const taken = await post(report);
    expect([taken.statusCode, taken.headers['cache-control']]).toEqual([200, 'private, no-store']);
    expect(taken.body).toContain('Thank you: Hatti has your report');
    expect(taken.body).toContain('rpt_7Kq2xY');
    expect(taken.body).toContain('href="/products/lawn?variant=2"');
    // What was wrong shows on the form again, as typed, in Urdu from Urdu pages.
    core.reported = {
      ok: false,
      errors: [{ field: 'phone', message: 'Enter a Pakistani mobile number' }],
    };
    const wrong = await post(
      { ...report, phone: '123', orderName: '', from: '//elsewhere.example/x' },
      {},
      '/ur/report',
    );
    expect(wrong.statusCode).toBe(422);
    expect(wrong.body).toContain('Enter a Pakistani mobile number, such as 0300 1234567.');
    expect(wrong.body).toContain('aria-invalid="true" aria-describedby="phone-error"');
    expect(wrong.body).toContain('Paid an advance; nothing came in three weeks.</textarea>');
    expect(wrong.body).toContain('<option value="never_delivered" selected');
    core.reported = {
      ok: false,
      errors: [{ field: 'base', message: 'You have reported this store today already' }],
    };
    expect((await post(report)).body).toContain('You have reported this store today already');
    expect(core.reports).toEqual([
      {
        shopId: 'sample',
        request: {
          reason: 'never_delivered',
          details: 'Paid an advance; nothing came in three weeks.',
          phone: '0300 1234567',
          orderName: '#1042',
          pageUrl: 'http://localhost/products/lawn?variant=2',
          client: '127.0.0.1',
          language: 'en',
        },
      },
      {
        shopId: 'sample',
        request: {
          reason: 'never_delivered',
          details: 'Paid an advance; nothing came in three weeks.',
          phone: '123',
          client: '127.0.0.1',
          language: 'ur',
        },
      },
      expect.objectContaining({ shopId: 'sample' }),
    ]);

    // Only from the shop itself; the core away says so.
    expect((await post(report, { 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    core.reported = new StorefrontApiError(502, 'Bad gateway');
    expect((await post(report)).statusCode).toBe(503);
    await app.close();
  });

  it("takes a rights owner's complaint naming the store's listings by their addresses (ADR-474)", async () => {
    const app = server();
    const other = sample.products[1]!;
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: 'localhost' } });
    const post = (fields: Record<string, string>, url = '/report/rights') =>
      app.inject({ method: 'POST', url, headers: FORM, payload: form(fields) });

    // Linked from the report page; Hatti's page, never kept.
    expect((await get('/report')).body).toContain('href="/report/rights"');
    expect((await get('/ur/report')).body).toContain('href="/ur/report/rights"');
    const page = await get('/report/rights');
    expect([page.statusCode, page.headers['cache-control']]).toEqual([200, 'private, no-store']);
    expect(page.body).toContain('Rights complaint');
    expect(page.body).toContain('حقوق کی شکایت');
    expect(page.body).toContain('<form method="post" action="/report/rights">');
    expect(page.body).toContain('<option value="counterfeit"');
    expect(page.body).toContain('name="sworn"');

    const complaint = {
      kind: 'counterfeit',
      rightsOwner: 'Gul Ahmed',
      registration: 'TM 123456',
      complainant: 'Sana Iqbal',
      actingAs: 'agent',
      email: 'legal@example.pk',
      listings: `http://localhost/products/${lawn.handle}\n/ur/products/${other.handle}\n\n/collections/all/products/${lawn.handle}`,
      details: 'Sold as Gul Ahmed lawn; it is a copy.',
      sworn: '1',
      signature: 'Sana Iqbal',
    };
    const taken = await post(complaint);
    expect([taken.statusCode, taken.headers['cache-control']]).toEqual([200, 'private, no-store']);
    expect(taken.body).toContain('Hatti has your complaint');
    expect(taken.body).toContain('ipc_3Rt9Lm');
    const [sent] = core.complaints;
    expect(sent).toEqual({
      shopId: 'sample',
      request: {
        kind: 'counterfeit',
        rightsOwner: 'Gul Ahmed',
        registration: 'TM 123456',
        complainant: 'Sana Iqbal',
        actingAs: 'agent',
        email: 'legal@example.pk',
        // Each product once, as the store has it.
        listings: [
          { id: lawn.id, title: lawn.title, url: `http://localhost/products/${lawn.handle}` },
          { id: other.id, title: other.title, url: `http://localhost/products/${other.handle}` },
        ],
        details: 'Sold as Gul Ahmed lawn; it is a copy.',
        signature: 'Sana Iqbal',
        sworn: true,
        client: '127.0.0.1',
        language: 'en',
      },
    });

    // Listings on another store, or none there is, are not sent on: the form says so, as typed.
    const elsewhere = await post(
      {
        ...complaint,
        listings: `https://other.example/products/${lawn.handle}\n/products/nothing`,
      },
      '/ur/report/rights',
    );
    expect(elsewhere.statusCode).toBe(422);
    expect(elsewhere.body).toContain('Give the address of each product on this store');
    expect(elsewhere.body).toContain('aria-invalid="true" aria-describedby="listings-error"');
    expect(elsewhere.body).toContain(`https://other.example/products/${lawn.handle}`);
    expect(core.complaints).toHaveLength(1);
    // What the core finds wrong shows too.
    core.complained = {
      ok: false,
      errors: [{ field: 'sworn', message: 'Swear the statement to send the complaint' }],
    };
    const unsworn = await post({ ...complaint, sworn: '' });
    expect(unsworn.statusCode).toBe(422);
    expect(unsworn.body).toContain('Tick the statement to send the complaint.');
    expect(core.complaints[1]!.request.sworn).toBe(false);
    await app.close();
  });

  it('sends a comment on to the core, then back to its article saying how it went (ADR-220)', async () => {
    const app = server();
    const post = (
      fields: Record<string, string>,
      headers: Record<string, string> = {},
      url = '/blogs/news/eid-lawn-is-here/comments',
    ) =>
      app.inject({ method: 'POST', url, headers: { ...FORM, ...headers }, payload: form(fields) });
    const comment = {
      form_type: 'new_comment',
      'comment[author]': 'Zara',
      'comment[email]': 'zara@example.pk',
      'comment[body]': 'Lovely lawn',
    };
    const taken = await post(comment, { 'user-agent': 'Mozilla/5.0' });
    expect([taken.statusCode, taken.headers.location, taken.headers['cache-control']]).toEqual([
      303,
      '/blogs/news/eid-lawn-is-here?comment_posted=true#comments',
      'private, no-store',
    ]);
    expect(core.comments.map((posted) => posted.request)).toEqual([
      {
        blog: 'news',
        article: 'eid-lawn-is-here',
        author: 'Zara',
        email: 'zara@example.pk',
        body: 'Lovely lawn',
        ip: '127.0.0.1',
        userAgent: 'Mozilla/5.0',
      },
    ]);

    // What was wrong, by field, back on the article in the page's language.
    core.commented = {
      ok: false,
      errors: [
        { field: 'email', message: 'Email must be an email address' },
        { field: 'body', message: "Body can't be blank" },
      ],
    };
    const wrong = await post(comment, {}, '/ur/blogs/news/eid-lawn-is-here/comments');
    expect(wrong.headers.location).toBe(
      '/ur/blogs/news/eid-lawn-is-here?comment_error=email%2Cbody#comment_form',
    );

    // Only Shopify's comment form, from the shop itself.
    expect((await post({ ...comment, form_type: 'customer' })).statusCode).toBe(404);
    expect((await post(comment, { 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    core.commented = new StorefrontApiError(502, 'Bad gateway');
    expect((await post(comment)).statusCode).toBe(503);
    expect(core.comments).toHaveLength(3);
    await app.close();
  });
});

/** A session's secret, as the core gives one once a code signs a shopper in (ADR-570). */
const ACCOUNT_TOKEN = 'sEsSiOn_SeCrEt-0123456789abcdefghijklmnopq';

/** The sample shop's variants a shopper ordered, as carts name them. */
const ORDERED = sampleStore().products.map((product) => product.variants[0]!.id);

/**
 * A shopper's account with the sample shop: two orders, one cancelled, and store credit. The
 * open one's items can be had again, but for one; none of the cancelled one's can.
 */
const ACCOUNT: AccountJson = {
  phone: '+923217654321',
  name: 'Ayesha Khan',
  // A subscription to a kurta every two weeks (ADR-916), and one paused.
  subscriptions: [
    {
      id: 'osub_01jb7k2m3n4p5q6r7s8t9v0w1x',
      status: 'active',
      planName: 'Subscribe & save',
      interval: { unit: 'week', count: 2 },
      discountPercent: 10,
      nextOrderOn: '2026-11-12',
      ordersPlaced: 3,
      lines: [{ productTitle: 'Kurta', variantTitle: 'M', quantity: 2 }],
      orderId: 'ord_01jb7k2m3n4p5q6r7s8t9v0w1x',
    },
    {
      id: 'osub_01jb7k2m3n4p5q6r7s8t9v0w1y',
      status: 'paused',
      planName: 'Monthly tea',
      interval: { unit: 'month', count: 1 },
      discountPercent: 5,
      nextOrderOn: '2026-12-01',
      ordersPlaced: 1,
      lines: [{ productTitle: 'Chai', variantTitle: null, quantity: 1 }],
      orderId: 'ord_01jb7k2m3n4p5q6r7s8t9v0w1z',
    },
  ],
  // One from the store the shop moved from (ADR-786).
  pastOrders: [
    {
      id: 'pord_01jb7k2m3n4p5q6r7s8t9v0w1x',
      name: '#S1042',
      placedAt: '2025-03-20T09:00:00.000Z',
      cancelled: false,
      financialStatus: 'paid',
      fulfillmentStatus: 'fulfilled',
      total: 925_000,
      currency: 'PKR',
      itemCount: 2,
      lines: [{ title: 'Lawn suit', variantTitle: 'M', quantity: 2 }],
    },
  ],
  orders: [
    {
      id: 'ord_01jb7k2m3n4p5q6r7s8t9v0w1x',
      name: '#1002',
      placedAt: '2026-10-01T09:00:00.000Z',
      status: 'open',
      financialStatus: 'pending',
      fulfillmentStatus: 'fulfilled',
      total: 1_250_000,
      currency: 'PKR',
      itemCount: 2,
      hasPage: true,
      lines: [
        {
          variantId: ORDERED[0]!,
          productTitle: 'Lawn 3-piece',
          variantTitle: 'M',
          quantity: 1,
          available: true,
        },
        {
          variantId: ORDERED[1]!,
          productTitle: 'Chiffon dupatta',
          variantTitle: null,
          quantity: 1,
          available: false,
        },
      ],
    },
    {
      id: 'ord_01jb7k2m3n4p5q6r7s8t9v0w1y',
      name: '#1001',
      placedAt: '2026-08-14T09:00:00.000Z',
      status: 'cancelled',
      financialStatus: 'voided',
      fulfillmentStatus: 'unfulfilled',
      total: 450_000,
      currency: 'PKR',
      itemCount: 1,
      hasPage: false,
      lines: [
        {
          variantId: null,
          productTitle: 'Eid 3-piece suit',
          variantTitle: null,
          quantity: 1,
          available: false,
        },
      ],
    },
  ],
  storeCredit: {
    balance: 50_000,
    currency: 'PKR',
    expiring: { amount: 20_000, expiresAt: '2026-12-31T00:00:00.000Z' },
    // Its latest changes, the newest first (ADR-668).
    history: [
      {
        kind: 'debit',
        event: 'order_payment',
        amount: -30_000,
        balanceAfter: 50_000,
        at: '2026-10-02T09:00:00.000Z',
        expiresAt: null,
        orderId: 'ord_01jb7k2m3n4p5q6r7s8t9v0w1x',
      },
      {
        kind: 'credit',
        event: 'order_refund',
        amount: 60_000,
        balanceAfter: 80_000,
        at: '2026-09-20T09:00:00.000Z',
        expiresAt: '2026-12-31T00:00:00.000Z',
        orderId: 'ord_01jb7k2m3n4p5q6r7s8t9v0w1y',
      },
      {
        kind: 'credit',
        event: 'adjustment',
        amount: 20_000,
        balanceAfter: 20_000,
        at: '2026-09-01T09:00:00.000Z',
        expiresAt: null,
        orderId: null,
      },
    ],
  },
  dataRequests: { available: true, erasureWaitDays: 10, export: null, erasure: null },
};

describe("Shoppers' accounts (ADR-571)", () => {
  let theme: Theme;
  let core: FakeCore;

  beforeAll(async () => {
    theme = loadTheme(await readThemeDir(THEME_DIR));
  });

  const server = (extra: Partial<StorefrontServerOptions> = {}) => {
    core = new FakeCore();
    return createStorefrontServer({
      theme,
      renderer: new PageRenderer(theme, { limits: { timeMs: 10_000 } }),
      domain: 'localhost',
      sample: new MemoryStore(sampleStore()),
      core,
      ...extra,
    });
  };
  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
  const FORM = { host: 'localhost', 'content-type': 'application/x-www-form-urlencoded' };
  /** The cookie a `Set-Cookie` header of the answer sets, as the browser sends it back. */
  const kept = (answer: { headers: Record<string, unknown> }, name: string) => {
    const cookies = [answer.headers['set-cookie'] ?? []].flat() as string[];
    return cookies.find((cookie) => cookie.startsWith(`${name}=`))?.split(';')[0] ?? null;
  };
  const signedIn = () => {
    core.accounts.set(ACCOUNT_TOKEN, ACCOUNT);
    return `hatti_account=${ACCOUNT_TOKEN}; hatti_signed_in=1`;
  };

  it('signs a shopper in with a code sent to their mobile, keeping the session in a cookie only the server reads', async () => {
    const app = server();
    const page = await app.inject({ method: 'GET', url: '/account/login', headers: FORM });
    expect(page.statusCode).toBe(200);
    expect([page.headers['cache-control'], page.headers['x-robots-tag']]).toEqual([
      'private, no-store',
      'noindex',
    ]);
    expect(page.headers['cache-tag']).toBeUndefined();
    expect(page.body).toContain('<title>Sign in · ');
    expect(page.body).toMatch(
      /<form method="post" action="\/account\/login" accept-charset="UTF-8" class="login__form">/,
    );
    expect(page.body).toContain('name="customer[phone]"');
    expect(page.body).toMatch(/value="whatsapp" checked>/);
    // The header's link to the account says "Sign in" to a shopper who is not.
    expect(page.body).toMatch(
      /class="header__account" data-account-link data-signed-in="Account">Sign in</,
    );

    // The number: a code goes to it on WhatsApp, from the shopper's address, in English.
    const sent = await app.inject({
      method: 'POST',
      url: '/account/login',
      headers: FORM,
      payload: form({
        form_type: 'customer_login',
        'customer[phone]': ' 0321 7654321 ',
        'customer[channel]': 'whatsapp',
      }),
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.headers['cache-control']).toBe('private, no-store');
    expect(core.loginStarts).toEqual([
      {
        shopId: 'sample',
        request: { phone: '0321 7654321', channel: 'whatsapp', locale: 'en' },
        client: { ip: '127.0.0.1' },
      },
    ]);
    expect(sent.body).toContain('We sent a code to <bdi dir="ltr">0300 ••••567</bdi> on WhatsApp.');
    expect(sent.body).toMatch(/<form method="post" action="\/account\/login\/verify"/);
    expect(sent.body).toContain('autocomplete="one-time-code"');
    // The number as typed waits on the server, in a cookie of ten minutes; never in the page.
    expect(sent.body).not.toContain('7654321');
    const waiting = kept(sent, 'hatti_login');
    expect(waiting).not.toBeNull();
    expect([sent.headers['set-cookie']].flat()).toEqual([
      expect.stringMatching(/^hatti_login=[\w-]+; Path=\/; Max-Age=600; HttpOnly; SameSite=Lax$/),
    ]);

    // The code, right: signed in, and on to the account.
    core.loginVerified = {
      ok: true,
      token: ACCOUNT_TOKEN,
      session: {
        phone: '+923217654321',
        name: 'Ayesha Khan',
        signedInAt: '2026-10-19T10:00:00.000Z',
        expiresAt: '2026-11-18T10:00:00.000Z',
      },
    };
    const verified = await app.inject({
      method: 'POST',
      url: '/account/login/verify',
      headers: { ...FORM, cookie: waiting! },
      payload: form({ form_type: 'customer_login', 'customer[code]': '123 456' }),
    });
    expect(core.loginVerifies).toEqual([
      { shopId: 'sample', request: { phone: '0321 7654321', code: '123456' } },
    ]);
    expect([verified.statusCode, verified.headers.location]).toEqual([303, '/account']);
    expect(verified.headers['cache-control']).toBe('private, no-store');
    expect(verified.headers['set-cookie']).toEqual([
      `hatti_account=${ACCOUNT_TOKEN}; Path=/; Max-Age=7776000; HttpOnly; SameSite=Lax`,
      'hatti_signed_in=1; Path=/; Max-Age=7776000; SameSite=Lax',
      'hatti_login=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
    ]);

    // Signed in, the sign-in page sends them to their account, or where its link asks.
    const cookie = signedIn();
    const again = await app.inject({
      method: 'GET',
      url: '/account/login',
      headers: { host: 'localhost', cookie },
    });
    expect([again.statusCode, again.headers.location]).toEqual([302, '/account']);
    const onward = await app.inject({
      method: 'GET',
      url: '/ur/account/login?return_to=%2Fur%2Fcart',
      headers: { host: 'localhost', cookie },
    });
    expect(onward.headers.location).toBe('/ur/cart');
    await app.close();
  });

  it('asks for the code by SMS, in Urdu, and over HTTPS keeps its cookies there alone', async () => {
    const app = server({ secureCookies: true });
    core.loginStarted = { ok: true, state: 'sent', phone: '0321 ••••321', channel: 'sms' };
    const sent = await app.inject({
      method: 'POST',
      url: '/ur/account/login',
      headers: FORM,
      payload: form({ 'customer[phone]': '03217654321', 'customer[channel]': 'sms' }),
    });
    expect(core.loginStarts[0]!.request).toEqual({
      phone: '03217654321',
      channel: 'sms',
      locale: 'ur',
    });
    expect(sent.body).toContain(
      'ہم نے <bdi dir="ltr">0321 ••••321</bdi> پر ایس ایم ایس سے کوڈ بھیجا ہے۔',
    );
    expect(sent.body).toMatch(/<form method="post" action="\/ur\/account\/login\/verify"/);
    expect([sent.headers['set-cookie']].flat()[0]).toMatch(/; HttpOnly; SameSite=Lax; Secure$/);
    core.loginVerified = {
      ok: true,
      token: ACCOUNT_TOKEN,
      session: { phone: '+923217654321', name: null, signedInAt: '', expiresAt: '' },
    };
    const verified = await app.inject({
      method: 'POST',
      url: '/ur/account/login/verify',
      headers: { ...FORM, cookie: kept(sent, 'hatti_login')! },
      payload: form({ 'customer[code]': '123456' }),
    });
    expect(verified.headers.location).toBe('/ur/account');
    for (const cookie of [verified.headers['set-cookie']].flat()) {
      expect(cookie).toMatch(/; Secure$/);
    }
    await app.close();
  });

  it("says why a sign-in did not go on, in the page's language, and asks again", async () => {
    const app = server();
    const post = (url: string, fields: Record<string, string>, cookie?: string) =>
      app.inject({
        method: 'POST',
        url,
        headers: { ...FORM, ...(cookie && { cookie }) },
        payload: form(fields),
      });

    // Not a mobile number: the number's step again, with what was typed.
    core.loginStarted = { ok: false, errors: [{ field: 'phone', message: 'Phone is invalid' }] };
    const invalid = await post('/account/login', { 'customer[phone]': '12345' });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.body).toContain(
      '<div id="LoginError" class="login__error" role="alert"><p>Enter a Pakistani mobile number, like 0300 1234567.</p></div>',
    );
    expect(invalid.body).toContain('value="12345"');
    expect(invalid.body).toContain('aria-invalid="true"');
    expect(invalid.headers['set-cookie']).toBeUndefined();

    // As many codes as the number may have for now.
    core.loginStarted = { ok: true, state: 'too_many', phone: '0321 ••••321', channel: 'whatsapp' };
    const tooMany = await post('/ur/account/login', { 'customer[phone]': '03217654321' });
    expect(tooMany.statusCode).toBe(429);
    expect(tooMany.body).toContain(
      'اس نمبر پر ابھی جتنے کوڈ بھیجے جا سکتے تھے، بھیج دیے گئے ہیں۔ براہ کرم کچھ دیر بعد دوبارہ کوشش کریں۔',
    );
    expect(tooMany.headers['set-cookie']).toBeUndefined();

    core.loginStarted = { ok: true, state: 'sent', phone: '0321 ••••321', channel: 'whatsapp' };
    const sent = await post('/account/login', { 'customer[phone]': '03217654321' });
    const waiting = kept(sent, 'hatti_login')!;

    // A wrong code: the code's step again, the code still on its way.
    core.loginVerified = { ok: false, error: 'wrong' };
    const wrong = await post('/account/login/verify', { 'customer[code]': '000000' }, waiting);
    expect(wrong.statusCode).toBe(422);
    expect(wrong.body).toContain('That code is not right. Check it and try again.');
    expect(wrong.body).toContain('<bdi dir="ltr">0321 ••••321</bdi>');
    expect(wrong.body).toMatch(/action="\/account\/login\/verify"/);
    expect(wrong.headers['set-cookie']).toBeUndefined();
    const urdu = await post('/ur/account/login/verify', { 'customer[code]': '000000' }, waiting);
    expect(urdu.body).toContain('یہ کوڈ درست نہیں۔ اسے دیکھ کر دوبارہ کوشش کریں۔');

    // Expired, or tried too often: the number's step, for a new code, the old one forgotten.
    const cleared = 'hatti_login=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax';
    core.loginVerified = { ok: false, error: 'expired' };
    const expired = await post('/account/login/verify', { 'customer[code]': '123456' }, waiting);
    expect(expired.statusCode).toBe(422);
    expect(expired.body).toContain('That code has expired. Ask for a new one.');
    expect(expired.body).toMatch(/action="\/account\/login"/);
    expect(expired.body).toContain('value="03217654321"');
    expect(expired.headers['set-cookie']).toBe(cleared);
    core.loginVerified = { ok: false, error: 'too_many' };
    const tried = await post('/account/login/verify', { 'customer[code]': '123456' }, waiting);
    expect(tried.statusCode).toBe(429);
    expect(tried.body).toContain('That code was tried too many times. Ask for a new one.');
    expect(tried.headers['set-cookie']).toBe(cleared);
    core.loginVerified = { ok: false, error: 'invalid' };
    const never = await post('/account/login/verify', { 'customer[code]': '123456' }, waiting);
    expect(never.body).toContain('Enter a Pakistani mobile number, like 0300 1234567.');

    // No code on its way, or a cookie not written here: asked for the number again.
    const none = await post('/account/login/verify', { 'customer[code]': '123456' });
    expect(none.statusCode).toBe(422);
    expect(none.body).toContain('That code has expired. Ask for a new one.');
    const forged = await post(
      '/account/login/verify',
      { 'customer[code]': '123456' },
      'hatti_login=bm90LWpzb24',
    );
    expect(forged.body).toContain('That code has expired. Ask for a new one.');
    expect(core.loginVerifies).toHaveLength(5);

    // From another site, nothing is sent; the core unreachable, the shopper is told.
    const away = { 'sec-fetch-site': 'cross-site' };
    for (const url of ['/account/login', '/account/login/verify']) {
      const refused = await app.inject({ method: 'POST', url, headers: { ...FORM, ...away } });
      expect(refused.statusCode, url).toBe(403);
    }
    core.loginStarted = new StorefrontApiError(502, 'Bad gateway');
    const down = await post('/account/login', { 'customer[phone]': '03217654321' });
    expect(down.statusCode).toBe(503);
    await app.close();
  });

  it('sends a shopper signed in only along paths on the shop', async () => {
    const app = server();
    core.loginVerified = {
      ok: true,
      token: ACCOUNT_TOKEN,
      session: { phone: '+923217654321', name: null, signedInAt: '', expiresAt: '' },
    };
    const sent = await app.inject({
      method: 'POST',
      url: '/account/login',
      headers: FORM,
      payload: form({ 'customer[phone]': '03217654321', return_to: '/collections/lawn' }),
    });
    // The form carries where to go on.
    expect(sent.body).toContain('<input type="hidden" name="return_to" value="/collections/lawn">');
    expect(sent.body).toContain('href="/account/login?return_to=%2Fcollections%2Flawn"');
    const waiting = kept(sent, 'hatti_login')!;
    const verify = (returnTo: string) =>
      app.inject({
        method: 'POST',
        url: '/account/login/verify',
        headers: { ...FORM, cookie: waiting },
        payload: form({ 'customer[code]': '123456', return_to: returnTo }),
      });
    expect((await verify('/collections/lawn?page=2')).headers.location).toBe(
      '/collections/lawn?page=2',
    );
    for (const away of ['//evil.example', 'https://evil.example/', '/\\evil.example', 'cart']) {
      expect((await verify(away)).headers.location, away).toBe('/account');
    }
    const page = await app.inject({
      method: 'GET',
      url: '/account/login?return_to=%2F%2Fevil.example',
      headers: { host: 'localhost' },
    });
    expect(page.body).not.toContain('evil.example');
    await app.close();
  });

  it('gives a signed-in shopper their link to bring friends while the shop rewards it (ADR-809)', async () => {
    // The shop's own address, as the platform's gives it.
    const app = server({
      renderer: new PageRenderer(theme, {
        limits: { timeMs: 10_000 },
        platformUrl: 'https://hatti.pk',
      }),
    });
    const cookie = signedIn();
    core.accounts.set(ACCOUNT_TOKEN, {
      ...ACCOUNT,
      referral: { code: 'K7QH2MXP', referrerCredit: 30_000, friendCredit: 20_000, currency: 'PKR' },
    });
    const page = await app.inject({
      method: 'GET',
      url: '/account',
      headers: { host: 'localhost', cookie },
    });
    const block = page.body.slice(page.body.indexOf('<div class="account__referral">'));
    expect(block).toContain('<h2>Bring a friend</h2>');
    expect(block).toContain(
      'Once a friend&#39;s first order from it arrives, you are given Rs 300 and they are given Rs 200 in store credit.',
    );
    expect(block).toMatch(/value="https:\/\/[a-z0-9-]+\.hatti\.pk\/\?invite=K7QH2MXP"/);
    expect(block).toMatch(
      /href="https:\/\/wa\.me\/\?text=Shop\+at\+.+https%3A%2F%2F.+%3Finvite%3DK7QH2MXP"/,
    );
    // The friend given nothing: it says what they are given alone, in Urdu too.
    core.accounts.set(ACCOUNT_TOKEN, {
      ...ACCOUNT,
      referral: { code: 'K7QH2MXP', referrerCredit: 30_000, friendCredit: 0, currency: 'PKR' },
    });
    const urdu = await app.inject({
      method: 'GET',
      url: '/ur/account',
      headers: { host: 'localhost', cookie },
    });
    expect(urdu.body).toContain('<h2>دوست کو لائیں</h2>');
    expect(urdu.body).toContain('تو آپ کو Rs 300 اسٹور کریڈٹ ملتا ہے۔');
    expect(urdu.body).toContain('?invite=K7QH2MXP');
  });

  it('shows a signed-in shopper their orders and store credit, never kept, and others the way to sign in', async () => {
    const app = server();
    const cookie = signedIn();
    const page = await app.inject({
      method: 'GET',
      url: '/account',
      headers: { host: 'localhost', cookie },
    });
    expect(page.statusCode).toBe(200);
    expect([page.headers['cache-control'], page.headers['x-robots-tag']]).toEqual([
      'private, no-store',
      'noindex',
    ]);
    expect(page.headers['cache-tag']).toBeUndefined();
    expect(page.headers['set-cookie']).toBeUndefined();
    const html = page.body;
    expect(html).toContain('<title>Your account · ');
    expect(html).toContain('<body class="template-account">');
    expect(html).toContain('<span dir="auto">Hi Ayesha</span>');
    expect(html).toContain('<bdi dir="ltr">+923217654321</bdi>');
    expect(html).toMatch(
      /class="header__account" data-account-link data-signed-in="Account">Account</,
    );
    // Its store credit, and what of it expires soonest.
    expect(html).toContain('<p class="account__credit-balance">Rs 500</p>');
    expect(html).toContain('Rs 200 of it expires on 31 December 2026.');
    // What happened to it, the newest first (ADR-668): spent on an order it links to, refunded
    // from the cancelled one it names, and given by the shop.
    const history = html.slice(html.indexOf('<ul class="account__credit-history"'));
    const entries = history.slice(0, history.indexOf('</ul>')).split('<li').slice(1);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toContain(
      'Spent · <a href="/account/orders/ord_01jb7k2m3n4p5q6r7s8t9v0w1x">#1002</a>',
    );
    expect(entries[0]).toMatch(/dir="ltr">−Rs 300</);
    expect(entries[1]).toContain('Refunded · #1001');
    expect(entries[1]).toContain('expires on 31 December 2026');
    expect(entries[1]).toMatch(/dir="ltr">\+Rs 600</);
    expect(entries[2]).toContain('Given by the shop');
    expect(entries[2]).not.toContain('expires on');
    // Its orders, the newest first: the one with a page links to it through the storefront.
    expect(html).toContain(
      '<a href="/account/orders/ord_01jb7k2m3n4p5q6r7s8t9v0w1x" aria-label="View order #1002"><bdi>#1002</bdi></a>',
    );
    expect(html).toContain('<dd>Pending</dd>');
    expect(html).toContain('<dd>Fulfilled</dd>');
    expect(html).toContain('<dt>2 items</dt>');
    expect(html).toContain('<dd>Rs 12,500</dd>');
    expect(html).toMatch(/<bdi>#1001<\/bdi>\s*<span/);
    expect(html).toContain('<dd>Cancelled</dd>');
    expect(html).toContain('<form method="post" action="/account/logout">');
    // Under them, what they bought at the store the shop moved from, with no page (ADR-786).
    const past = html.slice(html.indexOf('<section class="account__past"'));
    expect(past).toContain('<h2 id="past-orders-title">From our old store</h2>');
    expect(past).toMatch(/<bdi>#S1042<\/bdi>\s*<span/);
    expect(past).toContain('<dd>Paid</dd>');
    expect(past).toContain('<dd>Rs 9,250</dd>');
    expect(past).toContain('<span dir="auto">Lawn suit</span>');
    // Above their orders, their subscriptions, each managed from its latest order's page.
    const subscriptions = html.slice(
      html.indexOf('<section class="account__subscriptions"'),
      html.indexOf('</section>', html.indexOf('<section class="account__subscriptions"')),
    );
    expect(subscriptions).toContain('<h2 id="subscriptions-title">Your subscriptions</h2>');
    expect(subscriptions).toContain('Every 2 weeks');
    expect(subscriptions).toContain('Next order on 12 November 2026');
    expect(subscriptions).toContain('Every month');
    expect(subscriptions).toContain('Paused');
    expect(subscriptions).toContain(
      '<a class="button button--secondary" href="/account/orders/ord_01jb7k2m3n4p5q6r7s8t9v0w1x">Skip, pause or cancel</a>',
    );

    // In Urdu, the words and the statuses are Urdu, and the links stay in it.
    const urdu = await app.inject({
      method: 'GET',
      url: '/ur/account',
      headers: { host: 'localhost', cookie },
    });
    expect(urdu.statusCode).toBe(200);
    expect(urdu.body).toContain('<h1>آپ کا اکاؤنٹ</h1>');
    expect(urdu.body).toContain('<dd>ادائیگی باقی</dd>');
    expect(urdu.body).toContain('<dd>روانہ ہو گیا</dd>');
    expect(urdu.body).toContain('<dd>منسوخ</dd>');
    expect(urdu.body).toContain('<h2 id="past-orders-title">ہمارے پرانے اسٹور سے</h2>');
    expect(urdu.body).toContain('<h3>اس کی تفصیل</h3>');
    expect(urdu.body).toContain('href="/ur/account/orders/ord_01jb7k2m3n4p5q6r7s8t9v0w1x"');
    expect(urdu.body).toContain('<form method="post" action="/ur/account/logout">');

    // No orders, no credit, no name.
    core.accounts.set(ACCOUNT_TOKEN, {
      ...ACCOUNT,
      name: null,
      orders: [],
      storeCredit: { balance: 0, currency: 'PKR', expiring: null, history: [] },
    });
    const empty = await app.inject({
      method: 'GET',
      url: '/account',
      headers: { host: 'localhost', cookie },
    });
    expect(empty.body).toContain('<p>You haven&#39;t placed an order with us yet.</p>');
    expect(empty.body).not.toContain('<div class="account__credit">');
    // No link to bring friends while the shop's referral programme is off.
    expect(empty.body).not.toContain('<div class="account__referral">');
    expect(empty.body).toContain('<p class="account__who"><bdi dir="ltr">+923217654321</bdi>');

    // Not signed in: on to sign in. A session that is over takes its cookies with it.
    const out = await app.inject({
      method: 'GET',
      url: '/ur/account',
      headers: { host: 'localhost' },
    });
    expect([out.statusCode, out.headers.location, out.headers['set-cookie']]).toEqual([
      302,
      '/ur/account/login',
      undefined,
    ]);
    const over = await app.inject({
      method: 'GET',
      url: '/account',
      headers: { host: 'localhost', cookie: 'hatti_account=sEsSiOn_SeCrEt-EnDeD-0123456789abcdef' },
    });
    expect([over.statusCode, over.headers.location]).toEqual([302, '/account/login']);
    expect(over.headers['set-cookie']).toEqual([
      'hatti_account=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      'hatti_signed_in=; Path=/; Max-Age=0; SameSite=Lax',
    ]);
    expect(over.headers['cache-control']).toBe('private, no-store');
    await app.close();
  });

  it("keeps the shop's other pages the same for everyone, signed in or not", async () => {
    const app = server();
    const cookie = signedIn();
    const home = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: 'localhost', cookie },
    });
    expect(home.statusCode).toBe(200);
    expect(home.headers['cache-control']).toMatch(/^public, /);
    // The page says "Sign in"; its script says "Account" to a shopper with the cookie.
    expect(home.body).toMatch(/data-account-link data-signed-in="Account">Sign in</);
    expect(home.body).toContain('hatti_signed_in=1');
    expect(home.body).not.toContain('Ayesha');
    await app.close();
  });

  it("sends a shopper to their order's page, and signs them out", async () => {
    const app = server();
    const cookie = signedIn();
    const [order, other] = ACCOUNT.orders.map((each) => each.id);
    core.orderLinks.set(order!, { path: '/o/abc123', url: 'http://core.test/o/abc123' });
    const go = (url: string, headers: Record<string, string> = { cookie }) =>
      app.inject({ method: 'GET', url, headers: { host: 'localhost', ...headers } });
    const opened = await go(`/account/orders/${order}`);
    expect([opened.statusCode, opened.headers.location, opened.headers['cache-control']]).toEqual([
      303,
      'http://core.test/o/abc123',
      'private, no-store',
    ]);
    // An order with no page, or not theirs: the shop's page not found.
    const missing = await go(`/account/orders/${other}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain('Page not found');
    expect(missing.headers['cache-control']).toBe('private, no-store');
    expect((await go('/account/orders/ord_nobody')).statusCode).toBe(404);
    // Not signed in: to sign in first, and back.
    const out = await go(`/ur/account/orders/${order}`, {});
    expect([out.statusCode, out.headers.location]).toEqual([
      302,
      `/ur/account/login?return_to=%2Fur%2Faccount%2Forders%2F${order}`,
    ]);

    // Signing out ends the session, and its cookies go: by the theme's form, or Shopify's link.
    const cleared = [
      'hatti_account=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      'hatti_signed_in=; Path=/; Max-Age=0; SameSite=Lax',
    ];
    const posted = await app.inject({
      method: 'POST',
      url: '/account/logout',
      headers: { ...FORM, cookie },
    });
    expect([posted.statusCode, posted.headers.location, posted.headers['set-cookie']]).toEqual([
      303,
      '/',
      cleared,
    ]);
    expect(posted.headers['cache-control']).toBe('private, no-store');
    expect(core.signedOut).toEqual([ACCOUNT_TOKEN]);
    // Looking at the link signs no one out.
    core.accounts.set(ACCOUNT_TOKEN, ACCOUNT);
    const looked = await app.inject({
      method: 'HEAD',
      url: '/account/logout',
      headers: { host: 'localhost', cookie },
    });
    expect([looked.statusCode, looked.headers['set-cookie']]).toEqual([302, undefined]);
    expect(core.signedOut).toEqual([ACCOUNT_TOKEN]);
    const linked = await go('/ur/account/logout');
    expect([linked.statusCode, linked.headers.location, linked.headers['set-cookie']]).toEqual([
      302,
      '/ur',
      cleared,
    ]);
    expect(core.signedOut).toEqual([ACCOUNT_TOKEN, ACCOUNT_TOKEN]);
    // Signed out, the account sends them to sign in.
    expect((await go('/account')).headers.location).toBe('/account/login');
    await app.close();
  });

  /** A cart the core keeps, of `quantity` of each of `variantIds`, as far as a test needs. */
  const cartOf = (variantIds: readonly string[], quantity = 1): CartJson => ({
    note: '',
    attributes: {},
    items: variantIds.map((variantId) => ({
      key: `${variantId}:0123456789abcdef0123456789abcdef`,
      variantId,
      productId: 'p-1',
      quantity,
      properties: {},
      price: 100_000,
      linePrice: 100_000 * quantity,
      title: 'Lawn 3-piece',
      variantTitle: 'M',
      sku: null,
      grams: 0,
      taxable: true,
      taxCode: null,
      maxQuantity: null,
    })),
    itemCount: variantIds.length * quantity,
    subtotal: 100_000 * quantity * variantIds.length,
    totalWeightGrams: 0,
    discount: null,
    totalDiscount: 0,
  });

  it("shows each order's items, and buys them again into the cart, saying what could not go (ADR-574)", async () => {
    const app = server();
    const cookie = signedIn();
    const [open, cancelled] = ACCOUNT.orders.map((each) => each.id);
    const page = await app.inject({
      method: 'GET',
      url: '/account',
      headers: { host: 'localhost', cookie },
    });
    // Each order's items, compact; "Buy again" while any of them can be had.
    expect(page.body).toContain(
      '<ul class="account__order-items" role="list" aria-label="Items in order #1002">',
    );
    expect(page.body).toMatch(
      /<span dir="auto">Lawn 3-piece<\/span> <span class="account__muted" dir="auto">M<\/span>\s*<bdi>× 1<\/bdi><\/li>/,
    );
    expect(page.body).toMatch(
      /<span dir="auto">Chiffon dupatta<\/span>\s*<bdi>× 1<\/bdi> <span class="account__muted">Not available now<\/span>/,
    );
    expect(page.body).toMatch(
      new RegExp(
        `<form method="post" action="/account/orders/${open}/reorder" class="account__reorder">\\s*` +
          '<button type="submit" class="button button--secondary" aria-label="Buy the items of order #1002 again">Buy again</button>',
      ),
    );
    // None of the cancelled one's can be had.
    expect(page.body).toContain('aria-label="Items in order #1001"');
    expect(page.body).not.toContain(`/account/orders/${cancelled}/reorder`);
    const urdu = await app.inject({
      method: 'GET',
      url: '/ur/account',
      headers: { host: 'localhost', cookie },
    });
    expect(urdu.body).toContain(`action="/ur/account/orders/${open}/reorder"`);
    expect(urdu.body).toContain(
      'aria-label="آرڈر #1002 کی اشیاء دوبارہ خریدیں">دوبارہ خریدیں</button>',
    );
    expect(urdu.body).toContain('<span class="account__muted">ابھی دستیاب نہیں</span>');

    // Bought again: what can be had goes in the shopper's cart, which says the rest could not.
    const reorder = (url: string, cart = 'cart=cArT-sEcReT-1') =>
      app.inject({ method: 'POST', url, headers: { ...FORM, cookie: `${cookie}; ${cart}` } });
    core.answer = () => ({
      ok: true,
      cart: cartOf([ORDERED[0]!]),
      token: 'cArT-sEcReT-1',
      added: [],
    });
    const bought = await reorder(`/account/orders/${open}/reorder`);
    expect([bought.statusCode, bought.headers.location, bought.headers['cache-control']]).toEqual([
      303,
      '/cart?reorder=partial',
      'private, no-store',
    ]);
    expect(core.actions).toEqual([
      {
        token: 'cArT-sEcReT-1',
        action: 'add',
        body: { items: [{ variantId: ORDERED[0], quantity: 1, properties: {} }] },
      },
    ]);
    expect(bought.headers['set-cookie']).toEqual([
      'cart=cArT-sEcReT-1; Max-Age=1209600; Path=/; SameSite=Lax; HttpOnly',
      'cart_count=1; Max-Age=1209600; Path=/; SameSite=Lax',
    ]);
    const said = await app.inject({
      method: 'GET',
      url: '/cart?reorder=partial',
      headers: { host: 'localhost', cookie: 'cart=cArT-sEcReT-1' },
    });
    expect(said.body).toContain(
      '<p class="cart__error" role="alert" dir="auto">Not everything from your order could go in ' +
        'your cart: some of it is sold out, has fewer left, or is no longer for sale.</p>',
    );
    // A notice the cart page has no words for is none.
    const unknown = await app.inject({
      method: 'GET',
      url: '/cart?reorder=everything',
      headers: { host: 'localhost' },
    });
    expect(unknown.body).not.toContain('class="cart__error"');

    // All of it can be had: as many as the order had, fewer of one the cart has too few of, and
    // its notice says so; all of them, and none.
    core.accounts.set(ACCOUNT_TOKEN, {
      ...ACCOUNT,
      orders: [
        {
          ...ACCOUNT.orders[0]!,
          lines: [
            { ...ACCOUNT.orders[0]!.lines[0]!, quantity: 5 },
            { ...ACCOUNT.orders[0]!.lines[1]!, variantId: ORDERED[2]!, available: true },
          ],
        },
      ],
    });
    core.actions.length = 0;
    core.kept.set('cArT-sEcReT-1', cartOf([ORDERED[0]!]));
    core.answer = () =>
      (core.actions.at(-1)!.body as { items: { quantity: number }[] }).items[0]!.quantity > 2
        ? {
            ok: false,
            error: { code: 'MAX_QUANTITY', variantId: ORDERED[0]!, title: 'Lawn 3-piece', max: 3 },
          }
        : { ok: true, cart: cartOf([ORDERED[0]!, ORDERED[2]!]), token: 'cArT-sEcReT-1', added: [] };
    const fewer = await reorder(`/account/orders/${open}/reorder`);
    expect([fewer.statusCode, fewer.headers.location]).toEqual([303, '/cart?reorder=partial']);
    expect(core.actions.map((each) => each.body)).toEqual([
      {
        items: [
          { variantId: ORDERED[0], quantity: 5, properties: {} },
          { variantId: ORDERED[2], quantity: 1, properties: {} },
        ],
      },
      {
        items: [
          { variantId: ORDERED[0], quantity: 2, properties: {} },
          { variantId: ORDERED[2], quantity: 1, properties: {} },
        ],
      },
    ]);
    core.answer = () => ({
      ok: true,
      cart: cartOf([ORDERED[0]!, ORDERED[2]!]),
      token: 'cArT-sEcReT-2',
      added: [],
    });
    // A shopper without a cart has one begun.
    const all = await reorder(`/ur/account/orders/${open}/reorder`, 'other=1');
    expect([all.statusCode, all.headers.location]).toEqual([303, '/ur/cart']);
    expect(core.actions.at(-1)!.token).toBeNull();
    expect(all.headers['set-cookie']).toContain(
      'cart=cArT-sEcReT-2; Max-Age=1209600; Path=/; SameSite=Lax; HttpOnly',
    );
    core.answer = () => ({ ok: false, error: { code: 'NOT_FOUND', variantId: ORDERED[0]! } });
    const none = await reorder(`/ur/account/orders/${open}/reorder`);
    expect([none.statusCode, none.headers.location, none.headers['set-cookie']]).toEqual([
      303,
      '/ur/cart?reorder=none',
      undefined,
    ]);
    // Without the first, the second was asked for alone, and refused too.
    expect(core.actions.at(-1)!.body).toEqual({
      items: [{ variantId: ORDERED[2], quantity: 1, properties: {} }],
    });
    const saidUrdu = await app.inject({
      method: 'GET',
      url: '/ur/cart?reorder=none',
      headers: { host: 'localhost' },
    });
    expect(saidUrdu.body).toContain(
      '<p class="cart__error" role="alert" dir="auto">آپ کے آرڈر کی اشیاء کارٹ میں نہیں ڈالی جا سکیں: یہ ختم ہو گئی ہیں یا اب فروخت کے لیے نہیں ہیں۔</p>',
    );
    await app.close();
  });

  it('buys again only from the shop, for a shopper signed in, an order of theirs (ADR-574)', async () => {
    const app = server();
    const cookie = signedIn();
    const [open, cancelled] = ACCOUNT.orders.map((each) => each.id);
    core.answer = () => ({
      ok: true,
      cart: cartOf([ORDERED[0]!]),
      token: 'cArT-sEcReT-1',
      added: [],
    });
    const post = (url: string, headers: Record<string, string> = { cookie }) =>
      app.inject({ method: 'POST', url, headers: { ...FORM, ...headers } });
    // From another site, refused; from the shop's own pages, taken.
    const elsewhere = await post(`/account/orders/${open}/reorder`, {
      cookie,
      'sec-fetch-site': 'cross-site',
    });
    expect([elsewhere.statusCode, elsewhere.headers['cache-control']]).toEqual([
      403,
      'private, no-store',
    ]);
    expect(core.actions).toEqual([]);
    const own = await post(`/account/orders/${open}/reorder`, {
      cookie,
      'sec-fetch-site': 'same-origin',
    });
    expect(own.statusCode).toBe(303);
    expect(core.actions).toHaveLength(1);

    // An order none of whose items can be had, or not theirs: nothing goes in the cart.
    const nothing = await post(`/account/orders/${cancelled}/reorder`);
    expect([nothing.statusCode, nothing.headers.location]).toEqual([303, '/cart?reorder=none']);
    const missing = await post('/account/orders/ord_nobody/reorder');
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain('Page not found');
    // Looked at, the address changes nothing.
    const looked = await app.inject({
      method: 'GET',
      url: `/account/orders/${open}/reorder`,
      headers: { host: 'localhost', cookie },
    });
    expect(looked.statusCode).toBe(404);
    expect(core.actions).toHaveLength(1);

    // No one signed in: to sign in first; a session that is over takes its cookies with it.
    const out = await post(`/ur/account/orders/${open}/reorder`, {});
    expect([out.statusCode, out.headers.location]).toEqual([303, '/ur/account/login']);
    const over = await post(`/account/orders/${open}/reorder`, {
      cookie: 'hatti_account=sEsSiOn_SeCrEt-EnDeD-0123456789abcdef',
    });
    expect([over.statusCode, over.headers.location]).toEqual([303, '/account/login']);
    expect(over.headers['set-cookie']).toEqual([
      'hatti_account=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      'hatti_signed_in=; Path=/; Max-Age=0; SameSite=Lax',
    ]);
    expect(core.actions).toHaveLength(1);
    await app.close();
  });

  it('gives a signed-in shopper the file of their own data, coming back to their account saying so (ADR-572)', async () => {
    const app = server();
    const cookie = signedIn();
    const page = await app.inject({
      method: 'GET',
      url: '/account',
      headers: { host: 'localhost', cookie },
    });
    expect(page.body).toContain('<h2 id="your-data-title">Your data</h2>');
    expect(page.body).toMatch(
      /<form method="post" action="\/account\/data\/export" accept-charset="UTF-8"><input type="hidden" name="form_type" value="customer_data_export">\s*<button type="submit" class="button button--secondary">Download my data<\/button>/,
    );
    expect(page.body).not.toContain('role="status"');

    const asked = await app.inject({
      method: 'POST',
      url: '/account/data/export',
      headers: { ...FORM, cookie },
      payload: form({ form_type: 'customer_data_export' }),
    });
    expect([asked.statusCode, asked.headers.location, asked.headers['cache-control']]).toEqual([
      303,
      '/account?data_request=export_ready#your-data',
      'private, no-store',
    ]);
    expect(core.dataAsked).toEqual([['export', ACCOUNT_TOKEN]]);
    // Back on the account, saying so, with the file to download while it is kept.
    core.accounts.set(ACCOUNT_TOKEN, {
      ...ACCOUNT,
      dataRequests: { ...ACCOUNT.dataRequests, export: core.dataFiles.get(ACCOUNT_TOKEN)! },
    });
    const ready = await app.inject({
      method: 'GET',
      url: '/account?data_request=export_ready',
      headers: { host: 'localhost', cookie },
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.body).toContain(
      '<p class="account__notice" role="status">Your data is ready. Download it below.</p>',
    );
    expect(ready.body).toContain(
      '<a class="button" href="/account/data/export">Download your file</a>',
    );
    expect(ready.body).toContain('Your file is kept until 20 October 2026.');
    expect(ready.body).not.toContain('value="customer_data_export"');
    // Downloaded through a link the core signs each time, which the page never holds.
    expect(ready.body).not.toContain('storage.test');
    const download = await app.inject({
      method: 'GET',
      url: '/account/data/export',
      headers: { host: 'localhost', cookie },
    });
    expect([download.statusCode, download.headers.location]).toEqual([303, SIGNED_FILE]);
    expect(download.headers['cache-control']).toBe('private, no-store');
    // Gone since: back to the account, saying so.
    core.dataFiles.clear();
    const gone = await app.inject({
      method: 'GET',
      url: '/ur/account/data/export',
      headers: { host: 'localhost', cookie },
    });
    expect([gone.statusCode, gone.headers.location]).toEqual([
      302,
      '/ur/account?data_request=export_gone#your-data',
    ]);
    const goneSaid = await app.inject({
      method: 'GET',
      url: '/ur/account?data_request=export_gone',
      headers: { host: 'localhost', cookie },
    });
    expect(goneSaid.body).toContain('یہ فائل اب محفوظ نہیں۔ نئی فائل منگوائیں۔');
    // A notice the page does not know says nothing.
    const unknown = await app.inject({
      method: 'GET',
      url: '/account?data_request=%3Cscript%3E',
      headers: { host: 'localhost', cookie },
    });
    expect(unknown.body).not.toContain('role="status"');

    // A number the shop keeps nothing of: nothing to download, as the page says, in Urdu too.
    core.accounts.set(ACCOUNT_TOKEN, {
      ...ACCOUNT,
      orders: [],
      dataRequests: { ...ACCOUNT.dataRequests, available: false },
    });
    const none = await app.inject({
      method: 'POST',
      url: '/ur/account/data/export',
      headers: { ...FORM, cookie },
      payload: form({ form_type: 'customer_data_export' }),
    });
    expect(none.headers.location).toBe('/ur/account?data_request=export_none#your-data');
    const noneSaid = await app.inject({
      method: 'GET',
      url: '/ur/account?data_request=export_none',
      headers: { host: 'localhost', cookie },
    });
    expect(noneSaid.body).toContain(
      'ہمارے پاس ابھی آپ کا کوئی ڈیٹا محفوظ نہیں، اس لیے ڈاؤن لوڈ کرنے کو کچھ نہیں۔',
    );
    expect(noneSaid.body).toContain('<p>ہمارے پاس ابھی آپ کا کوئی ڈیٹا محفوظ نہیں۔</p>');
    expect(noneSaid.body).not.toContain('customer_data_erase');
    await app.close();
  });

  it("asks for a shopper's erasure only once they say they understand what it means (ADR-572)", async () => {
    const app = server();
    const cookie = signedIn();
    const page = await app.inject({
      method: 'GET',
      url: '/account',
      headers: { host: 'localhost', cookie },
    });
    // What happens, as the core's rules have it, and the box to tick.
    expect(page.body).toContain(
      'Your data is deleted after 10 days. Until then the shop can cancel the request',
    );
    expect(page.body).toContain('deleting waits until it has been delivered or cancelled.');
    expect(page.body).toContain('deleting waits until the shop has settled it with you.');
    expect(page.body).toContain('but without your name, number, email or address.');
    expect(page.body).toMatch(
      /<form method="post" action="\/account\/data\/erase" accept-charset="UTF-8" class="account__erase"><input type="hidden" name="form_type" value="customer_data_erase">/,
    );
    expect(page.body).toContain(
      '<input type="checkbox" name="customer[confirm]" value="1" required>',
    );
    expect(page.body).toContain('<span>I understand</span>');

    // Not ticked: the page again, saying why, and nothing asked.
    const unticked = await app.inject({
      method: 'POST',
      url: '/account/data/erase',
      headers: { ...FORM, cookie },
      payload: form({ form_type: 'customer_data_erase' }),
    });
    expect(unticked.statusCode).toBe(422);
    expect(unticked.headers['cache-control']).toBe('private, no-store');
    expect(unticked.body).toContain(
      'Tick the box to say you understand what deleting your data means.',
    );
    expect(core.dataAsked).toEqual([]);
    const untickedUrdu = await app.inject({
      method: 'POST',
      url: '/ur/account/data/erase',
      headers: { ...FORM, cookie },
      payload: form({ 'customer[confirm]': 'yes' }),
    });
    expect(untickedUrdu.statusCode).toBe(422);
    expect(untickedUrdu.body).toContain(
      'اپنا ڈیٹا حذف کرنے کا مطلب سمجھنے کی تصدیق کے لیے خانے پر نشان لگائیں۔',
    );
    expect(core.dataAsked).toEqual([]);

    // Ticked: asked for, and back on the account, saying so.
    const asked = await app.inject({
      method: 'POST',
      url: '/ur/account/data/erase',
      headers: { ...FORM, cookie },
      payload: form({ form_type: 'customer_data_erase', 'customer[confirm]': '1' }),
    });
    expect([asked.statusCode, asked.headers.location]).toEqual([
      303,
      '/ur/account?data_request=erase_requested#your-data',
    ]);
    expect(core.dataAsked).toEqual([['erase', ACCOUNT_TOKEN]]);
    // In the page's language, to be told in once it is done (ADR-582).
    expect(core.eraseLocales).toEqual(['ur']);
    core.accounts.set(ACCOUNT_TOKEN, {
      ...ACCOUNT,
      dataRequests: {
        ...ACCOUNT.dataRequests,
        erasure: core.erasure as Exclude<AccountDataEraseResponse, { state: 'none' }>,
      },
    });
    const urdu = await app.inject({
      method: 'GET',
      url: '/ur/account?data_request=erase_requested',
      headers: { host: 'localhost', cookie },
    });
    expect(urdu.body).toContain('آپ کا ڈیٹا حذف کرنے کی درخواست ہمیں مل گئی ہے۔');
    expect(urdu.body).toContain('درخواست منسوخ کرنے کے لیے دکان سے رابطہ کریں۔');
    expect(urdu.body).not.toContain('customer_data_erase');
    const english = await app.inject({
      method: 'GET',
      url: '/account',
      headers: { host: 'localhost', cookie },
    });
    expect(english.body).toContain('<p>Your data will be deleted after 29 October 2026.</p>');
    // Held by an open order, or store credit left, it says so.
    core.accounts.set(ACCOUNT_TOKEN, {
      ...ACCOUNT,
      dataRequests: {
        ...ACCOUNT.dataRequests,
        erasure: {
          state: 'held',
          requestedAt: '2026-10-19T10:00:00.000Z',
          eraseAfter: '2026-10-29T10:00:00.000Z',
        },
      },
    });
    const held = await app.inject({
      method: 'GET',
      url: '/account',
      headers: { host: 'localhost', cookie },
    });
    expect(held.body).toContain(
      'Your data will be deleted after 29 October 2026, once your open orders are closed and any store credit left is settled.',
    );

    // A number the shop keeps nothing of: nothing to delete.
    core.accounts.set(ACCOUNT_TOKEN, {
      ...ACCOUNT,
      dataRequests: { ...ACCOUNT.dataRequests, available: false },
    });
    const none = await app.inject({
      method: 'POST',
      url: '/account/data/erase',
      headers: { ...FORM, cookie },
      payload: form({ 'customer[confirm]': '1' }),
    });
    expect(none.headers.location).toBe('/account?data_request=erase_none#your-data');
    await app.close();
  });

  it("refuses shoppers' data requests from other sites, and from no one signed in (ADR-572)", async () => {
    const app = server();
    const cookie = signedIn();
    for (const url of ['/account/data/export', '/ur/account/data/erase']) {
      const elsewhere = await app.inject({
        method: 'POST',
        url,
        headers: { ...FORM, cookie, 'sec-fetch-site': 'cross-site' },
        payload: form({ 'customer[confirm]': '1' }),
      });
      expect(elsewhere.statusCode).toBe(403);
      expect(elsewhere.headers['cache-control']).toBe('private, no-store');
    }
    expect(core.dataAsked).toEqual([]);
    // The shop's own pages may.
    const own = await app.inject({
      method: 'POST',
      url: '/account/data/export',
      headers: { ...FORM, cookie, 'sec-fetch-site': 'same-origin' },
    });
    expect(own.statusCode).toBe(303);

    // No one signed in: to sign in first.
    for (const url of ['/account/data/export', '/account/data/erase']) {
      const out = await app.inject({
        method: 'POST',
        url,
        headers: FORM,
        payload: form({ 'customer[confirm]': '1' }),
      });
      expect([out.statusCode, out.headers.location]).toEqual([303, '/account/login']);
    }
    const download = await app.inject({
      method: 'GET',
      url: '/ur/account/data/export',
      headers: { host: 'localhost' },
    });
    expect([download.statusCode, download.headers.location]).toEqual([
      302,
      '/ur/account/login?return_to=%2Fur%2Faccount',
    ]);
    // A session that is over: to sign in, its cookies gone.
    const over = await app.inject({
      method: 'POST',
      url: '/account/data/erase',
      headers: { ...FORM, cookie: 'hatti_account=sEsSiOn_SeCrEt-EnDeD-0123456789abcdef' },
      payload: form({ 'customer[confirm]': '1' }),
    });
    expect([over.statusCode, over.headers.location]).toEqual([303, '/account/login']);
    expect(over.headers['set-cookie']).toEqual([
      'hatti_account=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      'hatti_signed_in=; Path=/; Max-Age=0; SameSite=Lax',
    ]);
    expect(core.dataAsked).toEqual([['export', ACCOUNT_TOKEN]]);
    await app.close();
  });

  it("keeps a signed-in shopper's address book on its own page, adding, changing and removing addresses (ADR-584)", async () => {
    const app = server();
    // No one signed in: to sign in first, and back.
    const out = await app.inject({ method: 'GET', url: '/account/addresses', headers: FORM });
    expect([out.statusCode, out.headers.location]).toEqual([
      302,
      '/account/login?return_to=%2Faccount%2Faddresses',
    ]);

    const cookie = signedIn();
    const empty = await app.inject({
      method: 'GET',
      url: '/account/addresses',
      headers: { ...FORM, cookie },
    });
    expect([empty.statusCode, empty.headers['cache-control']]).toEqual([200, 'private, no-store']);
    expect(empty.body).toContain('You haven&#39;t saved an address yet.');
    expect(empty.body).toMatch(
      /<form method="post" action="\/account\/addresses" accept-charset="UTF-8" id="address_form_new" class="addresses__form addresses__new"><input type="hidden" name="form_type" value="customer_address"><details open>/,
    );

    // Added as Shopify's forms add them: its first and last names, one name.
    const added = await app.inject({
      method: 'POST',
      url: '/account/addresses',
      headers: { ...FORM, cookie },
      payload: form({
        'address[first_name]': 'Ayesha',
        'address[last_name]': 'Khan',
        'address[phone]': '0321 7654321',
        'address[address1]': 'House 12, Street 4',
        'address[landmark]': 'Near the mosque',
        'address[city]': 'Lahore',
      }),
    });
    expect([added.statusCode, added.headers.location]).toEqual([303, '/account/addresses']);
    expect(core.addressesSaved).toEqual([
      [
        null,
        {
          name: 'Ayesha Khan',
          phone: '0321 7654321',
          address1: 'House 12, Street 4',
          address2: null,
          landmark: 'Near the mosque',
          city: 'Lahore',
          province: null,
          zip: null,
          default: false,
        },
      ],
    ]);
    const book = await app.inject({
      method: 'GET',
      url: '/account/addresses',
      headers: { ...FORM, cookie },
    });
    expect(book.body).toContain('Default address');
    expect(book.body).toContain('Near the mosque');
    expect(book.body).toMatch(
      /action="\/account\/addresses\/addr_1" accept-charset="UTF-8" id="address_form_addr_1"/,
    );
    expect(book.body).toContain('value="House 12, Street 4"');
    expect(book.body).toMatch(
      /<input type="checkbox" id="address_default_address_addr_1" name="address\[default\]" value="1" checked>/,
    );
    expect(book.body).toMatch(
      /<form method="post" action="\/account\/addresses\/addr_1" class="addresses__remove">\s*<input type="hidden" name="_method" value="delete">/,
    );
    // The account page links to it, saying which is the default.
    const account = await app.inject({
      method: 'GET',
      url: '/account',
      headers: { ...FORM, cookie },
    });
    expect(account.body).toContain('<a href="/account/addresses">Your addresses</a>');
    expect(account.body).toContain('Delivered to first: House 12, Street 4, Lahore, Punjab');

    // Refused, the page again, the form open with what was typed and what was wrong.
    const refused = await app.inject({
      method: 'POST',
      url: '/account/addresses/addr_1',
      headers: { ...FORM, cookie },
      payload: form({
        'address[name]': 'Ayesha Khan',
        'address[phone]': '0321 7654321',
        'address[address1]': 'Flat 3, Gulberg',
        'address[city]': '',
      }),
    });
    expect([refused.statusCode, refused.headers['cache-control']]).toEqual([
      422,
      'private, no-store',
    ]);
    expect(refused.body).toMatch(
      /id="address_form_addr_1" class="addresses__form"><input type="hidden" name="form_type" value="customer_address"><details open>/,
    );
    expect(refused.body).toContain('value="Flat 3, Gulberg"');
    expect(refused.body).toContain('<p>Enter the city.</p>');
    expect(refused.body).not.toMatch(/id="address_form_new"[^>]*><input[^>]*><details open>/);
    // In Urdu, in the page's words, posting where the page is.
    const urdu = await app.inject({
      method: 'POST',
      url: '/ur/account/addresses',
      headers: { ...FORM, cookie },
      payload: form({
        'address[name]': 'Bilal',
        'address[phone]': '123',
        'address[city]': 'Lahore',
      }),
    });
    expect(urdu.statusCode).toBe(422);
    expect(urdu.body).toContain('<p>پاکستانی موبائل نمبر درج کریں، جیسے 0300 1234567۔</p>');
    expect(urdu.body).toMatch(
      /action="\/ur\/account\/addresses" accept-charset="UTF-8" id="address_form_new"/,
    );
    expect(urdu.body).toMatch(/action="\/ur\/account\/addresses\/addr_1"/);

    // Changed and made the default, then removed.
    const second = await app.inject({
      method: 'POST',
      url: '/account/addresses',
      headers: { ...FORM, cookie },
      payload: form({
        'address[name]': 'Ayesha Khan',
        'address[phone]': '03217654321',
        'address[address1]': 'Office 9, Mall Road',
        'address[city]': 'Lahore',
        'address[default]': '1',
      }),
    });
    expect(second.headers.location).toBe('/account/addresses');
    expect(core.addressBooks.get(ACCOUNT_TOKEN)!.map((each) => [each.id, each.default])).toEqual([
      ['addr_2', true],
      ['addr_1', false],
    ]);
    const removed = await app.inject({
      method: 'POST',
      url: '/account/addresses/addr_2',
      headers: { ...FORM, cookie },
      payload: form({ _method: 'delete' }),
    });
    expect([removed.statusCode, removed.headers.location]).toEqual([303, '/account/addresses']);
    expect(core.addressBooks.get(ACCOUNT_TOKEN)!.map((each) => [each.id, each.default])).toEqual([
      ['addr_1', true],
    ]);
    await app.close();
  });

  it('refuses address changes from other sites and from no one signed in, and says when the book is full (ADR-584)', async () => {
    const app = server();
    const cookie = signedIn();
    const typed = form({
      'address[name]': 'Ayesha Khan',
      'address[phone]': '0321 7654321',
      'address[address1]': 'House 12',
      'address[city]': 'Lahore',
    });
    const elsewhere = await app.inject({
      method: 'POST',
      url: '/account/addresses',
      headers: { ...FORM, cookie, 'sec-fetch-site': 'cross-site' },
      payload: typed,
    });
    expect([elsewhere.statusCode, elsewhere.headers['cache-control']]).toEqual([
      403,
      'private, no-store',
    ]);
    const nobody = await app.inject({
      method: 'POST',
      url: '/ur/account/addresses',
      headers: FORM,
      payload: typed,
    });
    expect([nobody.statusCode, nobody.headers.location]).toEqual([303, '/ur/account/login']);
    expect(core.addressesSaved).toEqual([]);

    // An address not theirs.
    const lost = await app.inject({
      method: 'POST',
      url: '/account/addresses/addr_404',
      headers: { ...FORM, cookie },
      payload: typed,
    });
    expect(lost.statusCode).toBe(422);
    expect(lost.body).toContain('<p>That address is no longer in your account.</p>');

    // A full book offers no new one, and refuses one posted all the same.
    core.addressBooks.set(
      ACCOUNT_TOKEN,
      Array.from({ length: ACCOUNT_ADDRESSES_MAX }, (_, index) => ({
        id: `addr_${index + 1}`,
        name: 'Ayesha Khan',
        phone: '+923217654321',
        address1: `House ${index + 1}`,
        address2: null,
        landmark: null,
        city: 'Lahore',
        provinceCode: 'PB',
        province: 'Punjab',
        zip: null,
        default: index === 0,
      })),
    );
    const full = await app.inject({
      method: 'GET',
      url: '/account/addresses',
      headers: { ...FORM, cookie },
    });
    expect(full.body).toContain('You can keep 20 addresses. Remove one to add another.');
    expect(full.body).not.toContain('id="address_form_new"');
    const more = await app.inject({
      method: 'POST',
      url: '/account/addresses',
      headers: { ...FORM, cookie },
      payload: typed,
    });
    // Refused, the page says why as it did.
    expect(more.statusCode).toBe(422);
    expect(more.body).toContain(
      '<p class="addresses__full">You can keep 20 addresses. Remove one to add another.</p>',
    );

    // A session that is over: to sign in, its cookies gone.
    const over = await app.inject({
      method: 'POST',
      url: '/account/addresses',
      headers: { ...FORM, cookie: 'hatti_account=sEsSiOn_SeCrEt-EnDeD-0123456789abcdef' },
      payload: typed,
    });
    expect([over.statusCode, over.headers.location]).toEqual([303, '/account/login']);
    expect(over.headers['set-cookie']).toEqual([
      'hatti_account=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      'hatti_signed_in=; Path=/; Max-Age=0; SameSite=Lax',
    ]);
    await app.close();
  });

  /** A script's request of the shopper's wishlist, from the shop's own page, as JSON. */
  const WISHLIST = {
    host: 'localhost',
    origin: 'http://localhost',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  };

  it("gives each card its variants and their prices, for a reseller's own price (ADR-782)", async () => {
    const app = server();
    const page = await app.inject({
      method: 'GET',
      url: '/collections/all',
      headers: { host: 'localhost' },
    });
    expect(page.statusCode).toBe(200);
    const [first] = sampleStore().products as [ProductDoc];
    const pairs = first.variants.map((variant) => `${variant.id}:${variant.price}`).join(',');
    expect(page.body).toContain(`data-card-own-price="${pairs}"`);
    // Hidden until the header's script, signed in, finds a lower price of the reseller's own.
    expect(page.body).toMatch(/data-words="Your price: \{price\}"\s+hidden/);
    await app.close();
  });

  it("answers a signed-in shopper's own prices for a product page's script (ADR-781)", async () => {
    const app = server();
    const cookie = signedIn();
    const [lawn] = sampleStore().products as [ProductDoc];
    const [first, second] = lawn.variants.map((variant) => variant.id) as [string, string];
    core.ownPrices.set(first, 160_000);
    const ask = (url: string, headers: Record<string, string> = WISHLIST) =>
      app.inject({ method: 'GET', url, headers: { ...headers, cookie } });

    const priced = await ask(`/account/prices.json?variants=${first},${second},${first}`);
    expect([priced.statusCode, priced.json()]).toEqual([
      200,
      { prices: { [first]: { amount: 160_000, formatted: 'Rs 1,600' } } },
    ]);
    expect(priced.headers['cache-control']).toBe('private, no-store');
    expect(core.pricesAsked).toEqual([[first, second]]);

    // What is not variants' IDs is not asked of the core; nor is another site's page.
    expect((await ask('/account/prices.json?variants=a%20lawn')).statusCode).toBe(422);
    const many = Array.from({ length: 101 }, (_, index) => `v${index}`).join(',');
    expect((await ask(`/account/prices.json?variants=${many}`)).statusCode).toBe(422);
    expect(
      (
        await ask(`/account/prices.json?variants=${first}`, {
          ...WISHLIST,
          origin: 'https://evil.example',
        })
      ).statusCode,
    ).toBe(403);
    expect(core.pricesAsked).toHaveLength(1);

    // Signed out: 401, and the sign of being signed in gone.
    const over = await app.inject({
      method: 'GET',
      url: `/account/prices.json?variants=${first}`,
      headers: { ...WISHLIST, cookie: 'hatti_account=sEsSiOn_SeCrEt-EnDeD-0123456789abcdef' },
    });
    expect(over.statusCode).toBe(401);
    expect(over.headers['set-cookie']).toContain(
      'hatti_signed_in=; Path=/; Max-Age=0; SameSite=Lax',
    );
    await app.close();
  });

  it("keeps a signed-in shopper's wishlist with their account, by the products' handles (ADR-575)", async () => {
    const app = server();
    const cookie = signedIn();
    const [lawn, khussa, kurta] = sampleStore().products as [ProductDoc, ProductDoc, ProductDoc];
    const ask = (url: string, payload?: unknown) =>
      app.inject({
        method: payload === undefined ? 'GET' : 'POST',
        url,
        headers: { ...WISHLIST, cookie },
        ...(payload !== undefined && { payload: JSON.stringify(payload) }),
      });

    const empty = await ask('/account/wishlist.json');
    expect([empty.statusCode, empty.json()]).toEqual([200, { handles: [] }]);
    expect([empty.headers['cache-control'], empty.headers['x-robots-tag']]).toEqual([
      'private, no-store',
      'noindex',
    ]);
    expect(empty.headers['cache-tag']).toBeUndefined();

    // The browser's list joins the account's, by the products' IDs, each once, those the shop
    // does not show left out; the list comes back as it is then, by their handles.
    const joined = await ask('/account/wishlist', {
      handles: [khussa.handle, 'no-such-product', lawn.handle, khussa.handle],
    });
    expect([joined.statusCode, joined.json()]).toEqual([
      200,
      { handles: [khussa.handle, lawn.handle] },
    ]);
    expect(joined.headers['cache-control']).toBe('private, no-store');
    const added = await ask('/ur/account/wishlist', { handles: [kurta.handle] });
    expect(added.json()).toEqual({ handles: [kurta.handle, khussa.handle, lawn.handle] });
    expect(core.wishlistAsked).toEqual([
      ['read', ACCOUNT_TOKEN, []],
      ['add', ACCOUNT_TOKEN, [khussa.id, lawn.id]],
      ['add', ACCOUNT_TOKEN, [kurta.id]],
    ]);

    // Taken off; one the shop no longer shows is in it no longer either.
    const removed = await ask('/account/wishlist/remove', { handle: khussa.handle });
    expect(removed.json()).toEqual({ handles: [kurta.handle, lawn.handle] });
    const unknown = await ask('/account/wishlist/remove', { handle: 'no-such-product' });
    expect(unknown.json()).toEqual({ handles: [kurta.handle, lawn.handle] });
    expect(core.wishlistAsked.slice(3)).toEqual([
      ['remove', ACCOUNT_TOKEN, [khussa.id]],
      ['read', ACCOUNT_TOKEN, []],
    ]);
    core.wishlists.set(ACCOUNT_TOKEN, ['p-gone', lawn.id]);
    expect((await ask('/ur/account/wishlist.json')).json()).toEqual({ handles: [lawn.handle] });

    // What is not a list of handles, or too long, is not asked of the core.
    const asked = core.wishlistAsked.length;
    for (const payload of [
      { handles: 'khussa' },
      { handles: [1] },
      { handles: [''] },
      { handles: Array.from({ length: 101 }, (_, index) => `product-${index}`) },
    ]) {
      expect((await ask('/account/wishlist', payload)).statusCode).toBe(422);
    }
    expect((await ask('/account/wishlist/remove', { handle: ['khussa'] })).statusCode).toBe(422);
    expect(core.wishlistAsked).toHaveLength(asked);
    await app.close();
  });

  it('refuses wishlists from other sites and other shops, and from no one signed in (ADR-575)', async () => {
    const app = server();
    const cookie = signedIn();
    const lawn = sampleStore().products[0]!;
    const refused = [
      // Another site, or another address on the same site, such as another shop's.
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      { origin: 'https://elsewhere.example' },
      { origin: 'http://zari.localhost' },
      { origin: 'null' },
    ];
    for (const headers of refused) {
      for (const [method, url] of [
        ['GET', '/account/wishlist.json'],
        ['POST', '/account/wishlist'],
        ['POST', '/ur/account/wishlist/remove'],
      ] as const) {
        const answer = await app.inject({
          method,
          url,
          headers: { host: 'localhost', 'content-type': 'application/json', cookie, ...headers },
          ...(method === 'POST' && { payload: JSON.stringify({ handles: [lawn.handle] }) }),
        });
        expect([answer.statusCode, answer.headers['cache-control']]).toEqual([
          403,
          'private, no-store',
        ]);
      }
    }
    // A form, which another site's page could post, is not JSON.
    const posted = await app.inject({
      method: 'POST',
      url: '/account/wishlist',
      headers: {
        host: 'localhost',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: form({ 'handles[]': lawn.handle }),
    });
    expect(posted.statusCode).toBe(415);
    const plain = await app.inject({
      method: 'POST',
      url: '/account/wishlist',
      headers: { host: 'localhost', cookie, 'content-type': 'text/plain' },
      payload: JSON.stringify({ handles: [lawn.handle] }),
    });
    expect(plain.statusCode).toBe(415);
    expect(core.wishlistAsked).toEqual([]);

    // A browser that says nothing of where it is may, as forms may.
    const bare = await app.inject({
      method: 'GET',
      url: '/account/wishlist.json',
      headers: { host: 'localhost', cookie },
    });
    expect(bare.statusCode).toBe(200);

    // No one signed in: 401, with nothing asked of the core and no cookies changed.
    const out = await app.inject({
      method: 'POST',
      url: '/account/wishlist',
      headers: WISHLIST,
      payload: JSON.stringify({ handles: [lawn.handle] }),
    });
    expect([out.statusCode, out.headers['set-cookie'], out.headers['cache-control']]).toEqual([
      401,
      undefined,
      'private, no-store',
    ]);
    // A session that is over: 401, its cookies gone.
    const over = await app.inject({
      method: 'GET',
      url: '/account/wishlist.json',
      headers: { ...WISHLIST, cookie: 'hatti_account=sEsSiOn_SeCrEt-EnDeD-0123456789abcdef' },
    });
    expect(over.statusCode).toBe(401);
    expect(over.headers['set-cookie']).toEqual([
      'hatti_account=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      'hatti_signed_in=; Path=/; Max-Age=0; SameSite=Lax',
    ]);
    expect(core.wishlistAsked).toEqual([['read', ACCOUNT_TOKEN, []]]);

    // The core cannot be reached: said so.
    core.accountWishlist = () => Promise.reject(new StorefrontApiError(503, 'Restarting'));
    const down = await app.inject({
      method: 'GET',
      url: '/account/wishlist.json',
      headers: { ...WISHLIST, cookie },
    });
    expect(down.statusCode).toBe(503);
    await app.close();
  });

  it("links the account to the shop's wishlist page, where the theme says to, and its script keeps the wishlist with the account (ADR-575)", async () => {
    const files = await readThemeDir(THEME_DIR);
    const linked = loadTheme({
      ...files,
      'templates/customers/account.json': JSON.stringify({
        sections: { main: { type: 'main-account', settings: { wishlist: true } } },
        order: ['main'],
      }),
    });
    const app = server({
      theme: linked,
      renderer: new PageRenderer(linked, { limits: { timeMs: 10_000 } }),
    });
    const cookie = signedIn();
    const page = await app.inject({
      method: 'GET',
      url: '/account',
      headers: { host: 'localhost', cookie },
    });
    expect(page.body).toMatch(
      /<p class="account__wishlist">\s*<a href="\/pages\/wishlist">Your wishlist<\/a>/,
    );
    expect(page.body).toContain(
      'Kept with your account, on every phone or computer you sign in on.',
    );
    const urdu = await app.inject({
      method: 'GET',
      url: '/ur/account',
      headers: { host: 'localhost', cookie },
    });
    expect(urdu.body).toMatch(/<a href="\/ur\/pages\/wishlist">آپ کی پسندیدہ فہرست<\/a>/);
    // Not unless the theme says so: the shop may have no such page.
    const plain = server();
    const unlinked = await plain.inject({
      method: 'GET',
      url: '/account',
      headers: { host: 'localhost', cookie: signedIn() },
    });
    expect(unlinked.statusCode).toBe(200);
    expect(unlinked.body).not.toContain('<p class="account__wishlist">');

    // Every page's script tells the account of the hearts pressed, and joins the lists once a
    // visit, for a shopper signed in; the pages themselves are the same for everyone.
    const home = await plain.inject({ method: 'GET', url: '/', headers: { host: 'localhost' } });
    expect(home.headers['cache-control']).toMatch(/^public, /);
    expect(home.body).toContain("this.account('/account/wishlist', { handles: [handle] })");
    expect(home.body).toContain("this.account('/account/wishlist/remove', { handle })");
    expect(home.body).toContain("lists.account('/account/wishlist', { handles: lists.handles() })");
    await app.close();
    await plain.close();
  });
});

describe.skipIf(!redisUrl)('The storefront server', () => {
  const redis = new Redis(redisUrl ?? '', { lazyConnect: true });
  const prefix = `test-sfs-${randomBytes(4).toString('hex')}`;
  const keys = new StorefrontKeys(prefix);
  const queue = new BuildQueue(redis, { keys });
  const directory = new ShopDirectory(redis, keys);
  const [zari, bazaar, gone] = [randomUUID(), randomUUID(), randomUUID()];
  let theme: Theme;

  /** Publishes a shop's documents as the core does, and names it in the directory. */
  const publish = async (shopId: string, handle: string, documents: StoreDocuments) => {
    await queue.add(shopId, ['sample']);
    await queue.drain(shopId, async ({ writer }) => {
      await writer.putShop({ ...documents.shop, handle });
      await writer.putProducts(documents.products);
      await writer.putCollections(documents.collections);
      await writer.putMenus(documents.menus);
    });
    await directory.set(shopId, handle);
  };

  beforeAll(async () => {
    theme = loadTheme(await readThemeDir(THEME_DIR));
    const sample = sampleStore();
    await publish(zari, 'zari', sample);
    await publish(bazaar, 'bazaar', {
      ...sample,
      shop: { ...sample.shop, name: 'Bazaar of Lahore' },
      products: sample.products.slice(0, 10),
    });
    await directory.set(gone, 'gone');
  });

  afterAll(async () => {
    const found = await redis.keys(`${prefix}:*`);
    if (found.length > 0) await redis.del(...found);
    redis.disconnect();
  });

  const server = (core?: FakeCore) => {
    const sample = sampleStore();
    return createStorefrontServer({
      theme,
      // Time enough for a first render, which parses the theme, on a busy runner.
      renderer: new PageRenderer(theme, { limits: { timeMs: 10_000 } }),
      domain: 'localhost',
      redis,
      keys,
      sample: new MemoryStore({ ...sample, shop: { ...sample.shop, name: 'Sample' } }),
      core,
    });
  };

  it("counts a shopper's session, and its way to an order, as the page's script says (ADR-180)", async () => {
    const core = new FakeCore();
    const served = server(core);
    // From an address of its own: its cart's changes count against no other test's limit.
    const app = {
      inject: (request: InjectOptions) =>
        served.inject({ ...request, remoteAddress: '203.0.113.180' }),
      close: () => served.close(),
    };
    const activity = new StorefrontActivity(redis, keys);
    const today = localDay(new Date(), 'Asia/Karachi');
    const shopper = {
      host: 'zari.localhost',
      cookie: 'cart=secret-9; hatti_session=AbCdEfGhIjKlMnOpQrStUv',
      'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) Chrome/129.0.0.0 Mobile Safari/537.36',
    };
    // A shopper's page carries the script that tells of it.
    const home = await app.inject({ method: 'GET', url: '/', headers: shopper });
    expect(home.body).toContain(`navigator.sendBeacon('/.hatti/visit', body)`);
    // Its first page says where the session came from (ADR-884); its next pages, nothing.
    const arrival = JSON.stringify({
      b: 1,
      l: '/collections/eid',
      r: 'https://l.instagram.com/',
      s: null,
    });
    const seen = await app.inject({
      method: 'POST',
      url: '/.hatti/visit',
      headers: { ...shopper, 'content-type': 'text/plain;charset=UTF-8' },
      payload: arrival,
    });
    expect([seen.statusCode, seen.headers['cache-control']]).toEqual([204, 'no-store']);
    await app.inject({
      method: 'POST',
      url: '/.hatti/visit',
      headers: { ...shopper, 'content-type': 'text/plain;charset=UTF-8' },
      payload: arrival,
    });
    expect(await activity.origins(zari, today)).toEqual({
      source: { instagram: 1 },
      landing_page: { '/collections/eid': 1 },
      device: { mobile: 1 },
    });
    // Nothing counted for a robot, without a session or for a session that is no ID.
    for (const headers of [
      { ...shopper, 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      { ...shopper, cookie: 'cart=secret-9' },
      { ...shopper, cookie: 'hatti_session=short' },
    ]) {
      const ignored = await app.inject({ method: 'POST', url: '/.hatti/visit', headers });
      expect(ignored.statusCode).toBe(204);
    }
    const nowhere = { ...shopper, host: 'nobody.localhost' };
    expect(
      (await app.inject({ method: 'POST', url: '/.hatti/visit', headers: nowhere })).statusCode,
    ).toBe(404);
    expect(await activity.counts(zari, today)).toEqual({
      sessions: 1,
      added_to_cart: 0,
      reached_checkout: 0,
      converted: 0,
    });
    expect(await activity.liveVisitors(zari)).toBe(1);

    // On its way to an order: added to its cart, at checkout, and placed.
    const empty: CartJson = {
      note: '',
      attributes: {},
      items: [],
      itemCount: 0,
      subtotal: 0,
      totalWeightGrams: 0,
      discount: null,
      totalDiscount: 0,
    };
    core.answer = () => ({ ok: true, cart: empty, token: 'secret-9', added: [] });
    const variantId = sampleStore().products[0]!.variants[0]!.id;
    const added = await app.inject({
      method: 'POST',
      url: '/cart/add.js',
      headers: { ...shopper, 'content-type': 'application/json' },
      payload: { id: variantId, quantity: 1 },
    });
    expect(added.statusCode).toBe(200);
    core.page = { placed: false, status: 200, headers: {}, html: '<p>Checkout</p>' };
    await app.inject({ method: 'GET', url: '/checkouts/c-secret', headers: shopper });
    core.page = { placed: true };
    const placed = await app.inject({
      method: 'POST',
      url: '/checkouts/c-secret',
      headers: { ...shopper, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'name=Ayesha',
    });
    expect(placed.statusCode).toBe(303);
    expect(await activity.counts(zari, today)).toEqual({
      sessions: 1,
      added_to_cart: 1,
      reached_checkout: 1,
      converted: 1,
    });
    // Another shop's sessions are its own.
    expect((await activity.counts(bazaar, today)).sessions).toBe(0);
    await app.close();
  });

  it("counts how fast shoppers' pages were, by kind and device, as their script reports it (ADR-485)", async () => {
    const served = server();
    const app = {
      inject: (request: InjectOptions) =>
        served.inject({ ...request, remoteAddress: '203.0.113.185' }),
    };
    const vitals = new StorefrontVitals(redis, keys);
    const today = localDay(new Date(), 'Asia/Karachi');
    const shopper = {
      host: 'zari.localhost',
      cookie: 'hatti_session=AbCdEfGhIjKlMnOpQrStUv',
      'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) Chrome/129.0.0.0 Mobile Safari/537.36',
      'content-type': 'text/plain;charset=UTF-8',
    };
    // A product's page carries the script, saying its kind.
    const handle = sampleStore().products[0]!.handle;
    const page = await app.inject({ method: 'GET', url: `/products/${handle}`, headers: shopper });
    expect(page.body).toContain('<script data-hatti-vitals data-template="product">');
    expect(page.body).toContain(`navigator.sendBeacon('/.hatti/vitals'`);

    const report = (payload: string, headers: Record<string, string> = shopper) =>
      app.inject({ method: 'POST', url: '/.hatti/vitals', headers, payload });
    const sent = await report(JSON.stringify({ t: 'product', lcp: 2210.4, cls: 0.02, inp: 72 }));
    expect([sent.statusCode, sent.headers['cache-control']]).toEqual([204, 'no-store']);
    // Not counted for a robot or without a session; refused when it is no report, or too long.
    expect(
      (await report('{"t":"index","lcp":900}', { ...shopper, 'user-agent': 'Googlebot/2.1' }))
        .statusCode,
    ).toBe(204);
    expect((await report('{"t":"index","lcp":900}', { ...shopper, cookie: '' })).statusCode).toBe(
      204,
    );
    expect((await report('lcp=900')).statusCode).toBe(400);
    expect(
      (await report(JSON.stringify({ t: 'index', lcp: 1, pad: 'x'.repeat(2000) }))).statusCode,
    ).toBe(413);
    expect((await report('{"lcp":900}', { ...shopper, host: 'nobody.localhost' })).statusCode).toBe(
      404,
    );

    const { histograms, pageViews } = await vitals.histograms(zari, [today]);
    expect(Object.fromEntries(pageViews)).toEqual({ 'mobile:product': 1 });
    // And across every shop, for the objective of 12 §1 (ADR-729): the counted report alone.
    const paints = await recorded.histogram('hatti.storefront.lcp');
    expect(
      paints.map((point) => [
        point.attributes,
        point.count,
        point.atMost.get(2000),
        point.atMost.get(2500),
      ]),
    ).toEqual([[{ device: 'mobile', template: 'product' }, 1, 0, 1]]);
    expect(summarize('lcp', histograms.get('mobile:product:lcp')!)).toMatchObject({
      samples: 1,
      p75: 2500,
      rating: 'good',
    });
    expect((await vitals.histograms(bazaar, [today])).pageViews.size).toBe(0);
    await served.close();
  });

  it("counts shoppers' searches by their words, and those that found nothing, as their pages report them (ADR-683)", async () => {
    const core = new FakeCore();
    const served = server(core);
    const app = {
      inject: (request: InjectOptions) =>
        served.inject({ ...request, remoteAddress: '203.0.113.186' }),
    };
    const searches = new StorefrontSearches(redis, keys);
    const today = localDay(new Date(), 'Asia/Karachi');
    const shopper = {
      host: 'zari.localhost',
      cookie: 'hatti_session=AbCdEfGhIjKlMnOpQrStUv',
      'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) Chrome/129.0.0.0 Mobile Safari/537.36',
      'content-type': 'text/plain;charset=UTF-8',
    };
    // A search's page carries the script, with how much it found; other pages do not.
    core.found = sampleStore()
      .products.slice(0, 3)
      .map((product) => product.id);
    core.foundContent = { pageIds: [], articleIds: ['a-1'] };
    const page = await app.inject({ method: 'GET', url: '/search?q=Lawn', headers: shopper });
    expect(page.body).toContain('<script data-hatti-search data-found="4">');
    expect(page.body).toContain(`navigator.sendBeacon('/.hatti/search'`);
    const empty = await app.inject({ method: 'GET', url: '/search', headers: shopper });
    expect(empty.body).not.toContain('data-hatti-search');
    const handle = sampleStore().products[0]!.handle;
    const product = await app.inject({
      method: 'GET',
      url: `/products/${handle}`,
      headers: shopper,
    });
    expect(product.body).not.toContain('data-hatti-search');

    const report = (payload: string, headers: Record<string, string> = shopper) =>
      app.inject({ method: 'POST', url: '/.hatti/search', headers, payload });
    const sent = await report(JSON.stringify({ q: 'Lawn  Suit', n: 4 }));
    expect([sent.statusCode, sent.headers['cache-control']]).toEqual([204, 'no-store']);
    expect((await report(JSON.stringify({ q: 'khussa', n: 0 }))).statusCode).toBe(204);
    // Not counted for a robot or without a session; refused when it is no report, or too long.
    const robot = { ...shopper, 'user-agent': 'Googlebot/2.1' };
    expect((await report('{"q":"lawn","n":1}', robot)).statusCode).toBe(204);
    expect((await report('{"q":"lawn","n":1}', { ...shopper, cookie: '' })).statusCode).toBe(204);
    expect((await report('q=lawn')).statusCode).toBe(400);
    expect((await report('{"q":"  ","n":1}')).statusCode).toBe(400);
    expect((await report(JSON.stringify({ q: 'x'.repeat(600), n: 1 }))).statusCode).toBe(413);
    expect(
      (await report('{"q":"lawn","n":1}', { ...shopper, host: 'nobody.localhost' })).statusCode,
    ).toBe(404);

    const counted = await searches.counts(zari, [today]);
    expect([counted.searches, counted.foundNothing]).toEqual([2, 1]);
    expect(counted.terms).toEqual(
      expect.arrayContaining([
        { terms: 'lawn suit', searches: 1, foundNothing: 0 },
        { terms: 'khussa', searches: 1, foundNothing: 1 },
      ]),
    );
    expect((await searches.counts(bazaar, [today])).searches).toBe(0);
    await served.close();
  });

  it("counts each tap on a shop's link page's links, a day at a time, but not a robot's (ADR-204)", async () => {
    const app = server();
    const browser = 'Mozilla/5.0 (Linux; Android 10; K) Chrome/129.0.0.0 Mobile Safari/537.36';
    const tap = (url: string, headers: Record<string, string> = {}) =>
      app.inject({
        method: 'GET',
        url,
        // From an address of its own: its taps count against no other test's limit.
        remoteAddress: '203.0.113.204',
        headers: { host: 'zari.localhost', 'user-agent': browser, ...headers },
      });
    const activity = new StorefrontActivity(redis, keys);
    const today = localDay(new Date(), 'Asia/Karachi');
    const chat = 'https://wa.me/923001234567';
    // Zari's page has its chat on WhatsApp, through the storefront.
    expect((await tap('/links')).body).toContain(`href="/links/to/${linkKey(chat)}"`);

    for (const url of [`/links/to/${linkKey(chat)}`, `/ur/links/to/${linkKey(chat)}`]) {
      const sent = await tap(url);
      expect([sent.statusCode, sent.headers.location]).toEqual([302, chat]);
    }
    // A robot is sent on uncounted, and a link not on the page is never counted.
    const robot = await tap(`/links/to/${linkKey(chat)}`, {
      'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
    });
    expect(robot.headers.location).toBe(chat);
    // Nor a browser's prefetch, or a HEAD request, which are no taps.
    await tap(`/links/to/${linkKey(chat)}`, { 'sec-purpose': 'prefetch;prerender' });
    const head = await app.inject({
      method: 'HEAD',
      url: `/links/to/${linkKey(chat)}`,
      remoteAddress: '203.0.113.204',
      headers: { host: 'zari.localhost', 'user-agent': browser },
    });
    expect(head.statusCode).toBe(302);
    expect((await tap('/links/to/0123456789ab')).headers.location).toBe('/links');
    expect(await activity.linkTaps(zari, today)).toEqual({ [chat]: 2 });
    // Another shop's taps are its own, and the sample shop's are never counted.
    expect(await activity.linkTaps(bazaar, today)).toEqual({});
    expect((await tap(`/links/to/${linkKey(chat)}`, { host: 'localhost' })).statusCode).toBe(302);
    expect(await activity.linkTaps('sample', today)).toEqual({});
    await app.close();
  });

  it("serves each shop at its handle's subdomain, and the sample shop at the domain", async () => {
    const app = server();
    const page = (host: string, url = '/') => app.inject({ method: 'GET', url, headers: { host } });

    const home = await page('zari.localhost:4100');
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('<title>Zari Fashions</title>');
    expect((await page('bazaar.localhost')).body).toContain('<title>Bazaar of Lahore</title>');
    expect((await page('localhost:4100')).body).toContain('<title>Sample</title>');

    // A shop's pages are its own: Bazaar has 10 of Zari's 201 products.
    const product = sampleStore().products[20]!;
    expect((await page('zari.localhost', `/products/${product.handle}`)).statusCode).toBe(200);
    expect((await page('bazaar.localhost', `/products/${product.handle}`)).statusCode).toBe(404);
    expect((await page('zari.localhost', '/ur/')).body).toMatch(/<html lang="ur" dir="rtl">/);
    await app.close();
  });

  it("serves a shop at its own domains, and sends shoppers' pages on to its primary one", async () => {
    const mehr = randomUUID();
    const sample = sampleStore();
    const shop = {
      ...sample.shop,
      name: 'Mehr Crafts',
      handle: 'mehr',
      domain: 'www.mehr.pk',
      domains: ['www.mehr.pk', 'mehr.pk'],
    };
    await publish(mehr, 'mehr', { ...sample, shop });
    await directory.setDomains(mehr, shop.domains);
    const app = server();
    const get = (host: string, url = '/') => app.inject({ method: 'GET', url, headers: { host } });

    const home = await get('www.mehr.pk');
    expect([home.statusCode, home.body]).toEqual([200, expect.stringContaining('Mehr Crafts')]);
    // At its handle's subdomain or its other domain: the same page at the primary one.
    const product = sample.products[3]!;
    const moved = await get('mehr.localhost:4100', `/products/${product.handle}?variant=v1`);
    expect([moved.statusCode, moved.headers.location]).toEqual([
      301,
      `http://www.mehr.pk:4100/products/${product.handle}?variant=v1`,
    ]);
    expect((await get('MEHR.PK.', '/ur/collections/all?page=2')).headers.location).toBe(
      'http://www.mehr.pk/ur/collections/all?page=2',
    );
    // What changes carts, and scripts, answer where they are asked.
    const added = await app.inject({
      method: 'POST',
      url: '/cart/add.js',
      headers: { host: 'mehr.pk', 'content-type': 'application/json' },
      payload: { id: product.variants[0]!.id, quantity: 1 },
    });
    expect(added.statusCode).not.toBe(301);
    expect((await get('www.mehr.pk.evil.pk')).statusCode).toBe(404);
    // A preview stays where its link opened it.
    const core = new FakeCore();
    core.previews.set(PREVIEW_TOKEN, previewing('Mehr Winter', 'Mehr Winter Sale'));
    const previews = server(core);
    const opened = await previews.inject({
      method: 'GET',
      url: `/?preview=${PREVIEW_TOKEN}`,
      headers: { host: 'mehr.localhost:4100' },
    });
    expect([opened.statusCode, opened.body]).toEqual([200, expect.stringContaining('Mehr Winter')]);
    await previews.close();

    // A domain let go no longer answers.
    await directory.setDomains(mehr, ['www.mehr.pk'], shop.domains);
    await app.close();
    const fresh = server();
    expect(
      (await fresh.inject({ method: 'GET', url: '/', headers: { host: 'mehr.pk' } })).statusCode,
    ).toBe(404);
    await fresh.close();
  });

  it("tells crawlers the shop's own address, and lists what Valkey has", async () => {
    const app = createStorefrontServer({
      theme,
      renderer: new PageRenderer(theme, {
        limits: { timeMs: 10_000 },
        platformUrl: 'https://hatti.pk',
      }),
      domain: 'localhost',
      redis,
      keys,
      secureCookies: true,
    });
    const get = (host: string, url: string) =>
      app.inject({ method: 'GET', url, headers: { host } });
    expect((await get('zari.localhost', '/robots.txt')).body).toContain(
      'Sitemap: https://zari.hatti.pk/sitemap.xml',
    );
    const products = (await get('zari.localhost', '/sitemaps/products-1.xml')).body;
    expect([...products.matchAll(/<url>/g)]).toHaveLength(sampleStore().products.length);
    expect(products).toContain('<loc>https://zari.hatti.pk/products/');
    // Bazaar has 10 products of its own.
    const bazaarProducts = (await get('bazaar.localhost', '/sitemaps/products-1.xml')).body;
    expect([...bazaarProducts.matchAll(/<url>/g)]).toHaveLength(10);
    // Their catalog feeds, at the shops' own addresses.
    const feed = (await get('zari.localhost', PRODUCT_FEED_PATH)).body;
    expect(feed).toContain('<g:link>https://zari.hatti.pk/products/');
    const variants = (products: ProductDoc[]) =>
      products.reduce((count, product) => count + product.variants.length, 0);
    expect([...feed.matchAll(/<item>/g)]).toHaveLength(variants(sampleStore().products));
    const bazaarFeed = (await get('bazaar.localhost', PRODUCT_FEED_PATH)).body;
    expect(bazaarFeed).toContain('<title>Bazaar of Lahore</title>');
    expect([...bazaarFeed.matchAll(/<item>/g)]).toHaveLength(
      variants(sampleStore().products.slice(0, 10)),
    );
    await app.close();
  });

  it("shows a shop's own theme, and its next version once published", async () => {
    const sana = randomUUID();
    const sample = sampleStore();
    const shop = { ...sample.shop, name: 'Sana Lawn', handle: 'sana' };
    await publish(sana, 'sana', { ...sample, shop });
    const publishTheme = async (version: number, heading: string) => {
      await queue.add(sana, ['shop']);
      await queue.drain(sana, async ({ writer }) => {
        await writer.putTheme({
          id: 'thm-1',
          version,
          base: 'hatti-base',
          files: { 'templates/index.json': bannerHome(heading) },
        });
        await writer.putShop({ ...shop, theme: { id: 'thm-1', version } });
      });
    };
    const app = server();
    const home = async (host: string) =>
      (await app.inject({ method: 'GET', url: '/', headers: { host } })).body;

    expect(await home('sana.localhost')).toContain('Eid Lawn &#39;26');
    await publishTheme(1, 'Sana Winter Sale');
    expect(await home('sana.localhost')).toContain('Sana Winter Sale');
    // Other shops keep theirs.
    expect(await home('zari.localhost')).toContain('Eid Lawn &#39;26');
    await publishTheme(2, 'Sana Spring Lawn');
    const page = await home('sana.localhost');
    expect(page).toContain('Sana Spring Lawn');
    expect(page).not.toContain('Sana Winter Sale');
    await app.close();
  });

  it('limits how fast an address can change carts', async () => {
    const core = new FakeCore();
    const empty = {
      note: '',
      attributes: {},
      items: [],
      itemCount: 0,
      subtotal: 0,
      totalWeightGrams: 0,
      discount: null,
      totalDiscount: 0,
    };
    core.answer = () => ({ ok: true, cart: empty, token: null, added: [] });
    const app = createStorefrontServer({
      theme,
      renderer: new PageRenderer(theme, { limits: { timeMs: 10_000 } }),
      domain: 'localhost',
      redis,
      keys,
      core,
    });
    const clear = () =>
      app.inject({ method: 'POST', url: '/cart/clear', headers: { host: 'zari.localhost' } });
    for (let change = 0; change < 120; change += 1) expect((await clear()).statusCode).toBe(303);
    const refused = await clear();
    expect([refused.statusCode, refused.body]).toEqual([
      429,
      'Too many changes to the cart. Please wait a moment.\n',
    ]);
    expect(core.actions).toHaveLength(120);
    await app.close();
  });

  it('limits how often an address can search, suggestions among its searches', async () => {
    const core = new FakeCore();
    const app = createStorefrontServer({
      theme,
      renderer: new PageRenderer(theme, { limits: { timeMs: 10_000 } }),
      domain: 'localhost',
      redis,
      keys,
      core,
    });
    const ask = (url: string) =>
      app.inject({ method: 'GET', url, headers: { host: 'bazaar.localhost' } });
    for (let search = 0; search < 120; search += 1) {
      expect((await ask('/search/suggest.json?q=lawn')).statusCode).toBe(200);
      expect((await ask('/search?q=lawn')).statusCode).toBe(200);
    }
    const refused = await ask('/search/suggest.json?q=lawn');
    expect([refused.statusCode, refused.json()]).toMatchObject([
      429,
      { status: 429, message: 'Too Many Requests' },
    ]);
    const page = await ask('/search?q=lawn');
    expect([page.statusCode, page.body]).toEqual([
      429,
      'Too many searches. Please wait a moment.\n',
    ]);
    expect(core.searches).toHaveLength(240);
    await app.close();
  });

  it("limits how many photos an address sends to be read, as each spends the shop's AI credit", async () => {
    const core = new FakeCore();
    core.photoRead = { query: 'lawn', productIds: [] };
    const app = server(core);
    const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/search/photo',
        headers: { host: 'bazaar.localhost', 'content-type': 'application/json' },
        payload: { image: `data:image/png;base64,${PNG}` },
      });
    for (let photo = 0; photo < 10; photo += 1) expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(429);
    expect(core.photos).toHaveLength(10);
    await app.close();
  });

  it('limits how often an address can look up orders (ADR-251)', async () => {
    const core = new FakeCore();
    const app = server(core);
    const answers = [];
    for (let lookup = 0; lookup < 11; lookup += 1) {
      const answer = await app.inject({
        method: 'POST',
        url: '/track',
        headers: { host: 'bazaar.localhost', 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'reference=PX1&phone=03001234567',
      });
      answers.push(answer.statusCode);
    }
    expect(answers).toEqual([...Array<number>(10).fill(200), 429]);
    expect(core.lookups).toHaveLength(10);
    await app.close();
  });

  it('limits how often an address can try to sign in (ADR-571)', async () => {
    const core = new FakeCore();
    const app = server(core);
    const answers = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      const answer = await app.inject({
        method: 'POST',
        url: '/ur/account/login',
        headers: { host: 'bazaar.localhost', 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'customer%5Bphone%5D=03001234567',
        remoteAddress: '203.0.113.71',
      });
      answers.push(answer.statusCode);
      if (answer.statusCode === 429) {
        expect(answer.body).toContain(
          'بہت زیادہ کوششیں۔ براہ کرم ایک منٹ انتظار کر کے دوبارہ کوشش کریں۔',
        );
        expect(answer.headers['cache-control']).toBe('private, no-store');
      }
    }
    expect(answers).toEqual([...Array<number>(20).fill(200), 429]);
    expect(core.loginStarts).toHaveLength(20);
    expect(core.loginStarts[0]!.client).toEqual({ ip: '203.0.113.71' });
    // Codes typed count against the same tries.
    const typed = await app.inject({
      method: 'POST',
      url: '/account/login/verify',
      headers: {
        host: 'bazaar.localhost',
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `hatti_login=${Buffer.from(
          JSON.stringify({ phone: '03001234567', masked: '0300 ••••567', channel: 'whatsapp' }),
        ).toString('base64url')}`,
      },
      payload: 'customer%5Bcode%5D=123456',
      remoteAddress: '203.0.113.71',
    });
    expect(typed.statusCode).toBe(429);
    expect(core.loginVerifies).toHaveLength(0);
    await app.close();
  });

  it("limits how often an address can ask for shoppers' own data (ADR-572)", async () => {
    const core = new FakeCore();
    core.accounts.set(ACCOUNT_TOKEN, ACCOUNT);
    const app = server(core);
    const answers = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const answer = await app.inject({
        method: 'POST',
        url: attempt % 2 === 0 ? '/ur/account/data/export' : '/ur/account/data/erase',
        headers: {
          host: 'bazaar.localhost',
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `hatti_account=${ACCOUNT_TOKEN}`,
        },
        payload: 'customer%5Bconfirm%5D=1',
        remoteAddress: '203.0.113.72',
      });
      answers.push(answer.statusCode);
      if (answer.statusCode === 429) {
        expect(answer.body).toContain(
          'بہت زیادہ کوششیں۔ براہ کرم ایک منٹ انتظار کر کے دوبارہ کوشش کریں۔',
        );
        expect(answer.headers['cache-control']).toBe('private, no-store');
      }
    }
    expect(answers).toEqual([...Array<number>(10).fill(303), 429]);
    expect(core.dataAsked).toHaveLength(10);
    await app.close();
  });

  it("limits how often an address can buy shoppers' orders again (ADR-574)", async () => {
    const core = new FakeCore();
    core.accounts.set(ACCOUNT_TOKEN, ACCOUNT);
    core.answer = () => ({
      ok: true,
      cart: {
        note: '',
        attributes: {},
        items: [],
        itemCount: 1,
        subtotal: 0,
        totalWeightGrams: 0,
        discount: null,
        totalDiscount: 0,
      },
      token: 'cArT-sEcReT-1',
      added: [],
    });
    const app = server(core);
    const answers = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const answer = await app.inject({
        method: 'POST',
        url: `/ur/account/orders/${ACCOUNT.orders[0]!.id}/reorder`,
        headers: {
          host: 'bazaar.localhost',
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `hatti_account=${ACCOUNT_TOKEN}`,
        },
        remoteAddress: '203.0.113.73',
      });
      answers.push(answer.statusCode);
      if (answer.statusCode === 429) {
        // The cart page, saying so in the page's language.
        expect(answer.body).toContain(
          '<p class="cart__error" role="alert" dir="auto">بہت زیادہ کوششیں۔ براہ کرم ایک منٹ انتظار کر کے دوبارہ کوشش کریں۔</p>',
        );
        expect(answer.headers['cache-control']).toBe('private, no-store');
      }
    }
    expect(answers).toEqual([...Array<number>(10).fill(303), 429]);
    expect(core.actions).toHaveLength(10);
    await app.close();
  });

  it("limits how often an address can ask of shoppers' wishlists (ADR-575)", async () => {
    const core = new FakeCore();
    core.accounts.set(ACCOUNT_TOKEN, ACCOUNT);
    const app = server(core);
    const answers = [];
    for (let attempt = 0; attempt < 61; attempt += 1) {
      const answer = await app.inject({
        method: attempt % 2 === 0 ? 'GET' : 'POST',
        url: attempt % 2 === 0 ? '/account/wishlist.json' : '/ur/account/wishlist',
        headers: {
          host: 'bazaar.localhost',
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
          cookie: `hatti_account=${ACCOUNT_TOKEN}`,
        },
        ...(attempt % 2 === 1 && { payload: JSON.stringify({ handles: ['eid-lawn'] }) }),
        remoteAddress: '203.0.113.74',
      });
      answers.push(answer.statusCode);
      if (answer.statusCode === 429) {
        expect(answer.json()).toEqual({
          message: 'Too many changes to your wishlist. Please wait a moment.',
        });
        expect(answer.headers['cache-control']).toBe('private, no-store');
      }
    }
    expect(answers).toEqual([...Array<number>(60).fill(200), 429]);
    expect(core.wishlistAsked).toHaveLength(60);
    await app.close();
  });

  it("limits how often an address can try a closed shop's password", async () => {
    const closed = randomUUID();
    const sample = sampleStore();
    const verifier = await passwordVerifier('eid-2026');
    await publish(closed, 'closed', {
      ...sample,
      shop: { ...sample.shop, password: { verifier, message: '' } },
    });
    const app = server();
    expect(
      (await app.inject({ method: 'GET', url: '/', headers: { host: 'closed.localhost' } })).headers
        .location,
    ).toBe('/password');
    const tries = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const answer = await app.inject({
        method: 'POST',
        url: '/password',
        headers: { host: 'closed.localhost', 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'form_type=storefront_password&password=guess',
      });
      tries.push(answer.statusCode);
    }
    expect(tries).toEqual([...Array<number>(10).fill(401), 429]);
    await app.close();
  });

  it('shows a share of shoppers the draft of a theme experiment, each keeping their arm, counted apart (ADR-866)', async () => {
    const shopId = randomUUID();
    const sample = sampleStore();
    const experiment = { id: 'texp_draft', themeId: 'thm-draft', version: 2, share: 50 };
    await publish(shopId, 'trial', { ...sample, shop: { ...sample.shop, experiment } });
    await queue.add(shopId, ['sample']);
    await queue.drain(shopId, async ({ writer }) => {
      await writer.putExperimentTheme({
        id: 'thm-draft',
        version: 2,
        base: 'hatti-base',
        files: {
          // The draft's announcement: the offer the experiment tries.
          'sections/header-group.json': JSON.stringify({
            type: 'header',
            name: 'Header group',
            sections: {
              announcement: {
                type: 'announcement-bar',
                settings: { text: 'Eid sale: 20% off everything' },
              },
              header: { type: 'header', settings: { menu: 'main-menu' } },
            },
            order: ['announcement', 'header'],
          }),
        },
      });
    });
    const core = new FakeCore();
    const app = server(core);
    const shopper = {
      host: 'trial.localhost',
      'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) Chrome/129.0.0.0 Mobile Safari/537.36',
    };
    const page = (headers: Record<string, string>) =>
      app.inject({ method: 'GET', url: '/', headers: { ...shopper, ...headers } });

    // In the draft's arm, the draft, the shopper's own.
    const draft = await page({
      cookie: 'hatti_ab=texp_draft.b; hatti_session=AbCdEfGhIjKlMnOpQrStUv',
    });
    expect(draft.body).toContain('Eid sale: 20% off everything');
    expect(draft.headers['cache-control']).toBe('private, no-store');
    expect(draft.headers['set-cookie']).toBeUndefined();
    // In the live theme's, the live theme, kept at the edge as ever.
    const live = await page({ cookie: 'hatti_ab=texp_draft.a' });
    expect(live.body).not.toContain('Eid sale: 20% off everything');
    expect(String(live.headers['cache-control'])).toMatch(/^public/);
    // A new shopper is put in an arm, and keeps it.
    const first = await page({});
    expect(String(first.headers['set-cookie'])).toMatch(
      /^hatti_ab=texp_draft\.[ab]; Max-Age=2678400; Path=\/; SameSite=Lax$/,
    );
    expect(first.headers['cache-control']).toBe('private, no-store');
    // A robot sees the live theme, and is put in no arm.
    const robot = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: 'trial.localhost', 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
    });
    expect(robot.body).not.toContain('Eid sale: 20% off everything');
    expect(robot.headers['set-cookie']).toBeUndefined();

    // The draft's session is counted in its arm.
    const seen = await app.inject({
      method: 'POST',
      url: '/.hatti/visit',
      headers: {
        ...shopper,
        cookie: 'hatti_ab=texp_draft.b; hatti_session=AbCdEfGhIjKlMnOpQrStUv',
      },
    });
    expect(seen.statusCode).toBe(204);
    // Its order, with what it came to, is counted in its arm once, however often told (ADR-921).
    core.page = { placed: true, sale: { orderId: 'order-1', amount: '500000' } };
    for (let time = 0; time < 2; time += 1) {
      const placed = await app.inject({
        method: 'POST',
        url: '/checkouts/c-secret',
        // From an address of its own: its checkouts count against no other test's limit.
        remoteAddress: '203.0.113.187',
        headers: {
          ...shopper,
          cookie: 'hatti_ab=texp_draft.b; hatti_session=AbCdEfGhIjKlMnOpQrStUv',
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: 'name=Ayesha',
      });
      expect(placed.statusCode).toBe(303);
    }
    const counts = await new StorefrontActivity(redis, keys).experimentCounts(shopId, 'texp_draft');
    expect([counts.a.sessions, counts.b.sessions, counts.b.converted]).toEqual([0, 1, 1]);
    expect([counts.a.revenue, counts.b.revenue, counts.b.revenue_squares]).toEqual([
      0,
      500_000,
      500_000 ** 2,
    ]);
    await app.close();
  });

  it("shows a shopper in a later draft's arm that draft, and counts it in its own arm (ADR-931)", async () => {
    const shopId = randomUUID();
    const sample = sampleStore();
    const experiment = {
      id: 'texp_three',
      themeId: 'thm-b',
      version: 1,
      share: 25,
      others: [
        { themeId: 'thm-c', version: 1 },
        { themeId: 'thm-d', version: 1 },
      ],
    };
    await publish(shopId, 'three', { ...sample, shop: { ...sample.shop, experiment } });
    const announcing = (id: string, text: string) => ({
      id,
      version: 1,
      base: 'hatti-base',
      files: {
        'sections/header-group.json': JSON.stringify({
          type: 'header',
          name: 'Header group',
          sections: {
            announcement: { type: 'announcement-bar', settings: { text } },
            header: { type: 'header', settings: { menu: 'main-menu' } },
          },
          order: ['announcement', 'header'],
        }),
      },
    });
    await queue.add(shopId, ['sample']);
    await queue.drain(shopId, async ({ writer }) => {
      await writer.putExperimentTheme(announcing('thm-b', 'Draft B speaking'));
      await writer.putExperimentTheme(announcing('thm-c', 'Draft C speaking'), 'c');
      await writer.putExperimentTheme(announcing('thm-d', 'Draft D speaking'), 'd');
    });
    const app = server(new FakeCore());
    const shopper = {
      host: 'three.localhost',
      'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) Chrome/129.0.0.0 Mobile Safari/537.36',
    };
    const page = (arm: string) =>
      app.inject({
        method: 'GET',
        url: '/',
        headers: {
          ...shopper,
          cookie: `hatti_ab=texp_three.${arm}; hatti_session=CcDdEeFfGgHhIiJjKkLlMm`,
        },
      });
    for (const [arm, words] of [
      ['b', 'Draft B speaking'],
      ['c', 'Draft C speaking'],
      ['d', 'Draft D speaking'],
    ] as const) {
      const shown = await page(arm);
      expect(shown.body).toContain(words);
      expect(shown.headers['cache-control']).toBe('private, no-store');
    }
    expect((await page('a')).body).not.toContain('speaking');
    const seen = await app.inject({
      method: 'POST',
      url: '/.hatti/visit',
      headers: {
        ...shopper,
        cookie: 'hatti_ab=texp_three.d; hatti_session=CcDdEeFfGgHhIiJjKkLlMm',
      },
    });
    expect(seen.statusCode).toBe(204);
    const counts = await new StorefrontActivity(redis, keys).experimentCounts(
      shopId,
      'texp_three',
      3,
    );
    expect([counts.a.sessions, counts.b.sessions, counts.c?.sessions, counts.d?.sessions]).toEqual([
      0, 0, 0, 1,
    ]);
    await app.close();
  });

  it('keeps the currency a shopper picks, their pages theirs alone, and suggests one abroad (ADR-865)', async () => {
    const shopId = randomUUID();
    const sample = sampleStore();
    await publish(shopId, 'gulf', {
      ...sample,
      shop: {
        ...sample.shop,
        currencies: [{ currency: 'AED', rate: '76.4521', rounding: 'exact' }],
      },
    });
    const app = server();
    const host = 'gulf.localhost';
    const picked = await app.inject({
      method: 'POST',
      url: '/localization',
      headers: { host, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'form_type=localization&currency_code=AED&return_to=%2Fcollections%2Fall',
    });
    expect([picked.statusCode, picked.headers.location]).toEqual([303, '/collections/all']);
    expect(picked.headers['set-cookie']).toBe(
      'currency=AED; Max-Age=31536000; Path=/; SameSite=Lax',
    );
    // Shopify's country pickers post the country; one the shop has no currency of changes nothing.
    const country = await app.inject({
      method: 'POST',
      url: '/localization',
      headers: { host, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'country_code=GB&return_to=%2F%2Fevil.example',
    });
    expect([country.headers.location, country.headers['set-cookie']]).toEqual(['/', undefined]);
    const urdu = await app.inject({
      method: 'POST',
      url: '/localization',
      headers: { host, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'currency_code=PKR&language_code=ur&return_to=%2Fproducts%2Fkurta',
    });
    expect([urdu.headers.location, urdu.headers['set-cookie']]).toEqual([
      '/ur/products/kurta',
      'currency=; Max-Age=0; Path=/; SameSite=Lax',
    ]);

    // In dirhams, the page is the shopper's own; in rupees, kept at the edge as ever.
    const inDirhams = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host, cookie: 'currency=AED' },
    });
    expect(inDirhams.body).toContain('<option value="AED" selected>');
    expect(inDirhams.headers['cache-control']).toBe('private, no-store');
    expect(inDirhams.headers['cache-tag']).toBeUndefined();
    const inRupees = await app.inject({ method: 'GET', url: '/', headers: { host } });
    expect(String(inRupees.headers['cache-control'])).toMatch(/^public/);

    // From the Emirates, dirhams are suggested; from elsewhere, or having picked, nothing.
    const asked = async (headers: Record<string, string>) =>
      (
        await app.inject({
          method: 'GET',
          url: '/localization.json',
          headers: { host, ...headers },
        })
      ).json() as {
        currency: string;
        suggested: string | null;
      };
    expect(await asked({ 'cf-ipcountry': 'AE' })).toEqual({
      currency: 'PKR',
      suggested: 'AED',
      currencies: ['PKR', 'AED'],
    });
    expect((await asked({ 'cf-ipcountry': 'GB' })).suggested).toBeNull();
    expect((await asked({ 'cf-ipcountry': 'AE', cookie: 'currency=AED' })).suggested).toBeNull();
    await app.close();
  });

  it('takes sign-ups on a closed shop, as its password page may ask for them', async () => {
    const closed = randomUUID();
    const sample = sampleStore();
    const verifier = await passwordVerifier('eid-2026');
    await publish(closed, 'shut', {
      ...sample,
      shop: { ...sample.shop, password: { verifier, message: '' } },
    });
    const core = new FakeCore();
    const app = server(core);
    const signUp = await app.inject({
      method: 'POST',
      url: '/contact',
      headers: { host: 'shut.localhost', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'form_type=customer&contact%5Bphone%5D=0300-1234567&return_to=%2Fpassword',
    });
    expect([signUp.statusCode, signUp.headers.location]).toEqual([
      303,
      '/password?customer_posted=true',
    ]);
    expect(core.signUps.map((signedUp) => signedUp.shopId)).toEqual([closed]);

    // Hatti Base's password page asks to be told when the shop opens (ADR-446).
    const page = await app.inject({
      method: 'GET',
      url: '/password',
      headers: { host: 'shut.localhost' },
    });
    expect(page.body).toContain('<input type="hidden" name="contact[tags]" value="waitlist">');
    expect(page.body).toContain(
      '<label for="waitlist-phone">Tell me on WhatsApp when Zari Fashions opens, and send me its news and offers</label>',
    );
    const waitlisted = await app.inject({
      method: 'POST',
      url: '/contact',
      headers: { host: 'shut.localhost', 'content-type': 'application/x-www-form-urlencoded' },
      payload:
        'form_type=customer&contact%5Btags%5D=waitlist&contact%5Bphone%5D=0301-7654321&return_to=%2Fpassword%23waitlist',
    });
    expect(waitlisted.statusCode).toBe(303);
    expect(core.signUps.at(-1)).toMatchObject({ shopId: closed, request: { tags: 'waitlist' } });
    const back = await app.inject({
      method: 'GET',
      url: waitlisted.headers.location as string,
      headers: { host: 'shut.localhost' },
    });
    expect(back.body).toContain('Thank you! We&#39;ll message you on WhatsApp when we open.');
    await app.close();
  });

  it('answers 404 where no shop is, or where its documents are missing', async () => {
    const app = server();
    for (const host of ['nobody.localhost', 'zari.example.com', 'gone.localhost']) {
      const response = await app.inject({ method: 'GET', url: '/', headers: { host } });
      expect(response.statusCode, host).toBe(404);
      expect(response.headers['content-type'], host).toMatch(/^text\/plain/);
    }
    await app.close();
  });

  it("lets a drop's shoppers in a minute's worth at a time, keeping each one's place (ADR-822)", async () => {
    const droppy = randomUUID();
    const sample = sampleStore();
    const room = (startedAgoMs: number) => ({
      dropId: randomUUID().replace(/^.{8}/, 'd0d0d0d0'),
      name: 'Eid lawn',
      startsAt: new Date(Date.now() - startedAgoMs).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      admitPerMinute: 10,
    });
    const live = room(30_000);
    await publish(droppy, 'droppy', { ...sample, shop: { ...sample.shop, waitingRooms: [live] } });
    const app = server();
    const visit = (ip: string, cookie?: string) =>
      app.inject({
        method: 'GET',
        url: '/',
        headers: { host: 'droppy.localhost', ...(cookie && { cookie }) },
        remoteAddress: ip,
      });
    // The first minute's ten are let in, each given a place.
    for (let shopper = 1; shopper <= 10; shopper++) {
      const response = await visit(`198.51.100.${shopper}`);
      expect(response.statusCode, String(shopper)).toBe(200);
      expect(String(response.headers['set-cookie'])).toMatch(/hatti_line=/);
    }
    // The eleventh waits, told where they are, and the page asks again by itself.
    const waiting = await visit('198.51.100.11');
    expect(waiting.statusCode).toBe(503);
    expect(waiting.headers['cache-control']).toBe('private, no-store');
    expect(Number(waiting.headers.refresh)).toBeGreaterThanOrEqual(20);
    expect(waiting.body).toContain('re in line');
    expect(waiting.body).toContain('About 1 ahead of you: around 1 minute.');
    const cookie = /hatti_line=[^;]+/.exec(String(waiting.headers['set-cookie']))![0];
    // Back again, the same place, and no new one.
    const again = await visit('198.51.100.11', cookie);
    expect(again.statusCode).toBe(503);
    expect(again.headers['set-cookie']).toBeUndefined();
    expect(again.body).toContain('About 1 ahead of you');
    // Scripts are told in a line; robots.txt is answered as ever.
    const script = await app.inject({
      method: 'GET',
      url: '/cart.js',
      headers: { host: 'droppy.localhost', cookie },
      remoteAddress: '198.51.100.11',
    });
    expect(script.statusCode).toBe(503);
    expect(script.body).toBe(
      "You're in line for this drop: open the shop's page to keep your place.\n",
    );
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/robots.txt',
          headers: { host: 'droppy.localhost' },
          remoteAddress: '198.51.100.11',
        })
      ).statusCode,
    ).toBe(200);
    // One address takes ten places at most.
    for (let place = 0; place < 10; place++) await visit('198.51.100.12');
    const refused = await visit('198.51.100.12');
    expect(refused.statusCode).toBe(503);
    expect(refused.body).toContain('Too many places in line came from your internet connection.');
    // A minute on, the next minute's are let in, the eleventh among them.
    await publish(droppy, 'droppy', {
      ...sample,
      shop: { ...sample.shop, waitingRooms: [{ ...live, startsAt: room(61_000).startsAt }] },
    });
    expect((await visit('198.51.100.11', cookie)).statusCode).toBe(200);
    // Over, or not yet begun, no one waits.
    await publish(droppy, 'droppy', {
      ...sample,
      shop: {
        ...sample.shop,
        waitingRooms: [{ ...room(0), startsAt: new Date(Date.now() + 60_000).toISOString() }],
      },
    });
    expect((await visit('198.51.100.13')).statusCode).toBe(200);
    await app.close();
  });
});
