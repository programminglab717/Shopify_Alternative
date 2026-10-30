import type { CollectionDoc, ProductDoc } from '@hatti/storefront-data';
import { imageAddress } from './liquid.js';

// Buy buttons (CH-08, ADR-860): a shop's products on any other website, as Shopify's Buy Button
// puts them. The page pastes a snippet: an element naming a product by its handle, and this
// script, served by the shop's own storefront. The script reads the product from the storefront,
// public as its pages are, and shows its photo, title, price and variants, in English or Urdu;
// Buy now opens the shop's checkout holding it, through a cart permalink (ADR-709). Add to cart
// keeps it in a cart of the page's own, across the shop's buttons there, its bar opening the
// checkout holding all of it (ADR-918). A collection is embedded as a grid of its products, each
// with its buttons, twelve at a time, Show more giving the next (ADR-937); and the buttons take the
// shop's colour (ADR-925). A product may be laid out with its photo beside it, and a collection as a
// list of those or a carousel, rather than a grid (ADR-949). A collection may lead with one of its
// products, shown across above the rest and not again among them (ADR-980).

/** A buy button's cart (ADR-918): its lines at most, and as many of each. */
export const BUY_BUTTON_CART = { lines: 20, quantity: 10 } as const;

export const BUY_BUTTON_PATHS = {
  script: '/buy-button.js',
  product: '/buy-button/products/:handle',
  collection: '/buy-button/collections/:handle',
} as const;

/**
 * How many of a collection's products its embed shows at a time, in its order (ADR-925): a page
 * of them, and pages up to the hundredth (ADR-937).
 */
export const BUY_BUTTON_COLLECTION = { products: 12, pages: 100 } as const;

/**
 * How an embed is laid out (ADR-949), the first of each its default: a product as a card, or
 * across with its photo beside it; a collection as a grid of cards, a list of products across, or
 * a carousel scrolled sideways.
 */
export const BUY_BUTTON_LAYOUTS = {
  product: ['card', 'horizontal'],
  collection: ['grid', 'list', 'carousel'],
} as const;

/** A colour for the buttons, as the snippet gives it: "#0f766e". */
const COLOR = /^#[0-9a-fA-F]{6}$/;

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

/** A collection as its embed shows it (ADR-925): its title, address and a page of its products. */
export interface BuyButtonCollection {
  handle: string;
  title: string;
  url: string;
  products: BuyButtonProduct[];
  /** The page after this one, where it has more products (ADR-937); null at its last. */
  next: number | null;
}

/** The page of a collection's embed `asked` names, 1 unless it names another it may have. */
export function buyButtonPage(asked: unknown): number {
  const page = Number(asked);
  return Number.isInteger(page) && page >= 1 && page <= BUY_BUTTON_COLLECTION.pages ? page : 1;
}

/**
 * The collection's embed: `products` are its page `page`'s, in its order, as the storefront shows
 * them, those with nothing to sell left out.
 */
export function buyButtonCollection(
  collection: CollectionDoc,
  products: readonly (ProductDoc | null)[],
  origin: string,
  currency: string,
  page = 1,
): BuyButtonCollection {
  const more =
    collection.productIds.length > page * BUY_BUTTON_COLLECTION.products &&
    page < BUY_BUTTON_COLLECTION.pages;
  return {
    handle: collection.handle,
    title: collection.title,
    url: `${origin}/collections/${encodeURIComponent(collection.handle)}`,
    products: products
      .filter((product): product is ProductDoc => product !== null && product.variants.length > 0)
      .map((product) => buyButtonProduct(product, origin, currency)),
    next: more ? page + 1 : null,
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
    en: { buy: 'Buy now', soldOut: 'Sold out', option: 'Choose', add: 'Add to cart',
          checkout: 'Checkout', items: ' in your cart', empty: 'Empty the cart', more: 'Show more' },
    ur: { buy: 'ابھی خریدیں', soldOut: 'ختم ہو گیا', option: 'منتخب کریں', add: 'کارٹ میں ڈالیں',
          checkout: 'چیک آؤٹ', items: ' آپ کی کارٹ میں', empty: 'کارٹ خالی کریں', more: 'مزید دیکھیں' }
  };
  // The page's cart of the shop's things (ADR-918): kept by this site's browser storage, as
  // [{ id, quantity }], ${BUY_BUTTON_CART.lines} lines and ${BUY_BUTTON_CART.quantity} of each at most.
  var KEY = 'hatti-buy-button-cart:' + origin;
  function load() {
    try {
      var kept = JSON.parse(window.localStorage.getItem(KEY) || '[]');
      return Array.isArray(kept) ? kept.filter(function (line) {
        return line && typeof line.id === 'string' && line.quantity > 0;
      }).slice(0, ${BUY_BUTTON_CART.lines}) : [];
    } catch (error) { return []; }
  }
  function keep(lines) {
    try { window.localStorage.setItem(KEY, JSON.stringify(lines)); } catch (error) {}
  }
  var bar = null;
  function drawBar(lang) {
    var words = WORDS[lang] || WORDS.en;
    var lines = load();
    if (!bar) {
      var host = el('div', { 'data-hatti-buy-button-cart': '' });
      // In the colour of the page's first button (ADR-925).
      var first = document.querySelector('[data-hatti-buy-button],[data-hatti-buy-collection]');
      if (first) colour(first, host);
      document.body.appendChild(host);
      var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
      root.appendChild(el('style', {}, BAR_STYLE));
      var box = el('div', { class: 'bar', role: 'region', lang: lang, dir: lang === 'ur' ? 'rtl' : 'ltr' });
      var count = el('span', { class: 'count', 'aria-live': 'polite' });
      var go = el('a', { class: 'go', target: '_blank', rel: 'noopener' }, words.checkout);
      var empty = el('button', { class: 'empty', type: 'button' }, words.empty);
      go.addEventListener('click', function () { keep([]); drawBar(lang); });
      empty.addEventListener('click', function () { keep([]); drawBar(lang); });
      box.appendChild(count);
      box.appendChild(go);
      box.appendChild(empty);
      root.appendChild(box);
      bar = { host: host, count: count, go: go, words: words };
    }
    var units = lines.reduce(function (sum, line) { return sum + line.quantity; }, 0);
    bar.host.hidden = units === 0;
    bar.count.textContent = units + bar.words.items;
    bar.go.setAttribute('href', origin + '/cart/' + lines.map(function (line) {
      return encodeURIComponent(line.id) + ':' + line.quantity;
    }).join(','));
  }
  function add(variant, lang) {
    var lines = load();
    var line = lines.filter(function (each) { return each.id === variant.id; })[0];
    if (line) line.quantity = Math.min(line.quantity + 1, ${BUY_BUTTON_CART.quantity});
    else if (lines.length < ${BUY_BUTTON_CART.lines}) lines.push({ id: variant.id, quantity: 1 });
    keep(lines);
    drawBar(lang);
  }
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
    ':host([data-layout=horizontal]){max-width:36rem}' +
    '.wide{display:flex}' +
    '.wide img{width:42%;flex:none}' +
    '.wide .body{flex:1;min-width:0}' +
    '.card{border:1px solid #e7e5e4;border-radius:12px;overflow:hidden;background:#fff}' +
    'img{display:block;width:100%;aspect-ratio:1;object-fit:cover}' +
    '.body{display:flex;flex-direction:column;gap:.5rem;padding:.75rem}' +
    '.title{font-weight:600;color:inherit;text-decoration:none}' +
    '.price s{color:#78716c;margin-inline-start:.4rem}' +
    'select{font:inherit;padding:.4rem;border:1px solid #d6d3d1;border-radius:8px}' +
    '.buy{display:block;text-align:center;padding:.6rem;border-radius:8px;background:var(--hatti-color,#0f766e);color:#fff;font-weight:600;text-decoration:none}' +
    '.buy[aria-disabled=true]{background:#a8a29e;pointer-events:none}' +
    '.add{font:inherit;padding:.55rem;border:1px solid var(--hatti-color,#0f766e);border-radius:8px;background:#fff;color:var(--hatti-color,#0f766e);font-weight:600;cursor:pointer}' +
    '.add[disabled]{border-color:#a8a29e;color:#a8a29e;cursor:default}';
  var BAR_STYLE =
    ':host{all:initial;position:fixed;inset-inline:1rem;bottom:1rem;z-index:2147483000;font:15px/1.4 system-ui,sans-serif}' +
    ':host([hidden]){display:none}' +
    '.bar{display:flex;flex-wrap:wrap;align-items:center;gap:.75rem;max-width:28rem;margin:auto;padding:.6rem .9rem;border-radius:12px;background:#1c1917;color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.25)}' +
    '.count{flex:1}' +
    '.go{padding:.45rem .9rem;border-radius:8px;background:var(--hatti-color,#0f766e);color:#fff;font-weight:600;text-decoration:none}' +
    '.empty{font:inherit;background:none;border:0;color:#d6d3d1;text-decoration:underline;cursor:pointer}';
  function draw(host, product, lang) {
    var words = WORDS[lang] || WORDS.en;
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    root.appendChild(el('style', {}, STYLE));
    // Across, its photo beside it (ADR-949).
    var wide = host.getAttribute('data-layout') === 'horizontal';
    var card = el('div', { class: wide ? 'card wide' : 'card', lang: lang, dir: lang === 'ur' ? 'rtl' : 'ltr' });
    if (product.image) card.appendChild(el('img', { src: product.image.src, alt: product.image.alt, loading: 'lazy' }));
    var body = el('div', { class: 'body' });
    var title = el('a', { class: 'title', href: product.url, target: '_blank', rel: 'noopener' }, product.title);
    var price = el('div', { class: 'price' });
    var buy = el('a', { class: 'buy', target: '_blank', rel: 'noopener' });
    var put = el('button', { class: 'add', type: 'button' }, words.add);
    var chosen = null;
    put.addEventListener('click', function () { if (chosen && chosen.available) add(chosen, lang); });
    var choose = null;
    function show(variant) {
      chosen = variant;
      if (variant.available) put.removeAttribute('disabled');
      else put.setAttribute('disabled', '');
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
    body.appendChild(put);
    card.appendChild(body);
    root.appendChild(card);
    var first = product.variants.filter(function (variant) { return variant.available; })[0] || product.variants[0];
    if (choose) choose.value = String(product.variants.indexOf(first));
    show(first);
  }
  var GRID_STYLE =
    ':host{all:initial;display:block;font:15px/1.4 system-ui,sans-serif;color:#1c1917}' +
    '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(12rem,1fr));gap:1rem}' +
    '.list{grid-template-columns:1fr}' +
    '.carousel{grid-template-columns:none;grid-auto-flow:column;grid-auto-columns:minmax(12rem,15rem);overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:.5rem}' +
    '.carousel>div{scroll-snap-align:start}' +
    '.heading{display:block;margin-bottom:.75rem;font-weight:700;font-size:1.2em;color:inherit;text-decoration:none}' +
    '.more{grid-column:1/-1;justify-self:center;padding:.6rem 1.2rem;border:1px solid var(--hatti-color,#0f766e);border-radius:8px;background:#fff;color:var(--hatti-color,#0f766e);font:inherit;font-weight:600;cursor:pointer}' +
    '.carousel .more{grid-column:auto;align-self:center}' +
    '.featured{margin-bottom:1rem}';
  // A collection (ADR-925): its title, then each of its products as a button of its own, a page
  // at a time, Show more giving the next (ADR-937); in a grid, a list or a carousel (ADR-949);
  // led by the product the snippet features, across (ADR-980).
  function drawCollection(host, collection, lang) {
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    root.appendChild(el('style', {}, GRID_STYLE));
    var layout = host.getAttribute('data-layout');
    var shape = layout === 'list' || layout === 'carousel' ? ' ' + layout : '';
    var box = el('div', { lang: lang, dir: lang === 'ur' ? 'rtl' : 'ltr' });
    box.appendChild(el('a', { class: 'heading', href: collection.url, target: '_blank', rel: 'noopener' }, collection.title));
    var featured = (host.getAttribute('data-featured') || '').replace(/[^a-z0-9-]/g, '');
    if (featured) {
      var lead = el('div', { class: 'featured', 'data-layout': 'horizontal' });
      box.appendChild(lead);
      fetch(origin + '/buy-button/products/' + encodeURIComponent(featured))
        .then(function (answer) { return answer.ok ? answer.json() : null; })
        .then(function (found) {
          if (found && found.variants && found.variants.length) draw(lead, found, lang);
          else box.removeChild(lead);
        })
        .catch(function () { if (lead.parentNode) box.removeChild(lead); });
    }
    var grid = el('div', { class: 'grid' + shape });
    box.appendChild(grid);
    function add(page) {
      page.products.forEach(function (product) {
        // The featured product is shown once, above.
        if (featured && product.handle === featured) return;
        // A list's products across, their photos beside them.
        var cell = el('div', layout === 'list' ? { 'data-layout': 'horizontal' } : {});
        grid.appendChild(cell);
        draw(cell, product, lang);
      });
      if (!page.next) return;
      var more = el('button', { class: 'more', type: 'button' }, WORDS[lang].more);
      more.addEventListener('click', function () {
        more.disabled = true;
        fetch(origin + '/buy-button/collections/' + encodeURIComponent(collection.handle) + '?page=' + page.next)
          .then(function (answer) { return answer.ok ? answer.json() : null; })
          .then(function (found) {
            if (!found) { more.disabled = false; return; }
            grid.removeChild(more);
            add(found);
          })
          .catch(function () { more.disabled = false; });
      });
      grid.appendChild(more);
    }
    add(collection);
    root.appendChild(box);
  }
  // The shop's colour for the buttons, as the snippet says it; the platform's teal otherwise.
  function colour(host, target) {
    var color = host.getAttribute('data-color') || '';
    if (/^#[0-9a-fA-F]{6}$/.test(color)) target.style.setProperty('--hatti-color', color);
  }
  var hosts = document.querySelectorAll('[data-hatti-buy-button],[data-hatti-buy-collection]');
  // A cart kept from an earlier visit shows at once.
  if (hosts.length && load().length) {
    drawBar(hosts[0].getAttribute('data-language') === 'ur' ? 'ur' : 'en');
  }
  Array.prototype.forEach.call(hosts, function (host) {
    if (host.getAttribute('data-hatti-drawn')) return;
    host.setAttribute('data-hatti-drawn', '1');
    colour(host, host);
    var lang = host.getAttribute('data-language') === 'ur' ? 'ur' : 'en';
    var collection = host.getAttribute('data-hatti-buy-collection');
    var path = collection
      ? '/buy-button/collections/' + encodeURIComponent(collection)
      : '/buy-button/products/' + encodeURIComponent(host.getAttribute('data-hatti-buy-button'));
    fetch(origin + path)
      .then(function (answer) { return answer.ok ? answer.json() : null; })
      .then(function (found) {
        if (!found) return;
        if (collection) { if (found.products && found.products.length) drawCollection(host, found, lang); }
        else if (found.variants && found.variants.length) draw(host, found, lang);
      })
      .catch(function () {});
  });
})();
`;

/**
 * The snippet a shop pastes into another website for the product `handle`, or with
 * `collection` the collection's (ADR-925), in `language`, its buttons in `color` where given, laid
 * out as `layout` says, one of {@link BUY_BUTTON_LAYOUTS} for its kind (ADR-949); a collection's
 * led by its product `featured` where given (ADR-980).
 */
export function buyButtonSnippet(
  origin: string,
  handle: string,
  language: 'en' | 'ur' = 'en',
  options: {
    collection?: boolean;
    color?: string | null;
    layout?: string | null;
    featured?: string | null;
  } = {},
): string {
  const lang = language === 'ur' ? ' data-language="ur"' : '';
  const color = options.color && COLOR.test(options.color) ? ` data-color="${options.color}"` : '';
  const kind = options.collection ? 'data-hatti-buy-collection' : 'data-hatti-buy-button';
  const layouts: readonly string[] =
    BUY_BUTTON_LAYOUTS[options.collection ? 'collection' : 'product'];
  // Its default needs saying no more than a layout it hasn't.
  const layout =
    options.layout && layouts.indexOf(options.layout) > 0 ? ` data-layout="${options.layout}"` : '';
  const lead = options.featured?.replace(/[^a-z0-9-]/g, '');
  const featured = options.collection && lead ? ` data-featured="${lead}"` : '';
  return (
    `<div ${kind}="${handle.replace(/[^a-z0-9-]/g, '')}"${lang}${color}${layout}${featured}></div>\n` +
    `<script src="${origin}${BUY_BUTTON_PATHS.script}" async></script>`
  );
}
