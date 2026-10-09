/**
 * A page's body as staff write it: plain text, a blank line between paragraphs, sent to the core
 * as the simple HTML themes print; and back. A body written elsewhere with more than paragraphs
 * and line breaks is edited as its HTML, so nothing of it is lost.
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

/** Plain text as paragraphs: a blank line between them, a single line break kept as one. */
export function htmlFromText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
    .map((paragraph) => `<p>${escape(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

/** A body of paragraphs and line breaks alone as plain text, or null for any other HTML. */
export function textFromHtml(html: string): string | null {
  const body = html.trim();
  if (body === '') return '';
  const paragraphs = body.split(/<\/p>\s*/i).filter((part) => part.trim() !== '');
  const texts: string[] = [];
  for (const paragraph of paragraphs) {
    const match = /^<p>([^<]*(?:<br\s*\/?>[^<]*)*)$/i.exec(paragraph.trim());
    if (!match) return null;
    const text = match[1]!
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => UNESCAPES[entity]!);
    // Any other entity is HTML a plain text box would show as typed.
    if (/&[a-z#0-9]+;/i.test(text)) return null;
    texts.push(text);
  }
  return texts.join('\n\n');
}
