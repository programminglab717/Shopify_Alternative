// What shoppers search the shop for (SRC-06, ADR-683). A search's page is kept at the edge for a
// minute and the same for every shopper, so the page itself reports its search: a script in its
// head, carrying how much the search found, tells the storefront of the words in the page's
// address, once for each search, not again as the shopper turns its pages, filters or sorts it.
// Staff's previews and robots are not counted, and nothing about the shopper is kept.

/** Where a search's page reports it. */
export const SEARCH_REPORT_PATH = '/.hatti/search';

/** The most a report may be. */
export const SEARCH_REPORT_BODY_MAX = 512;

/**
 * The script a search's page carries, what it found in its `data-found`: classic, small, and
 * silent when anything fails. A page reached from a search's page for the same words, as its
 * next page, a filter or an order is, reports nothing.
 */
export const SEARCH_REPORT_SCRIPT = `(function () {
  try {
    if (!navigator.sendBeacon) return;
    var script = document.currentScript;
    var count = script && script.getAttribute('data-found');
    var found = count ? Number(count) : NaN;
    var words = function (address) {
      var url = new URL(address, location.href);
      return /^(\\/ur)?\\/search$/.test(url.pathname) ? (url.searchParams.get('q') || '').trim() : null;
    };
    var q = words(location.href);
    if (!q || !(found >= 0)) return;
    if (document.referrer && new URL(document.referrer).host === location.host &&
        words(document.referrer) === q) return;
    navigator.sendBeacon('${SEARCH_REPORT_PATH}', JSON.stringify({ q: q.slice(0, 200), n: found }));
  } catch (error) {}
})();`;

/** The script's tag for a search that found `found` things. */
export function searchReportTag(found: number): string {
  return `<script data-hatti-search data-found="${found}">${SEARCH_REPORT_SCRIPT}</script>`;
}

/** A report's body, as text or JSON: null when it is too long or no JSON. */
export function searchReportBodyOf(body: unknown): unknown {
  if (typeof body === 'string') {
    if (body.length > SEARCH_REPORT_BODY_MAX) return null;
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return null;
    }
  }
  return body ?? null;
}
