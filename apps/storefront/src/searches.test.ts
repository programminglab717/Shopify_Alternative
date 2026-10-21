import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  SEARCH_REPORT_PATH,
  SEARCH_REPORT_SCRIPT,
  searchReportBodyOf,
  searchReportTag,
} from './searches.js';

/** A shopper's page at `href`, come from `referrer`, with its search script run: what it reported. */
function page(href: string, referrer: string, found: string | null = '3') {
  const reports: [string, unknown][] = [];
  const location = new URL(href);
  runInNewContext(SEARCH_REPORT_SCRIPT, {
    URL,
    location,
    document: {
      currentScript: { getAttribute: (name: string) => (name === 'data-found' ? found : null) },
      referrer,
    },
    navigator: {
      sendBeacon: (url: string, body: string) => reports.push([url, JSON.parse(body)]),
    },
  });
  return reports;
}

describe("A shopper's search, reported by its page (SRC-06, ADR-683)", () => {
  it("reports the words in the page's address and what they found, once for each search", () => {
    expect(page('https://zari.pk/search?q=+lawn+suit', 'https://zari.pk/')).toEqual([
      [SEARCH_REPORT_PATH, { q: 'lawn suit', n: 3 }],
    ]);
    expect(page('https://zari.pk/ur/search?q=%D8%AC%D9%88%D8%AA%DB%92', '', '0')).toEqual([
      [SEARCH_REPORT_PATH, { q: 'جوتے', n: 0 }],
    ]);
    // A search from another site's link is the shopper's own.
    expect(
      page('https://zari.pk/search?q=lawn', 'https://www.google.com/search?q=lawn'),
    ).toHaveLength(1);
    // The same words' next page, filter or order is the same search.
    expect(page('https://zari.pk/search?q=lawn&page=2', 'https://zari.pk/search?q=lawn')).toEqual(
      [],
    );
    expect(
      page(
        'https://zari.pk/search?q=lawn&sort_by=price-ascending',
        'https://zari.pk/search?q=lawn',
      ),
    ).toEqual([]);
    // Other words are another search.
    expect(page('https://zari.pk/search?q=khussa', 'https://zari.pk/search?q=lawn')).toHaveLength(
      1,
    );
    // No words, or no count, report nothing.
    expect(page('https://zari.pk/search?q=+', '')).toEqual([]);
    expect(page('https://zari.pk/search?q=lawn', '', null)).toEqual([]);
  });

  it("carries what the search found in its tag, and reads a report's body", () => {
    expect(searchReportTag(7)).toMatch(/^<script data-hatti-search data-found="7">/);
    expect(searchReportBodyOf('{"q":"lawn","n":1}')).toEqual({ q: 'lawn', n: 1 });
    expect(searchReportBodyOf('q=lawn')).toBeNull();
    expect(searchReportBodyOf('x'.repeat(600))).toBeNull();
    expect(searchReportBodyOf({ q: 'lawn', n: 1 })).toEqual({ q: 'lawn', n: 1 });
  });
});
