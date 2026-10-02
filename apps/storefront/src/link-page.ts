import { formatMoney, money } from '@hatti/money';
import type { LinkPageDoc, ProductDoc, ShopDoc } from '@hatti/storefront-data';
import { escapeHtml, sized } from './liquid.js';

// A shop's link-in-bio page (CH-07, ADR-161), at /links: the one address for its Instagram and
// TikTok bios and its chats. What the shop says of itself, its own links, and the products it
// chose, each a tap from checkout, in the layout of the shop's theme around markup of the
// platform's own, which Hatti Base styles.

interface LinkPageWords {
  buy: string;
  choose: string;
  soldOut: string;
  from: (price: string) => string;
  sale: string;
  regular: string;
  all: string;
  whatsapp: string;
}

/** In each language the storefront speaks; those of Hatti Base's where it has them. */
const WORDS: Readonly<Record<string, LinkPageWords>> = {
  en: {
    buy: 'Buy now',
    choose: 'Choose options',
    soldOut: 'Sold out',
    from: (price) => `From ${price}`,
    sale: 'Sale price',
    regular: 'Regular price',
    all: 'See all products',
    whatsapp: 'Chat on WhatsApp',
  },
  ur: {
    buy: 'ابھی خریدیں',
    choose: 'آپشن منتخب کریں',
    soldOut: 'ختم ہو گیا',
    from: (price) => `${price} سے شروع`,
    sale: 'سیل قیمت',
    regular: 'اصل قیمت',
    all: 'تمام مصنوعات دیکھیں',
    whatsapp: 'واٹس ایپ پر بات کریں',
  },
};

/** What the page shows: the shop's link page, and those of its products still on sale. */
export interface LinkPageShown {
  bio: string;
  links: LinkPageDoc['links'];
  /** In the shop's order. */
  products: ProductDoc[];
}

/**
 * The page, as HTML: the shop's name and what it says of itself; its links, and a chat on
 * WhatsApp where it has a number; its products, each with its price and a way to buy it, straight
 * to checkout for one with nothing to choose; and the rest of its products.
 */
export function linkPageMarkup(
  page: LinkPageShown,
  shop: Pick<ShopDoc, 'name' | 'whatsapp'>,
  language: { locale: string; prefix: string },
): string {
  const words = WORDS[language.locale] ?? WORDS.en!;
  const at = (url: string) => localized(url, language.prefix);
  const links = page.links.map((link) => ({ title: link.title, url: at(link.url) }));
  if (shop.whatsapp) {
    links.push({ title: words.whatsapp, url: `https://wa.me/${shop.whatsapp.replace(/\D/g, '')}` });
  }
  const linkItems = links.map(
    (link) =>
      `<li><a class="button button--secondary hatti-links__link" href="${escapeHtml(link.url)}" ` +
      `dir="auto">${escapeHtml(link.title)}</a></li>`,
  );
  const products = page.products.filter((product) => product.variants.length > 0);
  return (
    '<div class="hatti-links">' +
    `<h1 class="hatti-links__name" dir="auto">${escapeHtml(shop.name)}</h1>` +
    (page.bio ? `<p class="hatti-links__bio" dir="auto">${escapeHtml(page.bio)}</p>` : '') +
    (linkItems.length > 0
      ? `<ul class="hatti-links__links" role="list">${linkItems.join('')}</ul>`
      : '') +
    (products.length > 0
      ? '<ul class="hatti-links__products" role="list">' +
        products.map((product, index) => productItem(product, index, words, at)).join('') +
        '</ul>'
      : '') +
    `<p class="hatti-links__all"><a href="${escapeHtml(at('/collections/all'))}">` +
    `${escapeHtml(words.all)}</a></p>` +
    '</div>'
  );
}

/**
 * A product: its image and title, linking to its page; its price, the lowest when its variants'
 * differ, and the price before a sale; and "Buy now" when it has one variant, to buy, "Choose
 * options" on its page when it has more, or "Sold out".
 */
function productItem(
  doc: ProductDoc,
  index: number,
  words: LinkPageWords,
  at: (url: string) => string,
): string {
  const url = at(`/products/${doc.handle}`);
  const prices = doc.variants.map((variant) => variant.price);
  const price = Math.min(...prices);
  const compared = doc.variants.flatMap((variant) =>
    variant.compareAtPrice === null ? [] : [variant.compareAtPrice],
  );
  const lowest = compared.length > 0 ? Math.min(...compared) : null;
  // The price before a sale, while there is one.
  const before = lowest !== null && lowest > price ? lowest : null;
  const amount = price === Math.max(...prices) ? rupees(price) : words.from(rupees(price));
  const only = doc.variants.length === 1 ? doc.variants[0]! : null;
  let action: string;
  if (!doc.variants.some((variant) => variant.available)) {
    action =
      '<span class="button button--secondary hatti-links__buy" aria-disabled="true">' +
      `${escapeHtml(words.soldOut)}</span>`;
  } else if (only) {
    action =
      `<a class="button hatti-links__buy" href="${escapeHtml(at(`/cart/${only.id}:1`))}">` +
      `${escapeHtml(words.buy)}</a>`;
  } else {
    action =
      `<a class="button button--secondary hatti-links__buy" href="${escapeHtml(url)}">` +
      `${escapeHtml(words.choose)}</a>`;
  }
  return (
    '<li class="hatti-links__product">' +
    `<a class="card__link" href="${escapeHtml(url)}">` +
    `<div class="card__media">${imageOf(doc, index)}</div>` +
    `<h2 class="card__title" dir="auto">${escapeHtml(doc.title)}</h2>` +
    '</a>' +
    `<div class="price${before === null ? '' : ' price--sale'}">` +
    (before === null ? '' : `<span class="visually-hidden">${escapeHtml(words.sale)}</span>`) +
    `<span class="price__amount">${escapeHtml(amount)}</span>` +
    (before === null
      ? ''
      : `<span class="visually-hidden">${escapeHtml(words.regular)}</span>` +
        `<s class="price__compare">${escapeHtml(rupees(before))}</s>`) +
    '</div>' +
    action +
    '</li>'
  );
}

/** The product's first image, small enough for phones; the first two load at once. */
function imageOf(doc: ProductDoc, index: number): string {
  const image = doc.images[0];
  if (!image) return '';
  const widths = [165, 360, 533].filter((width) => image.width === 0 || width <= image.width);
  const shown = image.width > 0 ? Math.min(360, image.width) : null;
  const size =
    shown !== null && image.height > 0
      ? ` width="${shown}" height="${Math.round((shown * image.height) / image.width)}"`
      : '';
  return (
    `<img src="${escapeHtml(sized(image.src, 360))}"` +
    (widths.length > 0
      ? ` srcset="${escapeHtml(widths.map((width) => `${sized(image.src, width)} ${width}w`).join(', '))}"`
      : '') +
    ` sizes="(min-width: 36rem) 17rem, 50vw" alt="${escapeHtml(image.alt ?? doc.title)}"${size}` +
    `${index > 1 ? ' loading="lazy"' : ''}>`
  );
}

function rupees(paisa: number): string {
  return formatMoney(money(BigInt(Math.round(paisa)), 'PKR'));
}

/**
 * A link on the page in the page's language: a path on the shop under the language's prefix,
 * "/ur", unless it has it; an address elsewhere as it is.
 */
function localized(url: string, prefix: string): string {
  if (prefix === '' || !url.startsWith('/') || url.startsWith('//')) return url;
  const rest = url.startsWith(prefix) ? url.slice(prefix.length) : null;
  if (rest !== null && (rest === '' || '/?#'.includes(rest[0]!))) return url;
  return url === '/' ? prefix : `${prefix}${url}`;
}
