/**
 * What the admin's service worker keeps and how it answers (ADR-295): the admin's own files from
 * its cache, the page itself from the network and from the cache offline, and nothing of the
 * shop's: the API, sign-in and storage always go to the network.
 */

/** How a request is answered: by the network alone, the cache first, or as the admin's page. */
export type Answer = 'network' | 'cache-first' | 'page';

/** The admin's files: its scripts, styles and fonts, named by their content, and its icons. */
const KEPT =
  /^\/(?:assets\/|icon[\w-]*\.(?:svg|png)$|apple-touch-icon\.png$|manifest(?:\.ur)?\.webmanifest$)/;

/** The core's paths the admin is proxied to: never kept, whoever asks. */
const CORE = /^\/(?:auth|admin|storage|images)(?:\/|$)/;

export function answerFor(
  request: { method: string; mode: string; url: string },
  origin: string,
): Answer {
  if (request.method !== 'GET') return 'network';
  const url = new URL(request.url);
  if (url.origin !== origin || CORE.test(url.pathname)) return 'network';
  if (request.mode === 'navigate') return 'page';
  return KEPT.test(url.pathname) ? 'cache-first' : 'network';
}

/**
 * What a build's service worker keeps as it installs, from the build's files and the public
 * folder's: the page as "/", its scripts and styles, the manifests and icons. Fonts are kept as
 * pages first use them, the Urdu font's many files being more than a phone needs at once.
 */
export function precacheOf(files: readonly string[]): string[] {
  const kept = files
    .filter((file) => file !== 'index.html' && file !== 'sw.js')
    .filter((file) => !/\.(?:map|woff2?|ttf)$/.test(file))
    .map((file) => `/${file}`)
    .filter((path) => KEPT.test(path));
  return ['/', ...[...new Set(kept)].sort()];
}
