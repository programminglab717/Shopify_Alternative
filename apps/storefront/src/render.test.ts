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
      return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
        ([, json]) => JSON.parse(json!) as unknown,
      );
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
    // The shop, the collection, two menus, and 24 products in chunks of 12.
    expect((await render({ path: '/collections/eid-lawn' })).roundTrips).toBe(6);
    expect((await render({ path: '/collections/eid-lawn' }, { chunkSize: 24 })).roundTrips).toBe(5);
    // The product, and the related collection's first chunk.
    expect((await render({ path: '/products/bridal-lehenga-heavy' })).roundTrips).toBe(6);
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
    expect(count(page.html, '<li>\n        <img')).toBe(10);
    expect(page.html).toContain('fetchpriority="high"');
    // The variant asked for is the one the form adds.
    const picked = await render({
      path: '/products/bridal-lehenga-heavy',
      query: { variant: 'p-heavy-v7' },
    });
    expect(picked.html).toMatch(/value="p-heavy-v7"\s+selected/);
    expect(picked.html).toMatch(/value="Maroon"\s+checked/);
  });

  it('paginates a collection, fetching only the page shown', async () => {
    const second = await render({ path: '/collections/eid-lawn', query: { page: '2' } });
    expect(second.html).toContain('80 products');
    expect(count(second.html, 'class="card"')).toBe(24);
    expect(second.html).toMatch(/Lawn \w+ 25</);
    expect(second.html).not.toMatch(/Lawn \w+ 24</);
    expect(second.html).toContain('<span class="page current" aria-current="page">2</span>');
    expect(second.roundTrips).toBe(6);
    // Past the last page is the last page.
    const last = await render({ path: '/collections/eid-lawn', query: { page: '99' } });
    expect(count(last.html, 'class="card"')).toBe(8);
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
    expect(urdu.html).toContain('<a href="/blogs/news">News پر واپس</a>');
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
    expect(beside(first.html)).toEqual(['newer /blogs/news/how-to-measure']);
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
    const renderer = new PageRenderer(loadTheme(files));
    const data = own.fresh();
    const ready = await renderer.prepare({ path: '/products/bridal-lehenga-heavy' }, data);
    expect(ready).toMatchObject({ status: 200, domain: 'www.zari.pk' });
    expect(ready.named).toContainEqual({ kind: 'product', handle: 'bridal-lehenga-heavy' });
    // The shop and the product: the header's menu and the recommendations wait for the render.
    expect(data.roundTrips).toBe(2);
    let html = '';
    for await (const chunk of ready.stream().body) html += chunk;
    expect(html).toMatch(/<\/html>\s*$/);
    expect(data.roundTrips).toBe(6);
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
    expect(plain).not.toContain('designMode');
  });

  it("does not count the layout's wait for its sections against its own time", async () => {
    // Sections may take 100 ms each: a featured collection, fetching twice at 60 ms, goes over,
    // and the layout waits as long for them.
    const page = await render({ path: '/' }, { latencyMs: 60, limits: { timeMs: 100 } });
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
    expect(page.html).not.toContain('_campaign');
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
    expect((await render({ path: '/cart', cart: null })).html).toContain('Your cart is empty.');
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
});
