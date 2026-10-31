/**
 * The headers the edge sends with the admin's files (ADR-513). The admin keeps its session's
 * tokens where script on its origin could read them (ADR-265), so its content security policy runs
 * only the admin's own scripts, Google's sign-in (ADR-164) and Facebook's SDK for connecting a
 * WhatsApp number (ADR-419): nothing inline, nothing evaluated. A build writes them to `_headers`,
 * the format Cloudflare's static hosting reads, and `vite preview` sends them too.
 */

/** Each directive of the admin's content security policy and the sources it allows. */
export const CONTENT_SECURITY_POLICY: Readonly<Record<string, readonly string[]>> = {
  'default-src': ["'self'"],
  'script-src': [
    "'self'",
    'https://accounts.google.com/gsi/client',
    'https://connect.facebook.net',
  ],
  // React's style props and Google's button set styles inline; the tab a document is printed in
  // (ui/print.ts) is the admin's own and loads the documents' fonts from Google Fonts.
  'style-src': [
    "'self'",
    "'unsafe-inline'",
    'https://accounts.google.com/gsi/style',
    'https://fonts.googleapis.com',
  ],
  'font-src': ["'self'", 'https://fonts.gstatic.com'],
  // Photos come from storage and the image route, previews from the camera as blobs.
  'img-src': ["'self'", 'data:', 'blob:', 'https:'],
  'media-src': ["'self'", 'blob:', 'https:'],
  // Photos and files go straight to storage by presigned addresses, wherever storage is.
  'connect-src': ["'self'", 'https:'],
  // The theme editor frames the shop's storefront, at its own domain (ADR-325); Google's and
  // Facebook's sign-in frame their pages.
  'frame-src': ['https:'],
  'worker-src': ["'self'"],
  'manifest-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
  'upgrade-insecure-requests': [],
};

/** The policy as its header's value. */
export function contentSecurityPolicy(): string {
  return Object.entries(CONTENT_SECURITY_POLICY)
    .map(([directive, sources]) => [directive, ...sources].join(' '))
    .join('; ');
}

/** The headers every response of the admin's carries. */
export function securityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': contentSecurityPolicy(),
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // Google's and Facebook's sign-in answer from pop-ups the admin opens.
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    // The camera scans barcodes and takes products' photos; nothing else is asked for.
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
  };
}

/**
 * How long the edge and browsers keep each file: the page and the service worker are asked for
 * again every time, so a new build reaches staff at once; the built files, named by their
 * content, are kept for a year.
 */
export const CACHE_RULES: readonly (readonly [path: string, cacheControl: string])[] = [
  ['/', 'no-cache'],
  ['/index.html', 'no-cache'],
  ['/sw.js', 'no-cache'],
  ['/assets/*', 'public, max-age=31536000, immutable'],
];

/** The headers as a `_headers` file: the security headers on every path, then the cache rules. */
export function headersFile(): string {
  const lines = [
    '/*',
    ...Object.entries(securityHeaders()).map(([name, value]) => `  ${name}: ${value}`),
  ];
  for (const [path, cacheControl] of CACHE_RULES)
    lines.push(path, `  Cache-Control: ${cacheControl}`);
  return `${lines.join('\n')}\n`;
}

/**
 * The same headers and cache rules for Caddy, the pilot's proxy (ADR-989): a file its admin site
 * imports, written beside the build as `_headers.caddy`, so the pilot sends what the edge does.
 */
export function caddyHeaders(): string {
  const quoted = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const lines = [
    'header {',
    ...Object.entries(securityHeaders()).map(([name, value]) => `\t${name} ${quoted(value)}`),
    '}',
  ];
  for (const [at, [path, cacheControl]] of CACHE_RULES.entries()) {
    lines.push(
      `@cache${at} path ${path}`,
      `header @cache${at} Cache-Control ${quoted(cacheControl)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
