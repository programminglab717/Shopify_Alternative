/**
 * The search syntax of the admin's lists, as Shopify's writes it (ADR-118, ADR-120): filters,
 * `key:value`, a value in double quotes if it has spaces, and a leading minus for the rows a filter
 * does not match, among the words to look for. Each list says which filters it takes and the values
 * of each; a filter it doesn't know, or a value its filter doesn't take, is refused, naming what it
 * takes, so a mistyped filter never quietly finds nothing.
 */
export interface SearchSyntax<K extends string> {
  /** What the list holds, as its errors name it: "Orders". */
  noun: string;
  /** Each filter, with the values it takes in lowercase, or `null` for any, kept as written. */
  filters: Readonly<Record<K, readonly string[] | null>>;
  /** For a filter that takes any value, one to give as an example. */
  examples: Readonly<Partial<Record<K, string>>>;
}

/** A filter a search names. */
export interface SearchFilter<K extends string = string> {
  key: K;
  /** As the filter takes it: lowercase, but for a filter that takes any value, as written. */
  value: string;
  /** Written with a leading minus: the rows it does not match. */
  negated: boolean;
}

/** A search, split into the filters it names and the words it looks for. */
export interface ParsedSearch<K extends string = string> {
  filters: SearchFilter<K>[];
  /** The rest, one space apart. */
  terms: string;
}

export type SearchParse<K extends string> =
  { ok: true; value: ParsedSearch<K> } | { ok: false; error: string };

/** `key:value` (`-key:value` to leave out, `key:"a value"`), a phrase in quotes, or a word. */
const SEARCH_TOKEN = /(-?)([A-Za-z_]+):(?:"([^"]*)"|([^\s"]*))|"([^"]*)"|(\S+)/g;

/**
 * A list's search, split into its filters and words. A word with a colon that doesn't follow
 * letters alone, such as `10:30`, stays a word.
 */
export function parseSearch<K extends string>(
  query: string,
  syntax: SearchSyntax<K>,
): SearchParse<K> {
  const filters: SearchFilter<K>[] = [];
  const terms: string[] = [];
  for (const match of query.matchAll(SEARCH_TOKEN)) {
    const [, minus, name, quoted, bare, phrase, word] = match;
    if (name === undefined) {
      terms.push((phrase ?? word)!);
      continue;
    }
    const key = name.toLowerCase();
    if (!Object.hasOwn(syntax.filters, key)) {
      return {
        ok: false,
        error: `${syntax.noun} can't be filtered by ${key}; filters are ${Object.keys(syntax.filters).join(', ')}`,
      };
    }
    const values: readonly string[] | null = syntax.filters[key as K];
    const written = (quoted ?? bare ?? '').trim();
    const value = values === null ? written : written.toLowerCase();
    if (value === '') {
      const example = values?.[0] ?? syntax.examples[key as K] ?? 'value';
      return { ok: false, error: `Give ${key} a value, such as ${key}:${example}` };
    }
    if (values !== null && !values.includes(value)) {
      return { ok: false, error: `${key} is one of ${values.join(', ')}, not ${written}` };
    }
    filters.push({ key: key as K, value, negated: minus === '-' });
  }
  return { ok: true, value: { filters, terms: terms.join(' ').trim() } };
}
