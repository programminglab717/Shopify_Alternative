import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CartJson } from '@hatti/storefront-api';
import {
  MemoryStore,
  type MenuLinkDoc,
  type ProductDoc,
  type ShopDoc,
  type StoreData,
} from '@hatti/storefront-data';
import { sampleStore } from './fixtures.js';
import { PageRenderer, type PageRequest, type RenderStat, type RendererOptions } from './render.js';
import { localizedPath } from './objects.js';
import { suggestParams } from './suggest.js';
import {
  loadTheme,
  overlayTheme,
  readThemeDir,
  ThemeError,
  type SectionList,
  type ThemeFiles,
} from '@hatti/themes';

const THEME_DIR = fileURLToPath(new URL('../../../themes/hatti-base', import.meta.url));

describe('Storefront rendering', () => {
  let files: ThemeFiles;
  const store = new MemoryStore(sampleStore());

  beforeAll(async () => {
    files = await readThemeDir(THEME_DIR);
  });

  /** Renders a page of Hatti Base, with `extra` files added or replaced. */
  const render = async (
    request: PageRequest,
    options: RendererOptions & { extra?: ThemeFiles; latencyMs?: number } = {},
  ) => {
    const errors: { render: RenderStat; message: string }[] = [];
    const renderer = new PageRenderer(loadTheme({ ...files, ...options.extra }), {
      ...options,
      // Time enough for a render that parses the theme on a busy runner, unless a test sets less.
      limits: { timeMs: 10_000, ...options.limits },
      onError: (render, error) => errors.push({ render, message: (error as Error).message }),
    });
    const data = store.fresh(options.latencyMs ?? 0);
    const page = await renderer.render(request, data);
    return { ...page, roundTrips: data.roundTrips, errors };
  };

  const count = (html: string, text: string) => html.split(text).length - 1;

  it('renders the home page from its JSON template, each section in its place', async () => {
    const page = await render({ path: '/' });
    expect(page.status).toBe(200);
    expect(page.errors).toEqual([]);
    expect(page.html).toMatch(/^<!doctype html>\s*<html lang="en" dir="ltr">/);
    expect(page.html).toContain('<title>Zari Fashions</title>');
    const order = [...page.html.matchAll(/id="hatti-section-([\w-]+)"/g)].map((match) => match[1]);
    expect(order).toEqual([
      'header-group__announcement',
      'header-group__header',
      'banner',
      'lawn',
      'khussa',
      'kurta',
      'newsletter',
      'whatsapp',
      'footer-group__footer',
      'cart-drawer',
    ]);
    // Blocks in their order, images sized so nothing shifts, and a srcset for small phones.
    expect(page.html).toMatch(/<h1 class="banner__heading" dir="auto" ?>Eid Lawn &#39;26<\/h1>/);
    expect(page.html).toContain(
      'src="/images/banners/eid-lawn.jpg?width=1500" srcset="/images/banners/eid-lawn.jpg?width=375 375w,',
    );
    expect(page.html).toContain('width="1500" height="900"');
    // 8 + 4 + 4 products; the first two of each list load at once.
    expect(count(page.html, 'class="card"')).toBe(16);
    expect(count(page.html, 'loading="eager"')).toBe(6);
    expect(page.html).toMatch(/From Rs [\d,]+/);
    expect(page.html).toContain('<a href="/collections/khussa" dir="auto">Khussas</a>');
    expect(page.html).toContain('https://wa.me/923001234567?text=Hi!%20I%20have%20a%20question.');
    // Sections' own CSS, once each, in the head; the layout's settings as CSS variables.
    expect(count(page.html, '.card__media')).toBe(0);
    expect(count(page.html, '.header__inner {')).toBe(1);
    expect(page.html).toContain('--color-accent: #0F766E;');
  });

  it("tells search engines and link previews where each page is, at the shop's address", async () => {
    const platformUrl = 'https://hatti.pk';
    const page = await render({ path: '/products/bridal-lehenga-heavy' }, { platformUrl });
    const html = page.html;
    const url = 'https://zari.hatti.pk/products/bridal-lehenga-heavy';
    expect(html).toContain(`<link rel="canonical" href="${url}">`);
    expect(html).toContain(`<meta property="og:url" content="${url}">`);
    expect(html).toContain('<meta property="og:type" content="product">');
    // The description as a sentence, its paragraphs and list items apart.
    expect(html).toContain(
      '<meta name="description" content="Bridal Lehenga, Hand-embellished: soft, breathable ' +
        'and made to last. Stitched by hand in Pakistan. Fabric: premium cotton lawn Care: ',
    );
    expect(html).toMatch(
      /<meta property="og:image" content="https:\/\/zari\.hatti\.pk\/images\/[^"]+\?width=1200">/,
    );
    // Its address in each language, and English for any other.
    expect(html).toContain(`<link rel="alternate" hreflang="en" href="${url}">`);
    expect(html).toContain(
      '<link rel="alternate" hreflang="ur" href="https://zari.hatti.pk/ur/products/bridal-lehenga-heavy">',
    );
    expect(html).toContain(`<link rel="alternate" hreflang="x-default" href="${url}">`);

    // The product as schema.org has it: an offer a variant, in rupees, at the shop's address.
    const jsonLd = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!;
    const product = JSON.parse(jsonLd) as Record<string, unknown> & {
      image: string[];
      offers: Record<string, unknown>[];
    };
    const lehenga = sampleStore().products.find((p) => p.handle === 'bridal-lehenga-heavy')!;
    expect(product).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: lehenga.title,
      url,
    });
    expect(product.image).toEqual(
      lehenga.images.map((image) => `https://zari.hatti.pk${image.src}?width=1200`),
    );
    expect(product.offers).toHaveLength(lehenga.variants.length);
    expect(product.offers[0]).toEqual({
      '@type': 'Offer',
      url: `${url}?variant=${lehenga.variants[0]!.id}`,
      ...(lehenga.variants[0]!.sku ? { sku: lehenga.variants[0]!.sku } : {}),
      name: lehenga.variants[0]!.title,
      price: (lehenga.variants[0]!.price / 100).toFixed(2),
      priceCurrency: 'PKR',
      availability: lehenga.variants[0]!.available
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
    });

    // In Urdu, a page of a listing: its own address; a page not found has no others.
    const urdu = (
      await render(
        { path: '/collections/eid-lawn', query: { page: '2' }, locale: 'ur' },
        { platformUrl },
      )
    ).html;
    expect(urdu).toContain(
      '<link rel="canonical" href="https://zari.hatti.pk/ur/collections/eid-lawn?page=2">',
    );
    expect(urdu).toContain(
      '<link rel="alternate" hreflang="en" href="https://zari.hatti.pk/collections/eid-lawn?page=2">',
    );
    const home = (await render({ path: '/', locale: 'ur' }, { platformUrl })).html;
    expect(home).toContain('<link rel="canonical" href="https://zari.hatti.pk/ur">');
    const missing = (await render({ path: '/products/none' }, { platformUrl })).html;
    expect(missing).not.toContain('<link rel="alternate"');

    // Images by URL, as from a Shopify export, at their own addresses, their queries kept.
    const sample = sampleStore();
    const byUrl = 'https://cdn.shopify.com/s/files/1/lehenga.jpg?v=1700000000';
    const imported = new MemoryStore({
      ...sample,
      products: sample.products.map((each) =>
        each.handle === lehenga.handle
          ? { ...each, images: each.images.map((image) => ({ ...image, src: byUrl })) }
          : each,
      ),
    });
    const shown = (
      await new PageRenderer(loadTheme(files), { platformUrl, limits: { timeMs: 10_000 } }).render(
        { path: `/products/${lehenga.handle}` },
        imported,
      )
    ).html;
    expect(shown).toContain(`<meta property="og:image" content="${byUrl}&amp;width=1200">`);
    const data = JSON.parse(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(shown)![1]!,
    ) as { image: string[] };
    expect(data.image[0]).toBe(`${byUrl}&width=1200`);
  });

  it('gives search engines the title and description a shop wrote for a page, else its own (ADR-231)', async () => {
    const sample = sampleStore();
    const products = sample.products.map((product) =>
      product.handle === 'bridal-lehenga-heavy'
        ? {
            ...product,
            seo: {
              title: 'Bridal lehengas & more',
              description: 'Hand-embellished bridal lehengas, stitched in Lahore.',
            },
          }
        : product,
    );
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const store = new MemoryStore({ ...sample, products });
    const html = (await renderer.render({ path: '/products/bridal-lehenga-heavy' }, store)).html;
    expect(html).toContain('<title>Bridal lehengas &amp; more · Zari Fashions</title>');
    expect(html).toContain('<meta property="og:title" content="Bridal lehengas &amp; more">');
    expect(html).toContain(
      '<meta name="description" content="Hand-embellished bridal lehengas, stitched in Lahore.">',
    );
    // A page without: its own title, and the start of its body as text, cut at a word.
    const returns = (await renderer.render({ path: '/pages/returns' }, store)).html;
    expect(returns).toContain('<title>Returns and exchanges · Zari Fashions</title>');
    expect(returns).toContain(
      '<meta name="description" content="Changed your mind? Send it back within 7 days of ' +
        'delivery, unworn and with its tags, and we exchange it or refund you. Stitched suits ' +
        'are exchanged for size…">',
    );
  });

  it("gives search engines and link previews the home page's title and description the shop wrote, and its sharing image (ADR-243)", async () => {
    const platformUrl = 'https://hatti.pk';
    const sample = sampleStore();
    const description = 'Lawn, bridal and khussas, delivered across Pakistan.';
    const sharing = 'http://localhost:4000/sharing-images/s1?v=abc12345';
    const store = new MemoryStore({
      ...sample,
      shop: {
        ...sample.shop,
        seo: { title: 'Zari Fashions: lawn and bridal in Lahore', description },
        sharingImage: { src: sharing, width: 0, height: 0, alt: 'Three lawn suits' },
      },
    });
    const renderer = new PageRenderer(loadTheme(files), {
      platformUrl,
      limits: { timeMs: 10_000 },
    });
    const page = async (path: string) => (await renderer.render({ path }, store.fresh())).html;

    // Its own title, the shop's name already in it; its description; its sharing image.
    const home = await page('/');
    expect(home).toContain('<title>Zari Fashions: lawn and bridal in Lahore</title>');
    expect(home).toContain(`<meta name="description" content="${description}">`);
    expect(home).toContain(`<meta property="og:image" content="${sharing}&amp;width=1200">`);
    expect(home).toContain('<meta property="og:image:alt" content="Three lawn suits">');
    // The shop's website, as schema.org has it, with the description.
    const graph = JSON.parse(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(home)![1]!,
    ) as { '@graph': Record<string, unknown>[] };
    expect(graph['@graph'][1]).toEqual({
      '@type': 'WebSite',
      name: 'Zari Fashions',
      url: 'https://zari.hatti.pk/',
      description,
    });

    // Elsewhere, a page's own title; the shop's description and image where it has none.
    const cart = await page('/cart');
    expect(cart).toContain(`<meta name="description" content="${description}">`);
    expect(cart).toContain(`<meta property="og:image" content="${sharing}&amp;width=1200">`);
    const returns = await page('/pages/returns');
    expect(returns).toContain('<title>Returns and exchanges · Zari Fashions</title>');
    expect(returns).not.toContain(`content="${description}"`);
    expect(await page('/products/bridal-lehenga-heavy')).toMatch(
      /<meta property="og:image" content="https:\/\/zari\.hatti\.pk\/images\/[^"]+\?width=1200">/,
    );

    // A shop that set none of it: its name, and no image.
    const plain = (await render({ path: '/' }, { platformUrl })).html;
    expect(plain).toContain('<title>Zari Fashions</title>');
    expect(plain).toContain('<meta name="description" content="Zari Fashions">');
    expect(plain).not.toContain('og:image');
  });

  it("gives the Urdu pages the shop's home page words in Urdu, its own where it gave none (ADR-245)", async () => {
    const sample = sampleStore();
    const description = 'Lawn, bridal and khussas, delivered across Pakistan.';
    const urduDescription = 'لان، عروسی جوڑے اور کھسے، پورے پاکستان میں۔';
    const store = new MemoryStore({
      ...sample,
      shop: {
        ...sample.shop,
        seo: { title: 'Zari Fashions: lawn and bridal in Lahore', description },
        translations: {
          ur: { seo: { title: 'زری فیشنز: لاہور کی لان', description: urduDescription } },
        },
      },
    });
    const renderer = new PageRenderer(loadTheme(files), {
      platformUrl: 'https://hatti.pk',
      limits: { timeMs: 10_000 },
    });
    const page = async (path: string, locale?: string) =>
      (await renderer.render({ path, ...(locale && { locale }) }, store.fresh())).html;

    // Its Urdu home page's title and description, and its website's in structured data.
    const home = await page('/', 'ur');
    expect(home).toContain('<title>زری فیشنز: لاہور کی لان · Zari Fashions</title>');
    expect(home).toContain(`<meta name="description" content="${urduDescription}">`);
    const graph = JSON.parse(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(home)![1]!,
    ) as { '@graph': Record<string, unknown>[] };
    expect(graph['@graph'][1]!.description).toBe(urduDescription);
    // Its other Urdu pages describe it so too.
    expect(await page('/cart', 'ur')).toContain(
      `<meta name="description" content="${urduDescription}">`,
    );
    // Its English pages, its own words alone.
    const english = await page('/');
    expect(english).toContain('<title>Zari Fashions: lawn and bridal in Lahore</title>');
    expect(english).toContain(`<meta name="description" content="${description}">`);
    expect(english).not.toContain('زری فیشنز');
  });

  it('gives search engines the title and description a shop wrote for a blog, and in Urdu (ADR-244)', async () => {
    const sample = sampleStore();
    const description = 'Eid edits, lawn launches and how to wear them.';
    const store = new MemoryStore({
      ...sample,
      shop: { ...sample.shop, seo: { title: null, description: 'Lawn, bridal and khussas.' } },
      blogs: sample.blogs!.map((blog) => ({
        ...blog,
        seo: { title: 'The Zari journal', description },
        translations: { ur: { seo: { title: 'زری کا روزنامچہ' } } },
      })),
    });
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const page = async (path: string, locale?: string) =>
      (await renderer.render({ path, ...(locale && { locale }) }, store.fresh())).html;

    // Its own, in place of its title and of the shop's description; on its tag's pages too.
    for (const path of ['/blogs/news', '/blogs/news/tagged/eid']) {
      const shown = await page(path);
      expect(shown, path).toContain('<title>The Zari journal · Zari Fashions</title>');
      expect(shown, path).toContain(`<meta name="description" content="${description}">`);
    }
    // In Urdu, the title it gave in Urdu; the description it gave none in Urdu, as it is.
    const urdu = await page('/blogs/news', 'ur');
    expect(urdu).toContain('<title>زری کا روزنامچہ · Zari Fashions</title>');
    expect(urdu).toContain(`<meta name="description" content="${description}">`);
    // Its articles are their own.
    const article = await page('/blogs/news/eid-lawn-is-here');
    expect(article).not.toContain('The Zari journal');
    expect(article).not.toContain(description);

    // A blog without: its own title, and the shop's description.
    const plain = (await render({ path: '/blogs/news' })).html;
    expect(plain).toContain('<title>News · Zari Fashions</title>');
    expect(plain).toContain('<meta name="description" content="Zari Fashions">');
  });

  it("gives search engines an article as schema.org's BlogPosting, and the shop on its home page (ADR-237)", async () => {
    const platformUrl = 'https://hatti.pk';
    const logo = 'https://api.hatti.pk/logos/s1?v=0a1b2c3d';
    const square = 'https://api.hatti.pk/logos/s1/square?v=4e5f6a7b';
    const image = {
      src: 'https://api.hatti.test/article-images/shop-1/art-eid?v=0a1b2c3d',
      width: 0,
      height: 0,
      alt: 'Lawn, folded',
    };
    const sample = sampleStore();
    const articles = sample.articles!.map((article) =>
      article.id === 'art-eid'
        ? { ...article, image, updatedAt: '2026-09-22T08:15:00.000Z' }
        : article,
    );
    const renderer = new PageRenderer(loadTheme(files), {
      platformUrl,
      limits: { timeMs: 10_000 },
    });
    const branded: ShopDoc = { ...sample.shop, brand: { logo, squareLogo: null } };
    const dataOf = async (request: PageRequest, shopDoc = branded) => {
      const shop = new MemoryStore({ ...sample, shop: shopDoc, articles });
      const { html } = await renderer.render(request, shop.fresh());
      // Where each page sits is its own test's (ADR-608).
      return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
        .map(([, json]) => JSON.parse(json!) as Record<string, unknown>)
        .filter((data) => data['@type'] !== 'BreadcrumbList');
    };
    const organization = {
      '@type': 'Organization',
      name: 'Zari Fashions',
      url: 'https://zari.hatti.pk/',
      logo: `${logo}&width=600`,
    };

    // Its headline, address, dates and image at the shop's address, and who wrote it.
    expect(await dataOf({ path: '/blogs/news/eid-lawn-is-here' })).toEqual([
      {
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: 'Eid lawn is here',
        url: 'https://zari.hatti.pk/blogs/news/eid-lawn-is-here',
        datePublished: '2026-09-20T21:30:00.000Z',
        dateModified: '2026-09-22T08:15:00.000Z',
        image: [`${image.src}&width=1200`],
        author: { '@type': 'Person', name: 'Ayesha Khan' },
        publisher: organization,
      },
    ]);
    // One with no author is the shop's; one never changed, changed when it was published.
    expect(await dataOf({ path: '/blogs/news/how-to-measure' })).toEqual([
      {
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: 'How to measure for a kurta',
        url: 'https://zari.hatti.pk/blogs/news/how-to-measure',
        datePublished: '2026-09-10T09:00:00.000Z',
        dateModified: '2026-09-10T09:00:00.000Z',
        author: organization,
        publisher: organization,
      },
    ]);

    // The home page has the shop and the site's name, in each language.
    const home = {
      '@context': 'https://schema.org',
      '@graph': [
        organization,
        { '@type': 'WebSite', name: 'Zari Fashions', url: 'https://zari.hatti.pk/' },
      ],
    };
    expect(await dataOf({ path: '/' })).toEqual([home]);
    expect(await dataOf({ path: '/', locale: 'ur' })).toEqual([home]);
    // Its square logo when that is all it has, and none without.
    const { logo: _, ...plain } = organization;
    const squared = { ...sample.shop, brand: { logo: null, squareLogo: square } };
    expect(await dataOf({ path: '/' }, squared)).toEqual([
      { ...home, '@graph': [{ ...plain, logo: `${square}&width=600` }, home['@graph'][1]] },
    ]);
    expect(await dataOf({ path: '/' }, sample.shop)).toEqual([
      { ...home, '@graph': [plain, home['@graph'][1]] },
    ]);
    // Other pages don't.
    for (const path of ['/blogs/news', '/collections/eid-lawn', '/pages/returns', '/search']) {
      expect(await dataOf({ path }), path).toEqual([]);
    }
  });

  it('tells search engines where each page sits in the shop, as a BreadcrumbList (ADR-608)', async () => {
    const renderer = new PageRenderer(loadTheme(files), {
      platformUrl: 'https://hatti.pk',
      limits: { timeMs: 10_000 },
    });
    const crumbsOf = async (request: PageRequest) => {
      const { html } = await renderer.render(request, new MemoryStore(sampleStore()).fresh());
      return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
        .map(([, json]) => JSON.parse(json!) as Record<string, unknown>)
        .filter((data) => data['@type'] === 'BreadcrumbList')
        .map((data) =>
          (data.itemListElement as { position: number; name: string; item: string }[]).map(
            (crumb) => [crumb.position, crumb.name, crumb.item],
          ),
        );
    };
    const home = [1, 'Zari Fashions', 'https://zari.hatti.pk/'];

    expect(await crumbsOf({ path: '/blogs/news/eid-lawn-is-here' })).toEqual([
      [
        home,
        [2, 'News', 'https://zari.hatti.pk/blogs/news'],
        [3, 'Eid lawn is here', 'https://zari.hatti.pk/blogs/news/eid-lawn-is-here'],
      ],
    ]);
    expect(await crumbsOf({ path: '/collections/eid-lawn' })).toEqual([
      [home, [2, 'Eid Lawn', 'https://zari.hatti.pk/collections/eid-lawn']],
    ]);
    const product = await crumbsOf({ path: '/products/bridal-lehenga-heavy' });
    expect(product[0]?.[1]?.[2]).toBe('https://zari.hatti.pk/products/bridal-lehenga-heavy');
    expect(await crumbsOf({ path: '/blogs/news' })).toEqual([
      [home, [2, 'News', 'https://zari.hatti.pk/blogs/news']],
    ]);
    // In Urdu, at its Urdu addresses.
    const urdu = await crumbsOf({ path: '/pages/returns', locale: 'ur' });
    expect(urdu[0]?.[0]).toEqual([1, 'Zari Fashions', 'https://zari.hatti.pk/ur']);
    expect(urdu[0]?.[1]?.[2]).toBe('https://zari.hatti.pk/ur/pages/returns');
    // Not on the home page, the cart or a search.
    for (const path of ['/', '/cart', '/search']) {
      expect(await crumbsOf({ path }), path).toEqual([]);
    }
  });

  it('says orders are paused in its own place and words, while they are (ADR-620)', async () => {
    const sample = sampleStore();
    const noticeOf = async (maintenance: ShopDoc['maintenance'], locale?: string) => {
      const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
      const store = new MemoryStore({
        ...sample,
        shop: { ...sample.shop, timezone: 'Asia/Karachi', maintenance },
      });
      const { html } = await renderer.render({ path: '/', locale }, store.fresh());
      const notice = /<div class="checkout-paused"[^>]*>([\s\S]*?)<\/div>/.exec(html);
      return notice && notice[1]!.replace(/\s+/g, ' ').trim();
    };
    const pause = {
      message: 'Eid break <3>',
      until: '2099-10-12T04:00:00.000Z',
      checkoutOnly: true as const,
    };
    expect(await noticeOf(pause)).toBe(
      '<strong>Orders are paused for a while.</strong> <span dir="auto">Eid break &lt;3&gt;</span> ' +
        '<span>We take orders again from 12 October 2099 at 9:00 AM.</span>',
    );
    expect(await noticeOf({ ...pause, message: '', until: null }, 'ur')).toBe(
      '<strong>آرڈر کچھ دیر کے لیے بند ہیں۔</strong> <span>ہم جلد دوبارہ آرڈر لیں گے۔</span>',
    );
    // Not once the time has come, nor while the shop takes orders.
    expect(await noticeOf({ ...pause, until: '2020-01-01T00:00:00.000Z' })).toBeNull();
    expect(await noticeOf(undefined)).toBeNull();
  });

  it('keeps the cart and turns checkout off while orders are paused (ADR-622)', async () => {
    const sample = sampleStore();
    const lawn = sample.products[0]!;
    const variant = lawn.variants.find((each) => each.available)!;
    const cart: CartJson = {
      note: '',
      attributes: {},
      items: [
        {
          key: `${variant.id}:0123456789abcdef0123456789abcdef`,
          variantId: variant.id,
          productId: lawn.id,
          quantity: 1,
          properties: {},
          price: variant.price,
          linePrice: variant.price,
          title: lawn.title,
          variantTitle: variant.title,
          sku: null,
          grams: 0,
          taxable: true,
          taxCode: null,
          maxQuantity: null,
        },
      ],
      itemCount: 1,
      subtotal: variant.price,
      totalWeightGrams: 0,
      discount: null,
      totalDiscount: 0,
    };
    const pageOf = async (request: PageRequest, maintenance: ShopDoc['maintenance']) => {
      const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
      const store = new MemoryStore({ ...sample, shop: { ...sample.shop, maintenance } });
      return (await renderer.render(request, store.fresh())).html;
    };
    const pause = { message: '', until: null, checkoutOnly: true as const };
    const paused = await pageOf({ path: '/cart', cart }, pause);
    expect(paused).toContain(
      '<p class="cart__paused" role="status" data-checkout-paused>' +
        'Orders are paused for a while: your cart is kept for when we take them again.</p>',
    );
    expect(paused).toContain(
      '<button type="submit" name="checkout" class="button" disabled data-checkout-paused-disabled>Check out</button>',
    );
    // The product goes in the cart all the same, for when orders come back.
    const product = await pageOf({ path: `/products/${lawn.handle}`, locale: 'ur' }, pause);
    expect(product).toContain(
      '<p class="product__paused" data-checkout-paused>' +
        'آرڈر کچھ دیر کے لیے بند ہیں: اسے کارٹ میں ڈال لیں، اور جب ہم دوبارہ آرڈر لیں تب منگوائیں۔</p>',
    );
    // Taking orders: neither.
    const open = await pageOf({ path: '/cart', cart }, undefined);
    expect(open).toContain(
      '<button type="submit" name="checkout" class="button">Check out</button>',
    );
    expect(open).not.toContain('cart__paused');
    expect(await pageOf({ path: `/products/${lawn.handle}` }, undefined)).not.toContain(
      'product__paused',
    );
  });

  it("opens a menu's links under its links, across the page and in a drawer on phones (ADR-641)", async () => {
    const sample = sampleStore();
    const nested = (title: string, url: string, links: MenuLinkDoc[] = []): MenuLinkDoc => ({
      title,
      url,
      type: 'http_link',
      links,
    });
    const data = new MemoryStore({
      ...sample,
      menus: sample.menus.map((menu) =>
        menu.handle === 'main-menu'
          ? {
              ...menu,
              links: [
                nested('Women', '/collections/women', [
                  nested('Lawn', '/collections/eid-lawn', [
                    nested('Unstitched', '/collections/unstitched'),
                  ]),
                  nested('Khussas', '/collections/khussa'),
                ]),
                nested('All', '/collections/all'),
              ],
            }
          : menu,
      ),
    });
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const { html } = await renderer.render({ path: '/' }, data.fresh());
    const header = /<header class="header"[\s\S]*?<\/header>/.exec(html)![0];
    // Once in the drawer and once across the page, each the same three levels.
    expect(count(header, '<details class="header__submenu">')).toBe(2);
    expect(header).toContain('<summary>Menu</summary>');
    const nav = /<nav class="header__nav"[\s\S]*?<\/nav>/.exec(header)![0];
    const links = [...nav.matchAll(/<a href="([^"]*)" dir="auto">([^<]*)<\/a>/g)].map(
      ([, href, text]) => [text, href],
    );
    expect(links).toEqual([
      // A link with links under it is among them, first, so it still leads somewhere.
      ['Women', '/collections/women'],
      ['Lawn', '/collections/eid-lawn'],
      ['Unstitched', '/collections/unstitched'],
      ['Khussas', '/collections/khussa'],
      ['All', '/collections/all'],
    ]);
    expect(nav).toContain('<summary dir="auto">Women</summary>');
    // In Urdu, its drawer says so in Urdu.
    const urdu = (await renderer.render({ path: '/', locale: 'ur' }, data.fresh())).html;
    expect(urdu).toContain('<summary>مینو</summary>');
  });

  it('shows where each page sits above it, unless the theme turns it off (ADR-614)', async () => {
    const trailOf = async (request: PageRequest, theme = files) => {
      const renderer = new PageRenderer(loadTheme(theme), {
        platformUrl: 'https://hatti.pk',
        limits: { timeMs: 10_000 },
      });
      const { html } = await renderer.render(request, new MemoryStore(sampleStore()).fresh());
      const nav = /<nav class="breadcrumbs[^"]*" aria-label="([^"]*)">([\s\S]*?)<\/nav>/.exec(html);
      if (!nav) return null;
      return {
        label: nav[1],
        crumbs: [
          ...nav[2]!.matchAll(/<li>(?:<a href="([^"]*)">|<span aria-current="page">)([^<]*)/g),
        ].map(([, href, text]) => [text, href ?? null]),
      };
    };

    expect(await trailOf({ path: '/blogs/news/eid-lawn-is-here' })).toEqual({
      label: 'Breadcrumbs',
      crumbs: [
        ['Home', '/'],
        ['News', '/blogs/news'],
        ['Eid lawn is here', null],
      ],
    });
    expect((await trailOf({ path: '/collections/eid-lawn' }))?.crumbs).toEqual([
      ['Home', '/'],
      ['Eid Lawn', null],
    ]);
    // In Urdu, at the Urdu addresses, right to left.
    expect(await trailOf({ path: '/pages/returns', locale: 'ur' })).toMatchObject({
      label: 'آپ یہاں ہیں',
      crumbs: [
        ['ہوم', '/ur'],
        [expect.any(String), null],
      ],
    });
    // Not on the home page, the cart or a search.
    for (const path of ['/', '/cart', '/search']) {
      expect(await trailOf({ path }), path).toBeNull();
    }
    // A shop that turns it off sees none; search engines are still told (ADR-608).
    const data = JSON.parse(files['config/settings_data.json']!) as {
      current: Record<string, unknown>;
    };
    data.current.show_breadcrumbs = false;
    const off = { ...files, 'config/settings_data.json': JSON.stringify(data) };
    expect(await trailOf({ path: '/collections/eid-lawn' }, off)).toBeNull();
  });

  it("shows a collection's image on its page, and as its featured image, else its first product's (ADR-785)", async () => {
    const sample = sampleStore();
    const eid = sample.collections.find((each) => each.handle === 'eid-lawn')!;
    eid.image = {
      src: 'https://api.hatti.pk/collection-images/s/c?v=abcd1234',
      width: 0,
      height: 0,
      alt: 'Lawn suits on a line',
    };
    const pageOf = async (path: string, theme = files) => {
      const renderer = new PageRenderer(loadTheme(theme), { limits: { timeMs: 10_000 } });
      return (await renderer.render({ path }, new MemoryStore(sample).fresh())).html;
    };
    const html = await pageOf('/collections/eid-lawn');
    expect(html).toMatch(
      /<figure class="collection__image"><img src="https:\/\/api\.hatti\.pk\/collection-images\/s\/c\?v=abcd1234[^"]*width=1600"[^>]*alt="Lawn suits on a line"/,
    );
    // None shown for a collection without one.
    expect(await pageOf('/collections/all')).not.toContain('<figure class="collection__image"');

    // A theme's featured image: its own, else its first product's.
    const theme = {
      ...files,
      'sections/main-collection.liquid':
        '<p id="f">{{ collection.featured_image.src | default: "none" }}</p>' +
        '{% schema %}{"name": "Collection", "settings": [' +
        '{"type": "range", "id": "products_per_page", "min": 8, "max": 48, "step": 4, "default": 24},' +
        '{"type": "checkbox", "id": "show_image", "default": true}]}{% endschema %}',
    };
    const featured = async (handle: string) =>
      /<p id="f">([^<]*)<\/p>/.exec(await pageOf(`/collections/${handle}`, theme))?.[1];
    expect(await featured('eid-lawn')).toBe(eid.image.src);
    const first = sample.products.find(
      (product) =>
        product.id === sample.collections.find((each) => each.handle === 'all')!.productIds[0],
    )!;
    expect(await featured('all')).toBe(first.images[0]!.src);
  });

  it('plays a YouTube or Vimeo video the shop chose in a section of its own (OS-08, ADR-705)', async () => {
    const sample = sampleStore();
    const pages = sample.pages ?? [];
    const store = new MemoryStore({
      ...sample,
      pages: [
        ...pages,
        {
          ...pages[0]!,
          id: 'pg-story',
          handle: 'story',
          title: 'Our story',
          templateSuffix: 'story',
        },
      ],
    });
    const render = async (sections: Record<string, Record<string, unknown>>) => {
      const template = { sections, order: Object.keys(sections) };
      const theme = { ...files, 'templates/page.story.json': JSON.stringify(template) };
      const renderer = new PageRenderer(loadTheme(theme), { limits: { timeMs: 10_000 } });
      return renderer.render({ path: '/pages/story' }, store.fresh());
    };
    const page = await render({
      film: {
        type: 'video',
        settings: {
          heading: 'How our lawn is made',
          video: 'https://youtu.be/dQw4w9WgXcQ?si=share',
          text: 'From the loom\nto your door',
        },
      },
      vimeo: { type: 'video', settings: { video: 'https://vimeo.com/76979871' } },
      // An address that plays nothing shows nothing.
      clip: { type: 'video', settings: { heading: 'Gone', video: 'https://example.com/a.mp4' } },
    });
    expect(page.status).toBe(200);
    const frames = [...page.html.matchAll(/<iframe ([^>]*)><\/iframe>/g)].map(([, at]) => at);
    expect(frames).toEqual([
      'src="https://www.youtube.com/embed/dQw4w9WgXcQ?enablejsapi=1&amp;playsinline=1&amp;rel=0" ' +
        'title="How our lawn is made" loading="lazy" frameborder="0" ' +
        'allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" ' +
        'allowfullscreen="allowfullscreen"',
      expect.stringMatching(/^src="https:\/\/player\.vimeo\.com\/video\/76979871" title=""/),
    ]);
    expect(page.html).toContain('<h2 dir="auto">How our lawn is made</h2>');
    expect(page.html).toContain(
      '<p class="video-section__text" dir="auto">From the loom<br />\nto your door</p>',
    );
    expect(page.html).not.toContain('Gone');
  });

  it("answers shoppers' questions on a page, and tells search engines as an FAQPage (ADR-615)", async () => {
    const sample = sampleStore();
    const pages = sample.pages ?? [];
    const store = new MemoryStore({
      ...sample,
      pages: [
        ...pages,
        { ...pages[0]!, id: 'pg-faq', handle: 'faq', title: 'FAQs', templateSuffix: 'faq' },
      ],
    });
    const render = async (theme = files) => {
      const renderer = new PageRenderer(loadTheme(theme), {
        platformUrl: 'https://hatti.pk',
        limits: { timeMs: 10_000 },
      });
      const { html } = await renderer.render({ path: '/pages/faq' }, store.fresh());
      const faqs = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
        .map(([, json]) => JSON.parse(json!) as Record<string, unknown>)
        .filter((data) => data['@type'] === 'FAQPage');
      return { html, faqs };
    };

    const { html, faqs } = await render();
    expect([...html.matchAll(/<summary dir="auto">([^<]*)<\/summary>/g)].map(([, q]) => q)).toEqual(
      [
        'How long does delivery take?',
        'Can I pay cash on delivery?',
        'Can I return or exchange an item?',
      ],
    );
    expect(faqs).toHaveLength(1);
    expect(faqs[0]!.mainEntity).toEqual([
      {
        '@type': 'Question',
        name: 'How long does delivery take?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: '<p>Two to five working days across Pakistan.</p>',
        },
      },
      expect.objectContaining({ name: 'Can I pay cash on delivery?' }),
      expect.objectContaining({ name: 'Can I return or exchange an item?' }),
    ]);

    // A question without its answer is left out of both; search engines are told nothing where
    // the section says not to.
    const template = JSON.parse(files['templates/page.faq.json']!) as {
      sections: {
        faq: {
          settings?: Record<string, unknown>;
          blocks: Record<string, { settings: Record<string, string> }>;
        };
      };
    };
    template.sections.faq.blocks.payment!.settings.answer = '';
    template.sections.faq.settings = { structured_data: false };
    const edited = await render({ ...files, 'templates/page.faq.json': JSON.stringify(template) });
    expect(edited.html).not.toContain('Can I pay cash on delivery?');
    expect(edited.html).toContain('How long does delivery take?');
    expect(edited.faqs).toEqual([]);
    // Other pages have none.
    const { html: returns } = await new PageRenderer(loadTheme(files), {
      platformUrl: 'https://hatti.pk',
      limits: { timeMs: 10_000 },
    }).render({ path: '/pages/returns' }, store.fresh());
    expect(returns).not.toContain('FAQPage');
  });

  it("prints an FAQ's rich-text answers as they are, plain ones as their lines, and no others (ADR-707)", async () => {
    const sample = sampleStore();
    const store = new MemoryStore({
      ...sample,
      pages: [
        { ...sample.pages![0]!, id: 'pg-faq', handle: 'faq', title: 'FAQs', templateSuffix: 'faq' },
      ],
    });
    const template = JSON.parse(files['templates/page.faq.json']!) as {
      sections: { faq: { blocks: Record<string, { settings: Record<string, string> }> } };
    };
    const { blocks } = template.sections.faq;
    blocks.delivery!.settings.answer =
      '<p>Two to five days. <a href="/pages/delivery">Where we deliver</a></p><ul><li><strong>Lahore</strong>: next day</li></ul>';
    // An answer kept as plain text before answers were rich text.
    blocks.payment!.settings.answer = 'Yes.\nPay the rider & keep the slip.';
    blocks.returns!.settings.answer = '<p>Yes</p><script>alert(1)</script>';
    const renderer = new PageRenderer(
      loadTheme({ ...files, 'templates/page.faq.json': JSON.stringify(template) }),
      { platformUrl: 'https://hatti.pk', limits: { timeMs: 10_000 } },
    );
    const { html } = await renderer.render({ path: '/pages/faq' }, store.fresh());
    const answers = [
      ...html.matchAll(/<div class="faq__answer" dir="auto">([\s\S]*?)<\/div>/g),
    ].map(([, answer]) => answer!.trim());
    expect(answers).toEqual([
      '<p>Two to five days. <a href="/pages/delivery">Where we deliver</a></p><ul><li><strong>Lahore</strong>: next day</li></ul>',
      'Yes.<br />\nPay the rider &amp; keep the slip.',
    ]);
    // An answer that is not rich text is no answer: its question is left out.
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('Can I return or exchange an item?');
  });

  it("renders a page's sections again with the theme's settings the editor has not saved, its static ones too (ADR-708)", async () => {
    const store = new MemoryStore(sampleStore());
    const renderer = new PageRenderer(loadTheme(files), {
      platformUrl: 'https://hatti.pk',
      limits: { timeMs: 10_000 },
    });
    const editing = (current: Record<string, unknown>) => {
      const theme = loadTheme({
        ...files,
        'config/settings_data.json': JSON.stringify({ current }),
      });
      return () => theme;
    };
    // In design mode, as the editor asks for sections.
    const ask = { path: '/', editor: { origins: ['https://admin.hatti.pk'] } };
    const drawer = await renderer.sections(ask, store.fresh(), ['cart-drawer'], editing({}));
    expect(drawer.get('cart-drawer')).toContain('<cart-drawer');
    expect(drawer.get('cart-drawer')).toContain('data-hatti-editor-section=');
    // The cart a page, unsaved: the drawer gone from the page at once.
    const page = await renderer.sections(
      ask,
      store.fresh(),
      ['cart-drawer'],
      editing({ cart_type: 'page' }),
    );
    expect(page.get('cart-drawer')).not.toContain('<cart-drawer');
    expect(page.get('cart-drawer')).toMatch(/^<div id="hatti-section-cart-drawer"/);
  });

  it("shows the shop's own Urdu on its Urdu pages, and its own words where it gave none (ADR-238)", async () => {
    const sample = sampleStore();
    const urdu = <T extends { id: string }>(docs: T[], id: string, translations: unknown) =>
      docs.map((doc) => (doc.id === id ? { ...doc, translations } : doc));
    const store = new MemoryStore({
      ...sample,
      products: urdu(
        urdu(sample.products, 'p-heavy', {
          ur: {
            title: 'دلہن کا لہنگا',
            descriptionHtml: '<p>ہاتھ سے کڑھائی۔</p>',
            seo: { description: 'لاہور میں سلا ہوا' },
          },
        }),
        'p-eid-lawn-1',
        { ur: { title: 'لان کا سوٹ' } },
      ),
      collections: urdu(sample.collections, 'c-eid-lawn', { ur: { title: 'عید کی لان' } }),
      menus: sample.menus.map((menu) =>
        menu.handle === 'main-menu'
          ? {
              ...menu,
              translations: {
                ur: {
                  links: menu.links.map((link, index) =>
                    index === 0 ? { ...link, title: 'عید کی لان' } : link,
                  ),
                },
              },
            }
          : menu,
      ),
    });
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const page = async (path: string, locale?: string) =>
      (await renderer.render({ path, ...(locale && { locale }) }, store.fresh())).html;

    const lehenga = await page('/products/bridal-lehenga-heavy', 'ur');
    expect(lehenga).toContain('<title>دلہن کا لہنگا · Zari Fashions</title>');
    expect(lehenga).toContain('<p>ہاتھ سے کڑھائی۔</p>');
    // What it gave search engines in Urdu; its menu's link too, those it did not translate as
    // they are.
    expect(lehenga).toContain('<meta name="description" content="لاہور میں سلا ہوا">');
    expect(lehenga).toContain('عید کی لان</a>');
    expect(lehenga).toContain('Khussas</a>');
    // A listing's cards, and its own title.
    const listing = await page('/collections/eid-lawn', 'ur');
    expect(listing).toContain('عید کی لان');
    expect(listing).toContain('لان کا سوٹ');

    // In English, the shop's own words alone.
    const english = await page('/products/bridal-lehenga-heavy');
    expect(english).toContain('<title>Bridal Lehenga, Hand-embellished · Zari Fashions</title>');
    for (const words of ['دلہن کا لہنگا', 'ہاتھ سے کڑھائی', 'عید کی لان']) {
      expect(english).not.toContain(words);
    }
  });

  it("shows a product's options in the shop's Urdu, the variant chosen the same (ADR-241)", async () => {
    const sample = sampleStore();
    const lehenga = sample.products.find((product) => product.id === 'p-heavy')!;
    // Its colours' name and two of them in Urdu; its other options as they are.
    const options = lehenga.options.map((option) =>
      option.name === 'Colour'
        ? {
            name: 'رنگ',
            values: option.values.map((value) =>
              value === 'Red' ? 'لال' : value === 'Maroon' ? 'میرون' : value,
            ),
          }
        : option,
    );
    const store = new MemoryStore({
      ...sample,
      products: sample.products.map((product) =>
        product === lehenga ? { ...product, translations: { ur: { options } } } : product,
      ),
    });
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const page = async (locale?: string) =>
      (
        await renderer.render(
          {
            path: '/products/bridal-lehenga-heavy',
            query: { variant: 'p-heavy-v7' },
            ...(locale && { locale }),
          },
          store.fresh(),
        )
      ).html;
    const variantsIn = (html: string) =>
      JSON.parse(
        /<script type="application\/json" data-variants>([\s\S]*?)<\/script>/.exec(html)![1]!,
      ) as { id: string; title: string; options: string[] }[];

    const urdu = await page('ur');
    expect(urdu).toContain('<legend>رنگ</legend>');
    expect(urdu).toContain('<legend>Size</legend>');
    // The variant asked for, its value checked in Urdu, its title in Urdu, its ID its own.
    expect(urdu).toMatch(/value="p-heavy-v7"\s+selected/);
    expect(urdu).toMatch(/value="میرون"\s+checked/);
    expect(urdu).toContain('XS / میرون / Velvet · ');
    // The variants the picker finds by the values checked, in the same words.
    expect(variantsIn(urdu)[6]).toMatchObject({
      id: 'p-heavy-v7',
      title: 'XS / میرون / Velvet',
      options: ['XS', 'میرون', 'Velvet'],
    });

    // In English, its own words alone.
    const english = await page();
    expect(english).toContain('<legend>Colour</legend>');
    expect(english).toMatch(/value="Maroon"\s+checked/);
    expect(variantsIn(english)[6]).toMatchObject({
      id: 'p-heavy-v7',
      title: 'XS / Maroon / Velvet',
    });
    expect(english).not.toContain('میرون');
  });

  it("keeps what shops write from ending a page's scripts", async () => {
    const sample = sampleStore();
    const lehenga = sample.products.find((p) => p.handle === 'bridal-lehenga-heavy')!;
    const sly = '</script><script>alert(1)</script>';
    const products = sample.products.map((product) =>
      product === lehenga
        ? {
            ...product,
            title: sly,
            variants: product.variants.map((variant) => ({ ...variant, title: sly })),
          }
        : product,
    );
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const store = new MemoryStore({ ...sample, products });
    const html = (await renderer.render({ path: '/products/bridal-lehenga-heavy' }, store)).html;
    expect(html).not.toContain('<script>alert(1)');
    // The variants' JSON and the structured data still parse, the title as written.
    const variants = /<script type="application\/json" data-variants>([\s\S]*?)<\/script>/.exec(
      html,
    )![1]!;
    expect((JSON.parse(variants) as { title: string }[])[0]!.title).toBe(sly);
    const jsonLd = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!;
    expect((JSON.parse(jsonLd) as { name: string }).name).toBe(sly);
  });

  it('fetches what a page shows in a few round trips, a list at a time', async () => {
    // The shop, two menus, three collections, and one chunk of products per collection.
    expect((await render({ path: '/' })).roundTrips).toBe(9);
    // The shop, the collection, two menus, and its 80 products at once, to count its filters by.
    expect((await render({ path: '/collections/eid-lawn' })).roundTrips).toBe(5);
    expect((await render({ path: '/collections/eid-lawn' }, { chunkSize: 24 })).roundTrips).toBe(5);
    // The shop, the product and two menus: its related products come once the page asks for them.
    expect((await render({ path: '/products/bridal-lehenga-heavy' })).roundTrips).toBe(4);
  });

  it('renders a product with its options, variants and a form that needs no JavaScript', async () => {
    const page = await render({ path: '/products/bridal-lehenga-heavy' });
    expect(page.status).toBe(200);
    expect(page.html).toContain('<title>Bridal Lehenga, Hand-embellished · Zari Fashions</title>');
    expect(page.html).toMatch(
      /<form method="post" action="\/cart\/add" accept-charset="UTF-8" id="product-form" class="product__form" novalidate="novalidate"><input type="hidden" name="form_type" value="product">/,
    );
    expect(count(page.html, '<option\n')).toBe(100);
    expect(count(page.html, 'name="option-')).toBe(5 + 5 + 4);
    expect(page.html).toContain('Cash on delivery available');
    expect(page.html).toMatch(/https:\/\/wa\.me\/923001234567\?text=Hi!%20I'd%20like%20to%20order/);
    expect(count(page.html, '<li><img')).toBe(10);
    expect(page.html).toContain('fetchpriority="high"');
    // The variant asked for is the one the form adds.
    const picked = await render({
      path: '/products/bridal-lehenga-heavy',
      query: { variant: 'p-heavy-v7' },
    });
    expect(picked.html).toMatch(/value="p-heavy-v7"\s+selected/);
    expect(picked.html).toMatch(/value="Maroon"\s+checked/);
  });

  it('paginates a collection, its products fetched at once to count its filters by', async () => {
    const second = await render({ path: '/collections/eid-lawn', query: { page: '2' } });
    expect(second.html).toContain('80 products');
    expect(count(second.html, 'class="card"')).toBe(24);
    expect(second.html).toMatch(/Lawn \w+ 25</);
    expect(second.html).not.toMatch(/Lawn \w+ 24</);
    expect(second.html).toContain('<span class="page current" aria-current="page">2</span>');
    expect(second.roundTrips).toBe(5);
    // Past the last page is the last page.
    const last = await render({ path: '/collections/eid-lawn', query: { page: '99' } });
    expect(count(last.html, 'class="card"')).toBe(8);
  });

  it("filters a collection by Shopify's filter parameters, in Hatti Base's form (ADR-478)", async () => {
    const lawn = sampleStore().products.filter((each) => each.id.startsWith('p-eid-lawn-'));
    const someSold = lawn.filter((each) => each.variants.some((variant) => !variant.available));
    const unfiltered = await render({ path: '/collections/eid-lawn' });
    expect(unfiltered.errors).toEqual([]);
    expect(unfiltered.html).toContain('<details class="facets">');
    expect(unfiltered.html).toContain('name="filter.v.availability" value="0"');
    expect(unfiltered.html).toContain('name="filter.v.price.gte"');
    expect(unfiltered.html).not.toContain('class="facets__active"');

    const params: [string, string][] = [['filter.v.availability', '0']];
    const page = await render({
      path: '/collections/eid-lawn',
      query: Object.fromEntries(params),
      params,
    });
    expect(page.errors).toEqual([]);
    expect(page.html).toContain(`${someSold.length} products`);
    expect(page.html).toContain('<details class="facets" open>');
    expect(page.html).toMatch(/name="filter\.v\.availability" value="0" checked/);
    expect(page.html).toContain('<a href="/collections/eid-lawn" aria-label="Remove Out of stock"');
    // Its pages' links keep the filter.
    expect(page.html).toContain('href="?filter.v.availability=0&amp;page=2"');
    // An Urdu page's links keep its language.
    const urdu = await render({
      path: '/collections/eid-lawn',
      query: Object.fromEntries(params),
      params,
      locale: 'ur',
    });
    expect(urdu.html).toContain(
      '<a href="/ur/collections/eid-lawn" aria-label="ختم ہو گیا ہٹائیں"',
    );
  });

  it("narrows a collection to products with each of its address's tags, Shopify's current_tags (ADR-643)", async () => {
    const lawn = sampleStore().products.filter((each) => each.id.startsWith('p-eid-lawn-'));
    const onSale = lawn.filter((each) => each.tags.includes('sale'));
    expect(onSale.length).toBeGreaterThan(0);
    expect(onSale.length).toBeLessThan(lawn.length);
    const sale = await render({ path: '/collections/eid-lawn/sale' });
    expect(sale.status).toBe(200);
    expect(sale.errors).toEqual([]);
    expect(sale.html).toContain(`${onSale.length} products`);
    // Tags joined with +, matched as their handles, each of them.
    const both = await render({ path: '/collections/eid-lawn/Sale+unstitched-suit/' });
    expect(both.html).toContain(`${onSale.length} products`);
    expect((await render({ path: '/collections/eid-lawn/sale+new' })).html).toContain('0 products');
    // In Urdu too, and filters narrow it further, their links keeping the tag's address.
    const params: [string, string][] = [['filter.v.availability', '0']];
    const urdu = await render({
      path: '/collections/eid-lawn/sale',
      query: Object.fromEntries(params),
      params,
      locale: 'ur',
    });
    expect(urdu.errors).toEqual([]);
    expect(urdu.html).toContain('<a href="/ur/collections/eid-lawn/sale" aria-label=');
    // Themes get the tags as Shopify's current_tags, and the collection's count without them.
    const extra = {
      'sections/main-collection.liquid':
        '<p class="tags">{{ current_tags | join: "," }} {{ collection.products_count }}/{{ collection.all_products_count }}</p>' +
        '{% schema %}{ "name": "Collection" }{% endschema %}',
    };
    expect(
      (await render({ path: '/collections/eid-lawn/sale+new+sale' }, { extra })).html,
    ).toContain(`<p class="tags">sale,new 0/${lawn.length}</p>`);
    expect((await render({ path: '/collections/eid-lawn' }, { extra })).html).toContain(
      `<p class="tags"> ${lawn.length}/${lawn.length}</p>`,
    );
    // A tag that is no handle, too many tags, or a collection the shop lacks are not found.
    const many = Array.from({ length: 11 }, (_, index) => `t${index}`).join('+');
    for (const path of [
      '/collections/eid-lawn/%E0',
      '/collections/eid-lawn/+',
      `/collections/eid-lawn/${many}`,
      '/collections/nothing/sale',
    ]) {
      expect((await render({ path })).status, path).toBe(404);
    }
  });

  it('shows the filters the shop chose on its collection and search pages, its params alone (ADR-568)', async () => {
    const sample = sampleStore();
    const store = new MemoryStore({
      ...sample,
      shop: {
        ...sample.shop,
        filters: [
          { kind: 'product_type', label: 'Kind', labelUr: 'قسمیں' },
          { kind: 'availability' },
        ],
      },
    });
    const errors: unknown[] = [];
    const renderer = new PageRenderer(loadTheme(files), {
      limits: { timeMs: 10_000 },
      onError: (_, error) => errors.push(error),
    });
    const params: [string, string][] = [['filter.v.price.gte', '999999']];
    const page = (path: string, locale?: string, search?: PageRequest['search']) =>
      renderer.render(
        {
          path,
          query: Object.fromEntries(params),
          params,
          ...(locale && { locale }),
          ...(search && { search }),
        },
        store.fresh(),
      );
    const collection = await page('/collections/eid-lawn');
    expect(collection.html).toContain('name="filter.v.availability"');
    // The price is hidden: its filter is not shown, and the price asked for narrows nothing.
    expect(collection.html).not.toContain('name="filter.v.price.gte"');
    expect(collection.html).toContain('80 products');
    const ids = sample.products.map((product) => product.id);
    const search = { terms: 'lawn', productIds: ids.slice(0, 100), pageIds: [] as string[] };
    const found = await page('/search', undefined, search);
    expect(found.html).toContain('Kind');
    expect(found.html.indexOf('name="filter.p.product_type"')).toBeLessThan(
      found.html.indexOf('name="filter.v.availability"'),
    );
    expect(found.html).not.toContain('name="filter.v.price.gte"');
    expect((await page('/search', 'ur', search)).html).toContain('قسمیں');
    expect(errors).toEqual([]);
  });

  it("renders Urdu pages right to left, in the theme's Urdu", async () => {
    const page = await render({ path: '/products/bridal-lehenga-heavy', locale: 'ur' });
    expect(page.html).toMatch(/<html lang="ur" dir="rtl">/);
    expect(page.html).toContain('کارٹ میں ڈالیں');
    expect(page.html).toContain('ڈیلیوری پر ادائیگی کی سہولت');
    // Plural forms and values in translations.
    const collection = await render({ path: '/collections/khussa', locale: 'ur' });
    expect(collection.html).toContain('60 پروڈکٹس');
    // A locale the theme lacks falls back to its default.
    expect((await render({ path: '/', locale: 'fr' })).html).toMatch(/<html lang="en" dir="ltr">/);
  });

  it('answers 404 for products, collections and paths it does not have', async () => {
    for (const path of [
      '/products/nothing',
      '/collections/nothing',
      '/pages/about',
      '/pages',
      '/blogs',
    ]) {
      const page = await render({ path });
      expect(page.status, path).toBe(404);
      expect(page.html, path).toContain('Page not found');
    }
  });

  it("renders a shop's pages, their content as the shop saved it, in the theme's page template", async () => {
    const page = await render({ path: '/pages/returns' });
    expect(page.status).toBe(200);
    expect(page.html).toContain('<title>Returns and exchanges · Zari Fashions</title>');
    expect(page.html).toContain('<h1 dir="auto">Returns and exchanges</h1>');
    expect(page.html).toContain('<li>Sale items are final.</li>');
    // The footer's links to the shop's pages.
    expect(page.html).toContain('href="/pages/delivery"');
    const urdu = await render({ path: '/pages/contact', locale: 'ur' });
    expect(urdu.status).toBe(200);
    expect(urdu.html).toContain('<p dir="rtl" lang="ur">ہم سے رابطہ کریں: 0300 1234567</p>');
  });

  it("renders a shop's blog, the latest articles first, a page at a time, and those tagged (ADR-177)", async () => {
    const blog = await render({ path: '/blogs/news' });
    expect([blog.status, blog.errors]).toEqual([200, []]);
    expect(blog.html).toContain('<title>News · Zari Fashions</title>');
    const listed = [...blog.html.matchAll(/<h2 dir="auto"><a href="([^"]+)">([^<]+)<\/a><\/h2>/g)];
    expect(listed.map((match) => [match[1], match[2]])).toEqual([
      ['/blogs/news/eid-lawn-is-here', 'Eid lawn is here'],
      ['/blogs/news/how-to-measure', 'How to measure for a kurta'],
      ['/blogs/news/winter-shawls', 'Winter shawls'],
    ]);
    // Its summary, or else its content's beginning; when it was published, in Pakistan's time.
    expect(blog.html).toContain('<p>Hand-block printed in Multan, out now.</p>');
    expect(blog.html).toContain('<p>Measure your chest under the arms');
    expect(blog.html).toContain(
      '<time datetime="2026-09-20T21:30:00Z">21 September 2026</time> · By Ayesha Khan</p>',
    );
    expect(blog.html).toContain(
      '<time datetime="2026-09-10T09:00:00Z">10 September 2026</time></p>',
    );
    // Every tag of its articles once, whatever its case, each linking to the articles with it.
    const tags = [
      ...blog.html.matchAll(/<li><a href="\/blogs\/news\/tagged\/([^"]+)"[^>]*>([^<]+)</g),
    ];
    expect(tags.map((match) => `${match[1]} ${match[2]}`)).toEqual([
      'eid Eid',
      'guides Guides',
      'lawn Lawn',
      'winter Winter',
    ]);

    const tagged = await render({ path: '/blogs/news/tagged/Eid' });
    expect(tagged.status).toBe(200);
    expect(tagged.html).toContain('Tagged “eid” · <a href="/blogs/news">All articles</a>');
    expect(tagged.html).toContain('<a href="/blogs/news/tagged/eid" aria-current="page">Eid</a>');
    expect(
      [...tagged.html.matchAll(/<h2 dir="auto"><a href="[^"]+">([^<]+)</g)].map((m) => m[1]),
    ).toEqual(['Eid lawn is here', 'Winter shawls']);
    const none = await render({ path: '/blogs/news/tagged/silk' });
    expect([none.status, none.html.includes('No articles yet.')]).toEqual([200, true]);
    const urdu = await render({ path: '/blogs/news/tagged/silk', locale: 'ur' });
    expect(urdu.html).toContain('ابھی کوئی تحریر نہیں۔');

    // A page of them at a time, fetching only those shown.
    const documents = sampleStore();
    const more = Array.from({ length: 12 }, (_, index) => ({
      ...documents.articles![1]!,
      id: `art-${index}`,
      handle: `note-${index}`,
      title: `Note ${index}`,
    }));
    const big = new MemoryStore({
      ...documents,
      blogs: [{ ...documents.blogs![0]!, articles: more.map((a) => ({ id: a.id, tags: a.tags })) }],
      articles: more,
    });
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const second = await renderer.render(
      { path: '/blogs/news', query: { page: '2' } },
      big.fresh(),
    );
    expect(
      [...second.html.matchAll(/<h2 dir="auto"><a href="[^"]+">([^<]+)</g)].map((m) => m[1]),
    ).toEqual(['Note 10', 'Note 11']);
    expect(second.html).toContain('<nav class="pagination">');
  });

  it('renders an article with its blog, in the template it names, and gives themes blogs and articles by handle (ADR-177)', async () => {
    const article = await render({ path: '/blogs/news/eid-lawn-is-here' });
    expect([article.status, article.errors]).toEqual([200, []]);
    expect(article.html).toContain('<title>Eid lawn is here · Zari Fashions</title>');
    expect(article.html).toContain(
      '<p><a href="/blogs/news">Back to News</a></p><h1 dir="auto">Eid lawn is here</h1>',
    );
    expect(article.html).toContain('<p>Order by the 20th to have it stitched in time.</p>');
    expect(article.html).toContain('<a href="/blogs/news/tagged/lawn">Lawn</a>');
    const urdu = await render({ path: '/blogs/news/eid-lawn-is-here', locale: 'ur' });
    // Its links in Urdu, as the page is (ADR-624).
    expect(urdu.html).toContain('<a href="/ur/blogs/news">News پر واپس</a>');
    for (const path of [
      '/blogs/news/nothing',
      '/blogs/nothing',
      '/blogs/nothing/eid-lawn-is-here',
    ]) {
      expect((await render({ path })).status, path).toBe(404);
    }

    const documents = sampleStore();
    const recipe = { ...documents.articles![1]!, templateSuffix: 'recipe' };
    const shop = new MemoryStore({
      ...documents,
      articles: [documents.articles![0]!, recipe, documents.articles![2]!],
    });
    const theme = loadTheme({
      ...files,
      'templates/article.recipe.json': JSON.stringify({
        sections: { main: { type: 'main-article' }, also: { type: 'more-articles' } },
        order: ['main', 'also'],
      }),
      'sections/more-articles.liquid':
        '<p class="more">{{ template.name }}.{{ template.suffix }}: {{ blogs[\'news\'].title }} ' +
        "{{ blogs['news'].articles_count }} {{ articles['news/winter-shawls'].url }} " +
        "[{{ articles['news/nothing'].title }}] {{ blogs['news'].articles.first.title }}</p>" +
        '{% schema %}{ "name": "More articles" }{% endschema %}',
    });
    const renderer = new PageRenderer(theme, { limits: { timeMs: 10_000 } });
    const named = await renderer.render({ path: '/blogs/news/how-to-measure' }, shop.fresh());
    expect(named.html).toContain(
      '<p class="more">article.recipe: News 3 /blogs/news/winter-shawls [] Eid lawn is here</p>',
    );
    const plain = await renderer.render({ path: '/blogs/news/winter-shawls' }, shop.fresh());
    expect(plain.html).not.toContain('class="more"');
  });

  it('links an article to the older and the newer beside it, and its blog to its feed (ADR-209)', async () => {
    /** The links to the articles beside it: older, then newer. */
    const beside = (html: string) =>
      [...html.matchAll(/<a href="([^"]+)" class="article__(older|newer)">/g)].map(
        ([, url, side]) => `${side} ${url}`,
      );
    const middle = await render({ path: '/blogs/news/how-to-measure' });
    expect(middle.errors).toEqual([]);
    expect(beside(middle.html)).toEqual([
      'older /blogs/news/winter-shawls',
      'newer /blogs/news/eid-lawn-is-here',
    ]);
    expect(middle.html).toContain('<nav class="article__nav" aria-label="More from News">');
    expect(middle.html).toMatch(
      /<span>Older article<\/span>\s*<span dir="auto">Winter shawls<\/span>/,
    );
    // The latest has none newer, the first none older.
    expect(beside((await render({ path: '/blogs/news/eid-lawn-is-here' })).html)).toEqual([
      'older /blogs/news/how-to-measure',
    ]);
    const first = await render({ path: '/blogs/news/winter-shawls', locale: 'ur' });
    expect(beside(first.html)).toEqual(['newer /ur/blogs/news/how-to-measure']);
    expect(first.html).toContain('<span>نئی تحریر</span>');

    // Its blog's feed, on its page and its articles', and nowhere else.
    const feed =
      '<link rel="alternate" type="application/atom+xml" title="Zari Fashions - News" ' +
      'href="/blogs/news.atom">';
    expect(middle.html).toContain(feed);
    expect((await render({ path: '/blogs/news' })).html).toContain(feed);
    expect((await render({ path: '/' })).html).not.toContain('application/atom+xml');

    // Themes get them as Shopify's: printed, their address; nothing on a blog's own page.
    const extra = {
      'sections/main-article.liquid':
        '<p class="beside">{{ blog.next_article }} {{ blog.previous_article.title }} {{ blog.previous_article.updated_at }} [{{ blogs[\'news\'].next_article }}]</p>' +
        '{% schema %}{ "name": "Article" }{% endschema %}',
    };
    const themed = await render({ path: '/blogs/news/how-to-measure' }, { extra });
    expect(themed.html).toContain(
      '<p class="beside">/blogs/news/winter-shawls Eid lawn is here 2026-09-20T21:30:00.000Z []</p>',
    );
    // The two in one round trip, beside the shop, the article and its blog, and the menus.
    const plain = await render(
      { path: '/blogs/news/how-to-measure' },
      {
        extra: {
          'sections/main-article.liquid': '{% schema %}{ "name": "Article" }{% endschema %}',
        },
      },
    );
    expect(themed.roundTrips).toBe(plain.roundTrips + 1);
  });

  it("prints dates in the shop's time zone and the page's language, with Shopify's time_tag (ADR-211)", async () => {
    // Published at 21:30 UTC on the 20th: the 21st in Pakistan, the 20th in New York.
    const time = (html: string) =>
      /<p class="article__meta">\s*(<time[^]*?<\/time>)/.exec(html)?.[1];
    const article = await render({ path: '/blogs/news/eid-lawn-is-here' });
    expect(time(article.html)).toBe(
      '<time datetime="2026-09-20T21:30:00Z">21 September 2026</time>',
    );
    const urdu = await render({ path: '/blogs/news/eid-lawn-is-here', locale: 'ur' });
    expect(time(urdu.html)).toBe('<time datetime="2026-09-20T21:30:00Z">21 ستمبر 2026</time>');
    const sample = sampleStore();
    const abroad = new MemoryStore({
      ...sample,
      shop: { ...sample.shop, timezone: 'America/New_York' },
    });
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const there = await renderer.render({ path: '/blogs/news/eid-lawn-is-here' }, abroad.fresh());
    expect(time(there.html)).toBe('<time datetime="2026-09-20T21:30:00Z">20 September 2026</time>');
    // A time zone Intl does not know, as no document should name: Pakistan's.
    const unknown = new MemoryStore({
      ...sample,
      shop: { ...sample.shop, timezone: 'Mars/Olympus' },
    });
    const lost = await renderer.render({ path: '/blogs/news/eid-lawn-is-here' }, unknown.fresh());
    expect(time(lost.html)).toBe('<time datetime="2026-09-20T21:30:00Z">21 September 2026</time>');

    // Shopify's formats by name, the theme's own first; strftime's; and its datetime.
    const extra = {
      'sections/main-article.liquid':
        '<p class="dates">' +
        "{{ article.published_at | date: format: 'abbreviated_date' }}|" +
        "{{ article.published_at | date: format: 'day_month_year' }}|" +
        "{{ article.published_at | date: '%H:%M %z' }}|" +
        '{{ article.published_at | date_to_long_string }}|' +
        "{{ article.published_at | time_tag: '%Y', datetime: '%Y-%m-%d' }}|" +
        "{{ article.published_at | time_tag: format: 'nothing' }}|" +
        '[{{ article.missing | time_tag }}]</p>' +
        '{% schema %}{ "name": "Article" }{% endschema %}',
    };
    const dated = await render({ path: '/blogs/news/eid-lawn-is-here' }, { extra });
    expect(/<p class="dates">([^]*?)<\/p>/.exec(dated.html)?.[1]).toBe(
      'Sep 21, 2026|21 September 2026|02:30 +0500|21 September 2026|' +
        '<time datetime="2026-09-21">2026</time>|' +
        '<time datetime="2026-09-20T21:30:00Z">Monday, September 21, 2026 at 2:30 am +0500</time>|' +
        '[]',
    );
    const urduDates = await render(
      { path: '/blogs/news/eid-lawn-is-here', locale: 'ur' },
      { extra },
    );
    expect(/<p class="dates">([^|]*)\|/.exec(urduDates.html)?.[1]).toBe('ستمبر 21, 2026');
  });

  it("shows an article's comments and Shopify's comment form where its blog takes them (ADR-220)", async () => {
    // Its blog taking none, as in documents written before: neither.
    const closed = await render({ path: '/blogs/news/eid-lawn-is-here' });
    expect(closed.html).not.toContain('id="comments"');
    expect(closed.html).not.toContain('new_comment');

    const sample = sampleStore();
    const comments = [
      {
        id: 'cmt-1',
        author: 'Zara',
        bodyHtml: '<p>Lovely &lt;3<br>Thanks</p>',
        createdAt: '2026-09-21T10:00:00.000Z',
      },
      {
        id: 'cmt-2',
        author: 'Hina',
        bodyHtml: '<p>When is the sale?</p>',
        createdAt: '2026-09-22T10:00:00.000Z',
      },
    ];
    const shop = new MemoryStore({
      ...sample,
      blogs: sample.blogs!.map((blog) => ({ ...blog, commentPolicy: 'moderated' as const })),
      articles: sample.articles!.map((article) =>
        article.id === 'art-eid'
          ? { ...article, commentPolicy: 'moderated' as const, comments, commentsCount: 2 }
          : article,
      ),
    });
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const at = (request: Partial<PageRequest>) =>
      renderer.render({ path: '/blogs/news/eid-lawn-is-here', ...request }, shop.fresh());
    const page = await at({});
    expect(page.status).toBe(200);
    expect(page.html).toContain('<h2 id="comments-heading">2 comments</h2>');
    // Escaped as text when published: printed as it is.
    expect(page.html).toContain('<div class="rte" dir="auto"><p>Lovely &lt;3<br>Thanks</p></div>');
    expect(page.html).toContain(
      '<form method="post" action="/blogs/news/eid-lawn-is-here/comments" accept-charset="UTF-8" ' +
        'id="comment_form" class="comment-form"><input type="hidden" name="form_type" ' +
        'value="new_comment">',
    );
    expect(page.html).toContain('name="comment[author]"');
    expect(page.html).toContain('Comments show once the shop approves them.');
    // Back from posting: thanked, as the blog moderates, or told what to put right.
    expect((await at({ query: { comment_posted: 'true' } })).html).toContain(
      'Thank you: your comment will show once the shop approves it.',
    );
    expect((await at({ query: { comment_error: 'email' } })).html).toContain(
      'Enter your name, your email address and a comment.',
    );
    // On the Urdu page, it posts there in Urdu.
    const urdu = await at({ locale: 'ur' });
    expect(urdu.html).toContain('action="/ur/blogs/news/eid-lawn-is-here/comments"');
    expect(urdu.html).toContain('2 تبصرے');

    // Themes get them as Shopify's, a page at a time.
    const extra = {
      'sections/main-article.liquid':
        '<p class="c">{{ article.comments_enabled? }} {{ article.moderated? }} ' +
        '{{ blog.comments_enabled? }} {{ blog.moderated? }} {{ article.comments_count }} ' +
        '{{ article.comment_post_url }} {% paginate article.comments by 1 %}' +
        '{% for c in article.comments %}{{ c.author }} {{ c.url }} {{ c.status }}{% endfor %} ' +
        '{{ paginate.pages }}{% endpaginate %}</p>' +
        '{% schema %}{ "name": "Article" }{% endschema %}',
    };
    const themed = await new PageRenderer(loadTheme({ ...files, ...extra }), {
      limits: { timeMs: 10_000 },
    }).render({ path: '/blogs/news/eid-lawn-is-here', query: { page: '2' } }, shop.fresh());
    expect(/<p class="c">([^]*?)<\/p>/.exec(themed.html)?.[1]).toBe(
      'true true true true 2 /blogs/news/eid-lawn-is-here/comments ' +
        'Hina /blogs/news/eid-lawn-is-here#comment-cmt-2 published 2',
    );
  });

  it("shows an article's image on its blog's page and its own, as Shopify's article.image (ADR-213)", async () => {
    const sample = sampleStore();
    // Where the API serves it, its size unknown, as the publisher names it.
    const image = {
      src: 'https://api.hatti.test/article-images/shop-1/art-eid?v=0a1b2c3d',
      width: 0,
      height: 0,
      alt: 'Lawn, folded',
    };
    const shop = new MemoryStore({
      ...sample,
      articles: sample.articles!.map((article) =>
        article.id === 'art-eid' ? { ...article, image } : article,
      ),
    });
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const blog = await renderer.render({ path: '/blogs/news' }, shop.fresh());
    // Beside the title it links to, hidden from screen readers, which the title tells already.
    const listed = [
      ...blog.html.matchAll(/<a href="([^"]+)" class="blog__image"[^>]*>\s*(<img [^>]*>)/g),
    ];
    expect(listed.map(([, url, img]) => [url, img])).toEqual([
      [
        '/blogs/news/eid-lawn-is-here',
        '<img src="https://api.hatti.test/article-images/shop-1/art-eid?v=0a1b2c3d&amp;width=720" ' +
          'srcset="https://api.hatti.test/article-images/shop-1/art-eid?v=0a1b2c3d&amp;width=720 720w" ' +
          'alt="" loading="lazy">',
      ],
    ]);
    const article = await renderer.render({ path: '/blogs/news/eid-lawn-is-here' }, shop.fresh());
    expect(/<figure class="article__image">\s*(<img [^>]*>)/.exec(article.html)?.[1]).toBe(
      '<img src="https://api.hatti.test/article-images/shop-1/art-eid?v=0a1b2c3d&amp;width=1200" ' +
        'srcset="https://api.hatti.test/article-images/shop-1/art-eid?v=0a1b2c3d&amp;width=1200 1200w" ' +
        'alt="Lawn, folded" fetchpriority="high">',
    );
    // None for an article without one, as for one in a document written before images.
    const plain = await renderer.render({ path: '/blogs/news/winter-shawls' }, shop.fresh());
    expect(plain.html).not.toContain('<figure class="article__image">');

    // Themes get it as Shopify's: printed, its address; its alt; null when there is none.
    const extra = {
      'sections/main-article.liquid':
        '<p class="image">{{ article.image }}|{{ article.image.alt }}|{{ article.image | image_url: width: 100 }}|[{{ articles[\'news/winter-shawls\'].image }}]</p>' +
        '{% schema %}{ "name": "Article" }{% endschema %}',
    };
    const themed = await new PageRenderer(loadTheme({ ...files, ...extra }), {
      limits: { timeMs: 10_000 },
    }).render({ path: '/blogs/news/eid-lawn-is-here' }, shop.fresh());
    expect(/<p class="image">([^]*?)<\/p>/.exec(themed.html)?.[1]).toBe(
      'https://api.hatti.test/article-images/shop-1/art-eid?v=0a1b2c3d|Lawn, folded|' +
        'https://api.hatti.test/article-images/shop-1/art-eid?v=0a1b2c3d&width=100|[]',
    );
  });

  it("gives themes a product's dates, as Shopify's product.created_at and its kin (ADR-216)", async () => {
    const sample = sampleStore();
    const [first, second] = sample.products;
    const dated = {
      ...first!,
      createdAt: '2026-09-01T09:00:00.000Z',
      updatedAt: '2026-09-20T10:00:00.000Z',
    };
    const shop = new MemoryStore({ ...sample, products: [dated, second!] });
    const theme = loadTheme({
      ...files,
      'sections/main-product.liquid':
        '<p class="dates">{{ product.created_at }}|{{ product.published_at }}|' +
        "{{ product.updated_at | date: '%Y-%m-%d' }}|[{{ all_products['" +
        second!.handle +
        "'].created_at }}]</p>" +
        '{% schema %}{ "name": "Product" }{% endschema %}',
    });
    const renderer = new PageRenderer(theme, { limits: { timeMs: 10_000 } });
    const page = await renderer.render({ path: `/products/${dated.handle}` }, shop.fresh());
    // Published when made, as Hatti keeps no time of a product's being made active; none in
    // documents written before.
    expect(/<p class="dates">([^]*?)<\/p>/.exec(page.html)?.[1]).toBe(
      '2026-09-01T09:00:00.000Z|2026-09-01T09:00:00.000Z|2026-09-20|[]',
    );
  });

  it("shows a product's published reviews, its stars on its page and cards, and tells search engines (ADR-401)", async () => {
    const sample = sampleStore();
    const [first, ...rest] = sample.products;
    const reviewed = {
      ...first!,
      reviews: {
        rating: 4.5,
        count: 2,
        latest: [
          {
            id: 'r2',
            author: 'Bilal A.',
            rating: 5,
            bodyHtml: '<p>Fits &lt;well&gt;</p>',
            createdAt: '2026-10-10T09:00:00.000Z',
          },
          {
            id: 'r1',
            author: 'Ayesha K.',
            rating: 4,
            bodyHtml: null,
            createdAt: '2026-10-08T09:00:00.000Z',
          },
        ],
      },
    };
    const shop = new MemoryStore({ ...sample, products: [reviewed, ...rest] });
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const page = await renderer.render({ path: `/products/${reviewed.handle}` }, shop.fresh());
    const html = page.html;
    // Under its title, leading to its reviews; then each, newest first, escaped as it was kept.
    expect(html).toContain('style="--rating: 4.5"');
    expect(html).toContain('Rated 4.5 out of 5');
    expect(html).toContain('<a href="#reviews">2 reviews</a>');
    expect(html).toContain('<h2 id="reviews-heading">Customer reviews</h2>');
    expect(html.indexOf('Bilal A.')).toBeLessThan(html.indexOf('Ayesha K.'));
    expect(html).toContain('<p>Fits &lt;well&gt;</p>');
    expect(count(html, 'Bought from this shop')).toBe(2);
    // Search engines get its stars, and the reviews' own.
    const data = JSON.parse(
      /<script type="application\/ld\+json">([^<]*Product[^<]*)<\/script>/.exec(html)![1]!,
    );
    expect(data.aggregateRating).toEqual({
      '@type': 'AggregateRating',
      ratingValue: 4.5,
      reviewCount: 2,
      bestRating: 5,
      worstRating: 1,
    });
    expect(data.review).toEqual([
      {
        '@type': 'Review',
        author: { '@type': 'Person', name: 'Bilal A.' },
        reviewRating: { '@type': 'Rating', ratingValue: 5, bestRating: 5, worstRating: 1 },
        datePublished: '2026-10-10',
        reviewBody: 'Fits <well>',
      },
      {
        '@type': 'Review',
        author: { '@type': 'Person', name: 'Ayesha K.' },
        reviewRating: { '@type': 'Rating', ratingValue: 4, bestRating: 5, worstRating: 1 },
        datePublished: '2026-10-08',
      },
    ]);
    // A collection's cards show its stars; a product with none shows none, nor its section.
    const listing = await renderer.render({ path: '/collections/all' }, shop.fresh());
    expect(count(listing.html, 'class="rating"')).toBe(1);
    const plain = await renderer.render({ path: `/products/${rest[0]!.handle}` }, shop.fresh());
    expect(plain.html).not.toContain('id="reviews"');
    expect(plain.html).not.toContain('aggregateRating');
    // In Urdu too.
    const urdu = await renderer.render(
      { path: `/products/${reviewed.handle}`, locale: 'ur' },
      shop.fresh(),
    );
    expect(urdu.html).toContain('خریداروں کے ریویوز');
  });

  it("shows a product's size chart, to read in inches or centimetres (ADR-407)", async () => {
    const sample = sampleStore();
    const [first, ...rest] = sample.products;
    const measured = {
      ...first!,
      sizeChart: {
        name: 'Kurtas <women>',
        unit: 'in' as const,
        columns: ['Chest', 'Length'],
        rows: [
          { size: 'S', values: [36, 42] },
          { size: 'M', values: [38.5, null] },
        ],
        note: 'Measure a kurta that fits.',
      },
    };
    const shop = new MemoryStore({ ...sample, products: [measured, ...rest] });
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const page = await renderer.render({ path: `/products/${measured.handle}` }, shop.fresh());
    const flat = page.html.replace(/\s+/g, ' ');
    expect(flat).toContain('<summary class="size-chart__summary">Size chart</summary>');
    expect(flat).toContain('<p class="size-chart__name" dir="auto">Kurtas &lt;women&gt;</p>');
    // Inches first, as the shop wrote it; centimetres worked out to a tenth.
    expect(flat).toMatch(/id="size-chart-in-[^"]+" value="in" checked/);
    expect(flat).not.toMatch(/id="size-chart-cm-[^"]+" value="cm" checked/);
    expect(flat).toContain('<th scope="row" dir="auto">S</th><td>36</td><td>42</td>');
    expect(flat).toContain('<th scope="row" dir="auto">S</th><td>91.4</td><td>106.7</td>');
    expect(flat).toContain('<th scope="row" dir="auto">M</th><td>97.8</td><td>–</td>');
    expect(flat).toContain('Measure a kurta that fits.');

    const plain = await renderer.render({ path: `/products/${rest[0]!.handle}` }, shop.fresh());
    expect(plain.html).not.toContain('size-chart');
    const urdu = await renderer.render(
      { path: `/products/${measured.handle}`, locale: 'ur' },
      shop.fresh(),
    );
    expect(urdu.html).toContain('سائز چارٹ');
    expect(urdu.html).toContain('سینٹی میٹر');
  });

  it('lists what a bundle holds on its page, linking the parts for sale (ADR-411)', async () => {
    const sample = sampleStore();
    const [first, second, ...rest] = sample.products;
    const set = {
      ...first!,
      bundle: {
        components: [
          { title: second!.title, variantTitle: null, quantity: 1, handle: second!.handle },
          { title: 'Silk <dupatta>', variantTitle: 'Red', quantity: 2, handle: null },
        ],
      },
    };
    const shop = new MemoryStore({ ...sample, products: [set, second!, ...rest] });
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const page = await renderer.render({ path: `/products/${set.handle}` }, shop.fresh());
    const flat = page.html.replace(/\s+/g, ' ');
    expect(flat).toContain('<p class="bundle-contents__title">In this set</p>');
    expect(flat).toContain(
      `<span class="bundle-contents__quantity">1 ×</span> <a href="/products/${second!.handle}" dir="auto">`,
    );
    // A part not for sale is named, not linked; its variant beside it.
    expect(flat).toContain(
      '<span class="bundle-contents__quantity">2 ×</span> <span dir="auto">Silk &lt;dupatta&gt;</span> <span class="bundle-contents__variant" dir="auto">Red</span>',
    );

    const plain = await renderer.render({ path: `/products/${second!.handle}` }, shop.fresh());
    expect(plain.html).not.toContain('bundle-contents');
    const urdu = await renderer.render(
      { path: `/products/${set.handle}`, locale: 'ur' },
      shop.fresh(),
    );
    expect(urdu.html).toContain('اس سیٹ میں');
  });

  it("offers a combined listing's other products as values of its option, linked to their pages (ADR-799)", async () => {
    const sample = sampleStore();
    const [first, second, third, ...rest] = sample.products;
    const listing = {
      optionName: 'Colour',
      products: [
        { id: first!.id, value: 'Maroon' },
        { id: second!.id, value: 'Teal <dark>' },
        { id: third!.id, value: 'Mustard' },
        // One whose page is gone since is left out.
        { id: 'gone', value: 'Black' },
      ],
    };
    const soldOut = {
      ...third!,
      combinedListing: listing,
      variants: third!.variants.map((each) => ({ ...each, available: false })),
    };
    const products = [
      { ...first!, combinedListing: listing },
      { ...second!, combinedListing: listing },
      soldOut,
      ...rest,
    ];
    const shop = new MemoryStore({ ...sample, products });
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const page = await renderer.render({ path: `/products/${first!.handle}` }, shop.fresh());
    const flat = page.html.replace(/\s+/g, ' ');
    expect(flat).toContain('<p class="combined-listing__name">Colour</p>');
    expect(flat).toMatch(
      /<span class="combined-listing__value combined-listing__value--selected" aria-current="page">.*?<span dir="auto">Maroon<\/span>/,
    );
    expect(flat).toMatch(
      new RegExp(
        `<a class="combined-listing__value" href="/products/${second!.handle}">.*?<span dir="auto">Teal &lt;dark&gt;</span></a>`,
      ),
    );
    expect(flat).toMatch(
      /<span dir="auto">Mustard<\/span><span class="combined-listing__sold-out">Sold out<\/span><\/a>/,
    );
    expect(flat).not.toContain('Black');

    const plain = await renderer.render({ path: `/products/${rest[0]!.handle}` }, shop.fresh());
    expect(plain.html).not.toContain('combined-listing__name');
  });

  it("names a one-card listing's values on its card in collections (ADR-901)", async () => {
    const sample = sampleStore();
    const [first, second, ...rest] = sample.products;
    const values = ['Maroon', 'Teal <dark>', 'Mustard', 'Black', 'Rust', 'Sage'];
    const listing = (oneCard: boolean) => ({
      optionName: 'Colour',
      products: values.map((value, index) => ({
        id: index === 0 ? first!.id : `p${index}`,
        value,
      })),
      ...(oneCard && { oneCard: true as const }),
    });
    const products = [
      { ...first!, combinedListing: listing(true) },
      {
        ...second!,
        combinedListing: { ...listing(false), products: listing(false).products.slice(0, 2) },
      },
      ...rest,
    ];
    const shop = new MemoryStore({ ...sample, products });
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const page = await renderer.render({ path: '/collections/all' }, shop.fresh());
    const flat = page.html.replace(/\s+/g, ' ');
    expect(flat).toContain(
      '<p class="card__values" dir="auto">Maroon · Teal &lt;dark&gt; · Mustard · Black · +2 more</p>',
    );
    // A listing not shown as one card names none.
    expect(flat.match(/class="card__values"/g)).toHaveLength(1);
  });

  it("counts down a running sale's end, and says how many are left where few are (ADR-445)", async () => {
    const sample = sampleStore();
    const [first, ...rest] = sample.products;
    const onSale = {
      ...first!,
      saleEndsAt: '2026-11-12T18:59:00.000Z',
      variants: first!.variants.map((each, index) => ({
        ...each,
        available: true,
        ...(index === 0 && { left: 3 }),
      })),
    };
    const shop = new MemoryStore({ ...sample, products: [onSale, ...rest] });
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const page = await renderer.render({ path: `/products/${onSale.handle}` }, shop.fresh());
    expect(page.html).toMatch(
      /<p\s+class="product__sale-ends"\s+data-sale-ends="2026-11-12T18:59:00.000Z"\s+data-words="Sale ends in \{time\}"\s+data-days="\{count\}d"\s*>Sale ends 12 November 2026<\/p>/,
    );
    expect(page.html).toMatch(
      /<p\s+class="product__low-stock"\s+data-low-stock\s+data-words="Only \{count\} left"\s*>Only 3 left<\/p>/,
    );
    // Its variants say theirs, as Shopify's do, for the page's script.
    const variants = JSON.parse(/data-variants>(.*?)<\/script>/s.exec(page.html)![1]!);
    expect(
      variants.map((each: { inventory_quantity: number | null }) => each.inventory_quantity),
    ).toEqual(onSale.variants.map((_, index) => (index === 0 ? 3 : null)));
    // A product in no sale, with plenty left, says neither.
    const plain = await renderer.render({ path: `/products/${rest[0]!.handle}` }, shop.fresh());
    expect(plain.html).not.toContain('class="product__sale-ends"');
    expect(plain.html).toMatch(
      /<p\s+class="product__low-stock"\s+data-low-stock[^>]*\shidden\s*><\/p>/,
    );
    // In Urdu too.
    const urdu = await renderer.render(
      { path: `/products/${onSale.handle}`, locale: 'ur' },
      shop.fresh(),
    );
    expect(urdu.html).toContain('صرف 3 باقی');
  });

  it("counts down to a drop's start, and says how many a customer may buy (ADR-823)", async () => {
    const sample = sampleStore();
    const [first, ...rest] = sample.products;
    const inDrop = {
      ...first!,
      drop: {
        name: 'Eid lawn',
        startsAt: '2026-10-31T19:00:00.000Z',
        endsAt: '2026-11-01T19:00:00.000Z',
        perCustomer: 2,
      },
    };
    const shop = new MemoryStore({ ...sample, products: [inDrop, ...rest] });
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const page = await renderer.render({ path: `/products/${inDrop.handle}` }, shop.fresh());
    expect(page.html).toMatch(
      /<p\s+class="product__drop"\s+data-drop-starts="2026-10-31T19:00:00.000Z"\s+data-drop-ends="2026-11-01T19:00:00.000Z"\s+data-words="On sale in \{time\}"\s+data-days="\{count\}d"\s*>On sale 1 November 2026<\/p>/,
    );
    expect(page.html).toContain('<p class="product__drop-limit">2 per customer</p>');
    // Its script counts down, and turns the button off until the start.
    expect(page.html).toContain("document.querySelectorAll('[data-drop-starts]')");
    // A product in no drop says nothing of one.
    const plain = await renderer.render({ path: `/products/${rest[0]!.handle}` }, shop.fresh());
    expect(plain.html).not.toContain('class="product__drop');
    // In Urdu too.
    const urdu = await renderer.render(
      { path: `/products/${inDrop.handle}`, locale: 'ur' },
      shop.fresh(),
    );
    expect(urdu.html).toContain('ہر گاہک کے لیے 2');
  });

  it('asks for what a product made to order needs, as properties of the line it adds (ADR-689)', async () => {
    const sample = sampleStore();
    const [first, ...rest] = sample.products;
    const named = {
      ...first!,
      personalisation: [
        { name: 'Name to embroider', kind: 'text' as const, required: true, maxLength: 12 },
        {
          name: 'Thread "colour"',
          kind: 'choice' as const,
          required: false,
          choices: ['Gold', 'Silver'],
          price: 500_00,
        },
      ],
    };
    const shop = new MemoryStore({ ...sample, products: [named, ...rest] });
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const page = await renderer.render({ path: `/products/${named.handle}` }, shop.fresh());
    expect(page.html).toMatch(
      /<input\s+type="text"\s+name="properties\[Name to embroider\]"\s+maxlength="12"\s+dir="auto"\s+autocomplete="off"\s+required\s*>/,
    );
    expect(page.html).toContain('<span>Name to embroider</span>');
    // Its name escaped where it names the property, and said to be optional.
    expect(page.html).toContain('<select name="properties[Thread &#34;colour&#34;]" >');
    // What it adds to the price is said beside it (ADR-697).
    expect(page.html).toContain('<span>Thread &#34;colour&#34; (optional) (+Rs 500)</span>');
    expect(page.html).toContain('<option value="Silver">Silver</option>');
    const urdu = await renderer.render(
      { path: `/products/${named.handle}`, locale: 'ur' },
      shop.fresh(),
    );
    expect(urdu.html).toContain('(اختیاری) (Rs 500 اضافی)');
    expect(urdu.html).toContain('<option value="">منتخب کریں</option>');
    // A product that asks for nothing has no such fields.
    const plain = await renderer.render({ path: `/products/${rest[0]!.handle}` }, shop.fresh());
    expect(plain.html).not.toContain('<label class="product__personalisation">');
  });

  it('offers an unstitched product stitched to measurements, for its price and days (ADR-802)', async () => {
    const sample = sampleStore();
    const [first, ...rest] = sample.products;
    const lawn = {
      ...first!,
      stitching: {
        price: 1_500_00,
        leadDays: 7,
        measurements: [
          { key: 'shirt_length', property: 'Shirt length (inches)' },
          { key: 'chest', property: 'Chest (inches)' },
        ],
      },
    };
    const shop = new MemoryStore({ ...sample, products: [lawn, ...rest] });
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const page = await renderer.render({ path: `/products/${lawn.handle}` }, shop.fresh());
    const flat = page.html.replace(/\s+/g, ' ');
    expect(flat).toContain('<legend>Stitching</legend>');
    expect(flat).toContain(
      '<input type="radio" name="properties[Stitching]" value="Unstitched" checked> <span>Unstitched</span>',
    );
    expect(flat).toContain(
      '<input type="radio" name="properties[Stitching]" value="Stitched"> <span>Stitched to my measurements (+Rs 1,500)</span>',
    );
    expect(flat).toContain('Stitched pieces ship 7 days later.');
    expect(flat).toMatch(
      /<span>Shirt length<\/span> <input type="text" inputmode="decimal" name="properties\[Shirt length \(inches\)\]"/,
    );
    expect(flat).toContain('<span>Chest</span>');
    const urdu = await renderer.render(
      { path: `/products/${lawn.handle}`, locale: 'ur' },
      shop.fresh(),
    );
    expect(urdu.html).toContain('میرے ناپ پر سلائی');
    expect(urdu.html).toContain('<span>چھاتی</span>');
    // A product offered no stitching has none.
    const plain = await renderer.render({ path: `/products/${rest[0]!.handle}` }, shop.fresh());
    expect(plain.html).not.toContain('product__stitching"');
  });

  it("offers a product its shop's selling plans, at their prices, by its tag (ADR-862)", async () => {
    const sample = sampleStore();
    const [first, ...rest] = sample.products;
    const chai = { ...first!, tags: [...first!.tags, 'Subscribe'] };
    const variant = chai.variants[0]!;
    const shop = new MemoryStore({
      ...sample,
      shop: {
        ...sample.shop,
        sellingPlans: [
          {
            id: 'slpl_month',
            name: 'Every month',
            intervalUnit: 'month',
            intervalCount: 1,
            discountPercent: 10,
            productTag: 'subscribe',
            minimumOrders: 3,
          },
          {
            id: 'slpl_tea',
            name: 'Every week',
            intervalUnit: 'week',
            intervalCount: 1,
            discountPercent: 5,
            productTag: 'tea',
          },
        ],
      },
      products: [chai, ...rest],
    });
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const page = await renderer.render({ path: `/products/${chai.handle}` }, shop.fresh());
    const flat = page.html.replace(/\s+/g, ' ');
    expect(flat).toContain('<legend>Purchase options</legend>');
    expect(flat).toContain('<input type="radio" name="selling_plan" value="" checked>');
    expect(flat).toContain('<input type="radio" name="selling_plan" value="slpl_month">');
    const off = Math.floor((variant.price * 90) / 100);
    expect(flat).toContain(
      `Subscribe: Every month, Rs ${(off / 100).toLocaleString('en', { maximumFractionDigits: 2 })} (10% off)`,
    );
    // Its minimum orders, where it asks for some (ADR-928).
    expect(flat).toContain('At least 3 orders before you cancel');
    // Only the plans of its tags, or of all products.
    expect(flat).not.toContain('slpl_tea');
    const plain = await renderer.render({ path: `/products/${rest[0]!.handle}` }, shop.fresh());
    expect(plain.html).not.toContain('<fieldset class="product__selling-plans">');
  });

  it('offers a plan for chosen variants on those alone, as their allocations say (ADR-930)', async () => {
    const sample = sampleStore();
    const [first, ...rest] = sample.products;
    const small = first!.variants[0]!;
    const large = { ...small, id: `${small.id}-large`, title: 'Large', price: small.price * 2 };
    const chai = { ...first!, variants: [small, large] };
    const shop = new MemoryStore({
      ...sample,
      shop: {
        ...sample.shop,
        sellingPlans: [
          {
            id: 'slpl_large',
            name: 'Every month',
            intervalUnit: 'month',
            intervalCount: 1,
            discountPercent: 10,
            productTag: null,
            variantIds: [large.id],
          },
        ],
      },
      products: [chai, ...rest],
    });
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    // The first variant is not sold on it: the plan is there, hidden, for the script to show.
    const page = await renderer.render({ path: `/products/${chai.handle}` }, shop.fresh());
    const flat = page.html.replace(/\s+/g, ' ');
    expect(flat).toContain('<label class="pill" data-selling-plan="slpl_large" hidden>');
    const variants = JSON.parse(
      /<script type="application\/json" data-variants>(.*?)<\/script>/s.exec(page.html)![1]!,
    ) as { id: string; selling_plan_allocations: { selling_plan_id: string; price: number }[] }[];
    expect(variants.map((each) => each.selling_plan_allocations)).toEqual([
      [],
      [
        expect.objectContaining({
          selling_plan_id: 'slpl_large',
          price: large.price - Math.floor((large.price * 10 + 50) / 100),
          compare_at_price: large.price,
        }),
      ],
    ]);
    // Picked, it shows.
    const picked = await renderer.render(
      { path: `/products/${chai.handle}`, query: { variant: large.id } },
      shop.fresh(),
    );
    expect(picked.html.replace(/\s+/g, ' ')).toContain(
      '<label class="pill" data-selling-plan="slpl_large">',
    );
    // A product with none of its variants is offered no plan.
    const plain = await renderer.render({ path: `/products/${rest[0]!.handle}` }, shop.fresh());
    expect(plain.html).not.toContain('<fieldset class="product__selling-plans">');
  });

  it("shows prices in the shopper's currency, of the shop's, and says checkout charges rupees (ADR-865)", async () => {
    const sample = sampleStore();
    const product = sample.products[0]!;
    const variant = product.variants[0]!;
    const shop = new MemoryStore({
      ...sample,
      shop: {
        ...sample.shop,
        currencies: [
          { currency: 'AED', rate: '76.4521', rounding: 'ninety_nine' },
          { currency: 'GBP', rate: '372', rounding: 'exact' },
        ],
      },
    });
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    // Up to the next .99 of the dirhams, at Rs 76.4521 each.
    const aed = Math.ceil(variant.price / 100 / 76.4521 + 0.000_1) - 0.01;
    const page = await renderer.render(
      { path: `/products/${product.handle}`, currency: 'AED' },
      shop.fresh(),
    );
    const flat = page.html.replace(/\s+/g, ' ');
    expect(flat).toContain(`AED ${aed.toFixed(2)}`);
    expect(flat).not.toContain(`Rs ${(variant.price / 100).toLocaleString('en')}`);
    // The footer's picker lists rupees and the shop's currencies, the shopper's picked.
    expect(flat).toContain('<option value="PKR">PKR · Pakistani rupee</option>');
    expect(flat).toContain('<option value="AED" selected>AED · UAE dirham</option>');
    expect(flat).toContain('<option value="GBP">GBP · British pound</option>');
    expect(flat).toContain(
      'Prices in AED are a guide, at 1 AED = Rs 76.4521. Checkout charges rupees.',
    );
    // A currency the shop doesn't show its prices in, or none, is rupees, and the suggestion.
    for (const currency of ['USD', null]) {
      const rupees = await renderer.render(
        { path: `/products/${product.handle}`, currency },
        shop.fresh(),
      );
      expect(rupees.html).toContain(`Rs ${(variant.price / 100).toLocaleString('en')}`);
      expect(rupees.html).toContain('<option value="PKR" selected>');
      expect(rupees.html).toContain(
        '<hatti-currency-suggest class="footer__currency-suggest" hidden>',
      );
    }
    // The cart says what checkout charges, in rupees.
    const cart: CartJson = {
      note: '',
      attributes: {},
      items: [
        {
          key: `${variant.id}:0123456789abcdef0123456789abcdef`,
          variantId: variant.id,
          productId: product.id,
          quantity: 1,
          properties: {},
          price: variant.price,
          linePrice: variant.price,
          title: product.title,
          variantTitle: variant.title,
          sku: null,
          grams: 0,
          taxable: true,
          taxCode: null,
          maxQuantity: null,
        },
      ],
      itemCount: 1,
      subtotal: variant.price,
      totalWeightGrams: 0,
      discount: null,
      totalDiscount: 0,
    };
    const cartPage = await renderer.render({ path: '/cart', currency: 'GBP', cart }, shop.fresh());
    expect(cartPage.html.replace(/\s+/g, ' ')).toContain(
      `You pay Rs ${(variant.price / 100).toLocaleString('en-IN')} at checkout. Prices in GBP are a guide.`,
    );
    // A shop showing rupees alone has no picker.
    const plain = await renderer.render(
      { path: `/products/${product.handle}`, currency: 'AED' },
      new MemoryStore(sample).fresh(),
    );
    expect(plain.html).not.toContain('<select id="FooterCurrency"');
  });

  it('says a product on pre-order is one, and the day it ships by, on its page, card and cart line (ADR-403)', async () => {
    const sample = sampleStore();
    const [first, ...rest] = sample.products;
    const variant = first!.variants[0]!;
    const preordered = {
      ...first!,
      preorderShipsOn: '2026-11-30',
      // Out of stock, but on pre-order it sells.
      variants: first!.variants.map((each) => ({ ...each, available: true })),
    };
    const shop = new MemoryStore({ ...sample, products: [preordered, ...rest] });
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const page = await renderer.render({ path: `/products/${preordered.handle}` }, shop.fresh());
    expect(page.html).toMatch(
      /<button type="submit" name="add" class="button"\s*>Pre-order<\/button>/,
    );
    expect(page.html).toContain(
      '<p class="product__preorder">Pre-order: ships by 30 November 2026</p>',
    );
    const listing = await renderer.render({ path: '/collections/all' }, shop.fresh());
    expect(count(listing.html, '<span class="badge badge--preorder">Pre-order</span>')).toBe(1);
    const cart = await renderer.render(
      {
        path: '/cart',
        cart: {
          note: '',
          attributes: {},
          items: [
            {
              key: `${variant.id}:0123456789abcdef0123456789abcdef`,
              variantId: variant.id,
              productId: preordered.id,
              quantity: 1,
              properties: {},
              price: variant.price,
              linePrice: variant.price,
              title: preordered.title,
              variantTitle: variant.title,
              sku: null,
              grams: 0,
              taxable: true,
              taxCode: null,
              maxQuantity: null,
              preorderShipsOn: '2026-11-30',
            },
          ],
          itemCount: 1,
          subtotal: variant.price,
          totalWeightGrams: 0,
          discount: null,
          totalDiscount: 0,
        },
      },
      shop.fresh(),
    );
    expect(cart.html).toContain(
      '<p class="cart-item__detail">Pre-order: ships by 30 November 2026</p>',
    );
    // A product not on pre-order says nothing of it.
    const plain = await renderer.render({ path: `/products/${rest[0]!.handle}` }, shop.fresh());
    expect(plain.html).not.toContain('class="product__preorder"');
    expect(plain.html).not.toMatch(/name="add" class="button"\s*>Pre-order/);
    // In Urdu too.
    const urdu = await renderer.render(
      { path: `/products/${preordered.handle}`, locale: 'ur' },
      shop.fresh(),
    );
    expect(urdu.html).toContain('پیشگی آرڈر');
  });

  it("gives themes an image's focal point, as Shopify's image.presentation, and keeps it in sight in image_tag (ADR-257)", async () => {
    const sample = sampleStore();
    const [first, ...rest] = sample.products;
    const [front, back] = first!.images;
    const pointed = {
      ...first!,
      images: [{ ...front!, focalPoint: { x: 25, y: 75.56 } }, back!],
    };
    const shop = new MemoryStore({ ...sample, products: [pointed, ...rest] });
    const theme = loadTheme({
      ...files,
      'sections/main-product.liquid':
        '{% for image in product.images limit: 2 %}<p class="focal">' +
        '{{ image.presentation.focal_point }}|{{ image.presentation.focal_point.x }}|' +
        "{{ image | image_url: width: 300 | image_tag: widths: '300' }}</p>{% endfor %}" +
        '{% schema %}{ "name": "Product" }{% endschema %}',
    });
    const renderer = new PageRenderer(theme, { limits: { timeMs: 10_000 } });
    const page = await renderer.render({ path: `/products/${pointed.handle}` }, shop.fresh());
    const [set, none] = [...page.html.matchAll(/<p class="focal">([^]*?)<\/p>/g)].map(
      (match) => match[1]!,
    );
    expect(set).toMatch(/^25% 75.56%\|25\|<img [^>]*style="object-position:25% 75.56%"[^>]*>$/);
    // None set: the middle, and nothing added to the tag.
    expect(none).toMatch(/^50% 50%\|50\|<img /);
    expect(none).not.toContain('object-position');
  });

  it("tells themes a product sold as a gift card is one, as Shopify's product.gift_card? (ADR-451)", async () => {
    const sample = sampleStore();
    const [first, ...rest] = sample.products;
    const card = { ...first!, giftCard: true as const };
    const shop = new MemoryStore({ ...sample, products: [card, ...rest] });
    const theme = loadTheme({
      ...files,
      'sections/main-product.liquid':
        '<p class="gift">{% if product.gift_card? %}gift card{% else %}goods{% endif %}</p>' +
        '{% schema %}{ "name": "Product" }{% endschema %}',
    });
    const renderer = new PageRenderer(theme, { limits: { timeMs: 10_000 } });
    const page = await renderer.render({ path: `/products/${card.handle}` }, shop.fresh());
    expect(page.html).toContain('<p class="gift">gift card</p>');
    const plain = await renderer.render({ path: `/products/${rest[0]!.handle}` }, shop.fresh());
    expect(plain.html).toContain('<p class="gift">goods</p>');
  });

  it("gives themes a product's eastern-wear attributes in the page's language, and Hatti Base says them (ADR-477)", async () => {
    const sample = sampleStore();
    const [first, ...rest] = sample.products;
    const suit = {
      ...first!,
      easternWear: {
        stitching: { value: 'unstitched', label: 'Unstitched', ur: 'ان سلا' },
        pieces: { value: '3', label: '3-piece', ur: '3 پیس' },
        fabrics: [
          { value: 'lawn', label: 'Lawn', ur: 'لان' },
          { value: 'chiffon', label: 'Chiffon', ur: 'شیفون' },
        ],
        season: { value: 'summer', label: 'Summer', ur: 'گرمیاں' },
      },
    };
    const shop = new MemoryStore({ ...sample, products: [suit, ...rest] });
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const page = await renderer.render({ path: `/products/${suit.handle}` }, shop.fresh());
    expect(page.html).toContain(
      '<p class="product__eastern-wear" dir="auto">Unstitched · 3-piece · Lawn, Chiffon · Summer</p>',
    );
    const urdu = await renderer.render(
      { path: `/products/${suit.handle}`, locale: 'ur' },
      shop.fresh(),
    );
    expect(urdu.html).toContain('ان سلا · 3 پیس · لان, شیفون · گرمیاں');
    // None said, no line.
    const plain = await renderer.render({ path: `/products/${rest[0]!.handle}` }, shop.fresh());
    expect(plain.html).not.toContain('class="product__eastern-wear"');

    // Each value and its words, and as metafields of Hatti's own namespace.
    const theme = loadTheme({
      ...files,
      'sections/main-product.liquid':
        '<p class="wear">{{ product.eastern_wear.stitching.value }}|{{ product.eastern_wear.pieces.value | plus: 0 }}|' +
        '{{ product.eastern_wear.fabrics | map: "value" | join: "," }}|' +
        '{{ product.metafields.hatti.fabric.value | join: "/" }}|{{ product.metafields.hatti.season.value }}</p>' +
        '{% schema %}{ "name": "Product" }{% endschema %}',
    });
    const custom = new PageRenderer(theme, { limits: { timeMs: 10_000 } });
    expect(
      (await custom.render({ path: `/products/${suit.handle}` }, shop.fresh())).html,
    ).toContain('<p class="wear">unstitched|3|lawn,chiffon|Lawn/Chiffon|Summer</p>');
  });

  it("gives themes products', variants' and collections' metafields of their types, as Shopify's (ADR-489)", async () => {
    const sample = sampleStore();
    const [first, ...rest] = sample.products;
    const [collection, ...others] = sample.collections;
    const kurta = {
      ...first!,
      metafields: {
        custom: {
          care: { type: 'single_line_text_field', value: 'Hand wash' },
          pieces: { type: 'number_integer', value: '3' },
          fabrics: { type: 'list.single_line_text_field', value: '["Lawn","Chiffon"]' },
          specs: { type: 'json', value: '{"weight":"350g"}' },
          lined: { type: 'boolean', value: 'false' },
        },
      },
      variants: first!.variants.map((variant, index) =>
        index === 0
          ? {
              ...variant,
              metafields: { custom: { length_in: { type: 'number_decimal', value: '42.5' } } },
            }
          : variant,
      ),
    };
    const eid = {
      ...collection!,
      metafields: { custom: { banner: { type: 'color', value: '#0f766e' } } },
    };
    const shop = new MemoryStore({
      ...sample,
      products: [kurta, ...rest],
      collections: [eid, ...others],
    });
    const theme = loadTheme({
      ...files,
      'sections/main-product.liquid':
        '<p class="fields">{{ product.metafields.custom.care }}|' +
        '{{ product.metafields.custom.pieces.value | plus: 1 }}|' +
        '{{ product.metafields.custom.fabrics.value | join: "/" }}|' +
        '{{ product.metafields.custom.specs.value.weight }}|' +
        '{% if product.metafields.custom.lined.value %}lined{% else %}unlined{% endif %}|' +
        '{{ product.metafields.custom.care.type }}|' +
        '{{ product.variants.first.metafields.custom.length_in.value | times: 2 }}|' +
        '{{ product.metafields.custom.missing.value | default: "none" }}</p>' +
        '{% schema %}{ "name": "Product" }{% endschema %}',
      'sections/main-collection.liquid':
        '<p class="banner">{{ collection.metafields.custom.banner.value }}</p>' +
        '{% schema %}{ "name": "Collection" }{% endschema %}',
    });
    const renderer = new PageRenderer(theme, { limits: { timeMs: 10_000 } });
    expect(
      (await renderer.render({ path: `/products/${kurta.handle}` }, shop.fresh())).html,
    ).toContain(
      '<p class="fields">Hand wash|4|Lawn/Chiffon|350g|unlined|single_line_text_field|85|none</p>',
    );
    expect(
      (await renderer.render({ path: `/collections/${eid.handle}` }, shop.fresh())).html,
    ).toContain('<p class="banner">#0f766e</p>');
  });

  it("gives themes a product's videos among its media, with Shopify's video filters, and Hatti Base plays them (ADR-258)", async () => {
    const sample = sampleStore();
    const [first, ...rest] = sample.products;
    const [front, back] = first!.images;
    const preview = (name: string, width: number, height: number) => ({
      src: `https://api.hatti.test/images/s1/${name}/kurta.jpg`,
      width,
      height,
      alt: null,
    });
    const filmed = {
      ...first!,
      images: [front!, back!],
      media: [
        { type: 'image' as const, image: 0 },
        {
          type: 'video' as const,
          id: 'm-video',
          alt: 'Kurta, turning',
          preview: preview('m-video', 1080, 1920),
          sources: [
            {
              src: 'https://api.hatti.test/videos/s1/m-video/kurta.mp4',
              mimeType: 'video/mp4',
              format: 'mp4',
              width: 1080,
              height: 1920,
            },
            // Its smaller copies (ADR-791).
            {
              src: 'https://api.hatti.test/videos/s1/m-video/720p/kurta.mp4',
              mimeType: 'video/mp4',
              format: 'mp4',
              width: 720,
              height: 1280,
            },
            {
              src: 'https://api.hatti.test/videos/s1/m-video/480p/kurta.mp4',
              mimeType: 'video/mp4',
              format: 'mp4',
              width: 480,
              height: 854,
            },
          ],
          durationMs: 12_000,
        },
        {
          type: 'external_video' as const,
          id: 'm-youtube',
          alt: null,
          preview: preview('m-youtube', 1280, 720),
          host: 'youtube' as const,
          externalId: 'dQw4w9WgXcQ',
        },
        { type: 'image' as const, image: 1 },
      ],
    };
    const shop = new MemoryStore({ ...sample, products: [filmed, ...rest] });
    const theme = loadTheme({
      ...files,
      'sections/main-product.liquid':
        '<p class="kinds">{{ product.media.size }}|{{ product.images.size }}|' +
        "{{ product.media | map: 'media_type' | join: ',' }}|{{ product.featured_media.media_type }}</p>" +
        '{% for media in product.media %}<p class="tag">{{ media | media_tag: image_size: \'540x\' }}</p>{% endfor %}' +
        '<p class="video">{{ product.media[1].duration }}|{{ product.media[1].sources[0].url }}|' +
        '{{ product.media[1].preview_image.width }}|{{ product.media[1].aspect_ratio }}</p>' +
        '<p class="url">{{ product.media[2] | external_video_url: color: \'white\', autoplay: true }}|' +
        '{{ product.media[2].host }}|{{ product.media[2].external_id }}</p>' +
        '{% schema %}{ "name": "Product" }{% endschema %}',
    });
    const renderer = new PageRenderer(theme, { limits: { timeMs: 10_000 } });
    const page = await renderer.render({ path: `/products/${filmed.handle}` }, shop.fresh());
    const text = (name: string) =>
      [...page.html.matchAll(new RegExp(`<p class="${name}">([^]*?)</p>`, 'g'))].map(
        (match) => match[1]!,
      );
    expect(text('kinds')).toEqual(['4|2|image,video,external_video,image|image']);
    const [, video, youtube] = text('tag');
    expect(video).toBe(
      '<video playsinline="playsinline" controls="controls" preload="metadata" ' +
        'poster="https://api.hatti.test/images/s1/m-video/kurta.jpg?width=540" ' +
        'aria-label="Kurta, turning">' +
        // The smallest copy for phones, then the next, then the original (ADR-791).
        '<source src="https://api.hatti.test/videos/s1/m-video/480p/kurta.mp4" type="video/mp4" ' +
        'media="(max-width: 767px)">' +
        '<source src="https://api.hatti.test/videos/s1/m-video/720p/kurta.mp4" type="video/mp4" ' +
        'media="(max-width: 1279px)">' +
        '<source src="https://api.hatti.test/videos/s1/m-video/kurta.mp4" ' +
        'type="video/mp4"><img src="https://api.hatti.test/images/s1/m-video/kurta.jpg?width=540" ' +
        'alt="Kurta, turning"></video>',
    );
    expect(youtube).toBe(
      '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ?enablejsapi=1&amp;playsinline=1&amp;rel=0" ' +
        'title="" loading="lazy" frameborder="0" ' +
        'allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" ' +
        'allowfullscreen="allowfullscreen"></iframe>',
    );
    expect(text('video')).toEqual([
      '12000|https://api.hatti.test/videos/s1/m-video/kurta.mp4|1080|0.563',
    ]);
    expect(text('url')).toEqual([
      'https://www.youtube.com/embed/dQw4w9WgXcQ?enablejsapi=1&playsinline=1&rel=0&color=white&autoplay=1|youtube|dQw4w9WgXcQ',
    ]);

    // Hatti Base's gallery: the video in its place, YouTube's player, the images around them.
    const based = await new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } }).render(
      { path: `/products/${filmed.handle}` },
      shop.fresh(),
    );
    expect(count(based.html, '<li><img')).toBe(2);
    expect(based.html).toContain('<li><video playsinline="playsinline"');
    expect(based.html).toContain(
      'poster="https://api.hatti.test/images/s1/m-video/kurta.jpg?width=1100"',
    );
    expect(based.html).toMatch(
      /<div class="product__embed" style="--ratio: 1\.778">\s*<iframe src="https:\/\/www\.youtube\.com\/embed\/dQw4w9WgXcQ\?/,
    );
  });

  it('renders what a search found, a page at a time, its links keeping the words', async () => {
    const ids = sampleStore().products.map((product) => product.id);
    const found = await render({
      path: '/search',
      query: { q: 'lawn', page: '2' },
      search: { terms: 'lawn', productIds: ids.slice(0, 30) },
    });
    expect(found.status).toBe(200);
    expect(found.html).toContain('<title>Search · Zari Fashions</title>');
    expect(found.html).toContain('value="lawn"');
    expect(found.html).toContain('30 results for “lawn”');
    // 24 a page: the second has the last 6, and links back keep the words.
    expect(count(found.html, 'class="grid__item"')).toBe(6);
    expect(found.html).toContain('<a href="?q=lawn&amp;page=1">');
    expect(found.roundTrips).toBeLessThanOrEqual(4);

    // What the shopper typed is text on the page, however it is written.
    const typed = '<script>steal()</script>';
    const none = await render({ path: '/search', search: { terms: typed, productIds: [] } });
    expect(none.html).toContain('Nothing matches “&lt;script&gt;steal()&lt;/script&gt;”');
    expect(none.html).toContain('value="&lt;script&gt;steal()&lt;/script&gt;"');
    expect(none.html).not.toContain('<script>steal()');
    expect(none.html).toContain('href="/collections/all"');
    // Without words, the page asks for some.
    const empty = await render({ path: '/search' });
    expect(empty.html).toContain('name="q"');
    expect(empty.html).not.toContain('class="search__count"');
    const urdu = await render({
      path: '/search',
      locale: 'ur',
      search: { terms: 'lawn', productIds: ids.slice(0, 1) },
    });
    expect(urdu.html).toContain('“lawn” کے لیے 1 نتیجہ');
  });

  it("offers search by photo where the search section's setting asks (SRC-07, ADR-870)", async () => {
    // Off by default: no button, no script.
    const plain = await render({ path: '/search' });
    expect(plain.html).not.toContain('<hatti-photo-search');
    const theme = loadTheme({
      ...files,
      'templates/search.json': JSON.stringify({
        sections: { main: { type: 'main-search', settings: { photo_search: true } } },
        order: ['main'],
      }),
    });
    const renderer = new PageRenderer(theme, { limits: { timeMs: 10_000 } });
    const store = new MemoryStore(sampleStore());
    const page = await renderer.render({ path: '/search' }, store.fresh());
    expect(page.status).toBe(200);
    expect(page.html).toContain(
      '<hatti-photo-search class="search__photo" data-url="/search/photo"',
    );
    expect(page.html).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(page.html).toContain('Search with a photo');
    expect(page.html).toContain("customElements.define('hatti-photo-search'");
    // In Urdu, to the Urdu address, which answers in Urdu.
    const urdu = await renderer.render({ path: '/search', locale: 'ur' }, store.fresh());
    expect(urdu.html).toContain('data-url="/ur/search/photo"');
    expect(urdu.html).toContain('تصویر سے تلاش کریں');
  });

  it('sorts a collection and filters a search, as Shopify does (ADR-479)', async () => {
    const lawn = sampleStore().products.filter((each) => each.id.startsWith('p-eid-lawn-'));
    const cheapest = [...lawn].sort(
      (a, b) =>
        Math.min(...a.variants.map((variant) => variant.price)) -
        Math.min(...b.variants.map((variant) => variant.price)),
    )[0]!;
    const sorted = await render({
      path: '/collections/eid-lawn',
      query: { sort_by: 'price-ascending' },
    });
    expect(sorted.errors).toEqual([]);
    expect(sorted.html).toMatch(/<option value="price-ascending" selected>Price, low to high</);
    const firstCard = /href="\/products\/([^"?]+)/.exec(
      sorted.html.slice(sorted.html.indexOf('class="grid"')),
    )![1];
    expect(firstCard).toBe(cheapest.handle);
    // Its pages' links keep the order.
    expect(sorted.html).toContain('href="?sort_by=price-ascending&amp;page=2"');

    const ids = sampleStore().products.map((product) => product.id);
    const search = { terms: 'lawn', productIds: ids.slice(0, 100), pageIds: [] as string[] };
    const all = await render({ path: '/search', query: { q: 'lawn' }, search });
    expect(all.html).toContain('<option value="relevance" selected>Relevance</option>');
    expect(all.html).toContain('name="filter.p.product_type" value="Footwear"');
    expect(all.html).toContain('<input type="hidden" name="q" value="lawn">');
    const params: [string, string][] = [
      ['q', 'lawn'],
      ['filter.p.product_type', 'Footwear'],
    ];
    const footwear = await render({
      path: '/search',
      query: Object.fromEntries(params),
      params,
      search,
    });
    expect(footwear.errors).toEqual([]);
    const khussas = ids.slice(0, 100).filter((id) => id.startsWith('p-khussa-')).length;
    expect(footwear.html).toContain(`${khussas} results for “lawn”`);
    expect(footwear.html).toContain('href="/search?q=lawn">Clear all</a>');
  });

  it("renders the predictive search section alone, as Shopify's section rendering API does", async () => {
    const sample = sampleStore();
    const [first, second, third] = sample.products as [ProductDoc, ProductDoc, ProductDoc];
    // The first product found cannot be bought.
    const soldOut = { ...first, variants: first.variants.map((v) => ({ ...v, available: false })) };
    const shop = new MemoryStore({ ...sample, products: [soldOut, ...sample.products.slice(1)] });
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const found = [first.id, second.id, third.id];
    const suggest = (q: string, options: Record<string, string> = {}, productIds = found) => ({
      path: '/search',
      suggest: {
        params: suggestParams(new URLSearchParams({ q, 'resources[limit]': '2', ...options })),
        productIds,
      },
    });
    const links = (html: string) =>
      [...html.matchAll(/href="\/products\/([\w-]+)"/g)].map((match) => match[1]);

    const data = shop.fresh();
    const sections = await renderer.sections(suggest('lawn'), data, [
      'predictive-search',
      'header-group__header',
      'main',
      'nothing',
    ]);
    const html = sections.get('predictive-search')!;
    expect(html).toMatch(/^<div id="hatti-section-predictive-search" class="hatti-section/);
    // Two asked for, and the sold out one goes last: out of the two.
    expect(links(html)).toEqual([second.handle, third.handle]);
    expect(html).toContain('role="option"');
    expect(html).toContain('href="/search?q=lawn&amp;options%5Bprefix%5D=last"');
    expect(html).toContain('Search for “lawn”');
    // The shop, the products found, once, and the header's menu.
    expect(data.roundTrips).toBe(3);
    // Sections of the page by their IDs, and nothing for one it does not have.
    expect(sections.get('header-group__header')).toContain(
      '<hatti-search class="search-panel" data-url="/search/suggest">',
    );
    expect(sections.get('main')).toContain('class="search__form"');
    expect(sections.get('nothing')).toBeNull();

    // Shown where they fall, or left out.
    const shown = await renderer.sections(
      suggest('lawn', { 'resources[options][unavailable_products]': 'show' }),
      shop.fresh(),
      ['predictive-search'],
    );
    expect(links(shown.get('predictive-search')!)).toEqual([first.handle, second.handle]);
    const hidden = await renderer.sections(
      suggest('lawn', {
        'resources[limit]': '5',
        'resources[options][unavailable_products]': 'hide',
      }),
      shop.fresh(),
      ['predictive-search'],
    );
    expect(links(hidden.get('predictive-search')!)).toEqual([second.handle, third.handle]);

    // Nothing found, what was typed escaped; nothing typed, nothing shown; in Urdu.
    const none = await renderer.sections(suggest('<b>zz</b>', {}, []), shop.fresh(), [
      'predictive-search',
    ]);
    expect(none.get('predictive-search')).toContain(
      'Nothing matches “&lt;b&gt;zz&lt;/b&gt;” yet. Search anyway',
    );
    const blank = await renderer.sections(suggest(''), shop.fresh(), ['predictive-search']);
    expect(blank.get('predictive-search')).not.toContain('<ul');
    const urdu = await renderer.sections({ ...suggest('lawn'), locale: 'ur' }, shop.fresh(), [
      'predictive-search',
    ]);
    expect(urdu.get('predictive-search')).toContain('href="/ur/search?q=lawn&amp;');
    expect(urdu.get('predictive-search')).toContain('“lawn” تلاش کریں');
  });

  it('puts an empty cart drawer on every page, unless the theme sends shoppers to the cart page', async () => {
    const home = await render({ path: '/' });
    expect(home.html).toMatch(/<cart-drawer\s+data-section="cart-drawer"\s+data-url="\/"/);
    expect(home.html).toMatch(/data-body>\s*<p>Your cart is empty\.<\/p>/);
    // Its script opens it from the header's cart link.
    expect(home.html).toContain('class="header__cart" data-cart-link>');
    const settings = JSON.stringify({ current: { cart_type: 'page' } });
    const toPage = await render(
      { path: '/' },
      { extra: { 'config/settings_data.json': settings } },
    );
    expect(toPage.html).not.toContain('<cart-drawer');
  });

  it('renders a page in the template it names, and gives themes pages by handle', async () => {
    const documents = sampleStore();
    const faq = {
      id: 'pg-faq',
      handle: 'faq',
      title: 'Questions',
      bodyHtml: '<p>How long does delivery take?</p>',
      templateSuffix: 'faq',
      publishedAt: '2026-09-01T09:00:00.000Z',
    };
    const shop = new MemoryStore({ ...documents, pages: [...documents.pages!, faq] });
    const theme = loadTheme({
      ...files,
      'templates/page.faq.json': JSON.stringify({
        sections: { main: { type: 'main-page' }, also: { type: 'more-pages' } },
        order: ['main', 'also'],
      }),
      'sections/more-pages.liquid':
        '<p class="more">{{ template.name }}.{{ template.suffix }}: {{ pages[\'delivery\'].title }} ' +
        "{{ pages['delivery'].url }} [{{ pages['nothing'].title }}]</p>" +
        '{% schema %}{ "name": "More pages" }{% endschema %}',
    });
    const renderer = new PageRenderer(theme, { limits: { timeMs: 10_000 } });
    const named = await renderer.render({ path: '/pages/faq' }, shop.fresh());
    expect(named.html).toContain('<p>How long does delivery take?</p>');
    expect(named.html).toContain('<p class="more">page.faq: Delivery /pages/delivery []</p>');
    // Pages that name no template, or one the theme lacks, have page.json.
    const plain = await renderer.render({ path: '/pages/delivery' }, shop.fresh());
    expect(plain.html).not.toContain('class="more"');
    const missing = new MemoryStore({
      ...documents,
      pages: [{ ...faq, templateSuffix: 'gone' }],
    });
    const fallback = await renderer.render({ path: '/pages/faq' }, missing.fresh());
    expect([fallback.status, fallback.html.includes('class="more"')]).toEqual([200, false]);
  });

  it('gives each card a heart for the wishlist, renders a card alone, and the wishlist and recently viewed (ADR-418)', async () => {
    const documents = sampleStore();
    const wishlist = {
      id: 'pg-wishlist',
      handle: 'wishlist',
      title: 'Wishlist',
      bodyHtml: '',
      templateSuffix: 'wishlist',
      publishedAt: '2026-09-01T09:00:00.000Z',
    };
    const shop = new MemoryStore({ ...documents, pages: [...documents.pages!, wishlist] });
    const header = JSON.parse(files['sections/header-group.json']!) as SectionList;
    const theme = loadTheme({
      ...files,
      'sections/header-group.json': JSON.stringify({
        ...header,
        sections: {
          ...header.sections,
          header: { ...header.sections.header, settings: { wishlist: true } },
        },
      }),
    });
    const renderer = new PageRenderer(theme, { limits: { timeMs: 10_000 } });
    const { handle, title } = documents.products[0]!;

    // A product's page: its heart, hidden until the script shows it, and recently viewed after it.
    const product = await renderer.render({ path: `/products/${handle}` }, shop.fresh());
    expect(product.html).toMatch(
      new RegExp(`class="wishlist-button"\\s+data-wishlist="${handle}"`),
    );
    expect(product.html).toContain(`aria-label="Save ${title} to your wishlist"`);
    expect(product.html).toMatch(new RegExp(`<hatti-recently-viewed[^>]*data-product="${handle}"`));
    expect(product.html).toContain('<a href="/pages/wishlist" class="header__wishlist">');

    // A card alone, as the wishlist asks for it, in the shopper's language.
    const cards = await renderer.sections(
      { path: `/products/${handle}`, locale: 'ur' },
      shop.fresh(),
      ['product-card'],
    );
    const card = cards.get('product-card')!;
    expect(card).toContain('<div class="card">');
    expect(card).toContain(`data-wishlist="${handle}"`);
    expect(card).toContain('اپنی پسندیدہ فہرست میں رکھیں');

    // The wishlist's own page, empty until the script fills it.
    const page = await renderer.render({ path: '/pages/wishlist' }, shop.fresh());
    expect(page.html).toContain('<hatti-wishlist>');
    expect(page.html).toContain('Nothing saved yet. Tap the heart on a product to keep it here.');
    const urdu = await renderer.render({ path: '/pages/wishlist', locale: 'ur' }, shop.fresh());
    expect(urdu.html).toContain('<a href="/ur/pages/wishlist" class="header__wishlist">');
  });

  it('leaves out a section that goes over a limit or fails, and renders the rest', async () => {
    const extra = {
      'sections/loop.liquid':
        '{% for i in (1..400) %}{% for j in (1..400) %}x{% endfor %}{% endfor %}',
      'sections/output.liquid':
        "{% assign s = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' %}" +
        '{% for i in (1..3000) %}{{ s }}{{ s }}{{ s }}{{ s }}{{ s }}{{ s }}{{ s }}{{ s }}{{ s }}{{ s }}{% endfor %}',
      'sections/recursion.liquid': "{% render 'again' %}",
      'snippets/again.liquid': "{% render 'again' %}",
      'sections/memory.liquid': '{% for i in (1..10000000) %}{% break %}{% endfor %}',
      'sections/broken.liquid': '{{ product.title | nonsense }}',
      'templates/index.json': JSON.stringify({
        sections: {
          loop: { type: 'loop' },
          output: { type: 'output' },
          recursion: { type: 'recursion' },
          memory: { type: 'memory' },
          broken: { type: 'broken' },
          ok: { type: 'whatsapp-cta' },
        },
        order: ['loop', 'output', 'recursion', 'memory', 'broken', 'ok'],
      }),
    };
    // Time enough for each to reach its own limit: side by side, they share one thread's time.
    const page = await render({ path: '/' }, { extra, limits: { timeMs: 10_000 } });
    expect(page.status).toBe(200);
    const failed = Object.fromEntries(
      page.renders.filter((stat) => stat.error).map((stat) => [stat.id, stat.error]),
    );
    expect(failed).toEqual({
      loop: 'nodes',
      output: 'output',
      recursion: 'depth',
      memory: 'memory',
      broken: 'error',
    });
    expect(page.html).toContain('<!-- loop: not shown -->');
    expect(page.html).toContain('Questions? Ask us on WhatsApp');
    expect(page.html).toContain('id="hatti-section-footer-group__footer"');
    expect(page.errors.map((error) => error.render.id).sort()).toEqual(
      ['broken', 'loop', 'memory', 'output', 'recursion'].sort(),
    );
  });

  it('gives each section its time, data it waits for included', async () => {
    // Data takes longer than a section's time; a section's own work, far less, even on a busy
    // machine, where sections rendered side by side share one thread.
    const page = await render({ path: '/' }, { latencyMs: 400, limits: { timeMs: 200 } });
    const failed = page.renders.filter((stat) => stat.error === 'time').map((stat) => stat.id);
    // Sections waiting on menus or products run out of time; those that wait for nothing do not.
    expect(failed).toEqual(
      expect.arrayContaining(['header-group__header', 'lawn', 'khussa', 'kurta']),
    );
    expect(page.renders.find((stat) => stat.id === 'banner')?.error).toBeNull();
    expect(page.html).toContain('Eid Lawn &#39;26');
  });

  it('escapes what shops and shoppers typed in theme strings and the title, keeping WhatsApp messages text', async () => {
    const documents = sampleStore();
    const product = documents.products[0]!;
    const risky = {
      ...product,
      title: 'Lawn & Silk </title><script>steal()</script>',
    };
    const productTemplate = JSON.parse(files['templates/product.json']!) as SectionList;
    const shop = new MemoryStore({
      ...documents,
      shop: { ...documents.shop, name: 'Zari <b>Fashions</b>' },
      products: [risky, ...documents.products.slice(1)],
    });
    const theme = loadTheme({
      ...files,
      'locales/en.default.json': JSON.stringify({
        ...JSON.parse(files['locales/en.default.json']!),
        test: { plain: 'Say <b>{{ what }}</b>', rich_html: 'Say <b>{{ what }}</b>' },
      }),
      'sections/strings.liquid':
        '<p class="plain">{{ \'test.plain\' | t: what: product.title }}</p>' +
        '<p class="rich">{{ \'test.rich_html\' | t: what: product.title }}</p>' +
        '{% schema %}{ "name": "Strings" }{% endschema %}',
      'templates/product.json': JSON.stringify({
        ...productTemplate,
        sections: { ...productTemplate.sections, strings: { type: 'strings' } },
        order: [...productTemplate.order, 'strings'],
      }),
    });
    const renderer = new PageRenderer(theme, { limits: { timeMs: 10_000 } });
    const page = await renderer.render({ path: `/products/${product.handle}` }, shop.fresh());
    expect(page.html).not.toContain('<script>steal()');
    expect(page.html).toContain(
      '<title>Lawn &amp; Silk &lt;/title&gt;&lt;script&gt;steal()&lt;/script&gt; · Zari &lt;b&gt;Fashions&lt;/b&gt;</title>',
    );
    // A string is text unless its key ends in _html; what fills it is escaped either way.
    expect(page.html).toContain(
      '<p class="plain">Say &lt;b&gt;Lawn &amp; Silk &lt;/title&gt;&lt;script&gt;steal()&lt;/script&gt;&lt;/b&gt;</p>',
    );
    expect(page.html).toContain(
      '<p class="rich">Say <b>Lawn &amp; Silk &lt;/title&gt;&lt;script&gt;steal()&lt;/script&gt;</b></p>',
    );
    expect(page.html).toContain('© ');
    expect(page.html).not.toContain('<b>Fashions</b>');
    // The order message goes to WhatsApp as the text it is.
    expect(page.html).toContain(
      encodeURIComponent("Hi! I'd like to order Lawn & Silk </title><script>steal()</script>"),
    );
  });

  it("gives themes the shop's brand, its logos as images, and Hatti Base's header its logo (ADR-207)", async () => {
    const logo = 'https://api.hatti.pk/logos/s1?v=0a1b2c3d';
    const square = 'https://api.hatti.pk/logos/s1/square?v=4e5f6a7b';
    const sample = sampleStore();
    const home = async (brand: ShopDoc['brand'], extra: ThemeFiles = {}) => {
      const renderer = new PageRenderer(loadTheme({ ...files, ...extra }), {
        limits: { timeMs: 10_000 },
      });
      const shop = { ...sample.shop, ...(brand && { brand }) };
      const page = await renderer.render(
        { path: '/' },
        new MemoryStore({ ...sample, shop }).fresh(0),
      );
      return page.html;
    };
    const probe = {
      'sections/probe.liquid':
        '[{{ shop.brand.logo }}|{{ shop.brand.logo | image_url: width: 200 }}|' +
        '{{ shop.brand.square_logo }}|{{ shop.brand.slogan }}]',
      'templates/index.json': JSON.stringify({
        sections: { probe: { type: 'probe' } },
        order: ['probe'],
        layout: false,
      }),
    };
    expect(await home({ logo, squareLogo: square }, probe)).toContain(
      `[${logo}|${logo}&width=200|${square}|]`,
    );
    expect(await home({ logo, squareLogo: null }, probe)).toContain(
      `[${logo}|${logo}&width=200||]`,
    );
    expect(await home(undefined, probe)).toContain('[|||]');
    // Hatti Base's header shows the logo, else the shop's name.
    expect(await home({ logo, squareLogo: null })).toContain(
      `<a href="/" class="header__logo"><img src="${logo}&width=400" alt="Zari Fashions" ` +
        'class="header__logo-image"></a>',
    );
    expect(await home(undefined)).toContain('<a href="/" class="header__logo">Zari Fashions</a>');
  });

  it("puts what each of the shop's pictures holds in its address, so a file replaced is fetched afresh (ADR-670)", async () => {
    const SHOWN = 'file_01k7c3d3t0pqrxwzw8x9a2b4c5';
    const OTHER = 'file_01k7c3d3t0pqrxwzw8x9a2b4c6';
    const sample = sampleStore();
    const home = async (pictures?: Record<string, string>) => {
      const probe = {
        'sections/probe.liquid':
          '[{{ section.settings.image }}|{{ section.settings.image | image_url: width: 300 }}]' +
          '{% schema %}{"name":"Probe","settings":[{"type":"image_picker","id":"image"}]}{% endschema %}',
        'templates/index.json': JSON.stringify({
          sections: {
            a: { type: 'probe', settings: { image: `/theme-images/${SHOWN}/Eid.jpg` } },
            b: { type: 'probe', settings: { image: `/theme-images/${OTHER}` } },
            c: { type: 'probe', settings: { image: 'https://cdn.example.pk/eid.jpg' } },
          },
          order: ['a', 'b', 'c'],
          layout: false,
        }),
      };
      const renderer = new PageRenderer(loadTheme({ ...files, ...probe }), {
        limits: { timeMs: 10_000 },
      });
      const theme = { id: 'th1', version: 1, ...(pictures && { pictures }) };
      const shop = { ...sample.shop, theme };
      const page = await renderer.render(
        { path: '/' },
        new MemoryStore({ ...sample, shop }).fresh(0),
      );
      return page.html;
    };
    const html = await home({ [SHOWN]: '0a1b2c3d' });
    expect(html).toContain(
      `[/theme-images/${SHOWN}/Eid.jpg?v=0a1b2c3d|/theme-images/${SHOWN}/Eid.jpg?v=0a1b2c3d&width=300]`,
    );
    // One whose file it names no version of, and another's address, as they are.
    expect(html).toContain(`[/theme-images/${OTHER}|/theme-images/${OTHER}?width=300]`);
    expect(html).toContain(
      '[https://cdn.example.pk/eid.jpg|https://cdn.example.pk/eid.jpg?width=300]',
    );
    // A document written before names none.
    expect(await home()).toContain(`[/theme-images/${SHOWN}/Eid.jpg|`);
  });

  it('lets templates reach only what they are given', async () => {
    const extra = {
      'sections/probe.liquid':
        'A[{{ product.constructor }}]B[{{ section.settings.__proto__ }}]' +
        'C[{{ shop.constructor.name }}]D[{{ product.variants.first.constructor }}]' +
        'E[{{ settings.hasOwnProperty }}]F[{% render "../layout/theme" %}]',
      'templates/product.json': JSON.stringify({
        sections: { probe: { type: 'probe' } },
        order: ['probe'],
        layout: false,
      }),
    };
    const page = await render({ path: '/products/bridal-lehenga-heavy' }, { extra });
    // Nothing of JavaScript's objects, and no file outside snippets/.
    expect(page.html).toBe('<!-- probe: not shown -->');
    expect(page.errors[0]?.message).toMatch(/theme has no snippets\/\.\.\/layout|not find|ENOENT/i);
    const safe = await render(
      { path: '/products/bridal-lehenga-heavy' },
      {
        extra: {
          ...extra,
          'sections/probe.liquid':
            'A[{{ product.constructor }}]B[{{ section.settings.__proto__ }}]' +
            'C[{{ shop.constructor.name }}]D[{{ product.variants.first.constructor }}]' +
            'E[{{ settings.hasOwnProperty }}]',
        },
      },
    );
    expect(safe.html).toContain('A[]B[]C[]D[]E[]');
  });

  it('refuses a theme with a misspelled filter or broken JSON when it is published', async () => {
    const renderer = new PageRenderer(
      loadTheme({ ...files, 'sections/typo.liquid': '{{ product.price | mony }}' }),
    );
    expect(renderer.check()).toEqual([
      { file: 'sections/typo.liquid', message: expect.stringMatching(/undefined filter: mony/) },
    ]);
    expect(() => loadTheme({ ...files, 'locales/ur.json': '{ "general": ' })).toThrow(ThemeError);
    expect(() =>
      loadTheme({ ...files, 'sections/bad.liquid': '{% schema %}{ nope }{% endschema %}' }),
    ).toThrow(/sections\/bad\.liquid: is not valid JSON/);
  });

  it("renders a shop's own templates, section groups and settings over Hatti Base", async () => {
    const base = loadTheme(files);
    const home = JSON.parse(files['templates/index.json']!) as SectionList;
    const header = JSON.parse(files['sections/header-group.json']!) as SectionList;
    const heading = { type: 'heading', settings: { heading: 'Winter Sale' } };
    const own: ThemeFiles = {
      'templates/index.json': JSON.stringify({
        sections: {
          banner: { ...home.sections.banner, blocks: { heading }, block_order: ['heading'] },
          khussa: home.sections.khussa,
        },
        order: ['khussa', 'banner'],
      }),
      'sections/header-group.json': JSON.stringify({
        ...header,
        sections: {
          ...header.sections,
          announcement: { type: 'announcement-bar', settings: { text: '20% off all winter' } },
        },
      }),
      'config/settings_data.json': JSON.stringify({ current: { color_accent: '#B91C1C' } }),
      // Left out: a file that is not a shop's to change, JSON that does not parse, and a section
      // Hatti Base does not have.
      'layout/theme.liquid': '<main>{{ content_for_layout }}</main>',
      'templates/collection.json': '{ "sections": ',
      'templates/product.json': JSON.stringify({
        sections: { x: { type: 'reviews' } },
        order: ['x'],
      }),
    };
    const rejected: ThemeError[] = [];
    const theme = overlayTheme(base, own, (error) => rejected.push(error));
    expect(rejected.map((error) => error.file)).toEqual([
      'layout/theme.liquid',
      'templates/collection.json',
      'templates/product.json',
    ]);
    expect(rejected[2]!.message).toMatch(
      /section "x" is a "reviews", which the theme does not have/,
    );
    // A version of its own, the same for the same files.
    expect(theme.version).not.toBe(base.version);
    expect(overlayTheme(base, own).version).toBe(theme.version);

    const renderer = new PageRenderer(base, { limits: { timeMs: 10_000 } });
    const page = await renderer.render({ path: '/' }, store.fresh(), () => theme);
    const order = [...page.html.matchAll(/id="hatti-section-([\w-]+)"/g)].map((match) => match[1]);
    expect(order).toEqual([
      'header-group__announcement',
      'header-group__header',
      'khussa',
      'banner',
      'footer-group__footer',
      'cart-drawer',
    ]);
    expect(page.html).toMatch(/<h1 class="banner__heading" dir="auto" ?>Winter Sale<\/h1>/);
    expect(page.html).toContain('20% off all winter');
    // The settings it sets, and the platform theme's defaults for the rest.
    expect(page.html).toContain('--color-accent: #B91C1C;');
    expect(page.html).toContain('--page-width: 1200px;');
    // Pages it left alone, or whose file it broke, are the platform theme's.
    const product = await renderer.render(
      { path: `/products/${sampleStore().products[0]!.handle}` },
      store.fresh(),
      () => theme,
    );
    expect(product.status).toBe(200);
    expect(product.html).toContain('<h1 class="product__title" dir="auto">');
    expect(product.html).not.toContain('<main>');
  });

  it('sends the head while the sections wait for their data, then the rest as a whole page', async () => {
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    // The shop's document at once; everything sections fetch only once let through.
    const memory = new MemoryStore(sampleStore());
    let letThrough = () => {};
    const gate = new Promise<void>((resolve) => (letThrough = resolve));
    const held =
      <T>(fetch: () => Promise<T>) =>
      async () => {
        await gate;
        return fetch();
      };
    const store: StoreData = {
      shop: () => memory.shop(),
      theme: () => memory.theme(),
      experimentTheme: () => memory.experimentTheme(),
      productByHandle: (handle) => held(() => memory.productByHandle(handle))(),
      products: (ids) => held(() => memory.products(ids))(),
      collectionByHandle: (handle) => held(() => memory.collectionByHandle(handle))(),
      menu: (handle) => held(() => memory.menu(handle))(),
      pageByHandle: (handle) => held(() => memory.pageByHandle(handle))(),
      pages: (ids) => held(() => memory.pages(ids))(),
      blogByHandle: (handle) => held(() => memory.blogByHandle(handle))(),
      articleByHandle: (handle) => held(() => memory.articleByHandle(handle))(),
      articles: (ids) => held(() => memory.articles(ids))(),
      redirect: (path) => memory.redirect(path),
      policy: (type) => memory.policy(type),
      handles: (kind) => memory.handles(kind),
      sitemap: (kind) => memory.sitemap(kind),
      productIds: () => memory.productIds(),
    };
    const page = await renderer.stream({ path: '/' }, store);
    expect(page.status).toBe(200);
    const reading = page.body[Symbol.asyncIterator]();
    let head = '';
    while (!head.includes('</head>')) {
      const next = await reading.next();
      if (next.done) break;
      head += next.value;
    }
    expect(head).toContain('<style data-hatti-sections>');
    expect(head).not.toContain('hatti-section-');
    letThrough();
    let rest = '';
    for (let next = await reading.next(); !next.done; next = await reading.next()) {
      rest += next.value;
    }
    const whole = await renderer.render({ path: '/' }, memory.fresh());
    expect(head + rest).toBe(whole.html);
    expect((await page.done).renders.at(-1)).toMatchObject({ id: 'layout/theme', error: null });
  });

  it('knows what a page will be before it renders, and renders nothing until it streams', async () => {
    const sample = sampleStore();
    const own = new MemoryStore({ ...sample, shop: { ...sample.shop, domain: 'www.zari.pk' } });
    // As the other tests, a budget no machine's load runs out of: the page is cut short past it.
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const data = own.fresh();
    const ready = await renderer.prepare({ path: '/products/bridal-lehenga-heavy' }, data);
    expect(ready).toMatchObject({ status: 200, domain: 'www.zari.pk' });
    expect(ready.named).toContainEqual({ kind: 'product', handle: 'bridal-lehenga-heavy' });
    // The shop and the product: the header's menus wait for the render.
    expect(data.roundTrips).toBe(2);
    let html = '';
    for await (const chunk of ready.stream().body) html += chunk;
    expect(html).toMatch(/<\/html>\s*$/);
    expect(data.roundTrips).toBe(4);
  });

  it('marks sections and blocks for the theme editor in its frame, with its script, and nothing elsewhere', async () => {
    /** The JSON an attribute holds, in the order the page has them. */
    const marks = (html: string, name: string) =>
      [...html.matchAll(new RegExp(`${name}="([^"]*)"`, 'g'))].map((match) =>
        JSON.parse(match[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&')),
      );
    const editor = { origins: ['https://admin.hatti.pk'] };
    const home = (await render({ path: '/', editor })).html;
    const sections = marks(home, 'data-hatti-editor-section');
    expect(sections.map((section) => section.id)).toEqual([
      'header-group__announcement',
      'header-group__header',
      'banner',
      'lawn',
      'khussa',
      'kurta',
      'newsletter',
      'whatsapp',
      'footer-group__footer',
      'cart-drawer',
    ]);
    // Where each one's settings are kept: a section group, the page's template, or the settings.
    expect(sections[0]).toEqual({
      id: 'header-group__announcement',
      type: 'announcement-bar',
      file: 'sections/header-group.json',
      key: 'announcement',
    });
    expect(sections[2]).toMatchObject({ file: 'templates/index.json', key: 'banner' });
    expect(sections[9]).toMatchObject({ file: 'config/settings_data.json', key: 'cart-drawer' });
    expect(marks(home, 'data-hatti-editor-block')).toContainEqual({
      id: 'heading',
      type: 'heading',
    });
    expect(marks(home, 'data-hatti-editor')).toEqual([
      { origins: ['https://admin.hatti.pk'], template: 'templates/index.json' },
    ]);
    expect(home).toContain('window.Shopify.designMode = true');
    // Where each template's and section group's sections start, for its script to order them.
    expect([...home.matchAll(/<!--hatti-editor-list ([^>]*)-->/g)].map((mark) => mark[1])).toEqual([
      'sections/header-group.json',
      'templates/index.json',
      'sections/footer-group.json',
    ]);
    const product = (await render({ path: '/products/bridal-lehenga-heavy', editor })).html;
    expect(marks(product, 'data-hatti-editor-block').map((block) => block.id)).toEqual([
      'title',
      'price',
      'buy',
      'delivery',
      'description',
    ]);
    expect(marks(product, 'data-hatti-editor')[0].template).toBe('templates/product.json');

    // Liquid's request.design_mode, for themes that show more in the editor.
    const probe = {
      'sections/probe.liquid':
        '<p>design mode: {{ request.design_mode }}</p>{% schema %}{"name":"Probe"}{% endschema %}',
      'templates/index.json': JSON.stringify({ sections: { p: { type: 'probe' } }, order: ['p'] }),
    };
    expect((await render({ path: '/', editor }, { extra: probe })).html).toContain(
      'design mode: true',
    );
    expect((await render({ path: '/' }, { extra: probe })).html).toContain('design mode: false');
    // Outside the frame: nothing of the editor's.
    const plain = (await render({ path: '/products/bridal-lehenga-heavy' })).html;
    expect(plain).not.toContain('data-hatti-editor');
    expect(plain).not.toContain('hatti-editor-list');
    expect(plain).not.toContain('designMode');
  });

  it("does not count the layout's wait for its sections against its own time", async () => {
    // Sections may take 300 ms each: a featured collection, fetching twice at 160 ms, goes over,
    // and the layout waits as long for them. The layout's own time is left room for a slow
    // machine's rendering.
    const page = await render({ path: '/' }, { latencyMs: 160, limits: { timeMs: 300 } });
    expect(page.status).toBe(200);
    expect(page.renders.at(-1)).toMatchObject({ id: 'layout/theme', error: null });
    expect(page.renders.find((stat) => stat.id === 'lawn')?.error).toBe('time');
    expect(page.html).toMatch(/^<!doctype html>[\s\S]*<!-- lawn: not shown -->[\s\S]*<\/html>\s*$/);
  });

  it('gives themes menus three levels deep, leaving out links that could end an attribute', async () => {
    const link = (title: string, url: string, links: MenuLinkDoc[] = []): MenuLinkDoc => ({
      title,
      url,
      type: url.startsWith('/collections/') ? 'collection_link' : 'http_link',
      links,
    });
    const documents = sampleStore();
    const menu = {
      handle: 'shop-by',
      title: 'Shop by',
      links: [
        link('Women', '/collections/eid-lawn', [
          link('Lawn', '/collections/eid-lawn', [
            link('Printed', '/collections/eid-lawn?sort_by=price-ascending', [
              link('Deeper', '/collections/khussa'),
            ]),
          ]),
        ]),
        link('Script', 'javascript:alert(1)'),
        link('Quote', '/a" onmouseover="alert(1)'),
        link('WhatsApp', 'https://wa.me/923001234567'),
      ],
    };
    const renderer = new PageRenderer(
      loadTheme({
        ...files,
        'sections/menu-probe.liquid':
          "{%- assign menu = linklists['shop-by'] -%}{{ menu.levels }}|" +
          '{%- for link in menu.links -%}{{ link.title }}:{{ link.levels }}:{{ link.type }}[' +
          '{%- for child in link.links -%}{{ child.title }}[' +
          '{%- for grandchild in child.links -%}{{ grandchild.title }}{{ grandchild.links.size }}' +
          '{%- endfor -%}]{%- endfor -%}] {% endfor -%}',
        'templates/index.json': JSON.stringify({
          sections: { probe: { type: 'menu-probe' } },
          order: ['probe'],
          layout: false,
        }),
      }),
      { limits: { timeMs: 10_000 } },
    );
    const page = await renderer.render(
      { path: '/' },
      new MemoryStore({ ...documents, menus: [...documents.menus, menu] }),
    );
    expect(page.html).toContain(
      '3|Women:2:collection_link[Lawn[Printed0]] WhatsApp:0:http_link[] ',
    );
    expect(page.html).not.toMatch(/Deeper|Script|Quote/);
  });

  it("holds a shop's settings to their types, and its IDs to letters, digits, _ and -", async () => {
    const base = loadTheme(files);
    const home = JSON.parse(files['templates/index.json']!) as SectionList;
    const rejected: string[] = [];
    const theme = overlayTheme(
      base,
      {
        'config/settings_data.json': JSON.stringify({
          current: {
            // Not a colour, a colour, over the range's maximum, and not a setting.
            color_accent: '#fff; } body { display: none } :root {',
            color_text: 'rgb(15, 23, 42)',
            page_width: 99_999,
            favicon: '"><script>alert(1)</script>',
          },
        }),
        'templates/index.json': JSON.stringify({
          sections: {
            banner: {
              ...home.sections.banner,
              settings: { image: { src: 'javascript:alert(1)', width: 1500, height: 900 } },
              blocks: {
                button: {
                  type: 'button',
                  settings: { label: 'Shop', link: 'javascript:alert(1)' },
                },
              },
              block_order: ['button'],
            },
          },
          order: ['banner'],
        }),
        'templates/product.json': JSON.stringify({
          sections: { 'x"><b': { type: 'main-product' } },
          order: ['x"><b'],
        }),
      },
      (error) => rejected.push(error.file),
    );
    expect(rejected).toEqual(['templates/product.json']);

    const renderer = new PageRenderer(base, { limits: { timeMs: 10_000 } });
    const page = await renderer.render({ path: '/' }, store.fresh(), () => theme);
    expect(page.html).toContain('--color-accent: #0F766E;');
    expect(page.html).toContain('--color-text: rgb(15, 23, 42);');
    expect(page.html).toContain('--page-width: 1600px;');
    // The link it gave gives way to the block's default.
    expect(page.html).toMatch(/<a class="button" href="\/collections\/all" ?>Shop<\/a>/);
    expect(page.html).not.toMatch(/body \{ display: none|javascript:|<script>alert/);
  });

  it("shows the shopper's cart on the cart page, and only there", async () => {
    const lawn = sampleStore().products[0]!;
    const variant = lawn.variants[1]!;
    const cart: CartJson = {
      note: 'Deliver after 5 <b>pm</b>',
      attributes: {},
      items: [
        {
          key: `${variant.id}:0123456789abcdef0123456789abcdef`,
          variantId: variant.id,
          productId: lawn.id,
          quantity: 2,
          properties: { Stitching: 'Yes, <i>please</i>', _campaign: 'eid' },
          price: variant.price,
          linePrice: variant.price * 2,
          title: lawn.title,
          variantTitle: variant.title,
          sku: null,
          grams: 0,
          taxable: true,
          taxCode: null,
          maxQuantity: null,
        },
        {
          // Its product not published yet: its title from the core, and no link.
          key: 'gone:fedcba9876543210fedcba9876543210',
          variantId: 'gone',
          productId: 'gone-product',
          quantity: 1,
          properties: {},
          price: 150_000,
          linePrice: 150_000,
          title: 'Chikankari Kurta',
          variantTitle: 'M',
          sku: null,
          grams: 0,
          taxable: true,
          taxCode: null,
          maxQuantity: 0,
        },
      ],
      itemCount: 3,
      subtotal: variant.price * 2 + 150_000,
      totalWeightGrams: 0,
      discount: null,
      totalDiscount: 0,
    };
    const page = await render({ path: '/cart', cart });
    expect([page.status, page.errors]).toEqual([200, []]);
    expect(page.html).toContain('<title>Your cart · Zari Fashions</title>');
    // It asks for the products paired with each of its products, those it holds left out
    // (ADR-437).
    const upsells =
      /<hatti-cart-upsells\s+class="page-width section-spacing"\s+data-urls="([^"]+)"\s+data-in-cart="([^"]+)"\s+data-limit="4"\s+hidden\s*>\s*<h2 dir="auto">Goes well with your order<\/h2>/.exec(
        page.html,
      );
    expect(upsells?.[1]?.replace(/&amp;/g, '&').split(' ')).toEqual(
      [lawn.id, 'gone-product'].map(
        (id) =>
          `/recommendations/products?section_id=cart-upsells&intent=complementary&product_id=${id}&limit=4`,
      ),
    );
    expect(upsells?.[2]).toBe(`${lawn.id} gone-product`);
    expect(page.html).toContain('<span class="count" data-cart-count>3</span>');
    expect(page.html).toContain(
      '<form method="post" action="/cart" accept-charset="UTF-8" class="cart__form"',
    );
    expect(page.html).toContain(
      `<a class="cart-item__title" href="/products/${lawn.handle}?variant=${variant.id}" dir="auto">`,
    );
    expect(page.html).toContain(`<p class="cart-item__detail" dir="auto">${variant.title}</p>`);
    // What the shopper typed, escaped; properties starting with _ are the shop's own.
    expect(page.html).toContain('Stitching: Yes, &lt;i&gt;please&lt;/i&gt;');
    expect(page.html.replace(/utm_campaign/g, '')).not.toContain('_campaign');
    expect(page.html).toContain(
      `href="/cart/change?id=${encodeURIComponent(cart.items[0]!.key)}&quantity=0"`,
    );
    expect(page.html).toContain(
      '<span class="cart-item__title" dir="auto">Chikankari Kurta</span>',
    );
    expect(page.html).toContain('<p class="cart-item__warning" role="status">Sold out</p>');
    expect(page.html).toContain('Deliver after 5 &lt;b&gt;pm&lt;/b&gt;</textarea>');
    expect(page.html).toMatch(/<strong>Rs [\d,]+<\/strong>/);
    // The shop's WhatsApp takes the whole cart as an order.
    expect(page.html).toContain(
      `https://wa.me/923001234567?text=${encodeURIComponent(
        `Hi! I'd like to order 2 × ${lawn.title} - ${variant.title}, 1 × Chikankari Kurta.`,
      )}`,
    );

    // In Urdu, its forms and links stay in Urdu.
    const urdu = await render({ path: '/cart', locale: 'ur', cart });
    expect(urdu.html).toContain('<form method="post" action="/ur/cart"');
    expect(urdu.html).toContain('href="/ur/cart/change?id=');
    expect(urdu.html).toContain('<title>آپ کا کارٹ · Zari Fashions</title>');

    // Why a change was refused; an empty cart; and other pages, the same for everyone.
    const refused = await render({ path: '/cart', cart, cartError: 'Rose Lawn is sold out.' });
    expect(refused.html).toContain(
      '<p class="cart__error" role="alert" dir="auto">Rose Lawn is sold out.</p>',
    );
    const empty = (await render({ path: '/cart', cart: null })).html;
    expect(empty).toContain('Your cart is empty.');
    expect(empty).not.toContain('<hatti-cart-upsells');
    const product = await render({ path: `/products/${lawn.handle}` });
    expect(product.html).toContain('<span class="count" data-cart-count>0</span>');
    expect(product.html).toContain('<form method="post" action="/cart/add"');

    // What delivery costs: the sample shop's is free from Rs 5,000.
    expect(product.html).toContain('<li>Free delivery on orders of Rs 5,000 or more</li>');
    expect(page.html).toContain('Your order is delivered free.');
    const small = await render({
      path: '/cart',
      cart: { ...cart, items: [cart.items[1]!], itemCount: 1, subtotal: 150_000 },
    });
    expect(small.html).toContain('Add Rs 3,500 more for free delivery.');
    expect(small.html).not.toContain('By law');
    // Past the law's cap on cash on delivery, it says checkout asks the rest another way.
    const big = await render({ path: '/cart', cart: { ...cart, subtotal: 20_000_100 } });
    expect(big.html).toContain(
      'By law, cash on delivery collects at most Rs 200,000 an order: checkout asks the rest in ' +
        'advance, or another way to pay.',
    );
  });

  it('says how many working days delivery takes, where the shop says (ADR-235)', async () => {
    const sample = sampleStore();
    const lawn = sample.products[0]!;
    const variant = lawn.variants[0]!;
    const cart: CartJson = {
      note: '',
      attributes: {},
      items: [
        {
          key: `${variant.id}:0123456789abcdef0123456789abcdef`,
          variantId: variant.id,
          productId: lawn.id,
          quantity: 1,
          properties: {},
          price: variant.price,
          linePrice: variant.price,
          title: lawn.title,
          variantTitle: variant.title,
          sku: null,
          grams: 0,
          taxable: true,
          taxCode: null,
          maxQuantity: null,
        },
      ],
      itemCount: 1,
      subtotal: variant.price,
      totalWeightGrams: 0,
      discount: null,
      totalDiscount: 0,
    };
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const withDays = (delivery: Partial<NonNullable<typeof sample.shop.delivery>>) =>
      new MemoryStore({
        ...sample,
        shop: { ...sample.shop, delivery: { ...sample.shop.delivery!, ...delivery } },
      }).fresh();
    // Wherever it goes: from the fewest days anywhere to the most.
    const days = withDays({
      days: { min: 2, max: 4 },
      zones: [{ name: 'Lahore', cities: ['Lahore'], charge: 15_000, days: { min: 1, max: 1 } }],
    });
    const product = await renderer.render({ path: `/products/${lawn.handle}` }, days);
    expect(product.html).toContain('<li>Delivered in 1 to 4 working days</li>');
    expect(product.html).not.toContain('Delivered in 2 to 5 days across Pakistan');
    const inCart = await renderer.render({ path: '/cart', cart }, days);
    expect(inCart.html).toContain('<p class="cart__delivery">Delivered in 1 to 4 working days</p>');
    const urdu = await renderer.render({ path: '/cart', cart, locale: 'ur' }, days);
    expect(urdu.html).toContain('1 سے 4 کام کے دنوں میں ڈیلیوری');
    const oneDay = await renderer.render(
      { path: '/cart', cart },
      withDays({ days: { min: 1, max: 1 }, zones: [] }),
    );
    expect(oneDay.html).toContain('Delivered in 1 working day<');
    const within = await renderer.render(
      { path: `/products/${lawn.handle}` },
      withDays({ days: { min: 0, max: 3 }, zones: [] }),
    );
    expect(within.html).toContain('<li>Delivered within 3 working days</li>');
    const sameDay = await renderer.render(
      { path: `/products/${lawn.handle}` },
      withDays({ days: { min: 0, max: 0 }, zones: [] }),
    );
    expect(sameDay.html).toContain('<li>Delivered the same day</li>');
    // Days for a zone alone say nothing of everywhere else; nor does a shop that set none.
    const zoneAlone = withDays({
      zones: [{ name: 'Lahore', cities: ['Lahore'], charge: 15_000, days: { min: 1, max: 1 } }],
    });
    const none = await renderer.render({ path: `/products/${lawn.handle}` }, zoneAlone);
    expect(none.html).toContain('<li>Delivered in 2 to 5 days across Pakistan</li>');
    expect((await renderer.render({ path: '/cart', cart }, zoneAlone)).html).not.toContain(
      'working day',
    );
  });

  it('says what heavier orders cost more to deliver, on product pages and for a heavy cart (ADR-704)', async () => {
    const sample = sampleStore();
    const lawn = sample.products[0]!;
    const variant = lawn.variants[0]!;
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const store = (weights?: { aboveGrams: number; charge: number }[]) =>
      new MemoryStore({
        ...sample,
        shop: {
          ...sample.shop,
          delivery: {
            ...sample.shop.delivery!,
            charge: 25_000,
            freeAbove: 500_000,
            ...(weights && { weights }),
          },
        },
      }).fresh();
    const heavy = store([
      { aboveGrams: 2_000, charge: 10_000 },
      { aboveGrams: 5_500, charge: 30_000 },
    ]);
    const path = `/products/${lawn.handle}`;
    const product = (await renderer.render({ path }, heavy)).html;
    expect(product).toContain('<li>Orders over 2 kg: Rs 100 more for delivery</li>');
    expect(product).toContain('<li>Orders over 5.5 kg: Rs 300 more for delivery</li>');
    expect((await renderer.render({ path, locale: 'ur' }, heavy)).html).toContain(
      '<li>2 کلو سے زیادہ کے آرڈر: ڈیلیوری Rs 100 زیادہ</li>',
    );
    // A shop charging none for weight says nothing of it.
    expect((await renderer.render({ path }, store())).html).not.toContain('more for delivery');

    // A cart of 3 kg is over the first and not the second; free delivery says nothing of weight.
    const cartOf = (grams: number, price: number): CartJson => ({
      note: '',
      attributes: {},
      items: [
        {
          key: `${variant.id}:0123456789abcdef0123456789abcdef`,
          variantId: variant.id,
          productId: lawn.id,
          quantity: 1,
          properties: {},
          price,
          linePrice: price,
          title: lawn.title,
          variantTitle: variant.title,
          sku: null,
          grams,
          taxable: true,
          taxCode: null,
          maxQuantity: null,
        },
      ],
      itemCount: 1,
      subtotal: price,
      totalWeightGrams: grams,
      discount: null,
      totalDiscount: 0,
    });
    const cartPage = async (grams: number, price = 200_000, locale?: string) =>
      (
        await renderer.render(
          { path: '/cart', cart: cartOf(grams, price), ...(locale && { locale }) },
          heavy,
        )
      ).html;
    expect(await cartPage(3_000)).toContain('Your order is over 2 kg: delivery costs Rs 100 more.');
    expect(await cartPage(6_000)).toContain(
      'Your order is over 5.5 kg: delivery costs Rs 300 more.',
    );
    expect(await cartPage(6_000, 200_000, 'ur')).toContain(
      'آپ کا آرڈر 5.5 کلو سے زیادہ ہے: ڈیلیوری Rs 300 زیادہ ہے۔',
    );
    expect(await cartPage(2_000)).not.toContain('Your order is over');
    expect(await cartPage(6_000, 600_000)).not.toContain('Your order is over');
  });

  it('says what larger orders pay at most to deliver, on product pages and for a cart reaching a rate (ADR-723)', async () => {
    const sample = sampleStore();
    const lawn = sample.products[0]!;
    const variant = lawn.variants[0]!;
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const store = (valueRates?: { fromSubtotal: number; charge: number }[]) =>
      new MemoryStore({
        ...sample,
        shop: {
          ...sample.shop,
          delivery: {
            ...sample.shop.delivery!,
            charge: 25_000,
            freeAbove: 1_000_000,
            ...(valueRates && { valueRates }),
          },
        },
      }).fresh();
    const rated = store([
      { fromSubtotal: 300_000, charge: 15_000 },
      { fromSubtotal: 500_000, charge: 0 },
    ]);
    const path = `/products/${lawn.handle}`;
    const product = (await renderer.render({ path }, rated)).html;
    expect(product).toContain('<li>Orders of Rs 3,000 or more: delivery at most Rs 150</li>');
    expect(product).toContain('<li>Orders of Rs 5,000 or more: free delivery</li>');
    expect((await renderer.render({ path, locale: 'ur' }, rated)).html).toContain(
      '<li>Rs 3,000 یا زیادہ کے آرڈر: ڈیلیوری زیادہ سے زیادہ Rs 150</li>',
    );
    // A shop setting none says nothing of them.
    expect((await renderer.render({ path }, store())).html).not.toContain(
      'or more: delivery at most',
    );

    const cartOf = (price: number): CartJson => ({
      note: '',
      attributes: {},
      items: [
        {
          key: `${variant.id}:0123456789abcdef0123456789abcdef`,
          variantId: variant.id,
          productId: lawn.id,
          quantity: 1,
          properties: {},
          price,
          linePrice: price,
          title: lawn.title,
          variantTitle: variant.title,
          sku: null,
          grams: 0,
          taxable: true,
          taxCode: null,
          maxQuantity: null,
        },
      ],
      itemCount: 1,
      subtotal: price,
      totalWeightGrams: 0,
      discount: null,
      totalDiscount: 0,
    });
    const cartPage = async (price: number, locale?: string) =>
      (
        await renderer.render(
          { path: '/cart', cart: cartOf(price), ...(locale && { locale }) },
          rated,
        )
      ).html;
    expect(await cartPage(200_000)).not.toContain('Your order pays at most');
    expect(await cartPage(400_000)).toContain('Your order pays at most Rs 150 for delivery.');
    expect(await cartPage(400_000, 'ur')).toContain(
      'آپ کے آرڈر کی ڈیلیوری زیادہ سے زیادہ Rs 150 ہے۔',
    );
    expect(await cartPage(600_000)).toContain('Your order&#39;s value makes its delivery free.');
  });

  it("says on a product's page what delivery costs and takes to each city, and links the shop's returns (OS-11, ADR-454)", async () => {
    const sample = sampleStore();
    const [lawn] = sample.products;
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const shop = (delivery: Partial<NonNullable<typeof sample.shop.delivery>>, more = {}) =>
      new MemoryStore({
        ...sample,
        shop: {
          ...sample.shop,
          ...more,
          delivery: { ...sample.shop.delivery!, charge: 25_000, ...delivery },
        },
      }).fresh();
    const zoned = shop(
      {
        days: { min: 2, max: 4 },
        zones: [
          {
            name: 'Twin cities',
            cities: ['Islamabad', 'Rawalpindi'],
            charge: 0,
            days: { min: 1, max: 1 },
          },
          { name: 'Lahore', cities: ['Lahore'], charge: 15_000 },
        ],
      },
      { policies: ['refund_policy'] },
    );
    const page = (await renderer.render({ path: `/products/${lawn!.handle}` }, zoned)).html;
    const cities = page.slice(page.indexOf('<details class="product__cities">'));
    const items = [
      ...cities.slice(0, cities.indexOf('</details>')).matchAll(/<li>([^]*?)<\/li>/g),
    ].map((match) => match[1]!.replace(/\s+/g, ' ').trim());
    expect(cities).toMatch(
      /^<details class="product__cities">\s*<summary>Delivery to your city<\/summary>/,
    );
    expect(items).toEqual([
      '<strong dir="auto">Islamabad, Rawalpindi</strong>: Free · Delivered in 1 working day',
      // A zone without days of its own takes everywhere's.
      '<strong dir="auto">Lahore</strong>: Rs 150 · Delivered in 2 to 4 working days',
      '<strong>Everywhere else</strong>: Rs 250 · Delivered in 2 to 4 working days',
    ]);
    expect(page).toMatch(
      /<li>\s*<a href="\/policies\/refund-policy">Returns and exchanges: see our policy<\/a>\s*<\/li>/,
    );
    const urdu = (await renderer.render({ path: `/products/${lawn!.handle}`, locale: 'ur' }, zoned))
      .html;
    expect(urdu).toContain('آپ کے شہر میں ڈیلیوری');
    expect(urdu).toContain('واپسی اور تبادلہ: ہماری پالیسی دیکھیں');
    // No zones and no refund policy: neither is said.
    const plain = (
      await renderer.render(
        { path: `/products/${lawn!.handle}` },
        shop({ zones: [] }, { policies: [] }),
      )
    ).html;
    expect(plain).not.toContain('product__cities');
    expect(plain).not.toContain('Returns and exchanges: see our policy');
    expect(plain).not.toContain('Verified by Hatti');

    // What Hatti verified of the shop (ADR-466), beside the rest and in the footer.
    const verified = async (level: 'identity' | 'business', locale?: string) =>
      (
        await renderer.render(
          { path: `/products/${lawn!.handle}`, ...(locale && { locale }) },
          shop({}, { verified: level }),
        )
      ).html.replace(/\s+/g, ' ');
    const owner = await verified('identity');
    expect(owner).toContain(
      '<li class="product__verified"> Verified by Hatti: the seller&#39;s identity is checked </li>',
    );
    expect(owner).toContain(
      '<p class="footer__verified"><span aria-hidden="true">✓</span> Verified by Hatti</p>',
    );
    expect(await verified('business')).toContain(
      '<li class="product__verified"> Verified by Hatti: a registered business </li>',
    );
    expect(await verified('business', 'ur')).toContain('ہٹی سے تصدیق شدہ: رجسٹرڈ کاروبار');

    // "Powered by Hatti" in the footer, as Shopify's powered_by_link, unless the shop hides it
    // (ADR-526).
    expect(plain).toContain(
      '<p class="footer__powered"><a target="_blank" rel="nofollow" ' +
        'href="https://hatti.pk/?utm_campaign=poweredby&amp;utm_medium=hatti&amp;' +
        'utm_source=onlinestore">Powered by Hatti</a></p>',
    );
    expect(await verified('identity', 'ur')).toContain('>ہٹی کے ذریعے</a>');
    const hidden = (
      await renderer.render(
        { path: `/products/${lawn!.handle}` },
        shop({}, { hidePoweredBy: true }),
      )
    ).html;
    expect(hidden).not.toContain('<p class="footer__powered">');
    expect(hidden).not.toContain('Powered by Hatti');

    // The shop's return window (ADR-468): in words beside its policy's link, and in each offer.
    const returned = async (returns: { days: number; exchangesOnly: boolean }, locale?: string) =>
      (
        await renderer.render(
          { path: `/products/${lawn!.handle}`, ...(locale && { locale }) },
          shop({}, { policies: ['refund_policy'], returns }),
        )
      ).html;
    const week = await returned({ days: 7, exchangesOnly: false });
    expect(week.replace(/\s+/g, ' ')).toContain(
      '<li class="product__returns">Returns within 7 days of delivery · ' +
        '<a href="/policies/refund-policy">our policy</a></li>',
    );
    expect(week).not.toContain('Returns and exchanges: see our policy');
    const offers = (html: string) =>
      (
        JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!) as {
          offers: Record<string, unknown>[];
        }
      ).offers;
    expect(offers(week)[0]!.hasMerchantReturnPolicy).toEqual({
      '@type': 'MerchantReturnPolicy',
      applicableCountry: 'PK',
      returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
      merchantReturnDays: 7,
      refundType: 'https://schema.org/FullRefund',
    });
    const day = await returned({ days: 1, exchangesOnly: true });
    expect(day).toContain('Exchanges within 1 day of delivery');
    expect(offers(day)[0]!.hasMerchantReturnPolicy).toMatchObject({
      refundType: 'https://schema.org/ExchangeRefund',
    });
    const none = await returned({ days: 0, exchangesOnly: false });
    expect(none).toContain('No returns or exchanges');
    expect(offers(none)[0]!.hasMerchantReturnPolicy).toEqual({
      '@type': 'MerchantReturnPolicy',
      applicableCountry: 'PK',
      returnPolicyCategory: 'https://schema.org/MerchantReturnNotPermitted',
    });
    expect(await returned({ days: 7, exchangesOnly: true }, 'ur')).toContain(
      'ڈیلیوری کے 7 دن کے اندر تبادلہ',
    );
    // Nothing said, nothing given.
    expect(offers(plain)[0]!.hasMerchantReturnPolicy).toBeUndefined();
  });

  it("offers sign-ups for the shop's news on WhatsApp, saying how one went", async () => {
    const home = (await render({ path: '/' })).html;
    expect(home).toContain(
      '<form method="post" action="/contact" accept-charset="UTF-8" id="newsletter" ' +
        'class="newsletter__form"><input type="hidden" name="form_type" value="customer">',
    );
    // The words beside the number go with it, as the consent the shop keeps.
    const consent = 'Send me news and offers from Zari Fashions on WhatsApp';
    expect(home).toContain(`<input type="hidden" name="contact[consent]" value="${consent}">`);
    expect(home).toContain(
      `<label class="newsletter__label" for="newsletter-phone">${consent}</label>`,
    );
    expect(home).toContain('<input type="hidden" name="return_to" value="/#newsletter">');
    expect(home).toMatch(/name="contact\[phone\]"/);
    expect(home).not.toContain('newsletter-error');
    const urdu = (await render({ path: '/', locale: 'ur' })).html;
    expect(urdu).toContain('action="/ur/contact"');
    expect(urdu).toContain('<input type="hidden" name="return_to" value="/ur/#newsletter">');
    expect(urdu).toContain('مجھے Zari Fashions کی خبریں اور آفرز واٹس ایپ پر بھیجیں');

    const taken = (await render({ path: '/', query: { customer_posted: 'true' } })).html;
    expect(taken).toContain('Thank you! We&#39;ll send you our news and offers on WhatsApp.');
    expect(taken).not.toContain('name="contact[phone]"');
    const wrong = (await render({ path: '/', query: { customer_error: 'phone' } })).html;
    expect(wrong).toContain('Enter a Pakistani mobile number, like 0300 1234567.');
    expect(wrong).toMatch(/name="contact\[phone\]"[^>]*aria-invalid="true"/);
  });

  it('opens a pop-up for sign-ups on WhatsApp where the shop shows it, its code once signed up (ADR-457)', async () => {
    // Hidden in Hatti Base until the shop shows it.
    expect((await render({ path: '/' })).html).not.toContain('<hatti-sign-up-popup');
    const footer = JSON.parse(files['sections/footer-group.json']!) as SectionList;
    const shown = (settings: Record<string, unknown>) => ({
      'sections/footer-group.json': JSON.stringify({
        ...footer,
        sections: {
          ...footer.sections,
          popup: { type: 'sign-up-popup', settings: { code: 'WELCOME10', ...settings } },
        },
      }),
    });
    const extra = shown({});
    const home = (await render({ path: '/' }, { extra })).html;
    expect(home).toMatch(/<hatti-sign-up-popup\s+data-delay="10"\s+data-days="14"\s+data-exit\s*>/);
    expect(home).toContain('<dialog class="sign-up-popup" id="sign-up-popup"');
    expect(home).toContain(
      '<form method="post" action="/contact" accept-charset="UTF-8" id="sign-up-popup-form" ' +
        'class="sign-up-popup__form"><input type="hidden" name="form_type" value="customer">',
    );
    expect(home).toContain('<input type="hidden" name="contact[tags]" value="popup">');
    expect(home).toContain('<input type="hidden" name="return_to" value="/#sign-up-popup">');
    expect(home).toContain(
      '<label for="sign-up-popup-phone">Send me news and offers from Zari Fashions on WhatsApp</label>',
    );
    // Its code is for those who signed up.
    expect(home).not.toContain('WELCOME10');
    const { handle } = sampleStore().products[0]!;
    expect((await render({ path: `/products/${handle}` }, { extra })).html).toContain(
      '<hatti-sign-up-popup',
    );

    const taken = (await render({ path: '/', query: { customer_posted: 'true' } }, { extra })).html;
    expect(taken).toMatch(
      /Your code for the offer:\s*<strong class="sign-up-popup__code" dir="ltr">WELCOME10<\/strong>/,
    );
    const wrong = (await render({ path: '/', query: { customer_error: 'phone' } }, { extra })).html;
    expect(wrong).toMatch(/id="sign-up-popup-phone"[^>]*aria-invalid="true"/);
    const urdu = (await render({ path: '/', locale: 'ur' }, { extra })).html;
    expect(urdu).toContain('<input type="hidden" name="return_to" value="/ur/#sign-up-popup">');
    expect(urdu).toContain('ابھی نہیں');

    // On the home page alone, without leaving; and opened at once in the theme editor.
    const homeOnly = shown({ home_only: true, exit_intent: false, delay: 0 });
    const product = (await render({ path: `/products/${handle}` }, { extra: homeOnly })).html;
    expect(product).not.toContain('<hatti-sign-up-popup');
    const plain = (await render({ path: '/' }, { extra: homeOnly })).html;
    expect(plain).toMatch(/<hatti-sign-up-popup\s+data-delay="0"\s+data-days="14"\s*>/);
    const editing = (
      await render({ path: '/', editor: { origins: ['https://admin.hatti.pk'] } }, { extra })
    ).html;
    expect(editing).toMatch(/<hatti-sign-up-popup[^>]*data-design/);
    // No wheel unless the shop shows one.
    expect(home).not.toMatch(/<hatti-sign-up-popup[^>]*data-spin/);
    expect(home).not.toContain('<div class="spin-wheel"');
  });

  it("draws the shop's spin-to-win wheel in the pop-up where it shows one (OS-08, ADR-900)", async () => {
    const footer = JSON.parse(files['sections/footer-group.json']!) as SectionList;
    const extra = {
      'sections/footer-group.json': JSON.stringify({
        ...footer,
        sections: {
          ...footer.sections,
          popup: { type: 'sign-up-popup', settings: { spin_wheel: true } },
        },
      }),
    };
    const home = (await render({ path: '/' }, { extra })).html;
    expect(home).toMatch(/<hatti-sign-up-popup[^>]*\sdata-spin\s/);
    expect(home).toContain('data-spin-label="Spin the wheel"');
    expect(home).toContain('data-spin-won="The wheel stopped at {label}!"');
    expect(home).toContain('data-spin-ends="Use it by {date}, for one order."');
    expect(home).toContain('<div class="spin-wheel" data-spin-wheel hidden>');
    expect(home).toContain(
      '<p class="sign-up-popup__error" role="alert" data-spin-error hidden></p>',
    );
    // Without scripts, the plain sign-up form.
    expect(home).toContain('<input type="hidden" name="contact[tags]" value="popup">');
    const urdu = (await render({ path: '/', locale: 'ur' }, { extra })).html;
    expect(urdu).toContain('data-spin-label="پہیہ گھمائیں"');
  });

  it('puts a WhatsApp button on every page, its message saying what the shopper was looking at (OS-10, ADR-593)', async () => {
    const documents = sampleStore();
    const lawn = documents.products[0]!;
    const variant = lawn.variants[0]!;
    const options = { platformUrl: 'https://hatti.pk' };
    const chat = (html: string) =>
      html.match(
        /<a\s+class="whatsapp-chat"\s+href="([^"]+)"(?: data-whatsapp-template="([^"]+)")?/,
      );
    const text = (url: string | undefined) => decodeURIComponent(url!.split('?text=')[1]!);

    // A question, from the home page.
    const home = chat((await render({ path: '/' }, options)).html);
    expect(home?.[1]).toBe('https://wa.me/923001234567?text=Hi!%20I%20have%20a%20question.');
    expect(home?.[2]).toBeUndefined();

    // A product's page names it, the variant shown and its link, at the shop's address, and both
    // links carry the message with the variant left for the page's script to fill in.
    const page = (await render({ path: `/products/${lawn.handle}` }, options)).html;
    const link = `https://zari.hatti.pk/products/${lawn.handle}`;
    const [, href, template] = chat(page)!;
    expect(text(href)).toBe(
      `Hi! I have a question about ${lawn.title} (${variant.title}): ${link}?variant=${variant.id}`,
    );
    expect(text(template)).toBe(
      `Hi! I have a question about ${lawn.title} (__VARIANT__): ${link}?variant=__ID__`,
    );
    const order = page.match(
      /<a\s+class="button button--secondary"\s+href="([^"]+)" data-whatsapp-template="([^"]+)"/,
    );
    expect(text(order?.[1])).toBe(
      `Hi! I'd like to order ${lawn.title} (${variant.title}): ${link}?variant=${variant.id}`,
    );
    expect(text(order?.[2])).toBe(
      `Hi! I'd like to order ${lawn.title} (__VARIANT__): ${link}?variant=__ID__`,
    );
    // Picking another variant fills both in.
    expect(page).toContain('link.dataset.whatsappTemplate');

    // A product with no variants to pick names none.
    const single = {
      ...lawn,
      handle: 'plain-dupatta',
      title: 'Plain Dupatta',
      variants: [{ ...variant, title: 'Default Title', options: ['Default Title'] }],
      options: [{ name: 'Title', values: ['Default Title'] }],
    };
    const plain = new MemoryStore({
      ...documents,
      products: [single, ...documents.products.slice(1)],
    });
    const renderer = new PageRenderer(loadTheme(files), { ...options, limits: { timeMs: 10_000 } });
    const alone = (await renderer.render({ path: '/products/plain-dupatta' }, plain.fresh())).html;
    expect(text(chat(alone)?.[1])).toBe(
      'Hi! I have a question about Plain Dupatta: https://zari.hatti.pk/products/plain-dupatta',
    );
    expect(chat(alone)?.[2]).toBeUndefined();
    expect(alone).toContain(
      `href="https://wa.me/923001234567?text=${encodeURIComponent("Hi! I'd like to order Plain Dupatta: https://zari.hatti.pk/products/plain-dupatta")}"`,
    );

    // A collection's page names the collection, in Urdu in Urdu.
    expect(text(chat((await render({ path: '/collections/eid-lawn' }, options)).html)?.[1])).toBe(
      'Hi! I have a question about Eid Lawn: https://zari.hatti.pk/collections/eid-lawn',
    );
    expect(
      text(
        chat((await render({ path: '/collections/eid-lawn', locale: 'ur' }, options)).html)?.[1],
      ),
    ).toMatch(
      /^السلام علیکم! مجھے .+ کے بارے میں پوچھنا ہے: https:\/\/zari\.hatti\.pk\/ur\/collections\/eid-lawn$/,
    );

    // None where the shop turns it off.
    const off = await render(
      { path: '/' },
      {
        ...options,
        extra: {
          'config/settings_data.json': JSON.stringify({ current: { whatsapp_chat: false } }),
        },
      },
    );
    expect(off.html).not.toContain('class="whatsapp-chat"');
    expect(off.html).toContain('class="button button--whatsapp"');
  });

  it("links every page's footer to reporting the store to Hatti, in its language (ADR-460)", async () => {
    expect((await render({ path: '/' })).html).toContain(
      '<p class="footer__report"><a href="/report" rel="nofollow">Report this store to Hatti</a></p>',
    );
    expect((await render({ path: '/', locale: 'ur' })).html).toContain(
      '<a href="/ur/report" rel="nofollow">اس دکان کی شکایت ہٹی سے کریں</a>',
    );
  });

  it('asks for related and paired products as Shopify themes do, and renders them, those for sale, when asked (ADR-434, ADR-435)', async () => {
    const sample = sampleStore();
    const [first, second, third, fourth, ...rest] = sample.products as [
      ProductDoc,
      ProductDoc,
      ProductDoc,
      ProductDoc,
      ...ProductDoc[],
    ];
    const soldOut = {
      ...third,
      variants: third.variants.map((each) => ({ ...each, available: false })),
    };
    const shop = new MemoryStore({
      ...sample,
      // A product gone since it was built is left out, as one sold out.
      products: [
        {
          ...first,
          related: [second.id, 'p-gone', soldOut.id, fourth.id],
          complements: [fourth.id, 'p-gone', second.id],
        },
        second,
        soldOut,
        fourth,
        ...rest,
      ],
    });
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const path = `/products/${first.handle}`;
    const page = (await renderer.render({ path }, shop.fresh())).html;
    // The page asks for them, those the shop pairs with it first: the sections are empty until
    // then.
    const urls = [
      ...page.matchAll(
        /<hatti-related-products\s+class="page-width section-spacing"\s+data-url="([^"]+)"\s*>\s*<\/hatti-related-products>/g,
      ),
    ].map((match) => match[1]!.replace(/&amp;/g, '&'));
    expect(urls).toEqual([
      `/recommendations/products?section_id=complementary&product_id=${first.id}&limit=4&intent=complementary`,
      `/recommendations/products?section_id=related&product_id=${first.id}&limit=4&intent=related`,
    ]);
    expect(page).not.toContain('You may also like');
    expect(page).not.toContain('Pairs well with');
    const asked = async (
      limit: number,
      locale?: string,
      intent: 'related' | 'complementary' = 'related',
      section: string = intent,
    ) =>
      (
        await renderer.sections(
          {
            path,
            ...(locale && { locale }),
            recommendations: { productId: first.id, intent, limit },
          },
          shop.fresh(),
          [section],
        )
      ).get(section)!;
    const links = (html: string) =>
      [...html.matchAll(/href="(?:\/ur)?\/products\/([\w-]+)" class="card__link"/g)].map(
        (match) => match[1],
      );
    const shown = await asked(4);
    expect(shown).toContain('<h2 dir="auto">You may also like</h2>');
    expect(links(shown)).toEqual([second.handle, fourth.handle]);
    expect(links(await asked(1))).toEqual([second.handle]);
    const urdu = await asked(4, 'ur');
    expect(links(urdu)).toEqual([second.handle, fourth.handle]);
    // Linking their Urdu pages (ADR-624).
    expect(urdu).toContain(`href="/ur/products/${second.handle}" class="card__link"`);
    // Those the shop pairs with it, in its order, those gone left out (ADR-435).
    const paired = await asked(4, undefined, 'complementary');
    expect(paired).toContain('<h2 dir="auto">Pairs well with</h2>');
    expect(links(paired)).toEqual([fourth.handle, second.handle]);
    // A product the shop pairs with none shows none.
    const alone = await renderer.sections(
      {
        path: `/products/${second.handle}`,
        recommendations: { productId: second.id, intent: 'complementary', limit: 4 },
      },
      shop.fresh(),
      ['complementary'],
    );
    expect(alone.get('complementary')).not.toContain('Pairs well with');
    // The cart's cross-sells ask for the same, rendered by their own section (ADR-437).
    const forCart = await asked(4, undefined, 'complementary', 'cart-upsells');
    expect(
      [...forCart.matchAll(/<li class="grid__item" data-product-id="([^"]+)">/g)].map(
        (match) => match[1],
      ),
    ).toEqual([fourth.id, second.id]);
    expect(forCart).not.toContain('<h2');
  });

  it("asks for a number on a sold-out variant's page while the shop sends back in stock messages (ADR-431)", async () => {
    const sample = sampleStore();
    const [first, second, ...rest] = sample.products as [ProductDoc, ProductDoc, ...ProductDoc[]];
    const soldOut = { ...first, variants: first.variants.map((v) => ({ ...v, available: false })) };
    const variant = soldOut.variants[0]!;
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const page = async (request: PageRequest, backInStock = true) =>
      (
        await renderer.render(
          request,
          new MemoryStore({
            ...sample,
            shop: { ...sample.shop, ...(backInStock && { backInStock: true as const }) },
            products: [soldOut, second, ...rest],
          }).fresh(),
        )
      ).html;
    const path = `/products/${soldOut.handle}`;

    // While the shop's automation is off, no form.
    expect(await page({ path }, false)).not.toContain('back_in_stock');
    const html = await page({ path });
    expect(html).toContain(
      '<form method="post" action="/back-in-stock" accept-charset="UTF-8" id="back-in-stock" ' +
        'class="back-in-stock__form"><input type="hidden" name="form_type" value="back_in_stock">',
    );
    expect(html).toContain(
      `<input type="hidden" name="contact[variant_id]" value="${variant.id}">`,
    );
    expect(html).toContain(
      `<input type="hidden" name="return_to" value="${path}?variant=${variant.id}#back-in-stock">`,
    );
    expect(html).toContain('Tell me on WhatsApp when it&#39;s back');
    expect(html).not.toMatch(/data-back-in-stock\s+hidden/);
    // A variant for sale: the form waits, hidden, for a sold-out one to be picked.
    expect(await page({ path: `/products/${second.handle}` })).toMatch(
      /data-back-in-stock\s+hidden/,
    );

    const urdu = await page({ path, locale: 'ur' });
    expect(urdu).toContain('action="/ur/back-in-stock"');
    expect(urdu).toContain(`value="/ur${path}?variant=${variant.id}#back-in-stock"`);
    expect(urdu).toContain('دوبارہ دستیاب ہونے پر مجھے واٹس ایپ پر بتائیں');

    // Back from the post, saying how it went.
    const taken = await page({ path, query: { back_in_stock_posted: 'true' } });
    expect(taken).toContain(
      'Thank you! We&#39;ll message you on WhatsApp once when it&#39;s back.',
    );
    expect(taken).not.toContain('name="contact[phone]"');
    const wrong = await page({ path, query: { back_in_stock_error: 'phone' } });
    expect(wrong).toContain('Enter a Pakistani mobile number, like 0300 1234567.');
    expect(wrong).toMatch(/name="contact\[phone\]"[^>]*aria-invalid="true"/);
    const off = await page({ path, query: { back_in_stock_error: 'base' } });
    expect(off).toContain('We couldn&#39;t take your number just now.');
  });

  it("shows what the cart's discount code takes off, free delivery by code, or a code that does not apply", async () => {
    const kurta = (price: number): CartJson['items'][number] => ({
      key: 'kurta:0123456789abcdef0123456789abcdef',
      variantId: 'kurta',
      productId: 'kurta-product',
      quantity: 1,
      properties: {},
      price,
      linePrice: price,
      title: 'Chikankari Kurta',
      variantTitle: 'M',
      sku: null,
      grams: 0,
      taxable: true,
      taxCode: null,
      maxQuantity: null,
    });
    const coded = (price: number, discount: CartJson['discount']): CartJson => ({
      note: '',
      attributes: {},
      items: [kurta(price)],
      itemCount: 1,
      subtotal: price,
      totalWeightGrams: 0,
      discount,
      totalDiscount: discount?.amount ?? 0,
    });
    const tenPercent = (amount: number) => ({
      code: 'EID10',
      applicable: true,
      kind: 'percentage' as const,
      value: 10,
      amount,
    });
    const page = await render({ path: '/cart', cart: coded(600_000, tenPercent(60_000)) });
    expect(page.errors).toEqual([]);
    // The subtotal, what the code takes off, and the total after it, which is free delivery's.
    expect(page.html.replace(/\s+/g, ' ')).toContain(
      '<p class="cart__line"> <span>Subtotal</span> <strong>Rs 6,000</strong> </p>' +
        '<p class="cart__line cart__discount"> <span>Discount (<bdi>EID10</bdi>)</span> ' +
        '<strong dir="ltr">−Rs 600</strong> </p>' +
        '<p class="cart__subtotal"> <span>Total</span> <strong>Rs 5,400</strong> </p>' +
        '<p class="cart__delivery">Your order is delivered free.</p>',
    );
    // As at checkout, the items must reach free delivery after their discount.
    const under = await render({ path: '/cart', cart: coded(520_000, tenPercent(52_000)) });
    expect(under.html).toContain('Add Rs 320 more for free delivery.');
    expect(under.html).toContain(
      encodeURIComponent("Hi! I'd like to order 1 × Chikankari Kurta. Total: Rs 4,680."),
    );

    const freeDelivery = {
      code: 'FREESHIP',
      applicable: true,
      kind: 'free_shipping' as const,
      value: 0,
      amount: 0,
    };
    const free = await render({ path: '/cart', cart: coded(150_000, freeDelivery) });
    expect(free.html).toContain(
      '<p class="cart__delivery">Your order is delivered free with the code <bdi>FREESHIP</bdi>.</p>',
    );
    expect(free.html).not.toContain('more for free delivery');
    expect(free.html).not.toContain('<span>Total</span>');

    const unusable = { code: 'eid10', applicable: false, kind: null, value: 0, amount: 0 };
    const refused = await render({ path: '/cart', cart: coded(150_000, unusable) });
    expect(refused.html).toContain(
      '<p class="cart__delivery">The code <bdi>eid10</bdi> doesn\'t apply to your cart yet.</p>',
    );
    expect(refused.html).toContain('Add Rs 3,500 more for free delivery.');

    // In Urdu, the code keeps its own direction.
    const urdu = await render({
      path: '/cart',
      locale: 'ur',
      cart: coded(600_000, tenPercent(60_000)),
    });
    expect(urdu.html).toContain('<span>رعایت (<bdi>EID10</bdi>)</span>');
  });

  it("shows what the shop's automatic discounts take off, and free delivery by one (ADR-515)", async () => {
    const cart: CartJson = {
      note: '',
      attributes: {},
      items: [
        {
          key: 'kurta:0123456789abcdef0123456789abcdef',
          variantId: 'kurta',
          productId: 'kurta-product',
          quantity: 1,
          properties: {},
          price: 600_000,
          linePrice: 600_000,
          title: 'Chikankari Kurta',
          variantTitle: 'M',
          sku: null,
          grams: 0,
          taxable: true,
          taxCode: null,
          maxQuantity: null,
        },
      ],
      itemCount: 1,
      subtotal: 600_000,
      totalWeightGrams: 0,
      discount: null,
      automaticDiscounts: [
        { title: 'Eid sale', kind: 'percentage', value: 10, amount: 60_000 },
        { title: 'Free delivery', kind: 'free_shipping', value: 0, amount: 0 },
      ],
      totalDiscount: 60_000,
    };
    const page = await render({ path: '/cart', cart });
    expect(page.errors).toEqual([]);
    expect(page.html.replace(/\s+/g, ' ')).toContain(
      '<p class="cart__line cart__discount"> <span>Discount (<bdi>Eid sale</bdi>)</span> ' +
        '<strong dir="ltr">−Rs 600</strong> </p>' +
        '<p class="cart__subtotal"> <span>Total</span> <strong>Rs 5,400</strong> </p>' +
        '<p class="cart__delivery">Your order is delivered free.</p>',
    );
    expect(page.html).not.toContain('with the code');
  });

  it("links an Urdu page's products, collections, pages, articles and menus in Urdu (ADR-624)", async () => {
    // Bar the language switcher's, which links the page in the other language.
    const hrefs = (html: string) =>
      [...html.replace(/<(a|link) [^>]*hreflang=[^>]*>/g, '').matchAll(/href="(\/[^"]*)"/g)].map(
        (m) => m[1]!,
      );
    /** The shop's own pages it links, not its assets or images. */
    const pages = (html: string) =>
      hrefs(html).filter((href) => /^\/(ur\/)?(products|collections|pages|blogs)\//.test(href));
    for (const path of ['/collections/eid-lawn', '/blogs/news', '/blogs/news/how-to-measure']) {
      const urdu = await render({ path, locale: 'ur' });
      expect(urdu.errors).toEqual([]);
      const linked = pages(urdu.html);
      expect(linked.length, path).toBeGreaterThan(0);
      expect(
        linked.filter((href) => !href.startsWith('/ur/')),
        path,
      ).toEqual([]);
      // The shop's own language as it was.
      const english = await render({ path });
      expect(
        pages(english.html).filter((href) => href.startsWith('/ur/')),
        path,
      ).toEqual([]);
    }
    // A menu's links to the shop's own pages, not elsewhere, nor those in a language already.
    expect(localizedPath('/collections/eid', '/ur')).toBe('/ur/collections/eid');
    expect(localizedPath('/', '/ur')).toBe('/ur');
    expect(localizedPath('/?ref=menu', '/ur')).toBe('/ur?ref=menu');
    expect(localizedPath('/ur/pages/faq', '/ur')).toBe('/ur/pages/faq');
    expect(localizedPath('https://instagram.com/zari', '/ur')).toBe('https://instagram.com/zari');
    expect(localizedPath('//cdn.example.com/x', '/ur')).toBe('//cdn.example.com/x');
    expect(localizedPath('#size-chart', '/ur')).toBe('#size-chart');
    expect(localizedPath('/pages/faq', '')).toBe('/pages/faq');
  });

  it("lists the shop's stores on its page, each found on a map, a city's alone at a choice (ADR-830)", async () => {
    const documents = sampleStore();
    const stores = {
      id: 'pg-stores',
      handle: 'stores',
      title: 'Our stores',
      bodyHtml: '',
      templateSuffix: 'stores',
      publishedAt: '2026-09-01T09:00:00.000Z',
    };
    const listed = (shop: ShopDoc) =>
      new MemoryStore({ ...documents, shop, pages: [...documents.pages!, stores] });
    const renderer = new PageRenderer(loadTheme(files), { limits: { timeMs: 10_000 } });
    const page = await renderer.render(
      { path: '/pages/stores' },
      listed({
        ...documents.shop,
        stores: [
          {
            name: 'Zari Gulberg',
            address: ['12 Main Boulevard', 'Gulberg III', 'Lahore 54000', 'Punjab'],
            city: 'Lahore',
            phone: '+923001234567',
            hours: 'Mon–Sat 11am–9pm\nSunday closed',
            pickup: true,
          },
          {
            name: 'Zari Clifton',
            address: ['Block 5', 'Karachi'],
            city: 'Karachi',
            phone: null,
            hours: null,
            pickup: false,
          },
        ],
      }).fresh(),
    );
    expect(page.status).toBe(200);
    const names = [...page.html.matchAll(/<h3 dir="auto">([^<]*)<\/h3>/g)].map(([, name]) => name);
    expect(names).toEqual(['Zari Gulberg', 'Zari Clifton']);
    expect(page.html).toContain(
      '<address dir="auto">12 Main Boulevard<br>Gulberg III<br>Lahore 54000<br>Punjab</address>',
    );
    expect(page.html).toContain('Mon–Sat 11am–9pm<br />\nSunday closed');
    expect(page.html).toContain('<a href="tel:+923001234567">Call 0300 1234567</a>');
    expect(page.html).toContain(
      'href="https://www.google.com/maps/search/?api=1&amp;query=Zari%20Gulberg%2C%2012%20Main',
    );
    // Collecting orders at the one that offers it.
    expect(page.html.match(/Collect your online order here/g)).toHaveLength(1);
    // Its cities to choose between, shown once the script runs.
    expect([...page.html.matchAll(/<option value="([^"]*)">/g)].map(([, city]) => city)).toEqual([
      '',
      'Karachi',
      'Lahore',
    ]);
    const data = [
      ...page.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
    ]
      .map(([, json]) => JSON.parse(json!) as unknown)
      .find((each) => Array.isArray(each)) as Record<string, unknown>[];
    expect(data.map((store) => [store['@type'], store.name, store.telephone])).toEqual([
      ['Store', 'Zari Gulberg', '+923001234567'],
      ['Store', 'Zari Clifton', undefined],
    ]);

    // A shop that lists none says so.
    const none = await renderer.render({ path: '/pages/stores' }, listed(documents.shop).fresh());
    expect(none.html).toContain('Our stores will be listed here soon.');
    expect(none.html).not.toContain('<select');
  });
});
