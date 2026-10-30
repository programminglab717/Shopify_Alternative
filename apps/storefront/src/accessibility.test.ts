import axe from 'axe-core';
import { Window } from 'happy-dom';
import { MemoryStore } from '@hatti/storefront-data';
import { platformTheme, platformThemes } from '@hatti/themes';
import { describe, expect, it } from 'vitest';
import { sampleStore } from './fixtures.js';
import { PageRenderer, type PageRequest } from './render.js';

// Shoppers' pages checked for accessibility (design §8), as the admin's screens are (ADR-966):
// each platform theme's pages, as a shop's sample catalogue renders them, read by axe, in English
// and in Urdu, right to left.

/** Rules a page without its stylesheet cannot be judged by, as the admin's tests leave them. */
const NOT_JUDGED = {
  // Nothing is laid out, so there are no colours to compare: the themes' colour settings are the
  // shop's, checked where it picks them.
  'color-contrast': { enabled: false },
};

/** A page of each kind a shopper sees. */
const PAGES: PageRequest[] = [
  { path: '/' },
  { path: '/products/bridal-lehenga-heavy' },
  { path: '/collections/eid-lawn' },
  { path: '/collections/all' },
  { path: '/cart' },
  { path: '/search', query: { q: 'lawn' } },
  { path: '/pages/returns' },
];

/** The rules the page `html` breaks, each said in a line or two; none where it breaks none. */
async function problemsOf(html: string): Promise<string[]> {
  // A window of its own, axe run inside it; the page's own scripts are not run.
  // Only axe's own code runs there: the page's scripts are taken out first.
  const window = new Window({
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  });
  window.document.write(html.replace(/<script\b[\s\S]*?<\/script>/gi, ''));
  window.eval(axe.source);
  const inside = (window as unknown as { axe: typeof axe }).axe;
  // A page's frames (a map, a video) are the embedded site's own pages.
  const { violations } = await inside.run(window.document as unknown as axe.ElementContext, {
    rules: NOT_JUDGED,
    iframes: false,
  });
  await window.happyDOM.close();
  return violations.map(
    (each) =>
      `${each.id} (${each.impact ?? 'minor'}): ${each.help}\n  ${each.nodes
        .slice(0, 2)
        .map((node) => node.html.slice(0, 160))
        .join('\n  ')}`,
  );
}

describe("Shoppers' pages, accessible in every platform theme (ADR-967)", async () => {
  const themes = (await platformThemes()).map((each) => each.handle);

  it('checks every platform theme', () => {
    expect(themes).toEqual(expect.arrayContaining(['hatti-base', 'lawn', 'bazaar', 'kundan']));
  });

  for (const handle of themes) {
    it(`renders ${handle}'s pages, in English and in Urdu, breaking no rule`, async () => {
      const renderer = new PageRenderer(await platformTheme(handle), {
        limits: { timeMs: 10_000 },
      });
      const store = new MemoryStore(sampleStore());
      const found: string[] = [];
      for (const locale of ['en', 'ur'] as const) {
        for (const request of PAGES) {
          const page = await renderer.render({ ...request, locale }, store.fresh(0));
          expect(page.status, `${locale} ${request.path}`).toBe(200);
          for (const problem of await problemsOf(page.html)) {
            found.push(`${locale} ${request.path}: ${problem}`);
          }
        }
      }
      expect(found).toEqual([]);
    });
  }
});
