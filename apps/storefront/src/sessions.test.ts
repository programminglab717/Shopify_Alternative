import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE, SESSION_SCRIPT, VISIT_PATH, isRobot, sessionOf } from './sessions.js';

/** A shopper's page loaded, its head's script run with the cookie it had: what it set and sent. */
function load(cookie: string | null, protocol = 'https:') {
  const jar = { value: cookie ? `other=1; ${SESSION_COOKIE}=${cookie}` : 'other=1', set: '' };
  const beacons: string[] = [];
  runInNewContext(SESSION_SCRIPT, {
    document: {
      get cookie() {
        return jar.value;
      },
      set cookie(value: string) {
        jar.set = value;
      },
    },
    location: { protocol },
    navigator: { sendBeacon: (url: string) => beacons.push(url) },
    crypto: webcrypto,
    btoa,
    String,
    Uint8Array,
  });
  return { set: jar.set, beacons };
}

describe('sessions (ADR-180)', () => {
  it("keeps a session's ID for half an hour from each page, and tells the storefront of each", () => {
    const first = load(null);
    const id = /^hatti_session=([\w-]+);/.exec(first.set)?.[1];
    expect(id).toMatch(/^[\w-]{22}$/);
    expect(first.set).toBe(`hatti_session=${id}; Max-Age=1800; Path=/; SameSite=Lax; Secure`);
    expect(first.beacons).toEqual([VISIT_PATH]);
    // The next page, within the half hour: the same session, kept half an hour more.
    const next = load(id!);
    expect(next.set).toBe(first.set);
    expect(next.beacons).toEqual([VISIT_PATH]);
    // Another browser's is another session; one that is no ID is replaced; over http, not Secure.
    expect(load(null).set).not.toBe(first.set);
    expect(load('not an id').set).toMatch(/^hatti_session=[\w-]{22}; /);
    expect(load(id!, 'http:').set).toBe(`hatti_session=${id}; Max-Age=1800; Path=/; SameSite=Lax`);
  });

  it("reads a session's ID from a request's cookies, and knows robots", () => {
    expect(sessionOf('cart=x; hatti_session=AbCdEfGhIjKlMnOpQrStUv; other=1')).toBe(
      'AbCdEfGhIjKlMnOpQrStUv',
    );
    for (const cookies of [
      undefined,
      '',
      'hatti_session=short',
      'hatti_session=has spaces in it ok',
    ]) {
      expect(sessionOf(cookies)).toBeNull();
    }
    expect(
      isRobot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'),
    ).toBe(true);
    expect(isRobot('Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/129.0.0.0 Safari/537.36')).toBe(
      true,
    );
    expect(isRobot(undefined)).toBe(true);
    expect(
      isRobot('Mozilla/5.0 (Linux; Android 10; K) Chrome/129.0.0.0 Mobile Safari/537.36'),
    ).toBe(false);
  });
});
