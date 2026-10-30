import axe from 'axe-core';
import { Window } from 'happy-dom';

// `hatti theme check` (ADR-968): a theme's pages read by axe through its preview, as Hatti's own
// themes are in its tests (ADR-967), so a designer finds what a reviewer would before offering it
// to the theme store, and Hatti's reviewer checks it the same way before listing it.

/** Rules a page without its stylesheet cannot be judged by, as Hatti's own tests leave them. */
const NOT_JUDGED = {
  // Nothing is laid out, so there are no colours to compare: the theme's colour settings are the
  // shop's, checked where it picks them.
  'color-contrast': { enabled: false },
};

/** The pages of each kind a shopper sees; a product is found on the catalogue's page. */
const PAGES = ['/', '/collections/all', '/cart', '/search?q=a'] as const;

/** The languages the pages are read in: Urdu's are under /ur/, right to left. */
const LOCALES = [
  { name: 'en', prefix: '' },
  { name: 'ur', prefix: '/ur' },
] as const;

export class ThemeCheckError extends Error {}

export interface ThemeCheckProblem {
  /** The page, as `en /cart`. */
  page: string;
  rule: string;
  impact: string;
  help: string;
  /** The first elements that break it, cut short. */
  elements: string[];
}

/**
 * The rules each of the theme's pages breaks, read through its preview link `previewUrl`: its
 * home page, catalogue, first product, cart and search, in English and in Urdu.
 */
export async function checkTheme(
  previewUrl: string,
  options: { fetch?: typeof fetch; log?: (line: string) => void } = {},
): Promise<{ pages: number; problems: ThemeCheckProblem[] }> {
  const get = options.fetch ?? fetch;
  let base: URL;
  try {
    base = new URL(previewUrl);
  } catch {
    throw new ThemeCheckError(`${previewUrl} is not a link to a theme's preview.`);
  }
  // Each page asked for with the preview's token, so the theme under check answers, not the
  // shop's live one.
  const urlOf = (path: string) => {
    const url = new URL(path, base.origin);
    for (const [key, value] of base.searchParams) url.searchParams.set(key, value);
    return url.toString();
  };
  const read = async (page: string, path: string): Promise<string> => {
    let response: Response;
    try {
      response = await get(urlOf(path), { headers: { accept: 'text/html' } });
    } catch (error) {
      throw new ThemeCheckError(`${page} could not be reached: ${(error as Error).message}`);
    }
    if (!response.ok) {
      throw new ThemeCheckError(
        `${page} answered ${response.status}: is the preview link current?`,
      );
    }
    return response.text();
  };

  const problems: ThemeCheckProblem[] = [];
  let pages = 0;
  for (const locale of LOCALES) {
    const paths: string[] = PAGES.map((path) => `${locale.prefix}${path}`);
    for (let index = 0; index < paths.length; index += 1) {
      const path = paths[index]!;
      const page = `${locale.name} ${path}`;
      options.log?.(`Checking ${page}`);
      const html = await read(page, path);
      pages += 1;
      // The catalogue's first product, checked next.
      if (index === 1) {
        // A catalogue in Urdu that links to its products' English pages: their Urdu ones.
        const english = productIn(html, '');
        const product = productIn(html, locale.prefix) ?? (english && `${locale.prefix}${english}`);
        if (product) paths.splice(2, 0, product);
      }
      for (const each of await violationsOf(html)) problems.push({ page, ...each });
    }
  }
  return { pages, problems };
}

/** The path of the first product a catalogue page links to, under `prefix`; null for none. */
export function productIn(html: string, prefix: string): string | null {
  const found = new RegExp(`href="(?:https?://[^/"]+)?(${prefix}/products/[^"?#/]+)`).exec(html);
  return found ? found[1]! : null;
}

/** The rules `html` breaks, read by axe in a window of its own. */
async function violationsOf(html: string): Promise<Omit<ThemeCheckProblem, 'page'>[]> {
  // Only axe's own code runs there: the page's scripts are taken out first.
  const window = new Window({
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  });
  try {
    window.document.write(html.replace(/<script\b[\s\S]*?<\/script>/gi, ''));
    window.eval(axe.source);
    const inside = (window as unknown as { axe: typeof axe }).axe;
    // A page's frames (a map, a video) are the embedded site's own pages.
    const { violations } = await inside.run(window.document as unknown as axe.ElementContext, {
      rules: NOT_JUDGED,
      iframes: false,
      // What passes is not needed, and is most of axe's time.
      resultTypes: ['violations'],
    });
    return violations.map((each) => ({
      rule: each.id,
      impact: each.impact ?? 'minor',
      help: each.help,
      elements: each.nodes.slice(0, 3).map((node) => node.html.slice(0, 160)),
    }));
  } finally {
    await window.happyDOM.close();
  }
}
