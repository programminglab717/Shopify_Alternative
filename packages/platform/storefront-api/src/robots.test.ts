import { describe, expect, it } from 'vitest';
import { robotsTxt, robotsVerdict } from './robots.js';

const LANGUAGES = { locales: ['en', 'ur'], defaultLocale: 'en' };

describe("A shop's robots.txt, and what it lets crawlers fetch (ADR-616)", () => {
  it('keeps crawlers from carts, checkouts, searches and sorted listings, in every language', () => {
    const txt = robotsTxt('https://zari.pk', LANGUAGES);
    const verdict = (path: string) => robotsVerdict(txt, 'Googlebot', path);
    expect(verdict('/products/lawn')).toEqual({ allowed: true, rule: null, group: '*' });
    expect(verdict('/ur/cart')).toEqual({
      allowed: false,
      rule: 'Disallow: /ur/cart',
      group: '*',
    });
    expect(verdict('/collections/eid?sort_by=price').allowed).toBe(false);
    expect(verdict('/collections/eid?page=2').allowed).toBe(true);
    expect(verdict('/robots.txt').allowed).toBe(true);
  });

  it("follows the crawler's own group, the longest rule matching, an Allow winning a tie", () => {
    const txt = robotsTxt(
      'https://zari.pk',
      LANGUAGES,
      [
        'Disallow: /pages/drafts',
        '',
        'User-agent: Googlebot-Image',
        'User-agent: Bingbot',
        'Disallow: /',
        'Allow: /products/',
        '',
        'User-agent: Googlebot-Image',
        'Disallow: /products/*.pdf$',
        'Allow: /collections/$',
      ].join('\n'),
    );
    // Every crawler without a group of its own reads the platform's group, with the shop's line.
    expect(robotsVerdict(txt, 'Googlebot', '/pages/drafts/eid')).toMatchObject({
      allowed: false,
      rule: 'Disallow: /pages/drafts',
      group: '*',
    });
    // Googlebot-Image's groups are read together; the longest matching pattern decides.
    const image = (path: string) => robotsVerdict(txt, 'Googlebot-Image/1.0', path);
    expect(image('/products/lawn')).toEqual({
      allowed: true,
      rule: 'Allow: /products/',
      group: 'Googlebot-Image',
    });
    expect(image('/products/size-chart.pdf')).toMatchObject({
      allowed: false,
      rule: 'Disallow: /products/*.pdf$',
    });
    expect(image('/products/size-chart.pdf?v=2').allowed).toBe(true);
    expect(image('/pages/about')).toMatchObject({ allowed: false, rule: 'Disallow: /' });
    expect(image('/collections/')).toMatchObject({ allowed: true, rule: 'Allow: /collections/$' });
    // Names are read without regard to case; the shop's group does not reach Googlebot.
    expect(robotsVerdict(txt, 'bingbot', '/pages/about').group).toBe('Bingbot');
    expect(robotsVerdict(txt, 'Googlebot', '/pages/about').allowed).toBe(true);
    // A tie between an Allow and a Disallow as long goes to the Allow.
    const tie = 'User-agent: *\nDisallow: /a\nAllow: /a\n';
    expect(robotsVerdict(tie, 'Googlebot', '/a')).toMatchObject({
      allowed: true,
      rule: 'Allow: /a',
    });
  });
});
