import sanitizeHtml from 'sanitize-html';

/** What a shop's pages may hold (ADR-045). */
export const PAGE_LIMITS = {
  pages: 1_000,
  title: 255,
  handle: 100,
  /** A page's body as HTML, cleaned, in bytes. */
  body: 512 * 1024,
  templateSuffix: 50,
} as const;

/** A page's handle, as in `/pages/about-us`; the same rule as menus'. */
export const PAGE_HANDLE = /^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$/;

/** Another of the theme's page templates: "contact" for page.contact.json. */
export const TEMPLATE_SUFFIX = /^[a-z0-9_-]{1,50}$/;

// Text and its formatting, links, images and tables: what shops' editors and pages brought from
// Shopify use, and nothing that runs, loads a frame or posts a form.
const TAGS = [
  'p',
  'br',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'del',
  'ins',
  'mark',
  'small',
  'sub',
  'sup',
  'blockquote',
  'q',
  'cite',
  'code',
  'pre',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'a',
  'img',
  'figure',
  'figcaption',
  'table',
  'caption',
  'colgroup',
  'col',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'span',
  'div',
  'section',
  'abbr',
  'address',
  'time',
  'details',
  'summary',
];

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: TAGS,
  // No id, name or class: a page must not stand in for the theme's own elements, which its
  // scripts find by them.
  allowedAttributes: {
    '*': ['dir', 'lang', 'title', 'style'],
    a: ['href', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
    col: ['span'],
    colgroup: ['span'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan', 'scope'],
    ol: ['start', 'reversed', 'type'],
    li: ['value'],
    time: ['datetime'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['https', 'http'] },
  allowProtocolRelative: false,
  // Where text sits and its colour, as editors set them; nothing that moves or hides things.
  allowedStyles: {
    '*': {
      'text-align': [/^(left|right|center|justify|start|end)$/],
      color: [
        /^#[0-9a-f]{3,8}$/i,
        /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*[\d.]+\s*)?\)$/i,
      ],
      'background-color': [
        /^#[0-9a-f]{3,8}$/i,
        /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*[\d.]+\s*)?\)$/i,
      ],
    },
  },
  transformTags: {
    // A link that opens a new tab gives that tab no hold on the shop's.
    a: (tagName, attribs) => ({
      tagName,
      attribs: attribs.target === '_blank' ? { ...attribs, rel: 'noopener noreferrer' } : attribs,
    }),
  },
  // An image whose address was refused is nothing to show.
  exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
};

/**
 * A page's body as the storefront may show it as it is (ADR-045): text, its formatting, links to
 * web, mail and phone addresses and to the storefront, images over http(s), and tables, with
 * where text sits and its colour. Scripts, style sheets, frames, forms, event handlers and other
 * addresses go; the text of tags that go stays. Cleaning a cleaned body changes nothing.
 */
export function cleanPageBody(html: string): string {
  return sanitizeHtml(html, OPTIONS).trim();
}
