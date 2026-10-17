import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { precacheOf } from '../offline/rules';
import {
  CACHE_RULES,
  CONTENT_SECURITY_POLICY,
  contentSecurityPolicy,
  headersFile,
  securityHeaders,
} from './headers';

const SRC = join(import.meta.dirname, '..');

/** The admin's source files, tests left out. */
function sources(directory = SRC): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Whether a source in a directive allows a script at this address. */
function allows(source: string, url: string): boolean {
  if (source === "'self'") return false;
  const address = new URL(url);
  const allowed = new URL(source);
  if (allowed.origin !== address.origin) return false;
  return allowed.pathname === '/' || allowed.pathname === address.pathname;
}

describe("The admin's edge headers", () => {
  it('runs no script inline, evaluated or from anywhere but its own origin and two sign-ins', () => {
    const scripts = CONTENT_SECURITY_POLICY['script-src'] ?? [];
    expect(scripts).toEqual([
      "'self'",
      'https://accounts.google.com/gsi/client',
      'https://connect.facebook.net',
    ]);
    for (const source of ["'unsafe-inline'", "'unsafe-eval'", 'https:', 'data:', 'blob:', '*'])
      expect(scripts).not.toContain(source);
    expect(CONTENT_SECURITY_POLICY['default-src']).toEqual(["'self'"]);
    expect(CONTENT_SECURITY_POLICY['object-src']).toEqual(["'none'"]);
    expect(CONTENT_SECURITY_POLICY['base-uri']).toEqual(["'none'"]);
    expect(CONTENT_SECURITY_POLICY['frame-ancestors']).toEqual(["'none'"]);
    expect(contentSecurityPolicy()).toContain(
      "script-src 'self' https://accounts.google.com/gsi/client https://connect.facebook.net; ",
    );
    expect(contentSecurityPolicy()).toMatch(/; upgrade-insecure-requests$/);
  });

  it('allows every script the admin loads, and its page has none inline', () => {
    const loaded = sources().flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/\.src = '(https:[^']+)'/g)].map(
        (match) => match[1] ?? '',
      ),
    );
    expect(loaded.sort()).toEqual([
      'https://accounts.google.com/gsi/client',
      'https://connect.facebook.net/en_US/sdk.js',
    ]);
    const scripts = CONTENT_SECURITY_POLICY['script-src'] ?? [];
    for (const url of loaded) expect(scripts.some((source) => allows(source, url))).toBe(true);

    const page = readFileSync(join(SRC, '..', 'index.html'), 'utf8');
    const tags = [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(tags).toHaveLength(1);
    for (const [, attributes, body] of tags) {
      expect(attributes).toMatch(/\bsrc="/);
      expect(body?.trim()).toBe('');
    }
  });

  it('writes the headers on every path and the cache rules as a _headers file, kept from the worker', () => {
    const file = headersFile();
    const lines = file.trimEnd().split('\n');
    expect(lines[0]).toBe('/*');
    for (const [name, value] of Object.entries(securityHeaders()))
      expect(lines).toContain(`  ${name}: ${value}`);
    expect(securityHeaders()['Permissions-Policy']).toMatch(/^camera=\(self\), microphone=\(\)/);
    expect(securityHeaders()['Cross-Origin-Opener-Policy']).toBe('same-origin-allow-popups');
    for (const [path, cacheControl] of CACHE_RULES) {
      const at = lines.indexOf(path);
      expect(at).toBeGreaterThan(0);
      expect(lines[at + 1]).toBe(`  Cache-Control: ${cacheControl}`);
    }
    expect(file).toContain('/sw.js\n  Cache-Control: no-cache\n');
    // The edge reads the file; the service worker never keeps it.
    expect(precacheOf(['_headers', 'index.html', 'assets/index-a1.js'])).toEqual([
      '/',
      '/assets/index-a1.js',
    ]);
  });
});
