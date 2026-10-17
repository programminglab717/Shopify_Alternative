import { FABRICS, type EasternWearInput, type Fabric } from './eastern-wear.js';
import { toHandle } from './handle.js';
import { LIMITS } from './input-checker.js';
import type { CreateProductInput } from './product.service.js';
import {
  PRODUCT_IMPORT_LIMITS,
  type ShopifyColumn,
  type ShopifyFileResult,
  type ShopifyProduct,
  type ShopifyRowProblem,
} from './shopify-csv.js';

// Products from a shop's Instagram posts (ONB-04, ADR-501), where most Pakistani shops sell
// before they have a store: each post a draft product, its caption read for what shops write in
// it. The title is its first line; the price after "Rs" or "PKR", or before "/-", the lower of
// two when it says sale; the sizes and colours from lines saying so; its hashtags its tags; and
// whether a suit is stitched, in how many pieces, of what fabric and for which season. Photos
// come by their addresses, as Instagram's API gives them; the posts in Instagram's own download
// have none to fetch. The import then goes on as it does for Shopify's file (ADR-120).

/** What of Shopify's columns a file of posts says, for an import that updates products. */
const COLUMNS: ReadonlySet<ShopifyColumn> = new Set([
  'title',
  'body',
  'tags',
  'price',
  'compareAtPrice',
  'option1Name',
  'option2Name',
  'imageSrc',
]);

export const INSTAGRAM_LIMITS = {
  /** A product's tags from its hashtags. */
  tags: 10,
  /** Its sizes, and its colours. */
  values: 12,
  /** A price below this is taken for something else, such as "3 piece". */
  lowestPrice: 50,
} as const;

/** A post as Instagram's download or its API gives it, before it is read. */
interface Post {
  caption: string;
  images: string[];
}

const SIZE = /^(xxs|xs|s|m|l|xl|xxl|xxxl|[2-5]xl|\d{2})$/i;
const SALE = /\b(sale|now|off|discount|was|flat)\b/i;
const HASHTAG = /#([\p{L}\p{N}_]+)/gu;
/** Emoji, their skin tones, and the joiners and selectors that hold them together. */
const PICTOGRAPH = new RegExp(
  `[\\p{Extended_Pictographic}\\p{Emoji_Modifier}${String.fromCharCode(0xfe0f, 0x200d)}]`,
  'gu',
);
const BOM = String.fromCharCode(0xfeff);

/**
 * Reads posts as Instagram gives them (ONB-04): the JSON of its own download
 * (your_instagram_activity/content/posts_1.json), or its API's media list, with or without
 * `data` around it. Each post with a caption becomes a draft product; what could not be read,
 * such as a post without a price, is said by its number, the first post being 1.
 */
export function readInstagramPosts(text: string): ShopifyFileResult {
  if (text.trim() === '') return { ok: false, code: 'BLANK', message: 'The file is empty' };
  if (text.length > PRODUCT_IMPORT_LIMITS.csv) {
    return {
      ok: false,
      code: 'TOO_LONG',
      message: `The file can have at most ${PRODUCT_IMPORT_LIMITS.csv.toLocaleString('en')} characters`,
    };
  }
  let parsed: unknown;
  try {
    const trimmed = text.trimStart();
    parsed = JSON.parse(trimmed.startsWith(BOM) ? trimmed.slice(1) : trimmed);
  } catch {
    return {
      ok: false,
      code: 'INVALID',
      message: "The file is not Instagram's posts, as JSON",
    };
  }
  const items = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.data)
      ? parsed.data
      : null;
  if (!items) {
    return { ok: false, code: 'INVALID', message: "The file is not Instagram's posts, as JSON" };
  }
  if (items.length > PRODUCT_IMPORT_LIMITS.rows) {
    return {
      ok: false,
      code: 'TOO_MANY',
      message: `The file can have at most ${PRODUCT_IMPORT_LIMITS.rows.toLocaleString('en')} posts`,
    };
  }

  const problems: ShopifyRowProblem[] = [];
  const products: ShopifyProduct[] = [];
  const handles = new Set<string>();
  items.forEach((item, at) => {
    const row = at + 1;
    const say = (column: string | null, message: string) => problems.push({ row, column, message });
    const post = postOf(item);
    if (!post || post.caption.trim() === '') {
      say('caption', 'The post has no caption to make a product of');
      return;
    }
    const read = productOf(post, say);
    if (!read) return;
    const { product, images } = read;
    let handle = toHandle(product.title) || 'instagram-post';
    for (let n = 2; handles.has(handle); n++) handle = `${toHandle(product.title)}-${n}`;
    handles.add(handle);
    products.push({
      handle,
      row,
      input: { ...product, handle },
      variantRows: (product.variants ?? []).map(() => row),
      images: images.map((src) => ({ src, alt: product.title, row })),
      stock: (product.variants ?? []).map(() => null),
      variantImages: (product.variants ?? []).map(() => null),
    });
  });
  return { ok: true, rows: items.length, products, problems, columns: COLUMNS };
}

/** A post's caption and the addresses of its photos, from either shape Instagram gives. */
function postOf(item: unknown): Post | null {
  if (!isRecord(item)) return null;
  // Instagram's API: caption, media_url, and a carousel's children.
  if ('caption' in item || 'media_url' in item) {
    const images: string[] = [];
    const add = (media: unknown) => {
      if (!isRecord(media) || media.media_type === 'VIDEO') return;
      if (typeof media.media_url === 'string') images.push(media.media_url);
    };
    const children = isRecord(item.children) ? item.children.data : null;
    if (Array.isArray(children) && children.length > 0) children.forEach(add);
    else add(item);
    return { caption: typeof item.caption === 'string' ? item.caption : '', images };
  }
  // Instagram's download: a title, or the first photo's, and photos at paths in its ZIP.
  const media = Array.isArray(item.media) ? item.media.filter(isRecord) : [];
  const title =
    typeof item.title === 'string' && item.title !== ''
      ? item.title
      : typeof media[0]?.title === 'string'
        ? media[0].title
        : '';
  return {
    caption: unmangled(title),
    images: media.flatMap((each) => (typeof each.uri === 'string' ? [each.uri] : [])),
  };
}

/**
 * Text as Instagram's download writes it: UTF-8 read as Latin-1, so that a letter beyond ASCII
 * comes as two characters. Mended where every character fits in a byte and they make UTF-8; as it is if not.
 */
function unmangled(text: string): string {
  let wide = false;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (code > 0xff) return text;
    if (code >= 0x80) wide = true;
  }
  if (!wide) return text;
  const mended = Buffer.from(text, 'latin1').toString('utf8');
  return mended.includes(String.fromCharCode(0xfffd)) ? text : mended;
}

/** The draft product a post makes, and the addresses of its photos to fetch. */
function productOf(
  post: Post,
  say: (column: string | null, message: string) => void,
): { product: CreateProductInput & { title: string }; images: string[] } | null {
  const lines = post.caption
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const plain = (line: string) =>
    line.replace(HASHTAG, '').replace(PICTOGRAPH, '').replace(/\s+/g, ' ').trim();
  const titleAt = lines.findIndex(
    (line) => plain(line) !== '' && !/^(price|sizes?|colou?rs?)\b/i.test(plain(line)),
  );
  if (titleAt < 0) {
    say('caption', 'The caption has nothing but hashtags to make a title of');
    return null;
  }
  const title = plain(lines[titleAt]!)
    .replace(/[\s:;,.!|-]+$/, '')
    .slice(0, LIMITS.title);
  const description = lines
    .filter((line, at) => at !== titleAt && plain(line) !== '')
    .join('\n')
    .slice(0, LIMITS.description);

  const amounts = pricesIn(post.caption);
  let price = '0';
  let compareAtPrice: string | undefined;
  if (amounts.length === 0) {
    say('price', 'The caption names no price: priced at Rs 0 until one is set');
  } else if (amounts.length > 1 && SALE.test(post.caption)) {
    const low = Math.min(...amounts);
    const high = Math.max(...amounts);
    price = String(low);
    if (high > low) compareAtPrice = String(high);
  } else {
    price = String(amounts[0]);
  }

  const sizes = valuesAfter(lines, /^sizes?\b\s*[:-]?\s*(.*)$/i, /[\s,/|]+/).flatMap((token) =>
    SIZE.test(token) ? [token.toUpperCase()] : [],
  );
  const colours = valuesAfter(lines, /^colou?rs?\b\s*[:-]\s*(.*)$/i, /\s*(?:,|\/|\||\band\b)\s*/i)
    .map((colour) => plain(colour))
    .filter((colour) => colour !== '' && colour.length <= LIMITS.shortText)
    .map((colour) => colour[0]!.toUpperCase() + colour.slice(1));
  const options = [
    ...(unique(sizes).length > 0 ? [{ name: 'Size', values: unique(sizes) }] : []),
    ...(unique(colours).length > 0 ? [{ name: 'Colour', values: unique(colours) }] : []),
  ].map((option) => ({ ...option, values: option.values.slice(0, INSTAGRAM_LIMITS.values) }));
  const combinations = options.reduce<string[][]>(
    (all, option) => all.flatMap((values) => option.values.map((value) => [...values, value])),
    [[]],
  );
  const variants = combinations.map((optionValues) => ({
    ...(optionValues.length > 0 && { optionValues }),
    price,
    ...(compareAtPrice !== undefined && { compareAtPrice }),
  }));

  const tags = unique(
    [...post.caption.matchAll(HASHTAG)].map((match) => match[1]!.toLowerCase()),
  ).slice(0, INSTAGRAM_LIMITS.tags);
  const notFetched = post.images.filter((src) => !/^https:\/\//i.test(src));
  if (notFetched.length > 0) {
    say(
      'media',
      notFetched.length === post.images.length
        ? "Its photos are in Instagram's download, not at addresses Hatti can fetch: add them to the product"
        : 'Some of its photos are not at https addresses, and were left out',
    );
  }
  const images = post.images.filter((src) => /^https:\/\//i.test(src)).slice(0, LIMITS.media);
  const easternWear = easternWearOf(post.caption);
  return {
    product: {
      title,
      description,
      status: 'draft',
      tags,
      ...(options.length > 0 && { options }),
      variants,
      ...(easternWear && { easternWear }),
    },
    images,
  };
}

/** Rupee amounts a caption names, in its order: "Rs 3,500", "PKR 3500", "3500/-", "Price: 3500". */
function pricesIn(caption: string): number[] {
  const found: { at: number; amount: number }[] = [];
  const patterns = [
    /\b(?:rs|pkr)\.?\s*[:-]?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi,
    /\b([0-9][0-9,]*)\s*(?:\/-|rs\b|pkr\b)/gi,
    /\bprice\s*[:-]?\s*([0-9][0-9,]*)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of caption.matchAll(pattern)) {
      const amount = Number(match[1]!.replace(/,/g, ''));
      if (!Number.isFinite(amount) || amount < INSTAGRAM_LIMITS.lowestPrice) continue;
      if (found.some((each) => Math.abs(each.at - match.index) < 12)) continue;
      found.push({ at: match.index, amount });
    }
  }
  return found.sort((a, b) => a.at - b.at).map((each) => each.amount);
}

/** The values a line names after its label, such as "Sizes: S, M, L", split as `separator`. */
function valuesAfter(lines: readonly string[], label: RegExp, separator: RegExp): string[] {
  for (const line of lines) {
    const match = label.exec(line.replace(PICTOGRAPH, '').trim());
    if (match) {
      return match[1]!
        .split(separator)
        .map((value) => value.trim())
        .filter(Boolean);
    }
  }
  return [];
}

/** Whether a suit is stitched, its pieces, fabrics and season, as its caption says (CAT-08). */
function easternWearOf(caption: string): EasternWearInput | null {
  const text = caption.toLowerCase();
  const stitching = /\bsemi[\s-]?stitched\b/.test(text)
    ? 'semi_stitched'
    : /\bun[\s-]?stitched\b/.test(text)
      ? 'unstitched'
      : /\b(stitched|ready[\s-]?to[\s-]?wear|pret)\b/.test(text)
        ? 'stitched'
        : null;
  const pieces = /\b([1-4])\s*-?\s*(?:pc|pcs|piece|pieces)\b/.exec(text);
  const fabrics: Fabric[] = [];
  for (const fabric of FABRICS) {
    const word = new RegExp(`\\b${fabric.replace('_', '[\\s-]?')}\\b`);
    if (word.test(text)) fabrics.push(fabric);
  }
  // Raw silk says silk too, as a word of its own.
  if (fabrics.includes('raw_silk')) {
    const silk = fabrics.indexOf('silk');
    if (silk >= 0) fabrics.splice(silk, 1);
  }
  const season = /\bsummer\b/.test(text)
    ? 'summer'
    : /\bwinter\b/.test(text)
      ? 'winter'
      : /\b(festive|eid|wedding|formals?)\b/.test(text)
        ? 'festive'
        : null;
  const found: EasternWearInput = {
    ...(stitching && { stitching }),
    ...(pieces && { pieces: Number(pieces[1]) }),
    ...(fabrics.length > 0 && { fabrics: fabrics.slice(0, 3) }),
    ...(season && { season }),
  };
  return Object.keys(found).length > 0 ? found : null;
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
