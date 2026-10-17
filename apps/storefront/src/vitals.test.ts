import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { VITALS_PATH, VITALS_SCRIPT, vitalTemplateOf, vitalsReportOf } from './vitals.js';

type Entry = Record<string, unknown>;

/**
 * A shopper's page with its vitals script run: the entries the browser gives each kind, the
 * shopper's interactions among them, and what the script reported when the page was left.
 */
function page(entries: Record<string, Entry[]>, leave: 'hide' | 'pagehide' = 'hide') {
  const reports: [string, unknown][] = [];
  const listeners: Record<string, (() => void)[]> = {};
  const document = {
    currentScript: {
      getAttribute: (name: string) => (name === 'data-template' ? 'product' : null),
    },
    visibilityState: 'visible',
  };
  class PerformanceObserver {
    static supportedEntryTypes = Object.keys(entries);
    constructor(private readonly each: (list: { getEntries: () => Entry[] }) => void) {}
    observe(options: { type: string; buffered: boolean }) {
      expect(options.buffered).toBe(true);
      const found = entries[options.type] ?? [];
      this.each({ getEntries: () => found });
    }
  }
  runInNewContext(VITALS_SCRIPT, {
    window: { PerformanceObserver },
    PerformanceObserver,
    document,
    navigator: {
      sendBeacon: (url: string, body: string) => reports.push([url, JSON.parse(body)]),
    },
    performance: {
      getEntriesByType: (type: string) => (type === 'navigation' ? [{ responseStart: 180 }] : []),
    },
    addEventListener: (type: string, listener: () => void) =>
      (listeners[type] ??= []).push(listener),
  });
  if (leave === 'hide') {
    document.visibilityState = 'hidden';
    for (const listener of listeners.visibilitychange ?? []) listener();
  }
  for (const listener of listeners.pagehide ?? []) listener();
  return reports;
}

describe("A shopper's page's Core Web Vitals (OS-13, ADR-485)", () => {
  it('measures them as Google does and reports them once, when the shopper leaves', () => {
    const reports = page({
      paint: [
        { name: 'first-paint', startTime: 300 },
        { name: 'first-contentful-paint', startTime: 420 },
      ],
      'largest-contentful-paint': [{ startTime: 900 }, { startTime: 1650 }],
      'layout-shift': [
        // A window of two shifts, then one after input, then a lone later shift.
        { startTime: 1000, value: 0.04, hadRecentInput: false },
        { startTime: 1400, value: 0.03, hadRecentInput: false },
        { startTime: 2000, value: 0.5, hadRecentInput: true },
        { startTime: 9000, value: 0.05, hadRecentInput: false },
      ],
      event: [
        { interactionId: 0, duration: 400 },
        { interactionId: 7, duration: 120 },
        { interactionId: 8, duration: 88 },
      ],
    });
    expect(reports).toHaveLength(1);
    const [url, report] = reports[0]!;
    expect(url).toBe(VITALS_PATH);
    expect(report).toEqual({ t: 'product', fcp: 420, lcp: 1650, cls: 0.07, inp: 120, ttfb: 180 });
  });

  it('says no layout shift where there was none, and reports on the page being put away', () => {
    const reports = page({ 'layout-shift': [] }, 'pagehide');
    expect(reports.map(([, report]) => report)).toEqual([{ t: 'product', cls: 0, ttfb: 180 }]);
  });

  it("names the page's kind by its template, and reads a report however it is sent", () => {
    expect(vitalTemplateOf('templates/product.json')).toBe('product');
    expect(vitalTemplateOf('templates/page.contact.json')).toBe('page');
    expect(vitalTemplateOf('templates/gift_card.json')).toBe('other');
    expect(vitalTemplateOf(null)).toBe('other');
    expect(vitalsReportOf('{"lcp":1}')).toEqual({ lcp: 1 });
    expect(vitalsReportOf({ lcp: 1 })).toEqual({ lcp: 1 });
    expect(vitalsReportOf('{"lcp":')).toBeNull();
    expect(vitalsReportOf('x'.repeat(2000))).toBeNull();
  });
});
