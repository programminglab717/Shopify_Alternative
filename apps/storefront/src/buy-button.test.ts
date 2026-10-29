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
});
