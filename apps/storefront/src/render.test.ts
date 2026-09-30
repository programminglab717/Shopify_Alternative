import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { MemoryStore, type MenuLinkDoc } from '@hatti/storefront-data';
import { sampleStore } from './fixtures.js';
import { PageRenderer, type PageRequest, type RenderStat, type RendererOptions } from './render.js';
import {
  loadTheme,
  overlayTheme,
  readThemeDir,
  ThemeError,
  type SectionList,
  type ThemeFiles,
} from './theme.js';

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
      'whatsapp',
      'footer-group__footer',
    ]);
    // Blocks in their order, images sized so nothing shifts, and a srcset for small phones.
    expect(page.html).toMatch(/<h1 class="banner__heading" dir="auto">Eid Lawn &#39;26<\/h1>/);
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
    for (const path of ['/products/nothing', '/collections/nothing', '/pages/about']) {
      const page = await render({ path });
      expect(page.status, path).toBe(404);
      expect(page.html, path).toContain('Page not found');
    }
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
    const page = await render({ path: '/' }, { latencyMs: 40, limits: { timeMs: 30 } });
    const failed = page.renders.filter((stat) => stat.error === 'time').map((stat) => stat.id);
    // Sections waiting on menus or products run out of time; those that wait for nothing do not.
    expect(failed).toEqual(
      expect.arrayContaining(['header-group__header', 'lawn', 'khussa', 'kurta']),
    );
    expect(page.renders.find((stat) => stat.id === 'banner')?.error).toBeNull();
    expect(page.html).toContain('Eid Lawn &#39;26');
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
    ]);
    expect(page.html).toContain('<h1 class="banner__heading" dir="auto">Winter Sale</h1>');
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
    expect(page.html).toContain('<a class="button" href="/collections/all">Shop</a>');
    expect(page.html).not.toMatch(/display: none|javascript:|<script>alert/);
  });
});
