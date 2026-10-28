import type { ProductDoc } from '@hatti/storefront-data';
import { imageAddress } from './liquid.js';

// Buy buttons (CH-08, ADR-860): a shop's products on any other website, as Shopify's Buy Button
// puts them. The page pastes a snippet: an element naming a product by its handle, and this
// script, served by the shop's own storefront. The script reads the product from the storefront,
// public as its pages are, and shows its photo, title, price and variants, in English or Urdu;
// Buy now opens the shop's checkout holding it, through a cart permalink (ADR-709).

export const BUY_BUTTON_PATHS = {
  script: '/buy-button.js',
  product: '/buy-button/products/:handle',
} as const;

/** A product as the buy button shows it: prices in the shop's currency, as decimals. */
export interface BuyButtonProduct {
  handle: string;
  title: string;
  url: string;
  image: { src: string; alt: string } | null;
  currency: string;
  variants: {
    id: string;
    title: string;
    available: boolean;
    price: string;
    compareAtPrice: string | null;
  }[];
}

const major = (minor: number) => (minor / 100).toFixed(2);

export function buyButtonProduct(
  product: ProductDoc,
  origin: string,
  currency: string,
): BuyButtonProduct {
  const image = product.images[0];
  return {
    handle: product.handle,
    title: product.title,
    url: `${origin}/products/${encodeURIComponent(product.handle)}`,
    image: image
      ? { src: imageAddress(image.src, origin, 600), alt: image.alt ?? product.title }
      : null,
    currency,
    variants: product.variants.map((variant) => ({
      id: variant.id,
      title: variant.title,
      available: variant.available,
      price: major(variant.price),
      compareAtPrice:
        variant.compareAtPrice !== null && variant.compareAtPrice > variant.price
          ? major(variant.compareAtPrice)
          : null,
    })),
  };
}

/**
 * The script itself, the same for every shop: it finds where it was served from, reads each
 * `[data-hatti-buy-button]` element's product, and draws it in a shadow root of its own, so that
 * the page's styles and the button's leave each other alone. Its words go in as text, never as
 * markup.
 */
export const BUY_BUTTON_SCRIPT = `(function () {
  var script = document.currentScript;
  if (!script) return;
  var origin = new URL(script.src).origin;
  var WORDS = {
    en: { buy: 'Buy now', soldOut: 'Sold out', option: 'Choose' },
    ur: { buy: 'ابھی خریدیں', soldOut: 'ختم ہو گیا', option: 'منتخب کریں' }
  };
  function money(amount, currency) {
    var value = Number(amount);
    var shown = value.toLocaleString('en', {
      minimumFractionDigits: value % 1 ? 2 : 0,
      maximumFractionDigits: 2
    });
    return (currency === 'PKR' ? 'Rs ' : currency + ' ') + shown;
  }
  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    for (var key in attrs) node.setAttribute(key, attrs[key]);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  var STYLE =
    ':host{all:initial;display:block;max-width:20rem;font:15px/1.4 system-ui,sans-serif;color:#1c1917}' +
    '.card{border:1px solid #e7e5e4;border-radius:12px;overflow:hidden;background:#fff}' +
    'img{display:block;width:100%;aspect-ratio:1;object-fit:cover}' +
    '.body{display:flex;flex-direction:column;gap:.5rem;padding:.75rem}' +
    '.title{font-weight:600;color:inherit;text-decoration:none}' +
    '.price s{color:#78716c;margin-inline-start:.4rem}' +
    'select{font:inherit;padding:.4rem;border:1px solid #d6d3d1;border-radius:8px}' +
    '.buy{display:block;text-align:center;padding:.6rem;border-radius:8px;background:#0f766e;color:#fff;font-weight:600;text-decoration:none}' +
    '.buy[aria-disabled=true]{background:#a8a29e;pointer-events:none}';
  function draw(host, product, lang) {
    var words = WORDS[lang] || WORDS.en;
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    root.appendChild(el('style', {}, STYLE));
    var card = el('div', { class: 'card', lang: lang, dir: lang === 'ur' ? 'rtl' : 'ltr' });
    if (product.image) card.appendChild(el('img', { src: product.image.src, alt: product.image.alt, loading: 'lazy' }));
    var body = el('div', { class: 'body' });
    var title = el('a', { class: 'title', href: product.url, target: '_blank', rel: 'noopener' }, product.title);
    var price = el('div', { class: 'price' });
    var buy = el('a', { class: 'buy', target: '_blank', rel: 'noopener' });
    var choose = null;
    function show(variant) {
      price.textContent = money(variant.price, product.currency);
      if (variant.compareAtPrice) price.appendChild(el('s', {}, money(variant.compareAtPrice, product.currency)));
      buy.textContent = variant.available ? words.buy : words.soldOut;
      buy.setAttribute('aria-disabled', variant.available ? 'false' : 'true');
      buy.setAttribute('href', origin + '/cart/' + encodeURIComponent(variant.id) + ':1');
    }
    body.appendChild(title);
    body.appendChild(price);
    if (product.variants.length > 1) {
      choose = el('select', { 'aria-label': words.option });
      product.variants.forEach(function (variant, index) {
        choose.appendChild(el('option', { value: String(index) }, variant.title));
      });
      choose.addEventListener('change', function () {
        show(product.variants[Number(choose.value)]);
      });
      body.appendChild(choose);
    }
    body.appendChild(buy);
    card.appendChild(body);
    root.appendChild(card);
    var first = product.variants.filter(function (variant) { return variant.available; })[0] || product.variants[0];
    if (choose) choose.value = String(product.variants.indexOf(first));
    show(first);
  }
  var hosts = document.querySelectorAll('[data-hatti-buy-button]');
  Array.prototype.forEach.call(hosts, function (host) {
    if (host.getAttribute('data-hatti-drawn')) return;
    host.setAttribute('data-hatti-drawn', '1');
    var handle = host.getAttribute('data-hatti-buy-button');
    var lang = host.getAttribute('data-language') === 'ur' ? 'ur' : 'en';
    fetch(origin + '/buy-button/products/' + encodeURIComponent(handle))
      .then(function (answer) { return answer.ok ? answer.json() : null; })
      .then(function (product) { if (product && product.variants.length) draw(host, product, lang); })
      .catch(function () {});
  });
})();
`;

/** The snippet a shop pastes into another website for `handle`, in `language`. */
export function buyButtonSnippet(
  origin: string,
  handle: string,
  language: 'en' | 'ur' = 'en',
): string {
  const lang = language === 'ur' ? ' data-language="ur"' : '';
  return (
    `<div data-hatti-buy-button="${handle.replace(/[^a-z0-9-]/g, '')}"${lang}></div>\n` +
    `<script src="${origin}${BUY_BUTTON_PATHS.script}" async></script>`
  );
}
