import { runInNewContext } from 'node:vm';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { BUY_BUTTON_SCRIPT, buyButtonSnippet, type BuyButtonProduct } from './buy-button.js';

describe('Buy buttons (CH-08, ADR-860)', () => {
  it('gives a snippet naming the product, the script served by the shop', () => {
    expect(buyButtonSnippet('https://zari.hatti.pk', 'lawn-suit', 'ur')).toBe(
      '<div data-hatti-buy-button="lawn-suit" data-language="ur"></div>\n' +
        '<script src="https://zari.hatti.pk/buy-button.js" async></script>',
    );
    // Nothing but a handle's letters goes into the markup.
    expect(buyButtonSnippet('https://zari.hatti.pk', 'x"><script>')).toContain(
      'data-hatti-buy-button="xscript"',
    );
  });

  it('is a script that parses, and does nothing where it was not loaded as a script', () => {
    expect(() =>
      runInNewContext(BUY_BUTTON_SCRIPT, { document: { currentScript: null } }),
    ).not.toThrow();
  });

  it('draws the product in its own shadow root, and buys the variant chosen through a permalink', async () => {
    const product: BuyButtonProduct = {
      handle: 'lawn-suit',
      title: 'Lawn suit <b>new</b>',
      url: 'https://zari.hatti.pk/products/lawn-suit',
      image: { src: 'https://zari.hatti.pk/img/lawn.jpg', alt: 'Lawn suit' },
      currency: 'PKR',
      variants: [
        { id: 'v-s', title: 'Small', available: false, price: '2500.00', compareAtPrice: null },
        {
          id: 'v-m',
          title: 'Medium',
          available: true,
          price: '2500.00',
          compareAtPrice: '3000.00',
        },
      ],
    };
    const window = new Window({ url: 'https://blog.example.pk/' });
    const document = window.document;
    document.body.innerHTML = '<div data-hatti-buy-button="lawn-suit" data-language="ur"></div>';
    const asked: string[] = [];
    window.fetch = (async (url: string) => {
      asked.push(url);
      return { ok: true, json: async () => product };
    }) as never;
    const script = document.createElement('script');
    script.setAttribute('src', 'https://zari.hatti.pk/buy-button.js');
    Object.defineProperty(document, 'currentScript', { value: script });
    window.eval(BUY_BUTTON_SCRIPT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(asked).toEqual(['https://zari.hatti.pk/buy-button/products/lawn-suit']);
    const root = document.querySelector('[data-hatti-buy-button]')!.shadowRoot!;
    // The title as words, never as markup.
    expect(root.querySelector('.title')!.textContent).toBe('Lawn suit <b>new</b>');
    expect(root.querySelector('.title b')).toBeNull();
    // The first variant to be had, in Urdu.
    const buy = root.querySelector('.buy')!;
    expect(buy.textContent).toBe('ابھی خریدیں');
    expect(buy.getAttribute('href')).toBe('https://zari.hatti.pk/cart/v-m:1');
    expect(root.querySelector('.price')!.textContent).toBe('Rs 2,500Rs 3,000');
    const select = root.querySelector('select')! as unknown as {
      value: string;
      dispatchEvent: (event: unknown) => void;
    };
    select.value = '0';
    select.dispatchEvent(new window.Event('change'));
    expect(buy.textContent).toBe('ختم ہو گیا');
    expect(buy.getAttribute('aria-disabled')).toBe('true');
    await window.happyDOM.close();
  });

  it("keeps a cart of the page's own across the shop's buttons, its bar checking all of it out (ADR-918)", async () => {
    const product = (handle: string, id: string): BuyButtonProduct => ({
      handle,
      title: handle,
      url: `https://zari.hatti.pk/products/${handle}`,
      image: null,
      currency: 'PKR',
      variants: [{ id, title: 'Default', available: true, price: '1000.00', compareAtPrice: null }],
    });
    const window = new Window({ url: 'https://blog.example.pk/' });
    const document = window.document;
    document.body.innerHTML =
      '<div data-hatti-buy-button="kurta"></div><div data-hatti-buy-button="shawl"></div>';
    window.fetch = (async (url: string) => ({
      ok: true,
      json: async () =>
        url.endsWith('/kurta') ? product('kurta', 'v-kurta') : product('shawl', 'v-shawl'),
    })) as never;
    const run = async () => {
      const script = document.createElement('script');
      script.setAttribute('src', 'https://zari.hatti.pk/buy-button.js');
      Object.defineProperty(document, 'currentScript', { value: script, configurable: true });
      window.eval(BUY_BUTTON_SCRIPT);
      await new Promise((resolve) => setTimeout(resolve, 10));
    };
    await run();
    const [kurta, shawl] = [...document.querySelectorAll('[data-hatti-buy-button]')].map(
      (host) => host.shadowRoot!,
    );
    const press = (root: typeof kurta) =>
      (root!.querySelector('.add') as unknown as { click: () => void }).click();
    // No cart yet: no bar.
    const barHost = () => document.querySelector('[data-hatti-buy-button-cart]');
    expect(barHost()).toBeNull();
    press(kurta);
    press(kurta);
    press(shawl);
    const bar = barHost()!.shadowRoot!;
    expect(bar.querySelector('.count')!.textContent).toBe('3 in your cart');
    expect(bar.querySelector('.go')!.getAttribute('href')).toBe(
      'https://zari.hatti.pk/cart/v-kurta:2,v-shawl:1',
    );
    // Kept by the page's browser, for the shop: on the next visit it is there.
    expect(
      JSON.parse(window.localStorage.getItem('hatti-buy-button-cart:https://zari.hatti.pk')!),
    ).toEqual([
      { id: 'v-kurta', quantity: 2 },
      { id: 'v-shawl', quantity: 1 },
    ]);
    // Emptied, the bar hides.
    (bar.querySelector('.empty') as unknown as { click: () => void }).click();
    expect((barHost() as unknown as { hidden: boolean }).hidden).toBe(true);
    expect(window.localStorage.getItem('hatti-buy-button-cart:https://zari.hatti.pk')).toBe('[]');
    await window.happyDOM.close();
  });

  it("embeds a collection as a grid of its products' buttons, in the shop's colour (ADR-925)", async () => {
    expect(
      buyButtonSnippet('https://zari.hatti.pk', 'eid-edit', 'en', {
        collection: true,
        color: '#7c2d12',
      }),
    ).toBe(
      '<div data-hatti-buy-collection="eid-edit" data-color="#7c2d12"></div>\n' +
        '<script src="https://zari.hatti.pk/buy-button.js" async></script>',
    );
    // A colour that is no colour is left out.
    expect(
      buyButtonSnippet('https://zari.hatti.pk', 'eid-edit', 'en', { color: 'red;x' }),
    ).not.toContain('data-color');

    const product = (handle: string, id: string): BuyButtonProduct => ({
      handle,
      title: handle,
      url: `https://zari.hatti.pk/products/${handle}`,
      image: null,
      currency: 'PKR',
      variants: [{ id, title: 'Default', available: true, price: '1500.00', compareAtPrice: null }],
    });
    const window = new Window({ url: 'https://blog.example.pk/' });
    const document = window.document;
    document.body.innerHTML =
      '<div data-hatti-buy-collection="eid-edit" data-color="#7c2d12"></div>';
    const asked: string[] = [];
    window.fetch = (async (url: string) => {
      asked.push(url);
      return {
        ok: true,
        json: async () => ({
          handle: 'eid-edit',
          title: 'Eid edit',
          url: 'https://zari.hatti.pk/collections/eid-edit',
          products: [product('kurta', 'v-k'), product('dupatta', 'v-d')],
        }),
      };
    }) as never;
    const script = document.createElement('script');
    script.setAttribute('src', 'https://zari.hatti.pk/buy-button.js');
    Object.defineProperty(document, 'currentScript', { value: script });
    window.eval(BUY_BUTTON_SCRIPT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(asked).toEqual(['https://zari.hatti.pk/buy-button/collections/eid-edit']);
    const host = document.querySelector('[data-hatti-buy-collection]')!;
    expect(host.getAttribute('style')).toContain('--hatti-color: #7c2d12');
    const grid = host.shadowRoot!;
    expect(grid.querySelector('.heading')!.textContent).toBe('Eid edit');
    const cards = [...grid.querySelectorAll('.grid > div')].map((cell) => cell.shadowRoot!);
    expect(cards.map((card) => card.querySelector('.buy')!.getAttribute('href'))).toEqual([
      'https://zari.hatti.pk/cart/v-k:1',
      'https://zari.hatti.pk/cart/v-d:1',
    ]);
    await window.happyDOM.close();
  });

  it('shows a collection twelve products at a time, Show more giving the next (ADR-937)', async () => {
    const product = (handle: string): BuyButtonProduct => ({
      handle,
      title: handle,
      url: `https://zari.hatti.pk/products/${handle}`,
      image: null,
      currency: 'PKR',
      variants: [
        {
          id: `v-${handle}`,
          title: 'Default',
          available: true,
          price: '1500.00',
          compareAtPrice: null,
        },
      ],
    });
    const window = new Window({ url: 'https://blog.example.pk/' });
    const document = window.document;
    document.body.innerHTML = '<div data-hatti-buy-collection="eid-edit" data-language="ur"></div>';
    const asked: string[] = [];
    window.fetch = (async (url: string) => {
      asked.push(url);
      const second = url.endsWith('?page=2');
      return {
        ok: true,
        json: async () => ({
          handle: 'eid-edit',
          title: 'Eid edit',
          url: 'https://zari.hatti.pk/collections/eid-edit',
          products: second ? [product('shawl')] : [product('kurta'), product('dupatta')],
          next: second ? null : 2,
        }),
      };
    }) as never;
    const script = document.createElement('script');
    script.setAttribute('src', 'https://zari.hatti.pk/buy-button.js');
    Object.defineProperty(document, 'currentScript', { value: script });
    window.eval(BUY_BUTTON_SCRIPT);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const grid = document.querySelector('[data-hatti-buy-collection]')!.shadowRoot!;
    const cards = () => grid.querySelectorAll('.grid > div').length;
    expect(cards()).toBe(2);
    const more = grid.querySelector('.more') as unknown as {
      textContent: string;
      click: () => void;
    };
    expect(more.textContent).toBe('مزید دیکھیں');
    more.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(asked).toEqual([
      'https://zari.hatti.pk/buy-button/collections/eid-edit',
      'https://zari.hatti.pk/buy-button/collections/eid-edit?page=2',
    ]);
    // Its last page: three in all, and no more to show.
    expect(cards()).toBe(3);
    expect(grid.querySelector('.more')).toBeNull();
    await window.happyDOM.close();
  });

  it('lays a product out across, and a collection as a list or a carousel (ADR-949)', async () => {
    const origin = 'https://zari.hatti.pk';
    expect(buyButtonSnippet(origin, 'lawn-suit', 'en', { layout: 'horizontal' })).toContain(
      '<div data-hatti-buy-button="lawn-suit" data-layout="horizontal"></div>',
    );
    expect(
      buyButtonSnippet(origin, 'eid-edit', 'en', { collection: true, layout: 'carousel' }),
    ).toContain('data-layout="carousel"');
    // Its default, or one not of its kind, is left out.
    expect(buyButtonSnippet(origin, 'lawn-suit', 'en', { layout: 'card' })).not.toContain(
      'data-layout',
    );
    expect(buyButtonSnippet(origin, 'lawn-suit', 'en', { layout: 'carousel' })).not.toContain(
      'data-layout',
    );
    expect(
      buyButtonSnippet(origin, 'eid-edit', 'en', { collection: true, layout: '"><x' }),
    ).not.toContain('data-layout');

    const product = (handle: string): BuyButtonProduct => ({
      handle,
      title: handle,
      url: `${origin}/products/${handle}`,
      image: { src: `${origin}/img/${handle}.jpg`, alt: handle },
      currency: 'PKR',
      variants: [
        {
          id: `v-${handle}`,
          title: 'Default',
          available: true,
          price: '1500.00',
          compareAtPrice: null,
        },
      ],
    });
    const window = new Window({ url: 'https://blog.example.pk/' });
    const document = window.document;
    document.body.innerHTML =
      '<div data-hatti-buy-button="kurta" data-layout="horizontal"></div>' +
      '<div data-hatti-buy-collection="eid" data-layout="list"></div>' +
      '<div data-hatti-buy-collection="sale" data-layout="carousel"></div>';
    window.fetch = (async (url: string) => ({
      ok: true,
      json: async () =>
        url.includes('/products/')
          ? product('kurta')
          : {
              handle: 'eid',
              title: 'Eid',
              url: `${origin}/collections/eid`,
              products: [product('kurta'), product('dupatta')],
            },
    })) as never;
    const script = document.createElement('script');
    script.setAttribute('src', `${origin}/buy-button.js`);
    Object.defineProperty(document, 'currentScript', { value: script });
    window.eval(BUY_BUTTON_SCRIPT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const [single, list, carousel] = [
      ...document.querySelectorAll('[data-hatti-buy-button],[data-hatti-buy-collection]'),
    ].map((host) => host.shadowRoot!);
    expect(single!.querySelector('.card')!.getAttribute('class')).toBe('card wide');
    expect(list!.querySelector('.grid')!.getAttribute('class')).toBe('grid list');
    // A list's products across, each card wide.
    const cells = [...list!.querySelectorAll('.grid > div')];
    expect(cells.map((cell) => cell.getAttribute('data-layout'))).toEqual([
      'horizontal',
      'horizontal',
    ]);
    expect(cells[0]!.shadowRoot!.querySelector('.card')!.getAttribute('class')).toBe('card wide');
    expect(carousel!.querySelector('.grid')!.getAttribute('class')).toBe('grid carousel');
    expect(carousel!.querySelector('.heading')!.textContent).toBe('Eid');
    const carouselCard = carousel!.querySelector('.grid > div')!.shadowRoot!.querySelector('.card');
    expect(carouselCard!.getAttribute('class')).toBe('card');
    await window.happyDOM.close();
  });

  it('leads a collection with the product it features, across, and not again in its grid (ADR-980)', async () => {
    const origin = 'https://zari.hatti.pk';
    expect(
      buyButtonSnippet(origin, 'eid-edit', 'en', { collection: true, featured: 'lawn-suit' }),
    ).toContain('<div data-hatti-buy-collection="eid-edit" data-featured="lawn-suit"></div>');
    // Only a collection features a product, and only by a handle.
    expect(buyButtonSnippet(origin, 'lawn-suit', 'en', { featured: 'kurta' })).not.toContain(
      'data-featured',
    );
    expect(
      buyButtonSnippet(origin, 'eid-edit', 'en', { collection: true, featured: '"><x' }),
    ).toContain('data-featured="x"');

    const product = (handle: string): BuyButtonProduct => ({
      handle,
      title: handle,
      url: `${origin}/products/${handle}`,
      image: null,
      currency: 'PKR',
      variants: [
        {
          id: `v-${handle}`,
          title: 'Default',
          available: true,
          price: '1500.00',
          compareAtPrice: null,
        },
      ],
    });
    const window = new Window({ url: 'https://blog.example.pk/' });
    const document = window.document;
    document.body.innerHTML =
      '<div data-hatti-buy-collection="eid" data-featured="dupatta"></div>' +
      '<div data-hatti-buy-collection="eid" data-featured="gone"></div>';
    const asked: string[] = [];
    window.fetch = (async (url: string) => {
      asked.push(url);
      if (url.endsWith('/products/gone')) return { ok: false, json: async () => null };
      return {
        ok: true,
        json: async () =>
          url.includes('/products/')
            ? product('dupatta')
            : {
                handle: 'eid',
                title: 'Eid',
                url: `${origin}/collections/eid`,
                products: [product('kurta'), product('dupatta'), product('shawl')],
              },
      };
    }) as never;
    const script = document.createElement('script');
    script.setAttribute('src', `${origin}/buy-button.js`);
    Object.defineProperty(document, 'currentScript', { value: script });
    window.eval(BUY_BUTTON_SCRIPT);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(asked).toContain(`${origin}/buy-button/products/dupatta`);
    const [led, missing] = [...document.querySelectorAll('[data-hatti-buy-collection]')].map(
      (host) => host.shadowRoot!,
    );
    const lead = led!.querySelector('.featured')!;
    expect(lead.getAttribute('data-layout')).toBe('horizontal');
    const leadCard = lead.shadowRoot!.querySelector('.card')!;
    expect(leadCard.getAttribute('class')).toBe('card wide');
    expect(leadCard.querySelector('.title')!.textContent).toBe('dupatta');
    const titles = (root: typeof led) =>
      [...root!.querySelectorAll('.grid > div')].map(
        (cell) => cell.shadowRoot!.querySelector('.title')!.textContent,
      );
    expect(titles(led)).toEqual(['kurta', 'shawl']);
    // A product no longer sold: the collection as it is, nothing above it.
    expect(missing!.querySelector('.featured')).toBeNull();
    await window.happyDOM.close();
  });

  it('leads a collection with up to three products it features, in its order (ADR-984)', async () => {
    const origin = 'https://zari.hatti.pk';
    expect(
      buyButtonSnippet(origin, 'eid', 'en', {
        collection: true,
        featured: ['shawl', 'kurta', 'shawl', '', 'khussa', 'dupatta'],
      }),
    ).toContain('data-featured="shawl,kurta,khussa"');

    const product = (handle: string): BuyButtonProduct => ({
      handle,
      title: handle,
      url: `${origin}/products/${handle}`,
      image: null,
      currency: 'PKR',
      variants: [
        {
          id: `v-${handle}`,
          title: 'Default',
          available: true,
          price: '1500.00',
          compareAtPrice: null,
        },
      ],
    });
    const window = new Window({ url: 'https://blog.example.pk/' });
    const document = window.document;
    // A fourth is one too many; the second, answered first, keeps its place.
    document.body.innerHTML =
      '<div data-hatti-buy-collection="eid" data-featured="shawl,kurta,dupatta,khussa"></div>';
    window.fetch = (async (url: string) => {
      if (url.endsWith('/products/shawl')) await new Promise((resolve) => setTimeout(resolve, 5));
      const handle = url.split('/').pop()!;
      return {
        ok: true,
        json: async () =>
          url.includes('/products/')
            ? product(handle)
            : {
                handle: 'eid',
                title: 'Eid',
                url: `${origin}/collections/eid`,
                products: ['kurta', 'dupatta', 'shawl', 'khussa'].map(product),
              },
      };
    }) as never;
    const script = document.createElement('script');
    script.setAttribute('src', `${origin}/buy-button.js`);
    Object.defineProperty(document, 'currentScript', { value: script });
    window.eval(BUY_BUTTON_SCRIPT);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const root = document.querySelector('[data-hatti-buy-collection]')!.shadowRoot!;
    const titlesOf = (selector: string) =>
      [...root.querySelectorAll(selector)].map(
        (cell) => cell.shadowRoot!.querySelector('.title')!.textContent,
      );
    expect(titlesOf('.featured')).toEqual(['shawl', 'kurta', 'dupatta']);
    expect(titlesOf('.grid > div')).toEqual(['khussa']);
    await window.happyDOM.close();
  });
});
