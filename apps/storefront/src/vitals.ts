// How fast the storefront is for its shoppers (OS-13, ADR-485): each shopper's page measures its
// Core Web Vitals as the browser sees them, as Google's web-vitals library does, and reports them
// once, when the shopper leaves it, to the storefront, which counts them by the page's kind and
// the shopper's device. Browsers without the measurements report nothing; staff's previews and
// robots are not counted.

import { VITAL_TEMPLATES, type VitalTemplate } from '@hatti/storefront-data';

/** Where a page's script reports its measurements. */
export const VITALS_PATH = '/.hatti/vitals';

/** The most a report may be. */
export const VITALS_BODY_MAX = 1024;

/** The kind of page a theme's template file shows, as its measurements are counted. */
export function vitalTemplateOf(templateFile: string | null): VitalTemplate {
  const name = /^templates\/([a-z_]+)[.]/.exec(templateFile ?? '')?.[1];
  return VITAL_TEMPLATES.find((each) => each === name) ?? 'other';
}

/**
 * The script each shopper's page carries, its kind in its `data-template`: classic, small, and
 * silent when anything fails. Largest contentful paint is the last candidate before the shopper
 * acts; layout shift the worst window of shifts a second apart and five at most, without those
 * that follow input; interaction to next paint the slowest interaction; time to first byte the
 * navigation's response start.
 */
export const VITALS_SCRIPT = `(function () {
  try {
    if (!window.PerformanceObserver || !navigator.sendBeacon) return;
    var script = document.currentScript;
    var kind = (script && script.getAttribute('data-template')) || 'other';
    var found = {};
    var supported = PerformanceObserver.supportedEntryTypes || [];
    var observe = function (type, each, threshold) {
      if (supported.indexOf(type) < 0) return;
      var options = { type: type, buffered: true };
      if (threshold) options.durationThreshold = threshold;
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(each);
      }).observe(options);
    };
    var acted = false;
    observe('largest-contentful-paint', function (entry) {
      if (!acted) found.lcp = entry.startTime;
    });
    observe('paint', function (entry) {
      if (entry.name === 'first-contentful-paint') found.fcp = entry.startTime;
    });
    if (supported.indexOf('layout-shift') >= 0) found.cls = 0;
    var windowed = 0, first = 0, last = 0;
    observe('layout-shift', function (entry) {
      if (entry.hadRecentInput) return;
      if (windowed && entry.startTime - last < 1000 && entry.startTime - first < 5000) {
        windowed += entry.value;
      } else {
        windowed = entry.value;
        first = entry.startTime;
      }
      last = entry.startTime;
      if (windowed > found.cls) found.cls = windowed;
    });
    observe('event', function (entry) {
      if (!entry.interactionId) return;
      acted = true;
      if (!(found.inp >= entry.duration)) found.inp = entry.duration;
    }, 40);
    var navigation = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    if (navigation && navigation.responseStart > 0) found.ttfb = navigation.responseStart;
    var sent = false;
    var send = function (leaving) {
      if (sent || !(leaving || document.visibilityState === 'hidden')) return;
      sent = true;
      found.t = kind;
      navigator.sendBeacon('${VITALS_PATH}', JSON.stringify(found));
    };
    addEventListener('visibilitychange', function () { send(false); }, true);
    addEventListener('pagehide', function () { send(true); }, true);
  } catch (error) {}
})();`;

/** A report's body, as text or JSON: null when it is too long or no JSON. */
export function vitalsReportOf(body: unknown): unknown {
  if (typeof body === 'string') {
    if (body.length > VITALS_BODY_MAX) return null;
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return null;
    }
  }
  return body ?? null;
}
