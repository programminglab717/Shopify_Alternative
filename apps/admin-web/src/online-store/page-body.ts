/**
 * A page's or policy's body as staff write it: plain text, a blank line between blocks, a block
 * of "## " a heading and one whose lines all start "- " a list, web addresses made links; sent to
 * the core as the simple HTML themes print, and read back the same way. A body with HTML beyond
 * that, written elsewhere, is edited as its HTML, so nothing of it is lost.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const UNESCAPES: Record<string, string> = Object.fromEntries(
  Object.entries(ESCAPES).map(([character, entity]) => [entity, character]),
);

const escape = (text: string) => text.replace(/[&<>"']/g, (character) => ESCAPES[character]!);
const unescape = (text: string) =>
  text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => UNESCAPES[entity]!);

const URL = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g;

/** Runs of Latin letters and digits, such as "Rs 250" or "+92 300 1234567", in right-to-left text. */
const LTR_RUN = /[+]?[A-Za-z0-9][A-Za-z0-9.,:/@_+-]*(?: +[A-Za-z0-9][A-Za-z0-9.,:/@_+-]*)*/g;

const ltr = (html: string) => `<span dir="ltr">${html}</span>`;

/** A line's words as HTML: escaped, its web addresses links, Latin kept left to right in Urdu. */
function inline(text: string, rtl: boolean): string {
  let html = '';
  let at = 0;
  for (const match of text.matchAll(URL)) {
    html += words(text.slice(at, match.index), rtl);
    const url = escape(match[0]);
    html += `<a href="${url}">${rtl ? ltr(url) : url}</a>`;
    at = match.index + match[0].length;
  }
  return html + words(text.slice(at), rtl);
}

function words(text: string, rtl: boolean): string {
  const html = escape(text);
  return rtl ? html.replace(LTR_RUN, (run) => ltr(run)) : html;
}

/** Plain text as HTML: paragraphs, "## " headings and "- " lists, a blank line between them. */
export function htmlFromText(text: string, options: { rtl?: boolean } = {}): string {
  const rtl = options.rtl ?? false;
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== ''),
    )
    .filter((lines) => lines.length > 0)
    .map((lines) => {
      if (lines.length === 1 && /^##\s+/.test(lines[0]!)) {
        return `<h2>${inline(lines[0]!.replace(/^##\s+/, ''), rtl)}</h2>`;
      }
      if (lines.every((line) => /^-\s+/.test(line))) {
        const items = lines.map((line) => `<li>${inline(line.replace(/^-\s+/, ''), rtl)}</li>`);
        return `<ul>\n${items.join('\n')}\n</ul>`;
      }
      return `<p>${lines.map((line) => inline(line, rtl)).join('<br>')}</p>`;
    })
    .join('\n');
}

/** A block's inner HTML as one line's text, or null if it holds HTML plain text cannot. */
function textOf(html: string): string | null {
  const parts = html.split(/<br\s*\/?>/i).map((part) => part.replace(/\s+/g, ' ').trim());
  if (parts.some((part) => /[<>]/.test(part))) return null;
  const text = unescape(parts.join('\n'));
  // Any other entity is HTML a plain text box would show as typed.
  return /&[a-z#0-9]+;/i.test(text) ? null : text;
}

/** A body of paragraphs, headings, lists and links alone as plain text, or null for other HTML. */
export function textFromHtml(html: string): string | null {
  let rest = html
    // Left-to-right runs in Urdu are wrapped again as the text is sent.
    .replace(/<span dir="ltr">([^<]*)<\/span>/g, '$1')
    // A link whose words are its address is that address; any other link is HTML.
    .replace(/<a href="([^"<>]*)">([^<]*)<\/a>/g, (whole, href: string, text: string) =>
      href === text ? href : whole,
    )
    .trim();
  if (/<a[\s>]/i.test(rest)) return null;
  const blocks: string[] = [];
  while (rest !== '') {
    const block = /^(?:<p>([\s\S]*?)<\/p>|<h2>([\s\S]*?)<\/h2>|<ul>([\s\S]*?)<\/ul>)\s*/i.exec(
      rest,
    );
    if (!block) return null;
    rest = rest.slice(block[0].length);
    const [, paragraph, heading, list] = block;
    if (paragraph !== undefined) {
      const text = textOf(paragraph);
      if (text === null) return null;
      if (text !== '') blocks.push(text);
    } else if (heading !== undefined) {
      const text = textOf(heading);
      if (text === null || text.includes('\n')) return null;
      blocks.push(`## ${text}`);
    } else {
      const items: string[] = [];
      let inside = list!.trim();
      while (inside !== '') {
        const item = /^<li>([\s\S]*?)<\/li>\s*/i.exec(inside);
        if (!item) return null;
        inside = inside.slice(item[0].length);
        const text = textOf(item[1]!);
        if (text === null || text.includes('\n')) return null;
        items.push(`- ${text}`);
      }
      blocks.push(items.join('\n'));
    }
  }
  return blocks.join('\n\n');
}
