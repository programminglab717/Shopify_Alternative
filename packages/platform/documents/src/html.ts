const MARKUP = Symbol('markup');

/** Markup built by {@link html}, so safe to place in a document as it is. */
export interface Html {
  readonly [MARKUP]: string;
}

/**
 * What {@link html} takes: markup as it is, or anything else as escaped text. Null, undefined and
 * false leave nothing, so `${condition && html`…`}` works.
 */
export type HtmlValue =
  Html | string | number | bigint | null | undefined | false | readonly HtmlValue[];

const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Text as HTML text or a quoted attribute value: no tags, no way out of the quotes. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ENTITIES[char]!);
}

function isHtml(value: unknown): value is Html {
  return typeof value === 'object' && value !== null && MARKUP in value;
}

/** The markup of `value`, escaping whatever is not markup already. */
export function toMarkup(value: HtmlValue): string {
  if (value === null || value === undefined || value === false) return '';
  if (isHtml(value)) return value[MARKUP];
  if (Array.isArray(value)) return (value as readonly HtmlValue[]).map(toMarkup).join('');
  return escapeHtml(String(value));
}

/**
 * Markup from a template. Every value is escaped unless it is markup already, so text that people
 * typed, such as a customer's name, can never add tags: html`<td>${name}</td>`.
 */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): Html {
  let markup = strings[0]!;
  values.forEach((value, index) => {
    markup += toMarkup(value) + strings[index + 1]!;
  });
  return trusted(markup);
}

/** Markup this package wrote itself, such as its styles. Not exported from the package. */
export function trusted(markup: string): Html {
  return { [MARKUP]: markup };
}
