/**
 * The headers the edge sends with the console's files (ADR-876). The console keeps its session's
 * token in the tab, where script on its origin could read it, so its content security policy runs
 * the console's own scripts alone: nothing inline, nothing evaluated, nothing from elsewhere. It is
 * never framed, indexed or cached by others. A build writes them to `_headers`, the format
 * Cloudflare's static hosting reads.
 */

/** Each directive of the console's content security policy and the sources it allows. */
export const CONTENT_SECURITY_POLICY: Readonly<Record<string, readonly string[]>> = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  // React's style props set styles inline.
  'style-src': ["'self'", "'unsafe-inline'"],
  'font-src': ["'self'"],
  'img-src': ["'self'", 'data:'],
  'connect-src': ["'self'"],
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

/** The headers every response of the console's carries. */
export function securityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': contentSecurityPolicy(),
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'X-Robots-Tag': 'noindex, nofollow',
  };
}

/** `_headers` for every path of the console. */
export function headersFile(): string {
  const lines = Object.entries(securityHeaders()).map(([name, value]) => `  ${name}: ${value}`);
  return `/*\n${lines.join('\n')}\n`;
}
